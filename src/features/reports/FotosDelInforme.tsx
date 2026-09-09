/**
 * Qué fotos lleva el informe, una por una.
 *
 * La casilla «Fotos del periodo» decide si hay fotos; esto decide CUÁLES. Y
 * hace falta porque no todas las fotos de una semana son publicables en un
 * documento que se firma y se manda a dirección: la que salió movida, la que
 * enseña la mesa de alguien, la que repite lo mismo que la de al lado. Hasta
 * ahora la única salida era quitar la sección entera y quedarse sin ninguna.
 *
 * **Por defecto entran todas.** Quien no abra esto ni se entere de que existe
 * tiene que recibir exactamente el informe que recibía antes: se marca lo que
 * se QUITA, no lo que se pone, y no quitar nada es lo normal.
 *
 * No es lo mismo que **retirar** una foto desde su visor (`hidden_at`), y las
 * dos hacen falta: retirar es para siempre y para todos los informes —la foto
 * en la que se coló una persona no tiene que volver a imprimirse nunca—;
 * esto es para el documento que se está pidiendo, y no cambia nada en la ficha
 * del aula. Las retiradas ni siquiera llegan a la rejilla: se quedan en la
 * consulta de adjuntos, que ya las filtra.
 *
 * La rejilla se pide sola al abrir los ajustes con la sección marcada, y no
 * cuesta lo que cuesta el informe: aquí no se baja ni una foto: se firma un
 * enlace corto por cada una —una sola petición para todas— y el navegador va
 * pidiendo las miniaturas que se ven. Bajar las fotos de verdad, reducirlas y
 * meterlas dentro del documento es el tramo más largo de generar un informe, y
 * elegir cuáles van no puede costar lo mismo que hacerlo.
 *
 * Son las MISMAS fotos que va a llevar el documento y en el mismo orden, porque
 * la lista la arma una sola pieza (`informe/fotos.ts`) para los dos sitios. Una
 * casilla que a veces no manda sería peor que no tener casilla.
 */

import { useQuery } from '@tanstack/react-query'
import type { Rango } from './periodos'
import { TOPE_FOTOS, fotosParaElegir, type FotoElegible } from './informe/datos'

const MOMENTO: Record<FotoElegible['momento'], string> = {
  revision: 'En la revisión',
  apertura: 'Incidencia abierta',
  cierre: 'Al resolverla',
}

export function FotosDelInforme({
  rango,
  activo,
  fuera,
  onFuera,
}: {
  rango: Rango
  /** La sección de fotos está marcada y el periodo es pedible. */
  activo: boolean
  /** Los ids de adjunto que se han quitado. */
  fuera: string[]
  onFuera: (ids: string[]) => void
}): React.ReactElement {
  const { data, isPending, isError, error } = useQuery({
    // Por el periodo: cambiar de semana es otra rejilla, y la anterior no vale.
    queryKey: ['fotos-informe', rango.start, rango.end],
    enabled: activo,
    queryFn: () => fotosParaElegir(rango),
    // Las URL firmadas duran media hora; a los veinte minutos se vuelven a pedir
    // antes de que ninguna miniatura se quede en un hueco roto.
    staleTime: 20 * 60_000,
  })

  /* Sin periodo no hay rejilla que enseñar, y el hueco en blanco debajo del
     rótulo se lee como una pantalla a medio cargar. */
  if (!activo) {
    return <p className="text-sm text-muted">Elige el periodo para ver sus fotos.</p>
  }

  if (isPending) {
    return (
      <p className="text-sm text-muted" role="status">
        Buscando las fotos del periodo…
      </p>
    )
  }

  if (isError) {
    return (
      <p role="alert" className="text-sm text-crit">
        No se han podido leer las fotos del periodo
        {error instanceof Error ? `: ${error.message}` : '.'} El informe se puede generar igual, y
        entrarán todas las que quepan.
      </p>
    )
  }

  const { fotos, total } = data
  if (fotos.length === 0) {
    return <p className="text-sm text-muted">El periodo no tiene ninguna foto.</p>
  }

  const quitada = new Set(fuera)
  const dentro = fotos.filter((f) => !quitada.has(f.id))
  const alternar = (id: string): void =>
    onFuera(quitada.has(id) ? fuera.filter((x) => x !== id) : [...fuera, id])

  return (
    <div>
      <p className="text-sm">
        <span className="font-medium">
          {dentro.length === fotos.length
            ? `Entran las ${fotos.length}`
            : `Entran ${dentro.length} de ${fotos.length}`}
        </span>
        <span className="text-muted">
          {' '}
          · toca una foto para dejarla fuera de este informe
        </span>
      </p>
      {/* Lo de aquí y «Que no salga en el informe» de la ficha del aula se
          parecen y no son lo mismo: aquello retira la foto de todos los
          informes, para siempre; esto es solo el documento que se está
          pidiendo. Confundirlos se paga caro en las dos direcciones. */}
      <p className="mt-1 text-xs text-muted">
        Solo para este documento y sin tocar nada en la ficha del aula. Para que una foto no salga
        nunca más —la que se coló con alguien dentro— se retira desde el visor de la propia foto.
        Las retiradas ya no salen aquí.
      </p>

      {dentro.length === 0 && (
        <p className="mt-1 text-xs text-warn">
          Sin ninguna marcada, el informe sale sin la sección de fotos.
        </p>
      )}

      {/* Los dos topes, dichos antes de generar y no descubiertos en el PDF. El
          documento admite cuarenta, y la rejilla no enseña un periodo entero
          cuando es largo. */}
      {dentro.length > TOPE_FOTOS && (
        <p className="mt-1 text-xs text-warn">
          En el documento caben {TOPE_FOTOS}: entrarán las {TOPE_FOTOS} primeras de las que dejes
          marcadas, en el orden en que salen aquí.
        </p>
      )}
      {total > fotos.length && (
        <p className="mt-1 text-xs text-muted">
          El periodo tiene {total} fotos y aquí se enseñan las {fotos.length} primeras. Las demás
          no se pueden quitar desde aquí, y tampoco caben en el documento.
        </p>
      )}

      <ul className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
        {fotos.map((f) => {
          const va = !quitada.has(f.id)
          return (
            <li key={f.id}>
              {/*
                Una casilla de verdad y no un botón con estado pintado: esto es
                marcar y desmarcar, que es lo que un lector de pantalla y un
                teclado ya saben hacer con `input[type=checkbox]`. La casilla se
                ve —arriba a la izquierda, sobre la foto— porque el atenuado
                solo no distingue «fuera» de «esta foto salió oscura».
              */}
              <label className="block cursor-pointer">
                <span className="relative block overflow-hidden rounded-ctl border border-line bg-sunken">
                  <img
                    src={f.url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className={`h-24 w-full object-cover transition-opacity ${
                      va ? '' : 'opacity-30'
                    }`}
                  />
                  <input
                    type="checkbox"
                    checked={va}
                    onChange={() => alternar(f.id)}
                    aria-label={`${MOMENTO[f.momento]} · ${f.building} ${f.room} · ${f.dia} ${f.hora} · ${f.titulo}`}
                    className="absolute left-1 top-1 h-5 w-5 accent-[rgb(var(--accent))]"
                  />
                  {!va && (
                    <span className="absolute inset-x-0 bottom-0 bg-warn-fill py-0.5 text-center text-[0.625rem] font-semibold text-warn-ink">
                      fuera
                    </span>
                  )}
                </span>
                <span className="mt-1 block text-[0.6875rem] leading-tight text-muted">
                  <span className="block font-mono">
                    {f.building} {f.room}
                  </span>
                  <span className="block">
                    {MOMENTO[f.momento]} · {f.hora}
                  </span>
                </span>
              </label>
            </li>
          )
        })}
      </ul>

      <div className="mt-2 flex gap-3 text-xs">
        <button type="button" onClick={() => onFuera([])} className="text-accent underline">
          Todas
        </button>
        <button
          type="button"
          onClick={() => onFuera(fotos.map((f) => f.id))}
          className="text-accent underline"
        >
          Ninguna
        </button>
      </div>
    </div>
  )
}
