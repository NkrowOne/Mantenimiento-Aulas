/**
 * El parte de hoy: lo abierto y lo cerrado en el día, listo para EasyVista.
 *
 * Es la pantalla del final de la jornada. Quien pasa el día a EasyVista
 * necesita tres cosas y nada más: qué ha pasado hoy, en qué estado está cada
 * cosa, y poder llevárselo sin teclearlo otra vez. Por eso cada fila trae su
 * botón de copiar y su casilla para el código, y por eso lo que todavía no
 * tiene código va arriba, aparte: esa es la lista de lo que falta por hacer.
 *
 * No se resuelve ni se apunta material desde aquí. Para eso está la lista de
 * al lado; esto es para leer y pasar.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { copiar } from '@/lib/portapapeles'
import { cuantos } from '@/lib/plural'
import { displayRoomCode } from '@/domain/normalize'
import { ZONA, diaEnMadrid, fechaCorta, horaCorta } from '@/domain/fechas'
import {
  filasDelParte,
  limitesDelDia,
  moverDia,
  resumenDelParte,
  textoParaEasyVista,
  type CierreEnCola,
  type FilaDelParte,
  type IncidenciaDelParte,
} from '@/domain/parteDelDia'
import { INCIDENT_KIND_LABELS } from '@/domain/types'
import { usePersonas } from '@/sync/personas'
import { CodigoEasyVista } from './CodigoEasyVista'
import { useCierresEnCola } from './cierresEnCola'

const COLUMNAS =
  'id,title,description,severity,state,kind,opened_at,opened_by,resolved_at,resolved_by,resolution,external_ref,easyvista_ref,room_id'

/** «lunes, 16 de noviembre», del día de Madrid. */
function nombreDelDia(dia: string): string {
  // A mediodía UTC: en Madrid sigue siendo ese mismo día en verano y en invierno.
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: ZONA,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${dia}T12:00:00Z`))
}

/**
 * Un botón que copia y lo dice.
 *
 * «Copiado» dura dos segundos y vuelve: sin esa respuesta no hay forma de
 * saber si el toque ha hecho algo hasta que se pega en la otra ventana.
 */
function Copiar({
  texto,
  children,
  className = 'key key-quiet min-h-11 px-3 text-xs',
}: {
  texto: string
  children: React.ReactNode
  className?: string
}): React.ReactElement {
  const [estado, setEstado] = useState<'reposo' | 'copiado' | 'fallo'>('reposo')
  const reloj = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(reloj.current), [])

  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        void copiar(texto).then((hecho) => {
          setEstado(hecho ? 'copiado' : 'fallo')
          window.clearTimeout(reloj.current)
          reloj.current = window.setTimeout(() => setEstado('reposo'), 2000)
        })
      }}
    >
      <span aria-live="polite">
        {estado === 'copiado' ? 'Copiado ✓' : estado === 'fallo' ? 'No se pudo copiar' : children}
      </span>
    </button>
  )
}

export function ParteDeHoy({
  onAbrirSala,
}: {
  onAbrirSala?: (roomId: string) => void
}): React.ReactElement {
  const hoy = diaEnMadrid()
  const [dia, setDia] = useState(hoy)
  const esHoy = dia === hoy
  const limites = useMemo(() => limitesDelDia(dia), [dia])

  const nombreDe = usePersonas()
  // Además de dar los ids, vuelve a pedir la lista cuando un cierre sube.
  useCierresEnCola()

  const servidor = useQuery({
    // Empieza por `incidents` para que guardar un código de EasyVista —que
    // invalida esa clave— refresque también este parte.
    queryKey: ['incidents', 'parte', dia],
    queryFn: async (): Promise<IncidenciaDelParte[]> => {
      const d = `"${limites.desde}"`
      const h = `"${limites.hasta}"`
      const { data, error } = await supabase
        .from('incidents')
        .select(COLUMNAS)
        .neq('state', 'borrador')
        .neq('kind', 'observacion')
        .or(
          `and(opened_at.gte.${d},opened_at.lt.${h}),and(resolved_at.gte.${d},resolved_at.lt.${h})`,
        )
        .order('opened_at')
        .limit(500)
      if (error) throw error
      return (data ?? []) as unknown as IncidenciaDelParte[]
    },
  })

  /* Lo del dispositivo: lo abierto sin cobertura y los cierres que esperan.
     Sin esto, el parte de un día de aulas sin red saldría medio vacío justo
     para quien ha hecho el trabajo. */
  const local = useLiveQuery(async () => {
    const [incidencias, cola, rooms, zones, buildings] = await Promise.all([
      db.incidents.toArray(),
      db.outbox.where('entity').anyOf('incident', 'incident_resolution').toArray(),
      db.rooms.toArray(),
      db.zones.toArray(),
      db.buildings.toArray(),
    ])
    const zoneById = new Map(zones.map((z) => [z.id, z]))
    const buildingById = new Map(buildings.map((b) => [b.id, b]))
    const salas = new Map<string, string>()
    for (const r of rooms) {
      const zone = zoneById.get(r.zone_id)
      const building = zone ? buildingById.get(zone.building_id) : undefined
      salas.set(r.id, `${building?.code ?? ''} ${displayRoomCode(r.code)}`.trim())
    }
    return {
      incidencias: incidencias as IncidenciaDelParte[],
      altasEnCola: new Set(cola.filter((e) => e.entity === 'incident').map((e) => e.id)),
      cierres: cola
        .filter((e) => e.entity === 'incident_resolution')
        .map((e) => e.payload as unknown as CierreEnCola)
        .filter((c) => typeof c.incident_id === 'string' && typeof c.resolved_at === 'string'),
      salas,
    }
  }, [])

  const filas = useMemo(
    () =>
      filasDelParte({
        servidor: servidor.data ?? [],
        espejo: local?.incidencias ?? [],
        cierres: local?.cierres ?? [],
        altasEnCola: local?.altasEnCola ?? new Set(),
        limites,
      }),
    [servidor.data, local, limites],
  )

  const resumen = resumenDelParte(filas)
  const porPasar = filas.filter((f) => !f.easyvista_ref)
  const pasadas = filas.filter((f) => f.easyvista_ref)

  const textoDe = (f: FilaDelParte): string =>
    textoParaEasyVista(f, {
      sala: f.room_id ? (local?.salas.get(f.room_id) ?? null) : null,
      abrio: nombreDe(f.opened_by),
      cerro: nombreDe(f.resolved_by),
    })

  const todoElDia = filas.map(textoDe).join('\n\n———\n\n')

  const fila = (f: FilaDelParte): React.ReactElement => {
    const sala = f.room_id ? (local?.salas.get(f.room_id) ?? null) : null
    const abrio = nombreDe(f.opened_by)
    const cerro = nombreDe(f.resolved_by)
    const resuelta = f.state === 'resuelta'
    const descripcion = (f.description ?? '').trim()
    const solucion = resuelta ? (f.resolution ?? '').trim() : ''

    return (
      <li key={f.id} className="card p-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {/* El estado, que es lo que decide qué se hace en EasyVista: una
              abierta se da de alta, una resuelta se da de alta y se cierra. */}
          <span
            className={`rounded-tag px-2 py-0.5 text-xs font-semibold ${
              resuelta ? 'bg-ok-tint text-ok' : 'bg-crit-tint text-crit'
            }`}
          >
            {resuelta ? 'Resuelta' : f.state === 'en_curso' ? 'En curso' : 'Abierta'}
          </span>
          {sala &&
            (onAbrirSala && f.room_id ? (
              <button
                type="button"
                onClick={() => onAbrirSala(f.room_id!)}
                className="-my-2.5 inline-flex min-h-11 items-center font-mono text-sm font-semibold text-accent underline-offset-2 hover:underline"
                title="Abrir la ficha de la sala"
              >
                {sala}
              </button>
            ) : (
              <span className="font-mono text-sm font-semibold text-ink-2">{sala}</span>
            ))}
          {f.kind !== 'incidencia' && (
            <span className="text-xs text-muted">{INCIDENT_KIND_LABELS[f.kind]}</span>
          )}
          {f.sinSubir && (
            <span className="ml-auto rounded-tag bg-warn-tint px-2 py-0.5 text-xs text-warn">
              sin subir
            </span>
          )}
        </div>

        <p className="mt-2 font-medium">{f.title}</p>
        {descripcion && (
          <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-ink-2">
            {descripcion}
          </p>
        )}

        {/* Las dos horas del día, una por línea y con su nombre. Lo que venía
            de antes lleva la fecha: «abierta el 12 nov» explica por qué una
            avería de hoy no se abrió hoy. */}
        <dl className="mt-2 space-y-0.5 text-xs text-muted">
          <div>
            <dt className="inline">Abierta </dt>
            <dd className="inline">
              <span className="text-ink-2">
                {f.abiertaHoy
                  ? `a las ${horaCorta(f.opened_at)}`
                  : `el ${fechaCorta(f.opened_at)}`}
              </span>
              {abrio && <> por {abrio}</>}
            </dd>
          </div>
          {resuelta && f.resolved_at && (
            <div>
              <dt className="inline">Cerrada </dt>
              <dd className="inline">
                <span className="text-ink-2">
                  {f.cerradaHoy
                    ? `a las ${horaCorta(f.resolved_at)}`
                    : `el ${fechaCorta(f.resolved_at)}`}
                </span>
                {cerro && <> por {cerro}</>}
              </dd>
            </div>
          )}
          {(f.external_ref || f.easyvista_ref) && (
            <div className="font-mono">
              {f.external_ref}
              {f.external_ref && f.easyvista_ref && ' · '}
              {f.easyvista_ref && <span className="text-ok">EasyVista {f.easyvista_ref}</span>}
            </div>
          )}
        </dl>

        {solucion && (
          <p className="mt-2 rounded-ctl bg-ok-tint px-3 py-2 text-sm leading-relaxed">
            <span className="font-semibold text-ok">Qué se hizo: </span>
            <span className="whitespace-pre-line">{solucion}</span>
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Copiar texto={textoDe(f)} className="key key-accent min-h-11 px-3 text-xs">
            Copiar todo
          </Copiar>
          {descripcion && <Copiar texto={descripcion}>Copiar descripción</Copiar>}
          {solucion && <Copiar texto={solucion}>Copiar solución</Copiar>}
          {/* Lo que se acaba de abrir sin cobertura aún no existe arriba, y el
              código se guarda en el servidor: el botón no sale hasta que suba. */}
          {!f.sinSubir && (
            <CodigoEasyVista incidentId={f.id} codigo={f.easyvista_ref} className="" />
          )}
        </div>
      </li>
    )
  }

  return (
    <div className="mx-auto max-w-4xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{esHoy ? 'Parte de hoy' : 'Parte del día'}</h1>
          <p className="text-sm text-muted first-letter:uppercase">{nombreDelDia(dia)}</p>
        </div>
        {/* Hoy es lo normal. Las flechas están para el lunes, que es cuando se
            pasa lo del viernes. */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setDia((d) => moverDia(d, -1))}
            className="key key-quiet min-h-11 px-3 text-sm"
          >
            <span aria-hidden="true">‹ </span>Día anterior
          </button>
          {!esHoy && (
            <>
              {moverDia(dia, 1) !== hoy && (
                <button
                  type="button"
                  onClick={() => setDia((d) => moverDia(d, 1))}
                  className="key key-quiet min-h-11 px-3 text-sm"
                >
                  Día siguiente<span aria-hidden="true"> ›</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setDia(hoy)}
                className="key key-accent min-h-11 px-3 text-sm"
              >
                Hoy
              </button>
            </>
          )}
        </div>
      </div>

      {/* El día en tres cifras. La tercera es la que importa al sentarse
          delante de EasyVista: cuántas faltan. */}
      <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
        {(
          [
            ['Abiertas hoy', resumen.abiertas, 'text-crit'],
            ['Cerradas hoy', resumen.cerradas, 'text-ok'],
            ['Por pasar a EasyVista', resumen.porPasar, resumen.porPasar > 0 ? 'text-warn' : 'text-ok'],
          ] as const
        ).map(([nombre, cifra, color]) => (
          <div key={nombre} className="card flex flex-col-reverse px-2 py-3">
            <dt className="mt-0.5 text-xs leading-tight text-muted">{nombre}</dt>
            <dd className={`font-mono text-2xl font-semibold ${color}`}>{cifra}</dd>
          </div>
        ))}
      </dl>

      {servidor.isError && (
        <div className="card mt-4 p-4">
          <p className="text-sm text-crit">No se ha podido preguntar al servidor.</p>
          <p className="mt-1 text-sm text-muted">
            Sin conexión solo se ve lo que hay en este dispositivo, y puede faltar lo que hayan
            hecho otros compañeros.
          </p>
          <button
            type="button"
            onClick={() => void servidor.refetch()}
            className="key key-quiet mt-3 min-h-11 px-3 text-sm"
          >
            Reintentar
          </button>
        </div>
      )}

      {servidor.isPending && filas.length === 0 && (
        <p className="mt-6 text-sm text-muted">Cargando el parte…</p>
      )}

      {!servidor.isPending && filas.length === 0 && (
        <p className="mt-6 text-sm text-muted">
          {esHoy
            ? 'Hoy no se ha abierto ni cerrado ninguna incidencia.'
            : 'Ese día no se abrió ni se cerró ninguna incidencia.'}
        </p>
      )}

      {filas.length > 1 && (
        <Copiar texto={todoElDia} className="key key-quiet mt-4 min-h-11 w-full px-3 text-sm">
          Copiar el parte entero ({cuantos(filas.length, 'incidencia', 'incidencias')})
        </Copiar>
      )}

      {porPasar.length > 0 && (
        <section className="mt-5">
          <h2 className="eyebrow">Falta pasarlas a EasyVista · {porPasar.length}</h2>
          <p className="mt-1 text-xs text-muted">
            Copia, pega en EasyVista y apunta aquí el código que te dé. Al guardarlo, la
            incidencia baja a «Ya en EasyVista».
          </p>
          <ul className="mt-2 space-y-3">{porPasar.map(fila)}</ul>
        </section>
      )}

      {filas.length > 0 && porPasar.length === 0 && (
        <p className="mt-5 rounded-ctl bg-ok-tint px-3 py-2 text-sm text-ok">
          Todo lo de {esHoy ? 'hoy' : 'ese día'} tiene ya su código de EasyVista.
        </p>
      )}

      {pasadas.length > 0 && (
        <section className="mt-6">
          <h2 className="eyebrow">Ya en EasyVista · {pasadas.length}</h2>
          {/* Siguen aquí porque una abierta que ya tiene ticket puede haberse
              cerrado después: el estado dice si toca cerrarla también allí. */}
          <p className="mt-1 text-xs text-muted">
            Mira el estado: si pone «Resuelta», recuerda cerrarla también en EasyVista.
          </p>
          <ul className="mt-2 space-y-3">{pasadas.map(fila)}</ul>
        </section>
      )}
    </div>
  )
}
