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
import { OVERDUE_INSPECTION_DAYS, type Building, type Role, type Room } from '@/domain/types'
import { cuantos } from '@/lib/plural'
import type { ResultadoPull } from '@/sync/pull'
import { BuscadorGlobal } from './BuscadorGlobal'
import { HojaDeMaestro } from './HojaDeMaestro'
import { averiasPorEdificio, averiasPorSala } from './averias'

/* El diagnóstico del servidor va en diferido: solo se abre cuando algo falla,
   nunca con el dedo apoyado, y son trescientas líneas que el arranque de cada
   iPad cargaba para nada. */
const Diagnostico = lazy(() =>
  import('@/features/admin/Diagnostico').then((m) => ({ default: m.Diagnostico })),
)

interface Props {
  role: Role
  /** El nombre de pila de quien ha entrado, para el saludo. Vacío si no se sabe. */
  nombre: string
  diagnostico: ResultadoPull | null
  onReintentar: () => void
  onEscanear: () => void
  /** Lo que dijo el último escaneo que no sirvió, si lo hubo. */
  avisoQR: string | null
  onEdificio: (building: Building) => void
  onSala: (building: Building, room: Room) => void
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
            className={alDia ? 'stroke-ok' : 'stroke-accent'}
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

/** «Buenos días», según la hora del aparato. */
function saludo(): string {
  const h = new Date().getHours()
  if (h < 6) return 'Buenas noches'
  if (h < 13) return 'Buenos días'
  if (h < 21) return 'Buenas tardes'
  return 'Buenas noches'
}

export function EdificiosPage({
  role,
  nombre,
  diagnostico,
  onReintentar,
  onEscanear,
  avisoQR,
  onEdificio,
  onSala,
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

  const buildings = useLiveQuery(() => db.buildings.orderBy('sort_order').toArray(), [])

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
      <header className="pb-4">
        <p className="text-sm text-muted">
          {saludo()}
          {nombre && `, ${nombre}`}
        </p>
        <h1 className="mt-0.5 text-2xl font-bold tracking-tight">¿Qué aula toca?</h1>
      </header>

      {/*
        El resumen del campus. Solo cuando hay salas: con la base vacía un anillo
        al 0% sería una cifra falsa, y lo que hay que leer ahí es el aviso de
        «sin datos» de más abajo.
      */}
      {campus.total > 0 && (
        <section aria-label="Cómo va la ronda" className="card flex items-center gap-4 p-4">
          <Anillo pct={pct} alDia={campus.pendientes === 0} />
          <div className="min-w-0 flex-1">
            <p className="font-semibold leading-snug">
              {campus.pendientes === 0
                ? 'Todo el campus al día'
                : `${alDia} de ${campus.total} salas al día`}
            </p>
            <p className="mt-0.5 text-sm leading-snug text-muted">
              Revisadas en los últimos {OVERDUE_INSPECTION_DAYS} días.
            </p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {campus.pendientes > 0 && (
                <span className="chip chip-warn">
                  {campus.pendientes} por revisar
                </span>
              )}
              {campus.averias > 0 && (
                <span className="chip chip-crit">
                  {cuantos(campus.averias, 'avería abierta', 'averías abiertas')}
                </span>
              )}
              {campus.pendientes === 0 && campus.averias === 0 && (
                <span className="chip chip-ok">Sin averías abiertas</span>
              )}
            </div>
          </div>
        </section>
      )}

      {(aMedias?.length ?? 0) > 0 && (
        <section aria-label="Revisiones a medias" className="card mt-3 overflow-hidden">
          <h2 className="eyebrow px-4 pt-3">
            {aMedias!.length === 1 ? 'Una revisión a medias' : 'Revisiones a medias'}
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
                  <span className="chip chip-accent">Seguir</span>
                  <Icono nombre="derecha" lado={16} className="text-muted" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/*
        Escanear va ANTES del buscador y de la lista, y ocupa el ancho entero,
        porque es el camino corto: el técnico ya está delante de la puerta.
        Buscar y bajar por los edificios siguen debajo para cuando no hay
        pegatina —o no hay cámara—, que es lo que impide que esto se convierta
        en un callejón.
      */}
      <div className="mt-3">
        <button
          type="button"
          onClick={onEscanear}
          className="key key-accent flex min-h-touch w-full items-center justify-center gap-2.5 px-4"
        >
          {/* El icono es el marco de una mirilla: cuatro esquinas y un punto.
              Se lee como «apunta» sin necesidad de leerlo. */}
          <Icono nombre="qr" />
          Escanear el QR del aula
        </button>
        {avisoQR && (
          <p role="alert" className="pt-2 text-sm text-crit">
            {avisoQR}
          </p>
        )}
      </div>

      {/* A la ficha, como la fila de la lista y el QR. Se vuelve aquí, a la
          pantalla de edificios, que es donde está el buscador. */}
      <BuscadorGlobal onPick={onSala} query={busqueda} onQueryChange={onBusqueda} />

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
      <ul className="grid gap-2 lg:grid-cols-2">
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
                              ? `${total} salas al día`
                              : `${pendientes} de ${total} por revisar`}
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
