import { describe, expect, it } from 'vitest'
import { juntarDirectorio } from './personas'

describe('el directorio de nombres', () => {
  it('pone nombre a cada uuid que llega', () => {
    expect(
      juntarDirectorio({}, [
        { id: 'a', full_name: 'Pedro de Bergia' },
        { id: 'b', full_name: 'Ana Ruiz' },
      ]),
    ).toEqual({ a: 'Pedro de Bergia', b: 'Ana Ruiz' })
  })

  it('no olvida a nadie aunque la respuesta venga corta', () => {
    // Un servidor sin la migración solo le enseña a un técnico su propio
    // perfil: eso no puede dejar sin firma lo que firmaron los demás.
    const antes = { a: 'Pedro de Bergia', b: 'Ana Ruiz' }
    expect(juntarDirectorio(antes, [{ id: 'b', full_name: 'Ana Ruiz Gil' }])).toEqual({
      a: 'Pedro de Bergia',
      b: 'Ana Ruiz Gil',
    })
  })

  it('un nombre vacío no pisa el que había', () => {
    expect(juntarDirectorio({ a: 'Pedro de Bergia' }, [{ id: 'a', full_name: '  ' }])).toEqual({
      a: 'Pedro de Bergia',
    })
    expect(juntarDirectorio({}, [{ id: 'a', full_name: null }])).toEqual({})
  })
})
