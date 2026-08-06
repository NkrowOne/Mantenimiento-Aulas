import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * La frontera entre la vista `inventory_sheet` y el tipo `FilaDeInventario`.
 *
 * La pantalla pide `select('*')` y castea el resultado a `FilaDeInventario` sin
 * mapear nada, que es justo lo que hace que una columna nueva no se pueda
 * olvidar por el camino — y también lo que deja este hueco: **el compilador no
 * mira la vista**. Renombrar `baja_motivo` en el SQL, o añadir una columna al
 * tipo y no a la vista, compila, pasa todas las pruebas, se despliega, y lo que
 * ocurre es que una columna de la hoja sale entera en blanco en producción.
 * Nadie lo nota hasta que alguien archiva un papel que dice que no consta el
 * motivo de ninguna baja.
 *
 * Es exactamente el fallo que ninguna de las dos mitades puede ver sola, así
 * que se comprueba desde fuera: se leen los dos ficheros y se comparan las
 * listas de columnas, en orden. El precedente es `sw.rescate.test.ts`, que lee
 * el fuente del rescate por el mismo motivo — es código que no se puede
 * importar y que aun así no puede fallar.
 */

const RAIZ = path.resolve(__dirname, '../../..')

const fuenteSql = readFileSync(
  path.join(RAIZ, 'supabase/migrations/20260806000200_hoja_de_inventario.sql'),
  'utf8',
)
const fuenteTs = readFileSync(path.join(RAIZ, 'src/features/inventory/hoja.ts'), 'utf8')

/** Corta la lista de columnas por las comas de primer nivel: las de dentro de
    un `coalesce(...)` o de un `exists (...)` no separan columnas. */
function porComasDeFuera(lista: string): string[] {
  const trozos: string[] = []
  let hondura = 0
  let actual = ''
  for (const c of lista) {
    if (c === '(') hondura += 1
    else if (c === ')') hondura -= 1
    if (c === ',' && hondura === 0) {
      trozos.push(actual)
      actual = ''
    } else actual += c
  }
  if (actual.trim() !== '') trozos.push(actual)
  return trozos
}

/** Cómo se va a llamar esta columna al salir de la vista: el alias si lo lleva,
    y si no, el nombre de la columna sin la tabla delante. */
function nombreDeSalida(expresion: string): string {
  const limpio = expresion.trim()
  const alias = /\bas\s+([a-z_][a-z0-9_]*)$/i.exec(limpio)
  if (alias?.[1]) return alias[1]
  const suelto = /([a-z_][a-z0-9_]*)$/i.exec(limpio)
  if (!suelto?.[1]) throw new Error(`No se entiende la columna: ${limpio}`)
  return suelto[1]
}

/** Las expresiones del `select` de la vista, una por columna publicada. */
function expresionesDeLaVista(): string[] {
  // Los comentarios se van primero: llevan comas y paréntesis dentro y
  // romperían el corte de arriba.
  const sinComentarios = fuenteSql.replace(/--[^\n]*/g, '')
  const cuerpo =
    /create or replace view public\.inventory_sheet as\s*select\b([\s\S]*?)\nfrom assets a\b/i.exec(
      sinComentarios,
    )
  if (!cuerpo?.[1]) throw new Error('No se encuentra el select de public.inventory_sheet')
  return porComasDeFuera(cuerpo[1])
}

/** Las columnas que la vista publica, en el orden en que las publica. */
function columnasDeLaVista(): string[] {
  return expresionesDeLaVista().map(nombreDeSalida)
}

/** Con qué produce la vista una columna concreta, en una sola línea. */
function expresionDe(columna: string): string {
  const encontrada = expresionesDeLaVista().find((e) => nombreDeSalida(e) === columna)
  if (encontrada === undefined) throw new Error(`La vista no publica ${columna}`)
  return encontrada.trim().replace(/\s+/g, ' ')
}

/** Los campos de `FilaDeInventario`, en el orden en que están declarados. */
function camposDeLaFila(): string[] {
  const cuerpo = /export interface FilaDeInventario \{([\s\S]*?)\n\}/.exec(fuenteTs)
  if (!cuerpo?.[1]) throw new Error('No se encuentra la interfaz FilaDeInventario')
  const sinDoc = cuerpo[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  return [...sinDoc.matchAll(/^\s*([a-z_][a-z0-9_]*)\??:/gim)].map((m) => m[1] as string)
}

describe('el contrato de la hoja: la vista SQL y FilaDeInventario', () => {
  it('publica las 26 columnas del contrato, ni una más', () => {
    expect(columnasDeLaVista()).toHaveLength(26)
    expect(camposDeLaFila()).toHaveLength(26)
  })

  it('las nombra igual y en el mismo orden a los dos lados', () => {
    expect(columnasDeLaVista()).toEqual(camposDeLaFila())
  })

  it('lleva las cuatro columnas que costaron una migración', () => {
    // `brand` y `cambio_at` son las dos columnas nuevas de `assets`; `baja_at` y
    // `retirada_pedida`, lo que la pantalla no puede deducir sola. Se nombran
    // aquí sueltas para que el día que alguien las quite de la vista, el fallo
    // diga cuál falta en vez de solo «las listas no coinciden».
    for (const columna of ['brand', 'cambio_at', 'baja_at', 'retirada_pedida']) {
      expect(columnasDeLaVista()).toContain(columna)
    }
  })
})

/**
 * El hueco de la columna «Último cambio», que se produce en el servidor.
 *
 * `FilaDeLaHoja` deja esa celda vacía cuando `cambio_at` llega nulo, y lo
 * explica: «desde que se apuntó, no consta que nadie lo tocara». Quien tiene que
 * producir ese nulo es la vista, porque `assets.updated_at` es `not null` y nace
 * igualada a `created_at` —el relleno de la migración para las 1.094 filas del
 * parque, y los dos `default now()` del mismo INSERT para un alta nueva—. Con la
 * columna publicada cruda, la hoja imprimía «Modificado» en TODAS las líneas y
 * con la misma fecha que la columna «Alta»: una afirmación falsa sobre equipos
 * que nadie ha tocado, en un papel que se firma y se archiva, y con la rama del
 * hueco convertida en código inalcanzable.
 *
 * Se comprueba aquí y no en `hoja.test.ts` por lo mismo que las columnas: es una
 * frontera que el compilador no mira y que ninguna de las dos mitades puede ver
 * sola — las pruebas de datos fabrican sus filas con `cambio_at: null`, que es
 * justo lo que el servidor había dejado de mandar.
 */
describe('el contrato de la hoja: la fecha de cambio la produce el servidor', () => {
  it('publica cambio_at solo cuando la fecha va por delante del alta', () => {
    expect(expresionDe('cambio_at')).toMatch(
      /case when a\.updated_at > a\.created_at then a\.updated_at end/i,
    )
  })

  it('y el disparador cubre también el alta, para que la fecha no la ponga el cliente', () => {
    // `default now()` se salta en cuanto la columna viene en la petición, y
    // PostgREST manda al INSERT lo que traiga el cuerpo. Sin el `insert` en el
    // disparador, un alta hecha a mano con el token de un técnico dejaba una
    // fecha de cambio inventada, y el hueco de arriba dejaba de significar nada.
    expect(fuenteSql).toMatch(
      /create trigger assets_updated_at\s+before insert or update on assets\b/i,
    )
  })
})
