/**
 * Autoguardado en dos niveles.
 *
 * Nivel 1 — Dexie, con 400ms de espera: instantáneo y funciona siempre.
 * Nivel 2 — servidor, con 3s: el borrador **no es un fichero local**, es una
 * fila en `inspections` que el técnico puede recuperar desde cualquier
 * dispositivo. Cerrar la app, quedarse sin batería, romper el móvil o que iOS
 * limpie el almacenamiento no pierde trabajo.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { v7 as uuidv7 } from 'uuid'
import { db, enqueue } from '@/db/dexie'
import { flush } from '@/sync/outbox'
import {
  CHECK_REQUIRES,
  type CheckKey,
  type CheckResult,
  type Inspection,
  type InspectionCheck,
  type Room,
  type Severity,
} from '@/domain/types'

const LOCAL_DEBOUNCE_MS = 400
const REMOTE_DEBOUNCE_MS = 3000

/** Qué comprobaciones tienen sentido en esta sala, y cuáles nacen en "No aplica". */
export function checksForRoom(room: Room): Array<{ key: CheckKey; applicable: boolean }> {
  const keys: CheckKey[] = ['pantallas', 'proyector', 'sonido', 'microfono', 'camara', 'red', 'botonera']

  return keys.map((key) => {
    const requirement = CHECK_REQUIRES[key]
    return { key, applicable: requirement === null || room.capabilities[requirement] === true }
  })
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

  // Al abrir una sala se recupera su borrador si lo había, y si no se crea uno
  // con las comprobaciones ya prerrellenadas según el equipamiento de la sala.
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
          checks: new Map(checks.map((c) => [c.check_key as CheckKey, c])),
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

      // Lo que la sala no tiene se marca "No aplica" de entrada. Así una
      // revisión con 7 comprobaciones se resuelve en dos o tres toques reales.
      const checks = new Map<CheckKey, InspectionCheck>()
      for (const { key, applicable } of checksForRoom(room)) {
        if (!applicable) {
          checks.set(key, {
            id: uuidv7(),
            inspection_id: inspection.id,
            check_key: key,
            result: 'na',
            severity: null,
            measure: null,
            measure_unit: null,
            note: 'La sala no tiene este equipamiento',
          })
        }
      }

      await db.inspections.put(inspection)
      await db.checks.bulkPut([...checks.values()])
      if (!cancelled) setDraft({ inspection, checks })
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

  return { draft, saving, setCheck, setNotes, complete }
}

export type { Severity }
