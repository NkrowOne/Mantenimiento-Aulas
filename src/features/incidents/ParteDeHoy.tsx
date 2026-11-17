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
  FILTROS_DEL_PARTE,
  filasDelParte,
  filtrarParte,
  limitesDelDia,
  moverDia,
  resumenDelParte,
  textoParaEasyVista,
  type CierreEnCola,
  type FilaDelParte,
  type FiltroDelParte,
  type IncidenciaDelParte,
} from '@/domain/parteDelDia'
import { Icono } from '@/components/Icono'
import { useEstadoDeSesion } from '@/lib/estado-de-sesion'
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

/** Los botones secundarios de una tarjeta: todos del mismo ancho. */
const SECUNDARIO = 'key key-quiet min-h-11 w-full px-3 text-sm'

/**
 * Las tres cifras, en el orden en que pasa el día.
 *
 * Etiquetas de un renglón, a propósito: «Sin registrar en EasyVista» ocupaba
 * dos y desalineaba su cifra respecto a las otras. El nombre largo se dice
 * abajo, en la línea del filtro, donde sí cabe.
 */
const INDICADORES: Array<{ id: FiltroDelParte; nombre: string; color: (n: number) => string }> = [
  { id: 'abiertas', nombre: 'Abiertas', color: () => 'text-crit' },
  { id: 'cerradas', nombre: 'Cerradas', color: () => 'text-ok' },
  // Lo que falta por pasar: ámbar mientras quede algo, verde cuando no.
  { id: 'porPasar', nombre: 'Sin EasyVista', color: (n) => (n > 0 ? 'text-warn' : 'text-ok') },
]

/** El filtro, dicho entero: es lo que se lee en la línea de debajo de las cifras. */
function nombreDelFiltro(filtro: FiltroDelParte, esHoy: boolean): string {
  if (filtro === 'porPasar') return 'Sin registrar en EasyVista'
  return `${filtro === 'abiertas' ? 'Abiertas' : 'Cerradas'} ${esHoy ? 'hoy' : 'ese día'}`
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

  /*
   * El filtro: una de las tres cifras, o ninguna.
   *
   * Se recuerda mientras la aplicación siga abierta —quien está pasando «las
   * que faltan» a EasyVista, va a una ficha y vuelve, sigue viendo las que
   * faltan—, y al cambiar de día se conserva: el lunes se repasa el viernes
   * con el mismo criterio.
   */
  const [filtro, setFiltro] = useEstadoDeSesion<FiltroDelParte | null>(
    'parte.filtro',
    null,
    (v) => v === null || (FILTROS_DEL_PARTE as readonly unknown[]).includes(v),
  )
  const visibles = useMemo(() => filtrarParte(filas, filtro), [filas, filtro])
  const porPasar = visibles.filter((f) => !f.easyvista_ref)
  const pasadas = visibles.filter((f) => f.easyvista_ref)

  const textoDe = (f: FilaDelParte): string =>
    textoParaEasyVista(f, {
      sala: f.room_id ? (local?.salas.get(f.room_id) ?? null) : null,
      abrio: nombreDe(f.opened_by),
      cerro: nombreDe(f.resolved_by),
    })

  // Lo que se copia es lo que se ve: con un filtro puesto, solo esas.
  const todoLoVisible = visibles.map(textoDe).join('\n\n———\n\n')

  const fila = (f: FilaDelParte): React.ReactElement => {
    const sala = f.room_id ? (local?.salas.get(f.room_id) ?? null) : null
    const abrio = nombreDe(f.opened_by)
    const cerro = nombreDe(f.resolved_by)
    const resuelta = f.state === 'resuelta'
    const descripcion = (f.description ?? '').trim()
    const solucion = resuelta ? (f.resolution ?? '').trim() : ''
    // Cuántos botones lleva la tarjeta, para cuadrarlos de dos en dos.
    const botones = 1 + (descripcion ? 1 : 0) + (solucion ? 1 : 0) + (f.sinSubir ? 0 : 1)

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

        {/*
          Los botones, en dos columnas iguales.
          Eran teclas sueltas, cada una del ancho de su texto, que saltaban de
          línea donde cayeran: en un teléfono salían dos arriba y una abajo en
          una tarjeta, tres en fila en la siguiente y dos en la otra. Ahora
          todas miden lo mismo y caen en el mismo sitio en todas las tarjetas.
          «Copiar todo» va primero, y si el número es impar ocupa la fila
          entera: es lo que se pulsa nueve de cada diez veces.
        */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Copiar
            texto={textoDe(f)}
            className={`key key-accent min-h-11 w-full px-3 text-sm ${botones % 2 === 1 ? 'col-span-2' : ''}`}
          >
            Copiar todo
          </Copiar>
          {descripcion && (
            <Copiar texto={descripcion} className={SECUNDARIO}>
              Copiar descripción
            </Copiar>
          )}
          {solucion && (
            <Copiar texto={solucion} className={SECUNDARIO}>
              Copiar solución
            </Copiar>
          )}
          {/* Lo que se acaba de abrir sin cobertura aún no existe arriba, y el
              código se guarda en el servidor: el botón no sale hasta que suba. */}
          {!f.sinSubir && (
            <CodigoEasyVista
              incidentId={f.id}
              codigo={f.easyvista_ref}
              className="w-full !text-sm"
              claseAlEditar="col-span-2"
            />
          )}
        </div>
      </li>
    )
  }

  return (
    <div className="mx-auto max-w-4xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{esHoy ? 'Parte de hoy' : 'Parte del día'}</h1>
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

      {/*
        El día en tres cifras, que son también tres filtros.

        Eran tres recuadros de solo lectura, y con dos defectos a la vista: la
        etiqueta de la tercera ocupaba dos renglones y subía su cifra por encima
        de las otras dos, y nada decía qué incidencias eran esas once. Ahora:

         - Miden lo mismo y sus cifras caen en la misma línea: la etiqueta es
           corta y va en un renglón.
         - Son botones. Tocar una deja en la lista solo esas, y volver a tocarla
           lo quita. La elegida se pinta como todo lo elegido en la aplicación
           —en petróleo— y lleva su marca, para que se vea sin leer.
         - Una cifra a cero no se puede tocar: filtraría a una lista vacía.
      */}
      <div role="group" aria-label="Resumen del día: toca una cifra para filtrar" className="mt-4 grid grid-cols-3 gap-2">
        {INDICADORES.map(({ id, nombre, color }) => {
          const cifra = resumen[id]
          const activo = filtro === id
          return (
            <button
              key={id}
              type="button"
              aria-pressed={activo}
              // A cero no filtra nada… salvo que sea el que está puesto, que
              // entonces hay que poder quitarlo.
              disabled={cifra === 0 && !activo}
              onClick={() => setFiltro(activo ? null : id)}
              className="indicador card relative flex min-h-[4.75rem] flex-col justify-between px-3 py-2.5 text-left"
            >
              <span className="flex items-start justify-between gap-1">
                <span
                  className={`tabular text-[1.75rem] font-bold leading-none tracking-tight ${
                    activo ? 'text-accent-ink' : color(cifra)
                  }`}
                >
                  {cifra}
                </span>
                {/* La marca de «elegido», en la esquina. Reserva su sitio aunque
                    no se vea, para que la cifra no se mueva al aparecer. */}
                <Icono nombre="hecho" lado={16} className={activo ? 'text-accent-ink' : 'invisible'} />
              </span>
              <span
                // Sin recortar: en un teléfono estrecho «Sin EasyVista» baja a dos
                // renglones antes que quedarse en «Sin EasyVi…». La cifra va
                // arriba, así que sigue alineada con las otras dos.
                className={`mt-1.5 block text-[0.6875rem] font-medium leading-tight ${
                  activo ? 'text-accent-ink' : 'text-muted'
                }`}
              >
                {nombre}
              </span>
            </button>
          )
        })}
      </div>

      {/*
        Debajo, siempre una línea que dice qué se está viendo. Sin filtro,
        enseña que las cifras se pueden tocar —un recuadro con un número no
        parece un botón hasta que alguien lo dice—. Con filtro, lo nombra y
        ofrece quitarlo, en el mismo sitio donde se puso.
      */}
      {filas.length > 0 &&
        (filtro ? (
          <div className="mt-2 flex items-center justify-between gap-3 rounded-ctl bg-accent-tint py-1 pl-3 pr-1">
            <p aria-live="polite" className="min-w-0 text-sm text-ink">
              <span className="font-semibold">{nombreDelFiltro(filtro, esHoy)}</span>
              <span className="text-ink-2">
                {' '}
                · {visibles.length} de {filas.length}
              </span>
            </p>
            <button
              type="button"
              onClick={() => setFiltro(null)}
              className="key-ghost inline-flex min-h-11 shrink-0 items-center gap-1 px-2 text-sm"
            >
              <Icono nombre="cerrar" lado={14} />
              Quitar filtro
            </button>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted">Toca una cifra para ver solo esas incidencias.</p>
        ))}

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

      {/* Un filtro que no deja nada: pasa al cambiar de día con uno puesto. */}
      {filas.length > 0 && visibles.length === 0 && filtro && (
        <p className="card mt-4 p-4 text-sm text-muted">
          No hay ninguna incidencia en «{nombreDelFiltro(filtro, esHoy)}».
          {filtro === 'porPasar' && ' Todas tienen ya su código.'}
        </p>
      )}

      {visibles.length > 1 && (
        <Copiar texto={todoLoVisible} className="key key-quiet mt-4 min-h-11 w-full px-3 text-sm">
          {filtro
            ? `Copiar estas ${visibles.length} incidencias`
            : `Copiar el parte entero (${cuantos(filas.length, 'incidencia', 'incidencias')})`}
        </Copiar>
      )}

      {porPasar.length > 0 && (
        <section className="mt-5">
          <h2 className="eyebrow">Pendientes de EasyVista · {porPasar.length}</h2>
          <p className="mt-1 text-xs text-muted">
            Copia el texto, pégalo en EasyVista y anota aquí el código asignado. Al guardarlo, la
            incidencia pasa a «Registradas en EasyVista».
          </p>
          <ul className="mt-2 space-y-3">{porPasar.map(fila)}</ul>
        </section>
      )}

      {filas.length > 0 && resumen.porPasar === 0 && filtro !== 'porPasar' && (
        <p className="mt-5 rounded-ctl bg-ok-tint px-3 py-2 text-sm text-ok">
          Todas las incidencias de {esHoy ? 'hoy' : 'ese día'} tienen su código de EasyVista.
        </p>
      )}

      {pasadas.length > 0 && (
        <section className="mt-6">
          <h2 className="eyebrow">Registradas en EasyVista · {pasadas.length}</h2>
          {/* Siguen aquí porque una abierta que ya tiene ticket puede haberse
              cerrado después: el estado dice si toca cerrarla también allí. */}
          <p className="mt-1 text-xs text-muted">
            Comprueba el estado: si figura como «Resuelta», hay que cerrarla también en EasyVista.
          </p>
          <ul className="mt-2 space-y-3">{pasadas.map(fila)}</ul>
        </section>
      )}
    </div>
  )
}
