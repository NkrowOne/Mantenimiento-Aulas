import { describe, expect, it } from 'vitest'
import { displayRoomCode, norm } from './normalize'
import {
  avisoDeCodigoDeEdificio,
  chocaCodigo,
  mismaPlanta,
  normServidor,
  plantaQueAbsorbe,
  sanearCodigo,
  sanearCodigoDeEdificio,
  validarEdificio,
  validarPlanta,
  validarSala,
} from './nomenclatura'
import type { Zone } from './types'

function zona(id: string, name: string, sort_order = 10): Zone {
  return { id, building_id: 'b-h', name, sort_order }
}

const ZONAS: Zone[] = [
  zona('z-baja', 'PLANTA BAJA', 10),
  zona('z-primera', '1ª PLANTA', 20),
  zona('z-modulo', 'MÓDULO 3', 30),
]

describe('normServidor · no es norm', () => {
  it('deja la coma donde está, igual que el servidor', () => {
    // `norm()` la convierte en punto porque nació para leer el Excel;
    // `norm_text()` no. Validar aquí con la regla del Excel produciría un «no
    // hay duplicados» en el iPad y un 23505 del servidor un segundo después,
    // sobre exactamente el mismo texto.
    expect(norm('1,7')).toBe('1.7')
    expect(normServidor('1,7')).toBe('1,7')
  })

  it('quita tildes, sube a mayúsculas y colapsa los espacios', () => {
    expect(normServidor('  módulo   3 ')).toBe('MODULO 3')
  })
})

describe('sanearCodigo · el signo menos de la pantalla', () => {
  it('devuelve el guion que se guarda de verdad', () => {
    expect(sanearCodigo('−2.1')).toBe('-2.1')
  })

  it('deshace exactamente lo que pinta la lista, y no cambia nada más', () => {
    // La trampa concreta: rellenar el campo con lo que se ve —`displayRoomCode`—
    // metería un U+2212 en la columna `code`, y desde ahí `roomMatches`,
    // `cleanRoomRef`, `splitIncidentKey` y `room_aliases.alias_norm` dejan de
    // encontrar la sala.
    expect(sanearCodigo(displayRoomCode('-2.1'))).toBe('-2.1')
    expect(sanearCodigo(sanearCodigo('−2.1'))).toBe('-2.1')
    expect(sanearCodigo('1.7')).toBe('1.7')
  })

  it('no recorta mientras se escribe', () => {
    // Recortar en cada tecla es lo que impide teclear «AULA MAGNA»: el espacio
    // desaparecía antes de llegar a la M.
    expect(sanearCodigo('AULA ')).toBe('AULA ')
  })
})

describe('chocaCodigo · salas', () => {
  const salas = [
    { id: 'r1', code: 'A1', name: 'Aula 1' },
    { id: 'r2', code: 'Aula  Moda', name: 'Aula de Moda' },
  ]

  it('encuentra el duplicado que Postgres dejaría entrar', () => {
    // El `unique (zone_id, code)` distingue mayúsculas: sin esto, `a1` y `A1`
    // conviven como dos salas distintas de la misma planta y las incidencias se
    // reparten entre las dos.
    expect(chocaCodigo('a1', salas).con).toBe('r1')
  })

  it('y el que solo se distingue por los espacios de más', () => {
    expect(chocaCodigo('AULA MODA', salas).con).toBe('r2')
  })

  it('dice quién ocupa el código, para poder nombrarlo en el aviso', () => {
    expect(chocaCodigo('a1', salas).etiqueta).toBe('Aula 1')
  })

  it('renombrar una sala a su propio código no es un duplicado', () => {
    // El caso de cada día: se abre el formulario solo para corregir el nombre y
    // el código se envía tal cual. Un `every(c => c !== nuevo)` ingenuo lo
    // bloquea.
    expect(chocaCodigo('A1', salas, 'r1').con).toBeNull()
  })

  it('con el código vacío no hay choque que denunciar', () => {
    // De eso ya se queja `validarSala`, y dos mensajes a la vez para el mismo
    // campo vacío se leen como un error del programa.
    expect(chocaCodigo('   ', salas).con).toBeNull()
  })
})

describe('chocaCodigo · edificios', () => {
  const edificios = [
    { id: 'b-h', code: 'H', name: 'Edificio H' },
    { id: 'b-c', code: 'C', name: 'Edificio Central' },
  ]

  it('el código de un edificio es único sin mirar tildes ni mayúsculas', () => {
    expect(chocaCodigo('h', edificios).con).toBe('b-h')
    expect(chocaCodigo('E', edificios).con).toBeNull()
  })
})

describe('códigos de edificio', () => {
  it('se guardan como matrícula: mayúsculas, sin tildes y sin sobras', () => {
    expect(sanearCodigoDeEdificio(' áv ')).toBe('AV')
  })

  it('avisan cuando no pueden ser el sufijo de «1.7 H»', () => {
    // `splitIncidentKey` solo reconoce como sufijo una última palabra de una a
    // cuatro letras: con «CENTRAL», las incidencias importadas de ese edificio
    // dejan de resolverse y caen en cuarentena.
    expect(avisoDeCodigoDeEdificio('CENTRAL')).not.toBeNull()
    expect(avisoDeCodigoDeEdificio('E-1')).not.toBeNull()
    expect(avisoDeCodigoDeEdificio('CRAI')).toBeNull()
    expect(avisoDeCodigoDeEdificio('H')).toBeNull()
  })

  it('pero no lo prohíben: esa regla el servidor no la tiene', () => {
    // Una regla que solo existe en el cliente es una regla que alguien se salta
    // desde otro sitio sin enterarse. Se dice lo que va a pasar y decide quien
    // escribe.
    expect(validarEdificio('CENTRAL', 'Edificio Central')).toBeNull()
  })
})

describe('plantas', () => {
  it('«1ª PLANTA» y «1ª planta» son la misma planta', () => {
    expect(mismaPlanta('1ª PLANTA', '1ª planta')).toBe(true)
    expect(mismaPlanta('MÓDULO 3', 'MODULO 3')).toBe(true)
    expect(mismaPlanta('PLANTA BAJA', '1ª PLANTA')).toBe(false)
  })

  it('avisa de la fusión antes de pedirla', () => {
    // `rename_zone` fusiona: mueve las aulas a la otra planta y borra esta.
    // Descubrirlo en el mensaje de éxito sería silenciar un error caro.
    expect(plantaQueAbsorbe('1ª planta', ZONAS, 'z-baja')?.id).toBe('z-primera')
  })

  it('y no confunde renombrarse a sí misma con una fusión', () => {
    // Corregir la grafía —«1a planta» → «1ª PLANTA»— no mueve ni una aula.
    expect(plantaQueAbsorbe('1ª PLANTA', ZONAS, 'z-primera')).toBeNull()
  })

  it('con un nombre que no existe no hay nada que absorber', () => {
    expect(plantaQueAbsorbe('4ª PLANTA', ZONAS, 'z-primera')).toBeNull()
  })
})

describe('validaciones', () => {
  it('una sala sin código dice por qué hace falta', () => {
    // «Error» a secas no le dice nada a quien está de pie en un pasillo.
    expect(validarSala('', 'Lab')).toMatch(/código/)
    expect(validarSala('   ', 'Lab')).toMatch(/código/)
  })

  it('una sala con código no necesita nombre', () => {
    // El servidor le pone el código de nombre: en la hoja de estado la mayoría
    // de las aulas se llaman como su código y repetirlo solo produce erratas.
    expect(validarSala('1.7', '')).toBeNull()
  })

  it('el salto de línea pegado desde el Excel se para aquí', () => {
    // `btrim` del servidor quita el blanco de los extremos, no el de en medio:
    // un código con un `\n` dentro no vuelve a cruzar con nada.
    expect(validarSala('1.7\n', 'Lab')).toMatch(/salto de línea/)
    expect(validarPlanta('1ª PLANTA\n')).toMatch(/salto de línea/)
  })

  it('un edificio necesita las dos cosas', () => {
    expect(validarEdificio('', 'Edificio H')).toMatch(/código/)
    expect(validarEdificio('H', '  ')).toMatch(/nombre/)
    expect(validarEdificio('H', 'Edificio H')).toBeNull()
  })

  it('una planta necesita un nombre', () => {
    expect(validarPlanta('  ')).toMatch(/nombre/)
    expect(validarPlanta('SÓTANO')).toBeNull()
  })
})
