/**
 * Fechas en hora de Madrid.
 *
 * Los instantes se guardan en UTC —`new Date().toISOString()` es correcto y no
 * hay que tocarlo— pero **los límites de un periodo son locales**: «este mes»
 * empieza a medianoche de Madrid, no a medianoche del huso en el que resulte
 * estar el aparato que hace la pregunta.
 *
 * Importa porque el mismo número se calcula en dos sitios: el panel lo saca en
 * el navegador y el informe en PDF lo saca en el servidor. Si cada uno usa una
 * zona distinta, dicen cifras distintas del mismo mes y nadie sabe cuál creer.
 */

/** La zona en la que trabaja el equipo. Gemela de `ZONA` en el worker. */
export const ZONA = 'Europe/Madrid'

/**
 * Las partes de una fecha tal y como se ven en Madrid.
 *
 * `Intl` es la única vía del navegador para convertir a otra zona sin arrastrar
 * una librería, y con `sv-SE` la fecha corta ya sale como `AAAA-MM-DD`, sin
 * tener que recomponerla.
 */
function fechaEnMadrid(instante: Date): { año: number; mes: number; dia: number } {
  const [año, mes, dia] = new Intl.DateTimeFormat('sv-SE', {
    timeZone: ZONA,
    dateStyle: 'short',
  })
    .format(instante)
    .split('-')
    .map(Number)

  return { año: año!, mes: mes!, dia: dia! }
}

/**
 * El instante en que empezó el mes en curso en Madrid.
 *
 * Se resuelve buscando el desfase real de ese día en vez de suponerlo: en
 * España son dos horas en verano y una en invierno, y el 1 de enero y el 1 de
 * julio no llevan el mismo.
 */
export function inicioDeMes(ahora = new Date()): Date {
  const { año, mes } = fechaEnMadrid(ahora)

  // Se parte de la medianoche UTC del día 1 y se corrige con el desfase que
  // Madrid tenga ese día concreto.
  const tentativa = Date.UTC(año, mes - 1, 1)
  const desfase = desfaseMs(new Date(tentativa))
  return new Date(tentativa - desfase)
}

/**
 * El instante en que empezó —o empezará— un día concreto en Madrid.
 *
 * Gemela de `public.inicio_del_dia(date)` en la base, y existe por el mismo
 * motivo: los límites de un periodo son medianoche DE MADRID. Comparar un
 * instante con una fecha suelta lo convierte usando la zona de quien pregunta,
 * y una revisión de las 00:30 acababa contada en el informe del día anterior.
 *
 * El desfase se busca, no se supone: en España son dos horas en verano y una en
 * invierno, y los dos domingos del cambio no tienen 24 horas.
 */
export function inicioDelDia(iso: string): Date {
  const [año, mes, dia] = iso.split('-').map(Number)
  const tentativa = Date.UTC(año!, mes! - 1, dia!)
  return new Date(tentativa - desfaseMs(new Date(tentativa)))
}

/** Cuánto va Madrid por delante de UTC en ese instante, en milisegundos. */
function desfaseMs(instante: Date): number {
  // `en-CA` con `hourCycle: 'h23'` da `AAAA-MM-DD, HH:MM:SS`, que se puede
  // reinterpretar como si fuera UTC para medir la diferencia.
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA,
    dateStyle: 'short',
    timeStyle: 'medium',
    hourCycle: 'h23',
  }).format(instante)

  const [fecha, hora] = partes.split(', ')
  const [a, m, d] = fecha!.split('-').map(Number)
  const [h, min, s] = hora!.split(':').map(Number)

  return Date.UTC(a!, m! - 1, d!, h!, min!, s!) - instante.getTime()
}

/** La fecha de Madrid de un instante, como `AAAA-MM-DD`. */
export function diaEnMadrid(instante = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: ZONA, dateStyle: 'short' }).format(instante)
}

/**
 * Para leer, no para ordenar: `18 jul 2026`.
 *
 * En la zona del campus y no en la del dispositivo, que es lo mismo que hace
 * todo lo demás de este fichero: un iPad con la zona mal puesta no debe mover un
 * registro de día en el historial de una sala.
 */
export function fechaCorta(iso: string): string {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: ZONA,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(t)
}

/**
 * La hora suelta de un instante, para leer: `10:42`.
 *
 * Es para sellar lo que acaba de pasar en la pantalla —«último intento a las
 * 10:42»—, que es la única forma de distinguir dos intentos seguidos cuando los
 * dos acaban igual. En la zona del campus por lo mismo que la fecha: quien lo
 * lee lo compara con el reloj de la pared del aula, no con el del iPad.
 *
 * Acepta el número de milisegundos además del ISO porque así es como lo dan los
 * relojes de react-query (`dataUpdatedAt`), y convertirlo en el sitio de la
 * llamada solo añadía un `new Date(...).toISOString()` de ida y vuelta.
 */
export function horaCorta(instante: string | number): string {
  const t = new Date(instante)
  if (Number.isNaN(t.getTime())) return ''
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: ZONA,
    hour: '2-digit',
    minute: '2-digit',
  }).format(t)
}
