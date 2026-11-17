/**
 * Leer el historial de una sala o de un edificio, para exportarlo.
 *
 * Qué hojas salen y qué dice cada fila lo decide `domain/historialExportado.ts`;
 * aquí solo se trae lo que hace falta, que son tres cosas:
 *
 *  - la línea de tiempo (`room_timeline`), que es lo mismo que enseña la ficha;
 *  - las incidencias de esas salas, con lo que la línea de tiempo no trae: la
 *    solución, el ticket de EasyVista, la gravedad;
 *  - de qué incidencia es cada movimiento de almacén, que es lo que permite
 *    decir «en esta avería se gastaron dos cables».
 *
 * **Entero, o nada.** Las tres lecturas van por páginas hasta la última
 * (`descargaEntera`), y si una se queda a medias no se exporta: un historial al
 * que le faltan los tres últimos meses sin decirlo es peor que ninguno, porque
 * quien lo lee no tiene cómo saberlo.
 *
 * Necesita conexión, como el historial de la ficha: el histórico completo no
 * está en el espejo local.
 */

import { db } from '@/db/dexie'
import { displayRoomCode } from '@/domain/normalize'
import {
  hojasDelHistorial,
  resumenDelHistorial,
  type DatosDelHistorial,
  type EventoDelHistorial,
  type IncidenciaDelHistorial,
} from '@/domain/historialExportado'
import type { Exportacion } from '@/domain/vistaPrevia'
import { esSilencio, señalConTope, TOPE_CONSULTA_MS } from '@/features/reports/informe/espera'
import { supabase } from '@/lib/supabase'
import { descargaEntera, type Descarga } from '@/sync/paginada'

/** De qué se exporta el historial. */
export type AlcanceDelHistorial =
  | { de: 'sala'; roomId: string; codigo: string; nombre: string; edificio: string }
  | { de: 'edificio'; buildingId: string; codigo: string; nombre: string }

const plazo = (): AbortSignal => señalConTope(TOPE_CONSULTA_MS)

/**
 * Cuántos identificadores van en un `in.(…)`. Un edificio grande son cuarenta
 * salas, y cuarenta uuid caben de sobra en una dirección; se trocea igualmente
 * para que el día que haya uno de ciento veinte no se quede en un 414.
 */
const POR_TROZO = 60

function trozos<T>(lista: T[], tam: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < lista.length; i += tam) out.push(lista.slice(i, i + tam))
  return out
}

/** Lo leído, o el motivo —dicho con palabras— por el que no se exporta. */
function exigir<T>(que: string, d: Descarga<T>): T[] {
  if (d.error) {
    throw new Error(
      esSilencio(new Error(d.error.message))
        ? `No se pudo leer ${que}: el servidor no ha contestado a tiempo. Comprueba la conexión y vuelve a intentarlo.`
        : `No se pudo leer ${que}: ${d.error.message}`,
    )
  }
  if (!d.completa) {
    throw new Error(`La descarga de ${que} vino incompleta. Vuelve a intentarlo.`)
  }
  return d.data ?? []
}

const CAMPOS_DE_INCIDENCIA =
  'id, room_id, kind, state, severity, title, description, opened_at, opened_by, resolved_at, resolved_by, resolution, external_ref, easyvista_ref'

export async function cargarHistorial(alcance: AlcanceDelHistorial): Promise<DatosDelHistorial> {
  // Las salas del alcance salen del espejo: son las que hay descargadas, y es
  // lo que evita un viaje más al servidor solo para saber sus códigos.
  let salas: Record<string, string>
  if (alcance.de === 'sala') {
    salas = { [alcance.roomId]: alcance.codigo }
  } else {
    const zonas = await db.zones.where('building_id').equals(alcance.buildingId).toArray()
    const delEdificio = await db.rooms
      .where('zone_id')
      .anyOf(zonas.map((z) => z.id))
      .toArray()
    salas = Object.fromEntries(delEdificio.map((r) => [r.id, r.code]))
  }
  const ids = Object.keys(salas)

  const eventosD = descargaEntera<EventoDelHistorial>((d, h) => {
    const q = supabase.from('room_timeline').select('*')
    return (alcance.de === 'sala' ? q.eq('room_id', alcance.roomId) : q.eq('building_id', alcance.buildingId))
      // Tres claves para que el orden sea estable entre páginas: la apertura y
      // el cierre de una incidencia comparten `ref_id`, y dos movimientos del
      // mismo cierre comparten instante.
      .order('at')
      .order('ref_id')
      .order('kind')
      .range(d, h)
      .abortSignal(plazo())
  })

  const incidenciasD = Promise.all(
    trozos(ids, POR_TROZO).map((trozo) =>
      descargaEntera<IncidenciaDelHistorial>((d, h) =>
        supabase
          .from('incidents')
          .select(CAMPOS_DE_INCIDENCIA)
          .in('room_id', trozo)
          .order('id')
          .range(d, h)
          .abortSignal(plazo()),
      ),
    ),
  )

  const movimientosD = Promise.all(
    trozos(ids, POR_TROZO).map((trozo) =>
      descargaEntera<{ id: string; incident_id: string | null }>((d, h) =>
        supabase
          .from('stock_movements')
          .select('id, incident_id')
          .in('room_id', trozo)
          .not('incident_id', 'is', null)
          .order('id')
          .range(d, h)
          .abortSignal(plazo()),
      ),
    ),
  )

  const [eventos, incidencias, movimientos] = await Promise.all([eventosD, incidenciasD, movimientosD])

  const incidenciaDeMovimiento: Record<string, string> = {}
  for (const d of movimientos) {
    for (const m of exigir('el material de las incidencias', d)) {
      if (m.incident_id) incidenciaDeMovimiento[m.id] = m.incident_id
    }
  }

  return {
    eventos: exigir('el historial', eventos),
    incidencias: incidencias.flatMap((d) => exigir('las incidencias', d)),
    incidenciaDeMovimiento,
    salas,
    deEdificio: alcance.de === 'edificio',
  }
}

/** Lo que la vista previa enseña, y de lo que salen el Excel y el PDF. */
export async function exportacionDelHistorial(alcance: AlcanceDelHistorial): Promise<Exportacion> {
  const datos = await cargarHistorial(alcance)
  const de =
    alcance.de === 'sala'
      ? `${alcance.edificio} ${displayRoomCode(alcance.codigo)}`
      : `Edificio ${alcance.codigo}`
  const nombre =
    alcance.de === 'sala'
      ? `${de}${alcance.nombre && alcance.nombre !== alcance.codigo ? ` — ${alcance.nombre}` : ''}`
      : `${alcance.codigo} — ${alcance.nombre}`
  return {
    titulo: `Historial de intervenciones · ${nombre}`,
    resumen: resumenDelHistorial(datos),
    nombreBase: `Historial ${de}`,
    hojas: hojasDelHistorial(datos),
  }
}
