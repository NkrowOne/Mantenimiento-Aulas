/**
 * La papelera del maestro: lo que se dio de baja y todavía se puede recuperar.
 *
 * Es lo que **solo** puede vivir en el panel. Todo lo demás del maestro está
 * también en la lista de «Revisar» —renombrar, añadir, dar de baja: un nombre
 * mal escrito se descubre delante de la puerta—, pero un edificio archivado ya
 * no está en ninguna lista de trabajo ni en ningún iPad, y una fila que no
 * existe no se puede mantener pulsada. Este es literalmente el único sitio del
 * mundo desde el que vuelve.
 *
 * Y vuelve entero. Archivar un edificio no toca sus salas: se quedan con
 * `active = true` debajo de un edificio con `active = false`, y por eso el
 * servidor las arrastra a `archived_rooms` con un `motivo` que dice por qué
 * están ahí. Una sala archivada porque lo está su edificio **no** se reactiva
 * sola —el servidor lo rechaza, y con razón: no volvería a ninguna lista—, así
 * que en su fila no se ofrece un botón que solo sabe fallar.
 *
 * El `motivo` tiene tres valores y no dos, y el tercero es el que evita la única
 * mentira que llegó a pintarse aquí: una sala archivada a mano ANTES de que
 * archivaran su edificio no vuelve con él —`restore_building` no toca `rooms`—
 * ni se puede reactivar mientras el edificio siga en la papelera. Prometerle
 * cualquiera de las dos cosas es enseñar a desconfiar del sitio del que se
 * recupera lo que se dio de baja por error.
 *
 * Los recuentos de cada edificio son lo que se recupera al restaurarlo. Están
 * ahí para que «Restaurar» sea una decisión y no una apuesta: 39 salas y 412
 * revisiones no es lo mismo que un edificio de pruebas creado ayer.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { pullMaster } from '@/sync/pull'
import { displayRoomCode } from '@/domain/normalize'
import { aplicarOperacion, explicarFallo } from '@/features/rooms/maestro'

export interface EdificioArchivado {
  building_id: string
  building_code: string
  building_name: string
  salas: number
  revisiones: number
}

/**
 * La papelera de edificios, pedida una sola vez para toda la sección.
 *
 * La usan dos sitios con dos propósitos distintos —esta lista, que la pinta, y
 * el alta de edificios de arriba, que necesita los códigos ocupados porque el
 * `unique (code)` de `buildings` es global y no perdona a los archivados— y sale
 * de aquí, en un hook, en vez de en dos `useQuery` sueltos. La alternativa no es
 * inocente: dos consultas con la MISMA clave y distinto `select` comparten
 * entrada de caché, y la primera que se monte decide qué columnas hay, así que
 * los recuentos de esta lista aparecerían vacíos según el orden de montaje — un
 * fallo que no se reproduce dos veces igual. Y con dos claves distintas serían
 * dos viajes al servidor para traer lo mismo.
 */
export function useEdificiosArchivados(): EdificioArchivado[] {
  const { data } = useQuery({
    queryKey: ['maestro', 'archived-buildings'],
    queryFn: async (): Promise<EdificioArchivado[]> => {
      const { data, error } = await supabase
        .from('archived_buildings')
        .select('building_id, building_code, building_name, salas, revisiones')
        .order('building_code')
      if (error) throw error
      return (data ?? []) as EdificioArchivado[]
    },
  })
  return data ?? []
}

interface SalaArchivada {
  room_id: string
  room_code: string
  room_name: string
  zone_name: string
  building_code: string
  /**
   * Qué la sacó de la lista de trabajo, que es lo que decide qué se puede hacer
   * con ella. Los tres valores son tres respuestas distintas y ninguno sobra:
   * `'edificio'` vuelve sola al restaurar el edificio, `'sala'` se reactiva aquí
   * mismo, y `'sala-y-edificio'` —archivada a mano ANTES de que archivaran su
   * edificio— no hace ninguna de las dos cosas todavía.
   */
  motivo: 'sala' | 'edificio' | 'sala-y-edificio'
}

/** Cuántas cosas vuelven, dicho como se lee. */
function loQueVuelve(b: EdificioArchivado): string {
  const salas = b.salas === 1 ? '1 sala' : `${b.salas} salas`
  const revisiones = b.revisiones === 1 ? '1 revisión' : `${b.revisiones} revisiones`
  return `${salas} · ${revisiones}`
}

export function PapeleraDelMaestro({
  onHecho,
}: {
  onHecho: (mensaje: string) => void
}): React.ReactElement | null {
  const qc = useQueryClient()

  const edificios = useEdificiosArchivados()

  const { data: salas } = useQuery({
    queryKey: ['maestro', 'archived'],
    queryFn: async (): Promise<SalaArchivada[]> => {
      const { data, error } = await supabase
        .from('archived_rooms')
        .select('room_id, room_code, room_name, zone_name, building_code, motivo')
        .order('building_code')
      if (error) throw error
      return (data ?? []) as SalaArchivada[]
    },
  })

  const restaurarEdificio = useMutation({
    mutationFn: (b: EdificioArchivado): Promise<string> =>
      // Por `aplicarOperacion` y no por un `supabase.rpc` suelto: es la misma
      // función que usa la lista de «Revisar», y con ella vienen gratis la
      // descarga del maestro y la invalidación de las dos consultas del panel.
      aplicarOperacion(
        { kind: 'restaurar-edificio', id: b.building_id, code: b.building_code },
        qc,
      ),
    onSuccess: onHecho,
  })

  const reactivarSala = useMutation({
    mutationFn: async (s: SalaArchivada): Promise<string> => {
      // `restore_room` no está en `maestro.ts` porque solo se llama desde aquí:
      // una sala archivada no aparece en ninguna lista de trabajo, así que no hay
      // ninguna fila que mantener pulsada para reactivarla.
      const { error } = await supabase.rpc('restore_room', { p_id: s.room_id })
      if (error) throw new Error(explicarFallo(error))
      await pullMaster()
      void qc.invalidateQueries({ queryKey: ['maestro'] })
      return `Sala ${s.room_code} reactivada: vuelve a la lista de trabajo.`
    },
    onSuccess: onHecho,
  })

  const hayEdificios = edificios.length > 0
  const haySalas = (salas ?? []).length > 0
  if (!hayEdificios && !haySalas) return null

  const ocupado = restaurarEdificio.isPending || reactivarSala.isPending
  const fallo = restaurarEdificio.error ?? reactivarSala.error

  return (
    <div className="mt-4">
      <p className="text-xs text-muted">
        Nada de aquí se ha perdido. Un edificio archivado conserva sus salas, sus revisiones y sus
        incidencias; solo ha salido de la lista de trabajo y de los dispositivos.
      </p>

      {hayEdificios && (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm text-muted">
            Edificios archivados ({edificios.length})
          </summary>
          <ul className="mt-2 divide-y divide-line-soft text-sm">
            {edificios.map((b) => (
              <li key={b.building_id} className="flex items-center gap-2 py-2">
                <span className="w-12 shrink-0 rounded-tag bg-raised py-1 text-center font-mono text-xs font-semibold text-accent">
                  {b.building_code}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{b.building_name}</span>
                  <span className="block text-xs text-muted">{loQueVuelve(b)}</span>
                </span>
                <button
                  type="button"
                  disabled={ocupado}
                  onClick={() => restaurarEdificio.mutate(b)}
                  className="key key-quiet min-h-11 shrink-0 px-3 text-xs text-muted"
                >
                  Restaurar
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {haySalas && (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm text-muted">
            Salas archivadas ({salas?.length ?? 0})
          </summary>
          <ul className="mt-2 divide-y divide-line-soft text-sm">
            {(salas ?? []).map((s) => (
              <li key={s.room_id} className="flex items-center gap-2 py-2">
                <span className="min-w-0 flex-1 truncate">
                  {s.building_code} · {displayRoomCode(s.room_code)}
                  <span className="ml-2 text-xs text-muted">
                    {[s.zone_name, s.room_name].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {/*
                  Tres casos y tres respuestas, y la del medio es la que hubo que
                  añadir: una sala archivada a mano DENTRO de un edificio
                  archivado salía marcada como «edificio» y prometía volver con
                  él. No vuelve —`restore_building` no toca `rooms`, y es
                  deliberado: al restaurar tiene que volver lo que había, no todo
                  lo que hubo alguna vez— así que aparecía otra vez en esta misma
                  lista, ahora como «sala» y con su botón. Una frase que se
                  desmiente sola en el flujo de recuperación enseña a no fiarse de
                  la papelera entera, que es lo caro.

                  Tampoco se le puede ofrecer «Reactivar»: `restore_room` rechaza
                  las salas de un edificio archivado, así que sería un botón que
                  solo sabe fallar.
                */}
                {s.motivo === 'sala' ? (
                  <button
                    type="button"
                    disabled={ocupado}
                    onClick={() => reactivarSala.mutate(s)}
                    className="key key-quiet min-h-11 shrink-0 px-3 text-xs text-muted"
                  >
                    Reactivar
                  </button>
                ) : (
                  <span className="shrink-0 text-xs text-muted">
                    {s.motivo === 'edificio'
                      ? 'Se restaura con su edificio'
                      : 'Archivada aparte: se reactiva cuando vuelva su edificio'}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {fallo && (
        <p className="mt-2 text-sm text-crit">
          {fallo instanceof Error ? fallo.message : 'No se ha podido aplicar.'}
        </p>
      )}
    </div>
  )
}
