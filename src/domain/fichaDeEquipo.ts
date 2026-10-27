/**
 * La ficha de un equipo: lo que se sabe de él además de dónde está.
 *
 * Hasta aquí un equipo era un tipo, una sala, una etiqueta y, con suerte, una
 * marca, un modelo y un número de serie. Eso basta para revisar un aula y no
 * basta para **gestionar un parque**: cuándo se compró, a quién, por cuánto,
 * hasta cuándo tiene garantía, cuándo deja de tener sentido repararlo, y —en
 * los ordenadores— cómo se llama en la red y qué lleva dentro. Son las
 * preguntas que se hacen desde un despacho y que hasta ahora contestaba un
 * Excel aparte que nadie cruzaba con el inventario.
 *
 * Tres decisiones que no son de estilo:
 *
 * **El fin de vida se calcula, y se puede fijar a mano.** Lo normal es que salga
 * solo: fecha de adquisición más la vida útil del tipo («los ordenadores, cinco
 * años»). Pero hay equipos que se mueren antes —un modelo que el fabricante deja
 * de soportar— y para esos la fecha fijada a mano gana. Sin fecha de compra y
 * sin fecha fijada no se inventa nada: el equipo sale «sin datos», que es
 * verdad y se ve, en vez de un «vigente» que nadie ha comprobado.
 *
 * **Lo que se escribe se normaliza antes de guardarse, no al leerlo.** Una MAC
 * se teclea de cinco maneras —con guiones, con puntos, en minúsculas, sin
 * separadores— y si se guarda como llega, buscar un equipo por su MAC deja de
 * funcionar en cuanto dos personas la han escrito. Aquí se lleva a una sola
 * forma (`AA:BB:CC:DD:EE:FF`), y lo que no es una MAC se dice en el momento.
 *
 * **Solo se manda lo que ha cambiado.** La ficha se guarda con un UPDATE de las
 * columnas tocadas y nada más: si mientras tanto alguien corrigió el número de
 * serie desde el aula, guardar el precio desde el despacho no lo pisa.
 */

import { norm } from './normalize'
import { fechaAExcel } from './valores'
import type { ValorCelda } from './xlsx'
import type { Formato, HojaNueva, Tinte } from './libro'
import type { AssetStatus } from './types'

// -----------------------------------------------------------------------------
// Lo que llega de la base
// -----------------------------------------------------------------------------

export type EstadoDeVida = 'obsoleto' | 'proximo' | 'vigente' | 'sin_datos'

export const ESTADO_DE_VIDA_LABEL: Record<EstadoDeVida, string> = {
  obsoleto: 'Obsoleto',
  proximo: 'Fin de vida en menos de un año',
  vigente: 'Vigente',
  sin_datos: 'Sin datos de vida útil',
}

/** Una fila de la vista `asset_registry`: un equipo con su sala y su ficha. */
export interface EquipoDelRegistro {
  id: string
  asset_type_id: string
  type_name: string
  category: string
  label: string | null
  brand: string | null
  model: string | null
  serial: string | null
  inventory_tag: string | null
  status: AssetStatus
  confirmed: boolean
  room_id: string | null
  room_code: string | null
  room_name: string | null
  zone_name: string | null
  building_id: string | null
  building_code: string | null
  building_name: string | null
  short_ref: string | null
  created_at: string | null
  updated_at: string | null
  acquired_at: string | null
  supplier: string | null
  /** PostgREST devuelve `numeric` como número o como texto según el tamaño. */
  purchase_price: number | string | null
  purchase_ref: string | null
  warranty_until: string | null
  end_of_life: string | null
  vida_util_anyos: number | null
  fin_vida: string | null
  estado_vida: EstadoDeVida
  en_garantia: boolean | null
  hostname: string | null
  mac_address: string | null
  ip_address: string | null
  cpu: string | null
  ram: string | null
  storage: string | null
  os: string | null
  notes: string | null
  baja_at: string | null
  ultimo_evento_at: string | null
}

export type ClaseDeMovimiento = 'alta' | 'baja' | 'sustitucion' | 'traslado' | 'averia'

/** Una fila de la vista `asset_movements`: un evento del histórico de un equipo. */
export interface MovimientoDeEquipo {
  id: string
  occurred_at: string
  recorded_at: string | null
  kind: ClaseDeMovimiento
  asset_id: string
  type_name: string | null
  label: string | null
  brand: string | null
  model: string | null
  serial: string | null
  inventory_tag: string | null
  room_id: string | null
  room_code: string | null
  building_code: string | null
  by_user: string | null
  by_name: string | null
  motivo: string | null
  destino: string | null
  source: string | null
  meta: Record<string, unknown> | null
}

/**
 * Cómo se lee cada clase de evento en una lista de entradas y salidas.
 *
 * «Entrada» y «Salida» van delante porque es la pregunta que se hace quien abre
 * esta lista: qué ha entrado en el parque y qué ha salido. El nombre técnico
 * queda detrás, entre paréntesis, para quien lo busca en el histórico.
 */
export const MOVIMIENTO_LABEL: Record<ClaseDeMovimiento, string> = {
  alta: 'Entrada (alta)',
  baja: 'Salida (baja)',
  traslado: 'Traslado',
  sustitucion: 'Sustitución',
  averia: 'Avería',
}

export const DESTINO_LABEL: Record<string, string> = {
  baja: 'Baja definitiva',
  almacen: 'Devuelto al almacén',
}

// -----------------------------------------------------------------------------
// Vida útil
// -----------------------------------------------------------------------------

/**
 * El fin de vida de un equipo, como `AAAA-MM-DD`, o `null` si no se puede saber.
 *
 * La fecha fijada a mano gana; si no la hay, compra más vida útil del tipo. Es
 * la misma regla que la vista `asset_registry` y está aquí para que la ficha la
 * enseñe **mientras se escribe**, antes de guardar.
 */
export function finDeVida(e: {
  acquired_at: string | null
  end_of_life: string | null
  vida_util_anyos: number | null
}): string | null {
  if (e.end_of_life) return e.end_of_life.slice(0, 10)
  if (!e.acquired_at || !e.vida_util_anyos) return null
  const [a, m, d] = e.acquired_at.slice(0, 10).split('-').map(Number)
  if (!a || !m || !d) return null
  // Sumar años a un 29 de febrero cae en un 1 de marzo, que es lo que hace
  // Postgres con `+ interval 'n years'`: el 28. Se replica para que la ficha
  // y la lista no digan dos fechas distintas del mismo equipo.
  const destino = a + e.vida_util_anyos
  const bisiesto = (destino % 4 === 0 && destino % 100 !== 0) || destino % 400 === 0
  const dia = m === 2 && d === 29 && !bisiesto ? 28 : d
  return `${destino}-${String(m).padStart(2, '0')}-${String(dia).padStart(2, '0')}`
}

/** En qué punto de su vida está, con la misma frontera que la vista: un año. */
export function estadoDeVida(fin: string | null, hoy: string): EstadoDeVida {
  if (!fin) return 'sin_datos'
  if (fin <= hoy) return 'obsoleto'
  const [a, m, d] = hoy.split('-')
  if (fin <= `${Number(a) + 1}-${m}-${d}`) return 'proximo'
  return 'vigente'
}

// -----------------------------------------------------------------------------
// Los campos de la ficha
// -----------------------------------------------------------------------------

export type ClaveDeFicha =
  | 'label'
  | 'brand'
  | 'model'
  | 'serial'
  | 'inventory_tag'
  | 'acquired_at'
  | 'supplier'
  | 'purchase_price'
  | 'purchase_ref'
  | 'warranty_until'
  | 'end_of_life'
  | 'hostname'
  | 'mac_address'
  | 'ip_address'
  | 'cpu'
  | 'ram'
  | 'storage'
  | 'os'
  | 'notes'

export type GrupoDeFicha = 'identidad' | 'compra' | 'vida' | 'ordenador' | 'notas'

export interface CampoDeFicha {
  clave: ClaveDeFicha
  etiqueta: string
  grupo: GrupoDeFicha
  tipo: 'texto' | 'fecha' | 'precio' | 'mac' | 'ip' | 'largo'
  pista?: string
  /** Se escribe en mayúsculas y monoespaciada: es un código, no una palabra. */
  codigo?: boolean
}

export const CAMPOS_DE_FICHA: CampoDeFicha[] = [
  { clave: 'label', etiqueta: 'Nombre en el aula', grupo: 'identidad', tipo: 'texto', pista: 'Proyector 2' },
  { clave: 'brand', etiqueta: 'Marca', grupo: 'identidad', tipo: 'texto', pista: 'Epson' },
  { clave: 'model', etiqueta: 'Modelo', grupo: 'identidad', tipo: 'texto', pista: 'EB-1485Fi' },
  { clave: 'serial', etiqueta: 'Número de serie', grupo: 'identidad', tipo: 'texto', pista: 'X5LK8700123', codigo: true },
  { clave: 'inventory_tag', etiqueta: 'N.º de inventario', grupo: 'identidad', tipo: 'texto', pista: 'INV-2026-0042', codigo: true },
  { clave: 'acquired_at', etiqueta: 'Fecha de adquisición', grupo: 'compra', tipo: 'fecha' },
  { clave: 'supplier', etiqueta: 'Proveedor', grupo: 'compra', tipo: 'texto', pista: 'Distribuidor S.L.' },
  { clave: 'purchase_price', etiqueta: 'Precio (€)', grupo: 'compra', tipo: 'precio', pista: '849,00' },
  { clave: 'purchase_ref', etiqueta: 'Pedido o factura', grupo: 'compra', tipo: 'texto', pista: 'PED-2026/118' },
  { clave: 'warranty_until', etiqueta: 'Garantía hasta', grupo: 'compra', tipo: 'fecha' },
  { clave: 'end_of_life', etiqueta: 'Fin de vida fijado a mano', grupo: 'vida', tipo: 'fecha' },
  { clave: 'hostname', etiqueta: 'Nombre de equipo (hostname)', grupo: 'ordenador', tipo: 'texto', pista: 'AULA-H17-PC01', codigo: true },
  { clave: 'mac_address', etiqueta: 'MAC', grupo: 'ordenador', tipo: 'mac', pista: 'AA:BB:CC:DD:EE:FF', codigo: true },
  { clave: 'ip_address', etiqueta: 'IP', grupo: 'ordenador', tipo: 'ip', pista: '10.20.1.15' },
  { clave: 'cpu', etiqueta: 'Procesador', grupo: 'ordenador', tipo: 'texto', pista: 'Intel Core i5-10400T' },
  { clave: 'ram', etiqueta: 'Memoria RAM', grupo: 'ordenador', tipo: 'texto', pista: '16 GB' },
  { clave: 'storage', etiqueta: 'Disco', grupo: 'ordenador', tipo: 'texto', pista: 'SSD 512 GB' },
  { clave: 'os', etiqueta: 'Sistema operativo', grupo: 'ordenador', tipo: 'texto', pista: 'Windows 11 Pro' },
  { clave: 'notes', etiqueta: 'Observaciones', grupo: 'notas', tipo: 'largo' },
]

export const GRUPO_LABEL: Record<GrupoDeFicha, string> = {
  identidad: 'Identificación',
  compra: 'Adquisición',
  vida: 'Vida útil',
  ordenador: 'Datos del ordenador',
  notas: 'Observaciones',
}

/** Lo que hay escrito en cada casilla, siempre como texto: así lo da un `<input>`. */
export type BorradorDeFicha = Record<ClaveDeFicha, string>

/** Un equipo del registro, puesto en las casillas de la ficha. */
export function borradorDe(e: Partial<Record<ClaveDeFicha, unknown>>): BorradorDeFicha {
  const b = {} as BorradorDeFicha
  for (const c of CAMPOS_DE_FICHA) {
    const v = e[c.clave]
    if (v === null || v === undefined) b[c.clave] = ''
    else if (c.tipo === 'fecha') b[c.clave] = String(v).slice(0, 10)
    else if (c.tipo === 'precio') b[c.clave] = precioParaEscribir(v)
    else b[c.clave] = String(v)
  }
  return b
}

/** `849.5` → `849,50`: el precio se escribe y se lee con coma, como en la factura. */
function precioParaEscribir(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(String(v))
  if (!Number.isFinite(n)) return String(v)
  return n.toFixed(2).replace('.', ',')
}

/**
 * Un precio tecleado, en número. `849`, `849,5`, `849.50`, `1.299,00`, `1 299 €`.
 *
 * El punto de miles y la coma decimal son lo que se escribe en España; el punto
 * decimal es lo que se pega desde una hoja en inglés. Si hay los dos, el último
 * es el decimal. Si solo hay puntos y el último deja tres cifras detrás
 * (`1.299`), es de miles: nadie escribe un precio con tres decimales.
 */
export function leerPrecio(texto: string): number | null {
  const limpio = texto.replace(/[€\s]/g, '')
  if (!limpio) return null
  if (!/^\d[\d.,]*$/.test(limpio)) return Number.NaN
  const ultimaComa = limpio.lastIndexOf(',')
  const ultimoPunto = limpio.lastIndexOf('.')
  let normalizado: string
  if (ultimaComa >= 0 && ultimoPunto >= 0) {
    const decimal = ultimaComa > ultimoPunto ? ',' : '.'
    const miles = decimal === ',' ? '.' : ','
    normalizado = limpio.split(miles).join('').replace(decimal, '.')
  } else if (ultimaComa >= 0) {
    normalizado = limpio.split('.').join('').replace(',', '.')
  } else if (ultimoPunto >= 0 && limpio.length - ultimoPunto - 1 === 3) {
    normalizado = limpio.split('.').join('')
  } else {
    normalizado = limpio
  }
  const n = Number(normalizado)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : Number.NaN
}

/**
 * Una MAC en su forma única, `AA:BB:CC:DD:EE:FF`, o `null` si no lo es.
 *
 * Vale con dos puntos, con guiones, con los puntos de Cisco (`aabb.ccdd.eeff`)
 * y sin separadores: lo que cuenta son las doce cifras hexadecimales.
 */
export function normalizarMac(texto: string): string | null {
  const hex = texto.replace(/[\s:.\-]/g, '').toUpperCase()
  if (!/^[0-9A-F]{12}$/.test(hex)) return null
  return hex.match(/.{2}/g)!.join(':')
}

/** ¿Es una IPv4 (`10.20.1.15`) o una IPv6? Sin máscara ni puerto. */
export function esIp(texto: string): boolean {
  const t = texto.trim()
  const v4 = t.split('.')
  if (v4.length === 4 && v4.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return true
  return /^[0-9a-f:]+$/i.test(t) && t.includes(':') && t.split(':').length <= 8
}

function esFecha(texto: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false
  const t = Date.parse(`${texto}T00:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === texto
}

/** Lo que está mal escrito en el borrador, casilla a casilla, para decirlo debajo de cada una. */
export function problemasDeFicha(b: BorradorDeFicha): Partial<Record<ClaveDeFicha, string>> {
  const p: Partial<Record<ClaveDeFicha, string>> = {}
  for (const c of CAMPOS_DE_FICHA) {
    const v = b[c.clave].trim()
    if (!v) continue
    if (c.tipo === 'fecha' && !esFecha(v)) p[c.clave] = 'No es una fecha válida.'
    if (c.tipo === 'precio') {
      const n = leerPrecio(v)
      if (n === null || Number.isNaN(n)) p[c.clave] = 'Escribe solo el importe, por ejemplo 849,00.'
      else if (n < 0) p[c.clave] = 'El precio no puede ser negativo.'
    }
    if (c.tipo === 'mac' && normalizarMac(v) === null) {
      p[c.clave] = 'Una MAC son doce cifras hexadecimales, por ejemplo AA:BB:CC:DD:EE:FF.'
    }
    if (c.tipo === 'ip' && !esIp(v)) p[c.clave] = 'No es una IP válida, por ejemplo 10.20.1.15.'
  }
  if (b.acquired_at && b.warranty_until && esFecha(b.acquired_at) && esFecha(b.warranty_until)) {
    if (b.warranty_until < b.acquired_at) p.warranty_until = 'La garantía no puede acabar antes de la compra.'
  }
  if (b.acquired_at && b.end_of_life && esFecha(b.acquired_at) && esFecha(b.end_of_life)) {
    if (b.end_of_life < b.acquired_at) p.end_of_life = 'El fin de vida no puede ser anterior a la compra.'
  }
  return p
}

/** El valor que se guarda de una casilla: normalizado, y `null` si está vacía. */
export function valorAGuardar(c: CampoDeFicha, texto: string): string | number | null {
  const v = texto.trim()
  if (!v) return null
  switch (c.tipo) {
    case 'precio':
      return leerPrecio(v)
    case 'mac':
      return normalizarMac(v) ?? v
    case 'texto':
      return c.codigo ? v.toUpperCase().replace(/\s+/g, ' ') : v.replace(/\s+/g, ' ')
    default:
      return v
  }
}

/**
 * Solo lo que ha cambiado, listo para el UPDATE.
 *
 * Se compara el valor **normalizado** con el de la base: reescribir una MAC en
 * minúsculas que ya estaba guardada en mayúsculas no es un cambio, y mandarlo
 * movería la fecha de «último cambio» de un equipo que nadie ha tocado.
 */
export function cambiosDeFicha(
  original: Partial<Record<ClaveDeFicha, unknown>>,
  b: BorradorDeFicha,
): Partial<Record<ClaveDeFicha, string | number | null>> {
  const antes = borradorDe(original)
  const cambios: Partial<Record<ClaveDeFicha, string | number | null>> = {}
  for (const c of CAMPOS_DE_FICHA) {
    const nuevo = valorAGuardar(c, b[c.clave])
    const viejo = valorAGuardar(c, antes[c.clave])
    if (nuevo !== viejo) cambios[c.clave] = nuevo
  }
  return cambios
}

// -----------------------------------------------------------------------------
// Buscar y filtrar
// -----------------------------------------------------------------------------

/**
 * ¿Responde este equipo a lo que se ha escrito en el buscador?
 *
 * Cada palabra tiene que aparecer en algún campo —«epson h» encuentra los Epson
 * del edificio H—, sin tildes ni mayúsculas. Los códigos (serie, inventario,
 * MAC) se comparan además sin separadores, que es como se teclean mal.
 */
export function coincideConBusqueda(e: EquipoDelRegistro, consulta: string): boolean {
  const palabras = norm(consulta).split(' ').filter(Boolean)
  if (palabras.length === 0) return true
  const campos = [
    e.type_name,
    e.label,
    e.brand,
    e.model,
    e.serial,
    e.inventory_tag,
    e.room_code,
    e.room_name,
    e.building_code,
    e.building_name,
    e.short_ref,
    e.hostname,
    e.mac_address,
    e.ip_address,
    e.supplier,
    e.purchase_ref,
  ]
  const texto = norm(campos.filter(Boolean).join(' '))
  const llano = texto.replace(/[\s:.\-_/]/g, '')
  return palabras.every((p) => texto.includes(p) || llano.includes(p.replace(/[:.\-_/]/g, '')))
}

export interface FiltroDeEquipos {
  consulta: string
  tipo: string
  edificio: string
  /** `activos` = instalados y averiados: lo que hay en las aulas hoy. */
  estado: 'activos' | AssetStatus | 'todos'
  vida: EstadoDeVida | 'todas'
  soloOrdenadores: boolean
}

export const FILTRO_INICIAL: FiltroDeEquipos = {
  consulta: '',
  tipo: '',
  edificio: '',
  estado: 'activos',
  vida: 'todas',
  soloOrdenadores: false,
}

/** ¿Es un ordenador? Por la categoría del tipo, que es como lo decide el catálogo. */
export function esOrdenador(e: Pick<EquipoDelRegistro, 'category' | 'type_name'>): boolean {
  return e.category === 'ti' || /ordenador|pc\b|port[aá]til|tiny/i.test(e.type_name)
}

export function filtrarEquipos(equipos: EquipoDelRegistro[], f: FiltroDeEquipos): EquipoDelRegistro[] {
  return equipos.filter(
    (e) =>
      (f.tipo === '' || e.asset_type_id === f.tipo) &&
      (f.edificio === '' || e.building_id === f.edificio) &&
      (f.estado === 'todos' ||
        (f.estado === 'activos' ? e.status !== 'retirado' : e.status === f.estado)) &&
      (f.vida === 'todas' || e.estado_vida === f.vida) &&
      (!f.soloOrdenadores || esOrdenador(e)) &&
      coincideConBusqueda(e, f.consulta),
  )
}

/** Como se recorre el campus: edificio, sala en orden numérico, tipo y etiqueta. */
export function ordenarEquipos(equipos: EquipoDelRegistro[]): EquipoDelRegistro[] {
  return [...equipos].sort(
    (a, b) =>
      (a.building_code ?? '~').localeCompare(b.building_code ?? '~', 'es') ||
      (a.room_code ?? '~').localeCompare(b.room_code ?? '~', 'es', { numeric: true }) ||
      a.type_name.localeCompare(b.type_name, 'es') ||
      (a.label ?? '').localeCompare(b.label ?? '', 'es', { numeric: true }),
  )
}

/** Los números de la cabecera: cuántos hay y cuántos piden atención. */
export function resumenDeEquipos(equipos: EquipoDelRegistro[]): {
  activos: number
  averiados: number
  obsoletos: number
  proximos: number
  sinSerie: number
  sinCompra: number
} {
  const activos = equipos.filter((e) => e.status !== 'retirado')
  return {
    activos: activos.length,
    averiados: activos.filter((e) => e.status === 'averiado').length,
    obsoletos: activos.filter((e) => e.estado_vida === 'obsoleto').length,
    proximos: activos.filter((e) => e.estado_vida === 'proximo').length,
    sinSerie: activos.filter((e) => !e.serial).length,
    sinCompra: activos.filter((e) => !e.acquired_at).length,
  }
}

// -----------------------------------------------------------------------------
// Excel
// -----------------------------------------------------------------------------

const ESTADO_LABEL: Record<AssetStatus, string> = {
  instalado: 'Instalado',
  averiado: 'Averiado',
  retirado: 'Retirado',
}

const COL_EQUIPOS = [
  'Ref',
  'Edificio',
  'Planta/Módulo',
  'Aula',
  'Tipo',
  'Nombre en el aula',
  'Marca',
  'Modelo',
  'N.º de serie',
  'N.º de inventario',
  'Estado',
  'Adquisición',
  'Proveedor',
  'Precio (€)',
  'Pedido/Factura',
  'Garantía hasta',
  'Vida útil (años)',
  'Fin de vida',
  'Vida útil',
  'Hostname',
  'MAC',
  'IP',
  'Procesador',
  'RAM',
  'Disco',
  'Sistema operativo',
  'Observaciones',
  'Alta en la app',
  'Baja',
]

/** `YYYY-MM-DD…` → número de fecha de Excel, o vacío. */
function fecha(iso: string | null): number | null {
  return iso ? fechaAExcel(iso.length > 10 ? iso : iso.slice(0, 10)) : null
}

function precio(v: number | string | null): number | null {
  if (v === null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Una fila por equipo, con toda su ficha.
 *
 * Es la hoja que se entrega cuando se pregunta «qué tenemos, de cuándo es y qué
 * hay que renovar»: lleva las mismas columnas que la ficha, en el mismo orden, y
 * la vida útil en palabras para poder filtrar por ella sin calcular nada. Lo
 * obsoleto sale en rojo, lo que caduca este año en ámbar y lo retirado apagado.
 */
export function hojaDeEquipos(equipos: EquipoDelRegistro[]): HojaNueva {
  const filas: ValorCelda[][] = [COL_EQUIPOS]
  const tintes: Array<Tinte | undefined> = []
  for (const e of ordenarEquipos(equipos)) {
    filas.push([
      e.short_ref,
      e.building_name ?? e.building_code,
      e.zone_name,
      e.room_code,
      e.type_name,
      e.label,
      e.brand,
      e.model,
      e.serial,
      e.inventory_tag,
      ESTADO_LABEL[e.status] ?? e.status,
      fecha(e.acquired_at),
      e.supplier,
      precio(e.purchase_price),
      e.purchase_ref,
      fecha(e.warranty_until),
      e.vida_util_anyos,
      fecha(e.fin_vida),
      ESTADO_DE_VIDA_LABEL[e.estado_vida] ?? null,
      e.hostname,
      e.mac_address,
      e.ip_address,
      e.cpu,
      e.ram,
      e.storage,
      e.os,
      e.notes,
      fecha(e.created_at),
      fecha(e.baja_at),
    ])
    tintes.push(
      e.status === 'retirado'
        ? 'apagado'
        : e.estado_vida === 'obsoleto'
          ? 'critico'
          : e.estado_vida === 'proximo'
            ? 'aviso'
            : undefined,
    )
  }
  return {
    nombre: 'Equipos',
    filas,
    anchos: [14, 20, 16, 12, 18, 20, 16, 22, 20, 18, 11, 12, 22, 11, 18, 12, 9, 12, 16, 20, 19, 15, 24, 10, 14, 20, 40, 12, 12],
    formatos: formatos({ 11: 'fecha', 15: 'fecha', 16: 'entero', 17: 'fecha', 26: 'textoAjustado', 27: 'fecha', 28: 'fecha' }),
    tintes,
    caracter: 'app',
  }
}

const COL_MOVIMIENTOS = [
  'Fecha',
  'Movimiento',
  'Tipo',
  'Nombre en el aula',
  'Marca',
  'Modelo',
  'N.º de serie',
  'N.º de inventario',
  'Aula',
  'Edificio',
  'Destino',
  'Motivo',
  'Quién',
]

const TINTE_DEL_MOVIMIENTO: Partial<Record<ClaseDeMovimiento, Tinte>> = {
  alta: 'ok',
  baja: 'critico',
  averia: 'aviso',
}

/**
 * Las entradas y salidas del parque, de la más antigua a la más reciente, que
 * es como se leen todos los historiales del libro.
 */
export function hojaDeEntradasYSalidas(movimientos: MovimientoDeEquipo[]): HojaNueva {
  const filas: ValorCelda[][] = [COL_MOVIMIENTOS]
  const tintes: Array<Tinte | undefined> = []
  const ordenados = [...movimientos].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
  for (const m of ordenados) {
    filas.push([
      fecha(m.occurred_at),
      MOVIMIENTO_LABEL[m.kind] ?? m.kind,
      m.type_name,
      m.label,
      m.brand,
      m.model,
      m.serial,
      m.inventory_tag,
      m.room_code,
      m.building_code,
      m.destino ? (DESTINO_LABEL[m.destino] ?? m.destino) : null,
      m.motivo,
      m.by_name,
    ])
    tintes.push(TINTE_DEL_MOVIMIENTO[m.kind])
  }
  return {
    nombre: 'Entradas y salidas',
    filas,
    anchos: [11, 16, 18, 20, 16, 22, 20, 18, 12, 10, 20, 40, 22],
    formatos: formatos({ 0: 'fecha', 11: 'textoAjustado' }),
    tintes,
    caracter: 'app',
  }
}

function formatos(porIndice: Record<number, Formato>): Array<Formato | undefined> {
  const maximo = Math.max(...Object.keys(porIndice).map(Number))
  const out = new Array<Formato | undefined>(maximo + 1).fill(undefined)
  for (const [i, f] of Object.entries(porIndice)) out[Number(i)] = f
  return out
}
