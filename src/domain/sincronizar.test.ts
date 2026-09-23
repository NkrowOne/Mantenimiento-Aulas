import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { BOLSA_2025, BOLSA_2026, ESTADO, MATERIAL_2026, MATERIAL_2025 } from './mapa'
import { construirIndice } from './cruce'
import type { Catalogo } from './cruce'
import {
  sincronizarBolsa,
  sincronizarEstado,
  sincronizarPartes,
  SIN_INSTANTANEA,
} from './sincronizar'
import type { Instantanea } from './sincronizar'
import { idDeDuda } from './dudas'
import { columnaParaLaRef } from './preparar'
import { abrirLibro, leerHoja } from './xlsx'
import type { FilaLeida } from './xlsx'
import type { ArticuloVolcado, IncidenciaVolcada, SalaVolcada } from './volcado'
import { fechaAExcel } from './valores'

const LIBRO = process.env.LIBRO_XLSX
const bytes = LIBRO ? readFileSync(LIBRO) : null

// -----------------------------------------------------------------------------
// Andamio
// -----------------------------------------------------------------------------

function sala(over: Partial<SalaVolcada> = {}): SalaVolcada {
  return {
    id: 'r1',
    shortRef: 'SALA-000001',
    edificio: 'EDIFICIO P',
    zona: 'PLANTA BAJA',
    code: '0.1P',
    activa: true,
    projectorHours: 921,
    lampPct: 0.73,
    botoneraEstado: 'Actualizada *',
    capacidades: { altavoces: true, camara: true, microfono: true, botonera: true },
    revisiones: ['2025-06-23', '2024-06-03'],
    notas: null,
    equipos: [],
    ...over,
  }
}

function fila(n: number, celdas: Record<string, string | number | boolean | null>): FilaLeida {
  return { fila: n, celdas }
}

const CABECERA = fila(
  1,
  Object.fromEntries(ESTADO.columnas.map((c) => [c.letra, c.cabecera])),
)

const catalogo: Catalogo = {
  salas: [
    {
      id: 'r1',
      shortRef: 'SALA-000001',
      code: '0.1P',
      name: '0.1P',
      active: true,
      zona: 'PLANTA BAJA',
      edificioCodigo: 'P',
      edificioNombre: 'EDIFICIO P',
      edificioActivo: true,
      alias: [],
    },
  ],
  edificios: [{ codigo: 'P', nombre: 'EDIFICIO P', activo: true }],
  edificiosDesaparecidos: [],
}
const indice = construirIndice(catalogo)

function estado(
  filas: FilaLeida[],
  salas: SalaVolcada[],
  instantanea: Instantanea = SIN_INSTANTANEA,
  combinadas: string[] = [],
) {
  return sincronizarEstado({
    hoja: ESTADO,
    filas: [CABECERA, ...filas],
    salas,
    indice,
    columnaRef: 'Y',
    combinadas,
    instantanea,
  })
}

// -----------------------------------------------------------------------------

describe('la hoja de estado', () => {
  it('sin desajustes de cabecera no se para', () => {
    const p = estado([fila(2, { Y: 'SALA-000001', C: '0.1P' })], [sala()])
    expect(p.desajustes).toEqual([])
  })

  it('una cabecera movida para la pasada antes de escribir nada', () => {
    const rota = fila(1, { ...CABECERA.celdas, M: 'Otra cosa' })
    const p = sincronizarEstado({
      hoja: ESTADO,
      filas: [rota, fila(2, { Y: 'SALA-000001' })],
      salas: [sala()],
      indice,
      columnaRef: 'Y',
      instantanea: SIN_INSTANTANEA,
    })
    expect(p.desajustes).toHaveLength(1)
    expect(p.celdas).toEqual([])
    expect(p.borrar).toEqual([])
  })

  it('escribe la cabecera de la columna de matrículas si no está', () => {
    // Sin ella, la pasada siguiente no encuentra la columna y estrena otra: `Y`,
    // `Z`, `AA`… y desde la segunda ninguna fila cruza ya por matrícula.
    const p = estado([fila(2, { C: '0.1P', A: 'EDIFICIO P' })], [sala()])
    expect(p.celdas).toContainEqual({ celda: 'Y1', valor: 'Ref' })
  })

  it('y no la reescribe si ya está', () => {
    const conRef = fila(1, { ...CABECERA.celdas, Y: 'Ref' })
    const p = sincronizarEstado({
      hoja: ESTADO,
      filas: [conRef, fila(2, { Y: 'SALA-000001' })],
      salas: [sala()],
      indice,
      columnaRef: 'Y',
      instantanea: SIN_INSTANTANEA,
    })
    expect(p.celdas.some((c) => c.celda === 'Y1')).toBe(false)
  })

  it('el blanco de una columna arrastrada no se rellena', () => {
    // En blanco no quiere decir «no hay dato»: quiere decir «lo mismo que
    // arriba». Rellenarlo cambia cómo se lee un libro que la gente mira a diario.
    const p = estado(
      [
        fila(2, { A: 'EDIFICIO P', B: 'PLANTA BAJA', C: 'otra', Y: 'SALA-000002' }),
        fila(3, { C: '0.1P', Y: 'SALA-000001' }),
      ],
      [sala(), sala({ id: 'r2', shortRef: 'SALA-000002', code: 'otra' })],
    )
    expect(p.celdas.some((c) => c.celda === 'A3' || c.celda === 'B3')).toBe(false)
  })

  it('pero sí se corrige la fila que lleva el edificio escrito', () => {
    const p = estado(
      [fila(2, { A: 'EDIFICIO VIEJO', B: 'PLANTA BAJA', C: '0.1P', Y: 'SALA-000001' })],
      [sala({ edificio: 'EDIFICIO P' })],
    )
    expect(p.celdas).toContainEqual({ celda: 'A2', valor: 'EDIFICIO P' })
  })

  it('la mitad tapada de una celda combinada no se escribe', () => {
    // De `E67:E68` la que se ve es `E67`. Un valor en `E68` no lo enseña nadie y
    // reaparece el día que alguien deshaga la combinación.
    const p = estado(
      [fila(2, { Y: 'SALA-000001' }), fila(3, { Y: 'SALA-000002' })],
      [sala(), sala({ id: 'r2', shortRef: 'SALA-000002', code: 'otra' })],
      SIN_INSTANTANEA,
      ['D2:D3'],
    )
    expect(p.celdas.some((c) => c.celda === 'D3')).toBe(false)
    // La de arriba sí: es la que se ve.
    expect(p.celdas.some((c) => c.celda === 'D2')).toBe(true)
  })

  it('una combinación horizontal tapa las columnas de la derecha', () => {
    const p = estado(
      [fila(2, { Y: 'SALA-000001' })],
      [sala()],
      SIN_INSTANTANEA,
      ['D2:E2'],
    )
    expect(p.celdas.some((c) => c.celda === 'E2')).toBe(false)
  })

  it('escribe la matrícula en la fila que no la lleva', () => {
    const p = estado([fila(2, { A: 'EDIFICIO P', B: 'PLANTA BAJA', C: '0.1P' })], [sala()])
    expect(p.celdas).toContainEqual({ celda: 'Y2', valor: 'SALA-000001' })
  })

  it('una matrícula escrita a mano que no cuadra no se pisa', () => {
    const p = estado([fila(2, { Y: 'SALA-000001', C: 'OTRA' })], [sala()])
    expect(p.celdas.some((c) => c.celda === 'Y2')).toBe(false)
  })

  it('manda la matrícula aunque el nombre no cuadre: renombrar no duplica', () => {
    const p = estado([fila(2, { Y: 'SALA-000001', C: 'nombre viejo' })], [sala({ code: '0.1P' })])
    expect(p.sinCruzar).toEqual([])
    // Y el código nuevo baja a la celda.
    expect(p.celdas).toContainEqual({ celda: 'C2', valor: '0.1P' })
  })

  it('una fila con datos y sin aula se cuenta y no se toca', () => {
    const p = estado([fila(2, { Q: '04204618NB' })], [sala()])
    expect(p.sinCruzar).toHaveLength(1)
    expect(p.sinCruzar[0]!.motivo).toMatch(/no dice de qué aula/)
    expect(p.celdas.filter((c) => c.celda.endsWith('2'))).toEqual([])
  })

  it('la segunda fila de un aula con dos proyectores se reconoce como continuación', () => {
    const p = estado(
      [
        fila(2, { A: 'EDIFICIO P', C: '0.1P', Y: 'SALA-000001', M: 'SN-1' }),
        fila(3, { M: 'SN-2', L: 'otro modelo' }),
      ],
      [sala()],
    )
    expect(p.sinCruzar).toHaveLength(1)
    expect(p.sinCruzar[0]!.motivo).toContain('continúa la fila de «0.1P»')
  })

  it('una fila entera vacía no es nada: ni cruce ni aviso', () => {
    const p = estado([fila(2, {})], [sala()])
    expect(p.sinCruzar).toEqual([])
  })

  it('el edificio y la planta se arrastran hacia abajo', () => {
    // La segunda fila los lleva en blanco, como 10 filas del libro real.
    const p = estado(
      [
        fila(2, { A: 'EDIFICIO P', B: 'PLANTA BAJA', C: 'otra' }),
        fila(3, { C: '0.1P' }),
      ],
      [sala()],
    )
    expect(p.sinCruzar.map((s) => s.fila)).not.toContain(3)
  })

  it('una sala archivada se lleva su fila del libro', () => {
    const p = estado([fila(2, { Y: 'SALA-000001' })], [sala({ activa: false })])
    expect(p.borrar).toEqual([2])
    expect(p.avisos.join(' ')).toMatch(/archivada/)
    // Y se cuenta como fila que sale, con su aula y su motivo, para la pantalla.
    expect(p.filasQueSalen).toEqual([expect.objectContaining({ fila: 2, destino: '0.1P' })])
    expect(p.filasQueSalen[0]!.motivo).toMatch(/archivada/)
  })

  it('la matrícula que se escribe se cuenta como celda al Excel, con su porqué', () => {
    const p = estado([fila(2, { A: 'EDIFICIO P', C: '0.1P' })], [sala()])
    expect(p.haciaElExcel).toContainEqual(
      expect.objectContaining({ fila: 2, letra: 'Y', cabecera: 'Ref', destino: '0.1P', valor: 'SALA-000001' }),
    )
  })

  it('dos filas para la misma sala: la segunda se cuenta y no se toca', () => {
    const p = estado(
      [fila(2, { Y: 'SALA-000001' }), fila(3, { Y: 'SALA-000001' })],
      [sala()],
    )
    expect(p.sinCruzar).toHaveLength(1)
    expect(p.sinCruzar[0]!.fila).toBe(3)
  })

  it('una sala nueva entra en el bloque de su edificio', () => {
    const p = estado(
      [
        fila(2, { A: 'EDIFICIO P', C: '0.1P', Y: 'SALA-000001' }),
        fila(3, { A: 'EDIFICIO H', C: '1.7', Y: 'SALA-000009' }),
      ],
      [
        sala(),
        sala({ id: 'r9', shortRef: 'SALA-000009', edificio: 'EDIFICIO H', code: '1.7' }),
        sala({ id: 'r2', shortRef: 'SALA-000002', edificio: 'EDIFICIO P', code: '0.9P' }),
      ],
    )
    expect(p.insertar).toHaveLength(1)
    // Detrás de la 2, que es la última del EDIFICIO P: no al final de la hoja.
    expect(p.insertar[0]!.tras).toBe(2)
    expect(p.avisos.join(' ')).toMatch(/entra en el bloque/)
    expect(p.filasQueEntran).toEqual([
      expect.objectContaining({ que: 'Sala', destino: '0.9P', donde: expect.stringContaining('EDIFICIO P') }),
    ])
  })

  it('dentro de un bloque, la fila nueva lleva también el edificio y la planta', () => {
    // Antes se dejaban en blanco para imitar el libro de siempre; una fila sin
    // edificio no se puede filtrar, y el libro reformateado los lleva en todas.
    const p = estado(
      [fila(2, { A: 'EDIFICIO P', C: '0.1P', Y: 'SALA-000001' })],
      [sala(), sala({ id: 'r2', shortRef: 'SALA-000002', code: '0.9P' })],
    )
    const celdas = p.insertar[0]!.celdas
    expect(celdas.find((c) => c.celda === 'A3')?.valor).toBe('EDIFICIO P')
    expect(celdas.find((c) => c.celda === 'B3')?.valor).toBe('PLANTA BAJA')
    expect(celdas.map((c) => c.celda)).toContain('C3')
  })

  it('un edificio que no está en la hoja abre bloque al final, con su nombre', () => {
    const p = estado(
      [fila(2, { A: 'EDIFICIO P', C: '0.1P', Y: 'SALA-000001' })],
      [sala(), sala({ id: 'r3', shortRef: 'SALA-000003', edificio: 'EDIFICIO NUEVO', code: '9.9' })],
    )
    expect(p.insertar).toHaveLength(1)
    expect(p.insertar[0]!.celdas).toContainEqual({ celda: 'A3', valor: 'EDIFICIO NUEVO' })
    expect(p.avisos.join(' ')).toMatch(/abre bloque/)
  })

  it('lo sucio va a cuarentena y no se interpreta', () => {
    const p = estado([fila(2, { Y: 'SALA-000001', F: 'No tiene', D: '19/0672025' })], [sala()])
    expect(p.cuarentena.map((c) => c.letra).sort()).toEqual(['D', 'F'])
    // Y ninguna de las dos se escribe en la base.
    expect(p.haciaLaBase.map((h) => h.letra)).not.toContain('F')
  })

  it('el asterisco de una celda de horas es un vacío, no cuarentena', () => {
    const p = estado([fila(2, { Y: 'SALA-000001', F: '********' })], [sala()])
    expect(p.cuarentena.map((c) => c.letra)).not.toContain('F')
    // La celda estaba vacía y la app tiene el dato: baja al Excel.
    expect(p.celdas).toContainEqual({ celda: 'F2', valor: 921 })
  })

  it('la fecha de revisión anterior es de la app y baja siempre', () => {
    const p = estado([fila(2, { Y: 'SALA-000001', E: fechaAExcel('2020-01-01') })], [sala()])
    expect(p.celdas).toContainEqual({ celda: 'E2', valor: fechaAExcel('2024-06-03'), formato: 'fecha' })
  })

  it('en las horas gana la medición más reciente, no el último en escribir', () => {
    const antes: Instantanea = (ref, l) => (ref === 'SALA-000001' && l === 'F' ? 100 : undefined)
    // El Excel dice 5000 con fecha vieja; la app 921 con fecha de 2025.
    const p = estado(
      [fila(2, { Y: 'SALA-000001', F: 5000, D: fechaAExcel('2020-01-01') })],
      [sala()],
      antes,
    )
    expect(p.celdas).toContainEqual({ celda: 'F2', valor: 921 })
  })

  it('y si la lectura del Excel es la más nueva, entra en la base', () => {
    const antes: Instantanea = (ref, l) => (ref === 'SALA-000001' && l === 'F' ? 100 : undefined)
    const p = estado(
      [fila(2, { Y: 'SALA-000001', F: 5000, D: fechaAExcel('2030-01-01') })],
      [sala()],
      antes,
    )
    expect(p.haciaLaBase.find((h) => h.letra === 'F')?.valor).toBe(5000)
  })

  it('los dos lados cambiados a cosas distintas no tocan ninguno', () => {
    const antes: Instantanea = (ref, l) => (ref === 'SALA-000001' && l === 'K' ? 'Actualizada' : undefined)
    const p = estado([fila(2, { Y: 'SALA-000001', K: 'No tiene' })], [sala()], antes)
    expect(p.conflictos).toHaveLength(1)
    expect(p.celdas.some((c) => c.celda === 'K2')).toBe(false)
    // Y el conflicto no deja rastro en la instantánea: si lo dejara, la pasada
    // siguiente creería que se resolvió solo.
    expect(p.instantanea.some((c) => c.letra === 'K' && c.clave === 'SALA-000001')).toBe(false)
  })

  it('la instantánea se guarda por matrícula, no por fila', () => {
    // Entre dos pasadas alguien ordena la hoja por edificio y la 2 pasa a ser la
    // 9. Un antepasado buscado por número de fila sería el de otra aula.
    const antes: Instantanea = (ref, l) =>
      ref === 'SALA-000001' && l === 'K' ? 'Actualizada' : undefined

    const enLa2 = estado([fila(2, { Y: 'SALA-000001', K: 'Actualizada' })], [sala()], antes)
    const enLa9 = estado([fila(9, { Y: 'SALA-000001', K: 'Actualizada' })], [sala()], antes)

    // La misma sala en otra fila da la misma decisión y la misma clave.
    expect(enLa2.instantanea.find((c) => c.letra === 'K')!.clave).toBe('SALA-000001')
    expect(enLa9.instantanea.find((c) => c.letra === 'K')!.clave).toBe('SALA-000001')
    expect(enLa2.conflictos).toEqual(enLa9.conflictos)
  })

  it('el número de serie del proyector baja del equipo de la sala', () => {
    const p = estado(
      [fila(2, { Y: 'SALA-000001' })],
      [
        sala({
          equipos: [
            { id: 'a1', tipo: 'Proyector', serial: '0340985RL', model: 'NP-M403 HG', desde: '2024-01-01' },
          ],
        }),
      ],
    )
    expect(p.celdas).toContainEqual({ celda: 'M2', valor: '0340985RL' })
    expect(p.celdas).toContainEqual({ celda: 'L2', valor: 'NP-M403 HG' })
  })

  it('TV y Monitor van a columnas distintas', () => {
    const p = estado(
      [fila(2, { Y: 'SALA-000001' })],
      [
        sala({
          equipos: [
            { id: 'a1', tipo: 'TV', serial: '04204664NB', model: 'NEC E657Q', desde: '2024-01-01' },
            { id: 'a2', tipo: 'Monitor', serial: 'V305T6VL', model: null, desde: '2024-01-01' },
          ],
        }),
      ],
    )
    expect(p.celdas).toContainEqual({ celda: 'Q2', valor: '04204664NB' })
    expect(p.celdas).toContainEqual({ celda: 'R2', valor: 'V305T6VL' })
  })

  it('el micrófono con número de serie escribe la serie, no un SÍ', () => {
    const p = estado(
      [fila(2, { Y: 'SALA-000001' })],
      [
        sala({
          equipos: [{ id: 'a1', tipo: 'Micrófono', serial: '294150186', model: null, desde: '2024-01-01' }],
        }),
      ],
    )
    expect(p.celdas).toContainEqual({ celda: 'J2', valor: '294150186' })
  })

  it('de una sala con dos proyectores enseña el más nuevo', () => {
    const p = estado(
      [fila(2, { Y: 'SALA-000001' })],
      [
        sala({
          equipos: [
            { id: 'a1', tipo: 'Proyector', serial: 'VIEJO', model: null, desde: '2020-01-01' },
            { id: 'a2', tipo: 'Proyector', serial: 'NUEVO', model: null, desde: '2025-01-01' },
          ],
        }),
      ],
    )
    expect(p.celdas).toContainEqual({ celda: 'M2', valor: 'NUEVO' })
  })

  it('no reescribe un SÍ que ya dice lo mismo con otra grafía', () => {
    const p = estado([fila(2, { Y: 'SALA-000001', H: 'sí' })], [sala()])
    expect(p.celdas.some((c) => c.celda === 'H2')).toBe(false)
  })
})

// -----------------------------------------------------------------------------

function incidencia(over: Partial<IncidenciaVolcada> = {}): IncidenciaVolcada {
  return {
    id: 'i1',
    numero: 'I260102_0002',
    salaCode: '0.1 BC',
    abierta: '2026-01-02',
    resuelta: '2026-01-02',
    problema: 'No duplica la imagen',
    observacion: null,
    resolucion: 'Se sustituye el cable',
    material: '1 Cable HDMI fibra 15 m',
    esParte: true,
    materialApuntado: [{ articuloId: 's1', cantidad: 1 }],
    ...over,
  }
}

const CAB_PARTES = fila(
  1,
  Object.fromEntries(MATERIAL_2026.columnas.map((c) => [c.letra, c.cabecera])),
)

describe('la hoja de partes', () => {
  it('cruza por número de incidencia', () => {
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [CAB_PARTES, fila(2, { D: 'I260102_0002', A: '0.1 BC' })],
      incidencias: [incidencia()],
    })
    expect(p.sinCruzar).toEqual([])
    expect(p.celdas).toContainEqual({ celda: 'G2', valor: '1 Cable HDMI fibra 15 m' })
  })

  it('un parte que la aplicación no conoce se cuenta y se deja intacto', () => {
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [CAB_PARTES, fila(2, { D: 'I250101_0001' })],
      incidencias: [incidencia()],
    })
    expect(p.sinCruzar).toHaveLength(1)
    expect(p.celdas.filter((c) => c.celda.endsWith('2'))).toEqual([])
    expect(p.borrar).toEqual([])
  })

  it('un número de incidencia con espacios de sobra se reconoce a sí mismo', () => {
    // La fila 101 del libro real lleva dos números en la misma celda separados
    // por 38 espacios. Si las dos caras no se normalizan igual, ese parte no se
    // encuentra entre dos pasadas y se vuelve a añadir cada vez.
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [CAB_PARTES, fila(2, { D: 'I260415_0029   I260414_0007' })],
      incidencias: [incidencia({ numero: 'I260415_0029                    I260414_0007' })],
    })
    expect(p.sinCruzar).toEqual([])
    expect(p.insertar).toEqual([])
  })

  it('los partes nuevos de la aplicación se añaden al final', () => {
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [CAB_PARTES, fila(2, { D: 'I260102_0002' })],
      incidencias: [incidencia(), incidencia({ id: 'i2', numero: 'I260315_0011' })],
    })
    expect(p.insertar).toHaveLength(1)
    expect(p.insertar[0]!.tras).toBe(2)
    expect(p.insertar[0]!.celdas).toContainEqual({ celda: 'D3', valor: 'I260315_0011' })
  })

  it('una hoja congelada no recibe ni una celda ni siquiera por un hueco', () => {
    // La regla del hueco —gana quien tiene el dato— dispara antes que la del
    // dueño. Sin la guarda, una columna `solo_excel` vacía con dato en la app
    // acaba escribiendo sobre un cierre ya rendido.
    const cab = fila(1, Object.fromEntries(MATERIAL_2025.columnas.map((c) => [c.letra, c.cabecera])))
    const p = sincronizarPartes({
      hoja: MATERIAL_2025,
      // Fila con su número de incidencia y todo lo demás vacío.
      filas: [cab, fila(2, { D: 'I260102_0002' })],
      incidencias: [incidencia()],
    })
    expect(p.celdas).toEqual([])
  })

  it('el antepasado de una celda que se escribe va marcado: describe el libro que saldrá', () => {
    // No es lo mismo «el Excel decía X» que «el Excel va a decir X cuando
    // alguien suba el fichero». Lo segundo, guardado antes de tiempo, hace que
    // una pasada que no llega a terminar deje la base creyendo que el Excel vale
    // A cuando vale V — y la siguiente mete la V en la base.
    const cab = fila(1, Object.fromEntries(MATERIAL_2026.columnas.map((c) => [c.letra, c.cabecera])))
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [cab, fila(2, { D: 'I260102_0002' })],
      incidencias: [incidencia({ numero: 'I260102_0002', problema: 'No enciende' })],
    })
    const escrita = p.instantanea.find((c) => c.letra === 'E')
    const leida = p.instantanea.find((c) => c.letra === 'D')
    expect(p.celdas).toContainEqual({ celda: 'E2', valor: 'No enciende' })
    expect(escrita?.trasEscribir).toBe(true)
    // Y la que solo se leyó, no: ésa es un hecho y se puede guardar ya.
    expect(leida?.trasEscribir).toBeUndefined()
  })

  it('una celda en cuarentena deja antepasado, para que el arreglo no se pise', () => {
    // Sin antepasado, una celda que ya vino sucia en la primera pasada se queda
    // sin él para siempre; el día que alguien la arregla, la fusión cae en
    // «primera pasada: manda la app» y le escribe encima. El arreglo se pierde
    // sin salir ni como choque ni como aviso.
    const cab = fila(1, Object.fromEntries(MATERIAL_2026.columnas.map((c) => [c.letra, c.cabecera])))
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [cab, fila(2, { D: 'I260102_0002', B: '19/0672025' })],
      incidencias: [incidencia({ numero: 'I260102_0002' })],
    })
    expect(p.cuarentena.map((c) => c.letra)).toContain('B')
    expect(p.instantanea).toContainEqual({
      clave: 'I260102_0002',
      fila: 2,
      letra: 'B',
      valor: '19/0672025',
    })
  })

  it('lo que no se vuelve a leer igual no se escribe: si no, es un bucle', () => {
    // `leer` trata «-», «***» y «?» como vacíos escritos a mano —lo son— y
    // `escribir` los metía tal cual. Si la base guarda uno de esos en una
    // columna de texto: se escribe «-», la pasada siguiente lo lee como vacío,
    // la regla del hueco dice «la celda estaba vacía» y lo vuelve a escribir.
    // Sin fin, y sin que el antepasado lo pare, porque guardaba «-» y lo leído
    // es null.
    const cab = fila(1, Object.fromEntries(MATERIAL_2026.columnas.map((c) => [c.letra, c.cabecera])))
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [cab, fila(2, { D: 'I260102_0002' })],
      incidencias: [incidencia({ numero: 'I260102_0002', problema: '-' })],
    })
    expect(p.celdas.filter((c) => c.celda.startsWith('E'))).toEqual([])
    expect(p.avisos.join(' ')).toContain('deje de leerse igual')
  })

  it('pero un texto normal se sigue escribiendo', () => {
    const cab = fila(1, Object.fromEntries(MATERIAL_2026.columnas.map((c) => [c.letra, c.cabecera])))
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [cab, fila(2, { D: 'I260102_0002' })],
      incidencias: [incidencia({ numero: 'I260102_0002', problema: 'No enciende' })],
    })
    expect(p.celdas).toContainEqual({ celda: 'E2', valor: 'No enciende' })
  })

  it('una fila insertada deja antepasado, para que mañana no se pise una corrección', () => {
    // Sin antepasado manda la app, así que si alguien corrige a mano una celda
    // de la fila recién insertada, la pasada siguiente se la comía sin decir
    // nada. Con el antepasado puesto, esa pasada ve que el Excel se movió y la
    // base no, y la corrección entra.
    const cab = fila(1, Object.fromEntries(MATERIAL_2026.columnas.map((c) => [c.letra, c.cabecera])))
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [cab],
      incidencias: [incidencia({ numero: 'I260315_0011', problema: 'No enciende' })],
    })
    expect(p.insertar).toHaveLength(1)

    const suyas = p.instantanea.filter((c) => c.clave === 'I260315_0011')
    expect(suyas.length).toBeGreaterThan(0)
    expect(suyas).toContainEqual({ clave: 'I260315_0011', fila: 0, letra: 'E', valor: 'No enciende' })
    // La fila va a cero: no estaba en ninguna del libro que se leyó, y `claveDe`
    // busca por número de fila para resolver a qué habla una corrección.
    expect(suyas.every((c) => c.fila === 0)).toBe(true)
  })

  it('una hoja congelada tampoco escribe en la base: ni comprado, ni meses', () => {
    // Es la dirección que faltaba. «Bolsa 2025» tiene sus columnas en
    // `solo_excel` y se dejaban pasar hacia la base para sembrar lo que 2025
    // sabía y la aplicación no. Pero una celda no lleva fecha: `Comprado` de
    // 2025 entraba como una compra fechada hoy, los meses no tienen dónde
    // entrar, y ninguno de los dos se calla nunca porque la base no los
    // devuelve como están escritos. Sobre el libro real eran 65 celdas por
    // pasada, para siempre.
    const cab = fila(1, Object.fromEntries(BOLSA_2025.columnas.map((c) => [c.letra, c.cabecera])))
    const art = articulo({ nombre: 'Cable HDMI fibra 10 m', meses: [9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], comprado: 4 })
    const p = sincronizarBolsa({
      hoja: BOLSA_2025,
      filas: [cab, fila(2, { A: 'Cable HDMI fibra 10 m', B: 3, W: 40 })],
      articulos: [art],
      resolver: () => art.id,
    })
    expect(p.haciaLaBase).toEqual([])
    expect(p.celdas).toEqual([])
    expect(p.cuarentena).toEqual([])
  })

  it('la hoja de 2025 está congelada: se lee y no se escribe', () => {
    const cab = fila(1, Object.fromEntries(MATERIAL_2025.columnas.map((c) => [c.letra, c.cabecera])))
    const p = sincronizarPartes({
      hoja: MATERIAL_2025,
      filas: [cab, fila(2, { D: 'I260102_0002', H: 'otra cosa' })],
      incidencias: [incidencia()],
    })
    expect(p.celdas).toEqual([])
    expect(p.insertar).toEqual([])
  })

  // Las «líneas raras con código»: la base numera también las observaciones y
  // los borradores, y por ese número la hoja de partes los añadía al final como
  // si fueran partes — una fila con un código y sin problema.
  it('una observación o un borrador de la aplicación no se añaden a la hoja de partes', () => {
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [CAB_PARTES, fila(2, { D: 'I260102_0002' })],
      incidencias: [
        incidencia(),
        incidencia({ id: 'obs', numero: 'I260315_0011', problema: 'El mando está en el cajón', esParte: false }),
        incidencia({ id: 'borrador', numero: 'I260316_0001', problema: null, esParte: false }),
      ],
    })
    expect(p.insertar).toEqual([])
    expect(p.filasQueEntran).toEqual([])
  })

  it('y si una pasada anterior ya las escribió, salen del libro', () => {
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [CAB_PARTES, fila(2, { D: 'I260102_0002' }), fila(3, { D: 'I260315_0011', E: 'El mando está en el cajón' })],
      incidencias: [incidencia(), incidencia({ id: 'obs', numero: 'I260315_0011', esParte: false })],
    })
    expect(p.borrar).toEqual([3])
    expect(p.filasQueSalen).toEqual([expect.objectContaining({ fila: 3, destino: 'I260315_0011' })])
    expect(p.filasQueSalen[0]!.motivo).toMatch(/observación/)
    expect(p.sinCruzar).toEqual([])
  })

  it('en la hoja congelada se cuentan y se dejan, como todo lo demás', () => {
    const cab = fila(1, Object.fromEntries(MATERIAL_2025.columnas.map((c) => [c.letra, c.cabecera])))
    const p = sincronizarPartes({
      hoja: MATERIAL_2025,
      filas: [cab, fila(2, { D: 'I250315_0011' })],
      incidencias: [incidencia({ id: 'obs', numero: 'I250315_0011', esParte: false })],
    })
    expect(p.borrar).toEqual([])
    expect(p.sinCruzar).toHaveLength(1)
  })

  it('cada parte nuevo que se añade se cuenta con su número y de qué habla', () => {
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [CAB_PARTES, fila(2, { D: 'I260102_0002' })],
      incidencias: [incidencia(), incidencia({ id: 'i2', numero: 'I260315_0011', problema: 'Sin ratón' })],
    })
    expect(p.filasQueEntran).toEqual([
      expect.objectContaining({ que: 'Parte', destino: 'I260315_0011', donde: expect.stringContaining('Sin ratón') }),
    ])
  })

  it('lo que se escribe en la hoja se cuenta con su aula, su columna, lo que decía y por qué', () => {
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [CAB_PARTES, fila(2, { D: 'I260102_0002', A: '0.1 BC', G: '2 Cable HDMI' })],
      incidencias: [incidencia()],
    })
    expect(p.haciaElExcel).toContainEqual({
      fila: 2,
      letra: 'G',
      cabecera: 'Material Usado',
      destino: 'I260102_0002',
      antes: '2 Cable HDMI',
      valor: '1 Cable HDMI fibra 15 m',
      motivo: 'primera pasada: sin instantánea previa manda la app',
    })
    // Y las mismas celdas que el parcheador va a escribir, ni una más.
    expect(p.haciaElExcel.map((h) => `${h.letra}${h.fila}`).sort()).toEqual(p.celdas.map((c) => c.celda).sort())
  })

  it('con «manda el Excel» elegido al cargar, la primera pasada entra en la base', () => {
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [CAB_PARTES, fila(2, { D: 'I260102_0002', G: '2 Cable HDMI' })],
      incidencias: [incidencia()],
      referencia: 'excel',
    })
    expect(p.haciaLaBase).toContainEqual(expect.objectContaining({ letra: 'G', valor: '2 Cable HDMI' }))
    expect(p.celdas.some((c) => c.celda === 'G2')).toBe(false)
  })
})

// -----------------------------------------------------------------------------

function articulo(over: Partial<ArticuloVolcado> = {}): ArticuloVolcado {
  return {
    id: 's1',
    nombre: 'Cable HDMI fibra 10 m',
    meses: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    comprado: 28,
    ...over,
  }
}

const CAB_BOLSA = fila(
  1,
  Object.fromEntries(BOLSA_2026.columnas.map((c) => [c.letra, c.cabecera])),
)

function bolsa(filas: FilaLeida[], articulos: ArticuloVolcado[]) {
  return sincronizarBolsa({
    hoja: BOLSA_2026,
    filas: [CAB_BOLSA, ...filas],
    articulos,
    resolver: (nombre) =>
      articulos.find((a) => a.nombre.toLowerCase() === nombre.toLowerCase())?.id ?? null,
  })
}

describe('la hoja de bolsa', () => {
  it('rellena los meses desde el arranque del recuento; los de antes son del libro', () => {
    // Agosto lo escribe la aplicación. Enero es de antes de que llevara el
    // almacén: aunque tenga un consumo apuntado, la celda se queda como está.
    const p = bolsa(
      [fila(2, { A: 'Cable HDMI fibra 10 m' })],
      [articulo({ meses: [1, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0] })],
    )
    expect(p.celdas).toContainEqual({ celda: 'I2', valor: 2 })
    expect(p.celdas.filter((c) => c.celda === 'B2')).toEqual([])
    expect(p.haciaLaBase.filter((h) => h.campo === 'mes:1')).toEqual([])
  })

  it('no le devuelve la fórmula a una celda si la fórmula daría otra cosa', () => {
    // Las tres del libro real: N5=3, N8=2 y N9=1 con los doce meses en blanco.
    // Son seis unidades de consumo que alguien apuntó como total sin desglosar y
    // que no están en ninguna otra celda ni en la base. Poner ahí `=B5+…+M5`,
    // con la aplicación escribiendo ceros porque no tiene movimientos, convierte
    // el 3 en un 0 sin dejar rastro. Eso no es devolver una fórmula: es borrar.
    const art = articulo({ nombre: 'Cable HDMI 3 mts', meses: new Array(12).fill(0), comprado: 10 })
    const p = bolsa([fila(2, { A: 'Cable HDMI 3 mts', N: 3 })], [art])

    // Ni el total ni los meses: rellenar los meses con ceros al lado de un total
    // escrito a mano afirma que no hubo consumo, que es lo contrario del total.
    expect(p.celdas.filter((c) => /^[B-N]2$/.test(c.celda))).toEqual([])
    expect(p.avisos.join(' ')).toContain('no está en ningún otro sitio')
  })

  it('pero sí se la devuelve cuando la fórmula da lo mismo', () => {
    const meses = [1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    const art = articulo({ nombre: 'Cable HDMI 3 mts', meses, comprado: 10 })
    const p = bolsa([fila(2, { A: 'Cable HDMI 3 mts', N: 3 })], [art])
    expect(p.celdas).toContainEqual({ celda: 'N2', valor: '=B2+C2+D2+E2+F2+G2+H2+I2+J2+K2+L2+M2' })
  })

  it('una celda que ya trae su fórmula no se toca', () => {
    const p = bolsa(
      [fila(2, { A: 'Cable HDMI fibra 10 m', N: '=B2+C2+D2+E2+F2+G2+H2+I2+J2+K2+L2+M2' })],
      [articulo()],
    )
    expect(p.celdas.some((c) => c.celda === 'N2')).toBe(false)
  })

  it('un artículo que no está en el catálogo se cuenta y no se toca', () => {
    const p = bolsa([fila(2, { A: 'Cosa rara' })], [articulo()])
    expect(p.sinCruzar).toHaveLength(1)
    expect(p.celdas.filter((c) => c.celda.endsWith('2'))).toEqual([])
  })

  it('un artículo nuevo entra con su fórmula, no con un número', () => {
    const p = bolsa(
      [fila(2, { A: 'Cable HDMI fibra 10 m' })],
      [articulo(), articulo({ id: 's2', nombre: 'Teclado', meses: new Array(12).fill(0), comprado: 10 })],
    )
    expect(p.insertar).toHaveLength(1)
    const celdas = p.insertar[0]!.celdas
    expect(celdas).toContainEqual({ celda: 'A3', valor: 'Teclado' })
    // Con `{f}` sin resolver: el número de fila lo pone el editor al escribir,
    // que es el único que sabe dónde cae cada fila nueva. Resuelto aquí, la
    // segunda fila nueva sumaba la fila de la primera.
    expect(celdas).toContainEqual({ celda: 'O3', valor: '=P{f}-N{f}' })
  })

  it('la segunda columna de nombre no se toca: de ahí salen los alias', () => {
    const p = bolsa(
      [fila(2, { A: 'Cable HDMI fibra 10 m', Q: 'Cable HDMI Fibra 10 metros' })],
      [articulo()],
    )
    expect(p.celdas.some((c) => c.celda === 'Q2')).toBe(false)
    // Y como la base no lo tiene, entra hacia la base.
    expect(p.haciaLaBase.find((h) => h.letra === 'Q')?.valor).toBe('Cable HDMI Fibra 10 metros')
  })
})

// -----------------------------------------------------------------------------

describe.skipIf(!bytes)('una pasada entera contra el libro real', () => {
  it('cruza, no revienta y deja claro qué queda fuera', async () => {
    const l = await abrirLibro(new Uint8Array(bytes!))
    const filas = await leerHoja(l, ESTADO.nombre)
    const colRef = columnaParaLaRef(filas, 1, 'Ref')

    // El maestro se construye desde el propio libro: es lo que habría en la base
    // después de importarlo, que es de donde salió.
    const salas: SalaVolcada[] = []
    const conocidas: Catalogo['salas'] = []
    const edificios = new Map<string, string>()
    let edificio = ''
    let zona = ''
    let n = 0
    for (const f of filas) {
      if (f.fila === 1) continue
      const t = (k: string): string => String(f.celdas[k] ?? '').trim()
      if (t('A') !== '') edificio = t('A')
      if (t('B') !== '') zona = t('B')
      const aula = t('C')
      if (aula === '' || edificio === '') continue
      n++
      const shortRef = `SALA-${String(n).padStart(6, '0')}`
      const codigo = edificio.replace(/\s+/g, ' ').trim()
      edificios.set(codigo, codigo)
      salas.push({
        id: `r${n}`,
        shortRef,
        edificio,
        zona,
        code: aula,
        activa: true,
        projectorHours: null,
        lampPct: null,
        botoneraEstado: null,
        capacidades: {},
        revisiones: [],
        notas: null,
        equipos: [],
      })
      conocidas.push({
        id: `r${n}`,
        shortRef,
        code: aula,
        name: aula,
        active: true,
        zona,
        edificioCodigo: codigo,
        edificioNombre: edificio,
        edificioActivo: true,
        alias: [],
      })
    }

    const plan = sincronizarEstado({
      hoja: ESTADO,
      filas,
      salas,
      indice: construirIndice({
        salas: conocidas,
        edificios: [...edificios.values()].map((c) => ({ codigo: c, nombre: c, activo: true })),
        edificiosDesaparecidos: [],
      }),
      columnaRef: colRef,
      instantanea: SIN_INSTANTANEA,
    })

    expect(plan.desajustes).toEqual([])
    // Las 276 salas con edificio y aula cruzan; lo que queda fuera son las filas
    // sin código de aula, que no son salas.
    expect(salas.length).toBeGreaterThan(250)
    expect(plan.sinCruzar.length).toBeLessThan(25)
    for (const s of plan.sinCruzar) expect(s.motivo).toBeTruthy()
    // Ninguna fila se borra: en este montaje no hay salas archivadas.
    expect(plan.borrar).toEqual([])

    // El invariante que importa: **ninguna sala se pierde**. O se le escribe la
    // matrícula en la fila que ya tenía, o se le abre una fila nueva. La suma de
    // las dos cosas son todas las salas, siempre.
    // Sin contar la cabecera de la columna, que también se escribe.
    const conMatricula = plan.celdas.filter(
      (c) => c.celda.startsWith(colRef) && c.celda !== `${colRef}1`,
    ).length
    expect(conMatricula + plan.insertar.length).toBe(salas.length)

    // Y la que no cruza es una sola, la de la errata del edificio: la fila 86
    // dice `EDIFICO E` y el maestro de esta prueba la dio de alta con la errata,
    // mientras que el cruce la corrige a `EDIFICIO E`. El motor no la adivina y
    // lo explica, que es justo lo que tiene que hacer. Las filas sin aula y las
    // de continuación —el segundo proyector de un aula de dos filas— no cuentan:
    // se explican solas.
    const explicadas = /no dice de qué aula|continúa la fila de/
    const sinAula = plan.sinCruzar.filter((s) => explicadas.test(s.motivo))
    expect(plan.sinCruzar.length - sinAula.length).toBe(1)
    expect(plan.sinCruzar.find((s) => !explicadas.test(s.motivo))!.motivo).toMatch(/EDIFICO E/)
  })

  it('una segunda pasada sobre su propia salida no escribe NADA', async () => {
    // Es la prueba que decide si el registro es perfecto. Si la segunda pasada
    // escribe algo, el libro y la base nunca se quedan quietos: cada
    // sincronización produce una versión nueva en SharePoint aunque no haya
    // pasado nada, y el historial de versiones deja de servir para saber qué
    // cambió de verdad.
    const { escribirLibro } = await import('./libro')
    const { celdasCombinadas } = await import('./xlsx')

    // El maestro se construye UNA vez y no cambia entre pasadas, que es lo que
    // hace la aplicación: las matrículas salen de la base, no de la hoja.
    const l0 = await abrirLibro(new Uint8Array(bytes!))
    const filas0 = await leerHoja(l0, ESTADO.nombre)
    const salas: SalaVolcada[] = []
    const conocidas: Catalogo['salas'] = []
    const edificios = new Set<string>()
    let ed = ''
    let zona = ''
    let n = 0
    for (const f of filas0) {
      if (f.fila === 1) continue
      const t = (k: string): string => String(f.celdas[k] ?? '').trim()
      if (t('A') !== '') ed = t('A')
      if (t('B') !== '') zona = t('B')
      if (t('C') === '' || ed === '') continue
      n++
      const shortRef = `SALA-${String(n).padStart(6, '0')}`
      edificios.add(ed)
      salas.push({
        id: `r${n}`,
        shortRef,
        edificio: ed,
        zona,
        code: t('C'),
        activa: true,
        projectorHours: n <= 5 ? 4242 + n : null,
        lampPct: null,
        botoneraEstado: null,
        capacidades: {},
        revisiones: n <= 5 ? ['2026-07-15'] : [],
        notas: null,
        equipos: [],
      })
      conocidas.push({
        id: `r${n}`,
        shortRef,
        code: t('C'),
        name: t('C'),
        active: true,
        zona,
        edificioCodigo: ed,
        edificioNombre: ed,
        edificioActivo: true,
        alias: [],
      })
    }
    const ix = construirIndice({
      salas: conocidas,
      edificios: [...edificios].map((c) => ({ codigo: c, nombre: c, activo: true })),
      edificiosDesaparecidos: [],
    })

    const pasada = async (
      entrada: Uint8Array,
      antes: Instantanea,
    ): Promise<{ plan: ReturnType<typeof sincronizarEstado>; salida: Uint8Array }> => {
      const libro = await abrirLibro(entrada)
      const filas = await leerHoja(libro, ESTADO.nombre)
      const plan = sincronizarEstado({
        hoja: ESTADO,
        filas,
        salas,
        indice: ix,
        columnaRef: columnaParaLaRef(filas, 1, 'Ref'),
        combinadas: await celdasCombinadas(libro, ESTADO.nombre),
        instantanea: antes,
      })
      const salida = await escribirLibro(libro, [
        { hoja: ESTADO.nombre, celdas: plan.celdas, filas: { insertar: plan.insertar, borrar: plan.borrar } },
      ])
      return { plan, salida }
    }

    const uno = await pasada(new Uint8Array(bytes!), SIN_INSTANTANEA)
    expect(uno.plan.celdas.length).toBeGreaterThan(100)

    const guardado = new Map<string, unknown>()
    for (const c of uno.plan.instantanea) guardado.set(`${c.clave}!${c.letra}`, c.valor)
    const conInstantanea: Instantanea = (clave, letra) => {
      const k = `${clave}!${letra}`
      return guardado.has(k) ? (guardado.get(k) as never) : undefined
    }

    const dos = await pasada(uno.salida, conInstantanea)
    const sobran = dos.plan.celdas.map((c) => `${c.celda}=${String(c.valor)}`)
    expect(sobran, `celdas que sobran: ${sobran.slice(0, 10).join(', ')}`).toEqual([])
    expect(dos.plan.insertar).toEqual([])
    expect(dos.plan.borrar).toEqual([])
  })

  it('las 88 fórmulas de «Bolsa 2026» siguen siendo fórmulas después de la pasada', async () => {
    // Era el peor fallo de todo el sincronizador y sobrevivía a la prueba de
    // idempotencia porque el destrozo es estable: la primera pasada convertía
    // las 86 celdas de fórmula en su propio texto, y la segunda ya las veía como
    // texto y no las tocaba. Cero diferencias, y la columna sin calcular.
    const { escribirLibro } = await import('./libro')
    const { descomprimir } = await import('../lib/zip')

    const libro = await abrirLibro(new Uint8Array(bytes!))
    const filas = await leerHoja(libro, BOLSA_2026.nombre)
    const articulos: ArticuloVolcado[] = filas
      .filter((f) => f.fila > 1 && f.celdas.A)
      .map((f, i) => ({
        id: `s${i}`,
        nombre: String(f.celdas.A),
        meses: [1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        comprado: typeof f.celdas.P === 'number' ? f.celdas.P : 0,
      }))
    const porNombre = new Map(articulos.map((a) => [a.nombre.toLowerCase(), a.id]))

    const plan = sincronizarBolsa({
      hoja: BOLSA_2026,
      filas,
      articulos,
      resolver: (n) => porNombre.get(n.toLowerCase()) ?? null,
      instantanea: SIN_INSTANTANEA,
    })

    const salida = await escribirLibro(libro, [
      { hoja: BOLSA_2026.nombre, celdas: plan.celdas, filas: { insertar: plan.insertar, borrar: plan.borrar } },
    ])

    const otra = await abrirLibro(salida)
    const ruta = otra.hojas.find((h) => h.nombre === BOLSA_2026.nombre)!.ruta
    const xml = new TextDecoder().decode(
      await descomprimir(otra.entradas.find((e) => e.nombre === ruta)!),
    )

    // Ni una sola celda con el texto de una fórmula dentro.
    expect(xml).not.toMatch(/<is><t[^>]*>=/)
    // Y las que había siguen estando, más las tres que se recuperan.
    const antes = new TextDecoder().decode(
      await descomprimir(libro.entradas.find((e) => e.nombre === ruta)!),
    )
    expect(xml.split('<f').length - 1).toBeGreaterThanOrEqual(antes.split('<f').length - 1)
  })

  it('a una fórmula de verdad no se le dice que está «escrita a mano»', async () => {
    const libro = await abrirLibro(new Uint8Array(bytes!))
    const filas = await leerHoja(libro, BOLSA_2026.nombre)
    const articulos: ArticuloVolcado[] = filas
      .filter((f) => f.fila > 1 && f.celdas.A)
      .map((f, i) => ({ id: `s${i}`, nombre: String(f.celdas.A), meses: new Array(12).fill(0), comprado: 0 }))
    const porNombre = new Map(articulos.map((a) => [a.nombre.toLowerCase(), a.id]))

    const plan = sincronizarBolsa({
      hoja: BOLSA_2026,
      filas,
      articulos,
      resolver: (n) => porNombre.get(n.toLowerCase()) ?? null,
      instantanea: SIN_INSTANTANEA,
    })

    // El libro de septiembre de 2026 tiene ocho celdas con un número tecleado
    // encima de la fórmula: N5, N8, N9 y N27 en «Total Instalado», y O27, O39,
    // O45 y O46 en «Stock Disponible».
    //
    // Con la aplicación sin movimientos —los doce meses a cero, nada comprado—
    // ninguno de esos números se explica, así que **no se tocan**: devolverles
    // la fórmula convertiría cada uno en un cero, y esas unidades no están en
    // ninguna otra celda del libro ni en la base.
    const protegidas = plan.avisos.filter((a) => a.includes('no está en ningún otro sitio'))
    const filasProtegidas = [...new Set(protegidas.map((a) => Number(/^[A-Z]+(\d+)/.exec(a)?.[1])))]
    expect(protegidas).toHaveLength(8)
    expect(protegidas.join(' ')).toContain('N5')
    expect(filasProtegidas.sort((a, b) => a - b)).toEqual([5, 8, 9, 27, 39, 45, 46])

    // Ni el total ni los meses ni el disponible de esas filas.
    for (const f of filasProtegidas) {
      expect(plan.celdas.filter((c) => new RegExp(`^[B-O]${f}$`).test(c.celda))).toEqual([])
    }
    // Y no se escribe ni una celda más de la columna N: las otras 40 filas ya
    // traen su fórmula del original y a una fórmula viva no se la toca.
    expect(plan.celdas.filter((c) => /^N\d+$/.test(c.celda))).toEqual([])
  })

  it('las celdas sucias del libro acaban en cuarentena, no en la base', async () => {
    const l = await abrirLibro(new Uint8Array(bytes!))
    const filas = await leerHoja(l, ESTADO.nombre)
    const colRef = columnaParaLaRef(filas, 1, 'Ref')

    const todas: SalaVolcada[] = []
    const conocidas: Catalogo['salas'] = []
    let edificio = ''
    let n = 0
    for (const f of filas) {
      if (f.fila === 1) continue
      const t = (k: string): string => String(f.celdas[k] ?? '').trim()
      if (t('A') !== '') edificio = t('A')
      if (t('C') === '' || edificio === '') continue
      n++
      const base = {
        id: `r${n}`,
        shortRef: `SALA-${String(n).padStart(6, '0')}`,
        code: t('C'),
        edificio,
      }
      todas.push({
        ...base,
        zona: '',
        activa: true,
        projectorHours: null,
        lampPct: null,
        botoneraEstado: null,
        capacidades: {},
        revisiones: [],
        notas: null,
        equipos: [],
      })
      conocidas.push({
        ...base,
        name: base.code,
        active: true,
        zona: '',
        edificioCodigo: edificio,
        edificioNombre: edificio,
        edificioActivo: true,
        alias: [],
      })
    }

    const plan = sincronizarEstado({
      hoja: ESTADO,
      filas,
      salas: todas,
      indice: construirIndice({
        salas: conocidas,
        edificios: [...new Set(conocidas.map((c) => c.edificioCodigo))].map((c) => ({
          codigo: c,
          nombre: c,
          activo: true,
        })),
        edificiosDesaparecidos: [],
      }),
      columnaRef: colRef,
      instantanea: SIN_INSTANTANEA,
    })

    // Las tres fechas ilegibles y el 86 mal escrito son cuarentena de verdad.
    const letras = new Set(plan.cuarentena.map((c) => c.letra))
    expect(letras.has('D')).toBe(true)
    // Nada de lo que está en cuarentena se propone escribir en la base.
    for (const q of plan.cuarentena) {
      expect(plan.haciaLaBase.some((h) => h.fila === q.fila && h.letra === q.letra)).toBe(false)
    }
    // Ni en el Excel.
    for (const q of plan.cuarentena) {
      expect(plan.celdas.some((c) => c.celda === `${q.letra}${q.fila}`)).toBe(false)
    }
  })
})

// -----------------------------------------------------------------------------
// Mudanzas, salas de dos filas, cruce por serial y rótulos de bloque
// -----------------------------------------------------------------------------

describe('una sala que cambia de edificio se muda de bloque', () => {
  // Dos edificios conocidos, para que el cruce pueda distinguir «otro edificio»
  // de «este edificio con otro nombre».
  const conO: Catalogo = {
    ...catalogo,
    salas: [...catalogo.salas],
    edificios: [
      { codigo: 'P', nombre: 'EDIFICIO P', activo: true },
      { codigo: 'O', nombre: 'EDIFICIO O', activo: true },
    ],
  }
  const ixPO = construirIndice(conO)
  const estadoPO = (filas: FilaLeida[], salas: SalaVolcada[], combinadas: string[] = []) =>
    sincronizarEstado({ hoja: ESTADO, filas: [CABECERA, ...filas], salas, indice: ixPO, columnaRef: 'Y', combinadas, instantanea: SIN_INSTANTANEA })

  it('la fila sale de su bloque y entra en el del edificio nuevo, con matrícula', () => {
    const p = estadoPO(
      [fila(2, { A: 'EDIFICIO P', B: 'PLANTA BAJA', C: '0.1P', Y: 'SALA-000001', M: 'SN-1' })],
      [sala({ edificio: 'EDIFICIO O' })],
    )
    expect(p.borrar).toEqual([2])
    expect(p.insertar).toHaveLength(1)
    const celdas = p.insertar[0]!.celdas.map((c) => [c.celda.replace(/\d+$/, ''), c.valor])
    expect(celdas).toContainEqual(['A', 'EDIFICIO O'])
    expect(celdas).toContainEqual(['Y', 'SALA-000001'])
    expect(p.avisos.some((a) => a.includes('se muda'))).toBe(true)
    // Y no se escribe nada en la fila que se va.
    expect(p.celdas.filter((c) => c.celda.endsWith('2'))).toEqual([])
  })

  it('pero un edificio que el maestro no conoce es un renombrado, no una mudanza', () => {
    const p = estadoPO(
      [fila(2, { A: 'EDIFICIO VIEJO', C: '0.1P', Y: 'SALA-000001' })],
      [sala({ edificio: 'EDIFICIO P' })],
    )
    expect(p.borrar).toEqual([])
    expect(p.celdas).toContainEqual({ celda: 'A2', valor: 'EDIFICIO P' })
  })

  it('una sala de dos filas no se muda: se corrige el edificio en su sitio y se avisa', () => {
    // Dos proyectores: el segundo va en una fila de continuación combinada.
    const p = estadoPO(
      [
        fila(2, { A: 'EDIFICIO P', C: '0.1P', Y: 'SALA-000001', M: 'SN-1' }),
        fila(3, { M: 'SN-2', L: 'otro modelo' }),
      ],
      [sala({ edificio: 'EDIFICIO O' })],
      ['C2:C3'],
    )
    expect(p.borrar).toEqual([])
    expect(p.insertar).toEqual([])
    expect(p.celdas).toContainEqual({ celda: 'A2', valor: 'EDIFICIO O' })
    expect(p.avisos.some((a) => a.includes('combinada') || a.includes('continuación'))).toBe(true)
  })

  it('archivar una sala de dos filas se lleva las dos', () => {
    const p = estadoPO(
      [
        fila(2, { A: 'EDIFICIO P', C: '0.1P', Y: 'SALA-000001', M: 'SN-1' }),
        fila(3, { M: 'SN-2' }),
        fila(4, { A: 'EDIFICIO P', C: 'otra', Y: 'SALA-000002' }),
      ],
      [sala({ activa: false }), sala({ id: 'r2', shortRef: 'SALA-000002', code: 'otra' })],
      ['C2:C3'],
    )
    expect(p.borrar.sort()).toEqual([2, 3])
  })

  it('al borrar la fila que abre un bloque, la siguiente hereda el rótulo', () => {
    const p = estadoPO(
      [
        fila(2, { A: 'EDIFICIO P', B: 'PLANTA BAJA', C: '0.1P', Y: 'SALA-000001' }),
        fila(3, { C: 'otra', Y: 'SALA-000002' }),
      ],
      [sala({ activa: false }), sala({ id: 'r2', shortRef: 'SALA-000002', code: 'otra' })],
    )
    expect(p.borrar).toEqual([2])
    expect(p.celdas).toContainEqual({ celda: 'A3', valor: 'EDIFICIO P' })
    expect(p.celdas).toContainEqual({ celda: 'B3', valor: 'PLANTA BAJA' })
  })

  it('una fila nueva no se cuelga de una fila que se va a borrar', () => {
    // La última del bloque se archiva y otra entra en el mismo bloque.
    const p = estadoPO(
      [fila(2, { A: 'EDIFICIO P', B: 'PLANTA BAJA', C: '0.1P', Y: 'SALA-000001' })],
      [sala({ activa: false }), sala({ id: 'r9', shortRef: 'SALA-000009', code: '9.9' })],
    )
    expect(p.borrar).toEqual([2])
    expect(p.insertar).toHaveLength(1)
    expect(p.insertar[0]!.tras).not.toBe(2)
  })
})

describe('sin matrícula y sin cruce por nombre, cruzan los números de serie', () => {
  it('si todos los seriales de la fila son de la misma sala, es esa', () => {
    const p = estado(
      [fila(2, { A: 'EDIFICIO P', C: 'nombre que no cruza', M: 'SN-PROY', O: 'SN-CAM' })],
      [sala({ equipos: [
        { id: 'e1', tipo: 'Proyector', serial: 'SN-PROY', model: null, desde: null },
        { id: 'e2', tipo: 'Cámara', serial: 'SN-CAM', model: null, desde: null },
      ] })],
    )
    expect(p.sinCruzar).toEqual([])
    expect(p.celdas).toContainEqual({ celda: 'Y2', valor: 'SALA-000001' })
    expect(p.avisos.some((a) => a.includes('números de serie'))).toBe(true)
  })

  it('si discrepan, no cruza con ninguna y lo dice', () => {
    const p = estado(
      [fila(2, { A: 'EDIFICIO P', C: 'nombre que no cruza', M: 'SN-A', O: 'SN-B' })],
      [
        sala({ equipos: [{ id: 'e1', tipo: 'Proyector', serial: 'SN-A', model: null, desde: null }] }),
        sala({ id: 'r2', shortRef: 'SALA-000002', code: 'otra', equipos: [{ id: 'e2', tipo: 'Cámara', serial: 'SN-B', model: null, desde: null }] }),
      ],
    )
    expect(p.sinCruzar).toHaveLength(1)
    expect(p.sinCruzar[0]!.motivo).toContain('discrepan')
  })

  it('un serial repetido en dos salas no identifica ninguna', () => {
    const p = estado(
      [fila(2, { A: 'EDIFICIO P', C: 'nombre que no cruza', M: 'SN-REPE' })],
      [
        sala({ equipos: [{ id: 'e1', tipo: 'Proyector', serial: 'SN-REPE', model: null, desde: null }] }),
        sala({ id: 'r2', shortRef: 'SALA-000002', code: 'otra', equipos: [{ id: 'e2', tipo: 'Proyector', serial: 'SN-REPE', model: null, desde: null }] }),
      ],
    )
    expect(p.sinCruzar).toHaveLength(1)
  })
})

describe('un mes a cero es un mes en blanco', () => {
  const cab = fila(1, Object.fromEntries(BOLSA_2026.columnas.map((c) => [c.letra, c.cabecera])))

  it('no se escriben ceros en los meses que la hoja tiene en blanco', () => {
    const art = articulo({ meses: [0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0] })
    const p = sincronizarBolsa({ hoja: BOLSA_2026, filas: [cab, fila(2, { A: art.nombre })], articulos: [art], resolver: () => art.id })
    expect(p.celdas.filter((c) => /^[B-M]2$/.test(c.celda))).toEqual([{ celda: 'J2', valor: 3 }])
  })

  it('ni en una fila nueva', () => {
    const art = articulo({ id: 'nuevo', nombre: 'Artículo nuevo', meses: [0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], comprado: 5 })
    const p = sincronizarBolsa({ hoja: BOLSA_2026, filas: [cab], articulos: [art], resolver: () => null })
    expect(p.insertar).toHaveLength(1)
    const meses = p.insertar[0]!.celdas.filter((c) => /^[B-M]\d+$/.test(c.celda)).map((c) => [c.celda.replace(/\d+$/, ''), c.valor])
    expect(meses).toEqual([['C', 2]])
  })

  it('y un cero escrito a mano frente a un cero de la app no manda nada a la base', () => {
    const art = articulo({ meses: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] })
    const p = sincronizarBolsa({ hoja: BOLSA_2026, filas: [cab, fila(2, { A: art.nombre, B: 0 })], articulos: [art], resolver: () => art.id })
    expect(p.haciaLaBase).toEqual([])
  })

  it('una fórmula sin valor en la app no es un descuadre', () => {
    const art = articulo({ meses: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] })
    const p = sincronizarBolsa({
      hoja: BOLSA_2026,
      filas: [cab, { fila: 2, celdas: { A: art.nombre, B: 1, N: 1 }, formulas: { N: 'SUM(B2:M2)' } } as FilaLeida],
      articulos: [art],
      resolver: () => art.id,
    })
    expect(p.avisos.filter((a) => a.includes('descuadre') || a.includes('Es una fórmula'))).toEqual([])
  })
})

describe('«Stock Disponible» cuando manda el Excel', () => {
  const cab = fila(1, Object.fromEntries(BOLSA_2026.columnas.map((c) => [c.letra, c.cabecera])))
  // La hoja tiene sus fórmulas intactas y la app un saldo distinto: lo que se
  // manda a la base es lo que dice la celda.
  //
  // `P` se calcula a partir del disponible que pide la prueba en vez de ser un
  // número fijo, y eso no es comodidad: con `P` clavado en 32, pedir 19 dejaba
  // una fila donde la fórmula da 18 y el valor guardado dice 19 —exactamente el
  // libro de verdad, con su resultado viejo— y la prueba daba por bueno que la
  // aplicación se creyera el 19. Una fila que se contradice a sí misma no puede
  // ser la que dice qué está bien.
  const art = articulo({ meses: [1, 0, 0, 0, 0, 0, 0, 4, 9, 0, 0, 0], comprado: 32, saldo: 28 })
  const filaBolsa = (o: number): FilaLeida =>
    ({
      fila: 2,
      celdas: { A: art.nombre, B: 1, I: 4, J: 9, N: 14, O: o, P: o + 14 },
      formulas: { N: 'B2+C2+D2+E2+F2+G2+H2+I2+J2+K2+L2+M2', O: 'P2-N2' },
    }) as FilaLeida

  it('sin referencia solo se avisa: la fórmula no se toca y la base tampoco', () => {
    const p = sincronizarBolsa({ hoja: BOLSA_2026, filas: [cab, filaBolsa(19)], articulos: [art], resolver: () => art.id })
    expect(p.haciaLaBase.filter((h) => h.campo === 'articulo.disponible')).toEqual([])
    expect(p.celdas.some((c) => c.celda === 'O2')).toBe(false)
  })

  it('con «manda el Excel» el disponible va a la base como ajuste, y la celda sigue sin tocarse', () => {
    const p = sincronizarBolsa({
      hoja: BOLSA_2026,
      filas: [cab, filaBolsa(19)],
      articulos: [art],
      resolver: () => art.id,
      referencia: 'excel',
    })
    expect(p.haciaLaBase).toContainEqual(expect.objectContaining({ campo: 'articulo.disponible', letra: 'O', valor: 19 }))
    expect(p.celdas.some((c) => c.celda === 'O2')).toBe(false)
  })

  it('y si el valor guardado de la fórmula está viejo, manda la fórmula', () => {
    /*
     * El caso del libro real, fila 8: la celda trae guardado un 19 de cuando
     * `P` valía 28, pero `P` ya vale 54 y la fórmula da 45. Excel enseña 45 al
     * abrir el libro —se marca con `fullCalcOnLoad` justo para eso— y quien
     * corrigió el inventario en la hoja vio 45.
     *
     * Cuadrar el almacén contra el 19 borraría veintiséis cables sin dejar
     * rastro, y el aviso saldría diciendo que manda el Excel.
     */
    const viejo: FilaLeida = {
      fila: 2,
      celdas: { A: art.nombre, B: 1, I: 4, J: 9, N: 14, O: 19, P: 59 },
      formulas: { N: 'B2+C2+D2+E2+F2+G2+H2+I2+J2+K2+L2+M2', O: 'P2-N2' },
    } as FilaLeida
    const p = sincronizarBolsa({
      hoja: BOLSA_2026,
      filas: [cab, viejo],
      articulos: [art],
      resolver: () => art.id,
      referencia: 'excel',
    })
    expect(p.haciaLaBase).toContainEqual(
      expect.objectContaining({ campo: 'articulo.disponible', letra: 'O', valor: 45 }),
    )
    expect(p.haciaLaBase.some((h) => h.campo === 'articulo.disponible' && h.valor === 19)).toBe(false)
    expect(p.avisos.join(' ')).toContain('O2 traía 19 y la fórmula da 45')
    // Y la celda sigue sin tocarse: una columna de fórmula no se escribe nunca.
    expect(p.celdas.some((c) => c.celda === 'O2')).toBe(false)
  })

  it('un disponible negativo no se cuadra: se dice que hay que revisar lo comprado', () => {
    const p = sincronizarBolsa({
      hoja: BOLSA_2026,
      filas: [cab, filaBolsa(-3)],
      articulos: [art],
      resolver: () => art.id,
      referencia: 'excel',
    })
    expect(p.haciaLaBase.filter((h) => h.campo === 'articulo.disponible')).toEqual([])
    expect(p.avisos.join(' ')).toContain('El disponible es negativo')
  })

  it('si la hoja y la app coinciden no hay nada que ajustar', () => {
    const igual = articulo({ meses: [1, 0, 0, 0, 0, 0, 0, 4, 9, 0, 0, 0], comprado: 32, saldo: 18 })
    const p = sincronizarBolsa({
      hoja: BOLSA_2026,
      filas: [cab, filaBolsa(18)],
      articulos: [igual],
      resolver: () => igual.id,
      referencia: 'excel',
    })
    expect(p.haciaLaBase.filter((h) => h.campo === 'articulo.disponible')).toEqual([])
  })
})

describe('cada hoja de partes solo inserta los partes de su año', () => {
  it('un parte abierto en 2025 no entra en la hoja de 2026', () => {
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [CAB_PARTES],
      incidencias: [incidencia({ id: 'x25', numero: 'I250301_0001', abierta: '2025-03-01' })],
    })
    expect(p.insertar).toEqual([])
  })

  it('uno de 2026 sí, y uno sin fecha de apertura no va a ninguna', () => {
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [CAB_PARTES],
      incidencias: [
        incidencia({ id: 'x26', numero: 'I260301_0001', abierta: '2026-03-01' }),
        incidencia({ id: 'sin', numero: 'I260301_0002', abierta: null }),
      ],
    })
    expect(p.insertar).toHaveLength(1)
    expect(p.insertar[0]!.celdas.some((c) => c.valor === 'I260301_0001')).toBe(true)
  })
})

describe('un aula que dice «ninguna»', () => {
  it('un parte nuevo con «Varias aulas» entra sin sala y no se pregunta', () => {
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [
        CAB_PARTES,
        fila(2, {
          A: 'Varias aulas',
          B: fechaAExcel('2026-09-15'),
          C: fechaAExcel('2026-09-15'),
          E: 'Regularización de almacén (septiembre 2026)',
          G: '2 Botonera',
        }),
      ],
      incidencias: [],
      indice,
    })
    expect(p.dudas).toEqual([])
    expect(p.sinCruzar).toEqual([])
    expect(p.altas).toHaveLength(1)
    expect(p.altas[0]).toMatchObject({ tipo: 'incidencia', salaId: null, aula: 'Varias aulas' })
  })

  it('en un parte que ya existe sin sala, la celda se compara como el blanco que es y no se toca', () => {
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [CAB_PARTES, fila(2, { D: 'I260102_0002', A: 'Almacén' })],
      incidencias: [incidencia({ salaCode: '' })],
    })
    expect(p.haciaLaBase.filter((h) => h.campo === 'sala.code')).toEqual([])
    expect(p.celdas.filter((c) => c.celda === 'A2')).toEqual([])
    expect(p.conflictos).toEqual([])
    expect(p.instantanea).toContainEqual(expect.objectContaining({ letra: 'A', fila: 2, valor: 'Almacén' }))
  })

  it('y si la aplicación sí le puso sala, tampoco se pisa lo que alguien escribió', () => {
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [CAB_PARTES, fila(2, { D: 'I260102_0002', A: 'Varias aulas' })],
      incidencias: [incidencia({ salaCode: '0.1 BC' })],
    })
    expect(p.haciaLaBase.filter((h) => h.campo === 'sala.code')).toEqual([])
    expect(p.celdas.filter((c) => c.celda === 'A2')).toEqual([])
  })
})

describe('el corte y la mudanza cuando manda el Excel', () => {
  const SERIAL = ESTADO.columnas.find((c) => c.campo === 'equipo:Proyector:serial')!.letra

  it('un proyector instalado en la aplicación después del corte no lo pisa la hoja en la primera pasada', () => {
    const p = sincronizarEstado({
      hoja: ESTADO,
      filas: [CABECERA, fila(2, { Y: 'SALA-000001', C: '0.1P', [SERIAL]: 'SN-VIEJO' })],
      salas: [sala({ equipos: [{ id: 'e1', tipo: 'Proyector', serial: 'SN-NUEVO', model: null, desde: '2026-09-15T10:00:00Z' }] })],
      indice,
      columnaRef: 'Y',
      instantanea: SIN_INSTANTANEA,
      referencia: 'excel',
      corte: '2026-09-09',
    })
    expect(p.celdas).toContainEqual({ celda: `${SERIAL}2`, valor: 'SN-NUEVO' })
    expect(p.haciaLaBase.filter((h) => h.campo === 'equipo:Proyector:serial')).toEqual([])
  })

  it('el mismo proyector, instalado antes del corte: manda el Excel, como se eligió', () => {
    const p = sincronizarEstado({
      hoja: ESTADO,
      filas: [CABECERA, fila(2, { Y: 'SALA-000001', C: '0.1P', [SERIAL]: 'SN-VIEJO' })],
      salas: [sala({ equipos: [{ id: 'e1', tipo: 'Proyector', serial: 'SN-NUEVO', model: null, desde: '2026-07-01T10:00:00Z' }] })],
      indice,
      columnaRef: 'Y',
      instantanea: SIN_INSTANTANEA,
      referencia: 'excel',
      corte: '2026-09-09',
    })
    expect(p.haciaLaBase).toContainEqual(expect.objectContaining({ campo: 'equipo:Proyector:serial', valor: 'SN-VIEJO' }))
    expect(p.celdas.filter((c) => c.celda === `${SERIAL}2`)).toEqual([])
  })

  it('una sala revisada después del corte se queda con sus altavoces aunque la hoja diga otra cosa', () => {
    const p = sincronizarEstado({
      hoja: ESTADO,
      filas: [CABECERA, fila(2, { Y: 'SALA-000001', C: '0.1P', H: 'NO' })],
      salas: [sala({ revisiones: ['2026-09-12'], capacidades: { altavoces: true } })],
      indice,
      columnaRef: 'Y',
      instantanea: SIN_INSTANTANEA,
      referencia: 'excel',
      corte: '2026-09-09',
    })
    expect(p.haciaLaBase.filter((h) => h.campo === 'capacidad:altavoces')).toEqual([])
    expect(p.celdas).toContainEqual({ celda: 'H2', valor: 'SI' })
  })

  const indiceDosEdificios = construirIndice({
    ...catalogo,
    edificios: [...(catalogo.edificios ?? []), { codigo: 'C', nombre: 'ED. CENTRAL', activo: true }],
  })
  const enElLibro = fila(2, { A: 'ED. CENTRAL', B: 'PLANTA BAJA', C: '0.1P', Y: 'SALA-000001' })
  const antesDeciaP: Instantanea = (_clave, letra) => (letra === 'A' ? 'EDIFICIO P' : undefined)

  it('con «manda el Excel», si el libro cambió el edificio de una sala, la sala se muda en la aplicación y la fila se queda', () => {
    const p = sincronizarEstado({
      hoja: ESTADO,
      filas: [CABECERA, enElLibro],
      salas: [sala()],
      indice: indiceDosEdificios,
      columnaRef: 'Y',
      instantanea: antesDeciaP,
      referencia: 'excel',
    })
    expect(p.borrar).toEqual([])
    expect(p.haciaLaBase).toContainEqual(expect.objectContaining({ campo: 'edificio', valor: 'ED. CENTRAL' }))
    expect(p.avisos.some((a) => a.includes('se muda en la aplicación'))).toBe(true)
  })

  it('sin elegir que mande el Excel, la fila se muda en el libro como siempre', () => {
    const p = sincronizarEstado({
      hoja: ESTADO,
      filas: [CABECERA, enElLibro],
      salas: [sala()],
      indice: indiceDosEdificios,
      columnaRef: 'Y',
      instantanea: antesDeciaP,
    })
    expect(p.borrar).toEqual([2])
    expect(p.haciaLaBase.filter((h) => h.campo === 'edificio')).toEqual([])
  })

  it('y si fue la aplicación la que movió la sala, «manda el Excel» no la devuelve: la fila se muda en el libro', () => {
    // La celda dice lo mismo que en la última pasada: quien cambió fue la app.
    const p = sincronizarEstado({
      hoja: ESTADO,
      filas: [CABECERA, enElLibro],
      salas: [sala()],
      indice: indiceDosEdificios,
      columnaRef: 'Y',
      instantanea: (_clave, letra) => (letra === 'A' ? 'ED. CENTRAL' : undefined),
      referencia: 'excel',
    })
    expect(p.borrar).toEqual([2])
  })

  it('un parte cerrado en la aplicación después del corte no lo pisa la hoja', () => {
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [CAB_PARTES, fila(2, { D: 'I260102_0002', F: 'Texto viejo de la hoja' })],
      incidencias: [incidencia({ abierta: '2026-09-10', resuelta: '2026-09-12', resolucion: 'Arreglado en la aplicación' })],
      referencia: 'excel',
      corte: '2026-09-09',
    })
    expect(p.celdas).toContainEqual({ celda: 'F2', valor: 'Arreglado en la aplicación' })
    expect(p.haciaLaBase.filter((h) => h.campo === 'incidencia.resolucion')).toEqual([])
  })

  it('y uno cerrado antes del corte sigue la regla elegida: entra lo que dice la hoja', () => {
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [CAB_PARTES, fila(2, { D: 'I260102_0002', F: 'Texto viejo de la hoja' })],
      incidencias: [incidencia({ abierta: '2026-08-10', resuelta: '2026-08-12', resolucion: 'Arreglado en la aplicación' })],
      referencia: 'excel',
      corte: '2026-09-09',
    })
    expect(p.haciaLaBase).toContainEqual(expect.objectContaining({ campo: 'incidencia.resolucion', valor: 'Texto viejo de la hoja' }))
  })
})

describe('un edificio que el maestro no conoce', () => {
  // La hoja llama a los edificios como los llama SharePoint —«ED. P - BLAISE
  // PASCAL»— y el maestro como los dejó el importador —«EDIFICIO P»—. Las
  // aulas cruzan igual, porque cruzan por matrícula, pero la celda no coincide
  // nunca: con «manda el Excel» se mandaba a la base aula por aula y volvían
  // 23 apuntes de cuarentena iguales.
  const comoLoEscribeSharePoint = {
    A: 'ED. P - BLAISE PASCAL',
    B: 'PLANTA BAJA',
    C: '0.1P',
    Y: 'SALA-000001',
  }

  it('su celda no viaja a la base, y se dice una vez con el recuento', () => {
    const p = sincronizarEstado({
      hoja: ESTADO,
      filas: [CABECERA, fila(2, comoLoEscribeSharePoint)],
      salas: [sala()],
      indice,
      columnaRef: 'Y',
      instantanea: SIN_INSTANTANEA,
      referencia: 'excel',
    })
    expect(p.haciaLaBase.filter((h) => h.campo === 'edificio')).toEqual([])
    expect(p.cuarentena).toEqual([])
    const aviso = p.avisos.find((a) => a.includes('ED. P - BLAISE PASCAL'))
    expect(aviso).toBeTruthy()
    expect(aviso).toContain('1 fila')
    expect(aviso).toContain('Maestro')
  })

  it('y las demás columnas de esa fila siguen entrando como siempre', () => {
    // No se bloquea la fila: solo esa celda. Lo que el Excel corrija en el
    // aula tiene que seguir llegando.
    //
    // Se mira el número de serie del proyector y no la casilla de altavoces
    // —que es lo que miraba antes— porque las columnas de SÍ/NO ya no vienen
    // del Excel: las escribe la aplicación desde su inventario.
    const p = sincronizarEstado({
      hoja: ESTADO,
      filas: [CABECERA, fila(2, { ...comoLoEscribeSharePoint, M: '0340985RL' })],
      salas: [
        sala({ equipos: [{ id: 'p1', tipo: 'Proyector', serial: null, model: null, desde: null }] }),
      ],
      indice,
      columnaRef: 'Y',
      instantanea: SIN_INSTANTANEA,
      referencia: 'excel',
    })
    expect(p.haciaLaBase).toContainEqual(
      expect.objectContaining({ campo: 'equipo:Proyector:serial', valor: '0340985RL' }),
    )
  })

  it('veinte filas del mismo bloque dan UN aviso, no veinte', () => {
    const filas = Array.from({ length: 20 }, (_, i) =>
      fila(i + 2, {
        ...comoLoEscribeSharePoint,
        C: `0.${i + 1}P`,
        Y: `SALA-00000${i}`,
      }),
    )
    const salas = filas.map((_f, i) =>
      sala({ id: `r${i}`, shortRef: `SALA-00000${i}`, code: `0.${i + 1}P` }),
    )
    const p = sincronizarEstado({
      hoja: ESTADO,
      filas: [CABECERA, ...filas],
      salas,
      indice: construirIndice({
        ...catalogo,
        salas: salas.map((s) => ({
          id: s.id,
          shortRef: s.shortRef,
          code: s.code,
          name: s.code,
          active: true,
          zona: s.zona,
          edificioCodigo: 'P',
          edificioNombre: 'EDIFICIO P',
          edificioActivo: true,
          alias: [],
        })),
      }),
      columnaRef: 'Y',
      instantanea: SIN_INSTANTANEA,
      referencia: 'excel',
    })
    expect(p.avisos.filter((a) => a.includes('no es ningún edificio del maestro'))).toHaveLength(1)
    expect(
      p.avisos.find((a) => a.includes('no es ningún edificio del maestro')),
    ).toContain('20 filas')
    expect(p.haciaLaBase.filter((h) => h.campo === 'edificio')).toEqual([])
  })
})

describe('la planta viaja con su edificio, o no viaja', () => {
  it('si el edificio se retiene, la planta también: crearla en el edificio viejo sería peor que rechazarla', () => {
    // La base crea la planta dentro del edificio en el que la sala está HOY
    // (sync_mover_sala). Con el edificio retenido, mandar la planta pone
    // «PLANTA 2» en el edificio de antes, sin un solo mensaje.
    const p = sincronizarEstado({
      hoja: ESTADO,
      filas: [
        CABECERA,
        fila(2, {
          A: 'ED. S - SÓCRATES',
          B: 'PLANTA 2',
          C: '0.1P',
          Y: 'SALA-000001',
        }),
      ],
      salas: [sala()],
      indice,
      columnaRef: 'Y',
      instantanea: SIN_INSTANTANEA,
      referencia: 'excel',
    })
    expect(p.haciaLaBase.filter((h) => h.campo === 'edificio' || h.campo === 'zona')).toEqual([])
  })

  it('pero con el edificio conocido, la planta entra: para eso la base sabe crearla', () => {
    const p = sincronizarEstado({
      hoja: ESTADO,
      filas: [CABECERA, fila(2, { A: 'EDIFICIO P', B: 'PLANTA 2', C: '0.1P', Y: 'SALA-000001' })],
      salas: [sala()],
      indice,
      columnaRef: 'Y',
      instantanea: SIN_INSTANTANEA,
      referencia: 'excel',
    })
    expect(p.haciaLaBase).toContainEqual(
      expect.objectContaining({ campo: 'zona', valor: 'PLANTA 2' }),
    )
  })
})

describe('y el aviso no impide que la hoja se siga corrigiendo', () => {
  it('con «manda la aplicación», el nombre del maestro sigue entrando en la celda: es un renombrado', () => {
    // La guarda corta solo la dirección que estaba rota —mandar a la base un
    // nombre que la base no puede aplicar—, no la que sana erratas.
    const p = sincronizarEstado({
      hoja: ESTADO,
      filas: [CABECERA, fila(2, { A: 'ED. P - BLAISE PASCAL', C: '0.1P', Y: 'SALA-000001' })],
      salas: [sala()],
      indice,
      columnaRef: 'Y',
      instantanea: SIN_INSTANTANEA,
      referencia: 'app',
    })
    expect(p.celdas).toContainEqual({ celda: 'A2', valor: 'EDIFICIO P' })
    expect(p.haciaLaBase.filter((h) => h.campo === 'edificio')).toEqual([])
  })
})

describe('un parte sin aula a propósito no es un parte sin identificar', () => {
  it('«Varias aulas» entra marcado como sin sala a propósito', () => {
    // La base apunta en la cuarentena todo parte que entra sin sala, y esa
    // bandeja solo sabe ofrecer salas del maestro: una regularización de
    // almacén se quedaría ahí para siempre, una por pasada.
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [
        CAB_PARTES,
        fila(2, {
          A: 'Varias aulas',
          B: fechaAExcel('2026-09-15'),
          E: 'Regularización de almacén',
          G: '2 Botonera',
        }),
      ],
      incidencias: [],
      indice,
    })
    expect(p.altas[0]).toMatchObject({ tipo: 'incidencia', salaId: null, sinSala: true })
  })

  it('y un aula que no cruza entra SIN esa marca: ésa sí hay que colocarla', () => {
    const p = sincronizarPartes({
      hoja: MATERIAL_2026,
      filas: [CAB_PARTES, fila(2, { A: '9.9 ZZ', B: fechaAExcel('2026-09-15'), E: 'No arranca' })],
      incidencias: [],
      indice,
      respuestas: { [`${MATERIAL_2026.nombre}!2`]: { tipo: 'sin_sala' } },
    })
    // Contestar «no es de ninguna sala» también es a propósito.
    expect(p.altas[0]).toMatchObject({ salaId: null, sinSala: true })
  })
})

describe('las aulas que el libro trae y el maestro no', () => {
  /*
   * Las 43 de Sócrates y de Antonio Gaudí: hoy son 43 dudas idénticas, pasada
   * tras pasada, y contestarlas una a una no las iba a crear nunca. El
   * edificio S existe en el maestro desde el histórico —con seis incidencias
   * detrás— pero sin nombre y sin ninguna sala, así que sus aulas no cruzan.
   */
  const conSocrates = construirIndice({
    ...catalogo,
    edificios: [
      { codigo: 'P', nombre: 'EDIFICIO P', activo: true },
      { codigo: 'S', nombre: 'SÓCRATES', activo: true },
    ],
  })

  function conLaOpcion(celdas: Record<string, string>, crearAulas = true) {
    return sincronizarEstado({
      hoja: ESTADO,
      filas: [CABECERA, fila(2, celdas)],
      salas: [sala()],
      indice: conSocrates,
      columnaRef: 'Y',
      instantanea: SIN_INSTANTANEA,
      crearAulas,
    })
  }

  const dosSeis = { A: 'SÓCRATES', B: 'PLANTA 2', C: '2.6' }

  it('apagada, sigue siendo una duda y no se crea nada', () => {
    // Es lo de siempre, y es el que manda: dar de alta una sala no se deshace.
    const p = conLaOpcion(dosSeis, false)
    expect(p.altas.filter((a) => a.tipo === 'sala')).toEqual([])
    expect(p.dudas.some((d) => d.tipo === 'sala')).toBe(true)
  })

  it('encendida, la crea con la planta que dice el libro y con el nombre del maestro', () => {
    const p = conLaOpcion(dosSeis)
    expect(p.altas.filter((a) => a.tipo === 'sala')).toEqual([
      {
        tipo: 'sala',
        fila: 2,
        edificio: 'S',
        // `PLANTA 2` del libro es la `2ª PLANTA` del maestro: sin traducirlo,
        // el servidor creaba una segunda planta con el nombre del libro y las
        // aulas quedaban repartidas entre las dos.
        zona: '2ª PLANTA',
        code: '2.6',
        aula: '2.6',
        plantaDeducida: false,
        celdas: expect.anything(),
      },
    ])
    // Y ya no se pregunta lo que se va a crear.
    expect(p.dudas.some((d) => d.tipo === 'sala')).toBe(false)
  })

  it('el sufijo del edificio se quita del código, pero el aula original queda de alias', () => {
    const p = conLaOpcion({ A: 'SÓCRATES', B: 'PLANTA 2', C: '2.6 S' })
    const alta = p.altas.find((a) => a.tipo === 'sala')
    expect(alta).toMatchObject({ code: '2.6', aula: '2.6 S' })
  })

  it('pero un nombre descriptivo se sigue preguntando', () => {
    // «Aula Demo» existe hoy en Bellas Artes. Crearla en Sócrates sin que nadie
    // lo mire partiría su histórico entre dos aulas.
    const p = conLaOpcion({ A: 'SÓCRATES', B: '', C: 'Aula Demo' })
    expect(p.altas.filter((a) => a.tipo === 'sala')).toEqual([])
    expect(p.dudas.some((d) => d.tipo === 'sala')).toBe(true)
  })

  it('y un edificio que el maestro no conoce tampoco crea nada', () => {
    /*
     * Sin edificio no se sabe dónde va el aula, y una sala en el edificio de
     * al lado es peor que una sala que falta: la de al lado parece correcta.
     */
    const p = conLaOpcion({ A: 'ED. X - LO QUE SEA', B: 'PLANTA 2', C: '2.6' })
    expect(p.altas.filter((a) => a.tipo === 'sala')).toEqual([])
    expect(p.dudas.some((d) => d.tipo === 'sala')).toBe(true)
  })

  it('una fila con matrícula nunca crea un aula: es una sala que ya existe', () => {
    // Si la matrícula no cruza es que el maestro cambió, no que falte el aula.
    const p = conLaOpcion({ A: 'SÓCRATES', B: 'PLANTA 2', C: '2.6', Y: 'SALA-999999' })
    expect(p.altas.filter((a) => a.tipo === 'sala')).toEqual([])
  })

  it('y un aula que el maestro ya tiene no se duplica', () => {
    // La 0.1P cruza por nombre: la opción no la toca.
    const p = conLaOpcion({ A: 'EDIFICIO P', B: 'PLANTA BAJA', C: '0.1P' })
    expect(p.altas.filter((a) => a.tipo === 'sala')).toEqual([])
  })
})

describe('los equipos que el libro trae y la sala no tiene', () => {
  /*
   * Setenta y cinco monitores. La pantalla del PC no estaba en la aplicación,
   * así que NINGUNA sala tenía «monitor» y la pasada preguntaba por cada una:
   * la misma pregunta setenta y cinco veces, pasada tras pasada, que es
   * exactamente como no se crea ninguno.
   */
  const conSerie = { Y: 'SALA-000001', C: '0.1P', R: 'V3080D6Y' }

  function conLaOpcion(crearEquipos: boolean) {
    return sincronizarEstado({
      hoja: ESTADO,
      filas: [CABECERA, fila(2, conSerie)],
      salas: [sala({ equipos: [] })],
      indice,
      columnaRef: 'Y',
      instantanea: SIN_INSTANTANEA,
      crearEquipos,
    })
  }

  it('apagada, se retiene la celda y se pregunta', () => {
    const p = conLaOpcion(false)
    expect(p.dudas.filter((d) => d.tipo === 'alta' && d.que === 'equipo')).toHaveLength(1)
    // Y la celda NO viaja: sin el sí, el equipo no se crea.
    expect(p.haciaLaBase.filter((h) => h.letra === 'R')).toEqual([])
  })

  it('encendida, la celda viaja y no se pregunta', () => {
    const p = conLaOpcion(true)
    expect(p.dudas.filter((d) => d.tipo === 'alta' && d.que === 'equipo')).toEqual([])
    const celda = p.haciaLaBase.find((h) => h.letra === 'R')
    expect(celda?.valor).toBe('V3080D6Y')
  })

  it('y se dice cuántos entran y de qué tipo, una vez', () => {
    // Una línea con el recuento, no setenta y cinco avisos: lo que entra está
    // celda a celda en la vista previa, que es donde se mira.
    const p = conLaOpcion(true)
    const aviso = p.avisos.find((a) => a.includes('sin preguntar'))
    expect(aviso).toBeTruthy()
    expect(aviso).toContain('1 monitor')
  })

  /*
   * Y el caso que costó dos rondas de capturas: el aparato YA está en la
   * aplicación, pero con otro nombre de tipo.
   *
   * Preguntar «¿lo creo?» ahí es mentira: la sala no se ha quedado sin nada, lo
   * tiene con otro nombre. Y decir que sí no crearía nada, porque
   * `assets_serial_idx` es único global y la base rechaza la fila entera.
   *
   * Qué se hace depende de DÓNDE esté, y son dos cosas distintas:
   *
   *  - En esta misma aula: la celda **viaja**. `sync_aplicar_equipo` adopta el
   *    aparato y le devuelve el tipo que el libro le da en su columna. Retener
   *    la celda era justo lo que impedía esa reclasificación: no llegaba nunca
   *    al servidor.
   *  - En otra aula: se retiene. Crear es imposible y mover un aparato de aula
   *    no se hace desde una celda.
   */
  function conEseSerialPuesto(tipo: string, crearEquipos = false) {
    return sincronizarEstado({
      hoja: ESTADO,
      filas: [CABECERA, fila(2, conSerie)],
      salas: [
        sala({ equipos: [{ id: 'e1', tipo, serial: 'V3080D6Y', model: null, desde: null }] }),
      ],
      indice,
      columnaRef: 'Y',
      instantanea: SIN_INSTANTANEA,
      crearEquipos,
    })
  }

  function enOtraAula(crearEquipos = false) {
    return sincronizarEstado({
      hoja: ESTADO,
      filas: [CABECERA, fila(2, conSerie)],
      salas: [
        sala({ equipos: [] }),
        sala({
          id: 'r2',
          shortRef: 'SALA-000002',
          code: '1.5',
          edificio: 'ED. O',
          equipos: [{ id: 'e9', tipo: 'TV', serial: 'V3080D6Y', model: null, desde: null }],
        }),
      ],
      indice,
      columnaRef: 'Y',
      instantanea: SIN_INSTANTANEA,
      crearEquipos,
    })
  }

  it('si ya está en esta aula con otro nombre, no se pregunta y la celda viaja', () => {
    const p = conEseSerialPuesto('TV')
    expect(p.dudas.filter((d) => d.tipo === 'alta' && d.que === 'equipo')).toEqual([])
    // Viaja a propósito: es lo que el servidor necesita para reclasificarlo.
    expect(p.haciaLaBase.find((h) => h.letra === 'R')?.valor).toBe('V3080D6Y')
  })

  it('y el aviso dice los dos nombres y que se reclasifica', () => {
    const aviso = conEseSerialPuesto('TV').avisos.find((a) => a.includes('devuelve el tipo'))
    expect(aviso).toBeTruthy()
    expect(aviso).toContain('«Monitor» del libro')
    expect(aviso).toContain('«TV»')
    expect(aviso).toContain('V3080D6Y')
    // No es un alta: no puede contarse entre los que entran de nuevos.
    expect(conEseSerialPuesto('TV', true).avisos.filter((a) => a.includes('sin preguntar'))).toEqual([])
  })

  it('un «sí» contestado antes no lo convierte en un alta', () => {
    // La respuesta valía para «no lo tengo». Aquí sí lo tiene, y se reclasifica.
    const p = sincronizarEstado({
      hoja: ESTADO,
      filas: [CABECERA, fila(2, conSerie)],
      salas: [
        sala({ equipos: [{ id: 'e1', tipo: 'TV', serial: 'V3080D6Y', model: null, desde: null }] }),
      ],
      indice,
      columnaRef: 'Y',
      instantanea: SIN_INSTANTANEA,
      respuestas: { [idDeDuda(ESTADO.nombre, 2, 'Monitor')]: { tipo: 'alta', aceptar: true } },
    })
    expect(p.haciaLaBase.find((h) => h.letra === 'R')?.valor).toBe('V3080D6Y')
    expect(p.avisos.some((a) => a.includes('devuelve el tipo'))).toBe(true)
  })

  it('en otra aula sí se retiene: crear es imposible y mover no se hace desde una celda', () => {
    const p = enOtraAula()
    expect(p.dudas.filter((d) => d.tipo === 'alta' && d.que === 'equipo')).toEqual([])
    expect(p.haciaLaBase.filter((h) => h.letra === 'R')).toEqual([])
  })

  it('y el aviso de la otra aula dice en cuál', () => {
    /*
     * El serial es único global: si lo tiene otra aula, este alta tampoco entra.
     * Y saber cuál convierte «no se puede» en «el aparato se movió y nadie lo
     * apuntó».
     */
    const aviso = enOtraAula(true).avisos.find((a) => a.includes('OTRA aula'))
    expect(aviso).toBeTruthy()
    expect(aviso).toContain('«1.5» (ED. O)')
    expect(enOtraAula(true).avisos.filter((a) => a.includes('sin preguntar'))).toEqual([])
  })

  it('la sala que ya tiene ese equipo no cuenta como nuevo', () => {
    // No es que se pregunte o no: es que ahí no hay nada que crear.
    const p = sincronizarEstado({
      hoja: ESTADO,
      filas: [CABECERA, fila(2, conSerie)],
      salas: [sala({ equipos: [{ id: 'e1', tipo: 'Monitor', serial: 'V3080D6Y', model: null, desde: null }] })],
      indice,
      columnaRef: 'Y',
      instantanea: SIN_INSTANTANEA,
      crearEquipos: true,
    })
    expect(p.avisos.filter((a) => a.includes('sin preguntar'))).toEqual([])
  })
})
