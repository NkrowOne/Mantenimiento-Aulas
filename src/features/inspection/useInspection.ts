/**
 * Autoguardado en dos niveles.
 *
 * Nivel 1 — Dexie, con 400ms de espera: instantáneo y funciona siempre.
 * Nivel 2 — servidor, con 3s: el borrador **no es un fichero local**, es una
 * fila en `inspections` que el técnico puede recuperar desde cualquier
 * dispositivo. Cerrar la app, quedarse sin batería, romper el móvil o que iOS
 * limpie el almacenamiento no pierde trabajo.
 *
 * Y desde aquí sale también **la corrección**: la misma pantalla, el mismo
 * autoguardado y el mismo cierre, pero sembrada con lo que dijo una revisión
 * anterior y apuntando a ella. Es el mismo trabajo —revisar un aula— hecho una
 * segunda vez sobre el mismo día, así que sería un error tener dos formularios.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { v7 as uuidv7 } from 'uuid'
import { db, enqueue } from '@/db/dexie'
import { flush } from '@/sync/outbox'
import { rangoDeTipo, resolveType } from '@/domain/inventory'
import { incidenciasDeRevision } from '@/domain/incidencias'
import { checksDeSemilla, type Semilla } from '@/domain/revision'
import {
  LAMP_MEASURE,
  LEGACY_CHECK_LABELS,
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
 * Rango de un tipo en el recorrido del aula, a partir de su identificador.
 *
 * El orden vive en `domain/inventory` porque lo comparten tres pantallas; aquí
 * solo se resuelve el tipo —siguiendo las fusiones— antes de preguntarlo.
 */
export function typeRank(types: Map<string, AssetType>, assetTypeId: string): number {
  return rangoDeTipo(resolveType(types, assetTypeId)?.name)
}

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
    .sort(
      (a, b) =>
        typeRank(types, a.asset?.asset_type_id ?? '') -
          typeRank(types, b.asset?.asset_type_id ?? '') ||
        a.label.localeCompare(b.label, 'es', { numeric: true }),
    )

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

/**
 * Lo que hace falta para corregir una revisión, tal y como llega de la ficha.
 *
 * La ficha ya ha tenido que hablar con el servidor para poder enseñar la lista de
 * revisiones, así que trae el detalle consigo en vez de obligar al formulario a
 * pedirlo otra vez —y a fallar si en ese segundo se ha ido la cobertura—. Desde
 * que el borrador existe en el dispositivo, la corrección sigue sin red como
 * cualquier revisión.
 */
export interface Correccion {
  /** La revisión que se va a reemplazar. */
  baseId: string
  /** La fecha de la visita original, que la corrección conserva. */
  occurredAt: string
  /** Quién la firmó, para poder decirlo en la cabecera. */
  who: string | null
  /** Cómo salió, para poder decir de qué se parte. */
  fallos: number
  /** Sus fotos siguen siendo las de aquel día: se enseñan al corregir. */
  fotos: number
  /** Lo que contestó, ya filtrado a lo que hoy se puede tocar. */
  semilla: Semilla | null
  /** Lo que aquella revisión anotó debajo de las fotos. */
  notes: string | null
}

export function useInspection(
  room: Room | null,
  userId: string | null,
  /**
   * Si viene, esta pantalla corrige una revisión en vez de abrir una nueva.
   *
   * El borrador de una corrección y el de una revisión normal conviven en la
   * misma sala sin mezclarse: se distinguen por `corrects`. Sin eso, empezar una
   * corrección y luego pulsar «Revisar esta sala» habría continuado la
   * corrección sin decirlo, y lo que iba a ser una visita nueva habría acabado
   * reemplazando a una vieja.
   */
  correccion?: Correccion | null,
) {
  const qc = useQueryClient()
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
  const baseId = correccion?.baseId ?? null
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
        // El borrador de la corrección de ESTA revisión, o el de la revisión
        // normal. `?? null` porque un borrador guardado antes de que la columna
        // existiera llega con `undefined`, que significa lo mismo que nulo.
        .filter((i) => i.status === 'borrador' && (i.corrects ?? null) === baseId)
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

      const id = uuidv7()
      const inspection: Inspection = {
        id,
        room_id: room.id,
        by_user: userId,
        /*
         * La corrección conserva la fecha de la visita.
         *
         * Es lo que impide que arreglar una errata de marzo convierta al aula en
         * «revisada hoy» y la saque de la lista de pendientes sin que nadie haya
         * entrado en ella.
         */
        occurred_at: correccion?.occurredAt ?? new Date().toISOString(),
        recorded_at: null,
        status: 'borrador',
        overall: null,
        // Se arrastra la observación: casi siempre sigue siendo verdad, y
        // obligar a reescribirla es la vía rápida a perderla.
        notes: correccion?.notes ?? null,
        corrects: baseId,
        corrected_at: baseId ? new Date().toISOString() : null,
      }

      const sembradas = correccion?.semilla
        ? checksDeSemilla(correccion.semilla.checks, id, uuidv7)
        : []

      await db.transaction('rw', db.inspections, db.checks, async () => {
        await db.inspections.put(inspection)
        if (sembradas.length > 0) await db.checks.bulkPut(sembradas)
      })

      /*
       * Y sube ya, sin esperar al primer toque.
       *
       * Una revisión normal nace vacía y no hay nada que respaldar hasta que
       * alguien marca algo. Una corrección nace con contenido —lo que dijo la
       * original—, y la regla del proyecto es que nada pendiente viva solo en el
       * móvil: si el aparato se rompe con la corrección a medias, lo que se
       * recupere desde otro tiene que incluir lo que se arrastró.
       */
      if (sembradas.length > 0) {
        await db.transaction('rw', db.outbox, async () => {
          await enqueue('inspection', id, { ...inspection, recorded_at: undefined })
          for (const c of sembradas) await enqueue('inspection_check', c.id, c)
        })
        void flush()
      }

      if (cancelled) return

      setDraft({
        inspection,
        checks: new Map(sembradas.map((c) => [c.check_key, c])),
      })
    })()

    return () => {
      cancelled = true
    }
    // Las dependencias son las tres que identifican el borrador. `correccion`
    // entera queda fuera a propósito: la ficha construye el objeto al vuelo y con
    // él aquí cada redibujado volvería a buscar el borrador.
  }, [room, userId, baseId])

  /**
   * Qué comprobaciones han cambiado desde el último guardado.
   *
   * Sin esto, cada toque reescribía las nueve filas y reencolaba las nueve
   * entradas, cada `enqueue` en su propia transacción: unas veinte transacciones
   * de IndexedDB para reflejar un solo dedo. Y cada una emitía su evento de
   * cambio, que la lámpara de la cabecera observa.
   */
  const sucias = useRef(new Set<CheckKey>())

  const scheduleSave = useCallback((next: InspectionDraft) => {
    setSaving(true)

    if (localTimer.current) clearTimeout(localTimer.current)
    localTimer.current = setTimeout(() => {
      void (async () => {
        const cambiadas = [...sucias.current]
          .map((k) => next.checks.get(k))
          .filter((c): c is InspectionCheck => c !== undefined)

        // Una sola transacción: un único evento de cambio en vez de uno por fila.
        await db.transaction('rw', db.inspections, db.checks, async () => {
          await db.inspections.put(next.inspection)
          if (cambiadas.length > 0) await db.checks.bulkPut(cambiadas)
        })
        setSaving(false)
      })()
    }, LOCAL_DEBOUNCE_MS)

    if (remoteTimer.current) clearTimeout(remoteTimer.current)
    remoteTimer.current = setTimeout(() => {
      void (async () => {
        const cambiadas = [...sucias.current]
          .map((k) => next.checks.get(k))
          .filter((c): c is InspectionCheck => c !== undefined)
        sucias.current = new Set()

        await db.transaction('rw', db.outbox, async () => {
          await enqueue('inspection', next.inspection.id, {
            ...next.inspection,
            recorded_at: undefined,
          })
          for (const check of cambiadas) {
            await enqueue('inspection_check', check.id, check)
          }
        })
        void flush()
      })()
    }, REMOTE_DEBOUNCE_MS)
  }, [])

  /*
   * Volcado al desmontar.
   *
   * Los dos temporizadores dejan una ventana en la que lo último que se tocó
   * solo vive en memoria. Salir del aula sin cerrar la revisión —el botón
   * «Volver», o cambiar de pestaña— caía en esa ventana y perdía el último
   * toque. `complete()` no cubre este caso porque justamente no se llama.
   */
  const draftRef = useRef<InspectionDraft | null>(null)
  useEffect(() => {
    draftRef.current = draft
  }, [draft])

  useEffect(() => {
    return () => {
      if (localTimer.current) clearTimeout(localTimer.current)
      if (remoteTimer.current) clearTimeout(remoteTimer.current)

      const pendiente = draftRef.current
      if (!pendiente || sucias.current.size === 0) return

      const cambiadas = [...sucias.current]
        .map((k) => pendiente.checks.get(k))
        .filter((c): c is InspectionCheck => c !== undefined)

      void (async () => {
        await db.transaction('rw', db.inspections, db.checks, async () => {
          await db.inspections.put(pendiente.inspection)
          if (cambiadas.length > 0) await db.checks.bulkPut(cambiadas)
        })
        await db.transaction('rw', db.outbox, async () => {
          await enqueue('inspection', pendiente.inspection.id, {
            ...pendiente.inspection,
            recorded_at: undefined,
          })
          for (const check of cambiadas) await enqueue('inspection_check', check.id, check)
        })
        void flush()
      })()
    }
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

        sucias.current.add(key)
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
        sucias.current.add(row.key)
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

  /**
   * Cómo se llama una comprobación.
   *
   * Sale de las filas que la revisión tiene delante, y si no está —un equipo que
   * se retiró entre el borrador y el cierre— cae en los nombres de las
   * comprobaciones antiguas. La última red es la propia clave: preferible un
   * título con `asset:1f2e…` que una incidencia que nadie abre por no tener
   * nombre.
   */
  const etiquetaDe = useCallback(
    (key: CheckKey): string =>
      rows.find((r) => r.key === key)?.label ?? LEGACY_CHECK_LABELS[key] ?? key,
    [rows],
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

    /*
     * Y los equipos que fallan se convierten en incidencias.
     *
     * Esta es la pieza que faltaba. Antes, marcar «Falla» dejaba una fila en
     * `inspection_checks` y nada más: la avería no salía en la pestaña de
     * Incidencias, no contaba en el aula y nadie tenía que cerrarla. La
     * aplicación sabía que el proyector estaba roto y no se lo pedía a nadie.
     *
     * Se decide con el espejo local —que guarda las incidencias sin resolver— así
     * que funciona igual dentro de un sótano: si ese equipo ya tiene una abierta,
     * no se abre otra, y la revisión de la ronda siguiente no duplica nada.
     */
    const abiertas = await db.incidents.where('room_id').equals(inspection.room_id).toArray()
    const nuevas = incidenciasDeRevision({
      inspection,
      checks: [...draft.checks.values()],
      etiquetaDe,
      abiertas,
      nuevoId: uuidv7,
    })
    if (nuevas.length > 0) await db.incidents.bulkPut(nuevas)

    /*
     * Y la sala se marca revisada **en local**, no solo en el servidor.
     *
     * Sin esto la lista mentía justo cuando más se usa: `last_inspection_at`
     * solo se escribía al descargar el maestro, y ese pull ocurre una única vez
     * al desbloquear la sesión. Así que el aula recién terminada volvía a la
     * lista con su raíl naranja, diciendo «Sin revisar» y en primera posición,
     * indistinguible de la que no has tocado — durante toda la mañana si no hay
     * cobertura. El riesgo real no es estético: es volver a entrar en un aula ya
     * hecha.
     *
     * Es optimista y el siguiente pull lo confirma con el valor del servidor.
     *
     * Una corrección no lo toca, y ahí está media gracia del asunto: no es una
     * visita, es la misma de aquel día contada mejor. Escribirlo movería la fecha
     * hacia atrás cuando se corrige una revisión antigua —la sala aparecería sin
     * revisar teniendo una posterior— y no cambiaría nada cuando se corrige la de
     * hoy, porque la original ya la puso.
     */
    if (!inspection.corrects) {
      await db.rooms.update(inspection.room_id, {
        last_inspection_at: inspection.occurred_at,
      })
    }

    // Al cerrar sí se manda todo, y en una transacción: es la última
    // oportunidad de que el servidor reciba la revisión íntegra.
    await db.transaction('rw', db.outbox, async () => {
      await enqueue('inspection', inspection.id, { ...inspection, recorded_at: undefined })
      for (const check of draft.checks.values()) {
        await enqueue('inspection_check', check.id, check)
      }
      // Detrás de la revisión y de sus comprobaciones a propósito: la incidencia
      // apunta a la revisión de la que salió, y el orden de subida de la cola
      // —`ORDER`, en outbox.ts— ya coloca `incident` después de `inspection` y de
      // `asset`, así que un equipo dado de alta y averiado en la misma visita
      // llega en el orden que la clave ajena necesita.
      for (const inc of nuevas) {
        await enqueue('incident', inc.id, inc)
      }
    })
    sucias.current = new Set()
    void flush()

    /*
     * Y lo que el servidor ya no puede responder igual se marca como caduco.
     *
     * Las pantallas de consulta cachean un minuto, que está bien para navegar y
     * es exactamente lo peor aquí: el técnico cierra la revisión, entra en la
     * ficha del aula y no ve ni la observación que acaba de escribir ni la
     * incidencia que acaba de abrir. Parecería que no se guardó.
     *
     * Se marcan por prefijo de clave —todas las salas— y no solo esta: al
     * encadenar salas se cierran varias seguidas, y acertar con la sala de cada
     * una obligaría a llevar la cuenta. Marcar caduco no dispara ninguna
     * consulta: solo hace que la próxima pantalla que se abra pida datos frescos.
     */
    void qc.invalidateQueries({ queryKey: ['room-timeline'] })
    void qc.invalidateQueries({ queryKey: ['room-inspections'] })
    void qc.invalidateQueries({ queryKey: ['room-reliability'] })
    // Las fotos, por lo mismo: la que se acaba de hacer sale de la cola local en
    // cuanto sube, y sin esto la ficha seguiría enseñando la lista de adjuntos de
    // antes de subirla — o sea, ninguna.
    void qc.invalidateQueries({ queryKey: ['fotos-revision'] })
    if (nuevas.length > 0) void qc.invalidateQueries({ queryKey: ['incidents'] })

    setDraft(null)
    return inspection
  }, [draft, etiquetaDe, qc])

  /**
   * Tira una corrección empezada.
   *
   * Hace falta porque el borrador de una corrección es persistente a propósito:
   * sin una salida, un «Corregir» pulsado por error deja a la ficha ofreciendo
   * «Continuar la corrección» para siempre, y con él delante nadie sabe si la
   * revisión que está leyendo es la de verdad.
   *
   * Solo borra el borrador —local y su sitio en la cola—. La revisión que se iba
   * a corregir no se toca, que es lo que hace esto seguro: descartar no puede
   * perder nada porque la corrección no había reemplazado nada todavía. Si el
   * borrador ya había subido, en el servidor queda una fila en `borrador` que
   * ninguna vista mira; borrarla del todo es cosa de administración, y el técnico
   * no tiene —ni debe tener— permiso para borrar filas.
   */
  const descartarBorrador = useCallback(async (): Promise<void> => {
    if (!draft) return

    if (localTimer.current) clearTimeout(localTimer.current)
    if (remoteTimer.current) clearTimeout(remoteTimer.current)

    const ids = [...draft.checks.values()].map((c) => c.id)

    await db.transaction('rw', db.inspections, db.checks, db.outbox, async () => {
      await db.checks.where('inspection_id').equals(draft.inspection.id).delete()
      await db.inspections.delete(draft.inspection.id)
      await db.outbox.bulkDelete([draft.inspection.id, ...ids])
    })

    sucias.current = new Set()
    setDraft(null)
  }, [draft])

  // `assets`, `types` y `typesById` se devuelven además de usarse aquí: la
  // página los necesita para el bloque de inventario y antes montaba SU PROPIA
  // copia de las dos mismas consultas de Dexie, con su propio observador y su
  // propio ciclo de re-render por cada cambio.
  return {
    draft,
    rows,
    assets: assets ?? [],
    types: types ?? [],
    typesById,
    saving,
    setCheck,
    setNotes,
    markRestOk,
    complete,
    descartarBorrador,
  }
}

export type { Severity }
