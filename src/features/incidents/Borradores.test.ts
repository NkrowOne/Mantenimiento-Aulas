import { describe, expect, it } from 'vitest'
import { hayQueMostrar } from './Borradores'

/**
 * La regla que mantiene limpia la pantalla de incidencias.
 *
 * Los borradores dejaron de tener pestaña propia justamente porque un destino
 * permanente en la barra para algo que casi siempre está vacío enseña a no
 * pulsarlo. Ahora viven dentro de Incidencias, y todo el trato depende de que
 * cuando no hay ninguno **no se dibuje nada**: ni cabecera, ni «ninguno
 * pendiente», ni un hueco.
 *
 * Es una condición de una línea, y por eso mismo es fácil que alguien la relaje
 * sin darse cuenta al añadir un estado más.
 */
describe('hayQueMostrar', () => {
  it('con borradores, se enseña', () => {
    expect(hayQueMostrar({ cargando: false, fallo: false, cuantos: 2 })).toBe(true)
  })

  it('sin ninguno, no se dibuja nada', () => {
    expect(hayQueMostrar({ cargando: false, fallo: false, cuantos: 0 })).toBe(false)
  })

  it('mientras carga, tampoco: un hueco que aparece y desaparece salta más que el dato', () => {
    expect(hayQueMostrar({ cargando: true, fallo: false, cuantos: 0 })).toBe(false)
  })

  it('si falla, se calla: el error de un añadido no debe tapar la lista principal', () => {
    // Y con datos viejos en caché tampoco, porque no se sabe si siguen siendo
    // ciertos: la lista de abajo ya avisa de que el servidor no responde.
    expect(hayQueMostrar({ cargando: false, fallo: true, cuantos: 3 })).toBe(false)
  })
})
