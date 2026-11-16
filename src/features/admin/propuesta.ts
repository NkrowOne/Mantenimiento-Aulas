/**
 * Qué sala proponer para una incidencia que llegó sin ella.
 *
 * En «Incidencias sin sala» cada grupo pedía elegir edificio y sala a mano
 * aunque el texto del Excel lo dijera con todas las letras: «1.7 H» es la 1.7
 * del edificio H, y aun así eran dos desplegables y cuarenta salas que leer.
 *
 * Esto lee ese texto y propone. Y propone poco, a propósito:
 *
 *  - Solo con el edificio escrito y EXACTO. Los códigos de aula de este campus
 *    son genéricos —«1.1», «2.3», «-1.2» están en casi todos los edificios—, así
 *    que una sala sin edificio no identifica nada. `normalize.ts` cuenta la
 *    lección: rellenar un edificio a ojo cuelga treinta partes del que no era.
 *  - La sala, solo si el código casa entero con UNA. «1.7» no es «11.7» ni
 *    «1.70», y si hay dos que casan no se elige ninguna.
 *  - Si el edificio existe pero la sala no, se propone solo el edificio: ya es
 *    un desplegable menos, y no se inventa nada.
 *
 * Es una propuesta y no una asignación: la pantalla la enseña como tal y quien
 * decide sigue teniendo que pulsar «Asignar».
 */

import {
  OLD_BUILDING_CODES,
  norm,
  splitIncidentKey,
  stripParenthetical,
} from '@/domain/normalize'

export interface SalaDelMaestro {
  id: string
  buildingId: string
  /** El código de la sala: `1.7`, `-1.3`. */
  codigo: string
}

export interface EdificioDelMaestro {
  id: string
  /** El código del edificio: `H`, `CRAI`. */
  code: string
}

export interface Propuesta {
  buildingId: string
  /** Vacío si el edificio se reconoce pero la sala no. */
  roomId: string
}

export function proponerSala(
  aula: string | null,
  salas: readonly SalaDelMaestro[],
  edificios: readonly EdificioDelMaestro[],
): Propuesta | null {
  if (!aula) return null

  // «5.4 (LAB 3D) H» → «5.4 H»: el nombre entre paréntesis no es del código.
  const limpio = stripParenthetical(aula)

  // Las dos formas de escribirlo: «1.7 H», como el histórico, y «H 1.7».
  const partes =
    splitIncidentKey(limpio) ??
    (() => {
      const m = norm(limpio).match(/^([A-ZÑ]{1,4})\s+(\S.*)$/)
      return m?.[1] && m[2] ? { buildingCode: m[1], roomCode: m[2].trim() } : null
    })()
  if (!partes) return null

  // Un código de la nomenclatura de antes vale solo si alguien que sabe la
  // respuesta lo ha apuntado en `OLD_BUILDING_CODES`. Hoy está vacío.
  const codigoDeHoy = OLD_BUILDING_CODES[partes.buildingCode] ?? partes.buildingCode
  const edificio = edificios.find((b) => norm(b.code) === codigoDeHoy)
  if (!edificio) return null

  const queCasan = salas.filter(
    (s) => s.buildingId === edificio.id && norm(s.codigo) === partes.roomCode,
  )
  return { buildingId: edificio.id, roomId: queCasan.length === 1 ? queCasan[0]!.id : '' }
}
