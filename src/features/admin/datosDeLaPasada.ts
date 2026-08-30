/**
 * Todo lo que la aplicación tiene que decir, leído de una vez.
 *
 * La sincronización necesita el estado entero: las 276 salas con sus equipos,
 * las revisiones para sacar las dos últimas fechas de cada una, las incidencias
 * con su material, y los movimientos de almacén del año. Traerlo pieza a pieza
 * —una consulta por sala— serían 276 viajes y una pantalla que tarda un minuto.
 * Aquí van once consultas planas y el cruce se hace en memoria.
 *
 * **Todo va paginado**, y eso no es prudencia. PostgREST aplica su tope de filas
 * **en silencio**: devuelve `200 OK` con las primeras mil y ninguna señal de que
 * falten más. Un dato truncado aquí no da un error, da algo peor — la pasada
 * cree que la aplicación no tiene ese equipo, decide que la celda del Excel gana
 * porque «la base no tenía este dato», y escribe en la base lo que ya estaba. Y
 * con 276 salas, sus equipos, dos años de partes y los movimientos de almacén,
 * el tope de mil está muy al alcance.
 *
 * Por eso, si alguna descarga viene incompleta, **se para**. Sincronizar con
 * medio inventario es peor que no sincronizar.
 */

import { supabase } from '@/lib/supabase'
import { descargaEntera } from '@/sync/paginada'
import type { ArticuloVolcado, IncidenciaVolcada, MovimientoVolcado, SalaVolcada } from '@/domain/volcado'
import { compradoEn, consumoPorMes } from '@/domain/volcado'
import type { EquipoParaHoja, MovimientoParaHoja, RevisionParaHoja } from '@/domain/hojasNuevas'
import { escribirMaterial } from '@/domain/valores'

// -----------------------------------------------------------------------------
// Lo que sale
// -----------------------------------------------------------------------------

export interface DatosDeLaPasada {
  salas: SalaVolcada[]
  incidencias: IncidenciaVolcada[]
  articulos: ArticuloVolcado[]
  /** Nombre escrito como sea → id del artículo. Sale de nombre + alias. */
  resolverArticulo: (nombre: string) => string | null
  /** Lo que queda en el almacén de cada artículo, para el corte de año. */
  saldos: Map<string, number>
  nombresAlternativos: Map<string, string | null>
  revisiones: RevisionParaHoja[]
  movimientos: MovimientoParaHoja[]
  equipos: EquipoParaHoja[]
}

interface FilaSala {
  id: string
  short_ref: string | null
  code: string
  name: string
  active: boolean
  zone_id: string
  projector_hours: number | null
  lamp_pct: number | null
  botonera_estado: string | null
  capabilities: Record<string, boolean> | null
}

interface FilaZona {
  id: string
  name: string
  building_id: string
}
interface FilaEdificio {
  id: string
  name: string
  code: string
  active: boolean
}
interface FilaEquipo {
  id: string
  room_id: string | null
  asset_type_id: string
  serial: string | null
  model: string | null
  status: string
  label: string | null
  created_at: string
}
interface FilaTipo {
  id: string
  name: string
  merged_into: string | null
}
interface FilaRevision {
  id: string
  room_id: string
  by_user: string | null
  occurred_at: string
  status: string
  overall: string | null
  notes: string | null
}
interface FilaCheck {
  inspection_id: string
  check_key: string
  result: string
  measure: number | null
  measure_unit: string | null
}
interface FilaPerfil {
  id: string
  full_name: string | null
}
interface FilaIncidencia {
  id: string
  room_id: string | null
  external_ref: string | null
  title: string
  description: string | null
  state: string
  opened_at: string
  resolved_at: string | null
  resolution: string | null
}
interface FilaMaterial {
  incident_id: string
  stock_item_id: string | null
  qty: number
  raw_text: string | null
}
interface FilaArticulo {
  id: string
  name: string
  aliases: string[] | null
  active: boolean
}
interface FilaMovimiento {
  stock_item_id: string
  qty: number
  kind: string
  occurred_at: string
  incident_id: string | null
  by_user: string | null
  note: string | null
}

/**
 * Lee el estado entero.
 *
 * `anyo` decide qué se reparte en las columnas de mes de la hoja `Bolsa`: el
 * consumo del año en curso, no el de siempre.
 */
export async function datosDeLaPasada(anyo: number): Promise<DatosDeLaPasada> {
  const [
    salasD,
    zonasD,
    edificiosD,
    equiposD,
    tiposD,
    revisionesD,
    checksD,
    perfilesD,
    incidenciasD,
    materialesD,
    articulosD,
    movimientosD,
  ] = await Promise.all([
    descargaEntera<FilaSala>((d, h) =>
      supabase
        .from('rooms')
        .select(
          'id, short_ref, code, name, active, zone_id, projector_hours, lamp_pct, botonera_estado, capabilities',
        )
        .order('id')
        .range(d, h),
    ),
    descargaEntera<FilaZona>((d, h) =>
      supabase.from('zones').select('id, name, building_id').order('id').range(d, h),
    ),
    descargaEntera<FilaEdificio>((d, h) =>
      supabase.from('buildings').select('id, name, code, active').order('id').range(d, h),
    ),
    descargaEntera<FilaEquipo>((d, h) =>
      supabase
        .from('assets')
        .select('id, room_id, asset_type_id, serial, model, status, label, created_at')
        .order('id')
        .range(d, h),
    ),
    descargaEntera<FilaTipo>((d, h) =>
      supabase.from('asset_types').select('id, name, merged_into').order('id').range(d, h),
    ),
    descargaEntera<FilaRevision>((d, h) =>
      supabase
        .from('inspections')
        .select('id, room_id, by_user, occurred_at, status, overall, notes')
        .order('id')
        .range(d, h),
    ),
    descargaEntera<FilaCheck>((d, h) =>
      supabase
        .from('inspection_checks')
        .select('inspection_id, check_key, result, measure, measure_unit')
        .order('id')
        .range(d, h),
    ),
    descargaEntera<FilaPerfil>((d, h) =>
      supabase.from('profiles').select('id, full_name').order('id').range(d, h),
    ),
    descargaEntera<FilaIncidencia>((d, h) =>
      supabase
        .from('incidents')
        .select('id, room_id, external_ref, title, description, state, opened_at, resolved_at, resolution')
        .order('id')
        .range(d, h),
    ),
    descargaEntera<FilaMaterial>((d, h) =>
      supabase
        .from('incident_materials')
        .select('incident_id, stock_item_id, qty, raw_text')
        .order('id')
        .range(d, h),
    ),
    descargaEntera<FilaArticulo>((d, h) =>
      supabase.from('stock_items').select('id, name, aliases, active').order('id').range(d, h),
    ),
    descargaEntera<FilaMovimiento>((d, h) =>
      supabase
        .from('stock_movements')
        .select('stock_item_id, qty, kind, occurred_at, incident_id, by_user, note')
        .order('id')
        .range(d, h),
    ),
  ])

  const descargas: Array<[string, { data: unknown[] | null; completa: boolean; error: { message: string } | null }]> = [
    ['el maestro de salas', salasD],
    ['las plantas', zonasD],
    ['los edificios', edificiosD],
    ['el inventario', equiposD],
    ['el catálogo de equipos', tiposD],
    ['las revisiones', revisionesD],
    ['las comprobaciones', checksD],
    ['los usuarios', perfilesD],
    ['las incidencias', incidenciasD],
    ['el material de las incidencias', materialesD],
    ['el catálogo del almacén', articulosD],
    ['los movimientos de almacén', movimientosD],
  ]
  for (const [que, d] of descargas) {
    if (d.error) throw new Error(`No se pudo leer ${que}: ${d.error.message}`)
    if (!d.completa) {
      throw new Error(
        `La descarga de ${que} vino incompleta. Sincronizar con medio inventario escribiría en la base datos que ya estaban: la pasada se para aquí.`,
      )
    }
  }

  const zonas = new Map((zonasD.data ?? []).map((z) => [z.id, z]))
  const edificios = new Map((edificiosD.data ?? []).map((b) => [b.id, b]))
  const perfiles = new Map((perfilesD.data ?? []).map((p) => [p.id, p.full_name ?? '']))

  // El nombre del tipo, siguiendo las fusiones: un equipo guardado con el id de
  // un tipo que luego se fundió tiene que salir con el nombre del vivo.
  const tipos = new Map((tiposD.data ?? []).map((t) => [t.id, t]))
  const nombreDelTipo = (id: string): string => {
    let t = tipos.get(id)
    for (let i = 0; t?.merged_into && i < 8; i++) t = tipos.get(t.merged_into)
    return t?.name ?? '—'
  }

  const donde = (zoneId: string): { edificio: string; zona: string } => {
    const z = zonas.get(zoneId)
    const b = z ? edificios.get(z.building_id) : undefined
    return { edificio: b?.name ?? '', zona: z?.name ?? '' }
  }

  // --- Salas y sus equipos ---------------------------------------------------
  const equiposPorSala = new Map<string, FilaEquipo[]>()
  for (const a of equiposD.data ?? []) {
    if (!a.room_id || a.status !== 'instalado') continue
    const l = equiposPorSala.get(a.room_id) ?? []
    l.push(a)
    equiposPorSala.set(a.room_id, l)
  }

  // --- Revisiones ------------------------------------------------------------
  const checksPorRevision = new Map<string, FilaCheck[]>()
  for (const c of checksD.data ?? []) {
    const l = checksPorRevision.get(c.inspection_id) ?? []
    l.push(c)
    checksPorRevision.set(c.inspection_id, l)
  }
  const revisionesPorSala = new Map<string, FilaRevision[]>()
  for (const r of revisionesD.data ?? []) {
    // Un borrador no es una revisión: no ha terminado y no puede fechar nada.
    if (r.status !== 'completa') continue
    const l = revisionesPorSala.get(r.room_id) ?? []
    l.push(r)
    revisionesPorSala.set(r.room_id, l)
  }
  for (const l of revisionesPorSala.values()) l.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))

  // --- Incidencias abiertas por sala, para la hoja de revisiones -------------
  const abiertasPorSala = new Map<string, number>()
  for (const i of incidenciasD.data ?? []) {
    if (!i.room_id || i.state === 'resuelta') continue
    abiertasPorSala.set(i.room_id, (abiertasPorSala.get(i.room_id) ?? 0) + 1)
  }

  const salas: SalaVolcada[] = []
  const equipos: EquipoParaHoja[] = []
  const revisiones: RevisionParaHoja[] = []

  for (const s of salasD.data ?? []) {
    // Sin matrícula no hay forma de identificar la fila entre dos pasadas. La
    // asigna un disparador de la base, así que solo pasa con un espejo viejo.
    if (!s.short_ref) continue
    const { edificio, zona } = donde(s.zone_id)
    const suyos = equiposPorSala.get(s.id) ?? []
    const misRevisiones = revisionesPorSala.get(s.id) ?? []

    salas.push({
      id: s.id,
      shortRef: s.short_ref,
      edificio,
      zona,
      code: s.code,
      activa: s.active,
      projectorHours: s.projector_hours,
      lampPct: s.lamp_pct,
      botoneraEstado: s.botonera_estado,
      capacidades: s.capabilities ?? {},
      revisiones: misRevisiones.slice(0, 2).map((r) => r.occurred_at),
      notas: misRevisiones[0]?.notes ?? null,
      equipos: suyos.map((a) => ({
        id: a.id,
        tipo: nombreDelTipo(a.asset_type_id),
        serial: a.serial,
        model: a.model,
        desde: a.created_at,
      })),
    })

    for (const a of suyos) {
      equipos.push({
        shortRef: s.short_ref,
        edificio,
        zona,
        sala: s.code,
        tipo: nombreDelTipo(a.asset_type_id),
        modelo: a.model,
        serial: a.serial,
        estado: a.status,
        desde: a.created_at,
        etiqueta: a.label,
      })
    }

    for (const r of misRevisiones) {
      const checks = checksPorRevision.get(r.id) ?? []
      revisiones.push({
        shortRef: s.short_ref,
        edificio,
        zona,
        sala: s.code,
        cuando: r.occurred_at,
        quien: r.by_user ? (perfiles.get(r.by_user) ?? null) : null,
        estado: r.status,
        resultado: r.overall,
        horasProyector: medidaDe(checks, 'h'),
        lampara: medidaDe(checks, '%'),
        comprobaciones: checks.length > 0 ? checks.map((c) => `${c.check_key}: ${c.result}`).join(' · ') : null,
        incidenciasAbiertas: abiertasPorSala.get(s.id) ?? 0,
        notas: r.notes,
      })
    }
  }

  // --- Almacén ---------------------------------------------------------------
  const articulosFilas = articulosD.data ?? []
  const porNombre = new Map<string, string>()
  for (const a of articulosFilas) {
    porNombre.set(llana(a.name), a.id)
    for (const alias of a.aliases ?? []) {
      // El nombre exacto gana al alias, igual que en `stock_item_id()`: si un
      // alias choca con el nombre de otro artículo, no lo pisa.
      if (!porNombre.has(llana(alias))) porNombre.set(llana(alias), a.id)
    }
  }

  const movimientosPorArticulo = new Map<string, MovimientoVolcado[]>()
  const saldos = new Map<string, number>()
  for (const m of movimientosD.data ?? []) {
    const l = movimientosPorArticulo.get(m.stock_item_id) ?? []
    l.push({ stockItemId: m.stock_item_id, qty: m.qty, kind: m.kind, occurredAt: m.occurred_at })
    movimientosPorArticulo.set(m.stock_item_id, l)
    saldos.set(m.stock_item_id, (saldos.get(m.stock_item_id) ?? 0) + m.qty)
  }

  const articulos: ArticuloVolcado[] = articulosFilas
    .filter((a) => a.active)
    .map((a) => {
      const suyos = movimientosPorArticulo.get(a.id) ?? []
      return {
        id: a.id,
        nombre: a.name,
        meses: consumoPorMes(suyos, anyo),
        comprado: compradoEn(suyos, anyo),
      }
    })

  const nombreDelArticulo = new Map(articulosFilas.map((a) => [a.id, a.name]))
  const nombresAlternativos = new Map(
    articulosFilas.map((a) => [a.id, a.aliases?.[0] ?? null] as [string, string | null]),
  )

  // --- Incidencias y su material --------------------------------------------
  const materialPorIncidencia = new Map<string, FilaMaterial[]>()
  for (const m of materialesD.data ?? []) {
    const l = materialPorIncidencia.get(m.incident_id) ?? []
    l.push(m)
    materialPorIncidencia.set(m.incident_id, l)
  }

  const salaPorId = new Map((salasD.data ?? []).map((s) => [s.id, s]))
  const incidencias: IncidenciaVolcada[] = []
  for (const i of incidenciasD.data ?? []) {
    // Sin número externo la fila no se puede emparejar con la del libro, que se
    // identifica justo por esa columna.
    if (!i.external_ref) continue
    const material = materialPorIncidencia.get(i.id) ?? []
    incidencias.push({
      id: i.id,
      numero: i.external_ref,
      salaCode: i.room_id ? (salaPorId.get(i.room_id)?.code ?? '') : '',
      abierta: i.opened_at.slice(0, 10),
      resuelta: i.resolved_at ? i.resolved_at.slice(0, 10) : null,
      problema: i.title,
      observacion: i.description,
      resolucion: i.resolution,
      material:
        material.length === 0
          ? null
          : escribirMaterial(
              material.map((m) => ({
                cantidad: m.qty,
                // Lo que no se pudo resolver a un artículo se devuelve tal y
                // como se escribió: es mejor que inventarse un nombre.
                articulo: m.stock_item_id
                  ? (nombreDelArticulo.get(m.stock_item_id) ?? (m.raw_text ?? ''))
                  : (m.raw_text ?? ''),
                crudo: m.raw_text ?? '',
              })),
            ),
    })
  }

  // --- Movimientos, para su hoja --------------------------------------------
  const numeroDeIncidencia = new Map(
    (incidenciasD.data ?? []).map((i) => [i.id, i.external_ref ?? ''] as [string, string]),
  )
  const salaDeIncidencia = new Map(
    (incidenciasD.data ?? []).map(
      (i) => [i.id, i.room_id ? (salaPorId.get(i.room_id)?.code ?? '') : ''] as [string, string],
    ),
  )
  const movimientos: MovimientoParaHoja[] = (movimientosD.data ?? []).map((m) => ({
    cuando: m.occurred_at.slice(0, 10),
    articulo: nombreDelArticulo.get(m.stock_item_id) ?? '—',
    cantidad: m.qty,
    tipo: m.kind,
    incidencia: m.incident_id ? (numeroDeIncidencia.get(m.incident_id) ?? null) : null,
    sala: m.incident_id ? (salaDeIncidencia.get(m.incident_id) ?? null) : null,
    quien: m.by_user ? (perfiles.get(m.by_user) ?? null) : null,
    nota: m.note,
  }))

  return {
    salas,
    incidencias,
    articulos,
    resolverArticulo: (nombre: string) => porNombre.get(llana(nombre)) ?? null,
    saldos,
    nombresAlternativos,
    revisiones,
    movimientos,
    equipos,
  }
}

/** La medida de una comprobación por su unidad: `h` las horas, `%` la lámpara. */
function medidaDe(checks: FilaCheck[], unidad: string): number | null {
  const c = checks.find((x) => x.measure !== null && x.measure_unit === unidad)
  return c?.measure ?? null
}

function llana(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}
