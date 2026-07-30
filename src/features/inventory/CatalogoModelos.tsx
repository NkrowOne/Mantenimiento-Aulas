import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useConfirmar } from '@/components/Confirmar'
import { supabase } from '@/lib/supabase'
import { pullMaster } from '@/sync/pull'
import { MARCAS_HABITUALES, SIN_MARCA, duplicadosProbables, modelLabel } from '@/domain/inventory'
import { norm } from '@/domain/normalize'
import { fechaCorta } from '@/domain/fechas'
import type { AssetModel, AssetType, Role, SpecValues } from '@/domain/types'
import { CamposPropios, resumirCampos } from './CamposPropios'
import { CamposDelTipo } from './CamposDelTipo'

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

  /*
   * Guardar la ficha del modelo: el nombre, y lo que se sabe de él.
   *
   * Van en dos escrituras porque son dos cosas distintas y solo una necesita
   * lógica: renombrar deja el nombre viejo de alias y da el modelo por validado
   * —eso es `rename_asset_model`—, mientras que los campos propios, el fin de
   * soporte y las observaciones son un UPDATE normal que la política «supervisor
   * gestiona modelos» ya permite.
   *
   * El nombre primero: si falla —un choque con otro modelo del mismo tipo—, no se
   * escribe nada. Al revés dejaría la ficha guardada sobre un nombre rechazado.
   */
  const corregir = useMutation({
    mutationFn: async (v: {
      id: string
      brand: string
      model: string
      specs: SpecValues
      eol_on: string | null
      notes: string | null
    }) => {
      const { error: err } = await supabase.rpc('rename_asset_model', {
        p_id: v.id,
        p_brand: v.brand,
        p_model: v.model,
      })
      if (err) throw err

      const { error: err2 } = await supabase
        .from('asset_models')
        .update({ specs: v.specs, eol_on: v.eol_on, notes: v.notes })
        .eq('id', v.id)
      if (err2) throw err2
    },
    onSuccess: () => {
      setEditando(null)
      void tras('Modelo guardado. El nombre anterior se queda de alias.')
    },
    onError: (e) => setNota(e instanceof Error ? e.message : 'No se ha podido guardar.'),
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
                    {/* Lo que se sabe del modelo, en una línea: «Resolución
                        1920×1080 · Lúmenes 4000». Para esto se escribió
                        `resumirCampos`, y era el rastro exacto de dónde se cortó
                        el trabajo anterior — la función estaba y la línea que la
                        usa no llegó a escribirse, así que había que abrir cada
                        modelo para saber si tenía algo dentro. */}
                    {(() => {
                      const resumen = resumirCampos(
                        tipos.get(m.asset_type_id)?.spec_fields ?? [],
                        m.specs ?? {},
                      )
                      return resumen ? (
                        <span className="block truncate text-xs text-muted">{resumen}</span>
                      ) : null
                    })()}
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
                        tipo={tipos.get(m.asset_type_id) ?? null}
                        guardando={corregir.isPending}
                        onGuardar={(ficha) => corregir.mutate({ id: m.id, ...ficha })}
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

      {/*
        Y qué se apunta de cada clase de aparato. Va aquí, debajo del catálogo de
        modelos, porque es la misma pregunta un nivel más arriba: el catálogo dice
        QUÉ modelos hay y esto dice QUÉ SE SABE de cada uno. Solo para quien puede
        gestionar el catálogo — cambiar la lista de campos afecta a lo que se pide
        en las 276 aulas.
      */}
      {puede && <CamposDelTipo tipos={data?.tipos ?? []} />}

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
  tipo,
  guardando,
  onGuardar,
  onCancelar,
}: {
  modelo: AssetModel
  /** Su tipo, que es quien declara los campos propios. */
  tipo: AssetType | null
  guardando: boolean
  onGuardar: (ficha: {
    brand: string
    model: string
    specs: SpecValues
    eol_on: string | null
    notes: string | null
  }) => void
  onCancelar: () => void
}): React.ReactElement {
  const [brand, setBrand] = useState(modelo.brand)
  const [model, setModel] = useState(modelo.model)
  const [specs, setSpecs] = useState<SpecValues>(modelo.specs ?? {})
  const [eol, setEol] = useState(modelo.eol_on ?? '')
  const [notes, setNotes] = useState(modelo.notes ?? '')

  /*
   * Los campos que se contestan una vez por MODELO y no por aparato.
   *
   * Es la mitad que faltaba de la parte personalizable del inventario, y sin ella
   * no servía de nada: la migración siembra «Resolución», «Lúmenes» y «Referencia
   * de lámpara» para los proyectores y «Pulgadas» para las pantallas, todos
   * marcados `en: 'modelo'`, y no había una sola casilla en toda la aplicación
   * donde escribirlos. El bloque de campos propios del aula filtra por
   * `c.en !== 'modelo'`, así que en los dos tipos más numerosos del parque no
   * aparecía nada. Un coordinador veía la pieza configurada en la base y en la
   * pantalla no existía.
   *
   * Y es el nivel correcto: los lúmenes de un EB-992F son los mismos en las
   * cuarenta aulas donde hay uno. Preguntarlo por aparato es pedir cuarenta veces
   * el mismo dato, que es como se garantiza que no se conteste ninguna.
   *
   * `ambos` entra aquí también: el modelo pone el valor de fábrica y una unidad
   * concreta puede contradecirlo desde el aula.
   */
  const campos = useMemo(
    () => (tipo?.spec_fields ?? []).filter((c) => c.en !== 'equipo'),
    [tipo],
  )

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

      {campos.length > 0 && (
        <div className="mt-3 border-t border-line-soft pt-3">
          <CamposPropios
            campos={campos}
            valores={specs}
            onChange={setSpecs}
            titulo={`Lo que se sabe de este ${tipo?.name?.toLowerCase() ?? 'modelo'}`}
          />
          <p className="mt-1.5 text-xs text-muted">
            Se contesta una vez y vale para todos los aparatos de este modelo.
          </p>
        </div>
      )}

      <div className="mt-3 grid gap-2 border-t border-line-soft pt-3 sm:grid-cols-2">
        <label className="text-xs text-muted">
          Fin de soporte
          {/*
            La columna existía y se pintaba en dos sitios —«sin soporte desde…» en
            esta lista y en la ficha del equipo— y no había dónde escribirla, así
            que ese texto no aparecía nunca. Es la que convierte el inventario en
            planificación: «qué hay que cambiar el curso que viene» deja de ser una
            conversación y pasa a ser un filtro.
          */}
          <input
            type="date"
            value={eol}
            onChange={(e) => setEol(e.target.value)}
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
          />
        </label>
        <label className="text-xs text-muted">
          Observaciones
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="La lámpara es la misma que la del ME403U…"
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
          />
        </label>
      </div>

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
          onClick={() =>
            onGuardar({
              brand: brand.trim(),
              model: model.trim(),
              specs,
              eol_on: eol || null,
              notes: notes.trim() || null,
            })
          }
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
