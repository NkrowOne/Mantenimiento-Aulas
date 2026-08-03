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
 * Tres decisiones que importan:
 *
 *  - **Una incidencia abierta por comprobación, no una por revisión.** El
 *    proyector roto se revisa otra vez la semana siguiente y se vuelve a marcar
 *    «Falla»; si cada ronda abriera una fila nueva, la pestaña de Incidencias
 *    acabaría con cinco copias del mismo proyector y el recuento de la sala
 *    mentiría. Mientras la anterior siga abierta, la nueva no se crea.
 *  - **Una revisión normal no toca lo que ya está abierto.** Sería tentador
 *    subir la gravedad si esta vez el técnico la marca más alta, pero modificar
 *    una incidencia ajena es cosa del supervisor: el permiso lo rechazaría y el
 *    técnico vería un error. El dato no se pierde — la comprobación de ESTA
 *    revisión queda guardada con su gravedad y su nota, y sale en el histórico.
 *  - **Una corrección sí manda sobre lo que abrió la visita que corrige.** Y esa
 *    es la excepción que da sentido a las otras dos, porque una corrección no es
 *    una visita nueva: es la misma visita contada mejor. Si el técnico se
 *    equivocó y el proyector estaba bien, la incidencia que se abrió no es un
 *    parte que alguien tenga que resolver — es un error que hay que retirar. Y
 *    si sigue roto pero la gravedad o la nota estaban mal, lo que vale es lo que
 *    dice la corrección, no lo que se apuntó la primera vez. Lo que NUNCA hace
 *    es abrir una segunda incidencia del mismo aparato: eso era exactamente el
 *    problema del que huye este fichero, solo que llegando por otra puerta.
 */

import {
  assetIdFromCheckKey,
  type CheckKey,
  type CheckResult,
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

/**
 * Por qué una corrección retira una incidencia.
 *
 * Va escrito en `resolution` y no se calla, porque la fila se queda en el
 * histórico y «resuelta» a secas se leería como que alguien fue y lo arregló.
 * Nadie arregló nada: la revisión se equivocó y la corrección lo dice.
 */
export function resolucionPorCorreccion(resultado: CheckResult): string {
  return resultado === 'na'
    ? 'Retirada al corregir la revisión: la comprobación pasó a «No aplica».'
    : 'Retirada al corregir la revisión: el equipo estaba bien.'
}

/** Y por qué retira a la segunda copia del mismo aparato. */
export const RESOLUCION_DUPLICADA =
  'Retirada al corregir la revisión: duplicaba una incidencia que ya estaba abierta para el mismo equipo.'

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
  /**
   * A qué revisiones reemplaza esta, si es una corrección.
   *
   * En el dispositivo se conoce la que se está corrigiendo y poco más; el
   * servidor, que sí puede recorrer la cadena entera, la resuelve completa en
   * `conciliar_incidencias_de_correccion()`. Las dos llegan al mismo sitio
   * porque hay una segunda seña, más barata y que no depende de la cadena: una
   * corrección **conserva la fecha de la visita**, y una incidencia de revisión
   * se fecha con ella. Misma fecha y nacida de una revisión = misma visita.
   */
  corrige?: string[]
  /** Cuándo se está cerrando. Se inyecta para poder probar sin reloj. */
  ahora?: string
}

/**
 * Qué le pasa a las incidencias de la sala al cerrar esta revisión.
 *
 * Son tres listas y no una porque son tres actos distintos, y confundirlos es
 * justo lo que hacía que corregir dejara la sala peor que antes: abrir un parte
 * nuevo, corregir el que ya existe y retirar el que no debió existir no se
 * pueden guardar igual ni contar igual.
 */
export interface PlanDeIncidencias {
  /** Las que abre esta revisión. Nacen aquí y suben por la cola de salida. */
  nuevas: Incident[]
  /** Las que la corrección reescribe: misma fila, lo que dice la corrección. */
  actualizadas: Incident[]
  /** Las que la corrección retira: la visita se equivocó. */
  retiradas: Incident[]
}

/**
 * Qué incidencias abre —y qué incidencias corrige— esta revisión.
 *
 * Las nuevas salen con su identidad definitiva sin haber hablado con el
 * servidor, que es lo que permite marcar una avería en un sótano sin cobertura.
 *
 * Lo que la corrección reescribe o retira se escribe en el espejo local para que
 * la sala diga la verdad en el momento, también sin cobertura; en el servidor lo
 * aplica el disparador de `inspections`, porque la cola de salida **no puede**
 * hacerlo: `incident` sube con «no pises lo que ya está» —es lo que evita que un
 * reenvío choque contra un permiso de supervisor— así que un cambio enviado
 * desde aquí llegaría y no haría nada. Las dos mitades aplican la misma regla,
 * igual que ocurre con la apertura desde que existe el rescate nocturno.
 */
export function incidenciasDeRevision(entrada: EntradaIncidencias): PlanDeIncidencias {
  const vivas = entrada.abiertas.filter((i) => i.state !== 'resuelta')
  const corrige = new Set(entrada.corrige ?? [])
  const esCorreccion = corrige.size > 0 || Boolean(entrada.inspection.corrects)
  const ahora = entrada.ahora ?? new Date().toISOString()

  /*
   * `typeof` y no `!== null`: en un dispositivo que espejó incidencias antes de
   * que la columna existiera, `check_key` llega `undefined`. Con la comprobación
   * ingenua, `undefined` entraba en el índice —inofensivo, porque ninguna clave
   * de comprobación es `undefined`— pero deja un índice que miente sobre lo que
   * contiene, y esa es la clase de descuido que rompe el siguiente cambio.
   *
   * Y se indexa también por equipo: `check_key` solo lo traen las incidencias
   * que nacieron de una revisión con esta versión de la app. Una avería del
   * mismo proyector importada del Excel o abierta a mano no lo tiene, y sin esta
   * segunda red la revisión abriría una segunda incidencia para un aparato que
   * ya está en la lista de alguien.
   *
   * Se guarda la fila y no solo la clave porque una corrección necesita saber
   * CUÁL es para poder reescribirla o retirarla, no solo que la hay.
   */
  const porCheck = new Map<string, Incident>()
  const porEquipo = new Map<string, Incident>()

  const indexar = (i: Incident): void => {
    if (typeof i.check_key === 'string' && i.check_key !== '' && !porCheck.has(i.check_key)) {
      porCheck.set(i.check_key, i)
    }
    if (typeof i.asset_id === 'string' && i.asset_id !== '' && !porEquipo.has(i.asset_id)) {
      porEquipo.set(i.asset_id, i)
    }
  }

  /**
   * ¿Esta incidencia la abrió la visita que se está corrigiendo?
   *
   * Es la frontera de toda la corrección, y por eso se pregunta dos veces. La
   * respuesta buena es la cadena de revisiones; la de repuesto es la fecha,
   * porque una corrección conserva `occurred_at` y una incidencia de revisión se
   * fecha con ella. Sin la segunda, corregir la corrección de una corrección
   * —que el dispositivo solo conoce un eslabón hacia atrás— dejaría de retirar
   * nada sin decir por qué.
   *
   * Lo abierto a mano desde la ficha nunca entra: no tiene revisión de origen, y
   * retirar el parte que alguien escribió porque hoy el aparato va bien sería
   * cerrarle el trabajo a otra persona.
   */
  const visitaEn = new Date(entrada.inspection.occurred_at).getTime()
  const deEstaVisita = (i: Incident): boolean => {
    if (typeof i.opened_from_inspection_id !== 'string' || i.opened_from_inspection_id === '') {
      return false
    }
    if (corrige.has(i.opened_from_inspection_id)) return true
    if (i.opened_from_inspection_id === entrada.inspection.id) return true
    /*
     * Por instante y no por cadena de texto: la fecha nace aquí como
     * `2026-07-30T08:15:00.000Z` y vuelve del servidor como
     * `2026-07-30T08:15:00+00:00`. Son el mismo momento y dos cadenas
     * distintas, así que comparar el texto haría que esta red dejara de
     * funcionar en cuanto la incidencia diera una vuelta por la red — que es
     * justo el caso para el que existe.
     */
    return new Date(i.opened_at).getTime() === visitaEn
  }

  const nuevas: Incident[] = []
  const actualizadas: Incident[] = []
  const retiradas: Incident[] = []
  /* Lo ya retirado en esta pasada, para que la segunda fila que apunte al mismo
     aparato no lo vuelva a tocar ni cuente como duplicado dos veces. */
  const yaRetiradas = new Set<string>()

  const retirar = (i: Incident, resolucion: string): void => {
    if (yaRetiradas.has(i.id)) return
    yaRetiradas.add(i.id)
    retiradas.push({
      ...i,
      state: 'resuelta',
      resolved_at: ahora,
      resolved_by: entrada.inspection.by_user,
      resolution: resolucion,
    })
  }

  /*
   * Antes de nada: dos partes vivos del mismo aparato abiertos por esta visita.
   *
   * No debería pasar —el índice de abajo lo evita— pero pasa: el espejo de un
   * dispositivo puede no tener la incidencia de la ronda anterior (una descarga
   * atrasada, un alta de otro iPad) y entonces se abrió la segunda. Cuando eso
   * ya ha ocurrido, la corrección es el momento de arreglarlo: sobrevive la más
   * antigua —que es la que lleva el ticket externo y el material apuntado— y la
   * copia se retira diciendo que lo era.
   *
   * Va PRIMERO y no al final para que el resto de la función trabaje contra la
   * superviviente: si se dedujera después, la corrección podría haber reescrito
   * la copia que está a punto de retirarse y su arreglo se iría con ella.
   */
  if (esCorreccion) {
    const porAparato = new Map<string, Incident[]>()
    for (const i of vivas) {
      if (!deEstaVisita(i)) continue
      const clave =
        typeof i.asset_id === 'string' && i.asset_id !== ''
          ? `asset:${i.asset_id}`
          : typeof i.check_key === 'string' && i.check_key !== ''
            ? i.check_key
            : null
      if (clave === null) continue
      porAparato.set(clave, [...(porAparato.get(clave) ?? []), i])
    }

    for (const grupo of porAparato.values()) {
      if (grupo.length < 2) continue
      // La más antigua sobrevive; el desempate por id mantiene la decisión
      // estable entre dispositivos cuando dos comparten la fecha de la visita.
      const ordenadas = [...grupo].sort(
        (a, b) => a.opened_at.localeCompare(b.opened_at) || a.id.localeCompare(b.id),
      )
      for (const copia of ordenadas.slice(1)) retirar(copia, RESOLUCION_DUPLICADA)
    }
  }

  for (const i of vivas) {
    if (!yaRetiradas.has(i.id)) indexar(i)
  }

  for (const check of entrada.checks) {
    const assetId = assetIdFromCheckKey(check.check_key)
    const yaHay =
      porCheck.get(check.check_key) ?? (assetId !== null ? porEquipo.get(assetId) : undefined) ?? null

    if (check.result !== 'incidencia') {
      // La corrección manda: si esta visita abrió un parte por esta fila y ahora
      // dice que el equipo estaba bien, el parte se retira.
      if (esCorreccion && yaHay && deEstaVisita(yaHay)) {
        retirar(yaHay, resolucionPorCorreccion(check.result))
      }
      continue
    }

    const nota = check.note?.trim() ?? ''
    const titulo = tituloDeIncidencia(entrada.etiquetaDe(check.check_key), nota)
    // La revisión siempre deja una gravedad puesta; el `?? 'media'` es para una
    // comprobación vieja guardada antes de que el formulario la exigiera.
    const gravedad = check.severity ?? 'media'

    if (!yaHay) {
      const fila: Incident = {
        id: entrada.nuevoId(),
        room_id: entrada.inspection.room_id,
        asset_id: assetId,
        opened_from_inspection_id: entrada.inspection.id,
        check_key: check.check_key,
        external_ref: null,
        title: titulo,
        description: nota || null,
        severity: gravedad,
        state: 'abierta',
        kind: 'incidencia',
        // La fecha de la revisión, no la de ahora: una avería vista el jueves en
        // un aula sin cobertura se abrió el jueves, aunque suba el lunes. De esa
        // fecha cuelga el «abierta hace N días» que decide qué está estancado.
        opened_at: entrada.inspection.occurred_at,
        opened_by: entrada.inspection.by_user,
        resolved_at: null,
        resolved_by: null,
        resolution: null,
        source: 'app',
      }
      nuevas.push(fila)
      // Dos filas de la misma revisión no pueden apuntar al mismo equipo —la
      // clave de la comprobación es única dentro de la revisión— pero se indexa
      // igual: así el bucle no depende de esa garantía para no duplicar.
      indexar(fila)
      continue
    }

    // Ya hay una viva para este aparato. En una revisión normal se respeta y no
    // se toca; corrigiendo, lo que vale es lo que dice la corrección.
    if (!esCorreccion || !deEstaVisita(yaHay)) continue

    const corregida: Incident = {
      ...yaHay,
      title: titulo,
      description: nota || null,
      severity: gravedad,
      check_key: yaHay.check_key ?? check.check_key,
      asset_id: yaHay.asset_id ?? assetId,
      opened_from_inspection_id: entrada.inspection.id,
    }

    // Solo si algo cambia de verdad. Una corrección que solo tocó la observación
    // de la sala no tiene por qué reescribir tres partes idénticos.
    const igual =
      corregida.title === yaHay.title &&
      corregida.description === yaHay.description &&
      corregida.severity === yaHay.severity &&
      corregida.check_key === yaHay.check_key &&
      corregida.asset_id === yaHay.asset_id &&
      corregida.opened_from_inspection_id === yaHay.opened_from_inspection_id
    if (!igual) actualizadas.push(corregida)
  }

  // Lo retirado no puede seguir en «actualizadas»: se retira y punto. Con el
  // deduplicado hecho antes del bucle no debería quedar ninguna, y el filtro se
  // queda porque la que sí puede coincidir es la fila que la corrección reescribe
  // y una comprobación posterior del mismo aparato retira.
  return {
    nuevas,
    actualizadas: actualizadas.filter((i) => !yaRetiradas.has(i.id)),
    retiradas,
  }
}
