import { describe, expect, it } from 'vitest'
import { MARGEN, cuantoDesplazar, franjaVisible, teclado, tramoConEtiqueta } from './campo-a-la-vista'

describe('cuánto tapa el teclado', () => {
  it('en iOS la página no encoge: lo tapado es lo que queda por debajo de lo visto', () => {
    // iPhone de 844 de alto, teclado de 336, sin que iOS haya movido nada.
    expect(teclado({ altoDePagina: 844, vistoDesde: 0, vistoAlto: 508 })).toBe(336)
  })

  it('si el navegador ya ha subido lo visto hasta el final, no queda nada tapado', () => {
    expect(teclado({ altoDePagina: 844, vistoDesde: 336, vistoAlto: 508 })).toBe(0)
    // A medias: lo que falta.
    expect(teclado({ altoDePagina: 844, vistoDesde: 100, vistoAlto: 508 })).toBe(236)
  })

  it('en un Android que encoge la página, tampoco: ya cabe todo', () => {
    expect(teclado({ altoDePagina: 444, vistoDesde: 0, vistoAlto: 444 })).toBe(0)
  })

  it('la barra del navegador escondiéndose no es un teclado', () => {
    expect(teclado({ altoDePagina: 780, vistoDesde: 0, vistoAlto: 724 })).toBe(0)
    expect(teclado({ altoDePagina: 780, vistoDesde: 0, vistoAlto: 780.4 })).toBe(0)
  })
})

describe('la franja en la que un campo se ve', () => {
  it('por arriba la corta la cabecera y por abajo el teclado', () => {
    // El carril va de la cabecera (57) al final de la página; lo visto, hasta el teclado.
    expect(franjaVisible({ arriba: 57, abajo: 784 }, { arriba: 0, abajo: 508 })).toEqual({ arriba: 57, abajo: 508 })
  })

  it('si iOS ha subido lo visto, la franja empieza donde empieza lo visto', () => {
    expect(franjaVisible({ arriba: 57, abajo: 784 }, { arriba: 200, abajo: 708 })).toEqual({ arriba: 200, abajo: 708 })
  })
})

describe('cuánto desplazar', () => {
  const franja = { arriba: 57, abajo: 508 }

  it('un campo que ya se ve entero no se toca', () => {
    expect(cuantoDesplazar({ arriba: 120, abajo: 164 }, franja)).toBe(0)
    // Justo en el límite, con su aire, tampoco.
    expect(cuantoDesplazar({ arriba: 57 + MARGEN.arriba, abajo: 508 - MARGEN.abajo }, franja)).toBe(0)
  })

  it('el que tapa el teclado sube lo justo para quedar encima, con aire', () => {
    // El campo acaba en 700 y el teclado empieza en 508: tiene que subir 212.
    expect(cuantoDesplazar({ arriba: 656, abajo: 700 }, franja)).toBe(700 - (508 - MARGEN.abajo))
    // Asomando solo a medias también cuenta.
    expect(cuantoDesplazar({ arriba: 480, abajo: 524 }, franja)).toBe(36)
  })

  it('el que se ha quedado bajo la cabecera baja lo justo', () => {
    expect(cuantoDesplazar({ arriba: 20, abajo: 64 }, franja)).toBe(20 - (57 + MARGEN.arriba))
  })

  it('uno más alto que la franja se alinea por arriba, que es por donde se escribe', () => {
    // Una nota de 500 px en una franja de 451.
    expect(cuantoDesplazar({ arriba: 300, abajo: 800 }, franja)).toBe(300 - (57 + MARGEN.arriba))
  })

  it('sin franja —todo tapado— no hace nada en vez de dar saltos', () => {
    expect(cuantoDesplazar({ arriba: 300, abajo: 344 }, { arriba: 500, abajo: 505 })).toBe(0)
  })
})

describe('el campo con su etiqueta', () => {
  it('cuenta la etiqueta que lleva encima: la pregunta y la respuesta, juntas', () => {
    expect(tramoConEtiqueta({ arriba: 140, abajo: 184 }, { arriba: 118, abajo: 184 })).toEqual({ arriba: 118, abajo: 184 })
  })

  it('una etiqueta que mide media pantalla no manda más que el campo', () => {
    expect(tramoConEtiqueta({ arriba: 400, abajo: 444 }, { arriba: 100, abajo: 444 })).toEqual({ arriba: 400, abajo: 444 })
  })

  it('sin etiqueta, el campo solo', () => {
    expect(tramoConEtiqueta({ arriba: 140, abajo: 184 }, null)).toEqual({ arriba: 140, abajo: 184 })
  })
})
