import { describe, expect, it } from 'vitest'
import { candidatasDeFotos, sinLasDescartadas, type FilasParaFotos } from './fotos'
import type {
  FilaAdjunto,
  FilaApertura,
  FilaCierre,
  FilaRevision,
  FilaSala,
} from './datos'

/**
 * Qué fotos lleva el informe, y cuáles se han quitado.
 *
 * Esta lista la usan DOS piezas —el documento, que se las baja, y la rejilla de
 * la pantalla, donde se quitan las que no tienen que salir— y por eso vive
 * sola. Lo que estas pruebas impiden es que las dos dejen de decir lo mismo: si
 * el orden o el emparejado cambiaran solo en un sitio, la casilla que alguien
 * desmarca dejaría de corresponder con la foto que falta en el papel, y eso no
 * se descubre hasta tener el PDF delante.
 */

function sala(p: Partial<FilaSala> & { room_id: string }): FilaSala {
  return {
    room_code: 'H-102',
    room_name: 'AULA 102',
    building_code: 'H',
    building_name: 'Edificio H',
    last_inspection_at: null,
    open_incidents: 0,
    ...p,
  }
}

function revision(p: Partial<FilaRevision> & { id: string }): FilaRevision {
  return {
    corrects: null,
    room_id: 'sala-1',
    occurred_at: '2026-07-27T08:00:00.000Z',
    corrected_at: null,
    by_user: 'ana',
    overall: 'ok',
    ...p,
  }
}

function apertura(p: Partial<FilaApertura> & { id: string }): FilaApertura {
  return {
    kind: 'incidencia',
    severity: 'media',
    state: 'abierta',
    title: 'Proyector sin señal',
    description: null,
    external_ref: null,
    room_id: 'sala-1',
    opened_at: '2026-07-27T09:00:00.000Z',
    opened_by: 'ana',
    opened_from_inspection_id: null,
    ...p,
  }
}

function cierre(p: Partial<FilaCierre> & { id: string }): FilaCierre {
  return {
    kind: 'incidencia',
    title: 'Proyector sin señal',
    resolution: 'Cambiado el cable',
    external_ref: null,
    room_id: 'sala-1',
    opened_at: '2026-07-27T09:00:00.000Z',
    resolved_at: '2026-07-28T11:00:00.000Z',
    resolved_by: 'ana',
    ...p,
  }
}

function adjunto(p: Partial<FilaAdjunto> & { id: string; entity_id: string }): FilaAdjunto {
  return {
    storage_path: `fotos/${p.id}.jpg`,
    taken_at: '2026-07-27T09:30:00.000Z',
    ...p,
  }
}

function filas(p: Partial<FilasParaFotos>): FilasParaFotos {
  return {
    aperturas: [],
    cierres: [],
    visitas: [],
    deSala: new Map([['sala-1', sala({ room_id: 'sala-1' })]]),
    deIncidencias: [],
    deRevisiones: [],
    ...p,
  }
}

describe('las fotos que puede llevar el informe', () => {
  it('empareja el antes con el después: la revisión que abrió la incidencia va con su cierre', () => {
    // La foto de la revisión enseña el problema recién encontrado y la del
    // cierre el aula arreglada. Separadas no demuestran nada; seguidas son un
    // trabajo hecho.
    const candidatas = candidatasDeFotos(
      filas({
        visitas: [revision({ id: 'rev-1' })],
        cierres: [cierre({ id: 'inc-1' })],
        aperturas: [apertura({ id: 'inc-1', opened_from_inspection_id: 'rev-1' })],
        deRevisiones: [adjunto({ id: 'f-antes', entity_id: 'rev-1' })],
        deIncidencias: [
          adjunto({ id: 'f-despues', entity_id: 'inc-1', taken_at: '2026-07-28T11:05:00.000Z' }),
        ],
      }),
    )

    expect(candidatas.map((c) => c.id)).toEqual(['f-antes', 'f-despues'])
    expect(candidatas.map((c) => c.momento)).toEqual(['revision', 'cierre'])
    // Las dos hablan de la misma incidencia, aunque una cuelgue de la revisión.
    expect(candidatas.every((c) => c.titulo === 'Proyector sin señal')).toBe(true)
  })

  it('una incidencia sin resolver es «mientras espera», no un «después»', () => {
    const [foto] = candidatasDeFotos(
      filas({
        aperturas: [apertura({ id: 'inc-2' })],
        deIncidencias: [adjunto({ id: 'f', entity_id: 'inc-2' })],
      }),
    )
    expect(foto?.momento).toBe('apertura')
  })

  it('las revisiones que no abrieron nada van detrás de todas las incidencias', () => {
    // Con el tope del documento por medio, un orden por hora dejaría fuera
    // justo los cierres, que son los que cierran el argumento.
    const candidatas = candidatasDeFotos(
      filas({
        visitas: [revision({ id: 'rev-suelta' })],
        aperturas: [apertura({ id: 'inc-1', opened_at: '2026-07-28T09:00:00.000Z' })],
        deRevisiones: [
          adjunto({ id: 'f-revision', entity_id: 'rev-suelta', taken_at: '2026-07-27T08:10:00.000Z' }),
        ],
        deIncidencias: [
          adjunto({ id: 'f-incidencia', entity_id: 'inc-1', taken_at: '2026-07-28T09:10:00.000Z' }),
        ],
      }),
    )
    expect(candidatas.map((c) => c.id)).toEqual(['f-incidencia', 'f-revision'])
  })

  it('lleva el aula de cada foto, para poder ponerla en el pie', () => {
    const [foto] = candidatasDeFotos(
      filas({
        aperturas: [apertura({ id: 'inc-1', room_id: 'sala-1' })],
        deIncidencias: [adjunto({ id: 'f', entity_id: 'inc-1' })],
      }),
    )
    expect(foto?.sala?.building_code).toBe('H')
    expect(foto?.sala?.room_code).toBe('H-102')
  })

  it('un adjunto de algo que no es del periodo no se cuela', () => {
    const candidatas = candidatasDeFotos(
      filas({ deIncidencias: [adjunto({ id: 'f', entity_id: 'inc-de-otro-mes' })] }),
    )
    expect(candidatas).toEqual([])
  })
})

describe('las que se quitan al pedir el informe', () => {
  const dos = (): ReturnType<typeof candidatasDeFotos> =>
    candidatasDeFotos(
      filas({
        aperturas: [apertura({ id: 'inc-1' })],
        deIncidencias: [
          adjunto({ id: 'f-1', entity_id: 'inc-1' }),
          adjunto({ id: 'f-2', entity_id: 'inc-1', taken_at: '2026-07-27T10:00:00.000Z' }),
        ],
      }),
    )

  it('sin lista, entran todas: no elegir nada es no quitar nada', () => {
    expect(sinLasDescartadas(dos(), new Set()).map((c) => c.id)).toEqual(['f-1', 'f-2'])
  })

  it('la que se quita no entra, y las demás siguen', () => {
    expect(sinLasDescartadas(dos(), new Set(['f-1'])).map((c) => c.id)).toEqual(['f-2'])
  })

  it('un id que ya no existe no se lleva por delante ninguna foto', () => {
    // Los ids viajan en el expediente del informe y se leen meses después: uno
    // de una foto borrada no puede vaciar el documento.
    expect(sinLasDescartadas(dos(), new Set(['f-de-otro-periodo']))).toHaveLength(2)
  })
})
