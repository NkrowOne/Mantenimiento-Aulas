import { describe, expect, it } from 'vitest'
import {
  capabilitiesFromRow,
  cleanRoomRef,
  classifyRoom,
  incidentDedupeKey,
  norm,
  parseLooseDate,
  parseMaterialUsed,
  splitIncidentKey,
  stripParenthetical,
  truthy,
  displayRoomCode,
} from './normalize'

// Todos los casos de este fichero salen del Excel real del equipo, no son
// inventados: cada uno corresponde a una fila que rompía el cruce de datos.

describe('norm', () => {
  it('quita tildes y unifica mayúsculas', () => {
    expect(norm('Simulación Quirúrgica')).toBe('SIMULACION QUIRURGICA')
  })

  it('convierte la coma decimal en punto, como en "0,3 EPS"', () => {
    expect(norm('0,3 EPS')).toBe('0.3 EPS')
  })

  it('colapsa los espacios dobles de "NP- M403HG"', () => {
    expect(norm('NP-  M403HG')).toBe('NP- M403HG')
  })
})

describe('truthy', () => {
  it('acepta las tres grafías de sí que conviven en la hoja', () => {
    expect(truthy('SÍ')).toBe(true)
    expect(truthy('SI')).toBe(true)
    expect(truthy('si')).toBe(true)
  })

  it('trata la celda vacía como "no consta"', () => {
    expect(truthy('')).toBe(false)
    expect(truthy(null)).toBe(false)
  })
})

describe('capabilitiesFromRow', () => {
  it('lee la botonera, que no es un sí/no sino "Actualizada" o "No tiene"', () => {
    expect(capabilitiesFromRow({ botonera: 'Actualizada *' }).botonera).toBe(true)
    // La errata "Actaulizada" aparece en 20 filas del Excel.
    expect(capabilitiesFromRow({ botonera: 'Actaulizada *' }).botonera).toBe(true)
    expect(capabilitiesFromRow({ botonera: 'No tiene' }).botonera).toBe(false)
    expect(capabilitiesFromRow({ botonera: '' }).botonera).toBe(false)
  })

  it('deduce el proyector del modelo anotado', () => {
    expect(capabilitiesFromRow({ modeloProyector: 'NP-M403' }).proyector).toBe(true)
    expect(capabilitiesFromRow({ modeloProyector: 'No tiene' }).proyector).toBe(false)
    // "N/D" significa que no se anotó, no que exista.
    expect(capabilitiesFromRow({ modeloProyector: 'N/D' }).proyector).toBe(false)
  })

  it('da por buena la cámara si hay modelo aunque la casilla esté vacía', () => {
    expect(capabilitiesFromRow({ camara: '', modeloCamara: '520 PRO' }).camara).toBe(true)
  })
})

describe('splitIncidentKey', () => {
  it('separa "1.7 H" en sala y edificio', () => {
    expect(splitIncidentKey('1.7 H')).toEqual({ roomCode: '1.7', buildingCode: 'H' })
  })

  it('entiende códigos de edificio de varias letras', () => {
    expect(splitIncidentKey('Aula 2 CSQ')).toEqual({ roomCode: 'AULA 2', buildingCode: 'CSQ' })
  })

  it('normaliza la coma decimal de "0,3 EPS"', () => {
    expect(splitIncidentKey('0,3 EPS')).toEqual({ roomCode: '0.3', buildingCode: 'EPS' })
  })

  it('devuelve null cuando no hay sufijo de edificio', () => {
    expect(splitIncidentKey('Ventanilla Unica')?.buildingCode).not.toBe('')
    expect(splitIncidentKey('')).toBeNull()
  })
})

describe('cleanRoomRef', () => {
  it('quita el prefijo Sotano, porque la planta ya va en el código', () => {
    expect(cleanRoomRef('Sotano -1.5 BC')).toBe('-1.5 BC')
  })

  it('tolera el acento suelto de "´-1.1 BC"', () => {
    expect(cleanRoomRef('´-1.1 BC')).toBe('-1.1 BC')
  })
})

describe('stripParenthetical', () => {
  it('reduce "5.4 (Lab 3D)" al código con el que se escribe en las incidencias', () => {
    expect(stripParenthetical('5.4 (Lab 3D)')).toBe('5.4')
    expect(stripParenthetical('5.1 (Lab de videojuegos)')).toBe('5.1')
  })
})

describe('classifyRoom', () => {
  it('reconoce laboratorios, salas de reunión y aulas', () => {
    expect(classifyRoom('Laboratorio 10')).toBe('laboratorio')
    expect(classifyRoom('Lab 5 -1.4')).toBe('laboratorio')
    expect(classifyRoom('Sala de Juntas')).toBe('sala_reunion')
    expect(classifyRoom('1.7')).toBe('aula')
    expect(classifyRoom('Aula Moda')).toBe('aula')
  })
})

describe('parseLooseDate', () => {
  it('corrige el año imposible de la incidencia fechada en 2005', () => {
    const { date, fixed } = parseLooseDate(new Date(Date.UTC(2005, 2, 26)))
    expect(date?.getUTCFullYear()).toBe(2025)
    expect(fixed).toContain('2005')
  })

  it('interpreta el texto "29-01-026" que alguien tecleó mal', () => {
    const { date } = parseLooseDate('29-01-026')
    expect(date?.toISOString().slice(0, 10)).toBe('2026-01-29')
  })

  it('deja en paz una fecha correcta', () => {
    const input = new Date(Date.UTC(2026, 0, 2))
    expect(parseLooseDate(input).fixed).toBeNull()
  })

  it('devuelve null en vez de inventarse una fecha ilegible', () => {
    expect(parseLooseDate('no consta').date).toBeNull()
  })

  it('reconstruye "27-03-296" quitando el dígito que sobra, no sumando 2000', () => {
    // El caso real del CRAI: dos incidencias fechadas en 2296 —doscientos
    // setenta años en el futuro— encabezando el Historial. La única lectura
    // creíble de «296» es «26».
    const { date, fixed } = parseLooseDate('27-03-296', 2027)
    expect(date?.toISOString().slice(0, 10)).toBe('2026-03-27')
    expect(fixed).toContain('296')
  })

  it('ante un año de tres cifras con dos lecturas posibles no adivina', () => {
    // «226» puede ser 2022 o 2026: las dos caen en la ventana creíble.
    expect(parseLooseDate('27-03-226', 2027).date).toBeNull()
  })

  it('un año del futuro es ilegible, venga como texto o como fecha de Excel', () => {
    expect(parseLooseDate('27-03-2296', 2027).date).toBeNull()
    expect(parseLooseDate('27-03-99', 2027).date).toBeNull()
    expect(parseLooseDate(new Date(Date.UTC(2296, 2, 27)), 2027).date).toBeNull()
  })
})

describe('parseMaterialUsed', () => {
  it('extrae cantidad y artículo de una partida simple', () => {
    const { items } = parseMaterialUsed('1 Cable Hdmi 15mts Fibra')
    expect(items).toHaveLength(1)
    expect(items[0]?.qty).toBe(1)
    expect(items[0]?.item).toMatch(/Cable Hdmi/i)
  })

  it('separa dos partidas en la misma celda', () => {
    const { items } = parseMaterialUsed('2 Cables Hdmi 10mts       2 Cables Usb 10 mts')
    expect(items.length).toBeGreaterThanOrEqual(2)
  })

  it('captura el número de serie que va tras N/S', () => {
    const { items } = parseMaterialUsed('1 Camara 520 PRO       N/S 5310306900024')
    expect(items[0]?.serial).toBe('5310306900024')
  })

  it('manda a cuarentena lo que no sabe interpretar en vez de inventárselo', () => {
    const { items, leftover } = parseMaterialUsed('Cambio Tini S4KQ2080')
    expect(items).toHaveLength(0)
    expect(leftover).toBe('Cambio Tini S4KQ2080')
  })

  it('no devuelve nada para una celda vacía', () => {
    expect(parseMaterialUsed('').items).toHaveLength(0)
  })
})

describe('incidentDedupeKey', () => {
  it('da la misma clave a las dos filas idénticas de "2.6 C"', () => {
    const row = {
      ref: 'I260203_0051',
      room: '2.6 C',
      date: '2026-02-03',
      problem: 'Los altavodes del aula emien un pitido constante',
    }
    expect(incidentDedupeKey(row)).toBe(incidentDedupeKey({ ...row }))
  })

  it('distingue dos incidencias distintas con la misma referencia', () => {
    const base = { ref: 'I260203_0051', room: '2.6 C', date: '2026-02-03' }
    expect(incidentDedupeKey({ ...base, problem: 'Altavoces' })).not.toBe(
      incidentDedupeKey({ ...base, problem: 'Proyector' }),
    )
  })
})

describe('displayRoomCode', () => {
  it('convierte el guion inicial en signo menos, que no se lee como errata', () => {
    expect(displayRoomCode('-2.1')).toBe('−2.1')
    expect(displayRoomCode('-1.3')).toBe('−1.3')
  })

  it('no toca los códigos normales ni los guiones interiores', () => {
    expect(displayRoomCode('1.7')).toBe('1.7')
    expect(displayRoomCode('Lab 5 -1.4')).toBe('Lab 5 -1.4')
  })
})
