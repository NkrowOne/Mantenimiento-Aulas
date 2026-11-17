import { describe, expect, it } from 'vitest'
import { monogramaDeEdificio } from './monograma'

/** Los edificios del campus, con el nombre con que están dados de alta. */
const CAMPUS: Array<[string, string]> = [
  ['AYD1', 'AYD1'], ['AYD2', 'AYD2'], ['C', 'ED. CENTRAL'], ['CD', 'CENTRO DEPORTIVO'],
  ['CM', 'COLEGIO MAYOR'], ['COM', 'COMUNICACION'], ['CRAI', 'EDIFICIO CRAI'], ['CSC', 'SIMULACION CLINICA'],
  ['CSQ', 'SIMULACION QUIRURGICA'], ['DOT', 'DOT'], ['E', 'EDIFICIO E'], ['EPS', 'EDIFICIO EPS'],
  ['H', 'EDIFICIO H'], ['M', 'EDIFICIO M'], ['MSI', 'MSI'], ['O', 'EDIFICIO O'], ['P', 'EDIFICIO P'],
  ['PRY', 'PROYECTA'],
]

const firma = (code: string, name: string): string => {
  const m = monogramaDeEdificio(code, name)
  return [m.letra, m.composicion, m.fondo, m.tinta].join('/')
}

describe('la chapa de un edificio', () => {
  it('es la misma siempre: no depende del dispositivo ni del momento', () => {
    expect(monogramaDeEdificio('H', 'EDIFICIO H')).toEqual(monogramaDeEdificio('H', 'EDIFICIO H'))
    // Ni de cómo esté escrito: mayúsculas, tildes y espacios de más no la cambian.
    expect(monogramaDeEdificio(' h ', 'Edificio  H')).toEqual(monogramaDeEdificio('H', 'EDIFICIO H'))
    expect(firma('COM', 'COMUNICACIÓN')).toBe(firma('COM', 'COMUNICACION'))
  })

  it('cambia cuando cambia la sigla o el nombre, y solo entonces', () => {
    const base = monogramaDeEdificio('H', 'EDIFICIO H')
    // Buscando entre varios nombres y siglas, alguno tiene que dar otra chapa:
    // con dos mil combinaciones, que cinco seguidas salgan iguales es un fallo.
    const otrosNombres = ['HOSPITAL', 'EDIFICIO HACHE', 'HUMANIDADES', 'H2', 'AULARIO H']
    expect(otrosNombres.some((n) => firma('H', n) !== [base.letra, base.composicion, base.fondo, base.tinta].join('/'))).toBe(true)
    expect(monogramaDeEdificio('HX', 'EDIFICIO H').lineas).toEqual(['HX'])
  })

  it('escribe el código entero, sin espacios, y lo apila solo cuando toca', () => {
    for (const [code, name] of CAMPUS) {
      const m = monogramaDeEdificio(code, name)
      expect(m.lineas.join('')).toBe(code)
      expect(m.lineas.length).toBe(m.composicion === 'apilada' ? 2 : 1)
    }
    expect(monogramaDeEdificio('AYD1', 'AYD1').lineas.join('/')).toMatch(/^AYD1$|^AY\/D1$/)
    expect(monogramaDeEdificio('', 'Sin sigla').lineas).toEqual(['–'])
  })

  it('nunca propone una combinación que no se pueda leer', () => {
    // Códigos de todas las medidas, no solo los de hoy: la chapa se genera
    // también para el edificio que se dé de alta mañana.
    const codigos = [...CAMPUS.map(([c]) => c), 'A', 'ZZ', 'ABC', 'ABCD', 'ABCDE', 'LAB12', 'X1', 'Ñ', 'BBAA', 'CEFF']
    for (const code of codigos) {
      for (const name of ['', 'EDIFICIO', 'OTRO NOMBRE', 'Y OTRO MÁS']) {
        const m = monogramaDeEdificio(code, name)
        const largo = code.length
        // A sangre, solo con una o dos letras.
        if (m.composicion === 'sangre') expect(largo).toBeLessThanOrEqual(2)
        // Arrimada a la esquina, hasta tres.
        if (m.composicion === 'esquina') expect(largo).toBeLessThanOrEqual(3)
        // Apilada, a partir de cuatro: con tres queda una letra suelta.
        if (m.composicion === 'apilada') expect(largo).toBeGreaterThanOrEqual(4)
        // En vertical, nunca una letra sola, ni inclinada.
        if (m.composicion === 'vertical') {
          expect(largo).toBeGreaterThanOrEqual(2)
          expect(m.letra).not.toBe('inclinada')
        }
        // Con cinco o más, solo las dos que caben.
        if (largo >= 5) expect(['apilada', 'centro']).toContain(m.composicion)
        // El contorno solo con una o dos letras, y la fina nunca a sangre.
        if (m.letra === 'contorno') expect(largo).toBeLessThanOrEqual(2)
        if (m.letra === 'fina') expect(m.composicion).not.toBe('sangre')
        // Y debajo de una letra que apoya en el borde no hay base ni arco.
        if (m.composicion === 'sangre' || m.composicion === 'esquina') {
          expect(['base', 'arco']).not.toContain(m.fondo)
        }
      }
    }
  })

  it('en el campus de hoy no hay dos chapas iguales, y se usa toda la paleta', () => {
    const firmas = CAMPUS.map(([c, n]) => firma(c, n))
    expect(new Set(firmas).size).toBe(CAMPUS.length)

    const usa = (eje: 0 | 1 | 2 | 3): number => new Set(firmas.map((f) => f.split('/')[eje])).size
    // Con dieciocho edificios tienen que salir casi todas las letras, varias
    // composiciones y las cuatro tintas: si no, el reparto está torcido.
    expect(usa(0)).toBeGreaterThanOrEqual(5)
    expect(usa(1)).toBeGreaterThanOrEqual(4)
    expect(usa(2)).toBeGreaterThanOrEqual(5)
    expect(usa(3)).toBe(4)
  })
})
