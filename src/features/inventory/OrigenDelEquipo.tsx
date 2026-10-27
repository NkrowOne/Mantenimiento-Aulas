import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { conflictoDeAlta, type ConflictoDeAlta } from '@/domain/inventory'
import { displayRoomCode } from '@/domain/normalize'
import type { AssetType, RemovalDestino } from '@/domain/types'
import { serialComparable, sinNumeroDeSerie, type UnidadDeAlmacen } from '@/domain/unidades'
import { ElegirUnidad } from './ElegirUnidad'
import type { Origen } from './useRoomInventory'

/**
 * ¿De dónde sale este equipo?
 *
 * Es la pregunta que faltaba. Hasta ahora dar de alta un proyector en un aula
 * no movía nada más: el almacén seguía diciendo que tenía doce y el aula de al
 * lado seguía diciendo que tenía el suyo. Un inventario que solo suma no cuadra
 * nunca.
 *
 * El panel abre con la respuesta más probable ya elegida —del almacén si hay
 * existencias de ese tipo, «ya estaba» si no— para que el caso normal sea
 * confirmar y no rellenar. Es la diferencia entre un paso más y un formulario.
 *
 * Las existencias salen del espejo local, así que la cifra se ve también sin
 * cobertura. Puede tener horas: la buena la tiene el servidor, que rechaza el
 * consumo si no llegan las unidades. Por eso la cifra se enseña como dato y
 * nunca como permiso — no bloquea el botón.
 */

type Modo = 'almacen' | 'traslado' | 'sin_origen'

export function OrigenDelEquipo({
  typeName,
  type,
  roomId,
  inventariando,
  onCancelar,
  onConfirmar,
}: {
  typeName: string
  type: AssetType | null
  roomId: string
  /**
   * La sala está sin inventariar, así que lo que se está haciendo es un
   * levantamiento y no una instalación. Cambia la respuesta que viene elegida:
   * durante un barrido, todo «ya estaba», y preguntar de dónde sale veinte
   * veces seguidas es justo lo que hace que se deje de apuntar.
   */
  inventariando: boolean
  onCancelar: () => void
  /**
   * `duplicarEtiqueta` viaja con el origen: dice que quien confirma ya ha visto
   * que la sala tiene un equipo con ese nombre y aun así quiere otro. Sin ese
   * aviso delante, el alta se planta en vez de inventarse un «… 2».
   */
  onConfirmar: (origen: Origen, opciones: { duplicarEtiqueta: boolean }) => void
}): React.ReactElement {
  // --- Almacén ---------------------------------------------------------------
  const articulos = useLiveQuery(
    async () => {
      if (!type) return []
      const items = await db.stockItems.toArray()
      const niveles = new Map((await db.stockLevels.toArray()).map((n) => [n.stock_item_id, n]))
      return items
        .filter((i) => i.asset_type_id === type.id)
        .map((i) => ({ id: i.id, name: i.name, onHand: niveles.get(i.id)?.on_hand ?? null }))
        .sort((a, b) => (b.onHand ?? -1) - (a.onHand ?? -1) || a.name.localeCompare(b.name, 'es'))
    },
    [type?.id],
    [],
  )

  const conExistencias = articulos.filter((a) => (a.onHand ?? 0) > 0)
  const [stockItemId, setStockItemId] = useState('')
  const [unidades, setUnidades] = useState(1)

  /*
   * Las unidades disponibles de este tipo, del espejo: también sin cobertura.
   *
   * Se quitan las que ya son un equipo de alguna sala de este iPad —se acaban
   * de instalar y el servidor todavía no lo sabe—, para que la misma no se
   * pueda elegir dos veces seguidas.
   */
  // Por los ids y no por el array: el de por defecto es uno nuevo en cada
  // pintado, y como dependencia relanzaría la consulta sin parar.
  const idsDeArticulos = articulos.map((a) => a.id).join(',')
  const unidadesDelTipo = useLiveQuery(
    async (): Promise<UnidadDeAlmacen[]> => {
      if (!type) return []
      const ids = new Set(idsDeArticulos ? idsDeArticulos.split(',') : [])
      const todas = await db.stockUnits.where('status').equals('disponible').toArray()
      const enSalas = new Set(
        (await db.assets.toArray())
          .filter((a) => a.status !== 'retirado' && a.serial)
          .map((a) => serialComparable(a.serial!)),
      )
      return todas.filter(
        (u) =>
          (u.asset_type_id === type.id || (u.stock_item_id !== null && ids.has(u.stock_item_id))) &&
          !enSalas.has(serialComparable(u.serial)),
      )
    },
    [type?.id, idsDeArticulos],
    [] as UnidadDeAlmacen[],
  )
  /** `null` sin elegir; el id de una unidad, o `'sin_numero'`. */
  const [unidadElegida, setUnidadElegida] = useState<string | null>(null)
  /** `null` sin contestar; `'no'` si es una más; el id del equipo al que sustituye. */
  const [sustituye, setSustituye] = useState<string | null>(null)
  const [destinoDelViejo, setDestinoDelViejo] = useState<RemovalDestino>('almacen')

  // --- Traslado --------------------------------------------------------------
  const [buildingId, setBuildingId] = useState('')
  const [origenRoomId, setOrigenRoomId] = useState('')
  const [assetId, setAssetId] = useState('')

  const buildings = useLiveQuery(() => db.buildings.orderBy('sort_order').toArray(), [], [])

  const salas = useLiveQuery(
    async () => {
      if (!buildingId) return []
      const zones = await db.zones.where('building_id').equals(buildingId).toArray()
      const zoneIds = new Set(zones.map((z) => z.id))
      const rooms = await db.rooms.filter((r) => zoneIds.has(r.zone_id) && r.id !== roomId).toArray()
      return rooms.sort((a, b) => a.code.localeCompare(b.code, 'es', { numeric: true }))
    },
    [buildingId, roomId],
    [],
  )

  const equipos = useLiveQuery(
    async () => {
      if (!origenRoomId) return []
      const enSala = await db.assets.where('room_id').equals(origenRoomId).toArray()
      const tipos = new Map((await db.assetTypes.toArray()).map((t) => [t.id, t.name]))
      return enSala
        .filter((a) => a.status !== 'retirado')
        .map((a) => ({
          id: a.id,
          label: a.label ?? tipos.get(a.asset_type_id) ?? 'Equipo',
          esDelTipo: a.asset_type_id === type?.id,
          detalle: [a.model, a.serial].filter(Boolean).join(' · '),
        }))
        // Los del tipo que se está añadiendo, primero: es lo que casi siempre
        // se busca, y en una sala con ocho equipos ahorra leerlos todos.
        .sort((a, b) => Number(b.esDelTipo) - Number(a.esDelTipo) || a.label.localeCompare(b.label, 'es'))
    },
    [origenRoomId, type?.id],
    [],
  )

  // --- El choque de nombre, delante y no después -----------------------------
  /*
   * ¿La sala ya tiene un equipo que se llama así?
   *
   * Se pregunta aquí, con el diálogo abierto, porque este es el último momento
   * en que la respuesta puede cambiar lo que se hace: antes de esto el técnico
   * solo ha tecleado un nombre, y después de esto la fila ya existe. El caso
   * frecuente del choque no es una segunda unidad — es el mismo aparato
   * apuntado dos veces, y para ese la salida correcta es cancelar y corregir el
   * que ya está en la lista.
   *
   * En un traslado no aplica: el equipo que viene de otra sala es otro aparato
   * por definición, y su etiqueta se recoloca sola al llegar.
   */
  const conflicto = useLiveQuery(
    async (): Promise<ConflictoDeAlta | null> => {
      const enSala = await db.assets.where('room_id').equals(roomId).toArray()
      return conflictoDeAlta(enSala, type?.name ?? typeName)
    },
    [roomId, type?.id, typeName],
    null as ConflictoDeAlta | null,
  )

  /*
   * Los del mismo tipo que ya están en la sala: a los que una unidad nueva puede
   * estar sustituyendo. Es la pregunta que el alta normal no hacía: cambiar el
   * proyector que se murió por uno del almacén dejaba dos proyectores en la
   * sala, y el viejo seguía contando en las revisiones.
   */
  const mismosEnSala = useLiveQuery(
    async () => {
      if (!type) return []
      return (await db.assets.where('room_id').equals(roomId).toArray()).filter(
        (a) => a.asset_type_id === type.id && a.status !== 'retirado',
      )
    },
    [roomId, type?.id],
    [],
  )

  // --- Modo ------------------------------------------------------------------
  const sugerido: Modo =
    inventariando || (conExistencias.length === 0 && unidadesDelTipo.length === 0) ? 'sin_origen' : 'almacen'
  const [modo, setModo] = useState<Modo>(sugerido)

  // Las existencias llegan del espejo un instante después del primer pintado,
  // así que el modo sugerido se recalcula cuando aparecen. Solo mientras nadie
  // haya tocado nada: cambiarle la elección al técnico bajo el dedo sería peor
  // que empezar en el modo que no toca.
  const [tocado, setTocado] = useState(false)
  useEffect(() => {
    if (!tocado) setModo(sugerido)
  }, [sugerido, tocado])

  useEffect(() => {
    if (stockItemId) return
    // Primero el artículo que tiene unidades por número de serie: es el que se
    // está buscando cuando hay que elegir una concreta.
    const conUnidades = articulos.find((a) => unidadesDelTipo.some((u) => u.stock_item_id === a.id))
    const primero = conUnidades ?? conExistencias[0]
    if (primero) setStockItemId(primero.id)
  }, [articulos, conExistencias, stockItemId, unidadesDelTipo])

  // Otro artículo, otras unidades: lo elegido del anterior ya no vale.
  useEffect(() => {
    setUnidadElegida(null)
    setSustituye(null)
  }, [stockItemId])

  useEffect(() => setOrigenRoomId(''), [buildingId])
  useEffect(() => setAssetId(''), [origenRoomId])

  const elegido = articulos.find((a) => a.id === stockItemId) ?? null
  const disponibles = elegido?.onHand ?? null

  /*
   * Las unidades que se ofrecen: las del artículo elegido, más las de este tipo
   * que no tienen artículo (una unidad sin casar sigue siendo un aparato que
   * está en la estantería).
   */
  const unidadesOfrecidas = unidadesDelTipo.filter(
    (u) => u.stock_item_id === (stockItemId || null) || u.stock_item_id === null,
  )
  const conSerieDelArticulo = unidadesDelTipo.filter((u) => u.stock_item_id === stockItemId).length
  const sinNumero = disponibles !== null ? sinNumeroDeSerie(disponibles, conSerieDelArticulo) : 0
  const hayQueElegir = modo === 'almacen' && unidadesOfrecidas.length > 0
  const unidad = unidadesOfrecidas.find((u) => u.id === unidadElegida) ?? null
  const preguntaSustitucion = hayQueElegir && unidad !== null && mismosEnSala.length > 0

  const listo = useMemo(() => {
    if (modo === 'almacen') {
      if (hayQueElegir && unidadElegida === null) return false
      if (preguntaSustitucion && sustituye === null) return false
      if (unidad) return true
      return Boolean(stockItemId) && unidades >= 1
    }
    if (modo === 'traslado') return Boolean(assetId)
    return true
  }, [modo, hayQueElegir, unidadElegida, preguntaSustitucion, sustituye, unidad, stockItemId, unidades, assetId])

  // El aviso de choque solo pesa cuando se va a CREAR una fila nueva. Con una
  // unidad elegida lo sustituye la pregunta de si cambia a uno que ya está.
  const chocaAqui = conflicto !== null && modo !== 'traslado' && !preguntaSustitucion

  function confirmar(): void {
    const opciones = { duplicarEtiqueta: chocaAqui || sustituye === 'no' }
    if (modo === 'almacen' && unidad) {
      onConfirmar(
        {
          tipo: 'almacen',
          stockItemId: unidad.stock_item_id ?? stockItemId,
          unidades: 1,
          unidad: { id: unidad.id, serial: unidad.serial, brand: unidad.brand, model: unidad.model },
          sustituye:
            sustituye && sustituye !== 'no' ? { assetId: sustituye, destino: destinoDelViejo } : undefined,
        },
        opciones,
      )
    } else if (modo === 'almacen') onConfirmar({ tipo: 'almacen', stockItemId, unidades }, opciones)
    else if (modo === 'traslado')
      onConfirmar({ tipo: 'traslado', assetId, desdeRoomId: origenRoomId }, opciones)
    else onConfirmar({ tipo: 'sin_origen' }, opciones)
  }

  const MODOS: Array<{ id: Modo; label: string; disponible: boolean }> = [
    { id: 'almacen', label: 'Del almacén', disponible: articulos.length > 0 || unidadesDelTipo.length > 0 },
    { id: 'traslado', label: 'De otra sala', disponible: true },
    { id: 'sin_origen', label: 'Ya estaba', disponible: true },
  ]

  return (
    <div className="mt-2 rounded-ctl border border-accent/30 bg-sunken p-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">Añadir «{typeName}»</p>
        <button
          type="button"
          onClick={onCancelar}
          className="shrink-0 text-xs text-muted underline-offset-4 hover:underline"
        >
          Cancelar
        </button>
      </div>

      {/* Control segmentado: las tres respuestas se ven a la vez y se compara
          entre ellas. Con un desplegable habría que abrirlo para saber que
          existe la opción de traslado. */}
      <div className="mt-2 flex gap-1 rounded-ctl border border-line bg-surface p-1">
        {MODOS.filter((m) => m.disponible).map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => {
              setTocado(true)
              setModo(m.id)
            }}
            aria-pressed={modo === m.id}
            className={`min-h-11 flex-1 rounded-ctl px-2 text-xs font-semibold ${
              modo === m.id ? 'key key-accent' : 'text-muted'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {modo === 'almacen' && (
        <div className="mt-3">
          {articulos.length === 0 ? (
            unidadesDelTipo.length === 0 && (
              <p className="text-xs text-muted">
                Este tipo de equipo no tiene ningún artículo asociado en el almacén.
              </p>
            )
          ) : (
            <>
              <label className="block text-xs text-muted">
                Artículo del almacén
                <select
                  value={stockItemId}
                  onChange={(e) => setStockItemId(e.target.value)}
                  className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-base text-ink"
                >
                  {articulos.map((a) => {
                    const conSerie = unidadesDelTipo.filter((u) => u.stock_item_id === a.id).length
                    return (
                      <option key={a.id} value={a.id}>
                        {a.name}
                        {a.onHand !== null ? ` · ${a.onHand} en almacén` : ''}
                        {conSerie > 0 ? ` · ${conSerie} con n.º de serie` : ''}
                      </option>
                    )
                  })}
                </select>
              </label>
            </>
          )}

          {hayQueElegir && (
            <ElegirUnidad
              unidades={unidadesOfrecidas}
              elegida={unidadElegida}
              sinNumero={sinNumero}
              conSinNumero={articulos.length > 0 && Boolean(stockItemId)}
              onElegir={(id) => {
                setTocado(true)
                setUnidadElegida(id)
                setSustituye(null)
              }}
            />
          )}

          {unidad?.condicion === 'averiado' && (
            <p className="mt-2 text-xs text-warn">
              Esta unidad está marcada como averiada. Si ya está reparada, cámbiale el estado en Almacén.
            </p>
          )}

          {preguntaSustitucion && (
            <Sustitucion
              mismos={mismosEnSala}
              sustituye={sustituye}
              destino={destinoDelViejo}
              siguiente={conflicto?.siguiente ?? null}
              onSustituye={setSustituye}
              onDestino={setDestinoDelViejo}
            />
          )}

          {articulos.length > 0 && !unidad && !(hayQueElegir && unidadElegida === null) && (
            <>
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-xs text-muted">Unidades</span>
                <span className="inline-flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setUnidades((n) => Math.max(1, n - 1))}
                    className="key key-quiet h-11 w-11"
                    aria-label="Una unidad menos"
                  >
                    −
                  </button>
                  <span className="w-6 text-center font-mono tabular">{unidades}</span>
                  <button
                    type="button"
                    onClick={() => setUnidades((n) => n + 1)}
                    className="key key-quiet h-11 w-11"
                    aria-label="Una unidad más"
                  >
                    +
                  </button>
                </span>
              </div>

              {/*
                El aviso es aviso y no bloqueo. La cifra del espejo puede tener
                horas —otro técnico pudo gastar la última esta mañana— y quien
                está delante del aparato sabe mejor que este número si la caja
                estaba ahí. El servidor tiene la palabra final.
              */}
              {disponibles !== null && unidades > disponibles && (
                <p className="mt-2 text-xs text-warn">
                  Según la última descarga solo quedan {disponibles}. Si no llegan, el descuento se
                  quedará pendiente y lo verás en el chip de sincronización.
                </p>
              )}
            </>
          )}

          {unidad && (
            <p className="mt-2 text-xs text-muted">
              El equipo se apunta en la sala con este número de serie, y el almacén descuenta la
              unidad al sincronizar.
            </p>
          )}
        </div>
      )}

      {modo === 'traslado' && (
        <div className="mt-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-muted">
              Edificio
              <select
                value={buildingId}
                onChange={(e) => setBuildingId(e.target.value)}
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-base text-ink"
              >
                <option value="">Elige…</option>
                {buildings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} — {b.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs text-muted">
              Sala
              <select
                value={origenRoomId}
                onChange={(e) => setOrigenRoomId(e.target.value)}
                disabled={!buildingId}
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-base text-ink disabled:opacity-40"
              >
                <option value="">{buildingId ? 'Elige…' : '—'}</option>
                {salas.map((r) => (
                  <option key={r.id} value={r.id}>
                    {displayRoomCode(r.code)} — {r.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {origenRoomId && (
            <label className="mt-2 block text-xs text-muted">
              Equipo que se trae
              <select
                value={assetId}
                onChange={(e) => setAssetId(e.target.value)}
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-base text-ink"
              >
                <option value="">Elige…</option>
                {equipos.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                    {a.detalle ? ` · ${a.detalle}` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

          {origenRoomId && equipos.length === 0 && (
            <p className="mt-2 text-xs text-muted">Esa sala no tiene equipos registrados.</p>
          )}

          <p className="mt-2 text-xs text-muted">
            El equipo se mueve con su modelo, su número de serie y su histórico, y deja de estar en
            la sala de origen.
          </p>
        </div>
      )}

      {modo === 'sin_origen' && (
        <p className="mt-3 text-xs text-muted">
          {inventariando
            ? 'Esta sala está sin inventariar, así que viene elegido lo más probable: el aparato ya estaba y solo faltaba apuntarlo. Si lo acabas de traer, dilo arriba.'
            : 'Se apunta el equipo sin tocar el almacén. Es lo que toca cuando el aparato ya estaba en la sala y solo faltaba registrarlo.'}
        </p>
      )}

      {/*
        El choque de nombre, ANTES del botón y con las dos salidas escritas.

        Aquí es donde nacían los «Monitor Atril 2» fantasma: la sala ya tenía un
        «Monitor Atril», el alta renombraba en silencio, y el técnico —que casi
        siempre estaba apuntando el MISMO aparato— acababa con un duplicado que
        nadie pidió. Ahora el número no se inventa: se anuncia, y añadir otra
        unidad es una decisión que se toma leyendo esto, no un efecto secundario.
      */}
      {chocaAqui && conflicto && (
        <div className="mt-3 rounded-ctl border border-warn/40 bg-warn-tint p-3">
          <p className="text-xs font-medium text-warn">
            Esta sala ya tiene un «{conflicto.existente.label ?? typeName}»
            {[conflicto.existente.model, conflicto.existente.serial].filter(Boolean).length > 0 &&
              ` (${[conflicto.existente.model, conflicto.existente.serial].filter(Boolean).join(' · ')})`}
            .
          </p>
          <p className="mt-1 text-xs text-warn">
            Si es el mismo aparato, cancela y corrígelo en la lista de equipos. Si de verdad hay
            otro, se añadirá como «{conflicto.siguiente}».
          </p>
        </div>
      )}

      <button
        type="button"
        disabled={!listo}
        onClick={confirmar}
        className="key key-accent mt-3 min-h-touch w-full px-4 text-sm"
      >
        {modo === 'traslado'
          ? 'Trasladar aquí'
          : unidad && sustituye && sustituye !== 'no'
            ? `Instalar ${unidad.serial} y pedir la retirada del otro`
            : unidad
              ? `Instalar ${unidad.serial}`
              : chocaAqui && conflicto
                ? `Sí, añadir otra unidad («${conflicto.siguiente}»)`
                : 'Añadir a la sala'}
      </button>
      {modo === 'almacen' && hayQueElegir && unidadElegida === null && (
        <p className="mt-1 text-center text-xs text-muted">Elige cuál de arriba se instala.</p>
      )}
      {preguntaSustitucion && sustituye === null && (
        <p className="mt-1 text-center text-xs text-muted">Di si sustituye a uno de la sala.</p>
      )}
    </div>
  )
}

/**
 * ¿Sustituye a uno de los que ya están?
 *
 * Solo se pregunta al instalar una unidad concreta en una sala que ya tiene
 * equipos de ese tipo. Si sustituye, el viejo no se quita aquí: se **pide** su
 * retirada, con su destino, igual que desde la lista de equipos —quitar un
 * equipo lo autoriza un supervisor—. Hasta entonces sigue en la sala.
 */
function Sustitucion({
  mismos,
  sustituye,
  destino,
  siguiente,
  onSustituye,
  onDestino,
}: {
  mismos: Array<{ id: string; label: string | null; model: string | null; serial: string | null }>
  sustituye: string | null
  destino: RemovalDestino
  siguiente: string | null
  onSustituye: (v: string) => void
  onDestino: (d: RemovalDestino) => void
}): React.ReactElement {
  const opciones: Array<{ id: string; titulo: string; detalle: string }> = [
    ...mismos.map((a) => ({
      id: a.id,
      titulo: `Sustituye a «${a.label ?? 'equipo'}»`,
      detalle: [a.model, a.serial].filter(Boolean).join(' · ') || 'Sin modelo ni número de serie',
    })),
    {
      id: 'no',
      titulo: 'No, es uno más',
      detalle: siguiente ? `Se añade como «${siguiente}».` : 'Se añade sin tocar los que hay.',
    },
  ]
  return (
    <fieldset role="radiogroup" className="mt-3 rounded-ctl border border-line bg-surface p-2">
      <legend className="px-1 text-xs text-muted">La sala ya tiene de este tipo</legend>
      <div className="space-y-1.5">
        {opciones.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={sustituye === o.id}
            onClick={() => onSustituye(o.id)}
            className={`flex min-h-11 w-full flex-col items-start justify-center rounded-ctl border px-3 py-2 text-left ${
              sustituye === o.id ? 'border-accent bg-accent-tint' : 'border-line bg-raised'
            }`}
          >
            <span className="text-sm">{o.titulo}</span>
            <span className="text-xs text-muted">{o.detalle}</span>
          </button>
        ))}
      </div>
      {sustituye && sustituye !== 'no' && (
        <div className="mt-2">
          <p className="px-1 text-xs text-muted">El que se quita va a…</p>
          <div className="mt-1 flex gap-1 rounded-ctl border border-line bg-raised p-1">
            {(['almacen', 'baja'] as const).map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={destino === d}
                onClick={() => onDestino(d)}
                className={`min-h-11 flex-1 rounded-ctl px-2 text-xs font-semibold ${
                  destino === d ? 'key key-accent' : 'text-muted'
                }`}
              >
                {d === 'almacen' ? 'Vuelve al almacén' : 'Baja definitiva'}
              </button>
            ))}
          </div>
          <p className="mt-1 px-1 text-xs text-muted">
            Se pide su retirada: sigue en la sala hasta que un supervisor la autorice.
          </p>
        </div>
      )}
    </fieldset>
  )
}
