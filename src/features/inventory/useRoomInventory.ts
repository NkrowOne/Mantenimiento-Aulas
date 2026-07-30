/**
 * Altas y correcciones de inventario desde el aula.
 *
 * Todo escribe primero en Dexie y luego encola: el técnico ve el elemento en su
 * lista al instante y sin cobertura, que es la única forma de que llegue a
 * apuntarlo. Lo que se apunta cuando hay wifi no se apunta.
 */

import { useCallback } from 'react'
import { v7 as uuidv7 } from 'uuid'
import { db, enqueue } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { flush } from '@/sync/outbox'
import { assetModelId, assetTypeId, nextLabel } from '@/domain/inventory'
import type {
  Asset,
  AssetModel,
  AssetRemoval,
  AssetStatus,
  AssetType,
  RemovalDestino,
} from '@/domain/types'

export interface AddResult {
  ok: boolean
  label?: string
  error?: string
}

/**
 * De dónde sale el equipo que se está dando de alta.
 *
 * Era la pregunta que nadie hacía, y por eso el almacén y las aulas eran dos
 * mundos: se instalaban proyectores que no salían de ningún sitio y el saldo
 * del almacén no se movía. Tres respuestas posibles y las tres son verdad
 * alguna vez:
 *
 *  - `almacen`: se ha cogido una caja del almacén. Descuenta unidades.
 *  - `traslado`: estaba en otra aula y se ha movido. No toca el almacén —el
 *    equipo ya era del centro— pero sí desaparece de la sala de origen.
 *  - `sin_origen`: ya estaba aquí y solo faltaba apuntarlo. Es el caso del
 *    inventario que se está poniendo al día, y no mueve nada más.
 */
export type Origen =
  | { tipo: 'sin_origen' }
  | { tipo: 'almacen'; stockItemId: string; unidades: number }
  | { tipo: 'traslado'; assetId: string; desdeRoomId: string }

/**
 * El modelo que se le pone al equipo: uno del catálogo, o uno nuevo.
 *
 * El segundo caso existe por lo mismo que existe crear tipos desde el aula: el
 * técnico está delante de un proyector cuyo modelo no está en la lista, y si
 * para apuntarlo tiene que esperar a que alguien lo dé de alta, no lo apunta.
 */
export type ModeloElegido = { id: string } | { brand: string; model: string }

/** Todo lo que se decide al añadir un equipo, en un solo objeto. */
export interface AltaDeEquipo {
  origen: Origen
  /** null = no consta el modelo. Es una respuesta legítima y frecuente. */
  modelo: ModeloElegido | null
  /**
   * Desde cuándo está puesto.
   *
   * Por defecto, ahora. Se puede cambiar porque durante un levantamiento la
   * respuesta correcta casi nunca es hoy: el aparato lleva años ahí y quien está
   * delante lo sabe. Fecharlo hoy convertiría el inventario en una foto de
   * cuándo se apuntó, que no es la pregunta que nadie hace.
   */
  instaladoEl: string
  /** Solo tiene sentido cuando se añade UNA unidad. */
  serial?: string | null
}

/**
 * Deja el modelo en el espejo local y lo encola si es nuevo. Devuelve su id.
 *
 * El id sale de (tipo, marca, modelo), así que dos técnicos sin cobertura que
 * registren el mismo «Epson EB-992F» generan la misma fila y al sincronizar
 * convergen. Es la misma defensa que ya tenían los tipos, y la razón por la que
 * el catálogo no se llena de duplicados por diseño.
 */
export async function asegurarModelo(
  typeId: string,
  brand: string,
  model: string,
  userId: string | null,
): Promise<string | null> {
  const marca = brand.trim()
  const nombre = model.trim()
  if (!nombre) return null

  const id = assetModelId(typeId, marca, nombre)
  const existente = await db.assetModels.get(id)
  if (existente) return id

  const nuevo: AssetModel = {
    id,
    asset_type_id: typeId,
    brand: marca,
    model: nombre,
    aliases: [],
    specs: {},
    notes: null,
    eol_on: null,
    // Lo apunta quien está en el aula, así que nace sin validar y sale marcado
    // hasta que un coordinador lo mire. Se usa igual mientras tanto.
    confirmed: false,
    active: true,
    merged_into: null,
    created_at: new Date().toISOString(),
  }

  await db.assetModels.put(nuevo)
  // `confirmed` y `active` no se envían: en el servidor los defectos ya son los
  // correctos, y omitirlos garantiza que un alta reenviada no pueda devolver a
  // naranja un modelo que el coordinador ya validó.
  await enqueue('asset_model', id, {
    id,
    asset_type_id: typeId,
    brand: marca,
    model: nombre,
    created_by: userId,
  })
  return id
}

/**
 * Guarda un cambio del elemento en local y lo encola.
 *
 * Relee el elemento de Dexie en vez de fiarse del objeto que le pasan. Ese
 * objeto viene capturado del render, y bastaba con escribir el modelo y pulsar
 * «Averiado» seguido para que la segunda escritura, con el elemento de antes
 * en la mano, mandara `model: null` y borrara lo recién escrito. El técnico lo
 * veía en pantalla —el campo conservaba el texto— y el dato ya no estaba.
 *
 * Está fuera del hook y no dentro porque la gestión desde el ordenador escribe
 * exactamente igual —en local y por la cola— y no tiene ninguna sala. Duplicar
 * la lista de columnas del envío en dos sitios es la forma más segura de que
 * una de las dos se quede sin un campo y el dato se pierda en silencio.
 */
export async function guardarAsset(asset: Asset, patch: Partial<Asset>): Promise<void> {
  const actual = (await db.assets.get(asset.id)) ?? asset
  const next = { ...actual, ...patch }
  await db.assets.put(next)
  await enqueue('asset', next.id, {
    id: next.id,
    asset_type_id: next.asset_type_id,
    room_id: next.room_id,
    label: next.label,
    serial: next.serial,
    model: next.model,
    asset_model_id: next.asset_model_id,
    installed_at: next.installed_at,
    warranty_until: next.warranty_until,
    specs: next.specs,
    notes: next.notes,
    status: next.status,
  })
  void flush()
}

/**
 * Le pone modelo a un equipo, creándolo si hace falta.
 *
 * Funciona sin cobertura, que es lo que la separa de la RPC `set_asset_model`
 * del servidor: aquí se escribe en el espejo y se encola, así que asignar el
 * modelo de veinte ordenadores en un aula sin línea es una operación normal.
 */
export async function asignarModelo(
  asset: Asset,
  modelo: ModeloElegido | null,
  userId: string | null,
): Promise<void> {
  const id =
    modelo === null
      ? null
      : 'id' in modelo
        ? modelo.id
        : await asegurarModelo(asset.asset_type_id, modelo.brand, modelo.model, userId)
  await guardarAsset(asset, { asset_model_id: id })
}

export function useRoomInventory(roomId: string | null, userId: string | null) {
  /**
   * Da de alta un elemento.
   *
   * Si el tipo no está en el catálogo se crea sobre la marcha, sin confirmar. El
   * id sale del nombre normalizado, así que dos técnicos que registren lo mismo
   * sin cobertura acaban en la misma fila en vez de duplicarla. Con el modelo
   * pasa exactamente igual.
   */
  const addAsset = useCallback(
    async (
      typeName: string,
      existing: AssetType | null,
      alta?: Pick<AltaDeEquipo, 'modelo' | 'instaladoEl' | 'serial'>,
    ): Promise<AddResult> => {
      if (!roomId) return { ok: false, error: 'Sin sala.' }

      const name = typeName.trim()
      if (name.length < 2) return { ok: false, error: 'Escribe al menos dos letras.' }

      let type = existing
      if (!type) {
        const id = assetTypeId(name)
        // Puede existir ya en local aunque el buscador no lo encontrara: el
        // técnico escribió el nombre completo de algo que sí está.
        type = (await db.assetTypes.get(id)) ?? null

        if (!type) {
          type = {
            id,
            name,
            category: 'av',
            tracks_serial: true,
            tracks_lamp_hours: false,
            confirmed: false,
            aliases: [],
            merged_into: null,
            active: true,
            spec_fields: [],
          }
          await db.assetTypes.put(type)
          // `confirmed` no se envía: en el servidor el defecto ya es "sin
          // confirmar", y omitirlo garantiza que un alta repetida no pueda
          // devolver a naranja un tipo que el coordinador ya validó.
          await enqueue('asset_type', type.id, {
            id: type.id,
            name: type.name,
            category: type.category,
            tracks_serial: type.tracks_serial,
            tracks_lamp_hours: type.tracks_lamp_hours,
          })
        }
      }

      const modelo = alta?.modelo ?? null
      const modelId =
        modelo === null
          ? null
          : 'id' in modelo
            ? modelo.id
            : await asegurarModelo(type.id, modelo.brand, modelo.model, userId)

      const inRoom = await db.assets.where('room_id').equals(roomId).toArray()
      const label = nextLabel(inRoom, type.name)
      const instaladoEl = alta?.instaladoEl ?? new Date().toISOString()

      const asset: Asset = {
        id: uuidv7(),
        asset_type_id: type.id,
        room_id: roomId,
        label,
        serial: alta?.serial?.trim() || null,
        model: null,
        asset_model_id: modelId,
        installed_at: instaladoEl,
        warranty_until: null,
        specs: {},
        notes: null,
        status: 'instalado',
        created_at: new Date().toISOString(),
        // Lo apunta quien está en el aula, así que nace sin validar. Igual que
        // con `confirmed` de los tipos, no se envía al servidor: allí el defecto
        // ya es ese, y omitirlo garantiza que un alta reenviada no pueda
        // devolver a la bandeja un equipo que el coordinador ya confirmó.
        confirmed: false,
      }

      await db.assets.put(asset)
      await enqueue('asset', asset.id, {
        id: asset.id,
        asset_type_id: asset.asset_type_id,
        room_id: asset.room_id,
        label: asset.label,
        serial: asset.serial,
        asset_model_id: asset.asset_model_id,
        // Va explícita y no se deja al disparador: el reloj bueno es el de este
        // aparato, y una subida que llega mañana no puede fecharse mañana.
        installed_at: asset.installed_at,
        status: asset.status,
        created_by: userId,
      })
      void flush()

      return { ok: true, label }
    },
    [roomId, userId],
  )

  /**
   * Alta con origen: la de arriba, más lo que el origen implique.
   *
   * Todo pasa por la cola de salida y en este orden: primero el equipo, después
   * el movimiento de almacén. Si se sincroniza a medias —cobertura que va y
   * viene— lo que queda es un equipo dado de alta sin descontar, que es un
   * descuadre de una unidad y se ve; al revés quedaría una unidad descontada sin
   * equipo, que no se ve en ningún sitio.
   *
   * El descuento no se comprueba aquí contra las existencias del espejo: esa
   * cifra puede tener horas y el servidor tiene la buena. Si no llegan, el
   * movimiento se queda rechazado en la cola y el técnico lo ve en el chip de
   * sincronización — con el equipo ya apuntado, que es lo que no se puede
   * perder.
   */
  const addAssetConOrigen = useCallback(
    async (typeName: string, existing: AssetType | null, alta: AltaDeEquipo): Promise<AddResult> => {
      const { origen } = alta

      if (origen.tipo === 'traslado') {
        return trasladarAsset(origen.assetId, roomId, userId, alta)
      }

      const unidades = origen.tipo === 'almacen' ? Math.max(1, origen.unidades) : 1

      // Varias unidades son varios equipos: dos altavoces en un aula son dos
      // filas con dos etiquetas, porque uno se puede averiar sin el otro. El
      // número de serie solo viaja con la primera: dos aparatos no lo comparten,
      // y el índice único de la base lo rechazaría con razón.
      let ultimo: AddResult = { ok: false, error: 'No se pudo añadir.' }
      for (let i = 0; i < unidades; i++) {
        ultimo = await addAsset(typeName, existing, {
          modelo: alta.modelo,
          instaladoEl: alta.instaladoEl,
          serial: i === 0 ? alta.serial : null,
        })
        if (!ultimo.ok) return ultimo
      }

      if (origen.tipo === 'almacen' && roomId) {
        const id = uuidv7()
        await enqueue('stock_movement', id, {
          id,
          stock_item_id: origen.stockItemId,
          qty: -unidades,
          kind: 'consumo',
          room_id: roomId,
          occurred_at: new Date().toISOString(),
          by_user: userId,
        })
        void flush()
      }

      return ultimo
    },
    [addAsset, roomId, userId],
  )

  const patchAsset = useCallback(
    (asset: Asset, patch: Partial<Asset>): Promise<void> => guardarAsset(asset, patch),
    [],
  )

  /** Elegir o crear el modelo de un equipo que ya está dado de alta. */
  const setModelo = useCallback(
    (asset: Asset, modelo: ModeloElegido | null): Promise<void> =>
      asignarModelo(asset, modelo, userId),
    [userId],
  )

  const setStatus = useCallback(
    async (asset: Asset, status: AssetStatus): Promise<void> => {
      // Volver a pulsar el mismo estado lo deshace: es un interruptor, no una
      // acción irreversible que obligue a buscar cómo revertirla.
      const actual = (await db.assets.get(asset.id)) ?? asset
      await patchAsset(actual, { status: actual.status === status ? 'instalado' : status })
    },
    [patchAsset],
  )

  /**
   * Pedir que un equipo salga de la sala.
   *
   * Antes esto era un botón que retiraba el aparato en el acto. Un toque, y el
   * inventario perdía una fila sin que nadie pudiera decir que no y sin que el
   * almacén se enterara de que un proyector perfectamente bueno acababa de
   * volver a la estantería.
   *
   * Ahora es una **solicitud**: el equipo se queda donde está —marcado, que es
   * la verdad: todavía está ahí— hasta que un coordinador la autoriza. Y con el
   * destino delante, porque «se ha roto» y «me lo llevo al almacén» son dos
   * cosas distintas y solo la segunda suma una unidad a las existencias.
   *
   * Se firma en el aula y sin cobertura, como todo lo demás: es justo donde se
   * ve que un aparato sobra.
   */
  const solicitarRetirada = useCallback(
    async (asset: Asset, destino: RemovalDestino, motivo?: string): Promise<AddResult> => {
      const yaHay = await db.assetRemovals
        .where('asset_id')
        .equals(asset.id)
        .filter((r) => r.state === 'pendiente')
        .first()
      if (yaHay) return { ok: false, error: 'Ya hay una retirada pedida para este equipo.' }

      const solicitud: AssetRemoval = {
        id: uuidv7(),
        asset_id: asset.id,
        room_id: asset.room_id,
        destino,
        reason: motivo?.trim() || null,
        state: 'pendiente',
        requested_at: new Date().toISOString(),
        requested_by: userId,
      }

      await db.assetRemovals.put(solicitud)
      await enqueue('asset_removal', solicitud.id, solicitud)
      void flush()

      return { ok: true }
    },
    [userId],
  )

  /** Deshacerla mientras nadie la haya decidido. Equivocarse al pulsar no puede
      costar una visita al coordinador. */
  const cancelarRetirada = useCallback(async (solicitudId: string): Promise<void> => {
    await db.assetRemovals.delete(solicitudId)
    // Si todavía estaba esperando a subir, se va con ella y no llega a existir.
    await db.outbox.delete(solicitudId)
    const { error } = await supabase.from('asset_removals').delete().eq('id', solicitudId)
    // Sin cobertura el borrado remoto falla y no pasa nada: o la solicitud nunca
    // subió —y acaba de morir en la cola— o subió y el coordinador la verá. Es
    // preferible a bloquear el gesto esperando a la red.
    if (error) console.warn('cancelarRetirada', error.message)
  }, [])

  /**
   * «He mirado el aula y esto es todo lo que hay.»
   *
   * Es lo que saca a una sala de la lista de pendientes, y por eso tiene que
   * ser un acto explícito y no un efecto secundario de añadir un equipo: se
   * puede añadir un proyector y seguir sin saber si falta algo más.
   *
   * Se guarda como una fila nueva y no como una fecha que se pisa. Un
   * levantamiento se repite —el recuento del curso siguiente es el mismo acto
   * otra vez— y así queda la serie entera, con quién y cuándo.
   *
   * El espejo local se actualiza a mano porque `rooms` viene de una vista que
   * solo se refresca al sincronizar: sin esto, el técnico confirma y la sala
   * sigue diciendo «sin inventariar» hasta la siguiente descarga.
   */
  const confirmarInventario = useCallback(
    async (assetCount: number, note?: string): Promise<AddResult> => {
      if (!roomId) return { ok: false, error: 'Sin sala.' }

      const cuando = new Date().toISOString()
      const id = uuidv7()
      await enqueue('room_inventory', id, {
        id,
        room_id: roomId,
        by_user: userId,
        occurred_at: cuando,
        asset_count: assetCount,
        note: note?.trim() || null,
      })

      const room = await db.rooms.get(roomId)
      if (room) await db.rooms.put({ ...room, last_inventory_at: cuando })

      void flush()
      return { ok: true }
    },
    [roomId, userId],
  )

  return {
    addAsset,
    addAssetConOrigen,
    cancelarRetirada,
    confirmarInventario,
    patchAsset,
    setModelo,
    setStatus,
    solicitarRetirada,
  }
}

/**
 * Mover un equipo de una sala a otra.
 *
 * No es un alta seguida de una baja: es la MISMA fila que cambia de sitio, y
 * eso importa porque el número de serie, el modelo y su histórico de averías
 * viajan con el aparato. Dar de baja y volver a crear rompería justo eso, que
 * es lo único que un inventario aporta sobre una lista.
 *
 * La etiqueta se recalcula en el destino: llegar como «Pantalla 2» a una sala
 * donde ya hay una «Pantalla 2» chocaría contra el índice único de la base, y
 * el traslado se quedaría rechazado en la cola sin que nadie entendiera por qué.
 *
 * Y la fecha de instalación se renueva: el proyector lleva en ESTA aula desde
 * hoy, aunque llevara seis años en la de al lado. La instalación anterior no se
 * pierde — está en el histórico, que es su sitio.
 */
async function trasladarAsset(
  assetId: string,
  destinoRoomId: string | null,
  userId: string | null,
  alta?: Pick<AltaDeEquipo, 'instaladoEl'>,
): Promise<AddResult> {
  if (!destinoRoomId) return { ok: false, error: 'Sin sala.' }

  const asset = await db.assets.get(assetId)
  if (!asset) return { ok: false, error: 'Ese equipo ya no está.' }
  if (asset.room_id === destinoRoomId) return { ok: false, error: 'Ya está en esta sala.' }

  const origen = asset.room_id
  const type = await db.assetTypes.get(asset.asset_type_id)
  const enDestino = await db.assets.where('room_id').equals(destinoRoomId).toArray()
  const label = nextLabel(enDestino, type?.name ?? asset.label ?? 'Equipo')
  const cuando = alta?.instaladoEl ?? new Date().toISOString()

  const movido: Asset = {
    ...asset,
    room_id: destinoRoomId,
    label,
    installed_at: cuando,
  }
  await db.assets.put(movido)
  await enqueue('asset', movido.id, {
    id: movido.id,
    asset_type_id: movido.asset_type_id,
    room_id: movido.room_id,
    label: movido.label,
    serial: movido.serial,
    model: movido.model,
    asset_model_id: movido.asset_model_id,
    installed_at: movido.installed_at,
    status: movido.status,
  })

  // El evento es lo que deja rastro del traslado en el histórico de las dos
  // salas: sin él, el equipo simplemente desaparecería de una y aparecería en
  // otra sin que nada dijera cuándo ni quién.
  const eventoId = uuidv7()
  await enqueue('asset_event', eventoId, {
    id: eventoId,
    asset_id: movido.id,
    room_id: destinoRoomId,
    kind: 'traslado',
    occurred_at: cuando,
    by_user: userId,
    meta: { desde_room_id: origen, nota: 'Trasladado desde otra sala' },
  })
  void flush()

  return { ok: true, label }
}
