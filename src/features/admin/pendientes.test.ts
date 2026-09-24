/**
 * A qué sección se atribuye cada recuento pendiente.
 *
 * Los edificios sin identificar se resuelven fusionando o confirmando datos
 * del importador —la misma familia que la cuarentena—, y desde que
 * `<EdificiosSinIdentificar />` vive en la sección Importación su recuento
 * tiene que ir con él. Un descuido aquí deja la insignia de una sección en
 * cero mintiendo, o cuenta el mismo edificio dos veces en el total.
 */
import { describe, expect, it } from 'vitest'
import { porSeccion, totalPendientes, type PendientesDeDatos } from './pendientes'

const BASE: PendientesDeDatos = {
  retiradas: 0,
  equiposSinValidar: 0,
  tiposSinValidar: 0,
  duplicados: 0,
  edificiosSinIdentificar: 0,
  incidenciasSinSala: 0,
  cuarentena: 0,
  cuarentenaSinSala: 0,
  ultimaSincronizacion: null,
}

describe('porSeccion', () => {
  it('cuenta los edificios sin identificar en importación, no en el maestro', () => {
    const s = porSeccion({ ...BASE, edificiosSinIdentificar: 6 })
    expect(s.importacion).toBe(6)
    expect(s.maestro).toBe(0)
  })

  it('el maestro no tiene hoy ningún recuento propio', () => {
    // Con todo lo demás también a cero: si algún día se le añade un recuento
    // propio, este `0` deja de sostenerse y esta prueba avisa del cambio.
    const s = porSeccion({ ...BASE, retiradas: 3, incidenciasSinSala: 2, cuarentena: 5 })
    expect(s.maestro).toBe(0)
  })

  it('el total no cambia por la mudanza: sigue sumando cada cosa una sola vez', () => {
    const p: PendientesDeDatos = {
      ...BASE,
      retiradas: 4,
      edificiosSinIdentificar: 6,
      incidenciasSinSala: 3,
      cuarentena: 10,
      // De esas 10, 3 son justo las de «sin sala»: no se cuentan dos veces.
      cuarentenaSinSala: 3,
    }
    const s = porSeccion(p)
    expect(s.importacion).toBe(6 + 3 + (10 - 3))
    expect(totalPendientes(p)).toBe(s.pendientes + s.maestro + s.importacion)
    expect(totalPendientes(p)).toBe(4 + 6 + 3 + (10 - 3))
  })
})
