import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import {
  MARCAS_HABITUALES,
  SIN_MARCA,
  exactModel,
  modelLabel,
  resolveModel,
  searchModels,
  splitBrandModel,
} from '@/domain/inventory'
import type { ModeloElegido } from './useRoomInventory'

/**
 * Elegir marca y modelo, o crearlos.
 *
 * Es el control que hace que «Ordenador» deje de ser un ordenador. Y es el mismo
 * en los tres sitios donde se decide un modelo —al añadir un equipo en el aula,
 * al corregirlo, y en la gestión desde el ordenador— porque tres controles
 * distintos acabarían aceptando tres formatos distintos, que es exactamente cómo
 * el campo de texto libre se llenó de «ME403U», «ME-403U» y «ME403U *».
 *
 * Cómo se usa, por orden de rapidez:
 *
 *   1. Se teclean tres letras y se toca la sugerencia. Es el 90% de las veces.
 *   2. No sale nada: se pulsa «Crear», que ya viene con la marca y el modelo
 *      separados de lo que se escribió —«Epson EB-992F» se parte solo— y se
 *      confirma. Dos toques y ninguna decisión.
 *   3. Se deja en blanco. «No consta» es una respuesta legítima y frecuente: hay
 *      aparatos sin una pegatina legible, y obligar a inventarse un modelo es
 *      peor que registrar el equipo sin él.
 *
 * Lee del espejo local, así que funciona en un sótano sin cobertura, que es
 * donde se usa.
 */

interface Props {
  /** El tipo manda: un modelo de proyector no se ofrece para una pantalla. */
  typeId: string | null
  /** El modelo asignado ahora, si lo hay. */
  value: string | null
  onChange: (modelo: ModeloElegido | null) => void
  /** Se enseña más compacto dentro de una fila de tabla. */
  compacto?: boolean
  autoFocus?: boolean
}

export function SelectorDeModelo({
  typeId,
  value,
  onChange,
  compacto = false,
  autoFocus = true,
}: Props): React.ReactElement {
  const [query, setQuery] = useState('')
  const [abierto, setAbierto] = useState(false)
  /* Cuando se está creando: marca y modelo por separado y ya partidos. */
  const [creando, setCreando] = useState<{ brand: string; model: string } | null>(null)

  const modelos = useLiveQuery(() => db.assetModels.toArray(), [], [])

  const porId = useMemo(() => new Map(modelos.map((m) => [m.id, m])), [modelos])
  const actual = resolveModel(porId, value)

  /* Las marcas que se ofrecen salen de lo que existe de verdad, y la lista de
     siempre solo rellena lo que falte: el primer día el catálogo está vacío y un
     desplegable en blanco obliga a teclear la marca a mano en un iPad. */
  const marcas = useMemo(() => {
    const usadas = [...new Set(modelos.map((m) => m.brand.trim()).filter(Boolean))]
    return [...new Set([...usadas, ...MARCAS_HABITUALES])].sort((a, b) =>
      a.localeCompare(b, 'es'),
    )
  }, [modelos])

  const hits = useMemo(() => searchModels(modelos, typeId, query), [modelos, typeId, query])
  const raw = query.trim()

  /* Si lo que se ha escrito ya existe tal cual, crear no es una opción: sería
     un duplicado que el índice único de la base rechazaría al sincronizar, lejos
     del aula y sin que nadie entendiera por qué. */
  const yaExiste = useMemo(() => {
    if (!typeId || !raw) return null
    const { brand, model } = splitBrandModel(raw, marcas)
    return exactModel(modelos, typeId, brand, model)
  }, [modelos, typeId, raw, marcas])

  function elegir(id: string): void {
    onChange({ id })
    setQuery('')
    setAbierto(false)
    setCreando(null)
  }

  function empezarACrear(): void {
    setCreando(splitBrandModel(raw, marcas))
  }

  function crear(): void {
    if (!creando || !creando.model.trim()) return
    onChange({ brand: creando.brand.trim(), model: creando.model.trim() })
    setCreando(null)
    setQuery('')
    setAbierto(false)
  }

  // --- Cerrado: solo lo que hay puesto, y un botón para cambiarlo ------------
  if (!abierto) {
    return (
      <div className="flex items-center gap-2">
        <span className={`min-w-0 flex-1 truncate ${compacto ? 'text-xs' : 'text-sm'}`}>
          {actual ? (
            <>
              <span className="font-medium">{modelLabel(actual)}</span>
              {!actual.confirmed && (
                <span className="ml-1.5 rounded-tag bg-warn-tint px-1 py-0.5 text-[0.625rem] font-medium text-warn">
                  sin validar
                </span>
              )}
            </>
          ) : (
            <span className="text-muted">Sin modelo</span>
          )}
        </span>
        <button
          type="button"
          onClick={() => setAbierto(true)}
          disabled={!typeId}
          className="key key-quiet min-h-11 shrink-0 px-2.5 text-xs text-muted"
        >
          {actual ? 'Cambiar' : 'Elegir'}
        </button>
      </div>
    )
  }

  // --- Creando: marca y modelo por separado ---------------------------------
  if (creando) {
    return (
      <div className="rounded-ctl border border-accent/30 bg-sunken p-3">
        <p className="text-xs font-semibold">Modelo nuevo</p>
        <p className="mt-1 text-xs text-muted">
          Sale marcado hasta que un coordinador lo valide. Se usa igual desde ya.
        </p>

        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-muted">
            Marca
            {/*
              Lista con escritura libre, no desplegable cerrado. Un desplegable
              obliga a que la marca esté prevista, y el día que llegue una que no
              está no hay forma de apuntarla; escribir a pelo pierde el
              autocompletado. `datalist` da las dos cosas y funciona igual en
              Safari de iPad y en el navegador del ordenador.
            */}
            <input
              type="text"
              list="marcas-conocidas"
              value={creando.brand}
              autoCapitalize="words"
              autoCorrect="off"
              spellCheck={false}
              placeholder={SIN_MARCA}
              onChange={(e) => setCreando({ ...creando, brand: e.target.value })}
              className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
            />
            <datalist id="marcas-conocidas">
              {marcas.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>

          <label className="text-xs text-muted">
            Modelo
            {/* Un modelo no es una frase: sin esto iOS lo capitaliza y el
                corrector reescribe cadenas alfanuméricas cortas. */}
            <input
              type="text"
              value={creando.model}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
              onChange={(e) => setCreando({ ...creando, model: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  crear()
                }
              }}
              className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 font-mono text-sm text-ink"
            />
          </label>
        </div>

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => setCreando(null)}
            className="key key-quiet min-h-11 flex-1 px-3 text-xs"
          >
            Atrás
          </button>
          <button
            type="button"
            disabled={!creando.model.trim()}
            onClick={crear}
            className="key key-accent min-h-11 flex-1 px-3 text-xs"
          >
            Usar este modelo
          </button>
        </div>
      </div>
    )
  }

  // --- Buscando -------------------------------------------------------------
  return (
    <div className="rounded-ctl border border-accent/30 bg-sunken p-3">
      <label className="block">
        <span className="sr-only">Buscar modelo</span>
        <input
          type="text"
          value={query}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          placeholder="Marca o modelo: epson, eb-992…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              setAbierto(false)
              return
            }
            if (e.key !== 'Enter') return
            e.preventDefault()
            const primero = hits[0]
            if (primero) elegir(primero.model.id)
            else if (raw) empezarACrear()
          }}
          className="h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
        />
      </label>

      {/* `min-h-11` y `gap-1.5`, no 36px pegados unos a otros. Es el control más
          tocado de todo el catálogo —elegir el modelo de la lista es «el 90% de
          las veces», dice la cabecera de este fichero— y se toca de pie, en un
          aula, con el iPad en una mano. Por debajo del mínimo táctil de 44px el
          gesto falla y se acaba escribiendo el modelo a mano, que es exactamente
          lo que el catálogo viene a evitar. */}
      <ul className="mt-2 flex max-h-56 flex-col gap-1.5 overflow-y-auto">
        {hits.map((hit) => (
          <li key={hit.model.id}>
            <button
              type="button"
              onClick={() => elegir(hit.model.id)}
              className="key key-quiet flex min-h-11 w-full items-center justify-between gap-2 px-2.5 py-2 text-left text-sm"
            >
              <span className="min-w-0 flex-1 truncate">
                {modelLabel(hit.model)}
                {!hit.model.brand.trim() && (
                  <span className="ml-1.5 text-xs font-normal text-muted">({SIN_MARCA})</span>
                )}
              </span>
              <span className="shrink-0 text-xs font-normal text-muted">
                {hit.why || (hit.model.confirmed ? 'del catálogo' : 'sin validar')}
              </span>
            </button>
          </li>
        ))}

        {hits.length === 0 && (
          <li className="px-1 py-2 text-xs text-muted">
            {typeId
              ? 'Ningún modelo de este tipo coincide.'
              : 'Elige primero el tipo de equipo.'}
          </li>
        )}
      </ul>

      {raw && !yaExiste && typeId && (
        <button
          type="button"
          onClick={empezarACrear}
          className="key mt-2 flex min-h-11 w-full items-center justify-between border border-warn/40 bg-warn-tint px-2.5 py-2 text-left text-sm text-warn"
        >
          <span className="min-w-0 truncate">Crear «{raw}»</span>
          <span className="shrink-0 text-xs font-normal">pendiente de validar</span>
        </button>
      )}
      {raw && yaExiste && (
        <p className="mt-2 text-xs text-muted">
          «{modelLabel(yaExiste)}» ya está en el catálogo: elígelo arriba.
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => setAbierto(false)}
          className="key key-quiet min-h-11 flex-1 px-3 text-xs"
        >
          Cancelar
        </button>
        {/* «No consta» tiene que ser un botón y no la ausencia de acción: sin él,
            quitar un modelo mal puesto obliga a adivinar que se hace cerrando
            sin elegir, que es justo lo que nadie prueba. */}
        <button
          type="button"
          onClick={() => {
            onChange(null)
            setAbierto(false)
          }}
          className="key key-quiet min-h-11 flex-1 px-3 text-xs text-muted"
        >
          Sin modelo
        </button>
      </div>
    </div>
  )
}
