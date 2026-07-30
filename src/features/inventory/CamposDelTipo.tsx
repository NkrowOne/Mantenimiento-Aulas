import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { pullMaster } from '@/sync/pull'
import { useConfirmar } from '@/components/Confirmar'
import { norm } from '@/domain/normalize'
import type { AssetType, SpecField } from '@/domain/types'

/**
 * Qué se apunta de cada clase de aparato.
 *
 * Es la pieza que hacía falta para que «personalizable» significara algo. La base
 * ya guardaba la lista de campos de cada tipo en `asset_types.spec_fields` y ya
 * tenía la función para cambiarla —`set_asset_type_fields`, con su permiso y su
 * validación—, pero no la llamaba nadie: el único camino para añadir «Tarjeta
 * gráfica» a los ordenadores era abrir `psql` y escribir un `update … jsonb`.
 * Así que la promesa del encargo —«añadir un campo no es un despliegue»— se
 * cumplía a medias: el dato viajaba, pero solo lo tocaba quien tiene acceso a la
 * base de datos, que no es quien sabe qué hay que apuntar.
 *
 * DÓNDE SE CONTESTA CADA CAMPO
 *
 * La columna que más se piensa es `en`, y es la que decide si el dato se escribe
 * una vez o mil:
 *
 *   modelo  — es del modelo. Los lúmenes de un EB-992F son los mismos en las
 *             cuarenta aulas donde hay uno. Se contesta en el catálogo.
 *   equipo  — es de este aparato. El número de horas de la lámpara, no.
 *   ambos   — el modelo trae el valor de fábrica y una unidad puede
 *             contradecirlo. Es el caso de la RAM: el modelo dice 8 GB y a tres
 *             de ellos alguien les puso 16.
 *
 * Por defecto, `equipo`: es la respuesta segura. Un campo de nivel modelo mal
 * puesto obliga a corregir el catálogo entero; uno de nivel equipo mal puesto
 * solo se pregunta más veces de la cuenta.
 *
 * QUITAR UN CAMPO NO BORRA LO ESCRITO
 *
 * Los valores viven en `specs`, en el equipo y en el modelo, y esta lista solo
 * dice qué se pinta. Quitar «Disco» deja de preguntarlo y no toca los 1.094
 * valores ya guardados, así que volver a añadirlo los devuelve a la pantalla.
 * Merece decirse en la confirmación, porque «quitar» suena a lo contrario.
 */

const TIPOS_DE_CAMPO: Array<{ valor: SpecField['tipo']; etiqueta: string }> = [
  { valor: 'texto', etiqueta: 'Texto' },
  { valor: 'numero', etiqueta: 'Número' },
  { valor: 'fecha', etiqueta: 'Fecha' },
  { valor: 'si_no', etiqueta: 'Sí / no' },
]

const DONDE: Array<{ valor: NonNullable<SpecField['en']>; etiqueta: string }> = [
  { valor: 'equipo', etiqueta: 'En cada aparato' },
  { valor: 'modelo', etiqueta: 'En el modelo' },
  { valor: 'ambos', etiqueta: 'En el modelo, y el aparato puede cambiarlo' },
]

/**
 * La clave sale de la etiqueta, y no se vuelve a tocar.
 *
 * Es lo que ata el campo a los valores ya guardados: `specs` es un objeto con la
 * clave dentro, así que cambiarla equivale a perder lo escrito sin decirlo. Por
 * eso solo se calcula al crear el campo y después el input queda de solo lectura.
 */
export function claveDesde(etiqueta: string): string {
  // `norm` quita las tildes y pone en MAYÚSCULAS —es el normalizador de búsqueda
  // del proyecto—, así que hay que bajarlo a minúsculas antes de filtrar: sin el
  // `toLowerCase`, el filtro `[^a-z0-9]` se comía la cadena entera y todas las
  // claves salían «campo».
  return (
    norm(etiqueta)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'campo'
  )
}

export function CamposDelTipo({ tipos }: { tipos: AssetType[] }): React.ReactElement {
  const qc = useQueryClient()
  const { pedir, dialogo } = useConfirmar()
  const [abierto, setAbierto] = useState(false)
  const [tipoId, setTipoId] = useState('')
  const [campos, setCampos] = useState<SpecField[] | null>(null)
  const [nota, setNota] = useState<string | null>(null)

  const tipo = tipos.find((t) => t.id === tipoId) ?? null
  /* Mientras no se toque nada, se pinta lo que hay en la base. En cuanto se toca,
     manda el borrador local: así «Cancelar» es volver a leer y no deshacer paso
     a paso. */
  const lista = campos ?? tipo?.spec_fields ?? []
  const sucio = campos !== null

  const elegir = (id: string): void => {
    setTipoId(id)
    setCampos(null)
    setNota(null)
  }

  const guardar = useMutation({
    mutationFn: async (fields: SpecField[]) => {
      const { error } = await supabase.rpc('set_asset_type_fields', {
        p_id: tipoId,
        p_fields: fields,
      })
      if (error) throw error
    },
    onSuccess: async () => {
      setCampos(null)
      setNota('Campos guardados. Ya se piden en el aula y en la gestión.')
      await qc.invalidateQueries({ queryKey: ['catalogo-modelos'] })
      // El espejo local también: los campos se pintan en el aula, que lee de
      // Dexie y no del servidor.
      await pullMaster()
    },
    onError: (e) => setNota(e instanceof Error ? e.message : 'No se han podido guardar.'),
  })

  const cambiar = (i: number, patch: Partial<SpecField>): void =>
    setCampos(lista.map((c, j) => (j === i ? { ...c, ...patch } : c)))

  const añadir = (): void =>
    setCampos([...lista, { clave: '', etiqueta: '', tipo: 'texto', en: 'equipo' }])

  const quitar = (i: number): void => setCampos(lista.filter((_, j) => j !== i))

  /* Una clave vacía o repetida rompe el objeto `specs` en silencio: dos campos
     con la misma clave se pisan el valor. Se comprueba antes de dejar guardar. */
  const claves = lista.map((c) => c.clave.trim() || claveDesde(c.etiqueta))
  const problema =
    lista.some((c) => !c.etiqueta.trim())
      ? 'Falta la etiqueta de algún campo.'
      : new Set(claves).size !== claves.length
        ? 'Hay dos campos con el mismo nombre interno. Cambia una de las etiquetas.'
        : null

  return (
    <section aria-labelledby="sec-campos-tipo" className="mt-8">
      <div className="section-head">
        <h2 id="sec-campos-tipo" className="eyebrow">
          Qué se apunta de cada tipo
        </h2>
      </div>

      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        aria-expanded={abierto}
        className="key key-quiet min-h-11 px-3 text-sm"
      >
        {abierto ? 'Cerrar' : 'Configurar los campos'}
      </button>

      <div className="collapse-y" data-open={abierto} inert={!abierto}>
        <div className="pt-3">
          <p className="text-sm text-muted">
            Además de la marca, el modelo y el número de serie —que los lleva todo—, cada clase de
            aparato puede tener sus propios datos: los lúmenes de un proyector, las pulgadas de una
            pantalla, la RAM de un ordenador. Se piden en el aula y en la gestión, y salen en la
            exportación.
          </p>

          <label className="mt-3 block text-xs text-muted sm:max-w-xs">
            Tipo de equipo
            <select
              value={tipoId}
              onChange={(e) => elegir(e.target.value)}
              className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
            >
              <option value="">Elige uno…</option>
              {[...tipos]
                .sort((a, b) => a.name.localeCompare(b.name, 'es'))
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {(t.spec_fields ?? []).length > 0
                      ? ` (${(t.spec_fields ?? []).length} campo(s))`
                      : ''}
                  </option>
                ))}
            </select>
          </label>

          {tipo && (
            <div className="mt-3 grid gap-2">
              {lista.length === 0 && (
                <p className="text-sm text-muted">
                  «{tipo.name}» no tiene campos propios. Con la marca, el modelo y la serie puede
                  ser suficiente: añade uno solo si de verdad se va a rellenar.
                </p>
              )}

              {lista.map((campo, i) => (
                <div
                  key={`${campo.clave}-${i}`}
                  className="rounded-ctl border border-line bg-sunken p-3"
                >
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="text-xs text-muted">
                      Cómo se llama
                      <input
                        type="text"
                        value={campo.etiqueta}
                        placeholder="Lúmenes"
                        /* Solo la etiqueta. La clave interna se deriva de ella al
                           GUARDAR y solo si está vacía —es decir, solo la primera
                           vez—: después queda atada a los valores ya escritos en
                           `specs`, y cambiarla equivaldría a perderlos sin
                           decirlo. Por eso se enseña debajo, y en gris. */
                        onChange={(e) => cambiar(i, { etiqueta: e.target.value })}
                        className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
                      />
                    </label>
                    <label className="text-xs text-muted">
                      Unidad (opcional)
                      <input
                        type="text"
                        value={campo.unidad ?? ''}
                        placeholder="lm, GB, ″"
                        onChange={(e) => cambiar(i, { unidad: e.target.value || undefined })}
                        className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
                      />
                    </label>
                    <label className="text-xs text-muted">
                      Qué clase de dato
                      <select
                        value={campo.tipo}
                        onChange={(e) => cambiar(i, { tipo: e.target.value as SpecField['tipo'] })}
                        className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
                      >
                        {TIPOS_DE_CAMPO.map((t) => (
                          <option key={t.valor} value={t.valor}>
                            {t.etiqueta}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-xs text-muted">
                      Dónde se contesta
                      <select
                        value={campo.en ?? 'equipo'}
                        onChange={(e) =>
                          cambiar(i, { en: e.target.value as NonNullable<SpecField['en']> })
                        }
                        className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
                      >
                        {DONDE.map((d) => (
                          <option key={d.valor} value={d.valor}>
                            {d.etiqueta}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-[0.6875rem] text-muted">
                      {campo.clave.trim() || claveDesde(campo.etiqueta) || '—'}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        void pedir({
                          titulo: `¿Quitar «${campo.etiqueta || 'este campo'}» de ${tipo.name}?`,
                          consecuencias: [
                            'Deja de pedirse en el aula y en la gestión.',
                            'Lo que ya estaba escrito NO se borra: sigue guardado y vuelve a verse si añades el campo otra vez.',
                          ],
                          confirmar: 'Quitar el campo',
                          tono: 'warn',
                        }).then((si) => {
                          if (si) quitar(i)
                        })
                      }
                      className="key key-quiet min-h-11 px-3 text-xs text-muted"
                    >
                      Quitar
                    </button>
                  </div>
                </div>
              ))}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={añadir}
                  className="key key-quiet min-h-11 px-3 text-xs"
                >
                  Añadir campo
                </button>
                {sucio && (
                  <>
                    <button
                      type="button"
                      disabled={guardar.isPending || problema !== null}
                      onClick={() =>
                        guardar.mutate(
                          lista.map((c) => ({
                            ...c,
                            clave: c.clave.trim() || claveDesde(c.etiqueta),
                            etiqueta: c.etiqueta.trim(),
                            unidad: c.unidad?.trim() || undefined,
                          })),
                        )
                      }
                      className="key key-accent min-h-11 px-3 text-xs"
                    >
                      Guardar los campos
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCampos(null)
                        setNota(null)
                      }}
                      className="key key-quiet min-h-11 px-3 text-xs text-muted"
                    >
                      Descartar cambios
                    </button>
                  </>
                )}
              </div>

              {problema && <p className="text-xs text-warn">{problema}</p>}
            </div>
          )}

          {nota && (
            <p aria-live="polite" className="mt-3 text-sm text-muted">
              {nota}
            </p>
          )}
        </div>
      </div>

      {dialogo}
    </section>
  )
}
