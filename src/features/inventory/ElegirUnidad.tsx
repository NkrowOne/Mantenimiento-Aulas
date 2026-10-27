import { useId, useMemo, useState } from 'react'
import {
  CONDICION_LABEL,
  coincideUnidad,
  descripcionDeUnidad,
  ordenarUnidades,
  type Condicion,
  type UnidadDeAlmacen,
} from '@/domain/unidades'

/**
 * Elegir cuál: la lista de unidades de un artículo, con buscador.
 *
 * Es la pregunta que el almacén no sabía hacer. «Del almacén» descontaba un
 * proyector y daba de alta «un proyector» en la sala, sin número de serie: el
 * aparato concreto que se había bajado de la estantería no quedaba apuntado en
 * ningún sitio. Ahora se elige —con el número a la vista, como está en la
 * pegatina— y el equipo de la sala nace con su serie, su marca y su modelo.
 *
 * **Un toque por unidad, sin desplegables.** Con el aparato en una mano, un
 * `<select>` obliga a abrir, leer números de serie de diez cifras en una rueda y
 * cerrar. Aquí se ven todas, con su estado al lado, y se toca la que es. Si son
 * muchas, el buscador encuentra la que se tiene delante tecleando cuatro cifras.
 *
 * «Sin número de serie» sigue siendo una respuesta: el almacén puede contar más
 * de las que tienen número, y hay que poder llevarse una de esas sin mentir.
 */
export function ElegirUnidad({
  unidades,
  elegida,
  sinNumero,
  conSinNumero,
  onElegir,
}: {
  unidades: UnidadDeAlmacen[]
  /** El id de la elegida, `'sin_numero'` si se eligió llevarse una sin número, o `null`. */
  elegida: string | null
  /** Cuántas cuenta el almacén sin número de serie. Solo para decirlo. */
  sinNumero: number
  /** Si se ofrece la opción de llevarse una sin número. */
  conSinNumero: boolean
  onElegir: (id: string) => void
}): React.ReactElement {
  const idTitulo = useId()
  const [consulta, setConsulta] = useState('')
  const lista = useMemo(
    () => ordenarUnidades(unidades).filter((u) => coincideUnidad(u, consulta)),
    [unidades, consulta],
  )

  return (
    <fieldset role="radiogroup" className="mt-3" aria-labelledby={idTitulo}>
      <legend id={idTitulo} className="text-xs text-muted">
        ¿Cuál se instala? {unidades.length === 1 ? 'Hay 1 con número de serie' : `Hay ${unidades.length} con número de serie`}
      </legend>

      {unidades.length > 4 && (
        <input
          type="search"
          value={consulta}
          onChange={(e) => setConsulta(e.target.value)}
          placeholder="Buscar por número de serie o modelo"
          aria-label="Buscar unidad"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 font-mono text-base"
        />
      )}

      <ul className="mt-2 space-y-1.5">
        {lista.map((u) => (
          <li key={u.id}>
            <OpcionDeUnidad unidad={u} elegida={elegida === u.id} onElegir={() => onElegir(u.id)} />
          </li>
        ))}
        {lista.length === 0 && (
          <li className="px-1 py-2 text-xs text-muted">Ninguna unidad coincide con «{consulta}».</li>
        )}
        {conSinNumero && (
          <li>
            <button
              type="button"
              role="radio"
              aria-checked={elegida === 'sin_numero'}
              onClick={() => onElegir('sin_numero')}
              className={`flex min-h-11 w-full items-center gap-3 rounded-ctl border px-3 py-2 text-left text-sm ${
                elegida === 'sin_numero' ? 'border-accent bg-accent-tint' : 'border-line bg-surface'
              }`}
            >
              <Marca activa={elegida === 'sin_numero'} />
              <span className="min-w-0 flex-1">
                <span className="block">Una sin número de serie</span>
                <span className="block text-xs text-muted">
                  {sinNumero > 0
                    ? `El almacén cuenta ${sinNumero} más que no tienen número apuntado.`
                    : 'Se descuenta una del almacén y el número se apunta después, en el aula.'}
                </span>
              </span>
            </button>
          </li>
        )}
      </ul>
    </fieldset>
  )
}

const TONO: Record<Condicion, string> = {
  nuevo: 'bg-ok-tint text-ok',
  reacondicionado: 'bg-accent-tint text-accent',
  usado: 'bg-sunken text-muted',
  averiado: 'bg-crit-tint text-crit',
  sin_indicar: 'bg-sunken text-muted',
}

/** La etiqueta del estado de una unidad, con el mismo color en todas las pantallas. */
export function EtiquetaDeCondicion({ condicion }: { condicion: Condicion }): React.ReactElement {
  return (
    <span className={`shrink-0 rounded-tag px-1.5 py-0.5 text-[0.6875rem] font-medium ${TONO[condicion]}`}>
      {CONDICION_LABEL[condicion]}
    </span>
  )
}

function Marca({ activa }: { activa: boolean }): React.ReactElement {
  return (
    <span
      aria-hidden
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
        activa ? 'border-accent' : 'border-line'
      }`}
    >
      {activa && <span className="h-2.5 w-2.5 rounded-full bg-accent" />}
    </span>
  )
}

function OpcionDeUnidad({
  unidad: u,
  elegida,
  onElegir,
}: {
  unidad: UnidadDeAlmacen
  elegida: boolean
  onElegir: () => void
}): React.ReactElement {
  const detalle = descripcionDeUnidad(u)
  return (
    <button
      type="button"
      role="radio"
      aria-checked={elegida}
      onClick={onElegir}
      className={`flex min-h-11 w-full items-center gap-3 rounded-ctl border px-3 py-2 text-left ${
        elegida ? 'border-accent bg-accent-tint' : 'border-line bg-surface'
      }`}
    >
      <Marca activa={elegida} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-sm font-semibold">{u.serial}</span>
        {detalle && <span className="block truncate text-xs text-muted">{detalle}</span>}
      </span>
      <EtiquetaDeCondicion condicion={u.condicion} />
    </button>
  )
}
