/**
 * El corte de año: las dos hojas que hacen falta cuando cambia el calendario.
 *
 * El libro tiene una hoja de partes y una de bolsa **por año**, y hasta ahora
 * las creaba una persona en enero copiando las del año anterior a mano. Eso
 * funciona hasta el año que a nadie se le ocurre, y entonces los partes de enero
 * se apuntan en la hoja del año pasado —que es justo lo que ya ha pasado: la
 * hoja de 2026 lleva dos partes de enero de 2025 y la de 2025 uno de 2005—.
 *
 * Aquí se crean solas, y con tres cuidados que no son evidentes:
 *
 * **Se copia la forma, no el contenido.** La hoja de partes nueva sale con su
 * cabecera y vacía. Arrastrar los partes del año anterior sería duplicarlos: ya
 * están en su hoja, que es donde van.
 *
 * **La bolsa arrastra el saldo, no el consumo.** Los doce meses nacen vacíos —el
 * año no ha consumido nada todavía— y `Total Comprado` nace con **lo que quedaba
 * en el almacén al cerrar**, porque en esta hoja `Stock Disponible` es
 * `Comprado − Instalado` y el material que sobró del año pasado sigue estando en
 * la estantería. Si naciera a cero, cada primero de enero el almacén parecería
 * vacío y `Stock Disponible` saldría en negativo en cuanto se gastara la primera
 * unidad.
 *
 * **El saldo lo dice la aplicación, no la fórmula de la hoja anterior.** Leer el
 * `Stock Disponible` de la hoja vieja significaría fiarse del **valor cacheado**
 * de una fórmula, que es lo que el fichero lleva guardado de la última vez que
 * alguien lo abrió con Excel — y en tres filas de este libro ese valor ya está
 * mal porque alguien escribió un número encima. El saldo sale de sumar los
 * movimientos, que es donde vive de verdad.
 *
 * Y una cosa que **no** hace: tocar las hojas del año que se cierra. Quedan como
 * están, con su IVA calculado y sus cuentas rendidas.
 */

import { BOLSA_2026, MATERIAL_2026, hojasDelAnyo } from './mapa'
import type { Hoja } from './mapa'
import type { HojaNueva } from './libro'
import type { ValorCelda } from './xlsx'

export interface ArticuloAlCierre {
  nombre: string
  /** La segunda grafía, si el libro la traía. Se arrastra para no perder el alias. */
  nombreAlternativo: string | null
  /** Lo que queda en el almacén al cerrar el año. Puede ser cero; negativo no. */
  saldo: number
}

export interface CorteDeAnyo {
  anyo: number
  hojas: HojaNueva[]
  /** Qué se ha hecho, para contarlo en el parte de la pasada. */
  avisos: string[]
}

/**
 * Las hojas que faltan para el año en curso.
 *
 * Devuelve la lista vacía si ya están: repetir la sincronización el 2 de enero
 * no puede crear una segunda `Bolsa 2027`.
 */
export function corteDeAnyo(opciones: {
  anyo: number
  /** Los nombres de las hojas que el libro ya tiene. */
  hojasExistentes: string[]
  articulos: ArticuloAlCierre[]
}): CorteDeAnyo {
  const { anyo, hojasExistentes, articulos } = opciones
  const nombres = hojasDelAnyo(anyo)
  const hojas: HojaNueva[] = []
  const avisos: string[] = []
  const existe = new Set(hojasExistentes)

  if (!existe.has(nombres.material)) {
    hojas.push(hojaDePartesVacia(nombres.material, MATERIAL_2026))
    avisos.push(`Se crea «${nombres.material}»: el año nuevo necesita su hoja de partes.`)
  }

  if (!existe.has(nombres.bolsa)) {
    hojas.push(hojaDeBolsaNueva(nombres.bolsa, BOLSA_2026, articulos))
    const conSaldo = articulos.filter((a) => a.saldo > 0).length
    avisos.push(
      `Se crea «${nombres.bolsa}» con ${articulos.length} artículos; ${conSaldo} arrastran el saldo del cierre anterior.`,
    )
  }

  return { anyo, hojas, avisos }
}

/**
 * La hoja de partes del año, con su cabecera y nada más.
 *
 * Toma las columnas del modelo del año en curso, no las del año que se cierra:
 * la de 2025 lleva una columna `Observación` que se quitó, y arrastrarla sería
 * resucitarla.
 */
function hojaDePartesVacia(nombre: string, modelo: Hoja): HojaNueva {
  return {
    nombre,
    filas: [modelo.columnas.map((c) => c.cabecera as ValorCelda)],
    anchos: [16, 11, 13, 17, 52, 52, 34],
    formatos: modelo.columnas.map((c) => (c.tipo === 'fecha' ? ('fecha' as const) : undefined)),
  }
}

/**
 * La bolsa del año, con un artículo por fila y sus fórmulas puestas.
 *
 * Las fórmulas se escriben desde el mapa y no copiando las de la hoja anterior:
 * copiarlas arrastraría también el `=P34-N34` de la fila 35, que apunta a la
 * fila de al lado desde vaya usted a saber cuándo.
 */
function hojaDeBolsaNueva(nombre: string, modelo: Hoja, articulos: ArticuloAlCierre[]): HojaNueva {
  const filas: ValorCelda[][] = [modelo.columnas.map((c) => c.cabecera as ValorCelda)]

  const ordenados = [...articulos].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))

  for (const [i, art] of ordenados.entries()) {
    const numeroDeFila = i + 2
    filas.push(
      modelo.columnas.map((c) => {
        if (c.dueno === 'formula' && c.formula) return c.formula.replace(/\{f\}/g, String(numeroDeFila))
        switch (c.campo) {
          case 'articulo.nombre':
            return art.nombre
          case 'articulo.nombreAlternativo':
            return art.nombreAlternativo ?? art.nombre
          case 'articulo.comprado':
            // Lo que quedaba en la estantería es lo que hay disponible el día 1.
            return Math.max(0, art.saldo)
          default:
            // Los doce meses nacen vacíos: el año no ha consumido nada todavía.
            return null
        }
      }),
    )
  }

  return {
    nombre,
    filas,
    anchos: [42, ...new Array(12).fill(9), 14, 15, 15, 42],
    autofiltro: true,
  }
}

/**
 * El año que le toca a una fecha, para saber en qué hoja va un parte.
 *
 * Existe para no volver a repetir el fallo que trae el libro: dos partes de
 * enero de 2025 apuntados en la hoja de 2026 porque se abrieron con la hoja del
 * año en curso delante. El año lo dice la fecha del parte, no la pestaña en la
 * que estuviera mirando quien lo escribió.
 */
export function anyoDelParte(fecha: string | null): number | null {
  if (!fecha) return null
  const d = new Date(fecha.length === 10 ? `${fecha}T00:00:00Z` : fecha)
  return Number.isNaN(d.getTime()) ? null : d.getUTCFullYear()
}

/** Los partes que están en la hoja de otro año. Se cuentan, no se mueven. */
export function partesFueraDeSuAnyo(
  hoja: string,
  partes: Array<{ fila: number; numero: string; abierta: string | null }>,
): Array<{ fila: number; numero: string; anyo: number }> {
  const suyo = /(\d{4})\s*$/.exec(hoja)
  if (!suyo) return []
  const anyoDeLaHoja = Number(suyo[1])

  const fuera: Array<{ fila: number; numero: string; anyo: number }> = []
  for (const p of partes) {
    const anyo = anyoDelParte(p.abierta)
    if (anyo !== null && anyo !== anyoDeLaHoja) {
      fuera.push({ fila: p.fila, numero: p.numero, anyo })
    }
  }
  return fuera
}
