import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { pullMaster } from '@/sync/pull'
import { useConfirmar } from '@/components/Confirmar'

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
 *
 * Va la primera del panel, por delante del catálogo, porque es lo único de esta
 * pantalla que crece solo: cada ronda de revisiones deja equipos aquí.
 */

interface Pendiente {
  id: string
  label: string | null
  room_id: string | null
  /** La identidad ya resuelta por el servidor: «Ordenador Lenovo U3302». */
  identidad: string
  type_name: string
  brand: string | null
  model_name: string | null
  model_libre: string | null
  serial: string | null
  installed_at: string | null
  created_at: string | null
  created_by: string | null
  created_by_name: string | null
  room_code: string | null
  room_name: string | null
  building_code: string | null
}

const LIMITE = 300

export function EquiposPendientes(): React.ReactElement {
  const qc = useQueryClient()
  const [nota, setNota] = useState<string | null>(null)
  const { pedir, dialogo } = useConfirmar()

  /*
   * Una sola consulta contra `asset_overview`.
   *
   * Antes eran cuatro —los equipos, y luego las salas, el catálogo entero y los
   * perfiles para poder escribir sus nombres— y el catálogo se bajaba completo
   * para resolver ocho tipos. La vista ya trae la sala, el tipo, la marca, el
   * modelo y el autor resueltos, y de paso sigue las fusiones: un equipo cuyo
   * tipo se agrupó ayer sale con el nombre bueno y no con la lápida.
   */
  const { data: pendientes, isPending, isError, error, refetch } = useQuery({
    queryKey: ['assets', 'pendientes'],
    queryFn: async (): Promise<Pendiente[]> => {
      const { data: equipos, error: err } = await supabase
        .from('asset_overview')
        .select(
          'id, label, room_id, identidad, type_name, brand, model_name, model_libre, serial, installed_at, created_at, created_by, created_by_name, room_code, room_name, building_code',
        )
        .eq('confirmed', false)
        .neq('status', 'retirado')
        // Los más recientes arriba: son los de la ronda que se acaba de hacer,
        // y los que quien mira esto todavía recuerda.
        .order('created_at', { ascending: false })
        .limit(LIMITE)
      if (err) throw err
      return (equipos ?? []) as Pendiente[]
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
      // El espejo de este dispositivo se entera ahora y no en el próximo
      // refresco: quien administra suele tener la aplicación abierta en Revisar,
      // y ver ahí el equipo que acaba de retirar es media pantalla de confianza.
      void pullMaster()
    },
  })

  const lista = pendientes ?? []

  // Agrupados por sala. Sueltos, la lista son cuarenta líneas sin más orden que
  // la fecha; por sala se lee como lo que es —«en el 2.4 apuntaron tres cosas»—
  // y se decide de una vez en lugar de una por una.
  const porSala = new Map<string, Pendiente[]>()
  for (const p of lista) {
    const clave = p.room_id ?? 'sin-sala'
    porSala.set(clave, [...(porSala.get(clave) ?? []), p])
  }

  return (
    <section aria-labelledby="sec-equipos-pendientes" className="mt-8">
      <div className="section-head">
        <h2 id="sec-equipos-pendientes" className="eyebrow">
          Equipos sin validar
        </h2>
      </div>
      <p className="text-sm text-muted">
        Apuntados desde un aula. Ya cuentan en las revisiones; esto solo confirma que están.
      </p>

      {isPending && <p className="mt-3 text-sm text-muted">Cargando…</p>}

      {isError && (
        <div className="card mt-3 p-4">
          <p className="text-sm text-crit">
            No se han podido leer: {error instanceof Error ? error.message : ''}
          </p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="key key-quiet mt-3 min-h-11 px-3 text-sm"
          >
            Reintentar
          </button>
        </div>
      )}

      {pendientes && lista.length === 0 && (
        <p className="mt-3 text-sm text-muted">Nada pendiente de validar.</p>
      )}

      {pendientes && lista.length > 0 && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={act.isPending}
              onClick={() =>
                void pedir({
                  titulo: `¿Validar los ${lista.length} equipos de la lista?`,
                  detalle: `En ${new Set(lista.map((p) => p.room_id)).size} sala(s).`,
                  consecuencias: [
                    'Pasan a formar parte del inventario oficial: cuentan en las revisiones y en los informes.',
                    'Dejan de salir en naranja en el aula.',
                    'Para sacar uno de su sala después ya hará falta una solicitud de retirada.',
                  ],
                  confirmar: 'Validar',
                  tono: 'accent',
                }).then((si) => {
                  if (si) act.mutate({ kind: 'confirmar', ids: lista.map((p) => p.id) })
                })
              }
              className="key key-accent min-h-11 px-3 text-sm"
            >
              Validar los {lista.length}
            </button>
            {lista.length === LIMITE && (
              <span className="text-xs text-muted">
                Se muestran los {LIMITE} más recientes. Valida estos y vuelve a entrar.
              </span>
            )}
          </div>

          <ul className="mt-3 space-y-3">
            {[...porSala].map(([roomId, equipos]) => {
              const sala = equipos[0]

              return (
                <li key={roomId} className="card p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {sala?.room_code
                        ? `${sala.building_code} · ${sala.room_code}`
                        : 'Equipos sin sala asignada'}
                      {sala?.room_name && sala.room_name !== sala.room_code && (
                        <span className="ml-2 text-sm font-normal text-muted">{sala.room_name}</span>
                      )}
                    </span>
                    <button
                      type="button"
                      disabled={act.isPending}
                      onClick={() =>
                        act.mutate({ kind: 'confirmar', ids: equipos.map((e) => e.id) })
                      }
                      className="key key-accent min-h-11 px-3 text-sm"
                    >
                      Validar {equipos.length === 1 ? 'el equipo' : `los ${equipos.length}`}
                    </button>
                  </div>

                  <ul className="mt-2 divide-y divide-line-soft">
                    {equipos.map((e) => {
                      /* Marca y modelo del catálogo; si todavía no tiene, el
                         texto libre que se escribió, que es la pista de qué hay
                         que asignarle. */
                      const modelo =
                        [e.brand, e.model_name].filter(Boolean).join(' ') ||
                        e.model_libre?.trim() ||
                        ''

                      return (
                        <li key={e.id} className="flex items-center gap-2 py-2">
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {e.label ?? e.type_name}
                            </span>
                            {/* Tipo, marca, modelo y serie: es lo que hace que
                                validar sea una decisión y no un acto de fe. Antes
                                ponía el tipo y un modelo de texto libre que en la
                                mitad de los casos estaba vacío. */}
                            <span className="block truncate text-xs text-muted">
                              {[
                                e.type_name,
                                modelo || 'sin modelo',
                                e.serial ? `S/N ${e.serial}` : null,
                                e.created_by_name,
                                e.installed_at
                                  ? `instalado el ${new Date(e.installed_at).toLocaleDateString('es-ES')}`
                                  : e.created_at
                                    ? new Date(e.created_at).toLocaleDateString('es-ES')
                                    : null,
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                          </span>

                          <button
                            type="button"
                            disabled={act.isPending}
                            onClick={() =>
                              /*
                               * Esto BORRA el equipo de la sala, y era lo único
                               * destructivo de la pantalla que preguntaba con el
                               * cuadro gris del navegador: el dominio delante, sin
                               * decir de qué aparato hablamos ni qué se conserva.
                               * Ahora pregunta como el resto, y con el aparato
                               * identificado — en un aula con dos ordenadores,
                               * «este equipo» no dice cuál.
                               */
                              void pedir({
                                titulo: `¿Borrar «${e.label ?? e.type_name ?? 'este equipo'}» de la sala?`,
                                detalle: [
                                  e.type_name,
                                  modelo || 'sin modelo',
                                  e.serial ? `S/N ${e.serial}` : null,
                                ]
                                  .filter(Boolean)
                                  .join(' · '),
                                consecuencias: [
                                  'No se valida: se quita del inventario de la sala.',
                                  'Si alguna revisión llegó a comprobarlo, el servidor lo retira en vez de borrarlo y conserva su histórico.',
                                  'Quién lo descartó queda en la auditoría.',
                                ],
                                confirmar: 'Borrar de la sala',
                                tono: 'crit',
                              }).then((si) => {
                                if (si) act.mutate({ kind: 'descartar', id: e.id })
                              })
                            }
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
        </>
      )}

      {act.isError && (
        <p className="mt-3 text-sm text-crit">
          {act.error instanceof Error ? act.error.message : 'No se ha podido aplicar.'}
        </p>
      )}
      {nota && !act.isPending && !act.isError && (
        <p aria-live="polite" className="mt-3 text-sm text-ok">
          {nota}
        </p>
      )}

      {dialogo}
    </section>
  )
}
