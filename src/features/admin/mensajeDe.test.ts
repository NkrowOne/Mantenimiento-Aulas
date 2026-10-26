import { describe, expect, it } from 'vitest'
import { mensajeDe } from './Seccion'

/**
 * El motivo del servidor tiene que llegar a la pantalla.
 *
 * `supabase.rpc()` devuelve un `PostgrestError` que en esta versión es un
 * objeto plano, no un `Error`. Con solo `instanceof Error`, los botones de la
 * bandeja de duplicados fallaban diciendo «No se ha podido aplicar.» y nada
 * más, y quien los pulsaba no tenía forma de saber por qué.
 */
describe('mensajeDe', () => {
  it('lee el mensaje de un error de Postgrest, que no es un Error', () => {
    const deLaBase = { code: 'P0001', message: 'Ese equipo ya no existe', details: null, hint: null }
    expect(deLaBase instanceof Error).toBe(false)
    expect(mensajeDe(deLaBase)).toBe('Ese equipo ya no existe')
  })

  it('y el de un Error de toda la vida', () => {
    expect(mensajeDe(new Error('sin red'))).toBe('sin red')
  })

  it('sin mensaje que leer, dice lo de siempre', () => {
    expect(mensajeDe(null)).toBe('No se ha podido aplicar.')
    expect(mensajeDe({ message: '   ' })).toBe('No se ha podido aplicar.')
    expect(mensajeDe('texto suelto', 'Otra cosa.')).toBe('Otra cosa.')
  })
})
