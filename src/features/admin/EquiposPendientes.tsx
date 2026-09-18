import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { pullMaster } from '@/sync/pull'
import { fechaCorta } from '@/domain/fechas'
import { Cargando, EstadoVacio, FalloDeCarga, Nota, Seccion, mensajeDe } from './Seccion'
import { useRefrescarPendientes } from './pendientes'

/**
 * Los equipos que alguien apuntó desde un aula y nadie ha mirado todavía.
 *
 * Es la contrapartida de dejar que el técnico dé de alta inventario sin pedir
 * permiso. Sin esta bandeja, «apuntar lo que hay delante» produce un inventario
 * que nadie ha revisado nunca — y un inventario sin revisar no se puede usar
 * para nada que importe, porque no se sabe qué parte es cierta.
 *
 * Tres cosas la separan de la bandeja de tipos, que está justo debajo:
 *
 *  - Ahí se decide **cómo se llama** una clase de aparato. Aquí, si un aparato
 *    concreto **está de verdad** en esa aula.
 *  - Aquí no se fusiona nada: un equipo o está o no está.
 *  - Y por eso la segunda salida no es «corregir» sino «retirar»: si el equipo
 *    ya no está —se lo llevaron, se apuntó dos veces—, sale del inventario y se
 *    queda en el histórico de la sala, que es donde tiene que quedarse.
 */

interface Pendiente {
  id: string
  label: string | null
  room_id: string | null
  asset_type_id: string
  serial: string | null
  model: string | null
  created_at: string | null
  created_by: string | null
}

interface Sala {
  room_id: string
  room_code: string
  room_name: string
  building_code: string
}

const LIMITE = 300

export function EquiposPendientes(): React.ReactElement {
  const qc = useQueryClient()
  const refrescar = useRefrescarPendientes()
  const [nota, setNota] = useState<string | null>(null)

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['assets', 'pendientes'],
    queryFn: async () => {
      const { data: equipos, error: err } = await supabase
        .from('assets')
        .select('id, label, room_id, asset_type_id, serial, model, created_at, created_by')
        .eq('confirmed', false)
        .neq('status', 'retirado')
        // Los más recientes arriba: son los de la ronda que se acaba de hacer,
        // y los que quien mira esto todavía recuerda.
        .order('created_at', { ascending: false })
        .limit(LIMITE)
      if (err) throw err

      const pendientes = (equipos ?? []) as Pendiente[]
      if (pendientes.length === 0) {
        return { pendientes, salas: new Map<string, Sala>(), tipos: new Map<string, string>(), quien: new Map<string, string>() }
      }

      // Los tres contextos que hacen falta para decidir, y ninguno más: dónde
      // está, qué es y quién lo apuntó. Se piden solo para lo que hay en la
      // bandeja en vez de bajarse las 276 salas y el catálogo entero.
      const roomIds = [...new Set(pendientes.map((p) => p.room_id).filter(Boolean))] as string[]
      const userIds = [...new Set(pendientes.map((p) => p.created_by).filter(Boolean))] as string[]

      const [salasRes, tiposRes, perfilesRes] = await Promise.all([
        roomIds.length
          ? supabase
              .from('room_overview')
              .select('room_id, room_code, room_name, building_code')
              .in('room_id', roomIds)
          : Promise.resolve({ data: [] }),
        supabase.from('asset_types').select('id, name'),
        userIds.length
          ? supabase.from('profiles').select('id, full_name').in('id', userIds)
          : Promise.resolve({ data: [] }),
      ])

      return {
        pendientes,
        salas: new Map(((salasRes.data ?? []) as Sala[]).map((s) => [s.room_id, s])),
        tipos: new Map(
          ((tiposRes.data ?? []) as Array<{ id: string; name: string }>).map((t) => [t.id, t.name]),
        ),
        quien: new Map(
          ((perfilesRes.data ?? []) as Array<{ id: string; full_name: string }>).map((p) => [
            p.id,
            p.full_name,
          ]),
        ),
      }
    },
  })

  const act = useMutation({
    mutationFn: async (input: { kind: 'confirmar'; ids: string[] } | { kind: 'descartar'; id: string }) => {
      if (input.kind === 'confirmar') {
        const { data: n, error: err } = await supabase.rpc('confirm_assets', { p_ids: input.ids })
        if (err) throw err
        return `${n as number} equipo(s) validado(s).`
      }

      /*
       * No autorizarlo lo BORRA de la sala, no lo deja retirado.
       *
       * Un equipo sin validar es una propuesta, y una propuesta rechazada no
       * tiene por qué convertirse en un aparato retirado en el histórico de una
       * sala donde nunca hubo nada. Lo que queda es la fila de auditoría de
       * quien lo descartó, que es todo lo que hay que conservar.
       *
       * El servidor lo retira en vez de borrarlo si de él cuelga algo que ya se
       * firmó —una revisión que lo comprobó, una incidencia que lo señala—, y
       * dice cuál de las dos ha hecho.
       */
      const { data: resultado, error: err } = await supabase.rpc('reject_asset', {
        p_id: input.id,
      })
      if (err) throw err
      return resultado === 'borrado'
        ? 'Borrado de la sala.'
        : 'Retirado de la sala: alguna revisión ya lo había comprobado, así que la fila se conserva.'
    },
    onSuccess: (mensaje) => {
      setNota(mensaje)
      void qc.invalidateQueries({ queryKey: ['assets'] })
      refrescar()
      // El espejo de este dispositivo se entera ahora y no en el próximo
      // refresco: quien administra suele tener la aplicación abierta en Revisar,
      // y ver ahí el equipo que acaba de retirar es media pantalla de confianza.
      void pullMaster()
    },
  })

  const pendientes = data?.pendientes ?? []

  // Agrupados por sala. Sueltos, la lista son cuarenta líneas sin más orden que
  // la fecha; por sala se lee como lo que es —«en el 2.4 apuntaron tres cosas»—
  // y se decide de una vez en lugar de una por una.
  const porSala = new Map<string, Pendiente[]>()
  for (const p of pendientes) {
    const clave = p.room_id ?? 'sin-sala'
    porSala.set(clave, [...(porSala.get(clave) ?? []), p])
  }

  return (
    <Seccion
      id="sec-equipos-pendientes"
      titulo="Equipos sin validar"
      texto="Apuntados desde un aula. Ya cuentan en las revisiones; esto solo confirma que están. «No está» lo borra de la sala, o lo retira si alguna revisión ya lo comprobó."
      pendientes={pendientes.length}
      acciones={
        data && pendientes.length > 0 ? (
          <>
            <button
              type="button"
              disabled={act.isPending}
              onClick={() => {
                if (confirm(`¿Validar los ${pendientes.length} equipos de la lista?`)) {
                  act.mutate({ kind: 'confirmar', ids: pendientes.map((p) => p.id) })
                }
              }}
              className="key key-accent min-h-11 px-3 text-sm"
            >
              Validar los {pendientes.length}
            </button>
            {pendientes.length === LIMITE && (
              <span className="text-xs text-muted">Se muestran los {LIMITE} más recientes.</span>
            )}
          </>
        ) : undefined
      }
    >
      {isPending && <Cargando />}
      {isError && <FalloDeCarga que="los equipos sin validar" error={error} onReintentar={() => void refetch()} />}
      {data && pendientes.length === 0 && (
        <EstadoVacio titulo="Todo el inventario apuntado está validado" />
      )}

      {data && pendientes.length > 0 && (
        <ul className="space-y-3">
          {[...porSala].map(([roomId, equipos]) => {
            const sala = data.salas.get(roomId)

            return (
              <li key={roomId} className="card p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {sala ? (
                      <>
                        <span className="rounded-tag bg-raised px-2 py-0.5 font-mono text-sm font-semibold text-accent">
                          {sala.building_code} {sala.room_code}
                        </span>
                        {sala.room_name !== sala.room_code && (
                          <span className="ml-2 text-sm font-normal text-muted">{sala.room_name}</span>
                        )}
                      </>
                    ) : (
                      'Equipos sin sala asignada'
                    )}
                  </span>
                  <button
                    type="button"
                    disabled={act.isPending}
                    onClick={() => act.mutate({ kind: 'confirmar', ids: equipos.map((e) => e.id) })}
                    className="key key-accent min-h-11 px-3 text-sm"
                  >
                    Validar {equipos.length === 1 ? 'el equipo' : `los ${equipos.length}`}
                  </button>
                </div>

                <ul className="mt-2 divide-y divide-line-soft">
                  {equipos.map((e) => {
                    const detalle = [e.model, e.serial].filter(Boolean).join(' · ')
                    const autor = e.created_by ? data.quien.get(e.created_by) : null

                    return (
                      <li key={e.id} className="flex items-center gap-2 py-2">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {e.label ?? data.tipos.get(e.asset_type_id) ?? 'Equipo'}
                          </span>
                          <span className="block truncate text-xs text-muted">
                            {[
                              data.tipos.get(e.asset_type_id),
                              detalle || 'sin modelo ni serie',
                              autor,
                              e.created_at ? fechaCorta(e.created_at) : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </span>

                        <button
                          type="button"
                          disabled={act.isPending}
                          onClick={() => {
                            // Borra el equipo de la sala. Se confirma por lo
                            // mismo que en el aula: no hay botón de deshacer
                            // al lado.
                            if (
                              confirm(
                                `¿Borrar «${e.label ?? 'este equipo'}» de la sala? No se autoriza y desaparece del inventario.`,
                              )
                            ) {
                              act.mutate({ kind: 'descartar', id: e.id })
                            }
                          }}
                          className="key key-quiet min-h-11 shrink-0 px-3 text-xs text-muted"
                        >
                          No está
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </li>
            )
          })}
        </ul>
      )}

      <Nota texto={act.isError ? mensajeDe(act.error) : nota} tono={act.isError ? 'crit' : 'ok'} />
    </Seccion>
  )
}
