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
import { norm } from '@/domain/normalize'
import type { Role } from '@/domain/types'
import { Cargando, EstadoVacio, FalloDeCarga, Nota, Seccion, mensajeDe } from './Seccion'

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

/** A partir de cuántas personas hace falta buscar en vez de leer. */
const CON_BUSCADOR = 8

export function UsersPage({ yo }: { yo: string | null }): React.ReactElement {
  const qc = useQueryClient()
  const [tocado, setTocado] = useState<string | null>(null)
  const [busqueda, setBusqueda] = useState('')
  const [verBajas, setVerBajas] = useState(false)

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

  const todos = perfiles ?? []
  const admins = todos.filter((p) => p.role === 'admin' && p.active).length
  const bajas = todos.filter((p) => !p.active).length
  const q = norm(busqueda)
  const visibles = todos.filter(
    (p) => (verBajas || p.active) && (q === '' || norm(p.full_name).includes(q) || norm(p.email).includes(q)),
  )

  return (
    <Seccion
      id="sec-usuarios"
      titulo="Usuarios y roles"
      texto={
        todos.length > 0
          ? `${todos.length - bajas} ${todos.length - bajas === 1 ? 'persona activa' : 'personas activas'}, ${admins} con rol de administrador${bajas > 0 ? `, ${bajas} de baja` : ''}. El rol decide qué pestañas ve cada uno.`
          : 'El rol decide qué pestañas ve cada uno.'
      }
      acciones={
        todos.length > CON_BUSCADOR ? (
          <>
            <input
              type="search"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por nombre o correo"
              aria-label="Buscar usuario"
              className="h-11 w-56 rounded-ctl border border-line bg-surface px-3 text-base"
            />
            {bajas > 0 && (
              <label className="flex items-center gap-2 text-sm text-muted">
                <input type="checkbox" checked={verBajas} onChange={(e) => setVerBajas(e.target.checked)} className="size-5 accent-accent" />
                Ver bajas
              </label>
            )}
          </>
        ) : bajas > 0 ? (
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={verBajas} onChange={(e) => setVerBajas(e.target.checked)} className="size-5 accent-accent" />
            Ver bajas
          </label>
        ) : undefined
      }
    >
      {isPending && <Cargando />}
      {isError && <FalloDeCarga que="los usuarios" error={error} onReintentar={() => void refetch()} />}

      {perfiles && visibles.length === 0 && (
        <p className="text-sm text-muted">
          {q ? `Nadie se llama «${busqueda}».` : 'No hay nadie activo.'}
        </p>
      )}

      {perfiles && visibles.length > 0 && (
        <ul className="divide-y divide-line-soft rounded-card border border-line bg-surface">
          {visibles.map((p) => {
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
              <li key={p.id} className={`px-4 py-4 ${p.active ? '' : 'opacity-70'}`}>
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  <span className="font-medium">{p.full_name}</span>
                  {soyYo && (
                    <span className="rounded-tag bg-accent-tint px-2 py-0.5 text-[0.6875rem] font-medium text-accent">
                      tú
                    </span>
                  )}
                  {!p.active && (
                    <span className="rounded-tag bg-raised px-2 py-0.5 text-[0.6875rem] text-muted">
                      de baja
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
                    onClick={() => {
                      if (p.active && !confirm(`¿Dar de baja a ${p.full_name}? No podrá entrar hasta que se reactive; lo que hizo se conserva.`)) return
                      cambiar.mutate({ id: p.id, patch: { active: !p.active } })
                    }}
                    className="key key-quiet ml-auto min-h-11 px-3 text-xs text-muted"
                  >
                    {p.active ? 'Dar de baja' : 'Reactivar'}
                  </button>
                </div>

                {ultimoAdmin && (
                  <p className="mt-2 text-xs text-muted">
                    Es el único administrador activo. Nombra a otro antes de cambiarle el rol o
                    darlo de baja, o nadie podrá volver a entrar en esta pantalla.
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

      {perfiles && perfiles.length === 0 && <EstadoVacio titulo="Todavía no hay nadie dado de alta" />}

      <Nota texto={cambiar.isError ? mensajeDe(cambiar.error, 'No se ha podido guardar.') : null} tono="crit" />

      {/*
        Qué hace cada rol, a la vista y no solo en el `title` de un botón: es lo
        que se consulta antes de decidir, y en un iPad no hay dónde posar el
        ratón. Y la frontera, dicha en voz alta: sin esto la pantalla parece
        incompleta y alguien acabará buscando el botón de «nuevo usuario» que
        no existe. No existe por una razón, y la razón cabe en dos líneas.
      */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="card p-4">
          <p className="text-sm font-medium">Qué puede hacer cada rol</p>
          <dl className="mt-2 space-y-1.5 text-sm">
            {ROLES.map((r) => (
              <div key={r.value} className="flex gap-2">
                <dt className="w-24 shrink-0 font-medium">{r.label}</dt>
                <dd className="text-muted">{r.que}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="card p-4">
          <p className="text-sm font-medium">Dar de alta a alguien nuevo</p>
          <p className="mt-1 text-sm text-muted">
            Se hace desde la terminal del servicio, no desde aquí: crear una cuenta exige la clave de
            servicio, que en el navegador convertiría cualquier sesión robada en el control del
            sistema completo.
          </p>
          <p className="mt-2 rounded-ctl bg-sunken px-3 py-2 font-mono text-xs text-ink-2">
            alta crear correo@ejemplo.es &quot;Nombre Apellido&quot; tecnico
          </p>
          <p className="mt-2 text-xs text-muted">
            Escribe siempre el rol: sin él entra como técnico, y es el descuido que deja a un
            administrador sin sus pestañas sin que nadie se entere.
          </p>
        </div>
      </div>
    </Seccion>
  )
}
