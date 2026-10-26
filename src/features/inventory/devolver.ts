/**
 * Devolver al inventario lo que una fusión de duplicados retiró por error.
 *
 * Tres migraciones lo intentaron para los treinta puestos del laboratorio de
 * informática 6 y ninguna los devolvió en producción. Lo que cuenta es que una
 * migración depende de cosas que no se ven desde la aplicación: que el
 * despliegue las aplique, que la base sea como se supuso al escribirlas. Esto
 * no depende de nada de eso. Lo pulsa un coordinador desde la hoja de la sala,
 * sobre las filas que esa misma hoja enseña, y escribe con los mismos permisos
 * con los que ya se corrige un equipo cada día.
 *
 * Por cada equipo:
 *
 *  - vuelve a `instalado`, en la sala que la hoja le pone —si la fila la había
 *    perdido, la hoja la saca del histórico— y con la fecha de alta que se
 *    elige, que es la de la instalación de verdad;
 *  - se apunta un `alta` en su histórico, por delante de la baja que deshace:
 *    es lo que hace que la hoja deje de leerlo como baja (`20261026000100`), y
 *    lo que deja escrito quién lo devolvió y cuándo;
 *  - y queda fuera de la bandeja de duplicados, con la misma marca que deja
 *    «Son dos aparatos», para que nadie lo vuelva a fundir mañana.
 *
 * La baja de la fusión NO se borra: sigue en el histórico y cuenta lo que pasó.
 */

import { v7 as uuidv7 } from 'uuid'
import { supabase } from '@/lib/supabase'
import type { FilaDeInventario } from './hoja'

/** El motivo exacto que deja `fusionar_equipo_duplicado` en la baja. */
export const MOTIVO_FUSION = 'Retirado en una fusión de duplicados'

/** Las filas de la hoja que una fusión retiró y siguen retiradas. */
export function retiradasPorFusion(filas: FilaDeInventario[]): FilaDeInventario[] {
  return filas.filter((f) => f.status === 'retirado' && f.baja_motivo === MOTIVO_FUSION)
}

/**
 * El instante del alta: el día elegido a las nueve de la mañana, hora local.
 *
 * A medianoche la fecha se lee como el día anterior en cuanto alguien mira el
 * papel desde otro huso; a las nueve es el mismo día en todos.
 */
export function instanteDeAlta(dia: string): Date {
  return new Date(`${dia}T09:00:00`)
}

/** El alta va por delante de la baja que deshace, con un minuto de margen. */
export function cuandoVuelve(alta: Date, bajaAt: string | null): string {
  const baja = bajaAt ? Date.parse(bajaAt) : Number.NaN
  const t = Number.isNaN(baja) ? alta.getTime() : Math.max(alta.getTime(), baja + 60_000)
  return new Date(t).toISOString()
}

export type Devolucion =
  | { ok: true; devueltos: number; fueraDeLaBandeja: boolean }
  | { ok: false; motivo: string }

/**
 * Devuelve las filas al inventario.
 *
 * `todas` son todas las filas de la hoja, con las vivas: los ordenadores que ya
 * estaban instalados en la misma sala también salen de la bandeja, porque
 * cualquiera de ellos puede aparecer como «duplicado» de uno de los devueltos.
 */
export async function devolverAlInventario(
  devolver: FilaDeInventario[],
  todas: FilaDeInventario[],
  dia: string,
): Promise<Devolucion> {
  if (devolver.length === 0) return { ok: true, devueltos: 0, fueraDeLaBandeja: true }

  const { data: sesion } = await supabase.auth.getSession()
  const yo = sesion.session?.user.id
  if (!yo) return { ok: false, motivo: 'no hay sesión: vuelve a entrar con tu PIN' }

  const alta = instanteDeAlta(dia)
  if (Number.isNaN(alta.getTime())) return { ok: false, motivo: 'la fecha de alta no es válida' }

  // Una actualización por sala: en la hoja de una sala es una sola.
  const porSala = new Map<string, string[]>()
  for (const f of devolver) porSala.set(f.room_id, [...(porSala.get(f.room_id) ?? []), f.asset_id])

  const vivos = companerosVivos(devolver, todas)

  for (const [sala, ids] of porSala) {
    const { error } = await supabase
      .from('assets')
      .update({ status: 'instalado', room_id: sala, created_at: alta.toISOString() })
      .in('id', ids)
    if (error) return { ok: false, motivo: error.message }
  }

  // Los del mismo tipo que ya estaban vivos en la sala llegaron con ellos: la
  // misma fecha de alta. Es lo que hace que la hoja diga un solo día para los
  // treinta puestos y no treinta y uno con uno suelto de agosto.
  if (vivos.length > 0) {
    const { error } = await supabase
      .from('assets')
      .update({ created_at: alta.toISOString() })
      .in('id', vivos.map((f) => f.asset_id))
    if (error) return { ok: false, motivo: error.message }
  }

  const { error: errorEventos } = await supabase.from('asset_events').insert(
    devolver.map((f) => ({
      id: uuidv7(),
      asset_id: f.asset_id,
      room_id: f.room_id,
      kind: 'alta',
      occurred_at: cuandoVuelve(alta, f.baja_at),
      by_user: yo,
      meta: {
        nota: 'Vuelve al inventario: la fusión de duplicados que lo retiró era un error.',
        instalado_el: dia,
      },
    })),
  )
  if (errorEventos) {
    // Los equipos ya están instalados; sin el alta la hoja los seguiría leyendo
    // como baja. Se dice tal cual para que se pueda volver a pulsar.
    return { ok: false, motivo: `están instalados, pero no se ha podido apuntar su alta: ${errorEventos.message}` }
  }

  const fuera = [...devolver, ...vivos]
  const { error: errorBandeja } = await supabase.from('asset_label_conflicts').insert(
    fuera.map((f) => ({
      room_id: f.room_id,
      asset_id: f.asset_id,
      op: 'descartado',
      resolved: true,
      resolved_at: new Date().toISOString(),
    })),
  )

  return { ok: true, devueltos: devolver.length, fueraDeLaBandeja: !errorBandeja }
}

/**
 * Los equipos vivos del mismo tipo y la misma sala que los que se devuelven.
 *
 * Son los que se quedaron con la identidad de los fundidos —el «bueno» de cada
 * fusión— y los que llegaron con ellos: comparten fecha de alta y, en la
 * bandeja de duplicados, cualquiera puede salir como copia de otro.
 */
export function companerosVivos(devolver: FilaDeInventario[], todas: FilaDeInventario[]): FilaDeInventario[] {
  const ids = new Set(devolver.map((f) => f.asset_id))
  const tipos = new Set(devolver.map((f) => f.type_name))
  const salas = new Set(devolver.map((f) => f.room_id))
  return todas.filter(
    (f) => !ids.has(f.asset_id) && f.status !== 'retirado' && salas.has(f.room_id) && tipos.has(f.type_name),
  )
}
