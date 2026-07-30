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
import { flush } from '@/sync/outbox'
import { assetTypeId, nextLabel } from '@/domain/inventory'
import type { Asset, AssetStatus, AssetType } from '@/domain/types'

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

export function useRoomInventory(roomId: string | null, userId: string | null) {
  /**
   * Da de alta un elemento.
   *
   * Si el tipo no está en el catálogo se crea sobre la marcha, sin confirmar. El
   * id sale del nombre normalizado, así que dos técnicos que registren lo mismo
   * sin cobertura acaban en la misma fila en vez de duplicarla.
   */
  const addAsset = useCallback(
    async (typeName: string, existing: AssetType | null): Promise<AddResult> => {
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

      const inRoom = await db.assets.where('room_id').equals(roomId).toArray()
      const label = nextLabel(inRoom, type.name)

      const asset: Asset = {
        id: uuidv7(),
        asset_type_id: type.id,
        room_id: roomId,
        label,
        serial: null,
        model: null,
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
    async (typeName: string, existing: AssetType | null, origen: Origen): Promise<AddResult> => {
      if (origen.tipo === 'traslado') {
        return trasladarAsset(origen.assetId, roomId, userId)
      }

      const unidades = origen.tipo === 'almacen' ? Math.max(1, origen.unidades) : 1

      // Varias unidades son varios equipos: dos altavoces en un aula son dos
      // filas con dos etiquetas, porque uno se puede averiar sin el otro.
      let ultimo: AddResult = { ok: false, error: 'No se pudo añadir.' }
      for (let i = 0; i < unidades; i++) {
        ultimo = await addAsset(typeName, existing)
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

  /**
   * Guarda un cambio del elemento en local y lo encola.
   *
   * Relee el elemento de Dexie en vez de fiarse del objeto que le pasan. Ese
   * objeto viene capturado del render, y bastaba con escribir el modelo y pulsar
   * «Averiado» seguido para que la segunda escritura, con el elemento de antes
   * en la mano, mandara `model: null` y borrara lo recién escrito. El técnico lo
   * veía en pantalla —el campo conservaba el texto— y el dato ya no estaba.
   */
  const patchAsset = useCallback(async (asset: Asset, patch: Partial<Asset>): Promise<void> => {
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
      status: next.status,
    })
    void flush()
  }, [])

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

  return { addAsset, addAssetConOrigen, confirmarInventario, patchAsset, setStatus }
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
 */
async function trasladarAsset(
  assetId: string,
  destinoRoomId: string | null,
  userId: string | null,
): Promise<AddResult> {
  if (!destinoRoomId) return { ok: false, error: 'Sin sala.' }

  const asset = await db.assets.get(assetId)
  if (!asset) return { ok: false, error: 'Ese equipo ya no está.' }
  if (asset.room_id === destinoRoomId) return { ok: false, error: 'Ya está en esta sala.' }

  const origen = asset.room_id
  const type = await db.assetTypes.get(asset.asset_type_id)
  const enDestino = await db.assets.where('room_id').equals(destinoRoomId).toArray()
  const label = nextLabel(enDestino, type?.name ?? asset.label ?? 'Equipo')

  const movido: Asset = { ...asset, room_id: destinoRoomId, label }
  await db.assets.put(movido)
  await enqueue('asset', movido.id, {
    id: movido.id,
    asset_type_id: movido.asset_type_id,
    room_id: movido.room_id,
    label: movido.label,
    serial: movido.serial,
    model: movido.model,
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
    occurred_at: new Date().toISOString(),
    by_user: userId,
    meta: { desde_room_id: origen, nota: 'Trasladado desde otra sala' },
  })
  void flush()

  return { ok: true, label }
}
