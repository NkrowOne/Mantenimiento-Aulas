/**
 * Autoguardado en dos niveles.
 *
 * Nivel 1 — Dexie, con 400ms de espera: instantáneo y funciona siempre.
 * Nivel 2 — servidor, con 3s: el borrador **no es un fichero local**, es una
 * fila en `inspections` que el técnico puede recuperar desde cualquier
 * dispositivo. Cerrar la app, quedarse sin batería, romper el móvil o que iOS
 * limpie el almacenamiento no pierde trabajo.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { v7 as uuidv7 } from 'uuid'
import { db, enqueue } from '@/db/dexie'
import { flush } from '@/sync/outbox'
import { norm } from '@/domain/normalize'
import { resolveType } from '@/domain/inventory'
import {
  LAMP_MEASURE,
  ROOM_CHECKS,
  ROOM_CHECK_HINTS,
  ROOM_CHECK_LABELS,
  ROOM_CHECK_MEASURE,
  assetCheckKey,
  type Asset,
  type AssetType,
  type CheckKey,
  type CheckResult,
  type Inspection,
  type InspectionCheck,
  type Room,
  type Severity,
} from '@/domain/types'

const LOCAL_DEBOUNCE_MS = 400
const REMOTE_DEBOUNCE_MS = 3000

/**
 * Orden de lectura de la sala, no alfabético.
 *
 * El técnico entra por la puerta y mira primero lo que se ve desde el fondo del
 * aula. Alfabéticamente la botonera iría primero y el proyector el sexto, que
 * no es el orden en que nadie revisa nada.
 */
const TYPE_ORDER = [
  'PROYECTOR',
  'PANTALLA',
  'ALTAVOCES',
  'MICROFONO',
  'CAMARA',
  'BOTONERA',
  'ORDENADOR',
  'ATRIL',
]

/** Una fila de la revisión: o un elemento del inventario, o algo de la sala. */
export interface CheckRow {
  key: CheckKey
  label: string
  hint: string
  measure: { unit: string; label: string } | null
  /** El aparato, si la fila es de un aparato. */
  asset: Asset | null
  /** El tipo se creó desde un aula y nadie lo ha validado todavía. */
  pending: boolean
}

/**
 * Las filas de la revisión salen del **inventario de la sala**, no de una lista
 * fija.
 *
 * Antes había una casilla «Pantallas» que tapaba tres objetos: si fallaba, el
 * parte decía que algo de las pantallas iba mal pero no cuál, y la incidencia
 * no se podía asociar a un número de serie. Ahora cada aparato se pregunta por
 * separado.
 */
export function checkRows(assets: Asset[], types: Map<string, AssetType>): CheckRow[] {
  const rows: CheckRow[] = assets
    .filter((a) => a.status !== 'retirado')
    .map((asset) => {
      const type = resolveType(types, asset.asset_type_id)
      const label = asset.label ?? type?.name ?? 'Equipo'

      const detail = [
        asset.model,
        asset.serial,
        asset.status === 'averiado' ? 'marcado averiado' : null,
      ]
        .filter(Boolean)
        .join(' · ')

      return {
        key: assetCheckKey(asset.id),
        label,
        hint: detail || 'Sin modelo ni serie',
        measure: type?.tracks_lamp_hours ? { ...LAMP_MEASURE } : null,
        asset,
        pending: type ? !type.confirmed : false,
      }
    })
    .sort((a, b) => {
      const rank = (row: CheckRow): number => {
        const name = norm(resolveType(types, row.asset?.asset_type_id ?? '')?.name ?? '')
        const i = TYPE_ORDER.indexOf(name)
        return i === -1 ? TYPE_ORDER.length : i
      }
      return rank(a) - rank(b) || a.label.localeCompare(b.label, 'es', { numeric: true })
    })

  // Lo de la sala va al final: no es un aparato que se pueda señalar con el
  // dedo, así que tampoco encabeza la lista.
  for (const key of ROOM_CHECKS) {
    rows.push({
      key,
      label: ROOM_CHECK_LABELS[key],
      hint: ROOM_CHECK_HINTS[key],
      measure: ROOM_CHECK_MEASURE[key] ? { ...ROOM_CHECK_MEASURE[key]! } : null,
      asset: null,
      pending: false,
    })
  }

  return rows
}

export interface InspectionDraft {
  inspection: Inspection
  checks: Map<CheckKey, InspectionCheck>
}

export function useInspection(room: Room | null, userId: string | null) {
  const [draft, setDraft] = useState<InspectionDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const localTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const remoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // El inventario se lee en vivo: dar de alta un elemento tiene que añadir su
  // fila a la revisión en el momento, sin recargar ni volver atrás.
  const assets = useLiveQuery<Asset[]>(
    async () => (room ? db.assets.where('room_id').equals(room.id).toArray() : []),
    [room?.id],
  )
  const types = useLiveQuery(() => db.assetTypes.toArray(), [])

  const typesById = useMemo(
    () => new Map((types ?? []).map((t) => [t.id, t])),
    [types],
  )
  const rows = useMemo(
    () => checkRows(assets ?? [], typesById),
    [assets, typesById],
  )

  // Al abrir una sala se recupera su borrador si lo había, y si no se crea uno.
  useEffect(() => {
    if (!room) {
      setDraft(null)
      return
    }

    let cancelled = false

    void (async () => {
      const existing = await db.inspections
        .where('room_id')
        .equals(room.id)
        .filter((i) => i.status === 'borrador')
        .first()

      if (cancelled) return

      if (existing) {
        const checks = await db.checks.where('inspection_id').equals(existing.id).toArray()
        if (cancelled) return
        setDraft({
          inspection: existing,
          checks: new Map(checks.map((c) => [c.check_key, c])),
        })
        return
      }

      const inspection: Inspection = {
        id: uuidv7(),
        room_id: room.id,
        by_user: userId,
        occurred_at: new Date().toISOString(),
        recorded_at: null,
        status: 'borrador',
        overall: null,
        notes: null,
      }

      await db.inspections.put(inspection)
      if (!cancelled) setDraft({ inspection, checks: new Map() })
    })()

    return () => {
      cancelled = true
    }
  }, [room, userId])

  const scheduleSave = useCallback((next: InspectionDraft) => {
    setSaving(true)

    if (localTimer.current) clearTimeout(localTimer.current)
    localTimer.current = setTimeout(() => {
      void (async () => {
        await db.inspections.put(next.inspection)
        await db.checks.bulkPut([...next.checks.values()])
        setSaving(false)
      })()
    }, LOCAL_DEBOUNCE_MS)

    if (remoteTimer.current) clearTimeout(remoteTimer.current)
    remoteTimer.current = setTimeout(() => {
      void (async () => {
        await enqueue('inspection', next.inspection.id, {
          ...next.inspection,
          recorded_at: undefined,
        })
        for (const check of next.checks.values()) {
          await enqueue('inspection_check', check.id, check)
        }
        void flush()
      })()
    }, REMOTE_DEBOUNCE_MS)
  }, [])

  const setCheck = useCallback(
    (key: CheckKey, result: CheckResult, extra?: Partial<InspectionCheck>) => {
      setDraft((prev) => {
        if (!prev) return prev
        const checks = new Map(prev.checks)
        const existing = checks.get(key)

        checks.set(key, {
          id: existing?.id ?? uuidv7(),
          inspection_id: prev.inspection.id,
          check_key: key,
          result,
          severity: result === 'incidencia' ? (extra?.severity ?? existing?.severity ?? 'media') : null,
          measure: extra?.measure ?? existing?.measure ?? null,
          measure_unit: extra?.measure_unit ?? existing?.measure_unit ?? null,
          note: extra?.note ?? existing?.note ?? null,
        })

        const next = { ...prev, checks }
        scheduleSave(next)
        return next
      })
    },
    [scheduleSave],
  )

  /**
   * Marca OK todo lo que sigue sin tocar. Es la «revisión por excepción»: la
   * mayoría de las salas están bien, y obligar a pulsar una vez por aparato es
   * la diferencia entre revisar treinta salas en una mañana o en un día.
   *
   * No pisa lo ya marcado: si el técnico registró una incidencia y luego pulsa
   * «Todo correcto», la incidencia se respeta.
   */
  const markRestOk = useCallback(() => {
    setDraft((prev) => {
      if (!prev) return prev
      const checks = new Map(prev.checks)

      for (const row of rows) {
        if (checks.has(row.key)) continue
        checks.set(row.key, {
          id: uuidv7(),
          inspection_id: prev.inspection.id,
          check_key: row.key,
          result: 'ok',
          severity: null,
          measure: null,
          measure_unit: null,
          note: null,
        })
      }

      const next = { ...prev, checks }
      scheduleSave(next)
      return next
    })
  }, [rows, scheduleSave])

  const setNotes = useCallback(
    (notes: string) => {
      setDraft((prev) => {
        if (!prev) return prev
        const next = { ...prev, inspection: { ...prev.inspection, notes } }
        scheduleSave(next)
        return next
      })
    },
    [scheduleSave],
  )

  /** Cierra la revisión. A partir de aquí es inmutable, también en el servidor. */
  const complete = useCallback(async (): Promise<Inspection | null> => {
    if (!draft) return null

    const hasIncident = [...draft.checks.values()].some((c) => c.result === 'incidencia')
    const inspection: Inspection = {
      ...draft.inspection,
      status: 'completa',
      overall: hasIncident ? 'con_incidencias' : 'ok',
    }

    // Se cancela cualquier guardado en vuelo para que no pise el estado final.
    if (localTimer.current) clearTimeout(localTimer.current)
    if (remoteTimer.current) clearTimeout(remoteTimer.current)

    await db.inspections.put(inspection)
    await db.checks.bulkPut([...draft.checks.values()])

    await enqueue('inspection', inspection.id, { ...inspection, recorded_at: undefined })
    for (const check of draft.checks.values()) {
      await enqueue('inspection_check', check.id, check)
    }
    void flush()

    setDraft(null)
    return inspection
  }, [draft])

  return { draft, rows, saving, setCheck, setNotes, markRestOk, complete }
}

export type { Severity }
