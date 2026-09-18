/**
 * La auditoría, leída con palabras.
 *
 * `audit_log` guarda cada cambio de lo que se puede editar —salas, edificios,
 * equipos, incidencias, usuarios, catálogo— con la fila entera antes y después,
 * en JSON. Es completo y es ilegible: `{"room_id":"7f3a…","label":"Pantalla 2"}`
 * no le dice a nadie que el proyector del 1.7 cambió de sala. Hasta ahora la
 * única forma de leerlo era SQL desde el servidor, así que en la práctica no se
 * leía, y «¿quién quitó esto?» se contestaba con «ni idea».
 *
 * Aquí se traduce: qué fila era (con su nombre, no su uuid), quién la tocó,
 * y qué campos cambiaron con el valor de antes y el de después, en el
 * vocabulario de la aplicación. Todo puro y sin red: los nombres los pone
 * quien llama, desde el espejo del dispositivo.
 *
 * Se omiten los campos que cambian solos —fecha de última revisión, orden— y
 * un cambio que solo tocó eso no se enseña: no es actividad de nadie.
 */

import { displayRoomCode } from './normalize'
import {
  ASSET_STATUS_LABELS,
  INCIDENT_KIND_LABELS,
  REMOVAL_DESTINO_LABELS,
  type RoomCapabilities,
} from './types'

export interface FilaDeAuditoria {
  id: number
  table_name: string
  row_id: string
  op: 'INSERT' | 'UPDATE' | 'DELETE'
  old_data: Record<string, unknown> | null
  new_data: Record<string, unknown> | null
  by_user: string | null
  at: string
}

/** Los nombres con los que se leen los uuid. Lo que falte sale abreviado. */
export interface Nombres {
  salas: Map<string, string>
  plantas: Map<string, string>
  edificios: Map<string, string>
  tipos: Map<string, string>
  equipos: Map<string, string>
  articulos: Map<string, string>
  personas: Map<string, string>
}

export const SIN_NOMBRES: Nombres = {
  salas: new Map(),
  plantas: new Map(),
  edificios: new Map(),
  tipos: new Map(),
  equipos: new Map(),
  articulos: new Map(),
  personas: new Map(),
}

export interface Cambio {
  campo: string
  antes: string | null
  despues: string | null
}

export type Operacion = 'alta' | 'cambio' | 'baja'

export interface Actividad {
  id: number
  cuando: string
  /** Nombre de quien lo hizo; nulo si lo hizo el sistema o no se sabe. */
  quien: string | null
  /** «Sala», «Equipo», «Usuario»… */
  tabla: string
  /** La fila, con su nombre: «1.7 H — Aula 1.7». */
  que: string
  op: Operacion
  cambios: Cambio[]
}

// -----------------------------------------------------------------------------
// Qué tabla es cada una y cómo se llama una fila
// -----------------------------------------------------------------------------

type Datos = Record<string, unknown>

const texto = (d: Datos, k: string): string | null => {
  const v = d[k]
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

const nombreDe = (mapa: Map<string, string>, id: unknown): string => {
  if (typeof id !== 'string' || id === '') return '—'
  return mapa.get(id) ?? `#${id.slice(0, 8)}`
}

interface Tabla {
  nombre: string
  etiqueta: (d: Datos, n: Nombres) => string
}

export const TABLAS: Record<string, Tabla> = {
  buildings: {
    nombre: 'Edificio',
    etiqueta: (d) => [texto(d, 'code'), texto(d, 'name')].filter(Boolean).join(' — ') || 'Edificio',
  },
  zones: {
    nombre: 'Planta',
    etiqueta: (d, n) => `${texto(d, 'name') ?? 'Planta'} · ${nombreDe(n.edificios, d['building_id'])}`,
  },
  rooms: {
    nombre: 'Sala',
    etiqueta: (d) => {
      const code = texto(d, 'code')
      const name = texto(d, 'name')
      const codigo = code ? displayRoomCode(code) : null
      return [codigo, name && name !== code ? name : null].filter(Boolean).join(' — ') || 'Sala'
    },
  },
  stock_items: {
    nombre: 'Artículo de almacén',
    etiqueta: (d) => texto(d, 'name') ?? 'Artículo',
  },
  assets: {
    nombre: 'Equipo',
    etiqueta: (d, n) => {
      const que = texto(d, 'label') ?? nombreDe(n.tipos, d['asset_type_id'])
      const sala = typeof d['room_id'] === 'string' ? nombreDe(n.salas, d['room_id']) : null
      return sala ? `${que} · ${sala}` : que
    },
  },
  incidents: {
    nombre: 'Incidencia',
    etiqueta: (d) => [texto(d, 'external_ref'), texto(d, 'title')].filter(Boolean).join(' · ') || 'Incidencia',
  },
  profiles: {
    nombre: 'Usuario',
    etiqueta: (d) => texto(d, 'full_name') ?? texto(d, 'email') ?? 'Usuario',
  },
  asset_types: {
    nombre: 'Tipo de equipo',
    etiqueta: (d) => texto(d, 'name') ?? 'Tipo',
  },
  asset_removals: {
    nombre: 'Retirada',
    etiqueta: (d, n) => `${nombreDe(n.equipos, d['asset_id'])} · ${valorLegible(d['destino'])}`,
  },
  asset_defaults: {
    nombre: 'Equipamiento por defecto',
    etiqueta: (d, n) =>
      `${nombreDe(n.tipos, d['asset_type_id'])} ×${String(d['qty'] ?? 1)} · ${
        typeof d['building_id'] === 'string' ? nombreDe(n.edificios, d['building_id']) : 'todas las salas'
      }`,
  },
}

// -----------------------------------------------------------------------------
// Qué campo es cada uno y cómo se lee un valor
// -----------------------------------------------------------------------------

/** Lo que cambia solo o no significa nada para quien lee. */
const IGNORADOS = new Set([
  'id',
  'created_at',
  'updated_at',
  'recorded_at',
  'last_inspection_at',
  'last_inventory_at',
  'sort_order',
  'name_norm',
  'search',
])

const CAMPOS: Record<string, string> = {
  code: 'Código',
  name: 'Nombre',
  full_name: 'Nombre',
  email: 'Correo',
  role: 'Rol',
  active: 'Activo',
  label: 'Etiqueta',
  serial: 'Nº de serie',
  brand: 'Marca',
  model: 'Modelo',
  status: 'Estado',
  state: 'Estado',
  kind: 'Tipo',
  confirmed: 'Validado',
  room_id: 'Sala',
  zone_id: 'Planta',
  building_id: 'Edificio',
  asset_type_id: 'Tipo de equipo',
  asset_id: 'Equipo',
  stock_item_id: 'Artículo',
  merged_into: 'Agrupado en',
  aliases: 'Alias',
  category: 'Categoría',
  tracks_serial: 'Lleva nº de serie',
  tracks_lamp_hours: 'Lleva horas de lámpara',
  needs_review: 'Sin identificar',
  review_note: 'Nota',
  capabilities: 'Equipamiento',
  projector_hours: 'Horas de proyector',
  lamp_pct: 'Lámpara',
  short_ref: 'Matrícula',
  title: 'Título',
  description: 'Descripción',
  severity: 'Gravedad',
  resolution: 'Resolución',
  resolved_at: 'Resuelta el',
  resolved_by: 'Resuelta por',
  opened_at: 'Abierta el',
  opened_by: 'Abierta por',
  external_ref: 'Nº del libro',
  easyvista_ref: 'Código EasyVista',
  check_key: 'Comprobación',
  opened_from_inspection_id: 'Revisión de origen',
  source: 'Origen',
  unit: 'Unidad',
  min_threshold: 'Mínimo',
  qty: 'Cantidad',
  destino: 'Destino',
  reason: 'Motivo',
  requested_at: 'Pedida el',
  requested_by: 'Pedida por',
  decided_at: 'Decidida el',
  decided_by: 'Decidida por',
  note: 'Nota',
}

/** Los valores de enumerado, en el vocabulario de las pantallas. */
const VALORES: Record<string, string> = {
  ...ASSET_STATUS_LABELS,
  ...INCIDENT_KIND_LABELS,
  ...REMOVAL_DESTINO_LABELS,
  aula: 'Aula',
  sala_reunion: 'Sala de reunión',
  laboratorio: 'Laboratorio',
  otro: 'Otro',
  borrador: 'Borrador',
  abierta: 'Abierta',
  en_curso: 'En curso',
  resuelta: 'Resuelta',
  pendiente: 'Pendiente',
  aprobada: 'Aprobada',
  rechazada: 'Rechazada',
  baja: 'Baja',
  media: 'Media',
  alta: 'Alta',
  tecnico: 'Técnico',
  supervisor: 'Supervisor',
  admin: 'Admin',
  app: 'Aplicación',
  import: 'Importación',
  system: 'Sistema',
}

const EQUIPAMIENTO: Record<keyof RoomCapabilities, string> = {
  proyector: 'proyector',
  altavoces: 'altavoces',
  camara: 'cámara',
  microfono: 'micrófono',
  botonera: 'botonera',
  tv: 'TV',
}

/** Qué mapa de nombres resuelve cada campo de referencia, según la tabla. */
function mapaDe(tabla: string, campo: string, n: Nombres): Map<string, string> | null {
  switch (campo) {
    case 'room_id':
      return n.salas
    case 'zone_id':
      return n.plantas
    case 'building_id':
      return n.edificios
    case 'asset_type_id':
      return n.tipos
    case 'asset_id':
      return n.equipos
    case 'stock_item_id':
      return n.articulos
    case 'merged_into':
      return tabla === 'buildings' ? n.edificios : n.tipos
    case 'opened_by':
    case 'resolved_by':
    case 'requested_by':
    case 'decided_by':
    case 'by_user':
      return n.personas
    default:
      return null
  }
}

function fechaLegible(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Madrid' }).format(d)
}

const PARECE_FECHA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

export function valorLegible(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'sí' : 'no'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') {
    if (PARECE_FECHA.test(v)) return fechaLegible(v)
    return VALORES[v] ?? v
  }
  if (Array.isArray(v)) return v.length === 0 ? '—' : v.map(valorLegible).join(', ')
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    // El equipamiento de la sala: solo lo que hay, con su nombre.
    const claves = Object.keys(EQUIPAMIENTO) as Array<keyof RoomCapabilities>
    if (claves.every((k) => k in o)) {
      const hay = claves.filter((k) => o[k] === true).map((k) => EQUIPAMIENTO[k])
      return hay.length ? hay.join(', ') : 'nada'
    }
    return JSON.stringify(o)
  }
  return String(v)
}

function valorDe(tabla: string, campo: string, v: unknown, n: Nombres): string {
  const mapa = mapaDe(tabla, campo, n)
  if (mapa && typeof v === 'string') return nombreDe(mapa, v)
  if (campo === 'lamp_pct' && typeof v === 'number') return `${Math.round(v * 100)} %`
  return valorLegible(v)
}

export function nombreDelCampo(campo: string): string {
  return CAMPOS[campo] ?? campo.replace(/_/g, ' ')
}

const iguales = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * Los campos que cambiaron entre las dos fotos, con sus valores leídos.
 * Solo los que importan: lo ignorado no cuenta como cambio.
 */
export function diferencias(tabla: string, antes: Datos, despues: Datos, n: Nombres = SIN_NOMBRES): Cambio[] {
  const campos = [...new Set([...Object.keys(antes), ...Object.keys(despues)])].filter((c) => !IGNORADOS.has(c))
  const cambios: Cambio[] = []
  for (const campo of campos) {
    if (iguales(antes[campo], despues[campo])) continue
    cambios.push({
      campo: nombreDelCampo(campo),
      antes: antes[campo] === undefined || antes[campo] === null ? null : valorDe(tabla, campo, antes[campo], n),
      despues: despues[campo] === undefined || despues[campo] === null ? null : valorDe(tabla, campo, despues[campo], n),
    })
  }
  return cambios
}

/**
 * Una fila de auditoría, contada. Nulo si no hay nada que contar: un cambio
 * que solo tocó lo que cambia solo.
 */
export function describir(fila: FilaDeAuditoria, n: Nombres = SIN_NOMBRES): Actividad | null {
  const tabla = TABLAS[fila.table_name]
  const datos = (fila.new_data ?? fila.old_data ?? {}) as Datos
  const base = {
    id: fila.id,
    cuando: fila.at,
    quien: fila.by_user ? (n.personas.get(fila.by_user) ?? null) : null,
    tabla: tabla?.nombre ?? fila.table_name,
    que: tabla ? tabla.etiqueta(datos, n) : `#${fila.row_id.slice(0, 8)}`,
  }

  if (fila.op === 'INSERT') return { ...base, op: 'alta', cambios: [] }
  if (fila.op === 'DELETE') return { ...base, op: 'baja', cambios: [] }

  const cambios = diferencias(fila.table_name, (fila.old_data ?? {}) as Datos, (fila.new_data ?? {}) as Datos, n)
  if (cambios.length === 0) return null
  return { ...base, op: 'cambio', cambios }
}

/** Una línea: lo que se lee sin desplegar. */
export function resumen(a: Actividad): string {
  if (a.op === 'alta') return `Alta de ${a.tabla.toLowerCase()}: ${a.que}`
  if (a.op === 'baja') return `Baja de ${a.tabla.toLowerCase()}: ${a.que}`
  const [primero, ...resto] = a.cambios
  const linea = primero ? `${primero.campo}: ${primero.antes ?? '—'} → ${primero.despues ?? '—'}` : ''
  return `${a.que} · ${linea}${resto.length ? ` y ${resto.length} más` : ''}`
}

export const OPERACION_LABELS: Record<Operacion, string> = {
  alta: 'Alta',
  cambio: 'Cambio',
  baja: 'Baja',
}
