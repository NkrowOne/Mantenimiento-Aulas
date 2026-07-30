import { describe, expect, it } from 'vitest'
import { claveDesde } from './CamposDelTipo'

/**
 * La clave interna de un campo propio.
 *
 * Se prueba porque es lo que ata el campo a los valores ya escritos: `specs` es un
 * objeto `jsonb` con la clave dentro, así que una clave que cambia es un valor que
 * desaparece de la pantalla sin que nadie diga nada. Y la primera versión de esto
 * ya estuvo mal —`norm()` devuelve MAYÚSCULAS y el filtro esperaba minúsculas, así
 * que se comía la cadena entera y TODOS los campos se llamaban «campo», que es
 * exactamente el fallo que se pisa los valores unos a otros—.
 */
describe('claveDesde', () => {
  it('convierte la etiqueta en un identificador legible', () => {
    expect(claveDesde('Lúmenes')).toBe('lumenes')
    expect(claveDesde('Referencia de lámpara')).toBe('referencia_de_lampara')
    expect(claveDesde('RAM')).toBe('ram')
  })

  it('quita las tildes y no las deja convertidas en guiones', () => {
    // Es el caso que delató el fallo: sin bajar a minúsculas, esto daba «campo».
    expect(claveDesde('Resolución')).toBe('resolucion')
    expect(claveDesde('Tamaño')).toBe('tamano')
  })

  it('no deja guiones sueltos en los bordes ni repetidos', () => {
    expect(claveDesde('  Pulgadas  ')).toBe('pulgadas')
    expect(claveDesde('Nº de serie del panel')).toBe('n_de_serie_del_panel')
    expect(claveDesde('¿Lleva lector?')).toBe('lleva_lector')
  })

  it('nunca devuelve una cadena vacía', () => {
    // Una clave vacía se pisaría con la de cualquier otro campo sin etiqueta.
    expect(claveDesde('')).toBe('campo')
    expect(claveDesde('···')).toBe('campo')
  })

  it('acota la longitud: la clave viaja en cada fila de `specs`', () => {
    expect(claveDesde('x'.repeat(80)).length).toBeLessThanOrEqual(40)
  })
})
