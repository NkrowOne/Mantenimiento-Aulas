import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { v7 as uuidv7 } from 'uuid'
import { db, enqueue } from '@/db/dexie'
import { flush } from '@/sync/outbox'
import { supabase } from '@/lib/supabase'
import { norm } from '@/domain/normalize'
import {
  lineasDeMaterial,
  mezclarApuntes,
  planQuitar,
  planRestar,
  planSumar,
  type ApunteDeMaterial,
  type Operacion,
} from './material'

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
 * había forma de quitarlo desde aquí: el movimiento estaba mal, la avería se
 * cerraba igual y el descuadre se arreglaba semanas después desde el Almacén,
 * si alguien lo veía. Ahora tocar el artículo lo apunta, y la línea que sale
 * lleva su `−`, su `+` y su `×`. Qué significa cada uno según dónde esté el
 * apunte —en la cola, saliendo o ya arriba— lo decide `material.ts`, que es
 * donde está probado.
 */
export function MaterialUsado({
  incidentId,
  roomId,
}: {
  incidentId: string
  roomId: string | null
}): React.ReactElement {
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const qc = useQueryClient()

  /*
   * Lo que ESTA pantalla ha encolado, recordado aparte.
   *
   * Es el tercer sitio de donde puede venir un apunte, y el que faltaba. La
   * cola BORRA la fila al subirla y la lista del servidor se pedía una sola vez
   * al abrir el panel: entre esas dos cosas el apunte no estaba en ningún lado
   * y la línea desaparecía de la pantalla con el cable ya descontado. Quien no
   * ve lo que acaba de apuntar, lo apunta otra vez — y eso es exactamente el
   * material duplicado que se veía.
   *
   * En un `ref` y no en estado: no pinta nada por sí solo —lo pinta la mezcla—
   * y cambiarlo dentro de una operación no tiene por qué provocar un render.
   */
  const apuntadosAqui = useRef<ApunteDeMaterial[]>([])

  /*
   * Del espejo local: la lista de artículos ya está en el dispositivo, y con
   * ella **cuánto queda de cada uno**.
   *
   * La cifra es una foto, no la verdad —el saldo se calcula en el servidor
   * sumando movimientos—, pero enseñarla dentro del aula es lo que evita el
   * apunte que el servidor va a rechazar: las existencias no pueden quedar en
   * negativo, y ese rechazo llega horas después, en una cola que mira otra
   * persona, con el material ya instalado y nadie a quien preguntarle.
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

  const coincidencias = useMemo(() => {
    const q = norm(query)
    if (!q) return []
    return articulos
      .filter((a) => norm(a.name).includes(q))
      .sort((a, b) => {
        const empieza = (n: string): number => (norm(n).startsWith(q) ? 0 : 1)
        return empieza(a.name) - empieza(b.name) || a.name.localeCompare(b.name)
      })
      .slice(0, 6)
  }, [articulos, query])

  /*
   * Lo ya apuntado en esta incidencia. Necesita conexión y por eso no bloquea
   * nada: sin ella se apunta igual. Está para lo de siempre —dos técnicos, o el
   * mismo técnico dos veces— que sin verlo acaba en el material contado doble.
   *
   * Las devoluciones vienen con los consumos, y no es un detalle: la cuenta de
   * lo gastado es la resta de las dos. Sin ellas, quitar una línea que ya había
   * subido la dejaría en pantalla como si el `×` no hubiera hecho nada.
   */
  const { data: enElServidor } = useQuery({
    queryKey: ['incident-materials', incidentId],
    queryFn: async () => {
      const { data, error: err } = await supabase
        .from('stock_movements')
        .select('id, qty, stock_item_id, kind')
        .eq('incident_id', incidentId)
        .in('kind', ['consumo', 'devolucion'])
      if (err) throw err
      return (data ?? []) as Array<{
        id: string
        qty: number
        stock_item_id: string
        kind: 'consumo' | 'devolucion'
      }>
    },
    retry: false,
  })

  /*
   * Y lo apuntado que **todavía está en la cola**, que sin cobertura es todo.
   *
   * Faltaba, y se notaba justo donde más duele: en el aula, sin red, la lista
   * de arriba no contesta y lo que se acababa de apuntar no aparecía en ninguna
   * parte. O sea que la pantalla decía lo mismo tanto si el cable estaba
   * apuntado como si no — que es la manera exacta de apuntarlo dos veces.
   *
   * El estado de la cola viaja con cada apunte porque de él depende qué hace el
   * `×`: lo que no ha salido se borra y lo que sí, se devuelve. Un `enviando`
   * cuenta como salido: ya va por el aire.
   */
  const enCola = useLiveQuery(
    async () => {
      const filas = await db.outbox.where('entity').equals('stock_movement').toArray()
      return filas
        .filter((e) => e.payload['incident_id'] === incidentId)
        .map((e) => ({
          id: e.id,
          qty: Number(e.payload['qty'] ?? 0),
          stockItemId: String(e.payload['stock_item_id'] ?? ''),
          kind: (e.payload['kind'] === 'devolucion' ? 'devolucion' : 'consumo') as
            | 'consumo'
            | 'devolucion',
          donde: (e.status === 'enviando' ? 'saliendo' : 'en_cola') as 'saliendo' | 'en_cola',
        }))
    },
    [incidentId],
    [],
  )

  /*
   * Los tres sitios, sin repetir ni perder ninguno. La regla está en
   * `material.ts`, que es donde se prueba.
   */
  const delServidor: ApunteDeMaterial[] = (enElServidor ?? []).map((m) => ({
    id: m.id,
    qty: m.qty,
    stockItemId: m.stock_item_id,
    kind: m.kind,
    donde: 'arriba' as const,
  }))
  const apuntes = mezclarApuntes(enCola, delServidor, apuntadosAqui.current)

  /*
   * En cuanto el servidor cuenta un apunte, se deja de recordar.
   *
   * El recuerdo es una red para el hueco entre la cola y el servidor, no un
   * segundo almacén: mantenerlo después sería quedarse con una copia que ya no
   * se refresca, y una devolución hecha desde otro sitio no la tocaría.
   */
  useEffect(() => {
    if (!enElServidor) return
    const arriba = new Set(enElServidor.map((m) => m.id))
    apuntadosAqui.current = apuntadosAqui.current.filter((a) => !arriba.has(a.id))
  }, [enElServidor])

  const lineas = lineasDeMaterial(apuntes)

  const articuloDe = (id: string): { name: string; quedan: number | null; unit: string } | null =>
    articulos.find((a) => a.id === id) ?? null

  const nombreDe = (id: string): string =>
    articuloDe(id)?.name ?? 'Artículo retirado del catálogo'

  /** Un movimiento nuevo, del signo que toque. `consumo` va en negativo. */
  async function apuntarNuevo(stockItemId: string, qty: number): Promise<void> {
    const { data } = await supabase.auth.getSession()
    // El id va en los dos sitios: es la clave de la cola y la de la fila. Con
    // el mismo valor, reenviar el apunte es no hacer nada.
    const id = uuidv7()
    await enqueue('stock_movement', id, {
      id,
      stock_item_id: stockItemId,
      qty,
      kind: qty < 0 ? 'consumo' : 'devolucion',
      incident_id: incidentId,
      room_id: roomId,
      occurred_at: new Date().toISOString(),
      by_user: data.session?.user.id ?? null,
    })
    apuntadosAqui.current = [
      ...apuntadosAqui.current,
      { id, qty, stockItemId, kind: qty < 0 ? 'consumo' : 'devolucion', donde: 'arriba' },
    ]
  }

  /**
   * Cambiar o borrar una fila de la cola, **comprobando dentro que sigue ahí**.
   *
   * La comprobación tiene que ir dentro de la transacción y no antes porque
   * entre leer la lista y pulsar el botón cabe una pasada de la cola. Y lo que
   * pasa si se pierde esa carrera no es un error a la vista: `stock_movement`
   * sube con «no pises lo que ya esté», así que una fila reencolada después de
   * salir se manda, el servidor la ignora por repetida, y la pantalla se queda
   * enseñando una cantidad que arriba no existe.
   *
   * @returns `true` si se aplicó; `false` si la fila ya había salido.
   */
  async function tocarLaCola(
    id: string,
    cambio: { qty: number } | 'borrar',
  ): Promise<boolean> {
    return await db.transaction('rw', db.outbox, async () => {
      const fila = await db.outbox.get(id)
      // `enviando` va por el aire; lo demás —pendiente, rechazado— no ha salido.
      if (!fila || fila.status === 'enviando') return false
      if (cambio === 'borrar') {
        await db.outbox.delete(id)
        return true
      }
      await db.outbox.put({
        ...fila,
        payload: { ...fila.payload, qty: cambio.qty },
        attempts: 0,
        nextAttemptAt: 0,
        status: 'pendiente',
        lastError: null,
      })
      return true
    })
  }

  /**
   * Y hacer lo que `material.ts` haya decidido.
   *
   * Cuando la carrera se pierde —la fila salió justo entre el plan y el toque—
   * no se deja a medias: lo que se quería cambiar se consigue igual con un
   * asiento nuevo, que es lo que el plan habría dicho de haberlo sabido. La
   * diferencia entre lo que pedía y lo que había dice de qué signo es.
   */
  async function ejecutar(ops: Operacion[], stockItemId: string, base: ApunteDeMaterial[]): Promise<void> {
    setError(null)
    try {
      for (const op of ops) {
        if (op.tipo === 'consumo') await apuntarNuevo(stockItemId, -op.unidades)
        else if (op.tipo === 'devolucion') await apuntarNuevo(stockItemId, op.unidades)
        else {
          const antes = base.find((a) => a.id === op.id)?.qty ?? 0
          const despues = op.tipo === 'borrar' ? 0 : op.qty
          const hecho = await tocarLaCola(op.id, op.tipo === 'borrar' ? 'borrar' : { qty: op.qty })
          if (hecho) {
            // Lo recordado sigue a la cola: si no, borrar un apunte que aún no
            // había salido lo dejaría en pantalla para siempre.
            apuntadosAqui.current =
              op.tipo === 'borrar'
                ? apuntadosAqui.current.filter((a) => a.id !== op.id)
                : apuntadosAqui.current.map((a) => (a.id === op.id ? { ...a, qty: op.qty } : a))
          } else {
            await apuntarNuevo(stockItemId, despues - antes)
          }
        }
      }
      /*
       * Y cuando la cola acabe de subir, se vuelve a preguntar al servidor.
       *
       * Faltaba: `['incident-materials']` se pedía al abrir el panel y no se
       * invalidaba en ningún sitio del proyecto —una sola aparición en todo el
       * código—, así que la lista del servidor se quedaba congelada en la foto
       * del principio mientras la cola iba vaciándose debajo.
       */
      void flush().then(() => qc.invalidateQueries({ queryKey: ['incident-materials', incidentId] }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se ha podido apuntar')
    }
  }

  /**
   * Un toque, una operación, **y en fila**.
   *
   * Dos motivos, y los dos producían material duplicado:
   *
   *  - El plan se calculaba con lo que había PINTADO. Entre dos toques
   *    seguidos —y en un móvil eso son un par de dedos torpes— la lista aún no
   *    se ha repintado, así que el segundo toque planificaba sobre la foto de
   *    antes: donde debía subir a dos el apunte que acababa de crear, abría
   *    otro de uno.
   *  - Y se ejecutaban a la vez, con lo cual ni siquiera el orden estaba claro.
   *
   * Así que el plan se calcula **al ejecutar**, releyendo la cola de Dexie, y
   * las operaciones van una detrás de otra. El `catch` del encadenado es para
   * que una que falle no rompa la fila: el error ya se enseña dentro.
   */
  const enFila = useRef<Promise<unknown>>(Promise.resolve())

  function pedir(
    plan: (a: ApunteDeMaterial[], stockItemId: string) => Operacion[],
    stockItemId: string,
  ): void {
    enFila.current = enFila.current.then(
      async () => {
        const frescos = mezclarApuntes(await colaDeAhora(), delServidor, apuntadosAqui.current)
        await ejecutar(plan(frescos, stockItemId), stockItemId, frescos)
      },
      () => undefined,
    )
  }

  /** La cola tal y como está AHORA, sin pasar por el render. */
  async function colaDeAhora(): Promise<ApunteDeMaterial[]> {
    const filas = await db.outbox.where('entity').equals('stock_movement').toArray()
    return filas
      .filter((e) => e.payload['incident_id'] === incidentId)
      .map((e) => ({
        id: e.id,
        qty: Number(e.payload['qty'] ?? 0),
        stockItemId: String(e.payload['stock_item_id'] ?? ''),
        kind: (e.payload['kind'] === 'devolucion' ? 'devolucion' : 'consumo') as
          | 'consumo'
          | 'devolucion',
        donde: (e.status === 'enviando' ? 'saliendo' : 'en_cola') as 'saliendo' | 'en_cola',
      }))
  }

  return (
    <div className="mt-3 rounded-ctl border border-line bg-raised p-3">
      {lineas.length > 0 && (
        <ul className="mb-3 space-y-2">
          {lineas.map((l) => {
            const art = articuloDe(l.stockItemId)
            const pasado = art?.quedan !== null && art !== null && l.unidades > art.quedan
            return (
              <li key={l.stockItemId} className="flex items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{nombreDe(l.stockItemId)}</span>
                  {l.sinSubir && <span className="text-xs text-warn">sin subir</span>}
                </span>
                <span className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => pedir(planRestar, l.stockItemId)}
                    className="key key-quiet h-11 w-11"
                    aria-label={`Una unidad menos de ${nombreDe(l.stockItemId)}`}
                  >
                    −
                  </button>
                  <span
                    className={`w-7 text-center font-mono tabular ${pasado ? 'text-warn' : ''}`}
                    aria-label={`${l.unidades} unidades`}
                  >
                    {l.unidades}
                  </span>
                  <button
                    type="button"
                    onClick={() => pedir(planSumar, l.stockItemId)}
                    className="key key-quiet h-11 w-11"
                    aria-label={`Una unidad más de ${nombreDe(l.stockItemId)}`}
                  >
                    +
                  </button>
                  {/* Quitar la línea entera. No borra un asiento que ya subió
                      —eso no se puede— sino que devuelve al almacén lo que se
                      apuntó de más, que es la corrección de verdad. */}
                  <button
                    type="button"
                    onClick={() => pedir(planQuitar, l.stockItemId)}
                    className="key key-quiet h-11 w-11 text-crit"
                    aria-label={`Quitar ${nombreDe(l.stockItemId)} de esta avería`}
                  >
                    ×
                  </button>
                </span>
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
        servidor y no quien lo apunta: el saldo no puede quedar en negativo, así
        que ese apunte volverá rechazado y hay que decirlo aquí.
      */}
      {lineas.map((l) => {
        const art = articuloDe(l.stockItemId)
        if (!art || art.quedan === null || l.unidades <= art.quedan) return null
        return (
          <p key={`aviso-${l.stockItemId}`} className="mb-2 text-sm text-warn">
            {art.quedan <= 0
              ? `Según la última sincronización no queda ningún ${art.name.toLowerCase()} en el almacén.`
              : `Según la última sincronización solo quedan ${art.quedan} de ${art.name.toLowerCase()}.`}{' '}
            Si de verdad has usado {l.unidades}, déjalo — pero el almacén lo rechazará hasta que se
            registre la compra que falta.
          </p>
        )
      })}

      <label className="block">
        <span className="sr-only">Buscar artículo del almacén</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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

      {coincidencias.length > 0 && (
        <ul className="mt-2 divide-y divide-line">
          {coincidencias.map((a) => (
            <li key={a.id}>
              {/*
                Un toque y está apuntado.

                Antes esto solo lo seleccionaba y hacía falta un segundo toque
                en «Apuntar». Los dos pasos existían para poder elegir la
                cantidad antes de confirmar, y la cantidad se elige igual de bien
                después, en la línea que sale arriba — con la ventaja de que
                ahora también se puede corregir.
              */}
              <button
                type="button"
                onClick={() => pedir(planSumar, a.id)}
                className="flex min-h-11 w-full items-center gap-3 py-2 text-left text-sm"
              >
                <span className="min-w-0 flex-1">{a.name}</span>
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
      )}

      {/* Que no aparezca lo que se busca no es un callejón sin salida, pero
          tampoco se puede inventar el artículo desde aquí: el almacén es
          maestro y darle de alta un artículo es cosa del administrador. */}
      {query && coincidencias.length === 0 && (
        <p className="mt-2 text-xs text-muted">
          Ningún artículo coincide. Si es material nuevo, tiene que darlo de alta un administrador
          desde Almacén.
        </p>
      )}

      {error && <p className="mt-2 text-sm text-crit">{error}</p>}
    </div>
  )
}
