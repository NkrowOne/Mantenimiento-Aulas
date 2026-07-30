import { describe, expect, it } from 'vitest'
import {
  RESULTADO,
  SEVERIDAD_ETIQUETA,
  etiquetaDeCheck,
  ordenDeResultado,
  retrasoDeSubida,
  textoDeFallos,
  tituloDeResultado,
} from './revision'

describe('cómo se nombra una comprobación', () => {
  it('usa el nombre del aparato que resuelve el servidor', () => {
    expect(etiquetaDeCheck('asset:1f2e3d4c-1111-4111-8111-111111111111', 'Pantalla 2')).toBe(
      'Pantalla 2',
    )
  })

  it('nombra en el cliente lo que no es un aparato', () => {
    expect(etiquetaDeCheck('red', null)).toBe('Red')
  })

  /*
   * La razón de que los nombres antiguos sigan en el vocabulario: hay revisiones
   * guardadas antes del inventario, y sin esto su ficha diría `pantallas`.
   */
  it('sigue leyendo las comprobaciones de antes del inventario', () => {
    expect(etiquetaDeCheck('pantallas', null)).toBe('Pantallas')
    expect(etiquetaDeCheck('botonera', null)).toBe('Botonera')
  })

  it('no escupe el uuid de un equipo que ya no está en el catálogo', () => {
    expect(etiquetaDeCheck('asset:1f2e3d4c-1111-4111-8111-111111111111', null)).toBe(
      'Equipo no identificado',
    )
  })

  it('y como última red devuelve la clave, que es mejor que nada', () => {
    expect(etiquetaDeCheck('algo_que_nadie_recuerda', null)).toBe('algo_que_nadie_recuerda')
  })
})

describe('qué falló, en una línea', () => {
  it('no dice nada cuando no falló nada', () => {
    expect(textoDeFallos([])).toBeNull()
  })

  it('junta los nombres cuando caben', () => {
    expect(
      textoDeFallos([
        { key: 'asset:1f2e3d4c-1111-4111-8111-111111111111', label: 'Proyector' },
        { key: 'red', label: null },
      ]),
    ).toBe('Proyector · Red')
  })

  it('corta y cuenta el resto en vez de partir la fila en cuatro líneas', () => {
    expect(
      textoDeFallos([
        { key: 'a', label: 'Proyector' },
        { key: 'b', label: 'Pantalla 2' },
        { key: 'c', label: 'Micrófono Jabra' },
        { key: 'd', label: 'Botonera' },
      ]),
    ).toBe('Proyector · Pantalla 2 y 2 más')
  })
})

describe('el orden de lectura de una ficha', () => {
  it('pone lo que falló primero y lo que no aplica al final', () => {
    const orden = (['na', 'ok', 'incidencia'] as const)
      .slice()
      .sort((a, b) => ordenDeResultado(a) - ordenDeResultado(b))
    expect(orden).toEqual(['incidencia', 'ok', 'na'])
  })
})

describe('el desfase entre el aula y el servidor', () => {
  it('se calla en el camino normal: se cierra y sube en segundos', () => {
    expect(
      retrasoDeSubida('2026-07-30T10:00:00.000Z', '2026-07-30T10:00:04.000Z'),
    ).toBeNull()
  })

  it('no dice nada de una revisión que todavía no ha llegado', () => {
    expect(retrasoDeSubida('2026-07-30T10:00:00.000Z', null)).toBeNull()
  })

  it('cuenta las horas cuando el aula no tenía cobertura', () => {
    expect(retrasoDeSubida('2026-07-30T08:00:00.000Z', '2026-07-30T13:00:00.000Z')).toBe(
      'Se hizo sin cobertura: subió 5 h después',
    )
  })

  it('y los días cuando el iPad pasó la noche fuera de línea', () => {
    expect(retrasoDeSubida('2026-07-28T08:00:00.000Z', '2026-07-30T08:00:00.000Z')).toBe(
      'Se hizo sin cobertura: subió 2 días después',
    )
  })

  it('un día en singular', () => {
    expect(retrasoDeSubida('2026-07-29T08:00:00.000Z', '2026-07-30T08:00:00.000Z')).toBe(
      'Se hizo sin cobertura: subió 1 día después',
    )
  })
})

describe('el resultado global', () => {
  it('un borrador no es una revisión sin incidencias: es una a medias', () => {
    expect(tituloDeResultado('borrador', null).etiqueta).toBe('Sin cerrar')
    // Y tampoco se pinta en verde, que se leería como «va bien».
    expect(tituloDeResultado('borrador', null).clase).toContain('warn')
  })

  it('distingue la que salió limpia de la que no', () => {
    expect(tituloDeResultado('completa', 'ok').etiqueta).toBe('Sin incidencias')
    expect(tituloDeResultado('completa', 'con_incidencias').etiqueta).toBe('Con incidencias')
  })
})

describe('el vocabulario compartido', () => {
  it('las gravedades se leen con las palabras del aula', () => {
    expect(SEVERIDAD_ETIQUETA.alta).toBe('Impide la clase')
    expect(SEVERIDAD_ETIQUETA.baja).toBe('Leve')
  })

  /* Quien marcó «Falla» en el aula tiene que encontrar «Falla» al leerlo. */
  it('los resultados se llaman igual al escribir y al leer', () => {
    expect(RESULTADO.incidencia.etiqueta).toBe('Falla')
    expect(RESULTADO.ok.etiqueta).toBe('Correcto')
    expect(RESULTADO.na.etiqueta).toBe('No aplica')
  })
})
