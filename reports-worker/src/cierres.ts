/**
 * Los cierres del rayo, contados como cualquier otro.
 *
 * El rayo de la ficha de sala guarda la avería y abre su cierre con el mismo
 * texto puesto: quien llega, ve el cable suelto y lo enchufa escribe una sola
 * frase —«No funcionan los altavoces se conecta el cable a la regleta»— y esa
 * frase acaba siendo a la vez el título de la incidencia y lo que se hizo. En
 * el diario salían dos filas idénticas, la del cierre sin su línea de «qué se
 * hizo» —el detalle que repite el título se omite— y las dos cortadas a 90
 * caracteres. Al lado, un cierre normal dice «La pantalla del atril no se
 * enciende» y debajo «Se acude al aula y se le explica a la profesora cómo
 * usar el aula».
 *
 * Es el mismo módulo que `src/features/reports/informe/cierres.ts`, con una
 * diferencia: el expediente del worker no lleva tabla de cierres, solo diario.
 *
 * Aquí se separa esa frase en sus dos mitades:
 *
 *   problema  lo que fallaba, entero. Va en la fila de la incidencia.
 *   resumen   ese problema en corto. Es el título de la fila del cierre.
 *   solucion  lo que se hizo, entero. Va debajo, como en cualquier cierre.
 *
 * La separación la hace la IA cuando el informe la usa (`separarConIA` en
 * `ia.ts`); sin ella, o para lo que la IA no devuelva bien, se corta por la
 * puntuación. Lo que no se hace nunca es tocar la base: el texto guardado es el
 * que escribió el técnico, y esto es solo cómo se imprime.
 */

import type { ReportData } from './data.js'

export interface Separado {
  problema: string
  resumen: string
  /** `null` si del texto no sale qué se hizo: el cierre se queda con su título. */
  solucion: string | null
}

/** Para comparar dos textos que deberían ser el mismo. */
function normaliza(t: string): string {
  return t
    .toLocaleLowerCase('es')
    .replace(/\s+/g, ' ')
    .replace(/[\s.…,;:!¡?¿]+$/u, '')
    .trim()
}

/**
 * El texto entero de un cierre del rayo, o `null` si no lo es.
 *
 * Es del rayo si lo que se hizo es el título tal cual, o el título con algo
 * añadido detrás —quien cierra puede completar el motivo que se le deja
 * puesto—. Un título que solo aparece DENTRO de la explicación no cuenta:
 * «Proyector» y «Se cambia la lámpara del proyector» son un cierre normal.
 */
export function textoDelRayo(titulo: string, explicacion: string | null): string | null {
  if (!explicacion) return null
  const t = normaliza(titulo)
  const e = normaliza(explicacion)
  if (!t || !e) return null
  if (t === e || e.startsWith(t)) return explicacion.trim().replace(/\s+/g, ' ')
  if (t.startsWith(e)) return titulo.trim().replace(/\s+/g, ' ')
  return null
}

/** Sin el punto, los puntos suspensivos o la coma que cuelgan al final. */
function sinCola(t: string): string {
  return t.replace(/[\s.…,;:]+$/u, '').trim()
}

/** La primera letra en mayúscula, que es como empieza cualquier fila del diario. */
function capital(t: string): string {
  return t ? t.charAt(0).toLocaleUpperCase('es') + t.slice(1) : t
}

/*
 * Dónde empieza «lo que se hizo» cuando no hay un punto que lo diga.
 *
 * Desde el móvil la frase se escribe del tirón: «No se proyecta la pantalla del
 * aula Se le indica al usuario cómo…». Lo que marca el corte es una mayúscula
 * pegada a una minúscula, y solo con las palabras con las que empieza un
 * cierre: con cualquier mayúscula, «se avisa a Jorge» se partiría en dos.
 */
const ARRANQUE_DE_CIERRE =
  /(?<=[a-záéíóúüñ,])\s+(?=(?:Se|Ya|Tras|Solucionad[oa]|Resuelt[oa]|Arreglad[oa])\b)/u

/**
 * La separación sin IA: por la puntuación, o por la primera frase de cierre.
 *
 * Si no hay por dónde cortar, el problema es el texto entero y no hay solución:
 * mejor un cierre con su título y sin detalle que uno con una mitad inventada.
 */
export function separarSinIA(texto: string): Separado {
  const limpio = texto.trim().replace(/\s+/g, ' ')

  // Las frases, cortando solo por un signo seguido de espacio: «1.7» no es un final.
  let partes = limpio.split(/(?<=[.!?;])\s+(?=\S)/u)
  if (partes.length < 2) {
    const m = ARRANQUE_DE_CIERRE.exec(limpio)
    partes = m ? [limpio.slice(0, m.index), limpio.slice(m.index + m[0].length)] : [limpio]
  }

  const problema = capital(sinCola(partes[0] ?? limpio)) || limpio
  const resto = partes.slice(1).join(' ').trim()
  return {
    problema,
    resumen: problema,
    solucion: resto ? capital(resto) : null,
  }
}

/**
 * Los textos que hay que separar, por incidencia.
 *
 * Se miran los cierres del diario: es el único sitio donde el expediente del
 * worker los trae con su texto, porque aquí no hay tabla de cierres aparte.
 */
export function cierresDelRayo(d: ReportData): Map<string, string> {
  const textos = new Map<string, string>()
  for (const e of d.eventos) {
    if (e.tipo !== 'cierre' || !e.incidencia) continue
    const texto = textoDelRayo(e.titulo, e.detalle)
    if (texto) textos.set(e.incidencia, texto)
  }
  return textos
}

/**
 * El expediente con los cierres del rayo ya separados.
 *
 * Devuelve uno nuevo y no toca el que recibe: la redacción del análisis puede
 * estar leyéndolo a la vez.
 */
export function aplicarSeparacion(d: ReportData, separados: Map<string, Separado>): ReportData {
  if (!separados.size) return d

  const eventos = d.eventos.map((e) => {
    const s = e.incidencia ? separados.get(e.incidencia) : undefined
    if (!s) return e
    if (e.tipo === 'apertura') return { ...e, titulo: s.problema }
    if (e.tipo === 'cierre') return { ...e, titulo: s.resumen, detalle: s.solucion }
    return e
  })

  return { ...d, eventos }
}

/**
 * Todos separados: lo que trae la IA y, para lo demás, la puntuación.
 *
 * Así un cierre del rayo nunca sale a medias por que la IA no lo haya
 * devuelto: sale separado de la otra forma.
 */
export function separarTodos(
  textos: Map<string, string>,
  deIA: Map<string, Separado> = new Map(),
): Map<string, Separado> {
  return new Map([...textos].map(([id, texto]) => [id, deIA.get(id) ?? separarSinIA(texto)]))
}
