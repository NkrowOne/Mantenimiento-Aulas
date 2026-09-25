/**
 * El libro entero: escribir celdas, mover filas, añadir o rehacer hojas y
 * darle el acabado en una pasada.
 *
 * `xlsx.ts` sabe de celdas y `estructura.ts` sabe de filas, pero las dos miran
 * un solo fichero de hoja. Hay tres cosas que solo se ven desde arriba y que son
 * justo las que rompen un libro sin avisar:
 *
 * **Un comentario vive en dos ficheros a la vez.** La referencia está en
 * `comments1.xml` y el cuadrito amarillo en un `.vml` con la fila en base 0. Se
 * llega a los dos por el fichero de relaciones de la hoja, no por su nombre —
 * `comments1.xml` puede ser de la tercera pestaña.
 *
 * **Las fórmulas de una hoja miran a las otras.** Mover una fila de `Bolsa 2026`
 * obliga a repasar las fórmulas de las cinco hojas y los nombres definidos, no
 * solo las de la hoja que se toca.
 *
 * **`calcChain.xml` sobra en cuanto la estructura cambia.** Es la caché del
 * orden de recálculo y apunta a celdas por posición. Mantenerla correcta cuesta
 * más que tirarla, y es de los pocos ficheros cuya incoherencia Excel sí
 * denuncia al abrir. Tirarlo no pierde nada: se regenera solo. Pero tirarlo
 * bien son tres sitios —la entrada del zip, el `Override` de los tipos de
 * contenido y la relación del libro—, y dejarse uno da el error que se quería
 * evitar.
 *
 * Sobre el formato: las hojas de la gente se parchean celda a celda y conservan
 * el estilo que tenían; las hojas que escribe la aplicación se pintan con
 * estilos **con nombre** (`ClaveDeEstilo`) que `estilos.ts` convierte en
 * índices de `styles.xml`, añadiendo al final lo que falte y reutilizando lo que
 * ya esté. La regla que hace esto seguro es que `styles.xml` **solo crece por el
 * final**: nunca se renumera lo que hay, porque todas las celdas del libro lo
 * usan por su número. Y crece una sola vez: la segunda pasada encuentra sus
 * estilos y no añade ninguno.
 *
 * El **acabado** (`Acabado`) es lo que se hace después de escribir: rehacer las
 * hojas de la app enteras, pintar las cabeceras de las hojas de la gente según
 * quién escribe cada columna, las bandas alternas, los colores de pestaña y el
 * orden de las pestañas. Todo idempotente: el mismo libro con el mismo acabado
 * dos veces da el mismo `styles.xml`, las mismas tablas, las mismas reglas.
 */

import {
  citarHoja,
  columnasEscritas,
  corregirComentarios,
  corregirReferenciasExternas,
  corregirVml,
  editarHojaXml,
  mostrarColumnas,
  planificar,
} from './estructura'
import type { EdicionDeFilas, MapaDeFilas } from './estructura'
import { columnaANumero, escapar, marcarRecalculo, numeroAColumna, parchearHojaXml, xmlDeCelda } from './xlsx'
import type { Cambio, Hoja, Libro, ResolverClave, ResolverEstilo, ValorCelda } from './xlsx'
import {
  COLOR_DE_BANDA,
  asegurarDxfDeFondo,
  asegurarRecetas,
  conTinte,
  estiloQuePinta,
  estilosDeLaColumna,
  leerEstilos,
  recetaDe,
} from './estilos'
import type { ClaveDeEstilo, Receta, Tinte } from './estilos'
import { asegurarTabla, columnasDeTabla, nombreDeTabla, quitarFiltroDeHoja, refDeTabla, xmlDeTableParts } from './tablas'
import { crearEntrada, descomprimir, escribirZip, reemplazar } from '../lib/zip'
import type { EntradaZip } from '../lib/zip'

export type { ClaveDeEstilo, Tinte } from './estilos'

const TIPO_HOJA =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'

/** Los colores de pestaña: azul claro para las hojas de la app, gris para las discretas. */
const PESTANA_APP = '9DC3E6'
const PESTANA_DISCRETA = '7F7F7F'

// -----------------------------------------------------------------------------
// Lo que se le pide al libro
// -----------------------------------------------------------------------------

export interface EdicionDeHoja {
  hoja: string
  /**
   * Celdas a escribir, con las **direcciones de la hoja original**. Se aplican
   * después de mover las filas, así que aquí se escribe `M87` pensando en el
   * `M87` de hoy aunque acabe siendo el `M89`.
   */
  celdas?: Cambio[]
  filas?: EdicionDeFilas
}

/**
 * El formato de una columna de una hoja nueva. Una fecha escrita sin formato de
 * fecha se ve como `45831`, y a nadie le sirve una hoja de revisiones que enseña
 * cinco cifras donde debería poner el día.
 */
export type Formato = 'texto' | 'textoAjustado' | 'fecha' | 'porcentaje' | 'entero'

export interface HojaNueva {
  nombre: string
  /** La primera fila es la cabecera. */
  filas: ValorCelda[][]
  /** Anchos de columna, en caracteres. Uno por columna. */
  anchos?: number[]
  /** Inmoviliza la fila de cabecera. Por defecto sí. */
  inmovilizar?: boolean
  /** Autofiltro sobre la cabecera. Por defecto sí; se ignora si la hoja es tabla (la tabla lleva el suyo). */
  autofiltro?: boolean
  /** El formato de cada columna. */
  formatos?: Array<Formato | undefined>
  /** Un tinte por FILA DE DATOS (índice 0 = primera fila de datos, es decir `filas[1]`). */
  tintes?: Array<Tinte | undefined>
  /** Estilos sueltos por celda, `'A1'` → clave. Gana a formatos y tintes. Para el Léeme y casos raros. */
  estilos?: Record<string, ClaveDeEstilo>
  /**
   * `'app'` (por defecto): cabecera 5B7F9E, pestaña azul claro, tabla con bandas.
   * `'editable'`: cabecera 1F4E78, pestaña sin color, autofiltro.
   * `'discreta'`: cabecera gris, pestaña gris, sin tabla, sin autofiltro salvo que se pida.
   */
  caracter?: 'app' | 'editable' | 'discreta'
  /** Tabla de Excel con estilo (TableStyleMedium2, bandas). Por defecto sí si `caracter` es `'app'`. */
  tabla?: boolean
  /** Alto de fila (puntos) para filas concretas, por número de fila de hoja (1 = cabecera). */
  altos?: Record<number, number>
}

export interface Acabado {
  /**
   * Hojas de la app que se regeneran ENTERAS: mismo fichero de hoja (misma ruta,
   * mismo `rId`, mismas relaciones, comentarios y `legacyDrawing`), XML nuevo
   * generado como una hoja nueva. Si no existen, se añaden.
   */
  rehacer?: HojaNueva[]
  /**
   * Cabeceras de las hojas de la gente: estilo por letra de columna. Solo se
   * cambia el `s` de las celdas de la fila de cabecera que tengan valor; el
   * texto no se toca.
   */
  cabeceras?: Array<{ hoja: string; fila?: number; columnas: Record<string, 'cabecera' | 'cabeceraApp'> }>
  /**
   * Hojas de la gente que llevan bandas alternas por formato condicional
   * (`MOD(ROW(),2)=0` con un `dxf` de fondo F2F6FA) sobre `A2:<últimaCol><últimaFila>`.
   * Idempotente: si ya hay una regla con esa fórmula se le ajusta el `sqref`;
   * si no, se añade con la prioridad más baja (el número mayor).
   */
  bandas?: string[]
  /**
   * Filas de totales al pie de una hoja de la gente (`Bolsa 2025`: la suma, el
   * IVA y el total). Ni el autofiltro ni las bandas llegan a ellas: un filtro
   * que las incluye las ordena con los artículos, y una suma en medio de la
   * lista es un libro roto sin ningún error.
   */
  totales?: Record<string, number>
  /**
   * Orden final de pestañas: los nombres listados van primero en ese orden; las
   * no listadas conservan su orden relativo detrás; las `discretas` van las últimas.
   */
  orden?: string[]
  /** Nombres exactos (o prefijos si terminan en `*`, p. ej. `Cambios*`) que van al final con pestaña gris. */
  discretas?: string[]
  /** Pestaña activa al abrir (nombre de hoja). Solo esa lleva `tabSelected=1`. */
  activa?: string
  /** Color de pestaña por hoja, por si se quiere forzar (`RRGGBB` sin alfa). */
  pestanas?: Record<string, string>
}

// -----------------------------------------------------------------------------
// Escribir
// -----------------------------------------------------------------------------

/**
 * Aplica todo y devuelve el libro. Lo que no se toca vuelve con sus bytes.
 *
 * El orden importa y no es intercambiable: primero se mueven las filas —que es
 * lo que cambia las direcciones— y solo después se escriben las celdas, ya
 * traducidas. Al revés se escribiría el número de serie en la fila de al lado.
 * Después vienen las hojas nuevas y las rehechas, luego el acabado de cada hoja
 * (cabeceras, bandas, color de pestaña) y al final el orden de las pestañas,
 * que es lo único que cambia los índices con los que el libro habla de sus hojas.
 */
export async function escribirLibro(
  libro: Libro,
  ediciones: EdicionDeHoja[],
  hojasNuevas: HojaNueva[] = [],
  acabado: Acabado = {},
): Promise<Uint8Array> {
  let entradas = [...libro.entradas]
  let hojas = [...libro.hojas]
  let estructuraTocada = false

  // Los estilos se resuelven UNA vez por escritura. Si no hace falta ninguno
  // —una pasada que solo parchea celdas— `styles.xml` ni se lee ni se toca.
  const todasLasHojas = [...hojasNuevas, ...(acabado.rehacer ?? [])]
  const paleta = await paletaDe(entradas, estilosNecesarios(ediciones, todasLasHojas, acabado))
  entradas = paleta.entradas
  const resolverClave: ResolverClave = (clave) => paleta.indice(clave) ?? null

  for (const ed of ediciones) {
    const hoja = hojas.find((h) => h.nombre === ed.hoja)
    if (!hoja) throw new Error(`El libro no tiene la hoja «${ed.hoja}»`)

    const mapa = planificar(ed.filas ?? {})
    const celdas = (ed.celdas ?? []).filter((c) => c.valor !== null)
    if (mapa.vacio && celdas.length === 0) continue

    const i = indice(entradas, hoja.ruta)
    let xml = await texto(entradas[i]!)
    // El mismo resolvedor para las dos rutas: una fecha escrita en una celda que
    // ya existe y una fecha escrita en una fila que se acaba de insertar tienen
    // que verse igual. Se saca del XML de antes de mover nada, que es donde
    // están los estilos que el libro ya usa en esa columna.
    const resolver = await resolverEstiloDe(entradas, xml)

    if (!mapa.vacio) {
      estructuraTocada = true
      xml = editarHojaXml(xml, ed.filas ?? {}, mapa, resolver)
    }
    if (celdas.length > 0) {
      const traducidas = celdas.map((c) => traducir(c, mapa)).filter((c) => c !== null)
      xml = parchearHojaXml(xml, traducidas, resolver, resolverClave)
      // Si se escribe en una columna escondida, se enseña: un dato que suma en
      // una fórmula y no se ve es un descuadre invisible.
      xml = mostrarColumnas(xml, columnasEscritas(traducidas))
    }
    entradas[i] = await reemplazar(entradas[i]!, bytes(xml))

    if (!mapa.vacio) {
      entradas = await moverLoDeFuera(entradas, hoja.ruta, ed.hoja, mapa, hojas)
    }
  }

  for (const nueva of hojasNuevas) {
    const r = await anadirHoja(entradas, hojas, nueva, paleta)
    entradas = r.entradas
    hojas = r.hojas
    estructuraTocada = true
  }

  for (const hoja of acabado.rehacer ?? []) {
    const r = hojas.some((h) => h.nombre === hoja.nombre)
      ? await rehacerHoja(entradas, hojas, hoja, paleta)
      : await anadirHoja(entradas, hojas, hoja, paleta)
    entradas = r.entradas
    hojas = r.hojas
    estructuraTocada = true
  }

  for (const c of acabado.cabeceras ?? []) {
    entradas = await tocarHoja(entradas, hojas, c.hoja, (xml) => pintarCabecera(xml, c.fila ?? 1, c.columnas, paleta))
  }

  if ((acabado.bandas ?? []).length > 0) {
    const dxf = await asegurarDxf(entradas, COLOR_DE_BANDA)
    entradas = dxf.entradas
    for (const nombre of acabado.bandas!) {
      const sinUltimas = acabado.totales?.[nombre] ?? 0
      entradas = await tocarHoja(entradas, hojas, nombre, (xml) =>
        ponerBandas(ajustarRangos(xml, sinUltimas), dxf.indice, sinUltimas),
      )
    }
  }

  for (const [nombre, rgb] of coloresDePestana(todasLasHojas, acabado, hojas)) {
    entradas = await tocarHoja(entradas, hojas, nombre, (xml) => colorearPestana(xml, rgb))
  }

  if (acabado.orden || acabado.discretas || acabado.activa) {
    const r = await ordenarPestanas(entradas, hojas, acabado)
    entradas = r.entradas
    estructuraTocada = estructuraTocada || r.reordenado
  }

  // Con las pestañas ya en su sitio —el `localSheetId` es una posición—, el
  // nombre definido del filtro de cada hoja con bandas dice el mismo rango que
  // su autofiltro.
  const conFiltro = [...(acabado.bandas ?? []), ...(acabado.rehacer ?? []).map((h) => h.nombre)]
  if (conFiltro.length > 0) entradas = await refrescarFiltros(entradas, hojas, conFiltro)

  if (estructuraTocada) entradas = await quitarCalcChain(entradas)

  const iw = entradas.findIndex((e) => e.nombre === 'xl/workbook.xml')
  if (iw >= 0) {
    const xml = await texto(entradas[iw]!)
    const nuevo = marcarRecalculo(xml)
    if (nuevo !== xml) entradas[iw] = await reemplazar(entradas[iw]!, bytes(nuevo))
  }

  return escribirZip(entradas)
}

/**
 * Cómo elegir el estilo de una celda que va a pintar una fecha o un porcentaje.
 *
 * La hoja de estado tiene la columna «Fecha Revisión» a medias: las celdas con
 * fecha llevan formato de fecha y las que estaban vacías se quedaron en
 * «General». Mientras nadie escribiera en ellas daba igual; en cuanto la
 * sincronización rellena las revisiones que faltaban, media columna sale en
 * números de cinco cifras. Se reutiliza un estilo que el libro ya usa —el de
 * otra celda de la misma columna— y nunca se crea uno nuevo.
 */
async function resolverEstiloDe(entradas: EntradaZip[], xmlHoja: string): Promise<ResolverEstilo> {
  const i = entradas.findIndex((e) => e.nombre === 'xl/styles.xml')
  if (i < 0) return () => null
  const estilos = leerEstilos(await texto(entradas[i]!))
  const porColumna = new Map<string, number[]>()

  return (columna, formato, actual) => {
    if (!porColumna.has(columna)) porColumna.set(columna, estilosDeLaColumna(xmlHoja, columna))
    const nuevo = estiloQuePinta(
      estilos,
      formato,
      actual === '' ? null : Number(actual),
      porColumna.get(columna)!,
    )
    return nuevo === null ? null : String(nuevo)
  }
}

/** Una celda escrita contra la hoja de antes, apuntando a la de después. */
function traducir(c: Cambio, mapa: MapaDeFilas): Cambio | null {
  if (mapa.vacio) return c
  const m = /^([A-Z]+)(\d+)$/.exec(c.celda.toUpperCase())
  if (!m) return c
  const nueva = mapa.nuevo(Number(m[2]))
  // Escribir en una fila que se acaba de borrar no es un error del que llama:
  // es lo que pasa cuando en la misma pasada un aula se archiva y se corrige.
  // Gana el borrado, que es la orden más fuerte.
  if (nueva === null) return null
  return { ...c, celda: `${m[1]}${nueva}` }
}

/** Comentarios, dibujos y las fórmulas de las demás hojas. */
async function moverLoDeFuera(
  entradas: EntradaZip[],
  ruta: string,
  nombre: string,
  mapa: MapaDeFilas,
  hojas: Hoja[],
): Promise<EntradaZip[]> {
  const out = [...entradas]

  for (const destino of await relacionesDe(out, ruta)) {
    const i = out.findIndex((e) => e.nombre === destino)
    if (i < 0) continue
    if (destino.includes('/comments')) {
      out[i] = await reemplazar(out[i]!, bytes(corregirComentarios(await texto(out[i]!), mapa)))
    } else if (destino.endsWith('.vml')) {
      out[i] = await reemplazar(out[i]!, bytes(corregirVml(await texto(out[i]!), mapa)))
    }
  }

  // Las fórmulas de las otras hojas y los nombres definidos del libro.
  for (const otra of [...hojas.map((h) => h.ruta), 'xl/workbook.xml']) {
    if (otra === ruta) continue
    const i = out.findIndex((e) => e.nombre === otra)
    if (i < 0) continue
    const xml = await texto(out[i]!)
    const nuevo = corregirReferenciasExternas(xml, nombre, mapa)
    if (nuevo !== xml) out[i] = await reemplazar(out[i]!, bytes(nuevo))
  }

  return out
}

/** Los ficheros a los que apunta una hoja: comentarios, dibujos, hipervínculos. */
async function relacionesDe(entradas: EntradaZip[], ruta: string): Promise<string[]> {
  const partes = ruta.split('/')
  const fichero = partes.pop()!
  const rels = `${partes.join('/')}/_rels/${fichero}.rels`
  const i = entradas.findIndex((e) => e.nombre === rels)
  if (i < 0) return []

  const xml = await texto(entradas[i]!)
  const base = partes.join('/')
  const out: string[] = []
  for (const m of xml.matchAll(/Target="([^"]+)"/g)) {
    const t = m[1]!
    if (t.startsWith('http')) continue
    out.push(normalizarRuta(base, t))
  }
  return out
}

/** `xl/worksheets` + `../drawings/vmlDrawing1.vml` → `xl/drawings/vmlDrawing1.vml`. */
function normalizarRuta(base: string, relativa: string): string {
  if (relativa.startsWith('/')) return relativa.slice(1)
  const partes = base.split('/')
  for (const trozo of relativa.split('/')) {
    if (trozo === '.' || trozo === '') continue
    if (trozo === '..') partes.pop()
    else partes.push(trozo)
  }
  return partes.join('/')
}

/**
 * La caché de recálculo: sobra en cuanto se mueve una fila, y en tres sitios.
 *
 * Quitar solo el fichero del zip deja el `Override` de `[Content_Types].xml` y
 * la relación de `workbook.xml.rels` apuntando a una parte que ya no está, que
 * es justamente el error que se quería evitar tirándolo. Los tres, o ninguno.
 */
async function quitarCalcChain(entradas: EntradaZip[]): Promise<EntradaZip[]> {
  if (!entradas.some((e) => e.nombre === 'xl/calcChain.xml')) return entradas

  const out = entradas.filter((e) => e.nombre !== 'xl/calcChain.xml')

  const ic = out.findIndex((e) => e.nombre === '[Content_Types].xml')
  if (ic >= 0) {
    const ct = await texto(out[ic]!)
    const sin = ct.replace(/<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, '')
    if (sin !== ct) out[ic] = await reemplazar(out[ic]!, bytes(sin))
  }

  const ir = out.findIndex((e) => e.nombre === 'xl/_rels/workbook.xml.rels')
  if (ir >= 0) {
    const rels = await texto(out[ir]!)
    // Por el `Type`, no por el `Target`: el destino puede venir escrito de más de
    // una forma y el tipo de relación es siempre el mismo.
    const sin = rels.replace(
      /<Relationship\b[^>]*Type="[^"]*\/calcChain"[^>]*\/>/g,
      '',
    )
    if (sin !== rels) out[ir] = await reemplazar(out[ir]!, bytes(sin))
  }

  return out
}

// -----------------------------------------------------------------------------
// Los estilos con nombre, resueltos una vez
// -----------------------------------------------------------------------------

/** Una clave y, si la fila lleva tinte, el tinte: `fecha` y `fecha` en fila crítica son dos estilos. */
type Pedido = { clave: ClaveDeEstilo; tinte?: Tinte }

interface Paleta {
  entradas: EntradaZip[]
  /** El índice de `cellXfs`, como texto para ponerlo en `s="…"`. */
  indice(clave: ClaveDeEstilo, tinte?: Tinte): string | undefined
}

function claveDePedido(p: Pedido): string {
  return p.tinte ? `${p.clave}+${p.tinte}` : p.clave
}

/** Todo lo que esta escritura va a pintar, para pedirlo de una vez. */
function estilosNecesarios(ediciones: EdicionDeHoja[], hojas: HojaNueva[], acabado: Acabado): Pedido[] {
  const out = new Map<string, Pedido>()
  const pedir = (p: Pedido) => out.set(claveDePedido(p), p)

  for (const ed of ediciones) {
    for (const c of ed.celdas ?? []) if (c.estilo) pedir({ clave: c.estilo })
  }
  for (const c of acabado.cabeceras ?? []) {
    for (const clave of Object.values(c.columnas)) pedir({ clave })
  }
  for (const hoja of hojas) {
    for (const p of pedidosDeLaHoja(hoja)) pedir(p)
  }
  return [...out.values()]
}

function pedidosDeLaHoja(hoja: HojaNueva): Pedido[] {
  const out: Pedido[] = []
  const columnas = columnasDe(hoja)
  for (let i = 0; i < Math.max(1, hoja.filas.length); i++) {
    for (let c = 0; c < columnas; c++) out.push(pedidoDeCelda(hoja, i, c))
  }
  return out
}

/** Qué estilo le toca a la celda `(fila i, columna c)` de una hoja nueva, ambos en base 0. */
function pedidoDeCelda(hoja: HojaNueva, i: number, c: number): Pedido {
  const suelto = hoja.estilos?.[`${numeroAColumna(c + 1)}${i + 1}`]
  if (suelto) return { clave: suelto }
  if (i === 0) return { clave: claveDeCabecera(hoja) }
  const clave: ClaveDeEstilo = hoja.formatos?.[c] ?? 'texto'
  const tinte = hoja.tintes?.[i - 1]
  return tinte ? { clave, tinte } : { clave }
}

function claveDeCabecera(hoja: HojaNueva): ClaveDeEstilo {
  const caracter = hoja.caracter ?? 'app'
  return caracter === 'app' ? 'cabeceraApp' : caracter === 'editable' ? 'cabecera' : 'cabeceraDiscreta'
}

function recetaDePedido(p: Pedido): Receta {
  const base = recetaDe(p.clave)
  return p.tinte ? conTinte(base, p.tinte) : base
}

/**
 * Resuelve los estilos contra `styles.xml` y lo escribe solo si ha crecido:
 * cuando todo lo pedido ya existe, la entrada vuelve con sus bytes de siempre.
 */
async function paletaDe(entradas: EntradaZip[], pedidos: Pedido[]): Promise<Paleta> {
  const indices = new Map<string, number>()
  const paleta: Paleta = {
    entradas,
    indice: (clave, tinte) => {
      const n = indices.get(claveDePedido({ clave, tinte }))
      return n === undefined ? undefined : String(n)
    },
  }
  if (pedidos.length === 0) return paleta

  const i = entradas.findIndex((e) => e.nombre === 'xl/styles.xml')
  if (i < 0) throw new Error('El libro no tiene xl/styles.xml')
  const antes = await texto(entradas[i]!)
  const r = asegurarRecetas(antes, pedidos.map(recetaDePedido))
  pedidos.forEach((p, k) => indices.set(claveDePedido(p), r.indices[k]!))
  if (r.xml !== antes) {
    const out = [...entradas]
    out[i] = await reemplazar(out[i]!, bytes(r.xml))
    paleta.entradas = out
  }
  return paleta
}

async function asegurarDxf(entradas: EntradaZip[], rgb: string): Promise<{ entradas: EntradaZip[]; indice: number }> {
  const i = indice(entradas, 'xl/styles.xml')
  const antes = await texto(entradas[i]!)
  const r = asegurarDxfDeFondo(antes, rgb)
  if (r.xml === antes) return { entradas, indice: r.indice }
  const out = [...entradas]
  out[i] = await reemplazar(out[i]!, bytes(r.xml))
  return { entradas: out, indice: r.indice }
}

// -----------------------------------------------------------------------------
// Hojas nuevas y rehechas
// -----------------------------------------------------------------------------

/**
 * Añade una hoja al final del libro.
 *
 * El número del fichero (`sheet7.xml`) no dice nada del orden de las pestañas
 * —el orden lo da `workbook.xml`— pero sí tiene que no chocar con ninguno que ya
 * exista, incluido el de una hoja que se borró en su día y dejó el hueco.
 */
async function anadirHoja(
  entradas: EntradaZip[],
  hojas: Hoja[],
  nueva: HojaNueva,
  paleta: Paleta,
): Promise<{ entradas: EntradaZip[]; hojas: Hoja[] }> {
  if (hojas.some((h) => h.nombre === nueva.nombre)) {
    throw new Error(`El libro ya tiene una hoja «${nueva.nombre}»`)
  }
  if (nueva.nombre.length > 31) {
    throw new Error(`«${nueva.nombre}» pasa de 31 caracteres: Excel no admite ese nombre de hoja`)
  }

  let out = [...entradas]
  const usados = new Set(
    out
      .map((e) => /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(e.nombre)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number),
  )
  let n = 1
  while (usados.has(n)) n++
  const ruta = `xl/worksheets/sheet${n}.xml`

  const modelo = out.find((e) => e.nombre === 'xl/workbook.xml')!
  let ridTabla: string | null = null
  if (esTabla(nueva)) {
    const t = await asegurarTabla(out, ruta, datosDeTabla(nueva))
    out = t.entradas
    ridTabla = t.rid
  }
  out.push(await crearEntrada(ruta, bytes(xmlDeHoja(nueva, paleta, '', ridTabla)), modelo))

  // 1 — la relación del libro
  const ir = indice(out, 'xl/_rels/workbook.xml.rels')
  const rels = await texto(out[ir]!)
  const rid = idLibre(rels)
  out[ir] = await reemplazar(
    out[ir]!,
    bytes(
      rels.replace(
        '</Relationships>',
        `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/></Relationships>`,
      ),
    ),
  )

  // 2 — la pestaña
  const iw = indice(out, 'xl/workbook.xml')
  const wb = await texto(out[iw]!)
  const idsHoja = [...wb.matchAll(/<sheet\b[^>]*\bsheetId="(\d+)"/g)].map((m) => Number(m[1]))
  const sheetId = Math.max(0, ...idsHoja) + 1
  out[iw] = await reemplazar(
    out[iw]!,
    bytes(
      wb.replace(
        '</sheets>',
        `<sheet name="${escapar(nueva.nombre)}" sheetId="${sheetId}" r:id="${rid}"/></sheets>`,
      ),
    ),
  )

  // 3 — el tipo de contenido, sin el cual Excel no sabe qué es el fichero
  const ic = indice(out, '[Content_Types].xml')
  const ct = await texto(out[ic]!)
  out[ic] = await reemplazar(
    out[ic]!,
    bytes(ct.replace('</Types>', `<Override PartName="/${ruta}" ContentType="${TIPO_HOJA}"/></Types>`)),
  )

  return { entradas: out, hojas: [...hojas, { nombre: nueva.nombre, ruta }] }
}

/**
 * Vuelve a escribir entera una hoja que ya existe, en su mismo fichero.
 *
 * Se conserva del XML viejo lo que va después de `</sheetData>` y no depende de
 * las filas —`pageMargins`, `legacyDrawing`, `dataValidations`…—, así que los
 * comentarios y su dibujo siguen relacionados. Lo que sí depende de las filas
 * (`autoFilter`, `tableParts`, `conditionalFormatting`) se regenera. Al cambiar
 * el número de filas no hace falta remapear nada fuera de la hoja: nadie edita a
 * mano estas hojas, y nadie les apunta desde una fórmula.
 */
async function rehacerHoja(
  entradas: EntradaZip[],
  hojas: Hoja[],
  hoja: HojaNueva,
  paleta: Paleta,
): Promise<{ entradas: EntradaZip[]; hojas: Hoja[] }> {
  const ruta = hojas.find((h) => h.nombre === hoja.nombre)!.ruta
  let out = [...entradas]
  const i = indice(out, ruta)
  const viejo = await texto(out[i]!)

  let ridTabla: string | null = null
  if (esTabla(hoja)) {
    const t = await asegurarTabla(out, ruta, datosDeTabla(hoja))
    out = t.entradas
    ridTabla = t.rid
    // La tabla lleva su filtro: el de la hoja sobra y Excel se queja del doble.
    const iw = indice(out, 'xl/workbook.xml')
    const wb = await texto(out[iw]!)
    const sin = quitarFiltroDeHoja(wb, await posicionDeLaHoja(out, hoja.nombre))
    if (sin !== wb) out[iw] = await reemplazar(out[iw]!, bytes(sin))
  }

  out[i] = await reemplazar(out[i]!, bytes(xmlDeHoja(hoja, paleta, colaDe(viejo), ridTabla)))
  return { entradas: out, hojas }
}

/** Lo que hay tras `</sheetData>` y no depende de las filas. */
function colaDe(xml: string): string {
  const m = /<\/sheetData>|<sheetData\b[^>]*\/>/.exec(xml)
  if (!m) return ''
  const fin = xml.lastIndexOf('</worksheet>')
  let cola = xml.slice(m.index + m[0].length, fin < 0 ? xml.length : fin)
  for (const etiqueta of ['autoFilter', 'tableParts', 'conditionalFormatting']) {
    cola = cola.replace(elemento(etiqueta), '')
  }
  return cola
}

/** El patrón de un elemento entero, autocerrado o con pareja. El autocerrado va primero a propósito. */
function elemento(etiqueta: string): RegExp {
  return new RegExp(`<${etiqueta}\\b[^>]*?/>|<${etiqueta}\\b[^>]*>[\\s\\S]*?</${etiqueta}>`, 'g')
}

function esTabla(hoja: HojaNueva): boolean {
  return hoja.tabla ?? (hoja.caracter ?? 'app') === 'app'
}

function columnasDe(hoja: HojaNueva): number {
  return Math.max(1, ...hoja.filas.map((f) => f.length))
}

function datosDeTabla(hoja: HojaNueva) {
  const columnas = columnasDe(hoja)
  const cabecera = [...(hoja.filas[0] ?? [])]
  while (cabecera.length < columnas) cabecera.push(null)
  return {
    nombre: nombreDeTabla(hoja.nombre),
    ref: refDeTabla(columnas, hoja.filas.length),
    columnas: columnasDeTabla(cabecera),
  }
}

function idLibre(rels: string): string {
  const usados = new Set([...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1])))
  let n = 1
  while (usados.has(n)) n++
  return `rId${n}`
}

/**
 * El XML de una hoja de la aplicación. `cola` es lo que se conserva de la hoja
 * vieja al rehacerla (vacío para una nueva); `ridTabla`, la relación de su tabla.
 */
function xmlDeHoja(hoja: HojaNueva, paleta: Paleta, cola: string, ridTabla: string | null): string {
  const columnas = columnasDe(hoja)
  const inmovilizar = hoja.inmovilizar ?? true
  const caracter = hoja.caracter ?? 'app'
  const autofiltro = ridTabla === null && (hoja.autofiltro ?? caracter !== 'discreta')
  // La cabecera de una tabla es la de la tabla: texto, sin vacíos ni repetidos.
  const cabecera: ValorCelda[] = ridTabla === null ? (hoja.filas[0] ?? []) : datosDeTabla(hoja).columnas

  const vista = inmovilizar
    ? `<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>`
    : `<sheetView workbookViewId="0"/>`

  const cols = hoja.anchos
    ? `<cols>${hoja.anchos
        .map((a, i) => `<col min="${i + 1}" max="${i + 1}" width="${a}" customWidth="1"/>`)
        .join('')}</cols>`
    : ''

  // La cabecera va a 30 puntos si no se dice otra cosa: lleva ajuste de texto y
  // los títulos largos («Fecha Revisión Anterior») no caben en una línea.
  const altos: Record<number, number> = { 1: 30, ...(hoja.altos ?? {}) }

  const filas = hoja.filas
    .map((valores, i) => {
      const numero = i + 1
      const celdas: string[] = []
      for (let c = 0; c < columnas; c++) {
        const v = i === 0 ? (cabecera[c] ?? null) : (valores[c] ?? null)
        const p = pedidoDeCelda(hoja, i, c)
        const s = paleta.indice(p.clave, p.tinte) ?? ''
        // Las celdas vacías se escriben con su estilo: son el borde de la
        // cuadrícula y el fondo del tinte, y sin ellas la fila tiene huecos.
        celdas.push(xmlDeCelda(numeroAColumna(c + 1) + numero, s, v ?? ''))
      }
      const alto = altos[numero]
      const ht = alto === undefined ? '' : ` ht="${alto}" customHeight="1"`
      return `<row r="${numero}"${ht}>${celdas.join('')}</row>`
    })
    .join('')

  const ultima = ridTabla === null ? Math.max(1, hoja.filas.length) : Math.max(2, hoja.filas.length)
  const dim = `A1:${numeroAColumna(columnas)}${ultima}`
  const filtro = autofiltro && hoja.filas.length > 0 ? `<autoFilter ref="${dim}"/>` : ''

  let xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<dimension ref="${dim}"/><sheetViews>${vista}</sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>${cols}` +
    `<sheetData>${filas}</sheetData>${filtro}${cola}</worksheet>`

  if (ridTabla !== null) xml = insertarEnHoja(xml, 'tableParts', xmlDeTableParts(ridTabla))
  return xml
}

// -----------------------------------------------------------------------------
// El acabado de cada hoja
// -----------------------------------------------------------------------------

/** Lee, transforma y escribe una hoja por su nombre; si no cambia, no se toca. */
async function tocarHoja(
  entradas: EntradaZip[],
  hojas: Hoja[],
  nombre: string,
  f: (xml: string) => string,
): Promise<EntradaZip[]> {
  const hoja = hojas.find((h) => h.nombre === nombre)
  if (!hoja) throw new Error(`El libro no tiene la hoja «${nombre}»`)
  const i = indice(entradas, hoja.ruta)
  const xml = await texto(entradas[i]!)
  const nuevo = f(xml)
  if (nuevo === xml) return entradas
  const out = [...entradas]
  out[i] = await reemplazar(out[i]!, bytes(nuevo))
  return out
}

/**
 * Los hijos de `<worksheet>` que van después de `sheetData`, en el orden que
 * exige el esquema. Insertar uno donde no toca es de los pocos errores de
 * orden que Excel sí denuncia.
 */
const TRAS_SHEETDATA = [
  'sheetCalcPr', 'sheetProtection', 'protectedRanges', 'scenarios', 'autoFilter', 'sortState',
  'dataConsolidate', 'customSheetViews', 'mergeCells', 'phoneticPr', 'conditionalFormatting',
  'dataValidations', 'hyperlinks', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter',
  'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags',
  'drawing', 'legacyDrawing', 'legacyDrawingHF', 'picture', 'oleObjects', 'controls',
  'webPublishItems', 'tableParts', 'extLst',
]

/** Inserta un fragmento como hijo de `<worksheet>` en el sitio que le toca a su etiqueta. */
function insertarEnHoja(xml: string, etiqueta: string, fragmento: string): string {
  const m = /<\/sheetData>|<sheetData\b[^>]*\/>/.exec(xml)
  if (!m) throw new Error('La hoja no tiene <sheetData>: no es una hoja de cálculo normal')
  const desde = m.index + m[0].length
  let corte = xml.lastIndexOf('</worksheet>')
  if (corte < 0) corte = xml.length
  for (const s of TRAS_SHEETDATA.slice(TRAS_SHEETDATA.indexOf(etiqueta) + 1)) {
    const k = xml.slice(desde, corte).search(new RegExp(`<${s}\\b`))
    if (k >= 0) corte = desde + k
  }
  return xml.slice(0, corte) + fragmento + xml.slice(corte)
}

/** Hasta dónde llegan los datos de una hoja, contando las celdas y no la `dimension`, que puede mentir. */
function extensionDe(xml: string): { filas: number; columnas: number } {
  let filas = 0
  let columnas = 0
  for (const m of xml.matchAll(/<row\b[^>]*\br="(\d+)"/g)) filas = Math.max(filas, Number(m[1]))
  for (const m of xml.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"/g)) columnas = Math.max(columnas, columnaANumero(m[1]!))
  return { filas, columnas }
}

/**
 * Cambia el estilo de las celdas con valor de la fila de cabecera. El texto no
 * se toca: la cabecera es el contrato con la aplicación, y esto es solo color.
 */
function pintarCabecera(
  xml: string,
  fila: number,
  columnas: Record<string, ClaveDeEstilo>,
  paleta: Paleta,
): string {
  const patron = new RegExp(`<row\\b[^>]*\\br="${fila}"[^>]*>([\\s\\S]*?)</row>`)
  return xml.replace(patron, (todo, cuerpo: string) => {
    const nuevo = cuerpo.replace(/<c\b([^>]*)>([\s\S]*?)<\/c>/g, (celda, attrs: string, interior: string) => {
      const col = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1]
      const clave = col ? columnas[col] : undefined
      if (!clave || !/<v>|<is>|<f>/.test(interior)) return celda
      const s = paleta.indice(clave)
      if (s === undefined) return celda
      const nuevos = /\bs="\d+"/.test(attrs) ? attrs.replace(/\bs="\d+"/, `s="${s}"`) : `${attrs} s="${s}"`
      return `<c${nuevos}>${interior}</c>`
    })
    return todo.replace(cuerpo, () => nuevo)
  })
}

/**
 * Bandas alternas por formato condicional sobre los datos de la hoja.
 *
 * Si la hoja ya tiene una regla con esa fórmula —el libro real la trae— se le
 * ajusta el rango y no se añade otra: dos reglas iguales pintan lo mismo dos
 * veces y el libro engorda en cada pasada.
 */
function ponerBandas(xml: string, dxf: number, sinUltimas = 0): string {
  const { filas, columnas } = extensionDe(xml)
  const sqref = `A2:${numeroAColumna(Math.max(1, columnas))}${Math.max(2, filas - sinUltimas)}`
  const formula = /<cfRule\b[^>]*\btype="expression"[^>]*>[\s\S]*?<formula>\s*MOD\(ROW\(\),\s*2\)\s*=\s*0\s*<\/formula>/

  let encontrada = false
  const out = xml.replace(/<conditionalFormatting\b[^>]*>[\s\S]*?<\/conditionalFormatting>/g, (bloque) => {
    if (encontrada || !formula.test(bloque)) return bloque
    encontrada = true
    return bloque.replace(/\bsqref="[^"]*"/, `sqref="${sqref}"`)
  })
  if (encontrada) return out

  const prioridades = [...xml.matchAll(/<cfRule\b[^>]*\bpriority="(\d+)"/g)].map((m) => Number(m[1]))
  const prioridad = Math.max(0, ...prioridades) + 1
  return insertarEnHoja(
    out,
    'conditionalFormatting',
    `<conditionalFormatting sqref="${sqref}"><cfRule type="expression" dxfId="${dxf}" priority="${prioridad}"><formula>MOD(ROW(),2)=0</formula></cfRule></conditionalFormatting>`,
  )
}

/**
 * `dimension` y `autoFilter` al tamaño de lo que hay.
 *
 * Las filas que la pasada añade al final —partes nuevos, artículos nuevos—
 * caían fuera del rango del autofiltro, que seguía diciendo `A1:R46` con la
 * hoja en la 70: el desplegable de la cabecera no las filtraba ni las
 * ordenaba, y nadie lo veía hasta que buscaba un parte de septiembre con el
 * filtro puesto y no salía. `dimension` es lo mismo con menos consecuencia:
 * Excel lo recalcula, pero quien lea el fichero con otra cosa no.
 *
 * Se conserva la celda donde empieza el autofiltro, que es la cabecera.
 */
function ajustarRangos(xml: string, sinUltimas = 0): string {
  const { filas, columnas } = extensionDe(xml)
  if (filas === 0 || columnas === 0) return xml
  const col = numeroAColumna(columnas)
  let out = xml.replace(/<dimension\b([^>]*)\bref="[^"]*"/, `<dimension$1ref="A1:${col}${filas}"`)
  const hastaFiltro = Math.max(1, filas - sinUltimas)
  out = out.replace(
    /<autoFilter\b([^>]*)\bref="([A-Z]+\d+)(?::[A-Z]+\d+)?"/,
    (_todo, attrs: string, desde: string) => `<autoFilter${attrs}ref="${desde}:${col}${hastaFiltro}"`,
  )
  return out
}

/**
 * El `_xlnm._FilterDatabase` de cada hoja, con el rango de su autofiltro.
 *
 * Es el nombre oculto con el que Excel recuerda dónde está el filtro, y lo
 * mantiene igual que el `autoFilter` de la hoja. Uno viejo no rompe el libro,
 * pero al abrirlo Excel lo cree y el filtro «recuerda» un rango que ya no es.
 * Solo se toca el que exista: Excel lo crea solo cuando falta.
 */
async function refrescarFiltros(entradas: EntradaZip[], hojas: Hoja[], nombres: string[]): Promise<EntradaZip[]> {
  const out = [...entradas]
  const iw = indice(out, 'xl/workbook.xml')
  let wb = await texto(out[iw]!)
  const posiciones = nombresDeSheets(wb)
  for (const nombre of nombres) {
    const hoja = hojas.find((h) => h.nombre === nombre)
    const posicion = posiciones.indexOf(nombre)
    if (!hoja || posicion < 0) continue
    const i = out.findIndex((e) => e.nombre === hoja.ruta)
    if (i < 0) continue
    const ref = /<autoFilter\b[^>]*\bref="([A-Z]+\d+:[A-Z]+\d+)"/.exec(await texto(out[i]!))?.[1]
    if (!ref) {
      // Sin autofiltro —una hoja rehecha que ya no lo lleva, o que es tabla—
      // el nombre viejo sobra: apuntaría a un filtro que no existe.
      wb = quitarFiltroDeHoja(wb, posicion)
      continue
    }
    const absoluto = ref.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')
    const patron = new RegExp(
      `(<definedName\\b[^>]*\\bname="_xlnm\\._FilterDatabase"[^>]*\\blocalSheetId="${posicion}"[^>]*>)[^<]*(</definedName>)`,
    )
    // Con función y no con cadena: `$A$1` dentro de una cadena de reemplazo
    // se lee como grupos de captura y deja el nombre hecho trizas.
    wb = wb.replace(patron, (_todo, abre: string, cierra: string) => `${abre}${escapar(citarHoja(nombre))}!${absoluto}${cierra}`)
  }
  if (wb !== (await texto(out[iw]!))) out[iw] = await reemplazar(out[iw]!, bytes(wb))
  return out
}

/** `tabColor` como PRIMER hijo de `sheetPr`, creando `sheetPr` si la hoja no lo tiene. */
function colorearPestana(xml: string, rgb: string): string {
  const tab = `<tabColor rgb="FF${rgb}"/>`
  if (/<tabColor\b/.test(xml)) return xml.replace(elemento('tabColor'), tab)
  if (/<sheetPr\b[^>]*\/>/.test(xml)) return xml.replace(/<sheetPr\b([^>]*)\/>/, `<sheetPr$1>${tab}</sheetPr>`)
  if (/<sheetPr\b/.test(xml)) return xml.replace(/<sheetPr\b[^>]*>/, (m) => `${m}${tab}`)
  return xml.replace(/<worksheet\b[^>]*>/, (m) => `${m}<sheetPr>${tab}</sheetPr>`)
}

/** Qué color lleva cada pestaña que hay que colorear: por carácter de hoja, por discreta, o forzado. */
function coloresDePestana(nuevas: HojaNueva[], acabado: Acabado, hojas: Hoja[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const h of nuevas) {
    const caracter = h.caracter ?? 'app'
    if (caracter === 'app') out.set(h.nombre, PESTANA_APP)
    else if (caracter === 'discreta') out.set(h.nombre, PESTANA_DISCRETA)
  }
  for (const h of hojas) {
    if (esDiscreta(h.nombre, acabado.discretas ?? [])) out.set(h.nombre, PESTANA_DISCRETA)
  }
  for (const [nombre, rgb] of Object.entries(acabado.pestanas ?? {})) out.set(nombre, rgb.replace(/^FF/i, '').slice(-6).toUpperCase())
  return out
}

function esDiscreta(nombre: string, patrones: string[]): boolean {
  return patrones.some((p) => (p.endsWith('*') ? nombre.startsWith(p.slice(0, -1)) : nombre === p))
}

// -----------------------------------------------------------------------------
// El orden de las pestañas
// -----------------------------------------------------------------------------

/** La posición 0-based de una hoja en `<sheets>`, que es lo que `localSheetId` y `activeTab` indexan. */
async function posicionDeLaHoja(entradas: EntradaZip[], nombre: string): Promise<number> {
  const wb = await texto(entradas[indice(entradas, 'xl/workbook.xml')]!)
  return nombresDeSheets(wb).indexOf(nombre)
}

function nombresDeSheets(workbookXml: string): string[] {
  return [...workbookXml.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => desescaparNombre(m[1] ?? ''))
}

function desescaparNombre(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
}

/**
 * Reordena `<sheets>` y **remapea `localSheetId` de cada `definedName`**, que es
 * el índice de posición y no el `sheetId`: sin esto, el autofiltro de la hoja
 * de estado se queda apuntando a la hoja que ahora ocupa su antiguo sitio.
 * `activeTab` va a la activa, y solo ella lleva `tabSelected="1"`: dos hojas
 * seleccionadas se abren agrupadas, y quien escriba en una escribe en las dos.
 */
async function ordenarPestanas(
  entradas: EntradaZip[],
  hojas: Hoja[],
  acabado: Acabado,
): Promise<{ entradas: EntradaZip[]; reordenado: boolean }> {
  let out = [...entradas]
  const iw = indice(out, 'xl/workbook.xml')
  const wb = await texto(out[iw]!)
  const bloque = /<sheets\b[^>]*>([\s\S]*?)<\/sheets>/.exec(wb)
  if (!bloque) return { entradas: out, reordenado: false }
  const elementos = [...bloque[1]!.matchAll(/<sheet\b[^>]*\/>|<sheet\b[^>]*>[\s\S]*?<\/sheet>/g)].map((m) => m[0])
  const nombres = elementos.map((e) => desescaparNombre(/\bname="([^"]*)"/.exec(e)?.[1] ?? ''))

  // Primero las listadas en su orden, luego el resto en el suyo, y las
  // discretas al final en el orden en que se nombraron sus patrones.
  const discretas = acabado.discretas ?? []
  const listadas = (acabado.orden ?? []).map((n) => nombres.indexOf(n)).filter((i) => i >= 0)
  const grises = nombres
    .map((n, i) => ({ i, patron: discretas.findIndex((p) => esDiscreta(n, [p])) }))
    .filter((x) => x.patron >= 0 && !listadas.includes(x.i))
    .sort((a, b) => a.patron - b.patron || a.i - b.i)
    .map((x) => x.i)
  const resto = nombres.map((_, i) => i).filter((i) => !listadas.includes(i) && !grises.includes(i))
  const nuevoOrden = [...listadas, ...resto, ...grises]
  const nuevaPosicion = new Map(nuevoOrden.map((viejo, nuevo) => [viejo, nuevo]))
  const reordenado = nuevoOrden.some((viejo, nuevo) => viejo !== nuevo)

  let xml = wb
  if (reordenado) {
    xml = xml.replace(bloque[0], bloque[0].replace(bloque[1]!, nuevoOrden.map((i) => elementos[i]!).join('')))
    xml = xml.replace(/(<definedName\b[^>]*\blocalSheetId=")(\d+)(")/g, (todo, a: string, id: string, b: string) => {
      const n = nuevaPosicion.get(Number(id))
      return n === undefined ? todo : `${a}${n}${b}`
    })
  }

  const activa = acabado.activa === undefined ? -1 : nombres.indexOf(acabado.activa)
  if (activa >= 0) {
    xml = ponerActiveTab(xml, nuevaPosicion.get(activa)!)
  } else if (reordenado) {
    const vieja = Number(/<workbookView\b[^>]*\bactiveTab="(\d+)"/.exec(xml)?.[1] ?? 0)
    xml = ponerActiveTab(xml, nuevaPosicion.get(vieja) ?? 0)
  }
  if (xml !== wb) out[iw] = await reemplazar(out[iw]!, bytes(xml))

  if (acabado.activa !== undefined && activa >= 0) {
    for (const h of hojas) {
      out = await tocarHoja(out, hojas, h.nombre, (s) => seleccionar(s, h.nombre === acabado.activa))
    }
  }
  return { entradas: out, reordenado }
}

function ponerActiveTab(workbookXml: string, indice: number): string {
  if (/<workbookView\b[^>]*\bactiveTab="\d+"/.test(workbookXml)) {
    return workbookXml.replace(/(<workbookView\b[^>]*\bactiveTab=")\d+(")/, `$1${indice}$2`)
  }
  if (/<workbookView\b/.test(workbookXml)) {
    return workbookXml.replace(/<workbookView\b/, `<workbookView activeTab="${indice}"`)
  }
  return workbookXml.replace(/<sheets\b/, `<bookViews><workbookView activeTab="${indice}"/></bookViews><sheets`)
}

/** `tabSelected="1"` en la primera vista de la hoja activa; en las demás, fuera. */
function seleccionar(xml: string, activa: boolean): string {
  if (!activa) return xml.replace(/<sheetView\b[^>]*/g, (m) => m.replace(/\s+tabSelected="[^"]*"/, ''))
  let hecho = false
  return xml.replace(/<sheetView\b[^>]*/, (m) => {
    if (hecho) return m
    hecho = true
    const sin = m.replace(/\s+tabSelected="[^"]*"/, '')
    return sin.replace(/<sheetView\b/, '<sheetView tabSelected="1"')
  })
}

// -----------------------------------------------------------------------------

function indice(entradas: EntradaZip[], ruta: string): number {
  const i = entradas.findIndex((e) => e.nombre === ruta)
  if (i < 0) throw new Error(`El libro no tiene «${ruta}»`)
  return i
}

async function texto(e: EntradaZip): Promise<string> {
  return new TextDecoder().decode(await descomprimir(e))
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}
