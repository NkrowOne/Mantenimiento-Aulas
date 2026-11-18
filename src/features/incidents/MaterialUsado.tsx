import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { v7 as uuidv7 } from 'uuid'
import { db, enqueue } from '@/db/dexie'
import { flush } from '@/sync/outbox'
import { supabase } from '@/lib/supabase'
import {
  detalleDe,
  lineasDeMaterial,
  mezclarParte,
  planQuitar,
  planRestar,
  planSumar,
  type Cambio,
  type Cual,
  type DetalleDeMaterial,
  type LineaDelParte,
} from './material'
import { buscarArticulos } from './buscarArticulo'
import { opcionesDeMaterial, unidadesLibres, type Opciones } from './cual'
import { ElegirCual, nombreDelGrupo } from './ElegirCual'
import { CONDICION_LABEL, type Condicion, type UnidadDeAlmacen } from '@/domain/unidades'
import { EtiquetaDeCondicion, PUNTO_DE_CONDICION } from '@/features/inventory/ElegirUnidad'

/**
 * El material que se ha gastado en una incidencia.
 *
 * Faltaba entera, y era el agujero que dejaba sin datos a media aplicación. El
 * Excel sí lo tenía —la columna «Material Usado»— y la importación lo trajo:
 * 320 líneas, 230 con artículo identificado. Pero de ahí no salía a ningún
 * sitio. El almacén no tenía **ni un solo movimiento de consumo**, así que el
 * top de material del informe diario y semanal salía en blanco y el consumo por
 * meses —las doce columnas Enero..Diciembre que estas vistas venían a
 * sustituir— también.
 *
 * El `−` de la pantalla de Almacén tampoco lo arreglaba: descuenta la unidad
 * pero no dice para qué, así que el gasto queda sin destino y no hay forma de
 * responder cuánto material se llevó un edificio. Aquí sí: el movimiento nace
 * con su incidencia y su sala.
 *
 * Va por la cola de salida y no directo contra el servidor —a diferencia del
 * resto del almacén— porque este apunte se hace en el aula, que es justo donde
 * no hay cobertura. El id nace con la pulsación, así que reenviarlo no duplica.
 *
 * **Un toque apunta, y lo apuntado se puede deshacer.** Antes hacían falta dos
 * pasos —elegir el artículo y confirmar con «Apuntar»— y una vez apuntado no
 * había forma de quitarlo desde aquí. Ahora tocar el artículo lo apunta, y la
 * línea que sale lleva su `−`, su `+` y su `×`.
 *
 * **Y el almacén no se entera hasta que la avería se cierra.** Lo que se apunta
 * aquí es el **parte de material** de la incidencia —una fila por artículo en
 * `incident_materials`, con las unidades que dice el parte— y cada toque
 * reenvía esa misma fila con la cantidad nueva. Antes cada toque era un asiento
 * del almacén, y como un asiento no se reescribe, corregir un toque de más era
 * otro asiento: el Historial de la sala enseñaba «+1 +1 −1 −1 −1» para un hub y
 * el almacén se movía con la solicitud todavía abierta. Ahora el servidor
 * descuenta la diferencia neta al cerrar —un asiento por artículo, con la fecha
 * del cierre— y si el parte llega detrás del cierre, lo descuenta al llegar. A
 * qué fila va cada toque lo decide `material.ts`, que es donde está probado.
 *
 * **Y solo se pregunta cuál cuando hay más de una respuesta.** Un cable se toca
 * y se apunta. Pero si del artículo hay nuevas y usadas, o lleva número de
 * serie, el toque abre «¿Cuál has usado?» (`ElegirCual`): se elige de un toque
 * y la línea lo enseña debajo —«Nuevas 2», «S/N PF3ABC12»—, cada cosa con su
 * `−`. Antes lo decidía la base por su cuenta al cerrar, sacando siempre lo
 * usado, y del aparato con número de serie no quedaba apuntado cuál era. Cuándo
 * hay algo que elegir lo decide `cual.ts`.
 */
export function MaterialUsado({
  incidentId,
  enfocar = false,
}: {
  incidentId: string
  /**
   * Poner el cursor en el buscador al abrirse. Solo cuando el panel lo ha
   * abierto un toque —«Material», «¿Has usado material?»—: ahí lo siguiente es
   * teclear el artículo, y sin esto había que tocar el campo antes. Cuando el
   * panel ya viene abierto con el formulario de cierre NO, porque le quitaría
   * el cursor a «Qué se ha hecho», que es lo primero que se escribe.
   */
  enfocar?: boolean
}): React.ReactElement {
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  /** El artículo del que se está preguntando cuál, o `null`. */
  const [eligiendo, setEligiendo] = useState<string | null>(null)
  const qc = useQueryClient()

  /*
   * Lo que ESTA pantalla ha encolado, recordado aparte.
   *
   * Es el tercer sitio de donde puede venir una fila del parte, y el que
   * faltaba. La cola BORRA la fila al subirla y la lista del servidor se pedía
   * una sola vez al abrir el panel: entre esas dos cosas la fila no estaba en
   * ningún lado y la línea desaparecía de la pantalla. Quien no ve lo que acaba
   * de apuntar, lo apunta otra vez — y eso es exactamente el material duplicado
   * que se veía.
   *
   * En un `ref` y no en estado: no pinta nada por sí solo —lo pinta la mezcla—
   * y cambiarlo dentro de una operación no tiene por qué provocar un render.
   */
  const apuntadasAqui = useRef<LineaDelParte[]>([])

  /*
   * Del espejo local: la lista de artículos ya está en el dispositivo, y con
   * ella **cuánto queda de cada uno**.
   *
   * La cifra es una foto, no la verdad —el saldo se calcula en el servidor
   * sumando movimientos—, pero enseñarla dentro del aula es lo que evita el
   * cierre que el servidor va a rechazar: las existencias no pueden quedar en
   * negativo, el almacén se descuenta al cerrar, y ese rechazo llega horas
   * después, en una cola que mira otra persona, con el material ya instalado y
   * nadie a quien preguntarle.
   */
  const articulos = useLiveQuery(
    async () => {
      const [items, niveles] = await Promise.all([
        db.stockItems.toArray(),
        db.stockLevels.toArray(),
      ])
      const porItem = new Map(niveles.map((n) => [n.stock_item_id, n.on_hand]))
      return items.map((i) => ({ ...i, quedan: porItem.get(i.id) ?? null }))
    },
    [],
    [],
  )

  /*
   * Lo que hace falta para saber si hay algo que elegir, también del espejo:
   * cuántas hay de cada estado y qué aparatos con número de serie están en la
   * estantería. Sin ninguna de las dos cosas —un servidor anterior, un iPad que
   * aún no ha sincronizado— no se pregunta nada y se apunta como siempre.
   */
  const niveles = useLiveQuery(
    async () => new Map((await db.stockLevelsPorEstado.toArray()).map((n) => [n.stock_item_id, n])),
    [],
    new Map(),
  )
  const unidadesPorArticulo = useLiveQuery(
    async () => {
      const [disponibles, partes] = await Promise.all([
        db.stockUnits.where('status').equals('disponible').toArray(),
        db.outbox.where('entity').equals('incident_material').toArray(),
      ])
      // Las que otra avería de este iPad ya tiene apuntadas y sin subir.
      const enOtros = new Set(
        partes
          .filter((e) => e.payload['incident_id'] !== incidentId && Number(e.payload['qty'] ?? 0) > 0)
          .map((e) => String(e.payload['stock_unit_id'] ?? ''))
          .filter(Boolean),
      )
      return unidadesLibres(disponibles, enOtros)
    },
    [incidentId],
    new Map<string, UnidadDeAlmacen[]>(),
  )

  // Todos, no los seis primeros: con «HDMI» el cable gastado podía ser el
  // séptimo y no había forma de llegar a él. Lo cuenta `buscarArticulo.ts`.
  const coincidencias = useMemo(() => buscarArticulos(articulos, query), [articulos, query])

  /*
   * El parte tal y como está en el servidor. Necesita conexión y por eso no
   * bloquea nada: sin ella se apunta igual. Está para lo de siempre —dos
   * técnicos, o el mismo técnico dos veces— que sin verlo acaba en el material
   * contado doble.
   *
   * Vienen también las filas que trajo el Excel y las que están a cero: las
   * primeras se corrigen desde aquí igual que las demás, y las segundas son
   * artículos quitados, que no se enseñan pero sí cuentan para saber a qué
   * fila va el siguiente toque.
   */
  const { data: enElServidor } = useQuery({
    queryKey: ['incident-materials', incidentId],
    queryFn: async () => {
      const pedir = (columnas: string) =>
        supabase
          .from('incident_materials')
          .select(columnas)
          .eq('incident_id', incidentId)
          .not('stock_item_id', 'is', null)
      let res = await pedir('id, qty, stock_item_id, condicion, stock_unit_id')
      // Un servidor anterior al 18/11/2026 no tiene las dos columnas: se pide
      // como antes, y ninguna fila dice cuál.
      if (res.error && /condicion|stock_unit_id|42703|PGRST204/i.test(`${res.error.message} ${res.error.code ?? ''}`)) {
        res = await pedir('id, qty, stock_item_id')
      }
      if (res.error) throw res.error
      return (res.data ?? []) as unknown as FilaDelServidor[]
    },
    retry: false,
  })

  /*
   * Y las filas del parte que **todavía están en la cola**, que sin cobertura
   * son todas.
   *
   * Faltaba, y se notaba justo donde más duele: en el aula, sin red, la lista
   * de arriba no contesta y lo que se acababa de apuntar no aparecía en ninguna
   * parte. O sea que la pantalla decía lo mismo tanto si el cable estaba
   * apuntado como si no — que es la manera exacta de apuntarlo dos veces.
   *
   * Una fila que está saliendo se trata como cualquiera de la cola: tocarla la
   * reencola con la cantidad nueva y la cola, al terminar la subida en vuelo,
   * ve que ha cambiado y la vuelve a mandar. Es lo bueno de que sea un parte y
   * no un asiento: la última cantidad pisa, y no hay nada que compensar.
   */
  const filaDeLaCola = (e: { id: string; payload: Record<string, unknown> }): LineaDelParte => ({
    id: e.id,
    qty: Number(e.payload['qty'] ?? 0),
    stockItemId: String(e.payload['stock_item_id'] ?? ''),
    donde: 'en_cola',
    condicion: (e.payload['condicion'] as Condicion | null | undefined) ?? null,
    unitId: (e.payload['stock_unit_id'] as string | null | undefined) ?? null,
  })

  const enCola = useLiveQuery(
    async () => {
      const filas = await db.outbox.where('entity').equals('incident_material').toArray()
      return filas.filter((e) => e.payload['incident_id'] === incidentId).map(filaDeLaCola)
    },
    [incidentId],
    [],
  )

  /*
   * Los tres sitios, sin repetir ni perder ninguno. La regla está en
   * `material.ts`, que es donde se prueba.
   */
  const delServidor: LineaDelParte[] = (enElServidor ?? []).map((m) => ({
    id: m.id,
    qty: m.qty,
    stockItemId: m.stock_item_id,
    donde: 'arriba' as const,
    condicion: m.condicion ?? null,
    unitId: m.stock_unit_id ?? null,
  }))
  const parte = mezclarParte(enCola, delServidor, apuntadasAqui.current)

  /*
   * En cuanto el servidor devuelve una fila, se deja de recordar.
   *
   * El recuerdo es una red para el hueco entre la cola y el servidor, no un
   * segundo almacén: mantenerlo después sería quedarse con una copia que ya no
   * se refresca, y una corrección hecha desde otro dispositivo no la tocaría.
   */
  useEffect(() => {
    if (!enElServidor) return
    const arriba = new Set(enElServidor.map((m) => m.id))
    apuntadasAqui.current = apuntadasAqui.current.filter((l) => !arriba.has(l.id))
  }, [enElServidor])

  const lineas = lineasDeMaterial(parte)

  const articuloDe = (id: string): (typeof articulos)[number] | null => articulos.find((a) => a.id === id) ?? null

  /** Qué se puede elegir de ese artículo AHORA, con lo que el parte ya lleva. */
  const opcionesDe = (id: string): Opciones => {
    const art = articuloDe(id)
    return opcionesDeMaterial({
      seguimiento: art?.seguimiento ?? null,
      nivel: niveles.get(id) ?? null,
      quedan: art?.quedan ?? null,
      unidades: unidadesPorArticulo.get(id) ?? [],
      apuntado: detalleDe(parte, id),
    })
  }

  /*
   * El número de serie de cada aparato del parte.
   *
   * Los que siguen en la estantería están en el espejo. Los de una avería ya
   * cerrada no —salieron del almacén, y el espejo solo guarda las
   * disponibles—, así que esos se le preguntan al servidor. Sin cobertura se
   * queda en «con número de serie», que es verdad y no inventa nada.
   */
  const unidadesDelParte = [...new Set(parte.map((l) => l.unitId).filter((u): u is string => Boolean(u)))].sort()
  const enElEspejo = useLiveQuery(
    async () => new Map((await db.stockUnits.bulkGet(unidadesDelParte)).filter(Boolean).map((u) => [u!.id, u!])),
    [unidadesDelParte.join(',')],
    new Map<string, UnidadDeAlmacen>(),
  )
  const queFaltan = unidadesDelParte.filter((id) => !enElEspejo.has(id))
  const { data: delServidorPorId } = useQuery({
    queryKey: ['incident-materials', 'unidades', queFaltan.join(',')],
    enabled: queFaltan.length > 0,
    queryFn: async () => {
      const { data, error: err } = await supabase.from('stock_units').select('id, serial, condicion').in('id', queFaltan)
      if (err) throw err
      return new Map((data ?? []).map((u) => [u.id as string, u as { id: string; serial: string; condicion: Condicion }]))
    },
    retry: false,
  })
  const serieDe = (unitId: string): string | null =>
    enElEspejo.get(unitId)?.serial ?? delServidorPorId?.get(unitId)?.serial ?? null

  const nombreDe = (id: string): string =>
    articuloDe(id)?.name ?? 'Artículo retirado del catálogo'

  /**
   * Una fila del parte con su cantidad, a la cola. La misma fila cada vez.
   *
   * El id va en los dos sitios: es la clave de la cola y la de la fila. Con el
   * mismo valor, reencolar es reescribir la entrada que hubiera —`enqueue`
   * pisa— y en el servidor es un UPDATE de la fila que ya está. Reenviarla no
   * duplica nada, y una entrada que estuviera en vuelo vuelve a salir con la
   * cantidad nueva cuando la subida termine.
   */
  async function apuntar(cambio: Cambio): Promise<void> {
    await enqueue('incident_material', cambio.id, {
      id: cambio.id,
      incident_id: incidentId,
      stock_item_id: cambio.stockItemId,
      qty: cambio.qty,
      origen: 'app',
      // Solo si dice cuál: una fila que no elige nada viaja como siempre.
      ...(cambio.condicion ? { condicion: cambio.condicion } : {}),
      ...(cambio.unitId ? { stock_unit_id: cambio.unitId } : {}),
    })
    const recordada = apuntadasAqui.current.some((l) => l.id === cambio.id)
    apuntadasAqui.current = recordada
      ? apuntadasAqui.current.map((l) => (l.id === cambio.id ? { ...l, qty: cambio.qty } : l))
      : [...apuntadasAqui.current, { ...cambio, donde: 'arriba' }]
  }

  /** Y hacer lo que `material.ts` haya decidido. */
  async function ejecutar(cambios: Cambio[]): Promise<void> {
    setError(null)
    try {
      for (const c of cambios) await apuntar(c)
      /*
       * Y cuando la cola acabe de subir, se vuelve a preguntar al servidor.
       *
       * Faltaba: `['incident-materials']` se pedía al abrir el panel y no se
       * invalidaba en ningún sitio del proyecto, así que la lista del servidor
       * se quedaba congelada en la foto del principio mientras la cola iba
       * vaciándose debajo.
       */
      void flush().then(() => qc.invalidateQueries({ queryKey: ['incident-materials', incidentId] }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se ha podido apuntar')
    }
  }

  /**
   * Un toque, un cambio, **y en fila**.
   *
   * Dos motivos, y los dos producían material duplicado:
   *
   *  - El plan se calculaba con lo que había PINTADO. Entre dos toques
   *    seguidos —y en un móvil eso son un par de dedos torpes— la lista aún no
   *    se ha repintado, así que el segundo toque planificaba sobre la foto de
   *    antes: donde debía subir a dos la fila que acababa de crear, abría otra
   *    de uno.
   *  - Y se ejecutaban a la vez, con lo cual ni siquiera el orden estaba claro.
   *
   * Así que el plan se calcula **al ejecutar**, releyendo la cola de Dexie, y
   * los cambios van uno detrás de otro. El `catch` del encadenado es para que
   * uno que falle no rompa la fila: el error ya se enseña dentro.
   */
  const enFila = useRef<Promise<unknown>>(Promise.resolve())

  function pedir(plan: (p: LineaDelParte[], stockItemId: string) => Cambio[], stockItemId: string): void {
    enFila.current = enFila.current.then(
      async () => {
        const fresco = mezclarParte(await colaDeAhora(), delServidor, apuntadasAqui.current)
        await ejecutar(plan(fresco, stockItemId))
      },
      () => undefined,
    )
  }

  /** Sumar lleva su generador de ids: la fila nueva nace con el suyo. */
  const sumar =
    (cual: Cual) =>
    (p: LineaDelParte[], stockItemId: string): Cambio[] =>
      planSumar(p, stockItemId, uuidv7, cual)

  /** El `−` de una de las cosas elegidas: «una nueva menos», «quitar ese aparato». */
  const restar =
    (clave?: string) =>
    (p: LineaDelParte[], stockItemId: string): Cambio[] =>
      planRestar(p, stockItemId, clave)

  /**
   * Una más de ese artículo: si hay algo que elegir, se pregunta; si no, se
   * apunta —sin decir cuál, o el único aparato que hay—.
   */
  function unaMas(stockItemId: string): void {
    const o = opcionesDe(stockItemId)
    if (o.hayQueElegir) setEligiendo(stockItemId)
    else pedir(sumar(o.unica), stockItemId)
  }

  /** La cola tal y como está AHORA, sin pasar por el render. */
  async function colaDeAhora(): Promise<LineaDelParte[]> {
    const filas = await db.outbox.where('entity').equals('incident_material').toArray()
    return filas.filter((e) => e.payload['incident_id'] === incidentId).map(filaDeLaCola)
  }

  return (
    <div className="mt-3 rounded-ctl border border-line bg-raised p-3">
      {lineas.length > 0 && (
        <ul className="mb-3 space-y-2">
          {lineas.map((l) => {
            const art = articuloDe(l.stockItemId)
            const pasado = art?.quedan !== null && art !== null && l.unidades > art.quedan
            // Sin nada elegido, la línea de siempre: su −, su cifra y su +.
            const simple = l.detalle.length === 1 && l.detalle[0]!.clave === ''
            return (
              <li key={l.stockItemId}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{nombreDe(l.stockItemId)}</span>
                    {l.sinSubir && <span className="text-xs text-warn">sin subir</span>}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    {simple && (
                      <button
                        type="button"
                        onClick={() => pedir(restar(), l.stockItemId)}
                        className="key key-quiet h-11 w-11"
                        aria-label={`Una unidad menos de ${nombreDe(l.stockItemId)}`}
                      >
                        −
                      </button>
                    )}
                    <span
                      className={`w-7 text-center font-mono tabular ${pasado ? 'text-warn' : ''}`}
                      aria-label={`${l.unidades} unidades`}
                    >
                      {l.unidades}
                    </span>
                    <button
                      type="button"
                      onClick={() => unaMas(l.stockItemId)}
                      className="key key-quiet h-11 w-11"
                      aria-label={`Una unidad más de ${nombreDe(l.stockItemId)}`}
                    >
                      +
                    </button>
                    {/* Quitar la línea entera: sus filas a cero. El almacén no
                        ha descontado nada todavía, así que no hay nada que
                        devolver; y si la avería ya estaba cerrada, el cero es lo
                        que le dice al servidor que devuelva lo descontado. */}
                    <button
                      type="button"
                      onClick={() => {
                        if (eligiendo === l.stockItemId) setEligiendo(null)
                        pedir(planQuitar, l.stockItemId)
                      }}
                      className="key key-quiet h-11 w-11 text-crit"
                      aria-label={`Quitar ${nombreDe(l.stockItemId)} de esta avería`}
                    >
                      ×
                    </button>
                  </span>
                </div>

                {/* Cuáles son, cuando se ha elegido: cada cosa con su `−`. */}
                {!simple && (
                  <ul className="ml-1 mt-1 space-y-1 border-l-2 border-line-soft pl-3">
                    {l.detalle.map((d) => (
                      <li key={d.clave} className="flex min-h-11 items-center gap-2">
                        <LoElegido detalle={d} serie={d.unitId ? serieDe(d.unitId) : null} />
                        <span className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => pedir(restar(d.clave), l.stockItemId)}
                            className="key key-quiet h-11 w-11"
                            aria-label={`${d.unitId ? 'Quitar' : 'Una menos de'} ${textoDe(d, d.unitId ? serieDe(d.unitId) : null)}, ${nombreDe(l.stockItemId)}`}
                          >
                            −
                          </button>
                          {/* Un aparato es uno: no lleva cifra ni `+`. De un
                              estado sí se puede poner otra igual sin volver a
                              pasar por la pregunta. */}
                          {!d.unitId && (
                            <span
                              className="w-7 text-center font-mono text-sm tabular"
                              aria-label={`${d.unidades} ${textoDe(d, null)}`}
                            >
                              {d.unidades}
                            </span>
                          )}
                          {!d.unitId && d.condicion && (
                            <button
                              type="button"
                              onClick={() => pedir(sumar({ condicion: d.condicion! }), l.stockItemId)}
                              className="key key-quiet h-11 w-11"
                              aria-label={`Una más de ${textoDe(d, null)}, ${nombreDe(l.stockItemId)}`}
                            >
                              +
                            </button>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {/*
        El aviso cuando lo apuntado se pasa de lo que hay.

        Avisa y **no bloquea**, a propósito: la cifra del dispositivo es una
        foto que puede estar vieja, y negarle a alguien apuntar el cable que
        acaba de poner porque su iPad cree que no quedaba sería fiarse más de la
        copia que de la persona. Lo que no puede pasar es que se entere el
        servidor y no quien lo apunta: el saldo no puede quedar en negativo y el
        almacén se descuenta al cerrar la avería, así que es el cierre lo que
        volverá rechazado — y hay que decirlo aquí, antes.
      */}
      {lineas.map((l) => {
        const art = articuloDe(l.stockItemId)
        if (!art || art.quedan === null || l.unidades <= art.quedan) return null
        return (
          <p key={`aviso-${l.stockItemId}`} className="mb-2 text-sm text-warn">
            {art.quedan <= 0
              ? `Según la última sincronización no queda ningún ${art.name.toLowerCase()} en el almacén.`
              : `Según la última sincronización solo quedan ${art.quedan} de ${art.name.toLowerCase()}.`}{' '}
            Si de verdad has usado {l.unidades}, déjalo — pero el almacén rechazará el cierre de la
            avería hasta que se registre la compra que falta.
          </p>
        )
      })}

      <label className="block">
        <span className="sr-only">Buscar artículo del almacén</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus={enfocar}
          /*
           * Enter aquí no hace nada —la lista filtra según se teclea— y
           * dentro de un formulario haría lo peor que puede hacer: enviarlo.
           * Este buscador vive ahora dentro del cierre de la avería, así que
           * la tecla de búsqueda del teclado del móvil daría por resuelta la
           * incidencia a media palabra.
           */
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.preventDefault()
          }}
          placeholder="Material usado: busca el artículo"
          enterKeyHint="search"
          className="h-touch w-full rounded-ctl border border-line bg-sunken px-3 text-base"
        />
      </label>

      {eligiendo && (
        <ElegirCual
          // Otra pregunta, otro buscador: el de dentro no arrastra lo tecleado.
          key={eligiendo}
          nombre={nombreDe(eligiendo)}
          opciones={opcionesDe(eligiendo)}
          onElegir={(cual) => {
            pedir(sumar(cual), eligiendo)
            setEligiendo(null)
          }}
          onCancelar={() => setEligiendo(null)}
        />
      )}

      {/* Mientras se pregunta cuál, la lista de resultados se aparta: dos
          listas tocables seguidas, en un teléfono, es tocar la que no era. */}
      {!eligiendo && coincidencias.length > 0 && (
        <>
          {/* Cuántos hay, dicho antes de la lista: si no caben, es lo único que
              avisa de que la lista sigue por debajo. */}
          <p className="mt-2 text-xs text-muted" aria-live="polite">
            {coincidencias.length === 1 ? '1 artículo' : `${coincidencias.length} artículos`}
            {coincidencias.length > 6 && ' · desliza la lista para verlos todos'}
          </p>
          {/*
            La lista desplaza por dentro, con su alto tope, y no empuja el resto
            del cierre hasta el fondo. `overscroll-contain`: al llegar al final no
            arrastra la pantalla de detrás, que es lo que hace que desplazar una
            lista dentro de otra se sienta a trompicones. El tope deja asomar
            media fila más: cortada justo entre dos filas, la lista parece
            terminar ahí.
          */}
          <ul className="mt-1 max-h-[18.5rem] divide-y divide-line overflow-y-auto overscroll-contain rounded-ctl border border-line bg-surface px-3">
            {coincidencias.map(({ articulo: a, alias }) => (
              <li key={a.id}>
                {/*
                  Un toque y está apuntado — o, si del artículo hay de varios
                  estados o lleva número de serie, un toque y se pregunta cuál.

                  Antes esto solo lo seleccionaba y hacía falta un segundo toque
                  en «Apuntar». Los dos pasos existían para poder elegir la
                  cantidad antes de confirmar, y la cantidad se elige igual de bien
                  después, en la línea que sale arriba — con la ventaja de que
                  ahora también se puede corregir.
                */}
                <button
                  type="button"
                  onClick={() => unaMas(a.id)}
                  className="flex min-h-11 w-full items-center gap-3 py-2 text-left text-sm"
                >
                  <span className="min-w-0 flex-1">
                    {a.name}
                    {/* Si ha salido por un nombre de antes, se dice cuál: si no,
                        un resultado que no se parece a lo tecleado parece un
                        error. */}
                    {alias && <span className="block text-xs text-muted">antes «{alias}»</span>}
                  </span>
                  {/* Cuánto queda, en la propia lista: es lo que decide cuál
                      de los tres cables se coge, y preguntarlo después de
                      elegir llega tarde. */}
                  {a.quedan !== null && (
                    <span
                      className={`shrink-0 font-mono text-xs tabular ${
                        a.quedan <= 0 ? 'text-crit' : a.quedan <= a.min_threshold ? 'text-warn' : 'text-muted'
                      }`}
                    >
                      {a.quedan} {a.unit}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Que no aparezca lo que se busca no es un callejón sin salida, pero
          tampoco se puede inventar el artículo desde aquí: el almacén es
          maestro y darle de alta un artículo es cosa del administrador. */}
      {!eligiendo && query && coincidencias.length === 0 && (
        <p className="mt-2 text-xs text-muted">
          Ningún artículo coincide. Si es material nuevo, tiene que darlo de alta un administrador
          desde Almacén.
        </p>
      )}

      {error && <p className="mt-2 text-sm text-crit">{error}</p>}
    </div>
  )
}

/** Una fila de `incident_materials` tal y como la devuelve el servidor. */
interface FilaDelServidor {
  id: string
  qty: number
  stock_item_id: string
  condicion?: Condicion | null
  stock_unit_id?: string | null
}

/** Cómo se dice, en una frase, una de las cosas elegidas: para los lectores de pantalla. */
function textoDe(d: DetalleDeMaterial, serie: string | null): string {
  if (d.unitId) return serie ? `la unidad con número de serie ${serie}` : 'la unidad con número de serie'
  if (d.condicion) return nombreDelGrupo(d.condicion).toLowerCase()
  return 'las que no dicen cuál'
}

/**
 * Una de las cosas elegidas de una línea: «● Nuevas», «S/N PF3ABC12 · Usado» o
 * «Sin elegir» para las que se apuntaron sin decir cuál.
 */
function LoElegido({ detalle: d, serie }: { detalle: DetalleDeMaterial; serie: string | null }): React.ReactElement {
  if (d.unitId) {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 truncate font-mono text-sm">
          <span className="text-muted">S/N </span>
          {serie ?? '…'}
        </span>
        {d.condicion && <EtiquetaDeCondicion condicion={d.condicion} />}
      </span>
    )
  }
  if (d.condicion) {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${PUNTO_DE_CONDICION[d.condicion]}`} />
        <span className={`truncate ${d.condicion === 'averiado' ? 'text-crit' : ''}`}>
          {nombreDelGrupo(d.condicion)}
          <span className="sr-only"> ({CONDICION_LABEL[d.condicion]})</span>
        </span>
      </span>
    )
  }
  return <span className="min-w-0 flex-1 truncate text-sm text-muted">Sin elegir</span>
}
