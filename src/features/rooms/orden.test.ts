import { describe, expect, it } from 'vitest'
import { nextRoom, roomMatches, sortRooms } from './orden'
import type { Room, Zone } from '@/domain/types'

function sala(code: string, zone: string, last: string | null, name = code): Room {
  return {
    id: `${zone}-${code}`,
    zone_id: zone,
    code,
    name,
    kind: 'aula',
    capabilities: {
      proyector: false,
      altavoces: false,
      camara: false,
      microfono: false,
      botonera: false,
      tv: false,
    },
    projector_hours: null,
    lamp_pct: null,
    last_inspection_at: last,
    active: true,
  }
}

const ZONAS = new Map<string, Zone>([
  ['z-sotano', { id: 'z-sotano', building_id: 'b', name: 'SÓTANO', sort_order: 1 }],
  ['z-baja', { id: 'z-baja', building_id: 'b', name: 'PLANTA BAJA', sort_order: 2 }],
  ['z-primera', { id: 'z-primera', building_id: 'b', name: '1ª PLANTA', sort_order: 3 }],
])

describe('sortRooms · antigüedad', () => {
  it('pone primero la que no se ha revisado nunca', () => {
    const rooms = [
      sala('1.7', 'z-primera', '2026-07-01'),
      sala('0.3', 'z-baja', null),
      sala('1.8', 'z-primera', '2026-01-01'),
    ]
    expect(sortRooms(rooms, ZONAS, 'antiguedad').map((r) => r.code)).toEqual(['0.3', '1.8', '1.7'])
  })

  it('desempata por código, no por el orden en que llegaron', () => {
    // Sin desempate, dos salas sin revisar quedaban en orden de IndexedDB, que
    // no es estable ni tiene sentido para nadie.
    const rooms = [sala('1.10', 'z-primera', null), sala('1.2', 'z-primera', null)]
    expect(sortRooms(rooms, ZONAS, 'antiguedad').map((r) => r.code)).toEqual(['1.2', '1.10'])
  })
})

describe('sortRooms · planta', () => {
  it('agrupa por planta para no hacer subir y bajar escaleras', () => {
    // Con el orden por antigüedad puro estas tres salían intercaladas: sótano,
    // primera, baja. Es la ruta en zigzag que motivó el segundo orden.
    const rooms = [
      sala('1.7', 'z-primera', '2020-01-01'),
      sala('-1.2', 'z-sotano', '2026-07-01'),
      sala('0.3', 'z-baja', '2023-01-01'),
    ]
    expect(sortRooms(rooms, ZONAS, 'planta').map((r) => r.code)).toEqual(['-1.2', '0.3', '1.7'])
  })

  it('ordena los códigos como los lee una persona: 0.2 antes que 0.10', () => {
    const rooms = [sala('0.10', 'z-baja', null), sala('0.2', 'z-baja', null)]
    expect(sortRooms(rooms, ZONAS, 'planta').map((r) => r.code)).toEqual(['0.2', '0.10'])
  })
})

describe('roomMatches', () => {
  const lab = sala('-2.1', 'z-sotano', null, 'Lab Criminología')

  it('encuentra sin tilde lo que está escrito con tilde', () => {
    expect(roomMatches(lab, 'criminologia')).toBe(true)
  })

  it('encuentra el código de sótano tecleado sin el guion', () => {
    // Es como se dice en voz alta: «el dos uno del sótano».
    expect(roomMatches(lab, '2.1')).toBe(true)
    expect(roomMatches(lab, '-2.1')).toBe(true)
  })

  it('encuentra por planta', () => {
    expect(roomMatches(lab, 'sotano', 'SÓTANO')).toBe(true)
  })

  it('no devuelve lo que no coincide', () => {
    expect(roomMatches(lab, 'informatica')).toBe(false)
  })

  it('con la búsqueda vacía no filtra nada', () => {
    expect(roomMatches(lab, '   ')).toBe(true)
  })
})

describe('nextRoom', () => {
  it('salta a la siguiente del mismo orden, nunca a la que se acaba de cerrar', () => {
    // El caso que rompía «Guardar y siguiente sala»: si la recién terminada
    // siguiera siendo la primera, devolvería a la misma aula.
    const rooms = [
      sala('0.3', 'z-baja', null),
      sala('1.8', 'z-primera', '2026-01-01'),
      sala('1.7', 'z-primera', '2026-07-01'),
    ]
    expect(nextRoom(rooms, ZONAS, 'antiguedad', 'z-baja-0.3')?.code).toBe('1.8')
  })

  it('devuelve null cuando ya no queda ninguna', () => {
    const rooms = [sala('0.3', 'z-baja', null)]
    expect(nextRoom(rooms, ZONAS, 'antiguedad', 'z-baja-0.3')).toBeNull()
  })
})
