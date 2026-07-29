/**
 * Ficha de sala.
 *
 * La pantalla del prototipo que nunca llegó a construirse, y la que sostiene una
 * pieza que hoy falta del todo: **registrar sin que nada haya fallado**.
 *
 * Toda la aplicación asumía que un registro nace de una revisión que sale mal.
 * Pero lo que hoy acaba en la columna de observaciones del Excel —un soporte
 * flojo, una pizarra abombada, una lámpara al 12 % que todavía funciona, o la
 * petición de instalar una cámara— no es una revisión que falla: es alguien que
 * pasa por delante y ve algo. Sin un sitio donde ponerlo, se pierde. Y se
 * pierde exactamente igual que se pierde hoy.
 *
 * Por eso el botón está aquí y está siempre disponible, no colgando de un bloque
 * en FALLA. Y por eso **basta la sala para guardar**: nada obliga a teclear de
 * pie en un pasillo. Lo aplazado va a la bandeja de borradores, que es la
 * contrapartida honesta de permitir aplazar.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { v7 as uuidv7 } from 'uuid'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { RoomPlate } from '@/components/RoomPlate'
import { DoorPlate } from '@/components/DoorPlate'
import { displayRoomCode } from '@/domain/normalize'
import { fechaCorta } from '@/domain/fechas'
import { INCIDENT_KIND_LABELS, type IncidentKind, type Room } from '@/domain/types'

interface TimelineRow {
  at: string
  kind: 'incidencia' | 'solicitud' | 'observacion' | 'revision_ok' | 'revision_ko'
  title: string
  ref: string | null
  who: string | null
  state: string
}

interface Fiabilidad {
  score: number
  incidencias: number
  observaciones: number
  solicitudes: number
  revisiones: number
  hay_datos: boolean
}

interface Reincidencia {
  item: string
  veces: number
  desde: string
  hasta: string
}

/** Cómo se marca cada cosa en la línea de tiempo. Nunca solo el color. */
const MARCA: Record<TimelineRow['kind'], { punto: string; texto: string }> = {
  incidencia: { punto: 'bg-crit', texto: 'Incidencia' },
  solicitud: { punto: 'bg-accent', texto: 'Solicitud' },
  observacion: { punto: 'bg-warn', texto: 'Observación' },
  revision_ok: { punto: 'bg-ok', texto: 'Revisión' },
  revision_ko: { punto: 'bg-crit', texto: 'Revisión' },
}

interface Props {
  room: Room
  buildingName: string
  zoneName: string
  userId: string | null
  onBack: () => void
  onRevisar: () => void
  /** Ir a la hoja de placas del edificio, lista para imprimir. */
  onImprimir: () => void
}

export function RoomSheet({
  room,
  buildingName,
  zoneName,
  userId,
  onBack,
  onRevisar,
  onImprimir,
}: Props): React.ReactElement {
  const qc = useQueryClient()
  const [abierto, setAbierto] = useState(false)
  const [kind, setKind] = useState<IncidentKind>('incidencia')
  const [texto, setTexto] = useState('')
  const [codigo, setCodigo] = useState('')
  const [guardado, setGuardado] = useState<string | null>(null)

  // El inventario sale del espejo local: la ficha tiene que abrirse en un
  // sótano sin cobertura igual que la revisión.
  const equipos = useLiveQuery(async () => {
    const assets = await db.assets.where('room_id').equals(room.id).toArray()
    const tipos = new Map((await db.assetTypes.toArray()).map((t) => [t.id, t]))
    return assets
      .map((a) => ({ ...a, tipo: tipos.get(a.asset_type_id)?.name ?? 'Sin tipo' }))
      .sort((x, y) => x.tipo.localeCompare(y.tipo, 'es'))
  }, [room.id])

  const { data: fiabilidad } = useQuery({
    queryKey: ['room-reliability', room.id],
    queryFn: async (): Promise<Fiabilidad | null> => {
      const { data, error } = await supabase
        .from('room_reliability')
        .select('*')
        .eq('room_id', room.id)
        .maybeSingle()
      if (error) throw error
      return (data as Fiabilidad | null) ?? null
    },
  })

  const { data: reincidencias } = useQuery({
    queryKey: ['room-repeats', room.id],
    queryFn: async (): Promise<Reincidencia[]> => {
      const { data, error } = await supabase
        .from('room_repeat_offenders')
        .select('*')
        .eq('room_id', room.id)
        .order('veces', { ascending: false })
      if (error) throw error
      return (data ?? []) as Reincidencia[]
    },
  })

  const { data: historial, isError: historialFalla } = useQuery({
    queryKey: ['room-timeline', room.id],
    queryFn: async (): Promise<TimelineRow[]> => {
      const { data, error } = await supabase
        .from('room_timeline')
        .select('*')
        .eq('room_id', room.id)
        .order('at', { ascending: false })
        .limit(30)
      if (error) throw error
      return (data ?? []) as TimelineRow[]
    },
  })

  /*
   * Guardar el registro.
   *
   * Nace como `borrador` cuando no hay título, y como `abierta` cuando sí lo
   * hay: la restricción de la base dice exactamente eso, y repetirla aquí evita
   * que el servidor rechace algo que la pantalla dejó escribir.
   *
   * El id se genera en el cliente (UUID v7), que es lo que permite que la fila
   * nazca con su identidad definitiva sin haber hablado con nadie.
   */
  const registrar = useMutation({
    mutationFn: async () => {
      const titulo = texto.trim()
      const { error } = await supabase.from('incidents').insert({
        id: uuidv7(),
        room_id: room.id,
        kind,
        title: titulo || null,
        state: titulo ? 'abierta' : 'borrador',
        external_ref: codigo.trim() || null,
        opened_at: new Date().toISOString(),
        opened_by: userId,
      })
      if (error) throw error
      return titulo.length > 0
    },
    onSuccess: (completo) => {
      setGuardado(
        completo
          ? `${INCIDENT_KIND_LABELS[kind]} registrada.`
          : `Borrador guardado. Complétalo cuando puedas desde la bandeja.`,
      )
      setTexto('')
      setCodigo('')
      setAbierto(false)
      void qc.invalidateQueries({ queryKey: ['room-timeline', room.id] })
      void qc.invalidateQueries({ queryKey: ['borradores'] })
    },
  })

  return (
    <div className="pb-4">
      <RoomPlate
        building={buildingName}
        zone={zoneName}
        title={room.name || displayRoomCode(room.code)}
        code={displayRoomCode(room.code)}
        onBack={onBack}
      />

      <div className="mx-auto max-w-2xl px-4 pb-10">
        {/*
          La placa, con su código escaneable.
          Va arriba del todo porque es lo que identifica la sala, y porque es lo
          que alguien viene a buscar cuando entra aquí desde el listado: «¿es
          esta?». El QR codifica el identificador interno, no el nombre, así que
          renombrar la sala no invalida las etiquetas ya atornilladas.
        */}
        {room.short_ref && (
          <section aria-labelledby="sec-placa" className="mt-6">
            <div className="section-head">
              <h2 id="sec-placa" className="eyebrow">Placa de puerta</h2>
            </div>
            <DoorPlate
              building={buildingName}
              zone={zoneName}
              title={room.name || displayRoomCode(room.code)}
              ref={room.short_ref}
              id={room.id}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onImprimir}
                className="key key-quiet min-h-11 px-3 text-sm"
              >
                Imprimir las placas del edificio
              </button>
            </div>
          </section>
        )}

        {/*
          El índice, y de qué está hecho.
          Un número solo invita a discutirlo; un número con su recuento al lado
          se puede comprobar. Y con la base recién arrancada dice honestamente
          que no sabe lo suficiente, en vez de sacar un 100 de la nada — que se
          leería como «va perfecta» cuando significa «no sé nada de ella».
        */}
        {fiabilidad && (
          <div className="card mt-4 flex items-center gap-4 p-4">
            <span
              className={`font-mono text-3xl font-bold tabular ${
                !fiabilidad.hay_datos
                  ? 'text-muted'
                  : fiabilidad.score >= 75
                    ? 'text-ok'
                    : fiabilidad.score >= 45
                      ? 'text-warn'
                      : 'text-crit'
              }`}
            >
              {fiabilidad.hay_datos ? fiabilidad.score : '—'}
            </span>
            <div className="min-w-0 text-sm">
              <p className="font-medium">Índice de fiabilidad</p>
              <p className="text-muted">
                {fiabilidad.hay_datos
                  ? `${fiabilidad.incidencias} incidencias · ${fiabilidad.observaciones} observaciones · ${fiabilidad.revisiones} revisiones en el último año`
                  : 'Datos insuficientes todavía: hacen falta unas cuantas revisiones más para que este número signifique algo.'}
              </p>
              {fiabilidad.hay_datos && fiabilidad.solicitudes > 0 && (
                <p className="mt-1 text-xs text-muted">
                  {fiabilidad.solicitudes} solicitudes, que no penalizan: pedir trabajo no es un
                  fallo de la sala.
                </p>
              )}
            </div>
          </div>
        )}

        {(reincidencias ?? []).map((r) => (
          <div key={r.item} className="card mt-3 border-warn/30 bg-warn-tint p-4 text-sm">
            <p className="font-medium text-warn">Reincidencia detectada: {r.item}</p>
            <p className="mt-1">
              {r.veces} sustituciones en esta sala desde {fechaCorta(r.desde)}. Poner la pieza otra
              vez no resuelve la causa: conviene revisar canalización, rosetas o longitud del
              tirado.
            </p>
            <p className="mt-1 text-xs text-muted">
              Basado en {r.veces} incidencias con consumo de ese artículo, la última el{' '}
              {fechaCorta(r.hasta)}.
            </p>
          </div>
        ))}

        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onRevisar} className="key key-accent min-h-11 flex-1 px-3 text-sm">
            Revisar esta sala
          </button>
          <button
            type="button"
            onClick={() => setAbierto((v) => !v)}
            className="key key-quiet min-h-11 flex-1 px-3 text-sm"
          >
            {abierto ? 'Cancelar' : 'Registrar algo'}
          </button>
        </div>

        {guardado && !abierto && (
          <p aria-live="polite" className="mt-3 text-sm text-ok">
            {guardado}
          </p>
        )}

        {abierto && (
          <form
            className="card mt-3 p-4"
            onSubmit={(e) => {
              e.preventDefault()
              registrar.mutate()
            }}
          >
            <h2 className="eyebrow">
              Registrar en {room.name || displayRoomCode(room.code)}
            </h2>

            {/* Los tres tipos, a la vista y sin desplegable: son tres y se elige
                uno de pie. Un `select` aquí serían dos toques y una lista. */}
            <div className="mt-2 flex gap-2">
              {(Object.keys(INCIDENT_KIND_LABELS) as IncidentKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={kind === k}
                  onClick={() => setKind(k)}
                  className={`key min-h-11 flex-1 px-2 text-xs ${
                    kind === k ? 'key-accent' : 'key-quiet'
                  }`}
                >
                  {INCIDENT_KIND_LABELS[k]}
                </button>
              ))}
            </div>

            <textarea
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              rows={3}
              placeholder="¿Qué ocurre? Opcional — se puede rellenar luego."
              className="mt-3 w-full rounded-ctl border border-line bg-surface p-3 text-sm"
            />

            {/* Una observación no genera ticket en ningún sitio, así que pedirle
                el código sería pedir algo que no existe. */}
            {kind !== 'observacion' && (
              <label className="mt-3 block text-sm">
                <span className="text-muted">Código de ticket externo</span>
                <input
                  value={codigo}
                  onChange={(e) => setCodigo(e.target.value)}
                  placeholder="I260728_0001"
                  className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 font-mono text-sm"
                />
              </label>
            )}

            <p className="mt-3 text-xs text-muted">
              Basta la sala para guardar. Lo demás se completa después, desde la bandeja de
              borradores.
            </p>

            {registrar.isError && (
              <p className="mt-2 text-sm text-crit">
                {registrar.error instanceof Error ? registrar.error.message : 'No se ha podido guardar.'}
              </p>
            )}

            <button
              type="submit"
              disabled={registrar.isPending}
              className="key key-accent mt-3 min-h-11 w-full px-3 text-sm"
            >
              {registrar.isPending
                ? 'Guardando…'
                : texto.trim()
                  ? `Guardar ${INCIDENT_KIND_LABELS[kind].toLowerCase()}`
                  : 'Guardar borrador'}
            </button>
          </form>
        )}

        <section aria-labelledby="sec-inv" className="mt-8">
          <div className="section-head">
            <h2 id="sec-inv" className="eyebrow">Inventario instalado</h2>
          </div>
          <ul className="divide-y divide-line">
            {(equipos ?? []).map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="flex-1">
                  {a.label || a.tipo}
                  <span className="block font-mono text-xs text-muted">
                    {[a.model, a.serial].filter(Boolean).join(' · ') || 'Sin modelo ni serie'}
                  </span>
                </span>
                {a.status !== 'instalado' && (
                  <span className="rounded-tag bg-warn-tint px-2 py-0.5 text-xs text-warn">
                    {a.status}
                  </span>
                )}
              </li>
            ))}
            {equipos?.length === 0 && (
              <li className="py-2 text-sm text-muted">Sin equipos registrados en esta sala.</li>
            )}
          </ul>
        </section>

        <section aria-labelledby="sec-hist" className="mt-8">
          <div className="section-head">
            <h2 id="sec-hist" className="eyebrow">Historial</h2>
          </div>
          {historialFalla && (
            <p className="mt-2 text-sm text-muted">
              El historial necesita conexión; lo demás de esta ficha funciona sin ella.
            </p>
          )}
          <ul className="mt-2 space-y-3">
            {(historial ?? []).map((h, i) => (
              <li key={`${h.at}-${i}`} className="flex gap-3">
                <span
                  aria-hidden
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-[1px] ${MARCA[h.kind].punto}`}
                />
                <div className="min-w-0 flex-1 text-sm">
                  <p>
                    <span className="text-muted">{MARCA[h.kind].texto} — </span>
                    {h.title}
                    {h.state === 'borrador' && (
                      <span className="ml-2 rounded-tag bg-warn-tint px-1.5 py-0.5 text-xs text-warn">
                        sin completar
                      </span>
                    )}
                  </p>
                  <p className="font-mono text-xs text-muted">
                    {[fechaCorta(h.at), h.who, h.ref].filter(Boolean).join(' · ')}
                  </p>
                </div>
              </li>
            ))}
            {historial?.length === 0 && (
              <li className="text-sm text-muted">Todavía no hay nada registrado en esta sala.</li>
            )}
          </ul>
        </section>
      </div>
    </div>
  )
}
