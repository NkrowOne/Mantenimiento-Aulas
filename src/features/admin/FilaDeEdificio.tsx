/**
 * Un edificio del maestro, con sus salas agrupadas por planta.
 *
 * Vive aparte de `MaestroSalas` porque es lo único que crece con el campus: la
 * sección de arriba tiene una lista, un formulario de alta y una papelera, y
 * esto tiene dentro otra lista y tres sitios desde los que se abre la hoja de
 * acciones. Juntos eran seiscientas líneas en las que había que buscar con el
 * dedo en la pantalla.
 *
 * Agrupar por planta no es decoración. La planta es una fila del maestro que se
 * puede renombrar —«1a planta» y «1ª PLANTA» convivían desde la importación— y
 * sin cabecera propia no había ningún sitio donde pulsar para arreglarla; la
 * alternativa era renombrarla aula por aula, que además de tedioso deja la mitad
 * del edificio en la planta vieja mientras dura.
 *
 * Aquí no se escribe nada: los tres `⋯` no hacen más que decir sobre qué se
 * quiere actuar, y quien actúa es `HojaDeMaestro` —la misma hoja que sube al
 * mantener pulsada una fila en «Revisar»—. Añadir una sala también va por ahí, y
 * no por un formulario propio desplegado en la fila: hubo los dos durante un
 * rato, con dos avisos distintos para el mismo choque de códigos, y dos maneras
 * de dar de alta la misma sala son dos sitios donde arreglar el siguiente fallo.
 */

import { displayRoomCode } from '@/domain/normalize'
import type {
  EdificioDeMaestro,
  ObjetoDeMaestro,
  SalaDeMaestro,
} from '@/features/rooms/HojaDeMaestro'
import type { Zone } from '@/domain/types'

export interface EdificioDelMaestro {
  id: string
  code: string
  name: string
  needs_review: boolean
}

export interface SalaDelMaestro {
  room_id: string
  room_code: string
  room_name: string
  short_ref: string | null
  zone_id: string
  zone_name: string
  zone_order: number
  building_id: string
}

/**
 * Lo que se le entrega a la hoja: sobre qué se actúa y con qué se compara.
 *
 * El contexto viaja con el objeto y no se vuelve a pedir arriba porque quien lo
 * tiene delante es esta fila: las plantas y las salas de ESTE edificio, que son
 * contra las que se mide un choque de código. La sección de arriba tiene las 276
 * del campus y filtrarlas otra vez allí sería repetir el trabajo con el riesgo
 * de filtrarlas por otro criterio.
 */
export interface HojaDelMaestro {
  objeto: ObjetoDeMaestro
  /** Las plantas del edificio: con ellas la hoja avisa de una fusión antes de pedirla. */
  zonas: Zone[]
  /** Sus salas, en la forma mínima que la hoja necesita para detectar un choque. */
  salas: SalaDeMaestro[]
}

interface Props {
  edificio: EdificioDelMaestro
  /** Sus salas vivas, ya ordenadas por planta y código por el servidor. */
  salas: SalaDelMaestro[]
  desplegado: boolean
  onAlternar: () => void
  onAcciones: (hoja: HojaDelMaestro) => void
}

/** Tres puntos. El botón lo nombra su `aria-label`, así que el dibujo sobra para quien no lo ve. */
function Puntos(): React.ReactElement {
  return (
    <svg viewBox="0 0 20 20" className="mx-auto h-5 w-5" fill="currentColor" aria-hidden>
      <circle cx="4" cy="10" r="1.6" />
      <circle cx="10" cy="10" r="1.6" />
      <circle cx="16" cy="10" r="1.6" />
    </svg>
  )
}

/**
 * Las plantas de este edificio, en el orden en que bajan del servidor.
 *
 * Se reconstruyen desde las salas y no se piden aparte a propósito: una planta
 * sin ninguna sala no existe para nadie —no sale en ninguna vista, no baja al
 * espejo— y el propio servidor la borra en cuanto se queda vacía al mover la
 * última aula. Enseñar aquí una planta vacía sería enseñar algo que va a
 * desaparecer solo.
 */
function porPlanta(salas: SalaDelMaestro[]): Array<{ zona: Zone; salas: SalaDelMaestro[] }> {
  const grupos = new Map<string, { zona: Zone; salas: SalaDelMaestro[] }>()
  for (const s of salas) {
    const grupo = grupos.get(s.zone_id)
    if (grupo) grupo.salas.push(s)
    else {
      grupos.set(s.zone_id, {
        zona: {
          id: s.zone_id,
          building_id: s.building_id,
          name: s.zone_name,
          sort_order: s.zone_order,
        },
        salas: [s],
      })
    }
  }
  return [...grupos.values()]
}

export function FilaDeEdificio({
  edificio,
  salas,
  desplegado,
  onAlternar,
  onAcciones,
}: Props): React.ReactElement {
  const grupos = porPlanta(salas)
  const zonas = grupos.map((g) => g.zona)
  const suyo: EdificioDeMaestro = { id: edificio.id, code: edificio.code, name: edificio.name }
  /* La forma que entiende la hoja: la fila del servidor trae `room_id`, y la del
     espejo local `id`. Se traduce aquí, una vez, y no dentro de la hoja: si la
     hoja tuviera que saber de qué pantalla viene tendría dos caminos otra vez. */
  const suyas: SalaDeMaestro[] = salas.map((s) => ({
    id: s.room_id,
    code: s.room_code,
    name: s.room_name,
    zone_id: s.zone_id,
  }))

  return (
    <li className="card overflow-hidden">
      {/* La cabecera es dos botones hermanos y no uno dentro de otro: un
          `<button>` anidado en otro es HTML inválido, y React lo hidrata mal —el
          clic acaba en el de fuera y despliega en vez de abrir la hoja. */}
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={onAlternar}
          aria-expanded={desplegado}
          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left"
        >
          <span className="w-12 shrink-0 rounded-tag bg-raised py-1 text-center font-mono text-xs font-semibold text-accent">
            {edificio.code}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{edificio.name}</span>
            <span className="block text-xs text-muted">
              {salas.length === 0 ? 'sin salas' : `${salas.length} salas`}
            </span>
          </span>
          <span className="shrink-0 text-sm text-muted">{desplegado ? 'cerrar' : 'abrir'}</span>
        </button>
        <button
          type="button"
          aria-label={`Acciones del edificio ${edificio.code}`}
          aria-haspopup="dialog"
          onClick={() =>
            onAcciones({
              objeto: { tipo: 'edificio', edificio: suyo, salas: salas.length },
              zonas,
              salas: suyas,
            })
          }
          className="w-touch shrink-0 border-l border-line-soft text-muted"
        >
          <Puntos />
        </button>
      </div>

      <div className="collapse-y" data-open={desplegado} inert={!desplegado}>
        <div>
          {desplegado && (
            <div className="border-t border-line px-4 py-3">
              {grupos.map((g) => (
                <div key={g.zona.id} className="mt-2 first:mt-0">
                  <div className="flex items-center gap-2 border-b border-line-soft">
                    <p className="eyebrow min-w-0 flex-1 truncate py-1">{g.zona.name}</p>
                    <button
                      type="button"
                      aria-label={`Renombrar la planta ${g.zona.name}`}
                      aria-haspopup="dialog"
                      onClick={() =>
                        onAcciones({
                          objeto: {
                            tipo: 'planta',
                            zona: g.zona,
                            edificio: suyo,
                            salas: g.salas.length,
                          },
                          zonas,
                          salas: suyas,
                        })
                      }
                      className="min-h-11 shrink-0 px-2 text-xs text-muted"
                    >
                      Renombrar
                    </button>
                  </div>

                  <ul className="divide-y divide-line-soft">
                    {g.salas.map((s) => (
                      <li key={s.room_id} className="flex items-center gap-2 py-2">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {displayRoomCode(s.room_code)}
                            {s.room_name !== s.room_code && (
                              <span className="ml-2 font-normal text-muted">{s.room_name}</span>
                            )}
                          </span>
                          <span className="block truncate font-mono text-xs text-muted">
                            {s.short_ref ?? '—'}
                          </span>
                        </span>
                        <button
                          type="button"
                          aria-label={`Acciones de ${s.room_code}`}
                          aria-haspopup="dialog"
                          onClick={() =>
                            onAcciones({
                              objeto: {
                                tipo: 'sala',
                                sala: {
                                  id: s.room_id,
                                  code: s.room_code,
                                  name: s.room_name,
                                  zone_id: s.zone_id,
                                },
                                edificio: suyo,
                                zona: g.zona,
                              },
                              zonas,
                              salas: suyas,
                            })
                          }
                          className="w-touch min-h-11 shrink-0 rounded-ctl text-muted"
                        >
                          <Puntos />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}

              {salas.length === 0 && (
                <p className="py-2 text-sm text-muted">Este edificio no tiene salas.</p>
              )}

              {/* Dónde se añade una sala, dicho donde se busca. Un edificio
                  recién creado se despliega vacío, y sin esta línea el `⋯` de
                  arriba es un botón sin promesa: nadie lo abre para buscar un
                  alta. */}
              <p className="mt-3 text-xs text-muted">
                Para añadir una sala, renombrar el edificio o darlo de baja, usa el botón de
                acciones de su cabecera.
              </p>
            </div>
          )}
        </div>
      </div>
    </li>
  )
}
