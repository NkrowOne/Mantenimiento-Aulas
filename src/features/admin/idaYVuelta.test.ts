/**
 * Ida y vuelta: la segunda pasada seguida no escribe nada.
 *
 * Es la única prueba que corre sobre el libro de verdad, y por eso hace falta
 * darle uno: `LIBRO_XLSX=…/Material_Aulas.xlsx npm test`. Sin esa variable se
 * salta, porque el libro no está en el repositorio —lleva dentro el parque
 * entero con nombres y números de serie— y una prueba que exige un fichero que
 * nadie tiene es una prueba roja para todo el mundo.
 *
 * Lo que comprueba es lo que más cuesta ver a ojo: sincronizar dos veces
 * seguidas contra los mismos datos tiene que dejar el libro quieto la segunda.
 * Si la segunda pasada escribe una sola celda, hay un valor que va y vuelve
 * —una fecha que se lee distinta de como se escribe, un blanco arrastrado que
 * se confunde con un hueco— y a la décima pasada el libro es otro. Encontró
 * cuatro así, y son cuatro que ninguna prueba de unidad iba a encontrar: las
 * cuatro necesitaban las 276 filas reales.
 *
 * `SALIDA=…/algo` guarda los dos ficheros para mirarlos con Excel cuando falla.
 *
 * Ojo con lo que NO dice: idempotente no quiere decir correcto. Un destrozo
 * estable pasa esta prueba tan campante —las fórmulas escritas como texto la
 * pasaban—, así que esto descarta el vaivén, no el estropicio.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { abrirLibro, leerHoja, columnaANumero, numeroAColumna } from '@/domain/xlsx'
import type { FilaLeida, ValorCelda } from '@/domain/xlsx'
import { BOLSA_2025, BOLSA_2026, ESTADO, MATERIAL_2025, MATERIAL_2026 } from '@/domain/mapa'
import type { Hoja } from '@/domain/mapa'
import { leer, leerMicrofono, limpiar } from '@/domain/valores'
import type { Valor } from '@/domain/valores'
import { sincronizarBolsa, sincronizarEstado, sincronizarPartes } from '@/domain/sincronizar'
import type { Instantanea, Plan } from '@/domain/sincronizar'
import type { ArticuloVolcado, IncidenciaVolcada, SalaVolcada, EquipoVolcado } from '@/domain/volcado'
import { escribir as escribirPasada, paraLaInstantanea } from '@/features/admin/pasada'
import { construirIndice } from '@/domain/cruce'

const RUTA = process.env.LIBRO_XLSX
const SALIDA = process.env.SALIDA

function txt(v: ValorCelda | undefined): string {
  if (v === null || v === undefined) return ''
  return limpiar(String(v))
}
function val(v: ValorCelda | undefined, tipo: string): Valor {
  const l = leer(v ?? null, tipo)
  return l.ok ? l.valor : null
}

interface Datos {
  catalogo: any
  salas: SalaVolcada[]
  incidencias: IncidenciaVolcada[]
  articulos: ArticuloVolcado[]
  resolver: (n: string) => string | null
  columnaRef: string
}

const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase()

/**
 * Un código corto y **distinto** por edificio, como los de la base.
 *
 * Truncar el nombre a seis letras parecía suficiente y no lo era: «EDIFICIO M» y
 * «EDIFICIO E» se convierten los dos en `EDIFIC`, y como el índice del cruce se
 * teclea por `edificioCodigo|code` (cruce.ts), el aula `1.1` de uno y la `1.1`
 * del otro pasaban a ser la misma clave. Resultado: 103 aulas no se reconocían,
 * se daban por nuevas y se insertaban duplicadas, y 329 filas salían «sin
 * cruzar». Nada de eso pasa en producción —las 23 aulas del maestro tienen 23
 * códigos distintos: M, E, H, CRAI…— así que la prueba estaba corriendo contra
 * un escenario roto que no existe, y de paso tapaba lo que sí tenía que ver.
 *
 * Se numeran por orden de aparición, que es lo único que garantiza que dos
 * edificios distintos no compartan código.
 */
const codigosDeEdificio = new Map<string, string>()
function codigoDeEdificio(nombre: string): string {
  const k = norm(nombre)
  if (!codigosDeEdificio.has(k)) codigosDeEdificio.set(k, `ED${codigosDeEdificio.size + 1}`)
  return codigosDeEdificio.get(k)!
}

/** Construye el lado «aplicación» espejo del Excel: nada que discutir. */
function datosDelLibro(estado: FilaLeida[], mat: FilaLeida[], bolsa: FilaLeida[]): Datos {
  let maxCol = 0
  for (const f of estado) for (const c of Object.keys(f.celdas)) maxCol = Math.max(maxCol, columnaANumero(c))
  const cab = estado.find((f) => f.fila === 1)
  let columnaRef = ''
  for (const [c, v] of Object.entries(cab?.celdas ?? {})) if (String(v).trim().toLowerCase() === 'ref') columnaRef = c
  if (!columnaRef) columnaRef = numeroAColumna(maxCol + 1)

  const salas: SalaVolcada[] = []
  let edificio = ''
  let zona = ''
  let n = 0
  const vistos = new Set<string>()
  for (const f of estado) {
    if (f.fila <= 1) continue
    if (txt(f.celdas.A) !== '') edificio = txt(f.celdas.A)
    if (txt(f.celdas.B) !== '') zona = txt(f.celdas.B)
    const code = txt(f.celdas.C)
    if (code === '') continue
    const clave = `${norm(edificio)}|${norm(code)}`
    if (vistos.has(clave)) continue
    vistos.add(clave)
    n++
    const equipos: EquipoVolcado[] = []
    const eq = (tipo: string, model: ValorCelda | undefined, serial: ValorCelda | undefined) => {
      const m = (val(model, 'texto') as string) || null
      const s = (val(serial, 'texto') as string) || null
      if (m === null && s === null) return
      equipos.push({ id: `${n}-${tipo}`, tipo, serial: s, model: m, desde: '2024-01-01' })
    }
    eq('Proyector', f.celdas.L, f.celdas.M)
    eq('Cámara', f.celdas.N, f.celdas.O)
    eq('TV', f.celdas.P, f.celdas.Q)
    eq('Monitor', undefined, f.celdas.R)
    eq('Ordenador', f.celdas.T, f.celdas.S)
    eq('Screenbeam', undefined, f.celdas.U)
    eq('Barco', undefined, f.celdas.V)
    eq('Panacast 50', undefined, f.celdas.W)
    const micro = leerMicrofono((f.celdas.J ?? null) as Valor)
    if (micro.serial || micro.modelo) {
      equipos.push({
        id: `${n}-mic`,
        tipo: 'Micrófono',
        serial: micro.serial,
        model: micro.modelo,
        desde: '2024-01-01',
      })
    }
    const d = val(f.celdas.D, 'fecha')
    const e2 = val(f.celdas.E, 'fecha')
    const revisiones: string[] =
      typeof d === 'string' ? (typeof e2 === 'string' ? [d, e2] : [d]) : []
    const capacidades: Record<string, boolean> = {}
    const alt = val(f.celdas.H, 'si_no')
    const cam = val(f.celdas.I, 'si_no')
    if (typeof alt === 'boolean') capacidades.altavoces = alt
    if (typeof cam === 'boolean') capacidades.camara = cam
    if (micro.hay !== null && !micro.serial && !micro.modelo) capacidades.microfono = micro.hay

    salas.push({
      id: `S${n}`,
      shortRef: `SALA-${String(n).padStart(6, '0')}`,
      edificio,
      zona,
      code,
      activa: true,
      projectorHours: typeof val(f.celdas.F, 'numero') === 'number' ? (val(f.celdas.F, 'numero') as number) : null,
      lampPct: typeof val(f.celdas.G, 'porcentaje') === 'number' ? (val(f.celdas.G, 'porcentaje') as number) : null,
      botoneraEstado: (val(f.celdas.K, 'texto') as string) ?? null,
      capacidades,
      revisiones,
      notas: (val(f.celdas.X, 'texto') as string) ?? null,
      equipos,
    })
  }

  // Incidencias: espejo de «Material Instalado 2026» (A..K sin Observación)
  const incidencias: IncidenciaVolcada[] = []
  const vistasInc = new Set<string>()
  for (const f of mat) {
    if (f.fila <= 1) continue
    const numero = txt(f.celdas.D)
    if (numero === '' || vistasInc.has(norm(numero))) continue
    vistasInc.add(norm(numero))
    incidencias.push({
      id: numero,
      numero,
      salaCode: txt(f.celdas.A),
      abierta: (val(f.celdas.B, 'fecha') as string) ?? null,
      resuelta: (val(f.celdas.C, 'fecha') as string) ?? null,
      problema: (val(f.celdas.E, 'texto') as string) ?? null,
      observacion: null,
      resolucion: (val(f.celdas.F, 'texto') as string) ?? null,
      material: (val(f.celdas.G, 'texto') as string) ?? null,
    })
  }

  // Artículos: espejo de «Bolsa 2026»
  const articulos: ArticuloVolcado[] = []
  const porNombre = new Map<string, string>()
  for (const f of bolsa) {
    if (f.fila <= 1) continue
    const nombre = txt(f.celdas.A)
    if (nombre === '') continue
    const id = `A${f.fila}`
    porNombre.set(norm(nombre), id)
    const alt = txt(f.celdas.Q)
    if (alt) porNombre.set(norm(alt), id)
    const meses: number[] = []
    for (let i = 0; i < 12; i++) {
      const letra = String.fromCharCode(66 + i)
      const v = val(f.celdas[letra], 'numero')
      meses.push(typeof v === 'number' ? v : 0)
    }
    const comprado = val(f.celdas.P, 'numero')
    articulos.push({ id, nombre, meses, comprado: typeof comprado === 'number' ? comprado : null })
  }

  const catalogo = {
    salas: salas.map((s) => ({
      id: s.id,
      shortRef: s.shortRef,
      code: s.code,
      name: s.code,
      active: true,
      zona: s.zona,
      edificioCodigo: codigoDeEdificio(s.edificio),
      edificioNombre: s.edificio,
      edificioActivo: true,
      alias: [],
    })),
  }
  return { catalogo, salas, incidencias, articulos, resolver: (x) => porNombre.get(norm(x)) ?? null, columnaRef }
}

async function pasada(bytes: Uint8Array, datos: Datos, inst: Instantanea): Promise<{ planes: Plan[]; libro: any }> {
  const libro = await abrirLibro(bytes)
  const filas = new Map<string, FilaLeida[]>()
  for (const h of [ESTADO, MATERIAL_2026, MATERIAL_2025, BOLSA_2026, BOLSA_2025]) {
    filas.set(h.nombre, await leerHoja(libro, h.nombre))
  }
  const indice = construirIndice(datos.catalogo as any)
  const planes: Plan[] = []
  planes.push(
    sincronizarEstado({
      hoja: ESTADO,
      filas: filas.get(ESTADO.nombre)!,
      salas: datos.salas,
      indice,
      columnaRef: datos.columnaRef,
      instantanea: inst,
    }),
  )
  for (const h of [MATERIAL_2026, MATERIAL_2025] as Hoja[]) {
    planes.push(
      sincronizarPartes({
        hoja: h,
        filas: filas.get(h.nombre)!,
        incidencias: datos.incidencias,
        instantanea: inst,
      }),
    )
  }
  for (const h of [BOLSA_2026, BOLSA_2025] as Hoja[]) {
    planes.push(
      sincronizarBolsa({
        hoja: h,
        filas: filas.get(h.nombre)!,
        articulos: datos.articulos,
        resolver: datos.resolver,
        instantanea: inst,
      }),
    )
  }
  return { planes, libro }
}

function instantaneaDe(planes: Plan[]): Instantanea {
  const mapa = new Map<string, Valor>()
  for (const p of planes) {
    for (const c of p.instantanea) {
      // Por la misma función que la de verdad, y no por una copia: la
      // instantánea de producción va y vuelve por una columna `text`, y toda la
      // gracia de esta prueba es pasar por donde se pasa. Una copia aquí es una
      // copia que mañana no se entera de que la otra cambió.
      mapa.set(`${p.hoja}!${c.clave}!${c.letra}`, paraLaInstantanea(c.valor))
    }
  }
  // La instantánea de producción NO lleva la hoja en la clave (sync_instantanea
  // se pide por hoja), pero aquí una sola función sirve para todas: se busca
  // por clave+letra en cualquiera de las hojas.
  return (clave, letra) => {
    for (const p of planes) {
      const k = `${p.hoja}!${clave}!${letra}`
      if (mapa.has(k)) return mapa.get(k)!
    }
    return undefined
  }
}

const datosPasada = (_planes: Plan[]) => ({
  revisiones: [
    {
      shortRef: 'SALA-000001',
      edificio: 'EDIFICIO H',
      zona: '1ª PLANTA',
      sala: '1.7',
      cuando: '2026-03-04T09:30:00Z',
      quien: 'Ana',
      estado: 'cerrada',
      resultado: 'ok',
      horasProyector: 4200,
      lampara: 0.86,
      comprobaciones: 'altavoces: ok',
      incidenciasAbiertas: 0,
      notas: 'Todo bien',
    },
  ],
  movimientos: [
    {
      cuando: '2026-02-01',
      articulo: 'Cable HDMI',
      cantidad: -2,
      tipo: 'consumo',
      incidencia: 'I260102_0007',
      sala: '1.7',
      quien: 'Ana',
      nota: null,
    },
  ],
  equipos: [
    {
      shortRef: 'SALA-000001',
      edificio: 'EDIFICIO H',
      zona: '1ª PLANTA',
      sala: '1.7',
      tipo: 'Proyector',
      modelo: 'EB-1985',
      serial: '0340985RL',
      estado: 'activo',
      desde: '2024-01-01',
      etiqueta: null,
    },
  ],
})

describe.skipIf(!RUTA)('ida y vuelta', () => {
  it('la segunda pasada seguida no escribe nada', async () => {
    const bytes0 = new Uint8Array(readFileSync(RUTA!))
    const libro0 = await abrirLibro(bytes0)
    const datos = datosDelLibro(
      await leerHoja(libro0, ESTADO.nombre),
      await leerHoja(libro0, MATERIAL_2026.nombre),
      await leerHoja(libro0, BOLSA_2026.nombre),
    )

    // ---- Pasada 1: la que pone el libro al día. Escribe, y tiene que escribir.
    const p1 = await pasada(bytes0, datos, () => undefined)
    const a1: any = { libro: p1.libro, planes: p1.planes, hojasNuevas: [], datos: datosPasada(p1.planes) }
    const bytes1 = await escribirPasada(a1, '2026-08-30 10:00')
    if (SALIDA) writeFileSync(`${SALIDA}-1.xlsx`, bytes1)

    // ---- Pasada 2 sobre lo que salió de la 1, con los mismos datos y la
    // instantánea que dejó. Aquí no queda nada que hacer.
    const p2 = await pasada(bytes1, datos, instantaneaDe(p1.planes))

    // Lo que se escribiría en la segunda, celda a celda y con su porqué: si
    // esto falla, lo primero que hace falta es saber QUÉ va y vuelve.
    const vaivenes: string[] = []
    for (const p of p2.planes) {
      for (const c of p.celdas) vaivenes.push(`${p.hoja}!${c.celda} ← ${JSON.stringify(c.valor)}`)
      for (const c of p.insertar) vaivenes.push(`${p.hoja} inserta una fila tras la ${c.tras}`)
      for (const f of p.borrar) vaivenes.push(`${p.hoja} borra la fila ${f}`)
      for (const c of p.haciaLaBase) vaivenes.push(`${p.hoja} a la base: ${c.destino} ${c.campo} = ${JSON.stringify(c.valor)}`)
    }
    expect(vaivenes.slice(0, 40)).toEqual([])

    // Y el libro que sale de la segunda tiene que tener la misma forma que el
    // de la primera. No basta con que el plan esté vacío: las cuatro hojas de
    // detalle no van por el plan —se rehacen enteras cada pasada— así que un
    // fallo ahí no aparece en ninguna celda propuesta. Y hubo uno: se
    // insertaban las filas nuevas sin borrar las viejas, y «Sincronización»
    // pasaba de 336 filas a 671 y a 1.006, con el mismo contenido repetido.
    const a2: any = { libro: p2.libro, planes: p2.planes, hojasNuevas: [], datos: datosPasada(p2.planes) }
    const bytes2 = await escribirPasada(a2, '2026-08-30 11:00')
    if (SALIDA) writeFileSync(`${SALIDA}-2.xlsx`, bytes2)

    expect(await formaDe(bytes2)).toEqual(await formaDe(bytes1))
  }, 300_000)
})

/** Cuántas filas tiene cada hoja del libro. La forma, no el contenido. */
async function formaDe(bytes: Uint8Array): Promise<Record<string, number>> {
  const libro = await abrirLibro(bytes)
  const out: Record<string, number> = {}
  for (const h of libro.hojas) out[h.nombre] = (await leerHoja(libro, h.nombre)).length
  return out
}
