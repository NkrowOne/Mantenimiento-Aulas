import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ESTADO_EN_PLURAL } from '@/domain/estados'
import { CONDICION_LABEL, coincideUnidad, descripcionDeUnidad, type Condicion } from '@/domain/unidades'
import { PUNTO_DE_CONDICION } from '@/features/inventory/ElegirUnidad'
import type { Opciones } from './cual'
import type { Cual } from './material'

/**
 * «¿Cuál has usado?»: la pregunta que solo sale cuando tiene más de una
 * respuesta.
 *
 * Un toque y está apuntada: se elige y se cierra. No hay «Confirmar» —la
 * elección ES la confirmación, y lo apuntado se corrige en su línea—, ni
 * desplegables: con el material en una mano, se ven todas las respuestas a la
 * vez y se toca una.
 *
 * **Una lista, y siempre la misma forma.** Cada respuesta es una fila a todo el
 * ancho: a la izquierda lo que es —el estado, o el número de serie como está en
 * la pegatina— y a la derecha el dato que ayuda a elegir —cuántas quedan, o en
 * qué estado está ese aparato—. La primera versión ponía los estados en una
 * rejilla de dos columnas y los aparatos en una lista: dos dibujos para la misma
 * pregunta, y con tres estados quedaba un hueco.
 *
 *  - Por estado, solo los que tienen existencias; lo averiado al final y en su
 *    color, que se puede haber puesto pero conviene verlo.
 *  - Por número de serie, con más de cuatro sale un buscador: se teclean cuatro
 *    cifras y queda el que se tiene delante. Y «Una sin número de serie» si el
 *    almacén cuenta más de las que tienen número.
 *
 * Las cifras son las de la última sincronización. No se bloquea nada con
 * ellas: si al cerrar ya no queda de lo elegido, el almacén saca de lo que haya.
 */
export function ElegirCual({
  nombre,
  opciones,
  onElegir,
  onCancelar,
}: {
  /** El artículo. Dentro de su propia línea no hace falta repetirlo. */
  nombre?: string
  opciones: Opciones
  onElegir: (cual: Cual) => void
  onCancelar: () => void
}): React.ReactElement {
  const idTitulo = useId()
  const [consulta, setConsulta] = useState('')
  const caja = useRef<HTMLDivElement>(null)

  // A la vista al abrirse: en un teléfono con el teclado arriba puede quedar
  // justo debajo de él.
  useEffect(() => {
    caja.current?.scrollIntoView({ block: 'nearest' })
  }, [])

  const unidades = useMemo(
    () => opciones.unidades.filter((u) => coincideUnidad(u, consulta)),
    [opciones.unidades, consulta],
  )
  const porSerie = opciones.unidades.length > 0
  const fila = 'flex min-h-touch w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-100 active:bg-raised'

  return (
    <div
      ref={caja}
      role="group"
      aria-labelledby={idTitulo}
      className="scroll-mb-4 overflow-hidden rounded-ctl border border-accent/50 bg-surface"
    >
      <div className="flex items-center justify-between gap-2 pl-3 pr-1 pt-1">
        <p id={idTitulo} className="min-w-0 flex-1 py-1.5">
          <span className="eyebrow block !text-accent">¿Cuál has usado?</span>
          {nombre && <span className="mt-0.5 block truncate text-sm font-semibold">{nombre}</span>}
        </p>
        <button type="button" onClick={onCancelar} className="key-ghost min-h-11 shrink-0 px-3 text-sm">
          Cancelar
        </button>
      </div>

      {porSerie && opciones.unidades.length > 4 && (
        <div className="px-3 pb-2">
          <input
            type="search"
            value={consulta}
            onChange={(e) => setConsulta(e.target.value)}
            onKeyDown={(e) => {
              // Dentro del cierre de la avería, Enter lo enviaría.
              if (e.key === 'Enter') e.preventDefault()
            }}
            placeholder="Número de serie o modelo"
            aria-label="Buscar unidad"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="characters"
            spellCheck={false}
            enterKeyHint="search"
            className="h-11 w-full rounded-ctl border border-line bg-sunken px-3 font-mono text-base"
          />
        </div>
      )}

      <ul className={`divide-y divide-line-soft border-t border-line-soft ${porSerie ? 'max-h-[17.5rem] overflow-y-auto overscroll-contain' : ''}`}>
        {!porSerie &&
          opciones.estados.map((e) => (
            <li key={e.condicion}>
              <button
                type="button"
                onClick={() => onElegir({ condicion: e.condicion })}
                className={fila}
                aria-label={`${nombreDelEstado(e.condicion)}, ${e.quedan === 1 ? 'queda 1' : `quedan ${e.quedan}`}`}
              >
                <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${PUNTO_DE_CONDICION[e.condicion]}`} />
                <span className={`min-w-0 flex-1 truncate text-sm font-medium ${e.condicion === 'averiado' ? 'text-crit' : ''}`}>
                  {nombreDelEstado(e.condicion)}
                </span>
                <span className="shrink-0 text-xs text-muted tabular">
                  {e.quedan === 1 ? 'queda 1' : `quedan ${e.quedan}`}
                </span>
              </button>
            </li>
          ))}

        {porSerie &&
          unidades.map((u) => {
            const detalle = descripcionDeUnidad(u)
            return (
              <li key={u.id}>
                <button
                  type="button"
                  onClick={() => onElegir({ unitId: u.id, condicion: u.condicion })}
                  className={fila}
                  aria-label={`Número de serie ${u.serial}, ${CONDICION_LABEL[u.condicion]}`}
                >
                  {/* El estado, como en las demás filas: en el punto y dicho
                      con su palabra, delante del modelo. */}
                  <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${PUNTO_DE_CONDICION[u.condicion]}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-sm font-medium">{u.serial}</span>
                    <span className="block truncate text-xs text-muted">
                      <span className={u.condicion === 'averiado' ? 'text-crit' : ''}>{nombreDelEstado(u.condicion)}</span>
                      {detalle && ` · ${detalle}`}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        {porSerie && unidades.length === 0 && (
          <li className="px-3 py-3 text-xs text-muted">Ninguna unidad coincide con «{consulta}».</li>
        )}
        {porSerie && opciones.sinNumero > 0 && (
          <li>
            <button type="button" onClick={() => onElegir(null)} className={fila}>
              <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-line" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">Una sin número de serie</span>
                <span className="block text-xs text-muted">
                  {opciones.sinNumero === 1 ? 'Hay 1 más sin número apuntado' : `Hay ${opciones.sinNumero} más sin número apuntado`}
                </span>
              </span>
            </button>
          </li>
        )}
      </ul>

      <p className="border-t border-line-soft px-3 py-2 text-xs leading-snug text-muted">
        {porSerie
          ? 'Al cerrar la avería sale del almacén y queda en esta aula.'
          : 'Cifras de la última sincronización.'}
      </p>
    </div>
  )
}

/** «Nuevo», «Usado», «Sin estado»: cómo se llama un estado cuando se elige. */
function nombreDelEstado(c: Condicion): string {
  return c === 'sin_indicar' ? 'Sin estado' : CONDICION_LABEL[c]
}

/** «Nuevas», «Usadas»: cómo se llama cada grupo en la línea del parte. */
export function nombreDelGrupo(condicion: Condicion): string {
  return ESTADO_EN_PLURAL[condicion]
}
