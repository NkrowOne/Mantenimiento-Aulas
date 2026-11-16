import { describe, expect, it } from 'vitest'
import { nextRoom, roomMatches, salaCoincide, sortRooms } from './orden'
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
    last_inventory_at: null,
    active: true,
  short_ref: null,
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

  it('por planta sigue la ruta, no vuelve a la cabeza de la lista', () => {
    /*
     * El bucle que se comía la ronda. Por planta el orden no se mueve al
     * revisar, así que «la primera que no sea esta» daba la primera del
     * edificio: terminar la 0.1 llevaba a la 0.2 y terminar la 0.2 devolvía a
     * la 0.1, indefinidamente. Se veía solo después de encadenar dos aulas.
     */
    const rooms = [
      sala('0.1', 'z-baja', null),
      sala('0.2', 'z-baja', null),
      sala('0.3', 'z-baja', null),
    ]
    expect(nextRoom(rooms, ZONAS, 'planta', 'z-baja-0.2')?.code).toBe('0.3')
  })

  it('por planta se salta las que ya se han revisado hoy', () => {
    // La 0.3 estaba ocupada: se hizo antes la 0.4 y luego se volvió a por ella.
    const haceUnRato = new Date(Date.now() - 30 * 60_000).toISOString()
    const rooms = [
      sala('0.3', 'z-baja', null),
      sala('0.4', 'z-baja', haceUnRato),
      sala('0.5', 'z-baja', '2026-01-01'),
    ]
    expect(nextRoom(rooms, ZONAS, 'planta', 'z-baja-0.3')?.code).toBe('0.5')
  })

  it('por planta no se salta una que va al día pero no es de hoy', () => {
    const ayer = new Date(Date.now() - 30 * 3_600_000).toISOString()
    const rooms = [sala('0.3', 'z-baja', null), sala('0.4', 'z-baja', ayer)]
    expect(nextRoom(rooms, ZONAS, 'planta', 'z-baja-0.3')?.code).toBe('0.4')
  })

  it('por planta cruza a la planta siguiente cuando se acaba la actual', () => {
    const rooms = [sala('0.9', 'z-baja', null), sala('1.1', 'z-primera', null)]
    expect(nextRoom(rooms, ZONAS, 'planta', 'z-baja-0.9')?.code).toBe('1.1')
  })

  it('por planta se acaba en la última del edificio, sin volver a empezar', () => {
    // Encadenar en círculo haría revisar dos veces las mismas aulas sin que
    // nada lo dijera. `null` devuelve a la lista, que es donde se ve el final.
    const rooms = [sala('0.1', 'z-baja', null), sala('1.1', 'z-primera', null)]
    expect(nextRoom(rooms, ZONAS, 'planta', 'z-primera-1.1')).toBeNull()
  })

  it('por planta sigue contestando si la sala cerrada ya no está en la lista', () => {
    // La ha archivado otro dispositivo mientras se revisaba: no hay posición
    // desde la que seguir, pero sí una sala razonable que ofrecer.
    const rooms = [sala('0.1', 'z-baja', null), sala('0.2', 'z-baja', null)]
    expect(nextRoom(rooms, ZONAS, 'planta', 'z-baja-9.9')?.code).toBe('0.1')
  })
})

describe('salaCoincide', () => {
  const H = { code: 'H', name: 'EDIFICIO H' }
  const CRAI = { code: 'CRAI', name: 'BIBLIOTECA CRAI' }
  const aula = sala('1.12', 'z-primera', null)
  const lab = sala('-2.1', 'z-sotano', null, 'Lab Criminología')

  it('encuentra el aula tecleando el edificio delante, como llega el aviso', () => {
    expect(salaCoincide(aula, 'h 1.12', '1ª PLANTA', H)).toBe(true)
    expect(salaCoincide(aula, '1.12 h', '1ª PLANTA', H)).toBe(true)
  })

  it('no la encuentra en otro edificio que tenga el mismo código de sala', () => {
    expect(salaCoincide(aula, 'h 1.12', '1ª PLANTA', CRAI)).toBe(false)
  })

  it('encuentra por un trozo del nombre del edificio', () => {
    expect(salaCoincide(aula, 'biblio 1.12', '1ª PLANTA', CRAI)).toBe(true)
  })

  it('la letra del edificio no coincide como trozo de otra palabra', () => {
    // «h» está dentro de «hemeroteca», pero quien teclea «h» pide el edificio H.
    const hemeroteca = sala('0.3', 'z-baja', null, 'Hemeroteca')
    expect(salaCoincide(hemeroteca, 'h', 'PLANTA BAJA', H)).toBe(true)
    expect(salaCoincide(hemeroteca, 'h 1.12', 'PLANTA BAJA', H)).toBe(false)
  })

  it('una sola palabra sigue buscando como antes', () => {
    expect(salaCoincide(lab, 'criminologia', 'SÓTANO', H)).toBe(true)
    expect(salaCoincide(lab, '2.1', 'SÓTANO', H)).toBe(true)
    expect(salaCoincide(lab, 'informatica', 'SÓTANO', H)).toBe(false)
  })

  it('con la búsqueda vacía no filtra nada', () => {
    expect(salaCoincide(lab, '  ', 'SÓTANO', H)).toBe(true)
  })
})
