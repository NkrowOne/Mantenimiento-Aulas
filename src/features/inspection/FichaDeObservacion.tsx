/**
 * La observación de una visita, como una ficha: la foto y la frase, juntas y a
 * la vista.
 *
 * Antes las fotos iban en miniaturas de 80 píxeles y la observación aparte, y
 * el conjunto se leía como metadatos: para saber QUÉ vio quien estuvo en el
 * aula había que abrir foto a foto. Pero la foto es la mitad del mensaje — «el
 * mando aparece en el cajón» al lado de la foto del cajón es una historia; en
 * dos bloques sueltos son dos datos. Esta ficha los junta en una sola pieza
 * que se entiende de un vistazo recorriendo el histórico con el pulgar.
 *
 * TRES DECISIONES DE FORMA:
 *
 *  - **La primera foto manda.** Se pinta grande, a lo ancho de la tarjeta: es
 *    la que alguien encuadró primero, y casi siempre la que cuenta la historia.
 *    Las demás van en fila debajo, del mismo tamaño entre sí.
 *  - **La ficha tiene techo.** A partir de la cuarta foto, la última baldosa
 *    dice «+N» y abre el visor: una visita con doce fotos no puede convertir
 *    el histórico en un carrete. El visor ya existe y pasa por todas.
 *  - **La observación va DENTRO de la ficha**, debajo de sus propias fotos y
 *    con el filete de cita: la escribió una persona que estuvo allí, y se lee
 *    como el pie de sus fotos, no como un campo más.
 *
 * Sin fotos, la observación se queda en su cita de siempre: un panel alrededor
 * de una frase sola sería marco sin cuadro.
 */

import { useState } from 'react'
import {
  SelloSinSubir,
  VisorDeFotos,
  useFotosDeRevision,
  type Foto,
} from './FotosDeRevision'

/** Cuántas baldosas caben en la fila de abajo. Con la grande, cuatro fotos. */
const BALDOSAS = 3

export function FichaDeObservacion({
  ids,
  nota,
  anunciadas,
}: {
  /** Las revisiones de la visita: una corregida son varias filas, y las fotos
      de aquel día están repartidas entre ellas. */
  ids: string[]
  /** La observación vigente de la visita. */
  nota: string | null
  /** Cuántas fotos dice el servidor que tiene la visita. Decide si «no hay
      fotos» significa «no las hizo nadie» o «no hay conexión para verlas». */
  anunciadas: number
}): React.ReactElement | null {
  const { fotos, sinConexion } = useFotosDeRevision(ids)
  const [abierta, setAbierta] = useState<number | null>(null)

  const texto = (nota ?? '').trim()

  if (fotos.length === 0) {
    if (!texto && anunciadas === 0) return null
    return (
      <div className="mt-3">
        {texto && (
          <p className="whitespace-pre-line border-l-2 border-line pl-3 text-sm leading-relaxed">
            {texto}
          </p>
        )}
        {/* Las fotos existen pero no se pueden traer: se dice, en vez de dejar
            una visita «con fotos» enseñando ninguna. */}
        {anunciadas > 0 && sinConexion && (
          <p className={`text-xs text-muted ${texto ? 'mt-2' : ''}`}>
            Las {anunciadas === 1 ? 'foto de esta visita necesita' : 'fotos de esta visita necesitan'}{' '}
            conexión.
          </p>
        )}
      </div>
    )
  }

  const [portada, ...resto] = fotos as [Foto, ...Foto[]]
  const enFila = resto.slice(0, BALDOSAS)
  const ocultas = fotos.length - 1 - enFila.length
  // Las columnas de la fila salen de cuántas fotos hay, no de un número fijo:
  // una sola foto extra a un tercio del ancho parecería un hueco a medio cargar.
  const columnas = ['grid-cols-1', 'grid-cols-2', 'grid-cols-3'][enFila.length - 1]

  return (
    <>
      <figure className="mt-3 overflow-hidden rounded-ctl border border-line bg-raised">
        <button
          type="button"
          onClick={() => setAbierta(0)}
          className="relative block w-full bg-sunken"
          aria-label={fotos.length === 1 ? 'Ver la foto' : `Ver la foto 1 de ${fotos.length}`}
        >
          <img
            src={portada.url}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-56 w-full object-cover sm:h-64"
          />
          {portada.pendiente && <SelloSinSubir />}
        </button>

        {enFila.length > 0 && (
          /* `gap-px` sobre el color de línea: las juntas del mosaico son la
             propia rejilla, sin bordes que sumar en las esquinas. */
          <ul className={`grid ${columnas} gap-px border-t border-line bg-line`}>
            {enFila.map((f, i) => {
              const indice = i + 1
              const ultima = i === enFila.length - 1 && ocultas > 0

              return (
                <li key={f.id} className="min-w-0">
                  <button
                    type="button"
                    onClick={() => setAbierta(indice)}
                    className="relative block w-full bg-sunken"
                    aria-label={
                      ultima
                        ? `Ver las ${ocultas + 1} fotos restantes`
                        : `Ver la foto ${indice + 1} de ${fotos.length}`
                    }
                  >
                    <img
                      src={f.url}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="h-24 w-full object-cover"
                    />
                    {/* El techo de la ficha: lo que no cabe se cuenta encima de
                        la última baldosa, y tocarla sigue el carrete en el visor. */}
                    {ultima && (
                      <span className="absolute inset-0 flex items-center justify-center bg-black/55 font-mono text-sm font-semibold text-white">
                        +{ocultas + 1}
                      </span>
                    )}
                    {!ultima && f.pendiente && <SelloSinSubir />}
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {texto && (
          <figcaption className="border-t border-line p-3">
            <p className="whitespace-pre-line border-l-2 border-accent/60 pl-3 text-sm leading-relaxed">
              {texto}
            </p>
          </figcaption>
        )}
      </figure>

      {abierta !== null && fotos[abierta] && (
        <VisorDeFotos
          fotos={fotos}
          indice={abierta}
          onIr={setAbierta}
          onCerrar={() => setAbierta(null)}
        />
      )}
    </>
  )
}
