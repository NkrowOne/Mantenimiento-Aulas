import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { pullMaster } from '@/sync/pull'
import { faltantesPorDefecto } from '@/domain/defaults'
import type { AssetDefault, AssetType, Building } from '@/domain/types'

/**
 * El equipamiento que una sala lleva por defecto.
 *
 * Un aula nueva no nace vacía: nace con lo que todas las aulas llevan. Sin esto,
 * dar de alta una sala es escribir seis equipos a mano — y como eso son seis
 * gestos por sala, en la práctica no se hace y el inventario nace incompleto,
 * que es de donde vienen las 41 aulas con cero equipos registrados.
 *
 * Dos ámbitos, y el segundo existe porque el primero no llega:
 *
 *  - **Global**: vale para todas las salas del campus.
 *  - **Por edificio**: vale solo para el suyo y MANDA sobre el global. Es lo que
 *    permite decir «en todas partes una pantalla; en el EPS, dos» sin repetir la
 *    lista entera veintitrés veces, que es como se convierte en veintitrés
 *    listas que nadie mantiene.
 *
 * Se aplica solo al crear la sala. El botón de aplicarlo a las que ya existen
 * está aparte y con la cifra delante, porque es una escritura masiva sobre
 * inventario real: no puede ser el efecto secundario de guardar una fila.
 */

export function EquipoPorDefecto(): React.ReactElement {
  const qc = useQueryClient()
  const [tipo, setTipo] = useState('')
  const [ambito, setAmbito] = useState('')
  const [cantidad, setCantidad] = useState(1)
  const [aplicarA, setAplicarA] = useState('')
  const [nota, setNota] = useState<string | null>(null)

  const { data: defaults } = useQuery({
    queryKey: ['asset-defaults'],
    queryFn: async (): Promise<AssetDefault[]> => {
      const { data, error } = await supabase
        .from('asset_defaults')
        .select('id, asset_type_id, building_id, qty')
      if (error) throw error
      return (data ?? []) as AssetDefault[]
    },
  })

  /*
   * El catálogo vivo ENTERO, validado o no.
   *
   * Antes esto pedía solo `confirmed = true`, y el resultado era que el equipo
   * que más falta hace declarar por defecto —el que un técnico acaba de apuntar
   * en un aula, «Micrófono Jabra»— era justo el único que no salía en la lista.
   * Desde el panel se veía como si la aplicación no lo tuviera.
   *
   * Se enseña con su marca de «sin validar» al lado, en el desplegable y en la
   * lista de abajo, y quien administra decide. Esconderlo no evitaba el
   * duplicado: solo escondía la decisión, y la bandeja para validarlo está dos
   * secciones más arriba, en esta misma pantalla.
   *
   * Clave de caché propia y no la de la bandeja de tipos: comparten servidor
   * pero no pregunta, y colgar esta respuesta de `['asset-types','confirmed']`
   * metería los tipos sin validar en el «Catálogo confirmado» y en los destinos
   * de agrupar.
   */
  const { data: tipos } = useQuery({
    queryKey: ['asset-types', 'vivos'],
    queryFn: async (): Promise<AssetType[]> => {
      const { data } = await supabase
        .from('asset_types')
        .select('*')
        .is('merged_into', null)
        // Los validados primero: son el caso normal, y así lo dudoso no se cuela
        // por orden alfabético en mitad de la lista.
        .order('confirmed', { ascending: false })
        .order('name')
      return (data ?? []) as AssetType[]
    },
  })

  /* Los edificios salen del espejo local: ya están descargados y así la lista
     aparece llena antes de que el servidor conteste. */
  const edificios = useLiveQuery(() => db.buildings.orderBy('sort_order').toArray(), [], [])

  /*
   * Qué crearía aplicarlo, contado aquí.
   *
   * El servidor es quien materializa, pero quien administra necesita la cifra
   * ANTES de pulsar: un botón que escribe cientos de filas de inventario sin
   * decir cuántas no se pulsa nunca, o se pulsa una vez y ya no se vuelve a
   * confiar en él. Sale del espejo —salas, zonas y equipos ya están aquí— así
   * que no cuesta ni una consulta.
   */
  const prevision = useLiveQuery(async () => {
    if (!defaults || defaults.length === 0) return null
    const [salas, zonas, equipos] = await Promise.all([
      db.rooms.toArray(),
      db.zones.toArray(),
      db.assets.toArray(),
    ])
    return faltantesPorDefecto({
      defaults,
      salas,
      edificioDeZona: new Map(zonas.map((z) => [z.id, z.building_id])),
      equipos,
      buildingId: aplicarA || null,
    })
  }, [defaults, aplicarA])

  const guardar = useMutation({
    mutationFn: async (input: { asset_type_id: string; building_id: string | null; qty: number }) => {
      // Va por RPC y no por `upsert`: el ámbito lo garantizan dos índices únicos
      // PARCIALES —uno para el global y otro por edificio—, y `on conflict` no
      // sabe inferir un índice parcial. La función hace el «existe, corrijo la
      // cantidad; no existe, la creo», que es lo que se espera al declarar dos
      // veces lo mismo: corregir, no un error que enseñarle a nadie.
      const { error } = await supabase.rpc('set_asset_default', {
        p_type: input.asset_type_id,
        p_building: input.building_id,
        p_qty: input.qty,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setTipo('')
      setCantidad(1)
      setNota('Guardado. Las salas nuevas ya nacen con él.')
      void qc.invalidateQueries({ queryKey: ['asset-defaults'] })
    },
  })

  const quitar = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('asset_defaults').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      // Quitar el defecto no quita nada de las salas: lo que ya se materializó
      // es inventario real y se da de baja sala a sala, si es que hay que darlo.
      setNota('Quitado. Los equipos que ya se crearon siguen en sus salas.')
      void qc.invalidateQueries({ queryKey: ['asset-defaults'] })
    },
  })

  const aplicar = useMutation({
    mutationFn: async (buildingId: string | null): Promise<number> => {
      const { data, error } = await supabase.rpc('apply_asset_defaults', {
        p_building: buildingId,
        p_room: null,
      })
      if (error) throw error
      return (data as number) ?? 0
    },
    onSuccess: (n) => {
      setNota(
        n === 0
          ? 'No faltaba nada: todas las salas del ámbito ya lo tenían.'
          : `${n} equipo(s) añadidos a las salas que no los tenían.`,
      )
      void pullMaster()
    },
  })

  const tipoDe = (id: string): AssetType | null => tipos?.find((t) => t.id === id) ?? null
  const nombreTipo = (id: string): string => tipoDe(id)?.name ?? 'Equipo'
  const nombreEdificio = (id: string | null): string =>
    id ? (edificios.find((b: Building) => b.id === id)?.name ?? 'Edificio') : 'Todas las salas'

  // Los globales primero y luego cada edificio: es el orden en que se lee la
  // regla —«esto en todas partes, salvo aquí»— y no el orden en que se tecleó.
  const ordenados = [...(defaults ?? [])].sort(
    (a, b) =>
      Number(a.building_id !== null) - Number(b.building_id !== null) ||
      nombreEdificio(a.building_id).localeCompare(nombreEdificio(b.building_id), 'es') ||
      nombreTipo(a.asset_type_id).localeCompare(nombreTipo(b.asset_type_id), 'es'),
  )

  return (
    <section aria-labelledby="sec-defecto" className="mt-8">
      <div className="section-head">
        <h2 id="sec-defecto" className="eyebrow">
          Equipamiento por defecto
        </h2>
      </div>
      <p className="text-sm text-muted">
        Lo que se le pone a una sala nueva nada más crearla. Lo del edificio manda sobre lo global.
      </p>

      <ul className="mt-3 divide-y divide-line-soft border-y border-line bg-surface">
        {ordenados.map((d) => (
          <li key={d.id} className="flex items-center gap-3 px-4 py-3">
            <span className="w-10 shrink-0 rounded-tag bg-raised py-1 text-center font-mono text-xs font-semibold text-accent">
              ×{d.qty}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="min-w-0 truncate text-sm font-medium">
                  {nombreTipo(d.asset_type_id)}
                </span>
                {/* La marca viaja con el equipo hasta aquí: un defecto declarado
                    sobre algo sin validar se instala en 276 aulas igual que
                    cualquier otro, y eso hay que poder verlo sin ir a buscarlo. */}
                {tipoDe(d.asset_type_id)?.confirmed === false && (
                  <span className="shrink-0 rounded-tag bg-warn-tint px-1.5 py-0.5 text-[0.6875rem] font-medium text-warn">
                    Sin validar
                  </span>
                )}
              </span>
              <span className="block truncate text-xs text-muted">
                {d.building_id === null ? 'En todas las salas' : `Solo en ${nombreEdificio(d.building_id)}`}
              </span>
            </span>
            <button
              type="button"
              disabled={quitar.isPending}
              onClick={() => quitar.mutate(d.id)}
              className="key key-quiet min-h-11 shrink-0 px-3 text-xs text-muted"
            >
              Quitar
            </button>
          </li>
        ))}

        {ordenados.length === 0 && (
          <li className="px-4 py-3 text-sm text-muted">
            No hay nada declarado: una sala nueva nace vacía.
          </li>
        )}
      </ul>

      <div className="card mt-4 p-4">
        <p className="text-sm font-medium">Añadir al equipamiento por defecto</p>

        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <label className="text-xs text-muted">
            Equipo
            <select
              value={tipo}
              onChange={(e) => setTipo(e.target.value)}
              className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-base text-ink"
            >
              <option value="">Elige del catálogo…</option>
              {/* Un `<option>` no admite maquetación, así que la marca va en el
                  propio texto. Es fea y se lee, que es lo que hace falta. */}
              {(tipos ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.confirmed ? t.name : `${t.name} — sin validar`}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs text-muted">
            Dónde
            <select
              value={ambito}
              onChange={(e) => setAmbito(e.target.value)}
              className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-base text-ink"
            >
              <option value="">En todas las salas</option>
              {edificios.map((b: Building) => (
                <option key={b.id} value={b.id}>
                  Solo en {b.name}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs text-muted">
            Cuántos
            <input
              type="number"
              min={1}
              max={20}
              inputMode="numeric"
              value={cantidad}
              onChange={(e) => setCantidad(Math.min(20, Math.max(1, Number(e.target.value) || 1)))}
              className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-base text-ink sm:w-20"
            />
          </label>
        </div>

        <button
          type="button"
          disabled={!tipo || guardar.isPending}
          onClick={() =>
            guardar.mutate({ asset_type_id: tipo, building_id: ambito || null, qty: cantidad })
          }
          className="key key-accent mt-3 min-h-11 px-3 text-sm"
        >
          Guardar
        </button>

        {/* Aquí no se escribe un nombre suelto: se elige del catálogo. Es la
            defensa que importa —esto instala en 276 aulas de una vez—, y no
            hace falta esconder además los tipos sin validar: el que un técnico
            acaba de apuntar suele ser justo el que hay que declarar. */}
        <p className="mt-2 text-xs text-muted">
          Se elige del catálogo, no se escribe: desde aquí se instala en todas las salas a la vez.
          Los que salen como <span className="text-warn">sin validar</span> los creó alguien desde un
          aula y se pueden declarar igual — conviene revisarlos antes en la bandeja de tipos, un poco
          más arriba.
        </p>
      </div>

      <div className="card mt-4 p-4">
        <p className="text-sm font-medium">Aplicarlo a las salas que ya existen</p>
        <p className="mt-1 text-sm text-muted">
          Añade solo lo que falte. Nunca quita nada: una sala con tres pantallas donde el defecto
          dice una se queda con sus tres.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            value={aplicarA}
            onChange={(e) => setAplicarA(e.target.value)}
            aria-label="Ámbito al que aplicar el equipamiento por defecto"
            className="h-11 min-w-48 flex-1 rounded-ctl border border-line bg-surface px-2 text-base text-ink"
          >
            <option value="">Todo el campus</option>
            {edificios.map((b: Building) => (
              <option key={b.id} value={b.id}>
                Solo {b.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            disabled={aplicar.isPending || (prevision?.equipos ?? 0) === 0}
            onClick={() => {
              const cuantos = prevision?.equipos ?? 0
              if (confirm(`¿Crear ${cuantos} equipo(s) en ${prevision?.salas ?? 0} sala(s)?`)) {
                aplicar.mutate(aplicarA || null)
              }
            }}
            className="key key-accent min-h-11 px-3 text-sm"
          >
            Aplicar ahora
          </button>
        </div>

        <p className="mt-2 text-sm text-muted">
          {prevision === undefined
            ? 'Contando…'
            : prevision === null
              ? 'Declara algo arriba para poder aplicarlo.'
              : prevision.equipos === 0
                ? 'Nada que añadir: las salas del ámbito ya lo tienen todo.'
                : `Se crearían ${prevision.equipos} equipos en ${prevision.salas} sala(s).`}
        </p>
      </div>

      {(guardar.isError || quitar.isError || aplicar.isError) && (
        <p className="mt-3 text-sm text-crit">
          {[guardar.error, quitar.error, aplicar.error].find(Boolean) instanceof Error
            ? ([guardar.error, quitar.error, aplicar.error].find(Boolean) as Error).message
            : 'No se ha podido guardar.'}
        </p>
      )}
      {nota && !guardar.isPending && !aplicar.isPending && (
        <p aria-live="polite" className="mt-3 text-sm text-ok">
          {nota}
        </p>
      )}
    </section>
  )
}
