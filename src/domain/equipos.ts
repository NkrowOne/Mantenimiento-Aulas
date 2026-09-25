/**
 * Un aparato con dos nombres sigue siendo un aparato.
 *
 * El libro llama a las cosas por su columna —`S/N TV`, `S/N Monitor`,
 * `S/N Ordenador`— y la aplicación las llama por su tipo de equipo, que lo
 * puso la importación y luego lo fue tocando la gente: «Pantalla», «Ordenador
 * Tiny», «Cámara Aver». Mientras los dos lados comparen nombres con `===`, el
 * Tiny del aula sale como «equipo nuevo» en cada pasada, el servidor lo rechaza
 * porque su número de serie ya está puesto, y la celda vuelve a la cuarentena
 * la semana siguiente con el contador una vez más alto. Es lo que pasó con 52
 * ordenadores y 67 monitores, y es el «sigue cogiéndolo como conflicto».
 *
 * Aquí se decide **cuándo dos nombres hablan del mismo aparato**, y se decide
 * en un solo sitio para que el volcado, la fusión y el servidor contesten lo
 * mismo. Tres fuentes, por este orden:
 *
 *  1. El **catálogo de la base**: el nombre del tipo, sus alias y el tipo en el
 *     que se fundió (`merged_into`). Es lo que `asset_type_id()` mira en el
 *     servidor, y aquí se mira igual.
 *  2. Los **sinónimos declarados** abajo, para lo que el catálogo todavía no
 *     sabe: una base sin la migración que fusionó «Ordenador Tiny» en
 *     «Ordenador» tiene que sincronizar igual de bien que una con ella.
 *  3. Y nada más. «Monitor» no es «TV» ni «TV» es «Monitor»: uno es la pantalla
 *     del PC y el otro la tele grande del aula, y que compartan la palabra
 *     «pantalla» en el habla es justo la trampa que costó dos rondas de
 *     capturas. «Monitor Atril», «Ordenador Lenovo Ideacentre» y «Pantalla de
 *     proyección» tampoco son sinónimos de nada: son otros aparatos.
 */

import { EQUIPOS_EN_COLUMNAS } from './mapa'

/**
 * Sin tildes, en mayúsculas y con los espacios colapsados: la misma regla que
 * `public.norm_text()` en el servidor, para que un alias que allí cruza aquí
 * cruce también. No se pasan las comas a puntos —eso es de `norm()` de
 * `normalize.ts` y nació para leer números del Excel—: un nombre de aparato
 * con coma es un nombre, no una cifra.
 */
export function normTipo(nombre: string): string {
  return String(nombre ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Cómo llama la gente a cada aparato de los que el libro saca en columnas.
 *
 * La clave es el nombre de la columna del libro, que es el que manda
 * (`EQUIPOS_EN_COLUMNAS`). Se compara sin tildes ni mayúsculas, así que
 * «Camara» y «Cámara» son la misma entrada aunque aquí figure una sola.
 */
export const SINONIMOS_DE_TIPO: Record<string, string[]> = {
  TV: ['Pantalla', 'Televisor', 'Televisión', 'Tele', 'TV NEC', 'Pantalla TV'],
  Monitor: ['Monitor PC', 'Monitor del PC', 'Monitor de PC', 'Pantalla del PC'],
  Ordenador: [
    'Ordenador Tiny',
    'Tiny',
    'PC',
    'PC Tiny',
    'Tiny PC',
    'ThinkCentre',
    'Ordenador del aula',
    'Ordenador del profesor',
  ],
  Cámara: ['Camara', 'Cámara Aver', 'Camara Aver', 'Webcam'],
  Micrófono: ['Micrófono Jabra', 'Microfono', 'Microfono Jabra', 'Jabra'],
  Proyector: ['Cañón', 'Canon', 'Videoproyector'],
  Screenbeam: ['Sreenbeam', 'Screen Beam'],
  'Panacast 50': ['Panacast', 'Jabra Panacast 50'],
  Barco: ['Barco ClickShare', 'ClickShare'],
}

/** Lo que hace falta saber de un tipo del catálogo para reconocerlo. */
export interface TipoConocido {
  id: string
  name: string
  aliases?: string[] | null
  merged_into?: string | null
}

/** Nombre normalizado → nombre de la columna del libro, por sinónimo. */
const CANONICO_POR_SINONIMO = new Map<string, string>()
for (const tipo of EQUIPOS_EN_COLUMNAS) {
  CANONICO_POR_SINONIMO.set(normTipo(tipo), tipo)
  for (const s of SINONIMOS_DE_TIPO[tipo] ?? []) CANONICO_POR_SINONIMO.set(normTipo(s), tipo)
}

/** El nombre de columna del libro al que responde un nombre suelto, si responde a alguno. */
export function canonicoDe(nombre: string): string | null {
  return CANONICO_POR_SINONIMO.get(normTipo(nombre)) ?? null
}

/**
 * El tipo vivo: si éste se fundió en otro, el otro (siguiendo la cadena hasta
 * ocho saltos, que es lo que hace `datosDeLaPasada` desde siempre).
 */
export function tipoVivo(tipo: TipoConocido, tipos: Map<string, TipoConocido>): TipoConocido {
  let t = tipo
  for (let i = 0; t.merged_into && i < 8; i++) {
    const siguiente = tipos.get(t.merged_into)
    if (!siguiente) break
    t = siguiente
  }
  return t
}

/**
 * El nombre con el que la sincronización habla de un tipo del catálogo.
 *
 * Si el tipo vivo —su nombre, cualquiera de sus alias, o el nombre del tipo
 * absorbido por el camino— responde a una columna del libro, se devuelve el
 * nombre de esa columna: es el que compara la fusión y el que escribe la hoja.
 * Si no, el nombre del tipo vivo tal cual: un «Atril» es un «Atril».
 *
 * El nombre exacto gana al alias, igual que en `asset_type_id()`: un tipo que
 * se llame «Monitor» es «Monitor» aunque lleve «pantalla» entre sus alias.
 */
export function tipoCanonico(tipo: TipoConocido, tipos: Map<string, TipoConocido>): string {
  const vivo = tipoVivo(tipo, tipos)
  const porNombre = canonicoDe(vivo.name)
  if (porNombre) return porNombre
  // El nombre del absorbido cuenta: «Ordenador Tiny» fundido en un tipo que
  // alguien renombró a «PC del aula» sigue siendo el ordenador de la columna.
  for (const candidato of [tipo.name, ...(vivo.aliases ?? []), ...(tipo.aliases ?? [])]) {
    const c = canonicoDe(candidato)
    if (c) return c
  }
  return vivo.name
}

/**
 * ¿Dos nombres hablan del mismo aparato?
 *
 * Iguales sin tildes ni mayúsculas, o los dos responden a la misma columna del
 * libro por sinónimo. Es lo que sustituye al `norm(a) === norm(b)` que dejaba
 * al Tiny fuera.
 */
export function mismoTipo(a: string, b: string): boolean {
  const na = normTipo(a)
  const nb = normTipo(b)
  if (na === '' || nb === '') return false
  if (na === nb) return true
  const ca = canonicoDe(a)
  const cb = canonicoDe(b)
  return ca !== null && ca === cb
}
