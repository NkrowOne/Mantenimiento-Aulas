/**
 * ¿Hay algo que elegir al apuntar este artículo?
 *
 * Casi nunca. Un cable es un cable: se toca y se resta. Pero hay dos casos en
 * que «uno» no basta, y hasta ahora los decidía la base por su cuenta al cerrar
 * la avería:
 *
 *  - **Hay de varios estados.** De ocho teclados, cinco nuevos y tres usados:
 *    cuál se ha puesto importa —el almacén sacaba siempre el usado— y solo lo
 *    sabe quien lo tiene en la mano.
 *  - **Lleva número de serie.** Un proyector no es «un proyector»: es ese. Sin
 *    decir cuál, se descontaba uno y el aparato seguía «en el almacén».
 *
 * La regla, que es la de toda la aplicación: **se pregunta solo si la respuesta
 * puede ser más de una**. Con un único estado en la estantería, o sin saber
 * cuántas hay de cada uno, no hay pregunta: se apunta sin decir cuál y la base
 * saca de lo que haya, como siempre. Con un único aparato y nada más, es ese y
 * se apunta solo —con su número a la vista, para poder comprobarlo—.
 *
 * Las cifras son las del espejo del dispositivo: una foto. Por eso lo elegido
 * es una preferencia y no una exigencia —si al cerrar ya no queda de ese
 * estado, sale de lo que haya— y por eso aquí no se bloquea nada.
 */

import type { NivelPorEstado } from '@/domain/estados'
import { ordenarUnidades, type Condicion, type UnidadDeAlmacen } from '@/domain/unidades'
import type { Cual, DetalleDeMaterial } from './material'

/** Un estado que se puede elegir, con cuántas quedarían por apuntar. */
export interface OpcionDeEstado {
  condicion: Condicion
  quedan: number
}

export interface Opciones {
  /** Los aparatos con número de serie que aún no están en este parte. */
  unidades: UnidadDeAlmacen[]
  /** Los estados con existencias, en el orden en que se ofrecen. */
  estados: OpcionDeEstado[]
  /**
   * Cuántas cuenta el almacén sin número de serie, descontadas las que este
   * parte ya lleva sin número. Solo en artículos por número de serie.
   */
  sinNumero: number
  /** `true` si hay que preguntar. */
  hayQueElegir: boolean
  /** Lo que se apunta cuando no hay que preguntar. */
  unica: Cual
}

/**
 * El orden en que se ofrecen: lo que se pondría antes, primero. Lo averiado al
 * final —se puede haber puesto, pero no es lo normal— y «sin estado» justo
 * antes, que es lo que nadie ha mirado.
 */
const ORDEN_DE_OFERTA: Condicion[] = ['nuevo', 'reacondicionado', 'usado', 'sin_indicar', 'averiado']

const NADA: Opciones = { unidades: [], estados: [], sinNumero: 0, hayQueElegir: false, unica: null }

export function opcionesDeMaterial(d: {
  /** Cómo se lleva el artículo. Sin dato, se deduce: si tiene unidades, por número de serie. */
  seguimiento?: 'cantidad' | 'serie' | null
  /** Su fila de `stock_levels_por_estado`, si el espejo la tiene. */
  nivel: NivelPorEstado | null
  /** Cuántas hay en total según `stock_levels`, por si no hay `nivel`. */
  quedan: number | null
  /** Sus unidades DISPONIBLES con número de serie, sin las que otro parte de este dispositivo ya tiene apuntadas. */
  unidades: UnidadDeAlmacen[]
  /** Lo que este parte ya lleva de este artículo. */
  apuntado: DetalleDeMaterial[]
}): Opciones {
  const seguimiento = d.seguimiento ?? d.nivel?.seguimiento ?? (d.unidades.length > 0 ? 'serie' : 'cantidad')

  if (seguimiento === 'serie') {
    const yaElegidas = new Set(d.apuntado.map((a) => a.unitId).filter(Boolean))
    const unidades = ordenarUnidades(d.unidades.filter((u) => !yaElegidas.has(u.id)))
    const total = d.nivel?.on_hand ?? d.quedan
    // Las contadas que ninguna unidad nombra, menos las que el parte ya lleva
    // sin número. Sin saber el total, no se ofrece: no se puede saber si hay.
    const sinNumeroApuntadas = d.apuntado.filter((a) => !a.unitId).reduce((n, a) => n + a.unidades, 0)
    const sinNumero = total === null ? 0 : Math.max(0, total - d.unidades.length - sinNumeroApuntadas)

    if (unidades.length === 0) return { ...NADA, sinNumero }
    if (unidades.length === 1 && sinNumero === 0) {
      const u = unidades[0]!
      return { unidades, estados: [], sinNumero, hayQueElegir: false, unica: { unitId: u.id, condicion: u.condicion } }
    }
    return { unidades, estados: [], sinNumero, hayQueElegir: true, unica: null }
  }

  // Por cantidad: los estados en los que queda alguna por apuntar.
  if (!d.nivel) return NADA
  const apuntadas = new Map<Condicion, number>()
  for (const a of d.apuntado) {
    if (a.condicion && !a.unitId) apuntadas.set(a.condicion, (apuntadas.get(a.condicion) ?? 0) + a.unidades)
  }
  const estados = ORDEN_DE_OFERTA.map((condicion) => ({
    condicion,
    quedan: Math.max(0, (d.nivel![condicion] ?? 0) - (apuntadas.get(condicion) ?? 0)),
  })).filter((e) => e.quedan > 0)

  /*
   * Con un solo estado no se pregunta — salvo que el parte ya lleve de otro.
   * Quien ha apuntado «2 nuevos» y agota los nuevos tiene que poder ver que el
   * siguiente es usado, no descubrirlo en el Excel.
   */
  const yaHaElegido = d.apuntado.some((a) => a.condicion && !a.unitId)
  const hayQueElegir = estados.length > 1 || (estados.length === 1 && yaHaElegido)
  return { unidades: [], estados, sinNumero: 0, hayQueElegir, unica: null }
}

/**
 * Las unidades con número de serie que se pueden ofrecer, por artículo: las
 * disponibles del espejo, sin las que otro parte de ESTE dispositivo tiene ya
 * apuntadas y sin subir. El servidor aún no lo sabe —el almacén no se mueve
 * hasta el cierre—, y ofrecerla otra vez sería gastar el mismo aparato en dos
 * averías.
 */
export function unidadesLibres(
  disponibles: UnidadDeAlmacen[],
  enOtrosPartes: Set<string>,
): Map<string, UnidadDeAlmacen[]> {
  const out = new Map<string, UnidadDeAlmacen[]>()
  for (const u of disponibles) {
    if (!u.stock_item_id || u.status !== 'disponible' || enOtrosPartes.has(u.id)) continue
    const suyas = out.get(u.stock_item_id)
    if (suyas) suyas.push(u)
    else out.set(u.stock_item_id, [u])
  }
  return out
}
