import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { BOLSA_2026, ESTADO, MATERIAL_2026, MATERIAL_2025 } from './mapa'
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

function estado(filas: FilaLeida[], salas: SalaVolcada[], instantanea: Instantanea = SIN_INSTANTANEA) {
  return sincronizarEstado({
    hoja: ESTADO,
    filas: [CABECERA, ...filas],
    salas,
    indice,
    columnaRef: 'Y',
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
    expect(p.celdas).toContainEqual({ celda: 'E2', valor: fechaAExcel('2024-06-03') })
  })

  it('en las horas gana la medición más reciente, no el último en escribir', () => {
    const antes: Instantanea = (f, l) => (f === 2 && l === 'F' ? 100 : undefined)
    // El Excel dice 5000 con fecha vieja; la app 921 con fecha de 2025.
    const p = estado(
      [fila(2, { Y: 'SALA-000001', F: 5000, D: fechaAExcel('2020-01-01') })],
      [sala()],
      antes,
    )
    expect(p.celdas).toContainEqual({ celda: 'F2', valor: 921 })
  })

  it('y si la lectura del Excel es la más nueva, entra en la base', () => {
    const antes: Instantanea = (f, l) => (f === 2 && l === 'F' ? 100 : undefined)
    const p = estado(
      [fila(2, { Y: 'SALA-000001', F: 5000, D: fechaAExcel('2030-01-01') })],
      [sala()],
      antes,
    )
    expect(p.haciaLaBase.find((h) => h.letra === 'F')?.valor).toBe(5000)
  })

  it('los dos lados cambiados a cosas distintas no tocan ninguno', () => {
    const antes: Instantanea = (f, l) => (f === 2 && l === 'K' ? 'Actualizada' : undefined)
    const p = estado([fila(2, { Y: 'SALA-000001', K: 'No tiene' })], [sala()], antes)
    expect(p.conflictos).toHaveLength(1)
    expect(p.celdas.some((c) => c.celda === 'K2')).toBe(false)
    // Y el conflicto no deja rastro en la instantánea: si lo dejara, la pasada
    // siguiente creería que se resolvió solo.
    expect(p.instantanea.some((c) => c.letra === 'K' && c.fila === 2)).toBe(false)
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
    const conMatricula = plan.celdas.filter((c) => c.celda.startsWith(colRef)).length
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
