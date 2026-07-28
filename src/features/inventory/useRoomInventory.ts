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

  /** Guarda un cambio del elemento en local y lo encola. */
  const patchAsset = useCallback(async (asset: Asset, patch: Partial<Asset>): Promise<void> => {
    const next = { ...asset, ...patch }
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
      await patchAsset(asset, { status: asset.status === status ? 'instalado' : status })
    },
    [patchAsset],
  )

  return { addAsset, patchAsset, setStatus }
}
