import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { norm } from '@/domain/normalize'
import { supabase } from '@/lib/supabase'
import { pullMaster } from '@/sync/pull'
import { Cargando, EstadoVacio, FalloDeCarga, Nota, Seccion, mensajeDe } from './Seccion'
import { tiposValidados, usoDeTipos } from './tiposDeEquipo'

/**
 * Cómo se llama cada cosa del inventario, y poder cambiarlo.
 *
 * Un tipo de equipo solo se podía renombrar mientras estaba «sin validar», en
 * la bandeja de «Por decidir». Una vez validado quedaba en una lista de solo
 * lectura, así que un nombre que se quedaba corto o no seguía la nomenclatura
 * —«Micro» donde el resto dice «Micrófono inalámbrico»— no tenía arreglo desde
 * la aplicación.
 *
 * Renombrar pasa por la misma función de la base que la bandeja
 * (`rename_asset_type`), y por eso hace lo mismo:
 *
 *  - El nombre de antes **se queda de alias**: el Excel lo sigue reconociendo
 *    en sus columnas, y quien lo teclee así lo sigue encontrando.
 *  - Las **etiquetas de los equipos** que llevaban el nombre viejo en cada sala
 *    pasan al nuevo: si en el aula sigue poniendo «Micro 2», el renombrado no
 *    ha llegado a donde se lee.
 *
 * Lo pueden hacer supervisores y administradores, que es lo que exige esa
 * función. El nombre de UN equipo concreto no se cambia aquí: eso es «Nombre
 * en esta sala», en el inventario del aula.
 */
export function CatalogoDeTipos(): React.ReactElement {
  const qc = useQueryClient()
  const [filtro, setFiltro] = useState('')
  const [editando, setEditando] = useState<{ id: string; antes: string; nombre: string } | null>(null)
  const [nota, setNota] = useState<string | null>(null)

  const { data: tipos, isPending, isError, error, refetch } = useQuery(tiposValidados)
  const { data: uso } = useQuery(usoDeTipos)

  const renombrar = useMutation({
    mutationFn: async (e: { id: string; antes: string; nombre: string }): Promise<string> => {
      const { error: fallo } = await supabase.rpc('rename_asset_type', { p_id: e.id, p_name: e.nombre })
      if (fallo) throw fallo
      return (
        `«${e.antes}» ahora se llama «${e.nombre}». El nombre de antes queda de alias y ` +
        'las etiquetas de las salas se actualizan.'
      )
    },
    onSuccess: (mensaje) => {
      setEditando(null)
      setNota(mensaje)
      void qc.invalidateQueries({ queryKey: ['asset-types'] })
      // Las etiquetas de las salas acaban de cambiar en el servidor: el espejo
      // de este dispositivo deja de ser cierto en el momento en que se pulsa.
      void pullMaster()
    },
  })

  const q = norm(filtro)
  const visibles = (tipos ?? []).filter(
    (t) => !q || norm(t.name).includes(q) || t.aliases.some((a) => norm(a).includes(q)),
  )

  const guardar = (): void => {
    if (!editando) return
    const nombre = editando.nombre.trim()
    if (!nombre || nombre === editando.antes) return
    setNota(null)
    renombrar.mutate({ ...editando, nombre })
  }

  return (
    <Seccion
      id="sec-catalogo-tipos"
      titulo="Tipos de equipo"
      texto="Cómo se llama cada cosa del inventario. Cambiar un nombre lo cambia en todas las salas, y el de antes se queda de alias: el Excel y quien lo busque así lo siguen encontrando."
      acciones={
        (tipos?.length ?? 0) > 8 ? (
          <input
            type="search"
            value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
            placeholder="Buscar tipo"
            aria-label="Buscar tipo de equipo"
            className="h-11 w-48 rounded-ctl border border-line bg-surface px-3 text-base"
          />
        ) : undefined
      }
    >
      {isPending && <Cargando texto="Cargando el catálogo…" />}
      {isError && <FalloDeCarga que="el catálogo" error={error} onReintentar={() => void refetch()} />}
      {tipos && tipos.length === 0 && <EstadoVacio titulo="Todavía no hay tipos validados" />}
      {tipos && tipos.length > 0 && visibles.length === 0 && (
        <p className="text-sm text-muted">Ningún tipo coincide con «{filtro}».</p>
      )}

      {visibles.length > 0 && (
        <ul className="divide-y divide-line-soft rounded-card border border-line bg-surface">
          {visibles.map((t) => (
            <li key={t.id} className="px-4 py-3">
              {editando?.id === t.id ? (
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    guardar()
                  }}
                >
                  <input
                    type="text"
                    value={editando.nombre}
                    onChange={(e) => setEditando({ ...editando, nombre: e.target.value })}
                    // Lo ha pedido quien acaba de pulsar «Cambiar nombre»: el
                    // teclado sube porque se va a escribir, no por sorpresa.
                    autoFocus
                    aria-label={`Nombre nuevo de ${t.name}`}
                    className="h-11 min-w-40 flex-1 rounded-ctl border border-line bg-surface px-2 text-base"
                  />
                  <button
                    type="submit"
                    disabled={
                      renombrar.isPending || !editando.nombre.trim() || editando.nombre.trim() === t.name
                    }
                    className="key key-accent min-h-11 px-3 text-sm"
                  >
                    {renombrar.isPending ? 'Guardando…' : 'Guardar'}
                  </button>
                  <button
                    type="button"
                    disabled={renombrar.isPending}
                    onClick={() => setEditando(null)}
                    className="key key-quiet min-h-11 px-3 text-sm text-muted"
                  >
                    Cancelar
                  </button>
                  <p className="w-full text-xs text-muted">
                    {uso?.[t.id] ?? 0} {uso?.[t.id] === 1 ? 'equipo' : 'equipos'} en salas cambiarán de
                    etiqueta si la llevaban con el nombre de antes.
                  </p>
                </form>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block font-medium">{t.name}</span>
                    {t.aliases.length > 0 && (
                      <span className="block text-xs text-muted">también: {t.aliases.join(', ')}</span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className="font-mono text-xs text-muted tabular" title="Equipos en salas">
                      {uso?.[t.id] ?? 0}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setNota(null)
                        renombrar.reset()
                        setEditando({ id: t.id, antes: t.name, nombre: t.name })
                      }}
                      className="key key-quiet min-h-11 px-3 text-sm"
                    >
                      Cambiar nombre
                    </button>
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <Nota
        texto={
          renombrar.isError
            ? mensajeDe(renombrar.error, 'No se ha podido cambiar el nombre. Solo un supervisor o un administrador puede tocar el catálogo.')
            : nota
        }
        tono={renombrar.isError ? 'crit' : 'ok'}
      />
    </Seccion>
  )
}
