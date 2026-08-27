/**
 * El maestro de salas tal y como lo necesita el cruce, leído desde la API.
 *
 * Es el mismo catálogo que arma `scripts/cruce-excel.ts` contra Postgres, pero
 * por PostgREST y desde el navegador. Que sean dos lecturas del mismo dato es a
 * propósito: el informe en seco tiene que poder ejecutarse sin la aplicación
 * delante, y la pantalla no puede depender de una conexión directa a la base.
 *
 * Todo va **paginado**, y no por prudencia: PostgREST aplica su tope de filas en
 * silencio —`200 OK` con las primeras N y ninguna señal de que falten más— y un
 * catálogo truncado no da un error, da algo peor: aulas que no cruzan, filas que
 * la pantalla declara «sin cruce» y una preparación del libro a la que le faltan
 * matrículas sin que nadie sepa por qué. Con 276 salas, sus alias y la
 * auditoría, el tope de 1.000 está al alcance.
 *
 * Y si alguna descarga viene incompleta se **para**, en vez de preparar el libro
 * con medio maestro.
 *
 * Lo que no se puede quitar de aquí sin que la pantalla mienta:
 *
 *  - Los **edificios**, aparte de las salas. Seis de ellos —`S`, `BC`, `G`,
 *    `TM`, `CC`, `CEFF`— no tienen ni una sala: los creó el importador al ver
 *    esas referencias en los partes. Un catálogo armado recorriendo salas los
 *    pierde, y entonces el cruce dice «ese edificio no está en el maestro»,
 *    que es falso.
 *  - Las **equivalencias de la auditoría**. Los renombrados y las fusiones
 *    hechos desde la aplicación están apuntados en `audit_log`, y son la
 *    traducción exacta de la nomenclatura vieja. Sin ellas, las filas de un
 *    edificio renombrado no cruzan.
 */

import { supabase } from '@/lib/supabase'
import { equivalenciasDesdeAuditoria } from '@/domain/cruce'
import type { Catalogo, SalaConocida } from '@/domain/cruce'
import { OLD_BUILDING_CODES } from '@/domain/normalize'
import { descargaEntera } from '@/sync/paginada'

interface FilaSala {
  id: string
  short_ref: string
  code: string
  name: string
  active: boolean
  zone_id: string
}

interface FilaZona {
  id: string
  name: string
  building_id: string
}

interface FilaAlias {
  room_id: string
  alias_norm: string
}

interface FilaEdificio {
  id: string
  code: string
  name: string
  active: boolean
  needs_review: boolean
}

interface FilaAuditoria {
  table_name: string
  row_id: string
  op: string
  old_data: Record<string, unknown> | null
  new_data: Record<string, unknown> | null
}

export async function catalogoDelMaestro(): Promise<Catalogo> {
  // Cuatro consultas planas en vez de una con `embed` anidado. PostgREST tipa
  // los embebidos como listas aunque la relación sea de uno a uno, y unir aquí
  // —con tablas de 23, 40 y 276 filas— cuesta menos que discutir con eso.
  const [salasD, zonasD, edificiosD, aliasD] = await Promise.all([
    descargaEntera<FilaSala>((d, h) =>
      supabase
        .from('rooms')
        .select('id, short_ref, code, name, active, zone_id')
        // `order` estable: sin él, dos páginas pueden solaparse o dejar un hueco.
        .order('id')
        .range(d, h),
    ),
    descargaEntera<FilaZona>((d, h) =>
      supabase.from('zones').select('id, name, building_id').order('id').range(d, h),
    ),
    descargaEntera<FilaEdificio>((d, h) =>
      supabase.from('buildings').select('id, code, name, active, needs_review').order('id').range(d, h),
    ),
    descargaEntera<FilaAlias>((d, h) =>
      supabase.from('room_aliases').select('room_id, alias_norm').order('id').range(d, h),
    ),
  ])

  for (const [que, d] of [
    ['el maestro de salas', salasD],
    ['las plantas', zonasD],
    ['los edificios', edificiosD],
    ['los alias', aliasD],
  ] as const) {
    if (d.error) throw new Error(`No se pudo leer ${que}: ${d.error.message}`)
    if (!d.completa) {
      throw new Error(
        `Llegó incompleto ${que}. Preparar el libro con medio maestro dejaría aulas sin matrícula sin decir por qué: vuelve a intentarlo.`,
      )
    }
  }

  const zonas = new Map((zonasD.data ?? []).map((z) => [z.id, z]))
  const edificiosPorId = new Map((edificiosD.data ?? []).map((b) => [b.id, b]))
  const aliasPorSala = new Map<string, string[]>()
  for (const a of aliasD.data ?? []) {
    const l = aliasPorSala.get(a.room_id)
    if (l) l.push(a.alias_norm)
    else aliasPorSala.set(a.room_id, [a.alias_norm])
  }

  const salas: SalaConocida[] = (salasD.data ?? []).map((r) => {
    const z = zonas.get(r.zone_id)
    const b = z ? edificiosPorId.get(z.building_id) : undefined
    return {
      id: r.id,
      shortRef: r.short_ref,
      code: r.code,
      name: r.name,
      active: r.active,
      zona: z?.name ?? 'SIN ZONA',
      edificioCodigo: b?.code ?? '??',
      edificioNombre: b?.name ?? '??',
      edificioActivo: b?.active ?? true,
      alias: aliasPorSala.get(r.id) ?? [],
    }
  })

  const edificios = (edificiosD.data ?? []).map((b) => ({
    codigo: b.code,
    nombre: b.name,
    activo: b.active,
    sinIdentificar: b.needs_review,
  }))

  return {
    salas,
    edificios,
    // Lo declarado a mano manda sobre lo deducido: quien escribe una línea en
    // `OLD_BUILDING_CODES` sabe algo que la auditoría no puede saber — los
    // códigos que ya eran viejos antes de cargar la base.
    equivalencias: {
      ...(await equivalenciasDeLaAuditoria(edificiosD.data ?? [])),
      ...OLD_BUILDING_CODES,
    },
  }
}

/**
 * Reconstruye a dónde fue a parar cada código viejo.
 *
 * `rename_building` cambia el código **sobre la misma fila**, así que la
 * auditoría deja el viejo y el nuevo con el mismo `row_id`. `merge_building`
 * mueve las zonas con `update zones set building_id` —que también se audita— y
 * después borra el edificio de origen. Con eso y el camino seguido hasta un
 * edificio vivo, la equivalencia es exacta y no hay nada que adivinar.
 *
 * Si la auditoría no se puede leer —el rol no llega, o viene a medias— se sigue
 * sin ella: se cruzará peor y las filas afectadas saldrán como «sin cruce», que
 * es visible en la pantalla, en vez de traducirse con media verdad.
 */
async function equivalenciasDeLaAuditoria(
  edificios: FilaEdificio[],
): Promise<Record<string, string>> {
  const d = await descargaEntera<FilaAuditoria>((desde, hasta) =>
    supabase
      .from('audit_log')
      .select('table_name, row_id, op, old_data, new_data')
      .in('table_name', ['buildings', 'zones'])
      .order('id')
      .range(desde, hasta),
  )

  if (d.error || !d.completa || !d.data) return {}

  const dato = (x: Record<string, unknown> | null, k: string): string | undefined => {
    const v = x?.[k]
    return typeof v === 'string' ? v : undefined
  }

  return equivalenciasDesdeAuditoria({
    vivos: edificios.map((b) => ({ id: b.id, codigo: b.code })),
    renombrados: d.data
      .filter(
        (r) =>
          r.table_name === 'buildings' &&
          r.op === 'UPDATE' &&
          dato(r.old_data, 'code') !== undefined &&
          dato(r.old_data, 'code') !== dato(r.new_data, 'code'),
      )
      .map((r) => ({ rowId: r.row_id, codigoViejo: dato(r.old_data, 'code')! })),
    fusiones: d.data
      .filter(
        (r) =>
          r.table_name === 'zones' &&
          r.op === 'UPDATE' &&
          dato(r.old_data, 'building_id') !== undefined &&
          dato(r.new_data, 'building_id') !== undefined &&
          dato(r.old_data, 'building_id') !== dato(r.new_data, 'building_id'),
      )
      .map((r) => ({ deId: dato(r.old_data, 'building_id')!, aId: dato(r.new_data, 'building_id')! })),
    borrados: d.data
      .filter((r) => r.table_name === 'buildings' && r.op === 'DELETE' && dato(r.old_data, 'code'))
      .map((r) => ({ rowId: r.row_id, codigo: dato(r.old_data, 'code')! })),
  })
}
