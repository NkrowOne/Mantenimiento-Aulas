/**
 * Usuarios y roles.
 *
 * Existe para romper un círculo que la aplicación tenía cerrado sobre sí misma.
 *
 * El rol lo decide `profiles.role`. Si sale mal —un alta hecha sin escribir el
 * rol, que es lo que pasa cuando se teclea `alta crear <email> "<nombre>"` a
 * secas— la aplicación esconde las pestañas de Informes y Datos. Y la única
 * forma de arreglarlo era la línea de órdenes del servidor, porque **la única
 * pantalla de administración estaba detrás del mismo rol que se acababa de
 * estropear**. El fallo se auto-ocultaba: cuanto más grave, menos visible.
 *
 * Con esto, un administrador que funcione puede arreglar a cualquiera desde el
 * propio dispositivo, sin abrir una terminal.
 *
 * Lo que sigue SIN poder hacerse aquí, y no es un olvido: **crear usuarios y
 * generar códigos de alta**. Eso exige la clave de servicio de Supabase, que
 * salta RLS entera; meterla en el navegador convertiría cualquier sesión robada
 * en el control del sistema completo. Sigue siendo `alta crear`, ejecutado en el
 * servidor, y así debe seguir.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Role } from '@/domain/types'

interface Perfil {
  id: string
  full_name: string
  email: string
  role: Role
  active: boolean
}

const ROLES: Array<{ value: Role; label: string; que: string }> = [
  { value: 'tecnico', label: 'Técnico', que: 'Revisa aulas y abre incidencias.' },
  { value: 'supervisor', label: 'Supervisor', que: 'Además cierra incidencias y genera informes.' },
  { value: 'admin', label: 'Admin', que: 'Además edifica el maestro y gestiona usuarios.' },
]

export function UsersPage({ yo }: { yo: string | null }): React.ReactElement {
  const qc = useQueryClient()
  const [tocado, setTocado] = useState<string | null>(null)

  const { data: perfiles, isPending, isError, error, refetch } = useQuery({
    queryKey: ['perfiles'],
    queryFn: async (): Promise<Perfil[]> => {
      const { data, error: err } = await supabase
        .from('profiles')
        .select('id, full_name, email, role, active')
        // Por rol descendente y luego por nombre: los administradores arriba, que
        // son los que hay que poder contar de un vistazo.
        .order('role', { ascending: false })
        .order('full_name')
      if (err) throw err
      return (data ?? []) as Perfil[]
    },
  })

  const cambiar = useMutation({
    mutationFn: async (input: { id: string; patch: Partial<Pick<Perfil, 'role' | 'active'>> }) => {
      const { error: err } = await supabase.from('profiles').update(input.patch).eq('id', input.id)
      if (err) throw err
    },
    onSuccess: (_d, input) => {
      setTocado(input.id)
      void qc.invalidateQueries({ queryKey: ['perfiles'] })
    },
  })

  const admins = (perfiles ?? []).filter((p) => p.role === 'admin' && p.active).length

  return (
    <section aria-labelledby="sec-usuarios" className="mt-8">
      <div className="section-head">
        <h2 id="sec-usuarios" className="eyebrow">
          Usuarios y roles
        </h2>
      </div>

      {isPending && <p className="text-sm text-muted">Cargando…</p>}

      {isError && (
        <div className="card p-4">
          <p className="text-sm text-crit">
            No se han podido leer los usuarios: {error instanceof Error ? error.message : ''}
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

      {perfiles && (
        <ul className="divide-y divide-line-soft border-y border-line bg-surface">
          {perfiles.map((p) => {
            const soyYo = p.id === yo
            /*
             * El último administrador no se puede degradar ni desactivar.
             *
             * Sin este freno, un administrador podía quitarse el rol a sí mismo
             * —o desactivar al único que quedaba— y dejar el despliegue sin
             * nadie capaz de volver a entrar aquí. Se recupera, pero solo desde
             * la terminal del servidor, que es exactamente de lo que esta
             * pantalla venía a librar a nadie.
             */
            const ultimoAdmin = p.role === 'admin' && p.active && admins <= 1

            return (
              <li key={p.id} className="px-4 py-4">
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  <span className="font-medium">{p.full_name}</span>
                  {soyYo && (
                    <span className="rounded-tag bg-accent-tint px-2 py-0.5 text-[0.6875rem] font-medium text-accent">
                      tú
                    </span>
                  )}
                  {!p.active && (
                    <span className="rounded-tag bg-raised px-2 py-0.5 text-[0.6875rem] text-muted">
                      desactivado
                    </span>
                  )}
                </div>
                <p className="mt-0.5 font-mono text-xs text-muted">{p.email}</p>

                <div
                  role="group"
                  aria-label={`Rol de ${p.full_name}`}
                  className="mt-2.5 flex flex-wrap gap-2"
                >
                  {ROLES.map((r) => (
                    <button
                      key={r.value}
                      type="button"
                      aria-pressed={p.role === r.value}
                      title={r.que}
                      disabled={cambiar.isPending || (ultimoAdmin && r.value !== 'admin')}
                      onClick={() => cambiar.mutate({ id: p.id, patch: { role: r.value } })}
                      className={`key min-h-11 px-3 text-xs ${
                        p.role === r.value ? 'key-accent' : 'key-quiet text-muted'
                      }`}
                    >
                      {r.label}
                    </button>
                  ))}

                  <button
                    type="button"
                    disabled={cambiar.isPending || ultimoAdmin}
                    onClick={() => cambiar.mutate({ id: p.id, patch: { active: !p.active } })}
                    className="key key-quiet ml-auto min-h-11 px-3 text-xs text-muted"
                  >
                    {p.active ? 'Desactivar' : 'Reactivar'}
                  </button>
                </div>

                {ultimoAdmin && (
                  <p className="mt-2 text-xs text-muted">
                    Es el único administrador activo. Nombra a otro antes de cambiarle el rol o
                    desactivarlo, o nadie podrá volver a entrar en esta pantalla.
                  </p>
                )}

                {tocado === p.id && !cambiar.isPending && !cambiar.isError && (
                  <p aria-live="polite" className="mt-2 text-xs text-ok">
                    Guardado. El rol viaja dentro del token, así que a esa persona le llega cuando
                    se renueve —hasta una hora— o de inmediato si cierra sesión y vuelve a entrar
                    con su PIN.
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {cambiar.isError && (
        <p className="mt-2 text-sm text-crit">
          {cambiar.error instanceof Error ? cambiar.error.message : 'No se ha podido guardar.'}
        </p>
      )}

      {/*
        La frontera, dicha en voz alta.
        Sin esto, la pantalla parece incompleta y alguien acabará buscando el
        botón de «nuevo usuario» que no existe. No existe por una razón, y la
        razón cabe en dos líneas.
      */}
      <div className="card mt-4 p-4">
        <p className="text-sm font-medium">Dar de alta a alguien nuevo</p>
        <p className="mt-1 text-sm text-muted">
          Se hace desde la terminal del servicio, no desde aquí: crear una cuenta exige la clave de
          servicio, que se salta RLS entera, y en el navegador convertiría cualquier sesión robada
          en el control del sistema completo.
        </p>
        <p className="mt-2 font-mono text-xs text-ink-2">
          alta crear correo@ejemplo.es &quot;Nombre Apellido&quot; tecnico
        </p>
        <p className="mt-2 text-xs text-muted">
          Escribe siempre el rol: sin él entra como técnico, y es el descuido que deja a un
          administrador sin sus pestañas sin que nadie se entere.
        </p>
      </div>
    </section>
  )
}
