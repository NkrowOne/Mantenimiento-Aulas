import { describe, expect, it } from 'vitest'
import { conPlazo, esRedCaida, esSilencio, señalConTope } from './espera'

/**
 * El fallo que estas pruebas existen para impedir no es un error: es la
 * AUSENCIA de uno. «Nunca me llega a dar el informe» fue una pantalla que se
 * quedó en «Leyendo los datos del periodo…» para siempre porque una de las
 * veinticinco peticiones no contestó y nadie le había puesto plazo.
 */

describe('el plazo de lo que no acepta una señal', () => {
  it('una espera que no termina se convierte en una frase que dice qué fue', async () => {
    const nuncaTermina = new Promise(() => undefined)
    await expect(conPlazo('la subida del documento', 20, nuncaTermina)).rejects.toThrow(
      /la subida del documento no ha contestado/,
    )
  })

  it('lo que contesta a tiempo pasa tal cual', async () => {
    await expect(conPlazo('algo', 1000, Promise.resolve(42))).resolves.toBe(42)
  })

  it('un fallo propio llega entero, sin disfrazarlo de plazo agotado', async () => {
    // Son dos cosas distintas y piden respuestas distintas: «ha contestado que
    // no» se arregla con el rol; «no ha contestado» con la red.
    await expect(conPlazo('algo', 1000, Promise.reject(new Error('permiso denegado')))).rejects.toThrow(
      'permiso denegado',
    )
  })
})

describe('distinguir el silencio del rechazo', () => {
  it('reconoce un aborto por tiempo', () => {
    expect(esSilencio(new DOMException('signal timed out', 'TimeoutError'))).toBe(true)
    expect(esSilencio(new DOMException('The operation was aborted', 'AbortError'))).toBe(true)
    expect(esSilencio(new Error('Se agotó la espera'))).toBe(true)
  })

  it('y no confunde con él a un permiso denegado', () => {
    expect(esSilencio(new Error('new row violates row-level security policy'))).toBe(false)
    expect(esSilencio(new Error('relation "public.ia_clave" does not exist'))).toBe(false)
  })
})

describe('la señal con tope', () => {
  it('se corta sola', async () => {
    const señal = señalConTope(20)
    expect(señal.aborted).toBe(false)
    await new Promise((r) => setTimeout(r, 60))
    expect(señal.aborted).toBe(true)
  })

  it('sirve también donde no existe AbortSignal.timeout', async () => {
    // Safari por debajo de la 16, que es exactamente el iPad que puede haber en
    // un campus. Sin el respaldo, el mecanismo que existe para que el informe
    // salga sería el que impide que salga.
    const original = AbortSignal.timeout
    try {
      // @ts-expect-error se retira a propósito para probar el respaldo
      delete AbortSignal.timeout
      const señal = señalConTope(20)
      await new Promise((r) => setTimeout(r, 60))
      expect(señal.aborted).toBe(true)
    } finally {
      AbortSignal.timeout = original
    }
  })
})

/*
 * La tercera categoría, la que se colaba tal cual en la pantalla del informe:
 * «TypeError: Load failed». Ni es un plazo agotado —ahí hubo petición y no hubo
 * respuesta— ni es un permiso denegado, que llega con su mensaje de la base. Es
 * que la petición no llegó a salir.
 */
describe('la red que no llega', () => {
  it('reconoce cómo lo dice cada navegador', () => {
    expect(esRedCaida(new TypeError('Load failed'))).toBe(true)
    expect(esRedCaida(new TypeError('Failed to fetch'))).toBe(true)
    expect(esRedCaida(new TypeError('NetworkError when attempting to fetch resource'))).toBe(true)
  })

  /*
   * El caso que se me escapó al escribirlo: por el camino de la descarga
   * paginada el `TypeError` original no llega nunca. `descargaEntera` lo recoge,
   * se queda con el mensaje y sigue con un `Error` normal — así que mirar el
   * tipo dejaba sin clasificar justo la consulta más larga del informe.
   */
  it('lo reconoce también cuando ya ha perdido el tipo por el camino', () => {
    expect(esRedCaida(new Error('TypeError: Load failed'))).toBe(true)
    expect(esRedCaida(new Error('Load failed'))).toBe(true)
    expect(esRedCaida('Failed to fetch')).toBe(true)
  })

  it('no confunde un permiso denegado con un fallo de red', () => {
    expect(esRedCaida(new Error('permission denied for table assets'))).toBe(false)
    expect(esRedCaida(new Error('JWT expired'))).toBe(false)
  })

  it('no se solapa con el plazo agotado: cada uno pide una respuesta distinta', () => {
    const plazo = new DOMException('Se agotó la espera', 'TimeoutError')
    expect(esSilencio(plazo)).toBe(true)
    expect(esRedCaida(plazo)).toBe(false)

    const red = new TypeError('Load failed')
    expect(esRedCaida(red)).toBe(true)
    expect(esSilencio(red)).toBe(false)
  })
})
