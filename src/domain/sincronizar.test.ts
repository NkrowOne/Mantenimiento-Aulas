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
  })

  it('dentro de un bloque, la fila nueva no repite el nombre del edificio', () => {
    const p = estado(
      [fila(2, { A: 'EDIFICIO P', C: '0.1P', Y: 'SALA-000001' })],
      [sala(), sala({ id: 'r2', shortRef: 'SALA-000002', code: '0.9P' })],
    )
    const celdas = p.insertar[0]!.celdas.map((c) => c.celda)
    expect(celdas).not.toContain('A3')
    expect(celdas).toContain('C3')
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
  it('rellena los meses, que hoy están en blanco', () => {
    const p = bolsa([fila(2, { A: 'Cable HDMI fibra 10 m' })], [articulo()])
    expect(p.celdas).toContainEqual({ celda: 'B2', valor: 1 })
  })

  it('devuelve la fórmula a una celda con el número escrito a mano encima', () => {
    // Es lo que pasa hoy en N5, N8 y N9 del libro real.
    const p = bolsa([fila(2, { A: 'Cable HDMI fibra 10 m', N: 3 })], [articulo()])
    expect(p.celdas).toContainEqual({
      celda: 'N2',
      valor: '=B2+C2+D2+E2+F2+G2+H2+I2+J2+K2+L2+M2',
    })
    expect(p.avisos.join(' ')).toMatch(/encima de la fórmula/)
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
    expect(celdas).toContainEqual({ celda: 'O3', valor: '=P3-N3' })
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
    // lo explica, que es justo lo que tiene que hacer.
    const sinAula = plan.sinCruzar.filter((s) => /no dice de qué aula/.test(s.motivo))
    expect(plan.sinCruzar.length - sinAula.length).toBe(1)
    expect(plan.sinCruzar.find((s) => !/no dice de qué aula/.test(s.motivo))!.motivo).toMatch(
      /no cruza con ninguna sala/,
    )
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

    // El libro real tiene exactamente tres celdas con un número tecleado encima
    // de la fórmula: N5, N8 y N9. Ni una más.
    const recuperadas = plan.avisos.filter((a) => a.includes('encima de la fórmula'))
    expect(recuperadas).toHaveLength(3)
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
