import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useConfirmar } from '@/components/Confirmar'
import { supabase } from '@/lib/supabase'
import { pullMaster } from '@/sync/pull'
import { MARCAS_HABITUALES, SIN_MARCA, duplicadosProbables, modelLabel } from '@/domain/inventory'
import { norm } from '@/domain/normalize'
import { fechaCorta } from '@/domain/fechas'
import type { AssetModel, AssetType, Role } from '@/domain/types'

/**
 * El catálogo de marcas y modelos, y las cuatro decisiones que se toman sobre él.
 *
 * Existe porque el catálogo se ensucia solo y nadie lo limpia si no hay un sitio
 * donde hacerlo. Con los datos reales del despliegue, el primer día aparecen
 * cincuenta y cinco modelos deducidos del texto libre del Excel, y entre ellos:
 *
 *     ME403U   ·   ME-403U   ·   ME403U *          ← el mismo proyector, tres veces
 *     EB-992F  ·  EB-992F EEB  ·  EB-992 F EEB     ← y otra vez
 *     M403H    ·   M403H *
 *     NO  ·  NET  ·  *****                          ← lo que alguien escribió en su día
 *
 * Ninguno tiene marca, porque en el Excel nadie la escribía. Así que las cuatro
 * operaciones no son genéricas, son exactamente lo que hace falta:
 *
 *   VALIDAR    — «este modelo existe y se llama así». Es el visto bueno.
 *   CORREGIR   — ponerle la marca que le falta, o arreglar el nombre.
 *   FUSIONAR   — los tres «ME403U» pasan a ser uno, y los equipos con él.
 *   RETIRAR    — el modelo descatalogado deja de ofrecerse sin borrarse.
 *
 * Fusionar y retirar se confirman con el alcance delante —cuántos equipos van a
 * moverse— porque no se deshacen desde la aplicación.
 */

interface ModeloConUso extends AssetModel {
  equipos: number
}

export function CatalogoModelos({ role }: { role: Role }): React.ReactElement {
  const qc = useQueryClient()
  const { pedir, dialogo } = useConfirmar()
  const [texto, setTexto] = useState('')
  const [soloPendientes, setSoloPendientes] = useState(false)
  const [tipoId, setTipoId] = useState('')
  const [editando, setEditando] = useState<string | null>(null)
  const [fusionando, setFusionando] = useState<ModeloConUso | null>(null)
  const [nota, setNota] = useState<string | null>(null)

  const puede = role === 'supervisor' || role === 'admin'

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['catalogo-modelos'],
    queryFn: async () => {
      const [modelosRes, tiposRes, usoRes] = await Promise.all([
        supabase.from('asset_models').select('*').order('brand').order('model'),
        supabase.from('asset_types').select('*').is('merged_into', null).order('name'),
        // Cuántos equipos lleva cada modelo. Es el número que decide si fusionar
        // es un clic o una operación con consecuencias en cuarenta aulas.
        supabase.from('assets').select('asset_model_id').neq('status', 'retirado'),
      ])
      if (modelosRes.error) throw modelosRes.error
      if (tiposRes.error) throw tiposRes.error

      const uso = new Map<string, number>()
      for (const a of (usoRes.data ?? []) as Array<{ asset_model_id: string | null }>) {
        if (a.asset_model_id) uso.set(a.asset_model_id, (uso.get(a.asset_model_id) ?? 0) + 1)
      }

      return {
        modelos: ((modelosRes.data ?? []) as AssetModel[]).map((m) => ({
          ...m,
          equipos: uso.get(m.id) ?? 0,
        })),
        tipos: (tiposRes.data ?? []) as AssetType[],
      }
    },
  })

  const tipos = useMemo(
    () => new Map((data?.tipos ?? []).map((t) => [t.id, t])),
    [data],
  )

  const vivos = useMemo(
    () => (data?.modelos ?? []).filter((m) => !m.merged_into),
    [data],
  )

  const visibles = useMemo(() => {
    const q = norm(texto)
    return vivos.filter((m) => {
      if (tipoId && m.asset_type_id !== tipoId) return false
      if (soloPendientes && m.confirmed) return false
      if (!q) return true
      return (
        norm(modelLabel(m)).includes(q) ||
        norm(tipos.get(m.asset_type_id)?.name ?? '').includes(q) ||
        m.aliases.some((a) => norm(a).includes(q))
      )
    })
  }, [vivos, texto, tipoId, soloPendientes, tipos])

  /* Los que casi seguro son el mismo. Es la lista de trabajo de verdad. */
  const duplicados = useMemo(() => duplicadosProbables(vivos), [vivos])
  const sinValidar = vivos.filter((m) => !m.confirmed).length

  const tras = async (mensaje: string): Promise<void> => {
    setNota(mensaje)
    await qc.invalidateQueries({ queryKey: ['catalogo-modelos'] })
    // El espejo de este dispositivo se entera ahora y no en el próximo refresco:
    // quien administra suele tener abierta la pestaña de revisar al lado.
    await pullMaster()
  }

  const validar = useMutation({
    mutationFn: async (ids: string[]) => {
      const { data: n, error: err } = await supabase.rpc('confirm_asset_models', { p_ids: ids })
      if (err) throw err
      return n as number
    },
    onSuccess: (n) => void tras(`${n} modelo(s) validado(s).`),
    onError: (e) => setNota(e instanceof Error ? e.message : 'No se ha podido validar.'),
  })

  const corregir = useMutation({
    mutationFn: async (v: { id: string; brand: string; model: string }) => {
      const { error: err } = await supabase.rpc('rename_asset_model', {
        p_id: v.id,
        p_brand: v.brand,
        p_model: v.model,
      })
      if (err) throw err
    },
    onSuccess: () => {
      setEditando(null)
      void tras('Modelo corregido. El nombre anterior se queda de alias.')
    },
    onError: (e) => setNota(e instanceof Error ? e.message : 'No se ha podido corregir.'),
  })

  const fusionar = useMutation({
    mutationFn: async (v: { from: string; into: string }) => {
      const { data: n, error: err } = await supabase.rpc('merge_asset_model', {
        p_from: v.from,
        p_into: v.into,
      })
      if (err) throw err
      return n as number
    },
    onSuccess: (n) => {
      setFusionando(null)
      void tras(`Fusionado. ${n} equipo(s) han pasado al modelo bueno.`)
    },
    onError: (e) => setNota(e instanceof Error ? e.message : 'No se ha podido fusionar.'),
  })

  const archivar = useMutation({
    mutationFn: async (v: { id: string; activo: boolean }) => {
      const { error: err } = await supabase.rpc('archive_asset_model', {
        p_id: v.id,
        p_activo: v.activo,
      })
      if (err) throw err
    },
    onSuccess: () => void tras('Hecho.'),
    onError: (e) => setNota(e instanceof Error ? e.message : 'No se ha podido cambiar.'),
  })

  return (
    <div className="p-4 pb-24">
      <div className="section-head">
        <h2 className="eyebrow">Catálogo de modelos</h2>
      </div>

      <p className="text-sm text-muted">
        Marca y modelo de cada tipo de equipo. Lo que se apunta desde un aula entra aquí sin validar
        y se usa igual; esta pantalla es donde se le pone la marca, se corrige el nombre y se
        fusionan los duplicados.
      </p>

      {!puede && (
        <p className="mt-3 rounded-ctl border border-line bg-sunken p-3 text-sm text-muted">
          Puedes consultarlo, pero validar, corregir y fusionar son cosa de un coordinador.
        </p>
      )}

      {isPending && <p className="mt-4 text-sm text-muted">Cargando…</p>}
      {isError && (
        <div className="card mt-4 p-4">
          <p className="text-sm text-crit">
            No se ha podido leer: {error instanceof Error ? error.message : ''}
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

      {data && (
        <>
          {/* --- Duplicados probables, arriba del todo -------------------- */}
          {puede && duplicados.length > 0 && (
            <section className="card mt-4 border-warn/40 p-4">
              <p className="text-sm font-semibold text-warn">
                {duplicados.length} grupo(s) que casi seguro son el mismo modelo
              </p>
              <p className="mt-1 text-xs text-muted">
                Se parecen tanto que solo cambian los guiones, los espacios o los asteriscos.
                Fusionarlos mueve sus equipos al que se quede.
              </p>
              <ul className="mt-3 space-y-2">
                {duplicados.slice(0, 8).map((grupo) => (
                  <li key={grupo.map((m) => m.id).join('|')} className="text-sm">
                    <span className="text-muted">{tipos.get(grupo[0]!.asset_type_id)?.name}: </span>
                    {grupo.map((m, i) => (
                      <span key={m.id}>
                        {i > 0 && <span className="text-muted"> · </span>}
                        <button
                          type="button"
                          onClick={() => {
                            setTexto(modelLabel(m))
                            setSoloPendientes(false)
                            setTipoId('')
                          }}
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {modelLabel(m)}
                        </button>
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
              {duplicados.length > 8 && (
                <p className="mt-2 text-xs text-muted">
                  Y {duplicados.length - 8} grupo(s) más. Resuelve estos y vuelve a entrar.
                </p>
              )}
            </section>
          )}

          {/* --- Filtros -------------------------------------------------- */}
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            <label className="text-xs text-muted">
              Buscar
              <input
                type="search"
                value={texto}
                placeholder="Marca, modelo o tipo…"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setTexto(e.target.value)}
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
              />
            </label>
            <label className="text-xs text-muted">
              Tipo
              <select
                value={tipoId}
                onChange={(e) => setTipoId(e.target.value)}
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
              >
                <option value="">Todos</option>
                {(data.tipos ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end gap-2">
              <button
                type="button"
                aria-pressed={soloPendientes}
                onClick={() => setSoloPendientes((v) => !v)}
                className={`key min-h-11 flex-1 px-3 text-xs ${
                  soloPendientes ? 'key-accent' : 'key-quiet text-muted'
                }`}
              >
                Sin validar ({sinValidar})
              </button>
              {puede && sinValidar > 0 && (
                <button
                  type="button"
                  disabled={validar.isPending}
                  onClick={() =>
                    void pedir({
                      titulo: `¿Validar los ${visibles.filter((m) => !m.confirmed).length} modelos de la lista?`,
                      detalle:
                        'Validar dice «estos modelos existen y se llaman así». No cambia ningún equipo.',
                      consecuencias: [
                        'Dejan de salir marcados en naranja en las aulas.',
                        'Se pueden seguir corrigiendo y fusionando después.',
                      ],
                      confirmar: 'Validar',
                      tono: 'accent',
                    }).then((si) => {
                      if (si) {
                        validar.mutate(visibles.filter((m) => !m.confirmed).map((m) => m.id))
                      }
                    })
                  }
                  className="key key-accent min-h-11 px-3 text-xs"
                >
                  Validar la lista
                </button>
              )}
            </div>
          </div>

          {nota && (
            <p aria-live="polite" className="mt-3 text-sm text-ok">
              {nota}
            </p>
          )}

          {/* --- La lista ------------------------------------------------- */}
          <ul className="mt-3 divide-y divide-line-soft">
            {visibles.map((m) => (
              <li key={m.id} className="py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {m.brand.trim() || <span className="text-muted">{SIN_MARCA}</span>}{' '}
                      {m.model}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {[
                        tipos.get(m.asset_type_id)?.name ?? 'Tipo desconocido',
                        `${m.equipos} equipo(s)`,
                        m.aliases.length > 0 ? `alias: ${m.aliases.join(', ')}` : null,
                        m.eol_on ? `sin soporte desde ${fechaCorta(m.eol_on)}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>

                  {!m.confirmed && (
                    <span className="shrink-0 rounded-tag bg-warn-tint px-1.5 py-0.5 text-[0.6875rem] font-medium text-warn">
                      Sin validar
                    </span>
                  )}
                  {!m.active && (
                    <span className="shrink-0 rounded-tag bg-sunken px-1.5 py-0.5 text-[0.6875rem] font-medium text-muted">
                      Retirado
                    </span>
                  )}

                  {puede && (
                    <span className="flex shrink-0 flex-wrap gap-1">
                      {!m.confirmed && (
                        <button
                          type="button"
                          disabled={validar.isPending}
                          onClick={() => validar.mutate([m.id])}
                          className="key key-accent min-h-11 px-2.5 text-xs"
                        >
                          Validar
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setEditando(editando === m.id ? null : m.id)}
                        aria-expanded={editando === m.id}
                        className="key key-quiet min-h-11 px-2.5 text-xs text-muted"
                      >
                        Corregir
                      </button>
                      <button
                        type="button"
                        onClick={() => setFusionando(fusionando?.id === m.id ? null : m)}
                        className="key key-quiet min-h-11 px-2.5 text-xs text-muted"
                      >
                        Fusionar
                      </button>
                      <button
                        type="button"
                        disabled={archivar.isPending}
                        onClick={() =>
                          void pedir({
                            titulo: m.active
                              ? `¿Retirar «${modelLabel(m)}» del catálogo?`
                              : `¿Devolver «${modelLabel(m)}» al catálogo?`,
                            detalle: m.active
                              ? 'Deja de ofrecerse al añadir equipos.'
                              : 'Vuelve a ofrecerse al añadir equipos.',
                            consecuencias: m.active
                              ? [
                                  `Los ${m.equipos} equipos que lo llevan lo conservan y siguen enseñándolo.`,
                                  'No se borra nada: el histórico lo sigue nombrando.',
                                  'Se puede deshacer desde aquí mismo.',
                                ]
                              : ['Vuelve a salir en el selector de modelo de las aulas.'],
                            confirmar: m.active ? 'Retirar del catálogo' : 'Devolver',
                            tono: m.active ? 'warn' : 'accent',
                          }).then((si) => {
                            if (si) archivar.mutate({ id: m.id, activo: !m.active })
                          })
                        }
                        className="key key-quiet min-h-11 px-2.5 text-xs text-muted"
                      >
                        {m.active ? 'Retirar' : 'Devolver'}
                      </button>
                    </span>
                  )}
                </div>

                <div className="collapse-y" data-open={editando === m.id} inert={editando !== m.id}>
                  <div>
                    {editando === m.id && (
                      <Corrector
                        modelo={m}
                        guardando={corregir.isPending}
                        onGuardar={(brand, model) => corregir.mutate({ id: m.id, brand, model })}
                        onCancelar={() => setEditando(null)}
                      />
                    )}
                  </div>
                </div>

                <div
                  className="collapse-y"
                  data-open={fusionando?.id === m.id}
                  inert={fusionando?.id !== m.id}
                >
                  <div>
                    {fusionando?.id === m.id && (
                      <Fusionador
                        origen={m}
                        candidatos={vivos.filter(
                          (o) => o.id !== m.id && o.asset_type_id === m.asset_type_id,
                        )}
                        fusionando={fusionar.isPending}
                        onCancelar={() => setFusionando(null)}
                        onFusionar={(intoId) => {
                          const destino = vivos.find((o) => o.id === intoId)
                          void pedir({
                            titulo: `¿Fusionar «${modelLabel(m)}» con «${modelLabel(destino ?? m)}»?`,
                            detalle: 'Es una operación que la aplicación no sabe deshacer.',
                            consecuencias: [
                              `Los ${m.equipos} equipos de «${modelLabel(m)}» pasan a «${modelLabel(destino ?? m)}».`,
                              `«${modelLabel(m)}» desaparece del catálogo y se queda como alias del otro.`,
                              'Quien escriba el nombre viejo seguirá encontrando el bueno.',
                            ],
                            confirmar: 'Fusionar',
                            tono: 'crit',
                            escribir: m.equipos > 10 ? 'FUSIONAR' : undefined,
                          }).then((si) => {
                            if (si) fusionar.mutate({ from: m.id, into: intoId })
                          })
                        }}
                      />
                    )}
                  </div>
                </div>
              </li>
            ))}

            {visibles.length === 0 && (
              <li className="py-3 text-sm text-muted">
                Ningún modelo cumple estos filtros.
              </li>
            )}
          </ul>
        </>
      )}

      {dialogo}
    </div>
  )
}

/**
 * Corregir marca y modelo.
 *
 * El caso real, y por eso el foco entra en la marca: los cincuenta y cinco
 * modelos que salen del Excel no tienen ninguna, y ponérsela es el 90% del
 * trabajo de esta pantalla.
 */
function Corrector({
  modelo,
  guardando,
  onGuardar,
  onCancelar,
}: {
  modelo: AssetModel
  guardando: boolean
  onGuardar: (brand: string, model: string) => void
  onCancelar: () => void
}): React.ReactElement {
  const [brand, setBrand] = useState(modelo.brand)
  const [model, setModel] = useState(modelo.model)

  return (
    <div className="mt-2 rounded-ctl border border-line bg-sunken p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-muted">
          Marca
          <input
            type="text"
            list="marcas-catalogo"
            value={brand}
            autoCapitalize="words"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            placeholder={SIN_MARCA}
            onChange={(e) => setBrand(e.target.value)}
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
          />
          <datalist id="marcas-catalogo">
            {MARCAS_HABITUALES.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <label className="text-xs text-muted">
          Modelo
          <input
            type="text"
            value={model}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setModel(e.target.value)}
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 font-mono text-sm text-ink"
          />
        </label>
      </div>

      <p className="mt-2 text-xs text-muted">
        El nombre anterior se queda como alias, así que quien lo teclee mañana seguirá encontrando
        este modelo. Corregir lo da además por validado.
      </p>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onCancelar}
          className="key key-quiet min-h-11 flex-1 px-3 text-xs"
        >
          Cancelar
        </button>
        <button
          type="button"
          disabled={guardando || !model.trim()}
          onClick={() => onGuardar(brand.trim(), model.trim())}
          className="key key-accent min-h-11 flex-1 px-3 text-xs"
        >
          Guardar
        </button>
      </div>
    </div>
  )
}

/** Elegir con cuál se fusiona. Solo del mismo tipo: la base lo exige y hace bien. */
function Fusionador({
  origen,
  candidatos,
  fusionando,
  onFusionar,
  onCancelar,
}: {
  origen: AssetModel
  candidatos: ModeloConUso[]
  fusionando: boolean
  onFusionar: (intoId: string) => void
  onCancelar: () => void
}): React.ReactElement {
  const [into, setInto] = useState('')

  return (
    <div className="mt-2 rounded-ctl border border-crit/30 bg-sunken p-3">
      <p className="text-xs">
        «{modelLabel(origen)}» se absorbe en el que elijas, y sus equipos se van con él.
      </p>

      <label className="mt-2 block text-xs text-muted">
        Se queda
        <select
          value={into}
          onChange={(e) => setInto(e.target.value)}
          className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
        >
          <option value="">Elige el modelo bueno…</option>
          {candidatos
            .slice()
            .sort(
              (a, b) =>
                Number(b.confirmed) - Number(a.confirmed) ||
                b.equipos - a.equipos ||
                modelLabel(a).localeCompare(modelLabel(b), 'es', { numeric: true }),
            )
            .map((c) => (
              <option key={c.id} value={c.id}>
                {modelLabel(c)} · {c.equipos} equipo(s)
                {c.confirmed ? ' · validado' : ''}
              </option>
            ))}
        </select>
      </label>

      {candidatos.length === 0 && (
        <p className="mt-2 text-xs text-muted">
          No hay ningún otro modelo de ese tipo con el que fusionarlo.
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onCancelar}
          className="key key-quiet min-h-11 flex-1 px-3 text-xs"
        >
          Cancelar
        </button>
        <button
          type="button"
          disabled={fusionando || !into}
          onClick={() => onFusionar(into)}
          className="key key-crit min-h-11 flex-1 px-3 text-xs"
        >
          Fusionar
        </button>
      </div>
    </div>
  )
}
