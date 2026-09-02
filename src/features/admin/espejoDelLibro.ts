/**
 * El lado «aplicación» construido como espejo del libro, para las pruebas que
 * corren sobre el Excel de verdad.
 *
 * Lo comparten dos pruebas y por eso vive aparte: `idaYVuelta.test.ts`, que
 * comprueba que dos pasadas seguidas dejan el libro quieto, y
 * `divergencia.test.ts`, que parte de este espejo, **cambia la aplicación**
 * —aulas nuevas, una sala que se muda de edificio, seriales, modelos, almacén,
 * partes— y comprueba dónde aterriza cada cambio en el libro que sale.
 *
 * Nada de aquí decide nada: solo lee el libro y lo cuenta como lo contaría la
 * base. Si el espejo miente, las dos pruebas mienten igual, que es lo que se
 * quiere: una sola fuente de verdad sobre cómo se lee el libro en las pruebas.
 */
import { abrirLibro, leerHoja, columnaANumero, numeroAColumna, celdasCombinadas } from '@/domain/xlsx'
import type { FilaLeida, ValorCelda, Libro } from '@/domain/xlsx'
import { BOLSA_2025, BOLSA_2026, ESTADO, MATERIAL_2025, MATERIAL_2026 } from '@/domain/mapa'
import type { Hoja } from '@/domain/mapa'
import { leer, leerMicrofono, limpiar } from '@/domain/valores'
import type { Valor } from '@/domain/valores'
import { sincronizarBolsa, sincronizarEstado, sincronizarPartes } from '@/domain/sincronizar'
import type { Instantanea, Plan } from '@/domain/sincronizar'
import type { ArticuloVolcado, IncidenciaVolcada, SalaVolcada, EquipoVolcado } from '@/domain/volcado'
import { paraLaInstantanea } from '@/features/admin/pasada'
import { construirIndice } from '@/domain/cruce'
import type { Catalogo } from '@/domain/cruce'
import { BUILDING_TYPOS } from '@/domain/normalize'

export function txt(v: ValorCelda | undefined): string {
  if (v === null || v === undefined) return ''
  return limpiar(String(v))
}

export function val(v: ValorCelda | undefined, tipo: string): Valor {
  const l = leer(v ?? null, tipo)
  return l.ok ? l.valor : null
}

export const norm = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase()

export interface Datos {
  catalogo: Catalogo
  salas: SalaVolcada[]
  incidencias: IncidenciaVolcada[]
  articulos: ArticuloVolcado[]
  resolver: (n: string) => string | null
  columnaRef: string
  /** Matrícula → fila del libro de la que salió. */
  filaDe: Map<string, number>
  /** Las matrículas cuya fila LLEVA escrito el edificio (abre bloque). */
  llevaEdificio: Set<string>
  /** Matrícula → edificio y planta tal y como se leyeron (arrastrados). */
  sitioDe: Map<string, { edificio: string; zona: string }>
}

/**
 * Un código corto y **distinto** por edificio, como los de la base.
 *
 * Truncar el nombre a seis letras parecía suficiente y no lo era: «EDIFICIO M»
 * y «EDIFICIO E» se convierten los dos en `EDIFIC`, y como el índice del cruce
 * se teclea por `edificioCodigo|code`, el aula `1.1` de uno y la `1.1` del otro
 * pasaban a ser la misma clave. Se numeran por orden de aparición, que es lo
 * único que garantiza que dos edificios distintos no compartan código.
 */
const codigosDeEdificio = new Map<string, string>()
export function codigoDeEdificio(nombre: string): string {
  // Las erratas conocidas resuelven al edificio bueno, como hace el cruce: si
  // no, «EDIFICO E» sería un edificio aparte en el espejo y sus aulas saldrían
  // «nuevas» en cada pasada sin que eso pase en producción.
  const errata = Object.entries(BUILDING_TYPOS).find(([mal]) => norm(mal) === norm(nombre))
  const k = norm(errata ? errata[1] : nombre)
  if (!codigosDeEdificio.has(k)) codigosDeEdificio.set(k, `ED${codigosDeEdificio.size + 1}`)
  return codigosDeEdificio.get(k)!
}

/** Construye el lado «aplicación» espejo del Excel: nada que discutir. */
export function datosDelLibro(
  estado: FilaLeida[],
  mat: FilaLeida[],
  bolsa: FilaLeida[],
  /** Las hojas de 2025, si se quieren en el espejo: la base también las tiene. */
  viejas: { mat?: FilaLeida[]; bolsa?: FilaLeida[] } = {},
): Datos {
  let maxCol = 0
  for (const f of estado) for (const c of Object.keys(f.celdas)) maxCol = Math.max(maxCol, columnaANumero(c))
  const cab = estado.find((f) => f.fila === 1)
  let columnaRef = ''
  for (const [c, v] of Object.entries(cab?.celdas ?? {})) if (String(v).trim().toLowerCase() === 'ref') columnaRef = c
  if (!columnaRef) columnaRef = numeroAColumna(maxCol + 1)

  const salas: SalaVolcada[] = []
  const filaDe = new Map<string, number>()
  const llevaEdificio = new Set<string>()
  const sitioDe = new Map<string, { edificio: string; zona: string }>()
  let edificio = ''
  let zona = ''
  let n = 0
  const vistos = new Set<string>()
  for (const f of estado) {
    if (f.fila <= 1) continue
    const llevaA = txt(f.celdas.A) !== ''
    if (llevaA) edificio = txt(f.celdas.A)
    if (txt(f.celdas.B) !== '') zona = txt(f.celdas.B)
    const code = txt(f.celdas.C)
    if (code === '') continue
    const clave = `${norm(edificio)}|${norm(code)}`
    if (vistos.has(clave)) continue
    vistos.add(clave)
    n++
    const shortRef = `SALA-${String(n).padStart(6, '0')}`
    filaDe.set(shortRef, f.fila)
    if (llevaA) llevaEdificio.add(shortRef)
    sitioDe.set(shortRef, { edificio, zona })

    const equipos: EquipoVolcado[] = []
    const eq = (tipo: string, model: ValorCelda | undefined, serial: ValorCelda | undefined): void => {
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
      equipos.push({ id: `${n}-mic`, tipo: 'Micrófono', serial: micro.serial, model: micro.modelo, desde: '2024-01-01' })
    }
    const d = val(f.celdas.D, 'fecha')
    const e2 = val(f.celdas.E, 'fecha')
    const revisiones: string[] = typeof d === 'string' ? (typeof e2 === 'string' ? [d, e2] : [d]) : []
    const capacidades: Record<string, boolean> = {}
    const alt = val(f.celdas.H, 'si_no')
    const cam = val(f.celdas.I, 'si_no')
    if (typeof alt === 'boolean') capacidades.altavoces = alt
    if (typeof cam === 'boolean') capacidades.camara = cam
    if (micro.hay !== null && !micro.serial && !micro.modelo) capacidades.microfono = micro.hay

    salas.push({
      id: `S${n}`,
      shortRef,
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

  // Los partes de 2025 llevan «Observación» en F y todo lo de la derecha corre
  // una letra. La base los tiene igual que los de 2026: el importador cargó los
  // dos años, y la hoja congelada tiene que cruzarlos para no escribir nada.
  for (const f of viejas.mat ?? []) {
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
      observacion: (val(f.celdas.F, 'texto') as string) ?? null,
      resolucion: (val(f.celdas.G, 'texto') as string) ?? null,
      material: (val(f.celdas.H, 'texto') as string) ?? null,
    })
  }

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
  // Los artículos que solo están en la bolsa de 2025 existen en el catálogo
  // igual: sin ellos la hoja congelada los da por desconocidos.
  for (const f of viejas.bolsa ?? []) {
    if (f.fila <= 1) continue
    const nombre = txt(f.celdas.A)
    if (nombre === '' || porNombre.has(norm(nombre))) continue
    const id = `A25-${f.fila}`
    porNombre.set(norm(nombre), id)
    const alt = txt(f.celdas.Y)
    if (alt && !porNombre.has(norm(alt))) porNombre.set(norm(alt), id)
    articulos.push({ id, nombre, meses: Array<number>(12).fill(0), comprado: null })
  }

  const catalogo: Catalogo = {
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
  return {
    catalogo,
    salas,
    incidencias,
    articulos,
    resolver: (x) => porNombre.get(norm(x)) ?? null,
    columnaRef,
    filaDe,
    llevaEdificio,
    sitioDe,
  }
}

/** El catálogo del cruce, rehecho a partir de las salas de hoy (por si cambiaron). */
export function catalogoDe(salas: SalaVolcada[]): Catalogo {
  const edificios = new Map<string, { codigo: string; nombre: string; activo: boolean }>()
  for (const s of salas) {
    const codigo = codigoDeEdificio(s.edificio)
    if (!edificios.has(codigo)) edificios.set(codigo, { codigo, nombre: s.edificio, activo: true })
  }
  return {
    edificios: [...edificios.values()],
    salas: salas.map((s) => ({
      id: s.id,
      shortRef: s.shortRef,
      code: s.code,
      name: s.code,
      active: s.activa,
      zona: s.zona,
      edificioCodigo: codigoDeEdificio(s.edificio),
      edificioNombre: s.edificio,
      edificioActivo: true,
      alias: [],
    })),
  }
}

export async function pasada(
  bytes: Uint8Array,
  datos: Datos,
  inst: Instantanea,
): Promise<{ planes: Plan[]; libro: Libro }> {
  const libro = await abrirLibro(bytes)
  const filas = new Map<string, FilaLeida[]>()
  for (const h of [ESTADO, MATERIAL_2026, MATERIAL_2025, BOLSA_2026, BOLSA_2025]) {
    filas.set(h.nombre, await leerHoja(libro, h.nombre))
  }
  const indice = construirIndice(catalogoDe(datos.salas))
  const planes: Plan[] = []
  planes.push(
    sincronizarEstado({
      hoja: ESTADO,
      filas: filas.get(ESTADO.nombre)!,
      salas: datos.salas,
      indice,
      columnaRef: datos.columnaRef,
      // Como en producción: las celdas combinadas se leen y no se escriben.
      combinadas: await celdasCombinadas(libro, ESTADO.nombre),
      instantanea: inst,
    }),
  )
  for (const h of [MATERIAL_2026, MATERIAL_2025] as Hoja[]) {
    planes.push(
      sincronizarPartes({ hoja: h, filas: filas.get(h.nombre)!, incidencias: datos.incidencias, instantanea: inst }),
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

/**
 * La instantánea que deja una pasada, por la misma función que la de verdad:
 * la de producción va y vuelve por una columna `text`, y la gracia es pasar por
 * donde se pasa.
 */
export function instantaneaDe(planes: Plan[]): Instantanea {
  const mapa = new Map<string, Valor>()
  for (const p of planes) {
    for (const c of p.instantanea) mapa.set(`${p.hoja}!${c.clave}!${c.letra}`, paraLaInstantanea(c.valor))
  }
  return (clave, letra) => {
    for (const p of planes) {
      const k = `${p.hoja}!${clave}!${letra}`
      if (mapa.has(k)) return mapa.get(k)!
    }
    return undefined
  }
}

/** Cuántas filas tiene cada hoja del libro. La forma, no el contenido. */
export async function formaDe(bytes: Uint8Array): Promise<Record<string, number>> {
  const libro = await abrirLibro(bytes)
  const out: Record<string, number> = {}
  for (const h of libro.hojas) out[h.nombre] = (await leerHoja(libro, h.nombre)).length
  return out
}

/** Lo que se escribiría, celda a celda y con su porqué. Vacío = quieto. */
export function vaivenesDe(planes: Plan[]): string[] {
  const out: string[] = []
  for (const p of planes) {
    for (const c of p.celdas) out.push(`${p.hoja}!${c.celda} ← ${JSON.stringify(c.valor)}`)
    for (const c of p.insertar) out.push(`${p.hoja} inserta una fila tras la ${c.tras}`)
    for (const f of p.borrar) out.push(`${p.hoja} borra la fila ${f}`)
    for (const c of p.haciaLaBase) out.push(`${p.hoja} a la base: ${c.destino} ${c.campo} = ${JSON.stringify(c.valor)}`)
  }
  return out
}
