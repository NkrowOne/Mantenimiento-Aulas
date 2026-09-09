/**
 * Traducir entre lo que hay en una celda y lo que cabe en la base.
 *
 * Suena a fontanería y es donde se decide si la sincronización es segura. Este
 * libro lleva años de manos distintas y en las columnas numéricas hay de todo:
 * `********` en 25 celdas de horas y de porcentaje, espacios duros que parecen
 * vacíos y no lo son, un `3356` en la columna de fecha que es un número de horas
 * de la de al lado, y tres fechas que no son fechas (`285-11-25`, `19/0672025`,
 * `26/11//24`).
 *
 * La tentación es interpretarlas: un `********` a cero, una fecha rota a la más
 * parecida. Es exactamente lo que no hay que hacer. **Un cero es un dato**, y una
 * lámpara al 0 % dispara una alerta que manda a alguien a un aula que está
 * perfectamente; una fecha adivinada mal reordena el historial de revisiones. Así
 * que aquí nada se adivina: lo que no se puede leer con seguridad se dice que no
 * se puede leer, y quien lo recibe lo manda a cuarentena.
 *
 * Al revés —de la base a la celda— sí hay una decisión de forma que conviene
 * dejar escrita: **se escribe con el formato de la columna, no con el del dato**.
 * Las fechas van como número de serie de Excel porque la columna ya lleva su
 * formato de fecha; el porcentaje va como `0,86` porque la columna lleva `0%` y
 * escribir `86` la convertiría en un 8.600 %. La celda ya sabe cómo enseñarse:
 * escribirle el texto ya formateado es lo que la rompe.
 *
 * Y una regla que no es de formato sino de respeto: **al escribir un `SÍ` no se
 * corrige la grafía de quien puso `si`**. La comparación de `fusion.ts` ya los da
 * por iguales, así que la celda no se toca. Si se «normalizaran», la primera
 * pasada reescribiría 160 celdas que nadie había cambiado, y el historial de
 * versiones de SharePoint sería inútil a partir de ese día.
 */

// -----------------------------------------------------------------------------
// Fechas
// -----------------------------------------------------------------------------

/**
 * El día 0 de Excel.
 *
 * Es el 30 de diciembre de 1899 y no el 31, porque Excel cree que 1900 fue
 * bisiesto —lo copió de Lotus 1-2-3 y ya no lo puede arreglar sin romper todas
 * las hojas del mundo—. Restar un día aquí es lo que hace que las fechas del
 * libro y las de la base sean el mismo día.
 */
const EPOCA = Date.UTC(1899, 11, 30)
const DIA = 86_400_000

/** `2025-06-23` → `45831`. Solo la fecha: la hora no cabe en estas columnas. */
export function fechaAExcel(iso: string): number | null {
  const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
  if (Number.isNaN(t)) return null
  // Se toma el día en la zona del usuario, no en UTC: una revisión de las 00:30
  // de Madrid es del día 23, y en UTC sería del 22.
  const d = new Date(t)
  const dia = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  return Math.round((dia - EPOCA) / DIA)
}

/** `45831` → `2025-06-23`. */
export function excelAFecha(serie: number): string | null {
  if (!Number.isFinite(serie)) return null
  // Antes de 1970 y después de 2200 no hay fechas legítimas en este libro: son
  // números de otra columna que alguien pegó donde no era.
  if (serie < 25_569 || serie > 109_575) return null
  const d = new Date(EPOCA + Math.round(serie) * DIA)
  return d.toISOString().slice(0, 10)
}

// -----------------------------------------------------------------------------
// Leer una celda
// -----------------------------------------------------------------------------

export type Valor = string | number | boolean | null

export type Lectura =
  | { ok: true; valor: Valor }
  /** No se puede leer con seguridad. Va a cuarentena, no a un valor por defecto. */
  | { ok: false; motivo: string; crudo: Valor }

/** Vacío de verdad: `null`, `''`, espacios normales y el espacio duro. */
export function esVacio(v: Valor): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'string') return limpiar(v) === ''
  return false
}

/** Quita espacios duros, tabuladores y espacios de los extremos. */
export function limpiar(s: string): string {
  return s.replace(/[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Los rellenos que la gente usa para decir «aquí no hay nada» o «esto no lo sé»:
 * una tira de asteriscos, un guion suelto. No son datos y tampoco son basura que
 * haya que denunciar en cada pasada: son un vacío escrito a mano.
 */
function esRelleno(s: string): boolean {
  const t = limpiar(s)
  return t !== '' && /^[*\-–—?.]+$/.test(t)
}

export function leer(valor: Valor, tipo: string): Lectura {
  if (esVacio(valor)) return { ok: true, valor: null }

  const texto = typeof valor === 'string' ? limpiar(valor) : valor
  if (typeof texto === 'string' && esRelleno(texto)) return { ok: true, valor: null }

  switch (tipo) {
    case 'texto':
      return { ok: true, valor: typeof texto === 'number' ? String(texto) : texto }

    case 'numero': {
      if (typeof texto === 'number') return { ok: true, valor: texto }
      const n = aNumero(String(texto))
      return n === null
        ? { ok: false, motivo: `«${texto}» no es un número`, crudo: valor }
        : { ok: true, valor: n }
    }

    case 'porcentaje': {
      const n = typeof texto === 'number' ? texto : aNumero(String(texto))
      if (n === null) return { ok: false, motivo: `«${texto}» no es un porcentaje`, crudo: valor }
      // La columna guarda la fracción (`0,86` = 86 %). Un número mayor que 1 es
      // que alguien escribió `86` en una celda con formato de porcentaje, y eso
      // en la hoja se ve como 8.600 %: no se corrige a la brava, se pregunta.
      if (n < 0 || n > 1) {
        return { ok: false, motivo: `${n} no está entre 0 y 1: ¿es ${n} % o ${n * 100} %?`, crudo: valor }
      }
      return { ok: true, valor: n }
    }

    case 'fecha': {
      if (typeof texto === 'number') {
        const iso = excelAFecha(texto)
        return iso === null
          ? { ok: false, motivo: `${texto} no es una fecha`, crudo: valor }
          : { ok: true, valor: iso }
      }
      const iso = fechaDeTexto(String(texto))
      return iso === null
        ? { ok: false, motivo: `«${texto}» no es una fecha que se pueda leer`, crudo: valor }
        : { ok: true, valor: iso }
    }

    case 'si_no': {
      const b = aSiNo(String(texto))
      return b === null
        ? { ok: false, motivo: `«${texto}» no es un sí ni un no`, crudo: valor }
        : { ok: true, valor: b }
    }

    default:
      return { ok: true, valor: texto }
  }
}

/** `1.234,56` y `1234.56` son el mismo número; `12 3` no es ninguno. */
function aNumero(s: string): number | null {
  const t = limpiar(s).replace(/\s/g, '')
  if (t === '') return null
  // Formato español: el punto agrupa millares y la coma decide los decimales.
  const normalizado = /,\d{1,3}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')
  if (!/^-?\d+(\.\d+)?$/.test(normalizado)) return null
  const n = Number(normalizado)
  return Number.isFinite(n) ? n : null
}

/**
 * Una fecha escrita a mano, solo cuando no hay duda posible.
 *
 * `23/06/2025` sí. `19/0672025` no —falta una barra y sobra un dígito, y las dos
 * lecturas plausibles dan meses distintos—. `26/11//24` tampoco. Y `03/04/2025`
 * es ambigua en cuanto alguien la escribe pensando en inglés, así que se lee en
 * el orden español y punto: es el libro de una universidad española.
 */
export function fechaDeTexto(s: string): string | null {
  const t = limpiar(s)
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  if (iso) return valida(Number(iso[1]), Number(iso[2]), Number(iso[3]))

  const es = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(t)
  if (!es) return null
  const anyo = Number(es[3])
  return valida(anyo < 100 ? 2000 + anyo : anyo, Number(es[2]), Number(es[1]))
}

function valida(anyo: number, mes: number, dia: number): string | null {
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null
  if (anyo < 1990 || anyo > 2100) return null
  const d = new Date(Date.UTC(anyo, mes - 1, dia))
  if (d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null
  return d.toISOString().slice(0, 10)
}

/** Las doce grafías de sí y de no que trae el libro. */
export function aSiNo(s: string): boolean | null {
  const t = limpiar(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
  if (t === 'SI' || t === 'S' || t === 'X' || t === 'TRUE' || t === 'VERDADERO') return true
  if (t === 'NO' || t === 'N' || t === 'FALSE' || t === 'FALSO') return false
  return null
}

// -----------------------------------------------------------------------------
// Escribir una celda
// -----------------------------------------------------------------------------

/**
 * Lo que hay que poner en la celda para que diga `valor`.
 *
 * `null` significa **no tocar la celda**, que es distinto de vaciarla: para
 * vaciarla hay que pedir `''` a propósito. Esa diferencia es lo que impide que un
 * dato que la app todavía no tiene borre el que lleva años en la hoja.
 */
export function escribir(valor: Valor, tipo: string): Valor {
  if (valor === null || valor === undefined) return null

  switch (tipo) {
    case 'fecha':
      return typeof valor === 'string' ? fechaAExcel(valor) : valor

    case 'si_no':
      // En mayúsculas y sin tilde: es la grafía más repetida del libro, y
      // `fusion.ts` da por iguales las otras once, así que no reescribe nada.
      return typeof valor === 'boolean' ? (valor ? 'SI' : 'NO') : valor

    case 'porcentaje':
    case 'numero':
      return typeof valor === 'number' ? valor : valor

    default:
      return valor
  }
}

// -----------------------------------------------------------------------------
// La columna del micrófono, que son dos
// -----------------------------------------------------------------------------

export interface Microfono {
  /** Lo que dice de si hay micrófono, si es que lo dice. */
  hay: boolean | null
  /** El número de serie, si lo que hay escrito es uno. */
  serial: string | null
  /** Un modelo escrito a mano: `Sennheiser`, `Sony Microfono`. */
  modelo: string | null
}

/**
 * Leer la columna `Microfono Jabra`, que lleva tres cosas distintas.
 *
 * El orden de las comprobaciones importa: un `SI` también es texto, así que el sí
 * y el no van primero. Lo que queda se parte en dos por una regla sencilla y
 * comprobable contra el libro: **un número de serie tiene dígitos**. Los 37 de
 * esta columna son `294150186` y parecidos; los cuatro modelos escritos a mano
 * —`Sennheiser`, `Sony Microfono`— no llevan ni uno.
 */
export function leerMicrofono(valor: Valor): Microfono {
  if (esVacio(valor)) return { hay: null, serial: null, modelo: null }

  if (typeof valor === 'number') {
    return { hay: true, serial: String(valor), modelo: null }
  }
  const t = limpiar(String(valor))
  if (esRelleno(t)) return { hay: null, serial: null, modelo: null }

  const si = aSiNo(t)
  if (si !== null) return { hay: si, serial: null, modelo: null }

  if (/\d/.test(t)) return { hay: true, serial: t, modelo: null }
  return { hay: true, serial: null, modelo: t }
}

/**
 * Y escribirla. El número de serie manda sobre el sí, porque dice las dos cosas:
 * si hay serie, hay micrófono.
 */
export function escribirMicrofono(m: Microfono): Valor {
  if (m.serial) return m.serial
  if (m.modelo) return m.modelo
  if (m.hay === null) return null
  return m.hay ? 'SI' : 'NO'
}

// -----------------------------------------------------------------------------
// El material consumido, que viene escrito en un renglón
// -----------------------------------------------------------------------------

export interface MaterialLeido {
  cantidad: number
  articulo: string
  /** El renglón entero, para poder guardarlo si el artículo no se resuelve. */
  crudo: string
}

/**
 * Partir `2 Cable Hdmi 10mts Fibra` en un 2 y un artículo.
 *
 * Y `1Pantalla 240X240` también, que es el mismo caso sin el espacio — pasa 30
 * veces en la hoja de 2025. La cantidad es lo primero que hay, si es un número
 * suelto; si no hay número, es una unidad: `1 raton` y `raton` dicen lo mismo.
 *
 * Un renglón puede llevar varios artículos separados por coma o por `+`. Lo que
 * no se pueda partir se devuelve entero como `crudo`, y quien lo reciba lo
 * guarda en `incident_materials.raw_text` en vez de inventarse una cantidad.
 */
export function leerMaterial(texto: string): MaterialLeido[] {
  const t = limpiar(texto)
  if (t === '') return []

  return t
    .split(/\s*[,+]\s*(?=\d|[A-Za-zÁÉÍÓÚÜÑáéíóúüñ])/)
    .map((trozo) => trozo.trim())
    .filter((trozo) => trozo !== '')
    .map((trozo) => {
      // `2 Cable…`, `2Cable…`, `1 mts canaleta…`. El número pegado a la palabra
      // solo cuenta si lo que sigue empieza por letra: `240X240` no es cantidad.
      const m = /^(\d+)\s*(?=[A-Za-zÁÉÍÓÚÜÑáéíóúüñ])(.*)$/.exec(trozo)
      if (!m) return { cantidad: 1, articulo: trozo, crudo: trozo }
      const resto = limpiar(m[2]!)
      if (resto === '') return { cantidad: 1, articulo: trozo, crudo: trozo }
      return { cantidad: Number(m[1]), articulo: resto, crudo: trozo }
    })
}

/** Y volver a escribirlo como lo escribe la gente: `2 Cable HDMI fibra 10 m`. */
export function escribirMaterial(materiales: MaterialLeido[]): string {
  return materiales.map((m) => `${m.cantidad} ${m.articulo}`).join(', ')
}
