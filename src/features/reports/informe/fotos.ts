/**
 * Qué fotos puede llevar el informe, y en qué orden.
 *
 * Está fuera de `datos.ts` porque ahora hay DOS sitios que necesitan la misma
 * respuesta y no pueden dar una distinta:
 *
 *  - el documento, que se las baja y las mete dentro como `data:`;
 *  - la pantalla, que las enseña antes de generar para poder quitar las que no
 *    tienen que salir.
 *
 * Si cada uno armara su lista, la casilla que se desmarca en la pantalla no
 * correspondería siempre con la foto que sale en el papel: bastaría una foto
 * añadida a una incidencia del periodo DESPUÉS del periodo —el informe la
 * lleva, porque la incidencia es del periodo, y una lista hecha por fecha de la
 * foto no la enseñaría— para que quien la quitó la viera impresa igual. Una
 * casilla que a veces no manda es peor que no tener casilla.
 *
 * La función es pura: recibe las filas ya leídas y devuelve la lista ordenada.
 * Así la prueba el test sin montar media base de datos.
 *
 * **De dónde sale cada momento.** No hace falta adivinarlo, lo dice la propia
 * aplicación: una foto colgada de una REVISIÓN se hizo mientras se revisaba el
 * aula —es la que enseña el problema recién encontrado— y una colgada de una
 * INCIDENCIA solo puede venir de la hoja de resolver, que es el único sitio
 * desde el que se le añade una. Si esa incidencia ya está resuelta, la foto es
 * el «después»; si sigue abierta, es una prueba de cómo está mientras espera.
 *
 * Y por eso van emparejadas: la incidencia guarda de qué revisión salió
 * (`opened_from_inspection_id`), así que las fotos de aquella revisión y las
 * del cierre son el antes y el después de lo mismo, y salen juntas.
 *
 * El orden no es cronológico a secas, y es deliberado: primero cada incidencia
 * con lo suyo —lo que justifica—, y después las revisiones que no abrieron
 * ninguna. Con el tope por medio, un orden por hora dejaría fuera justo los
 * cierres, que son los que cierran el argumento.
 */

import type {
  FilaAdjunto,
  FilaApertura,
  FilaCierre,
  FilaRevision,
  FilaSala,
} from './datos'

export type Momento = 'revision' | 'apertura' | 'cierre'

/**
 * Una foto que puede entrar en el informe, con todo lo que hace falta para
 * pintarla —en el documento o en la rejilla de la pantalla— y para descartarla.
 *
 * `id` es el del adjunto, y es lo que viaja en la petición cuando se quita: no
 * la ruta del almacén, que es un detalle de dónde está guardada y podría
 * cambiar, sino la identidad de la foto.
 */
export interface FotoCandidata {
  id: string
  storagePath: string
  takenAt: string
  momento: Momento
  titulo: string
  ref: string | null
  sala: FilaSala | undefined
}

export interface FilasParaFotos {
  aperturas: FilaApertura[]
  cierres: FilaCierre[]
  visitas: FilaRevision[]
  deSala: Map<string, FilaSala>
  /** Los adjuntos de las incidencias del periodo. */
  deIncidencias: FilaAdjunto[]
  /** Los de las revisiones del periodo. */
  deRevisiones: FilaAdjunto[]
}

/** Las incidencias del periodo, una ficha por incidencia. */
interface Ficha {
  titulo: string
  ref: string | null
  sala: FilaSala | undefined
  resuelta: boolean
  inspeccion: string | null
  cuando: string
}

/**
 * Una incidencia puede estar en las dos listas —abierta y cerrada dentro del
 * mismo periodo— y entonces manda la cerrada: es la que sabe que ya se
 * resolvió, y de eso depende si su foto es un «mientras espera» o un «después».
 */
function fichasDeIncidencias(
  aperturas: FilaApertura[],
  cierres: FilaCierre[],
  deSala: Map<string, FilaSala>,
): Map<string, Ficha> {
  const incidencias = new Map<string, Ficha>()

  for (const i of aperturas) {
    incidencias.set(i.id, {
      titulo: i.title ?? '(sin describir)',
      ref: i.external_ref,
      sala: i.room_id ? deSala.get(i.room_id) : undefined,
      resuelta: i.state === 'resuelta',
      inspeccion: i.opened_from_inspection_id,
      cuando: i.opened_at,
    })
  }

  for (const i of cierres) {
    const previa = incidencias.get(i.id)
    incidencias.set(i.id, {
      titulo: i.title ?? previa?.titulo ?? '(sin describir)',
      ref: i.external_ref ?? previa?.ref ?? null,
      sala: i.room_id ? deSala.get(i.room_id) : previa?.sala,
      resuelta: true,
      inspeccion: previa?.inspeccion ?? null,
      cuando: previa?.cuando ?? i.opened_at,
    })
  }

  return incidencias
}

/** Las fotos del periodo, ordenadas como van a salir en el documento. */
export function candidatasDeFotos(f: FilasParaFotos): FotoCandidata[] {
  const incidencias = fichasDeIncidencias(f.aperturas, f.cierres, f.deSala)

  const revisiones = new Map<string, FilaRevision>()
  for (const v of f.visitas) revisiones.set(v.id, v)

  if (incidencias.size === 0 && revisiones.size === 0) return []

  // El grupo ordena; el número sale del orden de apertura para que el documento
  // recorra las incidencias como pasaron.
  const grupoDe = new Map<string, number>()
  ;[...incidencias.entries()]
    .sort((a, b) => a[1].cuando.localeCompare(b[1].cuando))
    .forEach(([id], i) => grupoDe.set(id, i))

  // De qué incidencia es cada revisión, si abrió alguna. Es lo que empareja el
  // antes con el después.
  const incidenciaDeRevision = new Map<string, string>()
  for (const [id, ficha] of incidencias) {
    if (ficha.inspeccion) incidenciaDeRevision.set(ficha.inspeccion, id)
  }

  interface ConOrden extends FotoCandidata {
    grupo: number
    orden: number
  }
  const candidatas: ConOrden[] = []

  for (const a of f.deIncidencias) {
    const ficha = incidencias.get(a.entity_id)
    if (!ficha) continue
    candidatas.push({
      id: a.id,
      storagePath: a.storage_path,
      takenAt: a.taken_at,
      grupo: grupoDe.get(a.entity_id) ?? 0,
      orden: ficha.resuelta ? 2 : 1,
      momento: ficha.resuelta ? 'cierre' : 'apertura',
      titulo: ficha.titulo,
      ref: ficha.ref,
      sala: ficha.sala,
    })
  }

  const SUELTAS = incidencias.size
  for (const a of f.deRevisiones) {
    const visita = revisiones.get(a.entity_id)
    if (!visita) continue
    const deIncidencia = incidenciaDeRevision.get(a.entity_id)
    const ficha = deIncidencia ? incidencias.get(deIncidencia) : undefined
    candidatas.push({
      id: a.id,
      storagePath: a.storage_path,
      takenAt: a.taken_at,
      // Sin incidencia detrás, la foto de revisión va después de todas las
      // incidencias: cuenta cómo se encontró el aula, no qué se arregló.
      grupo: ficha && deIncidencia ? (grupoDe.get(deIncidencia) ?? 0) : SUELTAS,
      orden: 0,
      momento: 'revision',
      titulo: ficha?.titulo ?? 'Revisión del aula',
      ref: ficha?.ref ?? null,
      sala: ficha?.sala ?? (visita.room_id ? f.deSala.get(visita.room_id) : undefined),
    })
  }

  candidatas.sort(
    (a, b) => a.grupo - b.grupo || a.orden - b.orden || a.takenAt.localeCompare(b.takenAt),
  )

  return candidatas.map(({ grupo: _g, orden: _o, ...foto }) => foto)
}

/**
 * Las que de verdad van a entrar, quitadas las que se descartaron al pedir el
 * informe.
 *
 * Se descarta por lista de FUERA y no por lista de dentro a propósito: por
 * defecto entran todas, y una lista de dentro vacía no se distingue de «no se
 * eligió nada» —que es justo lo que pasa cuando el informe se pide sin abrir la
 * rejilla, o cuando lo pide una versión anterior de la pantalla—. Con la lista
 * de fuera, no elegir es no quitar nada, que es lo que espera cualquiera.
 */
export function sinLasDescartadas(
  candidatas: FotoCandidata[],
  fuera: ReadonlySet<string>,
): FotoCandidata[] {
  if (fuera.size === 0) return candidatas
  return candidatas.filter((c) => !fuera.has(c.id))
}
