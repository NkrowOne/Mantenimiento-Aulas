/**
 * La pantalla de inicio: cómo va la ronda, las dos puertas rápidas y los
 * edificios.
 *
 * Vivía dentro de `App.tsx` como un bloque de JSX más. Sale a su fichero con el
 * rediseño porque dejó de ser una lista con un botón encima y pasó a ser una
 * pantalla con tres partes, cada una con su trabajo:
 *
 *  1. EL RESUMEN. Lo primero que se ve al abrir: cuántas salas van al día,
 *     cuántas tocan y cuántas averías hay abiertas, del campus entero. Antes
 *     esa cuenta había que hacerla sumando a ojo las filas de los edificios, o
 *     yéndose al Panel, que está detrás de «Más» y necesita cobertura. Esto
 *     sale de lo que ya hay en el aparato.
 *  2. LAS DOS PUERTAS RÁPIDAS. Escanear y buscar: quien ya está delante de una
 *     puerta no tiene por qué bajar por una lista.
 *  3. LOS EDIFICIOS. Cada uno con su avance, para elegir por dónde seguir.
 */

import { Suspense, lazy, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { FilaConAcciones } from '@/components/FilaConAcciones'
import { Icono } from '@/components/Icono'
import { InsigniaAveria, detalleDeAverias } from '@/components/InsigniaAveria'
import { db } from '@/db/dexie'
import { displayRoomCode } from '@/domain/normalize'
import {
  OVERDUE_INSPECTION_DAYS,
  type Building,
  type Incident,
  type IncidentKind,
  type Role,
  type Room,
} from '@/domain/types'
import type { ResultadoPull } from '@/sync/pull'
import { BuscadorGlobal } from './BuscadorGlobal'
import { HojaDeMaestro } from './HojaDeMaestro'
import { NuevaIncidencia } from './NuevaIncidencia'
import { averiasPorEdificio, averiasPorSala } from './averias'
import { ordenarEdificios } from '@/domain/ordenDeEdificios'

/* El diagnóstico del servidor va en diferido: solo se abre cuando algo falla,
   nunca con el dedo apoyado, y son trescientas líneas que el arranque de cada
   iPad cargaba para nada. */
const Diagnostico = lazy(() =>
  import('@/features/admin/Diagnostico').then((m) => ({ default: m.Diagnostico })),
)

interface Props {
  role: Role
  diagnostico: ResultadoPull | null
  onReintentar: () => void
  onEscanear: () => void
  /** Lo que dijo el último escaneo que no sirvió, si lo hubo. */
  avisoQR: string | null
  onEdificio: (building: Building) => void
  onSala: (building: Building, room: Room) => void
  /** Ir a la pestaña Incidencias, con la lista entera. */
  onIncidencias: () => void
  /** Abrir el formulario de incidencia de esta sala, con el tipo ya elegido. */
  onNuevaIncidencia: (building: Building, room: Room, tipo: IncidentKind) => void
  /** Seguir con una revisión que se dejó a medias: abre su formulario tal cual. */
  onContinuar: (building: Building, room: Room) => void
  /** Lo tecleado en el buscador del campus, que sobrevive a abrir una ficha. */
  busqueda: string
  onBusqueda: (texto: string) => void
}

/**
 * Por qué la lista está vacía.
 *
 * «Sin datos. Conéctate una vez para descargarlos.» era la respuesta a las tres
 * situaciones a la vez: sin red, servidor vacío y servidor que no deja leer. Las
 * tres piden cosas distintas de quien lo lee, y la tercera —RLS devolviendo cero
 * filas sin error— es justo la que se pasa semanas sin diagnosticar, porque
 * desde el iPad se ve idéntica a «aún no me he conectado».
 */
function SinDatos({
  diagnostico,
  onReintentar,
}: {
  diagnostico: ResultadoPull | null
  onReintentar: () => void
}): React.ReactElement {
  return (
    <div className="card p-4">
      {diagnostico?.error ? (
        <>
          <p className="text-sm font-medium text-crit">No se han podido descargar los datos.</p>
          <p className="mt-2 text-sm text-muted">{diagnostico.error}</p>
          {diagnostico.fallos.length > 0 && (
            <ul className="mt-2 space-y-1 font-mono text-xs text-muted">
              {diagnostico.fallos.map((f) => (
                <li key={f.tabla}>
                  {f.tabla}: {f.code ? `[${f.code}] ` : ''}
                  {f.mensaje}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="text-sm text-muted">
          Sin datos todavía. Conéctate una vez para descargarlos.
        </p>
      )}
      <button
        type="button"
        onClick={onReintentar}
        className="key key-quiet mt-3 min-h-11 px-3 text-sm"
      >
        Reintentar descarga
      </button>
      <Suspense fallback={<p className="mt-2 text-sm text-muted">Cargando el diagnóstico…</p>}>
        <Diagnostico />
      </Suspense>
    </div>
  )
}

/**
 * El anillo de avance.
 *
 * Un círculo y no una barra porque aquí es LA cifra de la pantalla —qué parte
 * del campus está al día— y un anillo con el porcentaje dentro se lee como un
 * marcador, no como una barra de carga. Es una medida, así que no se anima al
 * entrar: animarla obligaría a esperar para poder leerla.
 *
 * `pathLength={100}` deja el trazo medido en tantos por ciento, así que el
 * `strokeDasharray` es el propio porcentaje y no hay que saber cuánto mide la
 * circunferencia.
 */
function Anillo({ pct, alDia }: { pct: number; alDia: boolean }): React.ReactElement {
  return (
    <span className="relative flex h-[4.5rem] w-[4.5rem] shrink-0 items-center justify-center">
      <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="3.5" className="stroke-raised" />
        {pct > 0 && (
          <circle
            cx="18"
            cy="18"
            r="15.5"
            fill="none"
            strokeWidth="3.5"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${pct} 100`}
            className={`anillo-trazo ${alDia ? 'stroke-ok' : 'stroke-accent'}`}
          />
        )}
      </svg>
      <span className="text-lg font-bold leading-none tracking-tight tabular">
        {pct}
        <span className="text-xs font-semibold text-muted">%</span>
      </span>
    </span>
  )
}

/** «lunes, 16 de noviembre», en el idioma y la zona del dispositivo. */
function hoyEnPalabras(): string {
  const fecha = new Date().toLocaleDateString('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
  // Solo la primera letra: el `capitalize` de CSS pone mayúscula a CADA palabra
  // y deja «Lunes, 16 De Noviembre».
  return fecha.charAt(0).toUpperCase() + fecha.slice(1)
}

/** Cuántas incidencias se enseñan en el inicio. Las demás, en su pestaña. */
const INCIDENCIAS_EN_EL_INICIO = 5

type Gravedad = 'alta' | 'media' | 'baja' | 'solicitud'

/**
 * La gravedad con la que se ordena y se pinta una fila. Una solicitud va
 * aparte y al final: es trabajo que se pide, no algo que esté roto, y su
 * «gravedad» en la base es un valor por defecto que no eligió nadie.
 */
function gravedadDe(i: Pick<Incident, 'kind' | 'severity'>): Gravedad {
  return i.kind === 'solicitud' ? 'solicitud' : i.severity
}

const ORDEN_DE_GRAVEDAD: Record<Gravedad, number> = { alta: 0, media: 1, baja: 2, solicitud: 3 }

/* Las mismas palabras que se eligen en el aula al marcar una falla. */
const ETIQUETA_DE_GRAVEDAD: Record<Gravedad, string> = {
  alta: 'Impide la clase',
  media: 'Molesta',
  baja: 'Leve',
  solicitud: 'Solicitud',
}

const PUNTO_DE_GRAVEDAD: Record<Gravedad, string> = {
  alta: 'bg-crit',
  media: 'bg-warn',
  baja: 'bg-na',
  solicitud: 'bg-accent',
}

/** «hoy», «ayer», «hace 14 días»: cuánto lleva abierta. */
function haceCuanto(iso: string): string {
  const dias = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (dias <= 0) return 'hoy'
  if (dias === 1) return 'ayer'
  return `hace ${dias} días`
}

export function EdificiosPage({
  role,
  diagnostico,
  onReintentar,
  onEscanear,
  avisoQR,
  onEdificio,
  onSala,
  onIncidencias,
  onNuevaIncidencia,
  onContinuar,
  busqueda,
  onBusqueda,
}: Props): React.ReactElement {
  /*
   * El edificio cuyas acciones están abiertas.
   *
   * No entra en la vista que se guarda en `db.meta['ultima-vista']`: esa existe
   * para poder devolver al técnico donde estaba, y restaurar una hoja abierta al
   * recargar la reabriría sobre un edificio que quizá acaba de archivarse. Lo que
   * merece sobrevivir a una recarga es dónde estás, no qué menú tenías
   * desplegado.
   *
   * La confirmación de lo que hizo el servidor ya no se guarda aquí: se lee
   * dentro de la propia hoja, que es fija y está a la altura del pulgar, y no se
   * va hasta que se pulsa «Entendido».
   */
  const [hojaEdificio, setHojaEdificio] = useState<Building | null>(null)

  const buildings = useLiveQuery(() => db.buildings.toArray().then(ordenarEdificios), [])

  /*
   * Cuántas salas tiene cada edificio y cuántas van con retraso.
   *
   * La lista de edificios eran veintitrés filas con un código y un nombre: la
   * misma altura, el mismo peso y ni un dato. Monótona, sí, pero sobre todo
   * MUDA — hay que entrar en cada una para saber cuál toca, que es justo lo que
   * la lista debería ahorrar.
   *
   * Con el recuento y el retraso, cada fila dice algo distinto y la vista se
   * ordena sola ante los ojos. La variedad sale de los datos, que es la única
   * que no cansa a la tercera semana.
   *
   * Se calcula en local, de una sola pasada sobre las tres tablas, y lo
   * recalcula Dexie cuando cambian.
   */
  const porEdificio = useLiveQuery(async () => {
    const [zones, rooms, incidencias] = await Promise.all([
      db.zones.toArray(),
      db.rooms.toArray(),
      db.incidents.toArray(),
    ])
    const edificioDeZona = new Map(zones.map((z) => [z.id, z.building_id]))

    const acc = new Map<string, { total: number; pendientes: number; averias: number }>()
    const limite = Date.now() - OVERDUE_INSPECTION_DAYS * 86_400_000
    // Las averías vivas por edificio, con la misma regla que el servidor
    // (`room_overview.open_incidents`): ni resueltas, ni borradores, ni
    // observaciones. El triángulo del edificio es la suma de sus salas.
    const averias = averiasPorEdificio(averiasPorSala(incidencias), rooms, edificioDeZona)

    for (const r of rooms) {
      const edificio = edificioDeZona.get(r.zone_id)
      if (!edificio) continue
      const fila = acc.get(edificio) ?? {
        total: 0,
        pendientes: 0,
        averias: averias.get(edificio) ?? 0,
      }
      fila.total++
      const revisada = r.last_inspection_at ? new Date(r.last_inspection_at).getTime() : 0
      if (revisada < limite) fila.pendientes++
      acc.set(edificio, fila)
    }
    return acc
  }, [])

  /*
   * Las plantas y las salas del edificio cuya hoja está abierta.
   *
   * Acotado por el edificio pulsado, así que no corre mientras no haya hoja: la
   * lista de edificios se repinta con cada descarga, y leer las 276 salas para
   * un menú que nadie ha abierto sería pagar el precio en la pantalla que más se
   * mira. Lo necesita la hoja para dos cosas: contar lo que se lleva por delante
   * una baja y detectar un choque de código sin ir al servidor.
   */
  const contextoDeHoja = useLiveQuery(async () => {
    const id = hojaEdificio?.id
    if (!id) return null
    const zonas = await db.zones.where('building_id').equals(id).toArray()
    const salas = await db.rooms
      .where('zone_id')
      .anyOf(zonas.map((z) => z.id))
      .toArray()
    return { zonas, salas }
  }, [hojaEdificio?.id])

  /*
   * Las revisiones que se quedaron a medias, con su aula y su edificio.
   *
   * Un borrador se guarda solo y no se pierde, pero desde aquí no se veía:
   * estaba marcado «A medias» en la fila de su aula, dentro de la lista de su
   * edificio. Quien dejó dos aulas sin cerrar ayer —le llamaron, se fue— tenía
   * que acordarse de cuáles eran y de en qué edificio, y entrar a buscarlas:
   * edificio, aula, «Revisar esta sala». Aquí están las dos, a un toque.
   *
   * Sin las correcciones: una corrección a medias se retoma desde la revisión
   * que corrige, en la ficha del aula, y abrirla como una revisión nueva la
   * mezclaría con la de hoy.
   */
  const aMedias = useLiveQuery(async () => {
    const borradores = await db.inspections.where('status').equals('borrador').toArray()
    const filas: Array<{ building: Building; room: Room; cuando: string }> = []
    for (const b of borradores) {
      if (b.corrects) continue
      const room = await db.rooms.get(b.room_id)
      const zone = room ? await db.zones.get(room.zone_id) : undefined
      const building = zone ? await db.buildings.get(zone.building_id) : undefined
      if (room && building) filas.push({ building, room, cuando: b.occurred_at })
    }
    // La más reciente primero, y una sola por aula.
    filas.sort((a, b) => b.cuando.localeCompare(a.cuando))
    return filas.filter((f, i) => filas.findIndex((g) => g.room.id === f.room.id) === i).slice(0, 4)
  }, [])

  /*
   * Las incidencias abiertas, de lo que hay en el dispositivo, con su aula.
   *
   * La misma regla que el triángulo de cada edificio (`esAveriaViva`): ni
   * resueltas, ni borradores, ni observaciones. Aquí se añaden las que no
   * tienen aula —que el triángulo no puede contar, porque no son de ningún
   * edificio— para que el número de arriba sea el de la pestaña Incidencias.
   *
   * El orden es el de atenderlas: primero la gravedad, y a igual gravedad la
   * que más lleva esperando.
   */
  const abiertas = useLiveQuery(async () => {
    const todas = (await db.incidents.toArray()).filter(
      (i) => i.state !== 'resuelta' && i.state !== 'borrador' && i.kind !== 'observacion',
    )
    todas.sort(
      (a, b) =>
        ORDEN_DE_GRAVEDAD[gravedadDe(a)] - ORDEN_DE_GRAVEDAD[gravedadDe(b)] ||
        a.opened_at.localeCompare(b.opened_at),
    )
    const filas = []
    for (const incidencia of todas.slice(0, INCIDENCIAS_EN_EL_INICIO)) {
      const room = incidencia.room_id ? await db.rooms.get(incidencia.room_id) : undefined
      const zone = room ? await db.zones.get(room.zone_id) : undefined
      const building = zone ? await db.buildings.get(zone.building_id) : undefined
      filas.push({ incidencia, room, building })
    }
    return { total: todas.length, filas }
  }, [])

  /* La hoja de «Nueva incidencia o solicitud». */
  const [nueva, setNueva] = useState(false)

  /*
   * El campus entero, sumando los edificios. Sale del mismo mapa que las filas
   * de abajo, así que el resumen y la lista no pueden decir cosas distintas.
   */
  const campus = { total: 0, pendientes: 0, averias: 0 }
  for (const c of porEdificio?.values() ?? []) {
    campus.total += c.total
    campus.pendientes += c.pendientes
    campus.averias += c.averias
  }
  const alDia = campus.total - campus.pendientes
  const pct = campus.total ? Math.round((alDia / campus.total) * 100) : 0

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-8 pt-3 lg:max-w-5xl">
      <header className="pb-3">
        {/* La fecha encima del título: es lo que se apunta en un parte, y decía
            «Buenos días». Un saludo no es un dato. */}
        <p className="text-sm text-muted">{hoyEnPalabras()}</p>
        <h1 className="mt-0.5 text-2xl font-bold tracking-tight">Inicio</h1>
      </header>

      {/*
        Lo primero, abrir una incidencia.

        Es lo que más veces se viene a hacer con prisa —alguien avisa por el
        pasillo— y costaba encontrar el aula, entrar en su ficha y dar ahí con
        el botón. Desde aquí se elige el tipo, el edificio y la sala, y se llega
        al formulario ya abierto.
      */}
      <button
        type="button"
        onClick={() => setNueva(true)}
        className="key key-accent flex min-h-touch w-full items-center justify-center gap-2.5 px-4"
      >
        <Icono nombre="anadir" />
        Nueva incidencia o solicitud
      </button>

      {/*
        Buscar un aula, y a su lado el lector de QR.

        El lector era el botón más grande de la pantalla, por encima de todo.
        Pero todavía no hay placas con QR en las puertas: ocupaba el sitio
        principal una función que hoy casi nadie puede usar. Pasa a ser un botón
        al lado del buscador —que es como se llega hoy a un aula— y cuando las
        placas estén puestas seguirá estando a un toque.
      */}
      <BuscadorGlobal
        onPick={onSala}
        query={busqueda}
        onQueryChange={onBusqueda}
        accion={
          <button
            type="button"
            onClick={onEscanear}
            aria-label="Escanear el código QR de un aula"
            title="Escanear el código QR de un aula"
            className="key key-quiet flex h-touch w-touch shrink-0 items-center justify-center text-accent"
          >
            <Icono nombre="qr" />
          </button>
        }
      />
      {avisoQR && (
        <p role="alert" className="pt-2 text-sm text-crit">
          {avisoQR}
        </p>
      )}

      {/*
        Las incidencias abiertas, antes que la ronda.

        Una incidencia abierta es trabajo que alguien está esperando; la ronda
        es trabajo que se hace cuando no hay otro. El inicio las ponía al revés:
        primero el avance de la ronda, y las incidencias en otra pestaña. Aquí
        salen las más urgentes —las que impiden dar clase, y dentro de cada
        gravedad las que más llevan abiertas— con el aula delante, y tocar una
        abre su aula, que es donde se resuelve.

        Salen de lo que ya hay en el dispositivo, así que se ven sin cobertura.
      */}
      {abiertas && abiertas.total > 0 && (
        <section aria-labelledby="inicio-incidencias" className="mt-6">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h2 id="inicio-incidencias" className="eyebrow">
              Incidencias abiertas · {abiertas.total}
            </h2>
            <button
              type="button"
              onClick={onIncidencias}
              className="key-ghost -mr-2 -my-2 inline-flex min-h-11 items-center gap-1 px-2 text-sm"
            >
              Ver todas
              <Icono nombre="derecha" lado={14} />
            </button>
          </div>
          <ul className="escalonada card overflow-hidden">
            {abiertas.filas.map(({ incidencia: i, building, room }) => (
              <li key={i.id} className="border-t border-line-soft first:border-t-0">
                <button
                  type="button"
                  onClick={() => (building && room ? onSala(building, room) : onIncidencias())}
                  className="fila flex w-full items-start gap-3 px-4 py-3 text-left"
                >
                  {/* La gravedad, en un punto de color: rojo si impide la
                      clase, ámbar si molesta, gris si es leve o una solicitud.
                      Con palabras va debajo, para quien no distingue el color. */}
                  <span
                    aria-hidden
                    className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${PUNTO_DE_GRAVEDAD[gravedadDe(i)]}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium leading-snug">
                      {i.title?.trim() || 'Sin descripción'}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted">
                      {building && room ? (
                        <>
                          <span className="font-mono font-semibold text-ink-2">
                            {building.code} {displayRoomCode(room.code)}
                          </span>
                          {' · '}
                        </>
                      ) : (
                        'Sin aula · '
                      )}
                      {ETIQUETA_DE_GRAVEDAD[gravedadDe(i)]} · {haceCuanto(i.opened_at)}
                    </span>
                  </span>
                  <Icono nombre="derecha" lado={16} className="mt-1 text-muted" />
                </button>
              </li>
            ))}
          </ul>
          {abiertas.total > abiertas.filas.length && (
            <p className="px-1 pt-2 text-xs text-muted">
              Se muestran las {abiertas.filas.length} más urgentes de {abiertas.total}.
            </p>
          )}
        </section>
      )}

      {(aMedias?.length ?? 0) > 0 && (
        <section aria-label="Revisiones en curso" className="card mt-6 overflow-hidden">
          <h2 className="eyebrow px-4 pt-3">
            {aMedias!.length === 1 ? 'Revisión en curso' : 'Revisiones en curso'}
          </h2>
          <ul className="mt-1">
            {aMedias!.map(({ building, room }) => (
              <li key={room.id} className="border-t border-line-soft first:border-t-0">
                <button
                  type="button"
                  onClick={() => onContinuar(building, room)}
                  className="fila flex min-h-touch w-full items-center gap-3 px-4 py-2 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      <span className="font-mono">{displayRoomCode(room.code)}</span>
                      {room.name !== room.code && ` · ${room.name}`}
                    </span>
                    <span className="block truncate text-xs text-muted">{building.name}</span>
                  </span>
                  <span className="chip chip-accent">Continuar</span>
                  <Icono nombre="derecha" lado={16} className="text-muted" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="section-head mt-6">
        <h2 className="eyebrow">Ronda de revisión</h2>
      </div>
      {/*
        El resumen del campus. Solo cuando hay salas: con la base vacía un anillo
        al 0% sería una cifra falsa, y lo que hay que leer ahí es el aviso de
        «sin datos» de más abajo.
      */}
      {campus.total > 0 && (
        <section aria-label="Estado de la ronda" className="card flex items-center gap-4 p-4">
          <Anillo pct={pct} alDia={campus.pendientes === 0} />
          <div className="min-w-0 flex-1">
            <p className="font-semibold leading-snug">
              {campus.pendientes === 0
                ? 'Todas las salas revisadas'
                : `${alDia} de ${campus.total} salas revisadas`}
            </p>
            <p className="mt-0.5 text-sm leading-snug text-muted">
              En los últimos {OVERDUE_INSPECTION_DAYS} días.
            </p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {campus.pendientes > 0 && (
                <span className="chip chip-warn">
                  {campus.pendientes} pendientes de revisión
                </span>
              )}
              {campus.pendientes === 0 && <span className="chip chip-ok">Ronda al día</span>}
            </div>
          </div>
        </section>
      )}

      <div className="section-head mt-6">
        <h2 className="eyebrow">
          Edificios{buildings && buildings.length > 0 ? ` · ${buildings.length}` : ''}
        </h2>
      </div>

      {/*
        Mientras Dexie no contesta —milisegundos, pero se ven— van los huecos de
        tres filas, no una lista vacía: una lista vacía se lee un instante como
        «no hay edificios», que es justo el susto que no hay que dar.
      */}
      {buildings === undefined && (
        <ul className="space-y-2" aria-hidden>
          {[0, 1, 2].map((i) => (
            <li key={i} className="card flex items-center gap-3 p-4 shadow-none">
              <span className="hueco h-11 w-11 rounded-ctl" />
              <span className="flex-1">
                <span className="hueco block h-4 w-1/2" />
                <span className="hueco mt-2 block h-3 w-1/3" />
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Dos columnas en una pantalla ancha: veintitrés edificios en una sola
          tira de 900 px son veintitrés líneas con el dato a un palmo del nombre. */}
      <ul className="escalonada grid gap-2 lg:grid-cols-2">
        {(buildings ?? []).map((b) => {
          const cuenta = porEdificio?.get(b.id)
          const total = cuenta?.total ?? 0
          const pendientes = cuenta?.pendientes ?? 0
          const hechas = total - pendientes

          return (
            <li key={b.id} className="card overflow-hidden">
              <FilaConAcciones
                esAdmin={role === 'admin'}
                etiqueta={`Acciones del edificio ${b.code}`}
                alAbrir={() => setHojaEdificio(b)}
              >
                {(manejadores) => (
                  <button
                    type="button"
                    onClick={() => onEdificio(b)}
                    {...manejadores}
                    /* `sin-lupa` solo para el administrador, que es el único con
                       pulsación larga: mantener pulsado el nombre del edificio
                       levantaba la lupa de iOS y su menú «Copiar» encima de la
                       hoja recién abierta. Al técnico no se le quita nada. */
                    className={`fila flex w-full flex-1 items-center gap-3 px-3.5 py-3 text-left ${
                      role === 'admin' ? 'sin-lupa' : ''
                    }`}
                  >
                    {/*
                      El código, en una chapa.
                      Suelto competía con el nombre a la misma altura y el ojo no
                      sabía cuál de los dos era la entrada. Metido en su recuadro
                      se lee como lo que es: una matrícula. La letra encoge con
                      los códigos largos («CRAI», «COM») para que la chapa mida
                      siempre lo mismo y los nombres arranquen alineados.
                    */}
                    <span
                      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-ctl bg-accent-tint font-mono font-semibold text-accent ${
                        b.code.length > 3 ? 'text-[0.625rem]' : b.code.length > 2 ? 'text-xs' : 'text-base'
                      }`}
                    >
                      {b.code}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-semibold">{b.name}</span>
                        {/* El triángulo del edificio: cuántas averías vivas hay
                            puertas adentro, sumando todas sus salas. */}
                        <InsigniaAveria
                          n={cuenta?.averias ?? 0}
                          detalle={detalleDeAverias(cuenta?.averias ?? 0)}
                        />
                      </span>
                      {total > 0 && (
                        <span className="mt-1.5 flex items-center gap-2">
                          {/*
                            El avance del edificio, recto y sin animar.
                            Es una medida, no una barra de carga: animarla obligaría
                            a esperar para poder leerla, y aquí se lee de pasada.
                          */}
                          <span
                            aria-hidden
                            className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-raised"
                          >
                            <span
                              className={`block h-full rounded-full ${pendientes === 0 ? 'bg-ok' : 'bg-warn'}`}
                              style={{ width: `${total ? (hechas / total) * 100 : 0}%` }}
                            />
                          </span>
                          <span className="truncate text-xs text-muted">
                            {pendientes === 0
                              ? `${total} salas revisadas`
                              : `${pendientes} de ${total} pendientes`}
                          </span>
                        </span>
                      )}
                      {b.needs_review && (
                        <span className="chip chip-warn mt-1.5">Sin identificar</span>
                      )}
                    </span>

                    {/* Solo para quien no tiene los tres puntos al lado: con
                        ellos, dos marcas seguidas al final de la fila sobran. */}
                    {role !== 'admin' && (
                      <Icono nombre="derecha" lado={18} className="text-muted" />
                    )}
                  </button>
                )}
              </FilaConAcciones>
            </li>
          )
        })}
      </ul>

      {buildings?.length === 0 && (
        <SinDatos diagnostico={diagnostico} onReintentar={onReintentar} />
      )}

      {/*
        La hoja espera a que Dexie conteste con las plantas y las salas del
        edificio —un viaje de milisegundos, y la vibración del gesto ya ha
        confirmado que se ha entendido—. Sin esperar, el desplegable de plantas
        del alta se pintaría vacío y «Añadir una sala» empezaría pidiendo
        escribir una planta que ya existe.
      */}
      {nueva && (
        <NuevaIncidencia
          onCerrar={() => setNueva(false)}
          onElegida={(building, room, tipo) => {
            setNueva(false)
            onNuevaIncidencia(building, room, tipo)
          }}
        />
      )}

      {hojaEdificio && contextoDeHoja && (
        <HojaDeMaestro
          objeto={{
            tipo: 'edificio',
            edificio: hojaEdificio,
            salas: contextoDeHoja.salas.length,
          }}
          zonas={contextoDeHoja.zonas}
          salasDelEdificio={contextoDeHoja.salas}
          edificios={buildings ?? []}
          onCerrar={() => setHojaEdificio(null)}
          /* La frase ya se ha leído dentro de la hoja: aquí solo queda
             cerrarla. */
          onHecho={() => setHojaEdificio(null)}
        />
      )}
    </div>
  )
}
