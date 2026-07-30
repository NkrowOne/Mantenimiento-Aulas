/**
 * De la revisión a la incidencia.
 *
 * Marcar «Falla» en un equipo durante la revisión no era una incidencia: era una
 * fila dentro de `inspection_checks` que solo se veía volviendo a abrir aquella
 * revisión. La avería quedaba registrada y nadie tenía que resolverla, que es la
 * peor combinación posible — la aplicación sabía que el proyector estaba roto y
 * no se lo pedía a nadie.
 *
 * Esto es la traducción, y vive en `domain` y no dentro del hook por dos motivos:
 * es la regla de negocio del proyecto («un fallo de un equipo de la sala es una
 * incidencia») y hay que poder probarla sin montar IndexedDB.
 *
 * Dos decisiones que importan:
 *
 *  - **Una incidencia abierta por comprobación, no una por revisión.** El
 *    proyector roto se revisa otra vez la semana siguiente y se vuelve a marcar
 *    «Falla»; si cada ronda abriera una fila nueva, la pestaña de Incidencias
 *    acabaría con cinco copias del mismo proyector y el recuento de la sala
 *    mentiría. Mientras la anterior siga abierta, la nueva no se crea.
 *  - **No se toca lo que ya está abierto.** Sería tentador subir la gravedad si
 *    esta vez el técnico la marca más alta, pero modificar una incidencia es cosa
 *    del supervisor: el permiso lo rechazaría y el técnico vería un error. El
 *    dato no se pierde — la comprobación de ESTA revisión queda guardada con su
 *    gravedad y su nota, y sale en el histórico de la sala.
 */

import {
  assetIdFromCheckKey,
  type CheckKey,
  type Incident,
  type Inspection,
  type InspectionCheck,
} from './types'

/** Lo más largo que se deja crecer un título antes de recortarlo. */
const TITULO_MAX = 100

/**
 * El título de la incidencia: el equipo, y lo que el técnico escribió.
 *
 * El nombre del equipo va delante y siempre. La lista de incidencias enseña el
 * título en negrita y poco más, así que un título que empiece por la nota
 * —«no da imagen»— obliga a abrir la fila para saber de qué aparato habla. Y
 * sin nota se dice que salió de la revisión en vez de dejar el título a secas,
 * que se leería como una incidencia a medio escribir.
 */
export function tituloDeIncidencia(etiqueta: string, nota: string | null): string {
  const texto = (nota ?? '').trim().split('\n')[0]?.trim() ?? ''
  if (!texto) return `${etiqueta}: fallo detectado en la revisión`

  const corto =
    texto.length > TITULO_MAX ? `${texto.slice(0, TITULO_MAX - 1).trimEnd()}…` : texto
  return `${etiqueta}: ${corto}`
}

export interface EntradaIncidencias {
  /** La revisión que se acaba de cerrar. */
  inspection: Inspection
  /** Sus comprobaciones, tal y como quedaron. */
  checks: InspectionCheck[]
  /** Cómo se llama la fila que falló: «Proyector», «Pantalla 2», «Red». */
  etiquetaDe: (key: CheckKey) => string
  /**
   * Las incidencias que ya hay en esta sala, del espejo local.
   *
   * El espejo solo guarda las que no están resueltas, así que en la práctica
   * esto son «las que siguen vivas». Se filtra igualmente por estado: si un día
   * el espejo guardara también las cerradas, esta función seguiría decidiendo
   * bien en vez de dejar de abrir incidencias sin que nada lo dijera.
   */
  abiertas: Incident[]
  /** Un id nuevo. Se inyecta para poder probar esto sin azar. */
  nuevoId: () => string
}

/**
 * Qué incidencias abre esta revisión.
 *
 * Devuelve filas completas de `incidents` listas para el espejo y para la cola
 * de salida: nacen con su identidad definitiva sin haber hablado con el
 * servidor, que es lo que permite marcar una avería en un sótano sin cobertura.
 */
export function incidenciasDeRevision(entrada: EntradaIncidencias): Incident[] {
  const vivas = entrada.abiertas.filter((i) => i.state !== 'resuelta')

  /*
   * `typeof` y no `!== null`: en un dispositivo que espejó incidencias antes de
   * que la columna existiera, `check_key` llega `undefined`. Con la comprobación
   * ingenua, `undefined` entraba en el conjunto —inofensivo, porque ninguna clave
   * de comprobación es `undefined`— pero deja un conjunto que miente sobre lo que
   * contiene, y esa es la clase de descuido que rompe el siguiente cambio.
   */
  const porCheck = new Set(
    vivas.map((i) => i.check_key).filter((k): k is string => typeof k === 'string' && k !== ''),
  )
  /*
   * Y también por equipo.
   *
   * `check_key` solo lo traen las incidencias que nacieron de una revisión con
   * esta versión de la app. Una avería del mismo proyector importada del Excel o
   * abierta a mano no lo tiene, y sin esta segunda red la revisión abriría una
   * segunda incidencia para un aparato que ya está en la lista de alguien.
   */
  const porEquipo = new Set(
    vivas.map((i) => i.asset_id).filter((a): a is string => typeof a === 'string' && a !== ''),
  )

  const nuevas: Incident[] = []

  for (const check of entrada.checks) {
    if (check.result !== 'incidencia') continue
    if (porCheck.has(check.check_key)) continue

    const assetId = assetIdFromCheckKey(check.check_key)
    if (assetId !== null && porEquipo.has(assetId)) continue

    const nota = check.note?.trim() ?? ''

    nuevas.push({
      id: entrada.nuevoId(),
      room_id: entrada.inspection.room_id,
      asset_id: assetId,
      opened_from_inspection_id: entrada.inspection.id,
      check_key: check.check_key,
      external_ref: null,
      title: tituloDeIncidencia(entrada.etiquetaDe(check.check_key), nota),
      description: nota || null,
      // La revisión siempre deja una gravedad puesta; el `?? 'media'` es para una
      // comprobación vieja guardada antes de que el formulario la exigiera.
      severity: check.severity ?? 'media',
      state: 'abierta',
      kind: 'incidencia',
      // La fecha de la revisión, no la de ahora: una avería vista el jueves en un
      // aula sin cobertura se abrió el jueves, aunque suba el lunes. De esa fecha
      // cuelga el «abierta hace N días» que decide qué está estancado.
      opened_at: entrada.inspection.occurred_at,
      opened_by: entrada.inspection.by_user,
      resolved_at: null,
      resolved_by: null,
      resolution: null,
      source: 'app',
    })

    // Dos filas de la misma revisión no pueden apuntar al mismo equipo —la clave
    // de la comprobación es única dentro de la revisión— pero se registra igual:
    // así el bucle no depende de esa garantía para no duplicar.
    porCheck.add(check.check_key)
    if (assetId !== null) porEquipo.add(assetId)
  }

  return nuevas
}
