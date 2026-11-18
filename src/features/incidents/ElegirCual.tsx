import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ESTADO_EN_PLURAL } from '@/domain/estados'
import { CONDICION_LABEL, coincideUnidad, descripcionDeUnidad } from '@/domain/unidades'
import { EtiquetaDeCondicion, PUNTO_DE_CONDICION } from '@/features/inventory/ElegirUnidad'
import type { Opciones } from './cual'
import type { Cual } from './material'

/**
 * «¿Cuál has usado?»: la pregunta que solo sale cuando tiene más de una
 * respuesta.
 *
 * Un toque y está apuntada: se elige y se cierra. No hay «Confirmar» —la
 * elección ES la confirmación, y lo apuntado se corrige en su línea, que lleva
 * su `−`—, ni desplegables: con el material en una mano, se ven todas las
 * respuestas a la vez y se toca una.
 *
 *  - Por estado, las que hay: «Nuevo · quedan 5», «Usado · quedan 3». Solo los
 *    estados con existencias; lo averiado al final y en su color, que se puede
 *    haber puesto pero conviene verlo.
 *  - Por número de serie, cada aparato con el suyo, como está en la pegatina, y
 *    su estado al lado. Con más de cuatro, un buscador: se teclean cuatro
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
  nombre: string
  opciones: Opciones
  onElegir: (cual: Cual) => void
  onCancelar: () => void
}): React.ReactElement {
  const idTitulo = useId()
  const [consulta, setConsulta] = useState('')
  const caja = useRef<HTMLDivElement>(null)

  // A la vista al abrirse: sale donde estaba la lista de resultados, y en un
  // teléfono con el teclado arriba puede quedar justo debajo de él.
  useEffect(() => {
    caja.current?.scrollIntoView({ block: 'nearest' })
  }, [])

  const unidades = useMemo(
    () => opciones.unidades.filter((u) => coincideUnidad(u, consulta)),
    [opciones.unidades, consulta],
  )
  const porSerie = opciones.unidades.length > 0

  return (
    <div
      ref={caja}
      role="group"
      aria-labelledby={idTitulo}
      className="mt-2 scroll-mb-4 rounded-ctl border border-accent/40 bg-surface p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <p id={idTitulo} className="min-w-0 flex-1 text-sm">
          <span className="block font-semibold">¿Cuál has usado?</span>
          <span className="block truncate text-xs text-muted">{nombre}</span>
        </p>
        <button
          type="button"
          onClick={onCancelar}
          className="-mr-1 -mt-1 min-h-11 shrink-0 px-2 text-xs text-muted underline-offset-4 hover:underline"
        >
          Cancelar
        </button>
      </div>

      {!porSerie && (
        <ul className="mt-2 grid grid-cols-2 gap-1.5">
          {opciones.estados.map((e) => (
            <li key={e.condicion}>
              <button
                type="button"
                onClick={() => onElegir({ condicion: e.condicion })}
                className={`flex min-h-touch w-full items-center gap-2 rounded-ctl border bg-raised px-3 py-2 text-left active:bg-sunken ${
                  e.condicion === 'averiado' ? 'border-crit/40' : 'border-line'
                }`}
                aria-label={`${CONDICION_LABEL[e.condicion]}, quedan ${e.quedan}`}
              >
                <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${PUNTO_DE_CONDICION[e.condicion]}`} />
                <span className="min-w-0 flex-1">
                  <span className={`block text-sm font-semibold ${e.condicion === 'averiado' ? 'text-crit' : ''}`}>
                    {e.condicion === 'sin_indicar' ? 'Sin estado' : CONDICION_LABEL[e.condicion]}
                  </span>
                  <span className="block font-mono text-xs text-muted tabular">
                    {e.quedan === 1 ? 'queda 1' : `quedan ${e.quedan}`}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {porSerie && (
        <>
          {opciones.unidades.length > 4 && (
            <input
              type="search"
              value={consulta}
              onChange={(e) => setConsulta(e.target.value)}
              onKeyDown={(e) => {
                // Dentro del cierre de la avería, Enter lo enviaría.
                if (e.key === 'Enter') e.preventDefault()
              }}
              placeholder="Buscar por número de serie o modelo"
              aria-label="Buscar unidad"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck={false}
              enterKeyHint="search"
              className="mt-2 h-11 w-full rounded-ctl border border-line bg-sunken px-3 font-mono text-base"
            />
          )}
          <ul className="mt-2 max-h-[17rem] space-y-1.5 overflow-y-auto overscroll-contain">
            {unidades.map((u) => {
              const detalle = descripcionDeUnidad(u)
              return (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => onElegir({ unitId: u.id, condicion: u.condicion })}
                    className="flex min-h-touch w-full items-center gap-3 rounded-ctl border border-line bg-raised px-3 py-2 text-left active:bg-sunken"
                    aria-label={`Número de serie ${u.serial}, ${CONDICION_LABEL[u.condicion]}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-sm font-semibold">{u.serial}</span>
                      {detalle && <span className="block truncate text-xs text-muted">{detalle}</span>}
                    </span>
                    <EtiquetaDeCondicion condicion={u.condicion} />
                  </button>
                </li>
              )
            })}
            {unidades.length === 0 && (
              <li className="px-1 py-2 text-xs text-muted">Ninguna unidad coincide con «{consulta}».</li>
            )}
            {opciones.sinNumero > 0 && (
              <li>
                <button
                  type="button"
                  onClick={() => onElegir(null)}
                  className="flex min-h-touch w-full items-center gap-3 rounded-ctl border border-dashed border-line bg-raised px-3 py-2 text-left active:bg-sunken"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">Una sin número de serie</span>
                    <span className="block text-xs text-muted">
                      El almacén cuenta {opciones.sinNumero} más que no {opciones.sinNumero === 1 ? 'tiene' : 'tienen'} número
                      apuntado.
                    </span>
                  </span>
                </button>
              </li>
            )}
          </ul>
        </>
      )}

      <p className="mt-2 text-xs text-muted">
        {porSerie
          ? 'Al cerrar la avería, la unidad sale del almacén y queda en esta aula.'
          : 'Las cifras son de la última sincronización. Si al cerrar no queda de ese estado, sale de lo que haya.'}
      </p>
    </div>
  )
}

/** «Nuevas», «Usadas»: cómo se llama cada grupo en la línea del parte. */
export function nombreDelGrupo(condicion: keyof typeof ESTADO_EN_PLURAL): string {
  return ESTADO_EN_PLURAL[condicion]
}
