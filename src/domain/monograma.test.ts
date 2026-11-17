import { describe, expect, it } from 'vitest'
import { monogramaDeEdificio } from './monograma'

/** Una muestra del campus, con nombres como los que tienen dados de alta. */
const CAMPUS: Array<[string, string]> = [
  ['AYD1', 'AYD1'], ['AYD2', 'AYD2'], ['C', 'ED. CENTRAL'], ['CD', 'CENTRO DEPORTIVO'],
  ['CM', 'COLEGIO MAYOR'], ['COM', 'COMUNICACION'], ['CRAI', 'EDIFICIO CRAI'], ['CSC', 'SIMULACION CLINICA'],
  ['CSQ', 'SIMULACION QUIRURGICA'], ['DOT', 'DOT'], ['E', 'EDIFICIO E'], ['EPS', 'EDIFICIO EPS'],
  ['H', 'EDIFICIO H'], ['M', 'EDIFICIO M'], ['MSI', 'MSI'], ['O', 'EDIFICIO O'], ['P', 'EDIFICIO P'],
  ['PRY', 'PROYECTA'],
]

const firma = (code: string, name: string): string => {
  const m = monogramaDeEdificio(code, name)
  return [m.letra, m.detalle, m.tinta].join('/')
}

describe('la chapa de un edificio', () => {
  it('es la misma siempre: no depende del dispositivo ni del momento', () => {
    expect(monogramaDeEdificio('H', 'EDIFICIO H')).toEqual(monogramaDeEdificio('H', 'EDIFICIO H'))
    // Ni de cómo esté escrito: mayúsculas, tildes y espacios de más no la cambian.
    expect(monogramaDeEdificio(' h ', 'Edificio  H')).toEqual(monogramaDeEdificio('H', 'EDIFICIO H'))
    expect(firma('COM', 'COMUNICACIÓN')).toBe(firma('COM', 'COMUNICACION'))
  })

  it('cambia cuando cambia la sigla o el nombre', () => {
    // Con veinticuatro combinaciones, que seis nombres distintos den todos la
    // misma chapa es un fallo del reparto, no una casualidad.
    const nombres = ['EDIFICIO H', 'HOSPITAL', 'EDIFICIO HACHE', 'HUMANIDADES', 'AULARIO H', 'H2']
    expect(new Set(nombres.map((n) => firma('H', n))).size).toBeGreaterThan(1)
    const siglas = ['H', 'HX', 'HA', 'H1', 'HH', 'HZ']
    expect(new Set(siglas.map((s) => firma(s, 'EDIFICIO H'))).size).toBeGreaterThan(1)
  })

  it('escribe el código entero, en mayúsculas y sin espacios', () => {
    for (const [code, name] of CAMPUS) {
      expect(monogramaDeEdificio(code, name).texto).toBe(code)
    }
    expect(monogramaDeEdificio(' ayd 1 ', '').texto).toBe('AYD1')
    // Sin sigla no se queda vacía: una chapa en blanco parece un fallo.
    expect(monogramaDeEdificio('', 'Sin sigla').texto).toBe('–')
  })

  it('solo usa la letra gruesa, un detalle y dos tintas', () => {
    // Es el contrato con quien lo mira: nada de contornos, rótulos en vertical
    // ni cuatro colores. Si alguien amplía el sistema, que sea a sabiendas.
    for (const [code, name] of CAMPUS) {
      const m = monogramaDeEdificio(code, name)
      expect(['recta', 'inclinada', 'pesada']).toContain(m.letra)
      expect(['liso', 'base', 'franja', 'arco']).toContain(m.detalle)
      expect(['tinte', 'llena']).toContain(m.tinta)
    }
  })

  it('en el campus se reparte: salen las tres letras, los cuatro detalles y las dos tintas', () => {
    const firmas = CAMPUS.map(([c, n]) => firma(c, n))
    const usa = (eje: 0 | 1 | 2): number => new Set(firmas.map((f) => f.split('/')[eje])).size
    expect(usa(0)).toBe(3)
    expect(usa(1)).toBe(4)
    expect(usa(2)).toBe(2)
    // Y ninguna combinación se lleva más de tres edificios: con dieciocho en
    // veinticuatro combinaciones habrá repetidas, pero no un montón iguales.
    const veces = new Map<string, number>()
    for (const f of firmas) veces.set(f, (veces.get(f) ?? 0) + 1)
    expect(Math.max(...veces.values())).toBeLessThanOrEqual(3)
  })
})
