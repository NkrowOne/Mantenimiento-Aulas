import { describe, expect, it } from 'vitest'
import { matrizQR } from './qr'

/**
 * Estas pruebas existen por un motivo concreto y no por rutina.
 *
 * El prototipo llevaba una «marca grabada» que se parecía a un QR —tres esquinas
 * dibujadas y relleno pseudoaleatorio— con un comentario admitiendo que no
 * pretendía ser legible. Sobre una maqueta, correcto. Impreso y atornillado a
 * una puerta, es una pegatina que no escanea nadie y que nadie descubre hasta
 * que va con el móvil delante del aula.
 *
 * Así que lo que se comprueba aquí es lo que distingue un QR de un dibujo: que
 * tiene los tres patrones de localización donde manda la norma, que el margen de
 * silencio existe, y que codifica lo que se le dio.
 */

const UUID = '0198f2c1-3a4b-7c5d-8e6f-a47b91c2d3e4'

/** ¿Hay patrón de localización en esa esquina? Anillo 7×7 con centro 3×3. */
function esLocalizador(
  esOscuro: (f: number, c: number) => boolean,
  filaBase: number,
  colBase: number,
): boolean {
  for (let f = 0; f < 7; f++) {
    for (let c = 0; c < 7; c++) {
      const borde = f === 0 || f === 6 || c === 0 || c === 6
      const centro = f >= 2 && f <= 4 && c >= 2 && c <= 4
      const deberia = borde || centro
      if (esOscuro(filaBase + f, colBase + c) !== deberia) return false
    }
  }
  return true
}

describe('matrizQR', () => {
  it('un UUID entra en la versión 3 (29×29)', () => {
    const m = matrizQR(UUID)
    expect(m.modulos).toBe(29)
  })

  it('tiene los tres patrones de localización de la norma', () => {
    const { esOscuro, modulos } = matrizQR(UUID)
    // Arriba-izquierda, arriba-derecha y abajo-izquierda. La cuarta esquina NO
    // lleva: es justamente lo que le dice al lector cómo está orientado el
    // código, y es lo que el patrón decorativo del prototipo sí imitaba.
    expect(esLocalizador(esOscuro, 0, 0)).toBe(true)
    expect(esLocalizador(esOscuro, 0, modulos - 7)).toBe(true)
    expect(esLocalizador(esOscuro, modulos - 7, 0)).toBe(true)
  })

  it('deja el margen de silencio de 4 módulos que pide la norma', () => {
    const m = matrizQR(UUID)
    // Sin margen, muchos lectores no encuentran dónde empieza el código.
    expect(m.lado).toBe(m.modulos + 8)

    // Y el trazado va desplazado por ese margen: ningún módulo puede caer en la
    // banda de silencio. El primero que se dibuja es la esquina del primer
    // localizador, o sea exactamente (4,4).
    expect(m.path.startsWith('M4 4h1v1h-1z')).toBe(true)
  })

  it('el margen es configurable y mueve el trazado con él', () => {
    const m = matrizQR(UUID, 0)
    expect(m.lado).toBe(m.modulos)
    expect(m.path.startsWith('M0 0h1v1h-1z')).toBe(true)
  })

  it('codifica el contenido: valores distintos dan matrices distintas', () => {
    const a = matrizQR(UUID)
    const b = matrizQR(UUID.replace(/4$/, '5'))
    expect(a.path).not.toBe(b.path)
  })

  it('es determinista: la misma sala imprime siempre la misma placa', () => {
    // Importa de verdad. Si dos impresiones del mismo aula salieran distintas,
    // no habría forma de saber si una etiqueta pegada está vigente.
    expect(matrizQR(UUID).path).toBe(matrizQR(UUID).path)
  })

  it('un valor vacío es un error, no un cuadro en blanco', () => {
    expect(() => matrizQR('')).toThrow()
  })
})
