/**
 * Cerrar una avería: qué se puede cerrar, y qué hay que contar para cerrarlo.
 *
 * Vive en `domain` por lo mismo que `incidencias.ts`: es la regla del proyecto
 * —«no se cierra nada sin decir qué se hizo»— y tiene que poder probarse sin
 * montar IndexedDB ni pintar un formulario. La pantalla la aplica; no la
 * inventa. Y son dos pantallas —la ficha del aula y la pestaña de Incidencias—,
 * que es justamente cómo una regla escrita dos veces acaba siendo dos reglas.
 *
 * La explicación es obligatoria y ese es el cambio de fondo. Cerrar era un
 * toque: la incidencia salía de la lista y de la sala no quedaba dicho nada. La
 * columna `resolution` existía desde el primer esquema y el botón no la pedía,
 * así que el histórico enseña «Resuelta: Proyector: no da imagen» sin una
 * palabra sobre qué se hizo — que es exactamente lo que hace falta la próxima
 * vez que ese proyector falle.
 */

import {
  assetIdFromCheckKey,
  LEGACY_CHECK_LABELS,
  ROOM_CHECK_LABELS,
  type Incident,
  type IncidentResolution,
} from './types'

/**
 * Lo más corto que se acepta como explicación.
 *
 * No es una cifra caprichosa: es el punto por debajo del cual no cabe una frase.
 * «Ya está», «ok» y «arreglado» pasan un `length > 0` y no dicen nada; «Cable
 * nuevo» son once caracteres y sí dice lo que se hizo. El listón está donde
 * separa esas dos cosas y ni un carácter más arriba — quien acaba de arreglar
 * algo de pie en un aula no tiene que redactar.
 *
 * El servidor solo exige que haya algo escrito, a propósito: una regla más dura
 * allí rechazaría el cierre horas después, en una cola que se vacía sola cuando
 * ya nadie mira. El sitio donde se exige es este, delante de quien puede
 * corregirlo.
 */
export const EXPLICACION_MINIMA = 10

/** Lo único que hace falta saber de una incidencia para decidir si se cierra. */
export type IncidenciaCerrable = Pick<Incident, 'state' | 'kind'>

/**
 * ¿Se puede cerrar esto?
 *
 * Un borrador no: lo que está a medio escribir no es todavía trabajo de nadie,
 * y cerrarlo dejaría una fila resuelta sin título. Una resuelta tampoco —ya lo
 * está—. Y una observación no se «resuelve»: es una nota de seguimiento, no
 * sale en la lista de trabajo y no tiene un final que firmar.
 */
export function sePuedeResolver(i: IncidenciaCerrable): boolean {
  return (i.state === 'abierta' || i.state === 'en_curso') && i.kind !== 'observacion'
}

/**
 * Qué le falta a la explicación, dicho para leerlo en pantalla. `null` si vale.
 *
 * Devuelve el mensaje y no un booleano porque el formulario tiene que decir qué
 * pasa: un botón deshabilitado sin motivo es la forma más rápida de que alguien
 * dé por hecho que la aplicación está rota.
 */
export function problemaDeExplicacion(texto: string): string | null {
  const limpio = texto.trim()
  if (limpio === '') return 'Escribe qué se ha hecho para resolverla.'
  if (limpio.length < EXPLICACION_MINIMA) {
    return `Cuenta un poco más: al menos ${EXPLICACION_MINIMA} caracteres. «Arreglado» no le sirve a quien lo lea dentro de seis meses.`
  }
  return null
}

export interface EntradaCierre {
  /** A qué incidencia cierra. */
  incidenciaId: string
  /** Lo que se escribió en el formulario, tal cual. */
  explicacion: string
  /** Quién lo firma. */
  autor: string | null
  /** El reloj del dispositivo. Se inyecta para poder probar esto sin esperar. */
  ahora: string
  /** Un id nuevo, por lo mismo. */
  nuevoId: () => string
}

/**
 * El asiento del cierre, listo para el espejo y para la cola.
 *
 * Nace con su identidad definitiva sin haber hablado con el servidor, que es lo
 * que permite dar por resuelto un proyector en un sótano sin cobertura. Revienta
 * si la explicación no vale: la pantalla ya lo ha comprobado y lo enseña al
 * escribir, y esto es la segunda capa — que ninguna otra pantalla se salte la
 * regla por descuido.
 */
export function cierreDeIncidencia(e: EntradaCierre): IncidentResolution {
  const problema = problemaDeExplicacion(e.explicacion)
  if (problema !== null) throw new Error(problema)

  return {
    id: e.nuevoId(),
    incident_id: e.incidenciaId,
    resolution: e.explicacion.trim(),
    resolved_at: e.ahora,
    resolved_by: e.autor,
  }
}

/**
 * Cómo queda la incidencia en el espejo local.
 *
 * Se escribe ya, sin esperar a nadie, porque quien acaba de resolverla tiene que
 * verla salir de la lista de la sala aunque no haya cobertura. Y se deja
 * EXACTAMENTE como quedará arriba —mismo texto, misma hora, mismo autor—: si
 * aquí se guardara otra cosa, la ficha diría una cosa antes de subir y otra
 * después, y la primera de las dos es la que la persona vio al pulsar.
 */
export function incidenciaCerrada(i: Incident, cierre: IncidentResolution): Incident {
  return {
    ...i,
    state: 'resuelta',
    resolution: cierre.resolution,
    resolved_at: cierre.resolved_at,
    resolved_by: cierre.resolved_by,
  }
}

/**
 * De qué aparato habla una incidencia: «Proyector», «Pantalla 2», «Red».
 *
 * Es lo que contesta a «¿cuál de las tres he arreglado?» cuando una sala tiene
 * varias abiertas. El título ya suele llevarlo delante —las que nacen de una
 * revisión se titulan «Proyector: no da imagen»—, pero las que se apuntan a mano
 * desde la ficha no, y esas son justamente las que se escriben con prisa.
 *
 * Tres fuentes, en orden de fiabilidad: el equipo al que apunta, la
 * comprobación de sala de la que salió («Red»), y el nombre de las casillas
 * fijas que existieron antes del inventario, para que una incidencia de
 * entonces no se lea como una clave. `null` cuando no hay ninguna de las tres,
 * que es el caso de todo lo importado del Excel.
 */
export function equipoDeIncidencia(
  i: Pick<Incident, 'asset_id' | 'check_key'>,
  nombreDeEquipo: (assetId: string) => string | null,
): string | null {
  if (i.asset_id !== null) {
    const nombre = nombreDeEquipo(i.asset_id)
    if (nombre !== null && nombre !== '') return nombre
  }

  const clave = i.check_key
  if (typeof clave !== 'string' || clave === '') return null

  // `asset:<uuid>` sin equipo conocido no dice nada legible: el aparato no está
  // en este dispositivo, y enseñar el uuid es peor que no enseñar nada.
  const porEquipo = assetIdFromCheckKey(clave)
  if (porEquipo !== null) return nombreDeEquipo(porEquipo)

  return ROOM_CHECK_LABELS[clave as 'red'] ?? LEGACY_CHECK_LABELS[clave] ?? null
}
