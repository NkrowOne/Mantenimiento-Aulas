/**
 * Lo que el libro tiene y la aplicación no: entra, o se pregunta.
 *
 * Son las pruebas de las dudas y las altas: un parte tecleado en el libro sin
 * número, una fila de estado que no dice de qué aula es, un número de serie que
 * crearía un equipo, un artículo que el almacén no conoce, un ordenador de
 * repuesto nuevo en la hoja de PCs. Antes todo eso se contaba como «sin
 * cruzar» y se dejaba para siempre.
 */
import { describe, expect, it } from 'vitest'
import { BOLSA_2026, ESTADO, MATERIAL_2025, MATERIAL_2026, PCS_2026 } from './mapa'
import { construirIndice } from './cruce'
import type { Catalogo } from './cruce'
import { idDeDuda, pendientes } from './dudas'
import type { Respuestas } from './dudas'
import {
  sincronizarBolsa,
  sincronizarEstado,
  sincronizarPartes,
  sincronizarUnidades,
} from './sincronizar'
import type { FilaLeida } from './xlsx'
import type { ArticuloVolcado, IncidenciaVolcada, SalaVolcada, UnidadVolcada } from './volcado'

// -----------------------------------------------------------------------------
// Andamio
// -----------------------------------------------------------------------------

function fila(n: number, celdas: Record<string, string | number | boolean | null>): FilaLeida {
  return { fila: n, celdas }
}

const cabeceraDe = (hoja: { columnas: Array<{ letra: string; cabecera: string }> }): FilaLeida =>
  fila(1, Object.fromEntries(hoja.columnas.map((c) => [c.letra, c.cabecera])))

function sala(over: Partial<SalaVolcada> = {}): SalaVolcada {
  return {
    id: 'r1',
    shortRef: 'SALA-000001',
    edificio: 'EDIFICIO P',
    zona: 'PLANTA BAJA',
    code: '0.1P',
    activa: true,
    projectorHours: null,
    lampPct: null,
    botoneraEstado: null,
    capacidades: {},
    revisiones: [],
    notas: null,
    equipos: [],
    ...over,
  }
}

const conocida = (s: SalaVolcada, edificioCodigo = 'P') => ({
  id: s.id,
  shortRef: s.shortRef,
  code: s.code,
  name: s.code,
  active: s.activa,
  zona: s.zona,
  edificioCodigo,
  edificioNombre: s.edificio,
  edificioActivo: true,
  alias: [] as string[],
})

// Dos edificios con un aula «1.1» cada uno: la referencia «1.1» a secas es
// ambigua, y «1.1 P» no.
const salaP = sala({ id: 'p11', shortRef: 'SALA-000011', code: '1.1', zona: 'PLANTA 1' })
const salaO = sala({ id: 'o11', shortRef: 'SALA-000021', code: '1.1', edificio: 'EDIFICIO O', zona: 'PLANTA 1' })
const catalogo: Catalogo = {
  salas: [conocida(sala()), conocida(salaP), conocida(salaO, 'O')],
  edificios: [
    { codigo: 'P', nombre: 'EDIFICIO P', activo: true },
    { codigo: 'O', nombre: 'EDIFICIO O', activo: true },
  ],
  edificiosDesaparecidos: [],
}
const indice = construirIndice(catalogo)

function incidencia(over: Partial<IncidenciaVolcada> = {}): IncidenciaVolcada {
  return {
    id: 'i1',
    numero: 'I260102_0002',
    salaCode: '0.1P',
    abierta: '2026-01-02',
    resuelta: '2026-01-02',
    problema: 'No duplica la imagen',
    observacion: null,
    resolucion: 'Se sustituye el cable',
    material: '1 Cable HDMI fibra 15 m',
    ...over,
  }
}

function partes(filas: FilaLeida[], respuestas: Respuestas = {}, hoja = MATERIAL_2026) {
  return sincronizarPartes({
    hoja,
    filas: [cabeceraDe(hoja), ...filas],
    incidencias: [incidencia()],
    indice,
    respuestas,
  })
}

const PARTE_NUEVO = {
  A: '1.1 P',
  B: 46_273, // 8/9/2026 en serie de Excel
  C: 46_273,
  E: 'El PC no arranca Windows',
  F: 'Se reemplaza por un PC de stock Tiny Lenovo',
  G: '1 Tiny Lenovo M70Q',
}

// -----------------------------------------------------------------------------
// Partes nuevos
// -----------------------------------------------------------------------------

describe('un parte que está en el libro y no en la aplicación', () => {
  it('sin número, con aula que cruza: entra como alta y la base le pondrá número', () => {
    const p = partes([fila(2, PARTE_NUEVO)])
    expect(p.dudas).toEqual([])
    expect(p.sinCruzar).toEqual([])
    expect(p.altas).toHaveLength(1)
    expect(p.altas[0]).toMatchObject({
      tipo: 'incidencia',
      fila: 2,
      salaId: 'p11',
      aula: '1.1 P',
      numero: null,
      abierta: '2026-09-08',
      resuelta: '2026-09-08',
      problema: 'El PC no arranca Windows',
      resolucion: 'Se reemplaza por un PC de stock Tiny Lenovo',
      material: '1 Tiny Lenovo M70Q',
    })
    // Las celdas leídas viajan con el alta: son el antepasado bajo la clave nueva.
    const alta = p.altas[0]!
    expect(alta.celdas.A).toBe('1.1 P')
    expect(alta.celdas.B).toBe('2026-09-08')
    expect(p.avisos.some((a) => a.includes('parte nuevo del libro'))).toBe(true)
  })

  it('con un número que la aplicación no conoce también entra, y pide conservarlo', () => {
    const p = partes([fila(2, { ...PARTE_NUEVO, D: 'S260901_0075' })])
    expect(p.altas).toHaveLength(1)
    expect(p.altas[0]).toMatchObject({ numero: 'S260901_0075', salaId: 'p11' })
  })

  it('con un aula ambigua se pregunta, con las candidatas, y el alta espera', () => {
    const p = partes([fila(2, { ...PARTE_NUEVO, A: '1.1' })])
    expect(p.altas).toEqual([])
    expect(p.dudas).toHaveLength(1)
    const d = p.dudas[0]!
    expect(d.tipo).toBe('sala')
    if (d.tipo !== 'sala') throw new Error('no es una duda de sala')
    expect(d.que).toBe('parte')
    expect(d.id).toBe(idDeDuda(MATERIAL_2026.nombre, 2))
    expect(d.candidatas.map((c) => c.id).sort()).toEqual(['o11', 'p11'])
    expect(p.sinCruzar[0]?.motivo).toContain('espera a saber de qué aula es')
  })

  it('con un aula que no cruza con nada se pregunta sin candidatas', () => {
    const p = partes([fila(2, { ...PARTE_NUEVO, A: 'Lab Docente 5' })])
    expect(p.dudas).toHaveLength(1)
    expect(p.dudas[0]).toMatchObject({ tipo: 'sala', candidatas: [] })
  })

  it('y contestada la duda con una sala, entra con ella', () => {
    const id = idDeDuda(MATERIAL_2026.nombre, 2)
    const p = partes([fila(2, { ...PARTE_NUEVO, A: '1.1' })], { [id]: { tipo: 'sala', salaId: 'o11' } })
    expect(p.dudas).toEqual([])
    expect(p.altas[0]).toMatchObject({ salaId: 'o11', aula: '1.1' })
  })

  it('contestada «sin sala», entra sin sala', () => {
    const id = idDeDuda(MATERIAL_2026.nombre, 2)
    const p = partes([fila(2, { ...PARTE_NUEVO, A: 'Lab Docente 5' })], { [id]: { tipo: 'sin_sala' } })
    expect(p.altas[0]).toMatchObject({ salaId: null, aula: 'Lab Docente 5' })
  })

  it('contestada «dejar como está», ni entra ni se vuelve a preguntar', () => {
    const id = idDeDuda(MATERIAL_2026.nombre, 2)
    const p = partes([fila(2, { ...PARTE_NUEVO, A: '1.1' })], { [id]: { tipo: 'ignorar' } })
    expect(p.dudas).toEqual([])
    expect(p.altas).toEqual([])
    expect(p.sinCruzar).toHaveLength(1)
  })

  it('sin aula escrita se pregunta también', () => {
    const p = partes([fila(2, { ...PARTE_NUEVO, A: null })])
    expect(p.dudas).toHaveLength(1)
    expect(p.dudas[0]).toMatchObject({ tipo: 'sala', motivo: 'el parte no dice de qué aula es' })
  })

  it('sin problema descrito no hay parte: se cuenta y se deja', () => {
    const p = partes([fila(2, { ...PARTE_NUEVO, E: null })])
    expect(p.altas).toEqual([])
    expect(p.dudas).toEqual([])
    expect(p.sinCruzar[0]?.motivo).toContain('no se puede dar de alta')
  })

  it('una fecha ilegible en un parte nuevo va a cuarentena y el alta sigue sin ella', () => {
    const p = partes([fila(2, { ...PARTE_NUEVO, C: '27-03-296' })])
    expect(p.altas[0]).toMatchObject({ abierta: '2026-09-08', resuelta: null })
    expect(p.cuarentena).toHaveLength(1)
    expect(p.cuarentena[0]).toMatchObject({ fila: 2, letra: 'C' })
  })

  it('en la hoja congelada de 2025 se cuenta y no entra, como siempre', () => {
    const cab = cabeceraDe(MATERIAL_2025)
    const p = sincronizarPartes({
      hoja: MATERIAL_2025,
      filas: [cab, fila(2, { A: '1.1 P', E: 'Algo viejo' })],
      incidencias: [],
      indice,
    })
    expect(p.altas).toEqual([])
    expect(p.dudas).toEqual([])
    expect(p.sinCruzar).toEqual([{ fila: 2, motivo: 'el parte no lleva número de incidencia' }])
  })

  it('las dudas pendientes son las que no tienen respuesta', () => {
    const p = partes([fila(2, { ...PARTE_NUEVO, A: '1.1' }), fila(3, { ...PARTE_NUEVO, A: 'Lab 5' })])
    expect(pendientes(p.dudas, {})).toHaveLength(2)
    expect(pendientes(p.dudas, { [idDeDuda(MATERIAL_2026.nombre, 2)]: { tipo: 'ignorar' } })).toHaveLength(1)
  })
})

// -----------------------------------------------------------------------------
// La hoja de estado
// -----------------------------------------------------------------------------

function estado(filas: FilaLeida[], salas: SalaVolcada[], respuestas: Respuestas = {}) {
  return sincronizarEstado({
    hoja: ESTADO,
    filas: [cabeceraDe(ESTADO), ...filas],
    salas,
    indice,
    columnaRef: 'Y',
    respuestas,
  })
}

describe('una fila de estado que no dice de qué aula es', () => {
  it('se pregunta, con lo que la fila dice de sí misma', () => {
    const p = estado([fila(2, { A: 'Sala Vip', V: 1862642855 })], [sala()])
    expect(p.sinCruzar).toHaveLength(1)
    expect(p.dudas).toHaveLength(1)
    const d = p.dudas[0]!
    if (d.tipo !== 'sala') throw new Error('no es una duda de sala')
    expect(d.que).toBe('estado')
    expect(d.texto).toContain('Sala Vip')
    expect(d.texto).toContain('Barco: 1862642855')
  })

  it('contestada con una sala, la fila cruza: matrícula escrita y celdas fusionadas', () => {
    const id = idDeDuda(ESTADO.nombre, 2)
    const p = estado([fila(2, { A: 'Sala Vip', V: 1862642855 })], [sala()], { [id]: { tipo: 'sala', salaId: 'r1' } })
    expect(p.dudas.filter((d) => d.tipo === 'sala')).toEqual([])
    expect(p.sinCruzar).toEqual([])
    expect(p.celdas).toContainEqual({ celda: 'Y2', valor: 'SALA-000001' })
  })

  it('contestada «dejar como está», se cuenta y no se vuelve a preguntar', () => {
    const id = idDeDuda(ESTADO.nombre, 2)
    const p = estado([fila(2, { A: 'Sala Vip', V: 1862642855 })], [sala()], { [id]: { tipo: 'ignorar' } })
    expect(p.dudas).toEqual([])
    expect(p.sinCruzar).toHaveLength(1)
  })

  it('un aula que no cruza en su edificio también se pregunta', () => {
    const p = estado([fila(2, { A: 'EDIFICIO P', C: '9.9' })], [sala()])
    expect(p.dudas).toHaveLength(1)
    expect(p.dudas[0]).toMatchObject({ tipo: 'sala', que: 'estado', fila: 2 })
  })

  it('la segunda fila de un aula con dos proyectores no es una duda', () => {
    const p = estado(
      [fila(2, { A: 'EDIFICIO P', C: '0.1P', M: 'SN-1' }), fila(3, { M: 'SN-2' })],
      [sala()],
    )
    expect(p.dudas.filter((d) => d.tipo === 'sala')).toEqual([])
  })
})

describe('un número de serie que crearía un equipo que la sala no tenía', () => {
  it('se retiene y se pregunta; la celda no va a la base ni deja antepasado', () => {
    const p = estado([fila(2, { A: 'EDIFICIO P', C: '0.1P', M: '0340985RL', L: 'NP-M403' })], [sala()])
    expect(p.haciaLaBase.filter((h) => h.campo.startsWith('equipo:'))).toEqual([])
    expect(p.instantanea.filter((c) => c.fila === 2 && (c.letra === 'M' || c.letra === 'L'))).toEqual([])
    expect(p.dudas).toHaveLength(1)
    const d = p.dudas[0]!
    expect(d).toMatchObject({ tipo: 'alta', que: 'equipo', fila: 2, id: idDeDuda(ESTADO.nombre, 2, 'Proyector') })
    if (d.tipo !== 'alta') throw new Error('no es una duda de alta')
    expect(d.detalle).toContain('0340985RL')
    expect(d.detalle).toContain('NP-M403')
  })

  it('aceptada, las dos celdas del aparato entran en la base', () => {
    const id = idDeDuda(ESTADO.nombre, 2, 'Proyector')
    const p = estado([fila(2, { A: 'EDIFICIO P', C: '0.1P', M: '0340985RL', L: 'NP-M403' })], [sala()], {
      [id]: { tipo: 'alta', aceptar: true },
    })
    expect(p.dudas).toEqual([])
    expect(p.haciaLaBase.map((h) => h.campo).sort()).toEqual(['equipo:Proyector:model', 'equipo:Proyector:serial'])
  })

  it('rechazada, se queda como está y se dice', () => {
    const id = idDeDuda(ESTADO.nombre, 2, 'Proyector')
    const p = estado([fila(2, { A: 'EDIFICIO P', C: '0.1P', M: '0340985RL' })], [sala()], {
      [id]: { tipo: 'alta', aceptar: false },
    })
    expect(p.dudas).toEqual([])
    expect(p.haciaLaBase.filter((h) => h.campo.startsWith('equipo:'))).toEqual([])
    expect(p.avisos.some((a) => a.includes('se ha dicho que no se cree'))).toBe(true)
  })

  it('si la sala ya tiene un aparato de ese tipo, es una corrección y no se pregunta', () => {
    const conProyector = sala({
      equipos: [{ id: 'a1', tipo: 'Proyector', serial: 'VIEJO', model: null, desde: '2024-01-01' }],
    })
    const p = estado([fila(2, { A: 'EDIFICIO P', C: '0.1P', M: 'NUEVO' })], [conProyector])
    expect(p.dudas).toEqual([])
  })
})

// -----------------------------------------------------------------------------
// La bolsa
// -----------------------------------------------------------------------------

function articulo(over: Partial<ArticuloVolcado> = {}): ArticuloVolcado {
  return { id: 'a1', nombre: 'Cable HDMI fibra 10 m', meses: new Array<number>(12).fill(0), comprado: 5, ...over }
}

function bolsa(filas: FilaLeida[], respuestas: Respuestas = {}) {
  const articulos = [articulo()]
  return sincronizarBolsa({
    hoja: BOLSA_2026,
    filas: [cabeceraDe(BOLSA_2026), ...filas],
    articulos,
    resolver: (nombre) => articulos.find((a) => a.nombre.toLowerCase() === nombre.toLowerCase())?.id ?? null,
    respuestas,
  })
}

describe('un artículo que la bolsa lista y el almacén no conoce', () => {
  it('se pregunta antes de entrar', () => {
    const p = bolsa([fila(2, { A: 'Pasta térmica', P: 30, Q: 'Pasta termica' })])
    expect(p.altas).toEqual([])
    expect(p.dudas).toHaveLength(1)
    expect(p.dudas[0]).toMatchObject({ tipo: 'alta', que: 'articulo', texto: 'Pasta térmica' })
    expect(p.sinCruzar).toHaveLength(1)
  })

  it('aceptado, entra con su nombre alternativo y lo comprado', () => {
    const id = idDeDuda(BOLSA_2026.nombre, 2)
    const p = bolsa([fila(2, { A: 'Pasta térmica', P: 30, Q: 'Pasta termica' })], { [id]: { tipo: 'alta', aceptar: true } })
    expect(p.dudas).toEqual([])
    expect(p.sinCruzar).toEqual([])
    expect(p.altas[0]).toMatchObject({
      tipo: 'articulo',
      nombre: 'Pasta térmica',
      nombreAlternativo: 'Pasta termica',
      comprado: 30,
    })
  })

  it('rechazado, se cuenta y se deja', () => {
    const id = idDeDuda(BOLSA_2026.nombre, 2)
    const p = bolsa([fila(2, { A: 'Pasta térmica' })], { [id]: { tipo: 'alta', aceptar: false } })
    expect(p.dudas).toEqual([])
    expect(p.altas).toEqual([])
    expect(p.sinCruzar[0]?.motivo).toContain('no darlo de alta')
  })
})

// -----------------------------------------------------------------------------
// La hoja de PCs de repuesto
// -----------------------------------------------------------------------------

function unidad(over: Partial<UnidadVolcada> = {}): UnidadVolcada {
  return {
    id: 'u1',
    articulo: 'Ordenador Tiny',
    marca: 'Lenovo ThinkCentre',
    modelo: 'M710Q',
    serial: 'S4GM1899',
    observaciones: 'Ordenador con imagen funcional de repuesto',
    estado: 'disponible',
    sala: null,
    desde: null,
    ...over,
  }
}

function pcs(filas: FilaLeida[], unidades: UnidadVolcada[], respuestas: Respuestas = {}) {
  return sincronizarUnidades({
    hoja: PCS_2026,
    filas: [cabeceraDe(PCS_2026), ...filas],
    unidades,
    respuestas,
  })
}

const FILA_PC = {
  A: 'Ordenador Tiny',
  B: 'Lenovo ThinkCentre',
  C: 'M710Q',
  D: 'S4GM1899',
  E: 'Ordenador con imagen funcional de repuesto',
}

describe('la hoja de PCs de repuesto', () => {
  it('cruza por número de serie y escribe la situación al final de la fila', () => {
    const p = pcs([fila(3, FILA_PC)], [unidad()])
    expect(p.sinCruzar).toEqual([])
    expect(p.dudas).toEqual([])
    expect(p.celdas).toContainEqual({ celda: 'F1', valor: 'Situación' })
    expect(p.celdas).toContainEqual({ celda: 'F3', valor: 'En almacén' })
  })

  it('el número de serie se compara sin espacios ni guiones', () => {
    const p = pcs([fila(3, { ...FILA_PC, D: ' s4gm-1899 ' })], [unidad()])
    expect(p.sinCruzar).toEqual([])
  })

  it('un ordenador instalado dice dónde y desde cuándo', () => {
    const p = pcs([fila(3, FILA_PC)], [unidad({ estado: 'instalado', sala: '2.1 (EDIFICIO C)', desde: '2026-09-08' })])
    expect(p.celdas).toContainEqual({ celda: 'F3', valor: 'Instalado en 2.1 (EDIFICIO C) · 08/09/2026' })
  })

  it('no reescribe la situación si ya dice lo mismo, ni la cabecera si ya está', () => {
    const p = sincronizarUnidades({
      hoja: PCS_2026,
      filas: [
        fila(1, { ...cabeceraDe(PCS_2026).celdas, F: 'Situación' }),
        fila(3, { ...FILA_PC, F: 'En almacén' }),
      ],
      unidades: [unidad()],
    })
    expect(p.celdas.filter((c) => c.celda.startsWith('F'))).toEqual([])
  })

  it('una fila con número de serie que la aplicación no tiene se pregunta', () => {
    const p = pcs([fila(3, { ...FILA_PC, D: 'S4DF5471' })], [unidad()])
    expect(p.dudas).toHaveLength(1)
    expect(p.dudas[0]).toMatchObject({ tipo: 'alta', que: 'unidad', fila: 3 })
    expect(p.altas).toEqual([])
  })

  it('aceptada, entra con lo que la fila dice', () => {
    const id = idDeDuda(PCS_2026.nombre, 3)
    const p = pcs([fila(3, { ...FILA_PC, D: 'S4DF5471' })], [unidad()], { [id]: { tipo: 'alta', aceptar: true } })
    expect(p.dudas).toEqual([])
    expect(p.altas[0]).toMatchObject({
      tipo: 'unidad',
      serial: 'S4DF5471',
      articulo: 'Ordenador Tiny',
      marca: 'Lenovo ThinkCentre',
      modelo: 'M710Q',
    })
  })

  it('las unidades de la aplicación que el libro no tiene se añaden al final, con su situación', () => {
    const p = pcs([fila(3, FILA_PC)], [unidad(), unidad({ id: 'u2', serial: 'S4DF5471', modelo: 'M70Q' })])
    expect(p.insertar).toHaveLength(1)
    const nueva = p.insertar[0]!
    expect(nueva.tras).toBe(3)
    expect(nueva.celdas).toContainEqual({ celda: 'D4', valor: 'S4DF5471' })
    expect(nueva.celdas).toContainEqual({ celda: 'F4', valor: 'En almacén' })
  })

  it('una fila vacía en medio —la 2 del libro real— no es nada', () => {
    const p = pcs([fila(2, { A: null }), fila(3, FILA_PC)], [unidad()])
    expect(p.sinCruzar).toEqual([])
    expect(p.dudas).toEqual([])
  })

  it('las observaciones corregidas en la hoja entran en la base', () => {
    // Con antepasado: sin él es la primera pasada y manda la app, como en todas.
    const p = sincronizarUnidades({
      hoja: PCS_2026,
      filas: [cabeceraDe(PCS_2026), fila(3, { ...FILA_PC, E: 'Imagen de julio' })],
      unidades: [unidad()],
      instantanea: (clave, letra) => (clave === 'u1' && letra === 'E' ? 'Ordenador con imagen funcional de repuesto' : undefined),
    })
    expect(p.haciaLaBase).toContainEqual(
      expect.objectContaining({ campo: 'unidad.observaciones', valor: 'Imagen de julio', destino: 'S4GM1899' }),
    )
  })
})
