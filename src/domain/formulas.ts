/**
 * Cuánto vale de verdad una celda de fórmula, calculado con los números de la
 * propia hoja en vez de con el valor que el fichero trae guardado.
 *
 * Un `.xlsx` guarda cada fórmula dos veces: la fórmula (`<f>P8-N8</f>`) y **el
 * último resultado que alguien calculó** (`<v>19</v>`). Quien abre el libro con
 * Excel no nota la diferencia porque Excel recalcula; quien lo lee como fichero
 * —esta aplicación— se lleva el número guardado tal cual.
 *
 * Y ese número **se queda viejo en cuanto la aplicación escribe una celda de las
 * que la fórmula depende**, porque calcular fórmulas no es algo que se pueda
 * hacer aquí: el libro se marca con `fullCalcOnLoad` para que Excel las rehaga
 * al abrirlo, y hasta entonces el `<v>` miente. En el libro de hoy mienten 32 de
 * las 51 filas de la bolsa: `O8` trae guardado un 19 cuando `P8−N8` es 54−9=45.
 *
 * Eso no ensucia el Excel —una columna de fórmula no se escribe nunca— pero sí
 * al revés: «Stock Disponible» es la celda con la que, cuando manda el Excel, el
 * almacén se cuadra con un movimiento de ajuste. Cuadrarlo contra un 19 en vez
 * de contra un 45 borra veintiséis cables del almacén sin que salte nada.
 *
 * Así que la fórmula se calcula. Solo la aritmética que este libro usa de
 * verdad —`+ - * /`, paréntesis, `SUM` con rangos— y con una regla firme: **lo
 * que no se entienda devuelve `null`**, y quien pregunta se queda con el valor
 * guardado, que es exactamente lo que había antes. Inventarse el resultado de
 * una fórmula que no se sabe leer sería peor que leer uno viejo.
 */

import type { FilaLeida, ValorCelda } from './xlsx'

/** Una celda de fórmula cuyo valor guardado no era el que da la fórmula. */
export interface Correccion {
  /** `O8`. */
  ref: string
  /** Lo que traía el fichero. */
  cacheado: ValorCelda
  /** Lo que da la fórmula con los números de la hoja. */
  real: number
}

/** La hoja indexada por número de fila, que es como se buscan las referencias. */
export type Hoja = Map<number, FilaLeida>

/** `A8` → `{ columna: 'A', fila: 8 }`. Tolera los `$` de una referencia fija. */
function partir(ref: string): { columna: string; fila: number } | null {
  const m = /^\$?([A-Z]+)\$?(\d+)$/.exec(ref.toUpperCase())
  return m ? { columna: m[1]!, fila: Number(m[2]) } : null
}

/** `A` → 1, `AA` → 27. Hace falta para recorrer un rango `B8:M8`. */
function numeroDeColumna(letras: string): number {
  let n = 0
  for (const c of letras) n = n * 26 + (c.charCodeAt(0) - 64)
  return n
}

/** 1 → `A`, 27 → `AA`. */
function letraDeColumna(n: number): string {
  let s = ''
  let x = n
  while (x > 0) {
    const r = (x - 1) % 26
    s = String.fromCharCode(65 + r) + s
    x = Math.floor((x - 1) / 26)
  }
  return s
}

/** Las referencias que cubre un rango, en orden. Solo rectángulos normales. */
function celdasDelRango(desde: string, hasta: string): string[] | null {
  const a = partir(desde)
  const b = partir(hasta)
  if (!a || !b) return null
  const c1 = Math.min(numeroDeColumna(a.columna), numeroDeColumna(b.columna))
  const c2 = Math.max(numeroDeColumna(a.columna), numeroDeColumna(b.columna))
  const f1 = Math.min(a.fila, b.fila)
  const f2 = Math.max(a.fila, b.fila)
  // Un rango enorme sería una hoja entera (`A:A` no llega aquí, pero `A1:A99999`
  // sí): calcularlo celda a celda tardaría más que la pasada completa.
  if ((c2 - c1 + 1) * (f2 - f1 + 1) > 10_000) return null
  const out: string[] = []
  for (let f = f1; f <= f2; f++) for (let c = c1; c <= c2; c++) out.push(`${letraDeColumna(c)}${f}`)
  return out
}

/**
 * Lo que aporta una celda a una cuenta.
 *
 * `null` es «no sé»: la celda tiene texto, o una fórmula que no se sabe leer.
 * Una celda **vacía vale 0**, que es lo que hace Excel: los doce meses en blanco
 * de la bolsa son doce ceros, no doce incógnitas.
 */
function valorDe(ref: string, hoja: Hoja, visitadas: Set<string>): number | null {
  const p = partir(ref)
  if (!p) return null
  const fila = hoja.get(p.fila)
  if (!fila) return 0

  const formula = fila.formulas?.[p.columna]
  if (formula !== undefined && formula !== '') {
    // Una fórmula que se llama a sí misma no se resuelve: Excel lo llama
    // referencia circular y aquí sería un bucle infinito.
    if (visitadas.has(ref)) return null
    visitadas.add(ref)
    const v = calcularTexto(formula, hoja, visitadas)
    visitadas.delete(ref)
    return v
  }

  const v = fila.celdas[p.columna]
  if (v === undefined || v === null || v === '') return 0
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  // Un texto que es un número («12») cuenta; uno que no, no se adivina.
  const n = Number(String(v).replace(',', '.'))
  return String(v).trim() !== '' && Number.isFinite(n) ? n : null
}

/**
 * El analizador. Descenso recursivo sobre la gramática que este libro usa:
 *
 *     expresion := termino (('+' | '-') termino)*
 *     termino   := unario (('*' | '/') unario)*
 *     unario    := ('-' | '+') unario | atomo
 *     atomo     := numero | '(' expresion ')' | 'SUM' '(' args ')' | referencia
 *
 * Cualquier otra cosa —una función que no sea `SUM`, una comparación, otra
 * hoja— para el análisis y devuelve `null`.
 */
function calcularTexto(texto: string, hoja: Hoja, visitadas: Set<string>): number | null {
  const src = texto.trim().replace(/^=/, '')
  let i = 0

  const espacios = (): void => {
    while (i < src.length && /\s/.test(src[i]!)) i++
  }

  const expresion = (): number | null => {
    let izq = termino()
    if (izq === null) return null
    for (;;) {
      espacios()
      const op = src[i]
      if (op !== '+' && op !== '-') return izq
      i++
      const der = termino()
      if (der === null) return null
      izq = op === '+' ? izq + der : izq - der
    }
  }

  const termino = (): number | null => {
    let izq = unario()
    if (izq === null) return null
    for (;;) {
      espacios()
      const op = src[i]
      if (op !== '*' && op !== '/') return izq
      i++
      const der = unario()
      if (der === null) return null
      // Dividir entre cero es `#DIV/0!` en la hoja, no un infinito aquí.
      if (op === '/' && der === 0) return null
      izq = op === '*' ? izq * der : izq / der
    }
  }

  const unario = (): number | null => {
    espacios()
    const signo = src[i]
    if (signo === '-' || signo === '+') {
      i++
      const v = unario()
      return v === null ? null : signo === '-' ? -v : v
    }
    return atomo()
  }

  const atomo = (): number | null => {
    espacios()
    if (src[i] === '(') {
      i++
      const v = expresion()
      espacios()
      if (src[i] !== ')') return null
      i++
      return v
    }

    const num = /^\d+(\.\d+)?/.exec(src.slice(i))
    if (num) {
      i += num[0].length
      return Number(num[0])
    }

    // `SUM(...)`. Va antes que la referencia porque `SUM` empieza por letras.
    const fn = /^([A-Za-z_][A-Za-z0-9_.]*)\s*\(/.exec(src.slice(i))
    if (fn) {
      if (fn[1]!.toUpperCase() !== 'SUM') return null
      i += fn[0].length
      return suma()
    }

    const ref = /^\$?[A-Z]+\$?\d+/.exec(src.slice(i))
    if (ref) {
      i += ref[0].length
      // Un rango suelto —`B8:M8` sin `SUM`— no es un número.
      espacios()
      if (src[i] === ':') return null
      return valorDe(ref[0], hoja, visitadas)
    }

    return null
  }

  /** Los argumentos de un `SUM` ya abierto, hasta su paréntesis de cierre. */
  const suma = (): number | null => {
    let total = 0
    for (;;) {
      espacios()
      const rango = /^(\$?[A-Z]+\$?\d+)\s*:\s*(\$?[A-Z]+\$?\d+)/.exec(src.slice(i))
      if (rango) {
        i += rango[0].length
        const celdas = celdasDelRango(rango[1]!, rango[2]!)
        if (!celdas) return null
        for (const c of celdas) {
          const v = valorDe(c, hoja, visitadas)
          // `SUM` **se salta el texto**, no falla: es lo que hace Excel y es la
          // diferencia entre sumar una columna con una cabecera dentro o no.
          if (v !== null) total += v
        }
      } else {
        const v = expresion()
        if (v === null) return null
        total += v
      }
      espacios()
      if (src[i] === ',' || src[i] === ';') {
        i++
        continue
      }
      if (src[i] !== ')') return null
      i++
      return total
    }
  }

  const v = expresion()
  espacios()
  // Sobran caracteres: se ha entendido media fórmula, que es peor que ninguna.
  return i === src.length ? v : null
}

/** Lo que vale la celda `ref` según la hoja, o `null` si no se sabe calcular. */
export function calcular(ref: string, hoja: Hoja): number | null {
  return valorDe(ref, hoja, new Set())
}

/**
 * Las filas con cada celda de fórmula puesta al día.
 *
 * Devuelve filas nuevas —no toca las que entran— y la lista de las que traían un
 * valor guardado distinto, para poder decirlo en el parte. Las fórmulas se dejan
 * intactas: lo que cambia es el **valor** que se lee de esa celda, no la celda.
 */
export function conFormulasAlDia(filas: FilaLeida[]): {
  filas: FilaLeida[]
  corregidas: Correccion[]
} {
  const hoja: Hoja = new Map(filas.map((f) => [f.fila, f]))
  const corregidas: Correccion[] = []
  const salida = filas.map((f) => {
    const conFormula = Object.keys(f.formulas ?? {})
    if (conFormula.length === 0) return f

    let celdas: Record<string, ValorCelda> | null = null
    for (const columna of conFormula) {
      const ref = `${columna}${f.fila}`
      const real = calcular(ref, hoja)
      if (real === null) continue
      const cacheado = f.celdas[columna] ?? null
      if (cacheado === real) continue
      corregidas.push({ ref, cacheado, real })
      celdas ??= { ...f.celdas }
      celdas[columna] = real
    }
    return celdas ? { ...f, celdas } : f
  })

  return { filas: salida, corregidas }
}
