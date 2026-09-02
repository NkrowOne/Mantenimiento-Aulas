/**
 * La pasada, de principio a fin: subir el libro, ver qué pasaría, y que pase.
 *
 * Es el único sitio donde se juntan las tres cosas —el fichero, la base y el
 * motor— y por eso es el único donde hay un orden que **no** se puede cambiar:
 *
 *   1. leer el libro y la base
 *   2. leer la instantánea de la última pasada
 *   3. decidir, sin escribir nada, y enseñarlo
 *   4. aplicar a la base **en una transacción**
 *   5. y solo entonces, escribir el libro
 *
 * El 4 va antes que el 5 a propósito. Si el libro se escribiera primero y la
 * base fallara, el fichero diría cosas que la base no sabe y la pasada
 * siguiente las leería como «lo cambió el Excel» y las volvería a meter — o
 * peor, las daría por conflicto contra la app. Al revés, si la base entra y el
 * navegador se cierra antes de descargar, no se ha perdido nada: la pasada
 * siguiente vuelve a escribir el libro, porque la instantánea ya dice cuál es
 * el valor bueno.
 *
 * Y el 3 no es un adorno de la pantalla. Contra un libro de 295 filas que lleva
 * años de manos distintas, la primera pasada mueve cientos de celdas: poder
 * mirarlas antes es la diferencia entre revisar y creer.
 *
 * **El fichero no sale de este ordenador.** Se abre, se cruza y se parchea en el
 * navegador; lo único que viaja al servidor es el plan —qué celdas ganó el
 * Excel— y las filas leídas, que es lo que hace falta para poder contestar «¿de
 * dónde salió este dato?» seis meses después.
 */

import { supabase } from '@/lib/supabase'
import { construirIndice } from '@/domain/cruce'
import type { Catalogo } from '@/domain/cruce'
import { corteDeAnyo } from '@/domain/anyo'
import { hojaDeInventario, hojaDeMovimientos, hojaDeRevisiones, hojaDelParte } from '@/domain/hojasNuevas'
import type { LineaDelParte } from '@/domain/hojasNuevas'
import { escribirLibro } from '@/domain/libro'
import type { EdicionDeHoja, HojaNueva } from '@/domain/libro'
import {
  BOLSA_2025,
  BOLSA_2026,
  ESTADO,
  MATERIAL_2025,
  MATERIAL_2026,
  hojaPorNombre,
  hojasDelAnyo,
} from '@/domain/mapa'
import type { Hoja } from '@/domain/mapa'
import { columnaParaLaRef } from '@/domain/preparar'
import {
  resumir,
  sincronizarBolsa,
  sincronizarEstado,
  sincronizarPartes,
} from '@/domain/sincronizar'
import type { Instantanea, Plan, Resumen } from '@/domain/sincronizar'
import { leerMaterial } from '@/domain/valores'
import type { Valor } from '@/domain/valores'
import { abrirLibro, celdasCombinadas, leerHoja } from '@/domain/xlsx'
import type { Libro } from '@/domain/xlsx'
import { datosDeLaPasada } from './datosDeLaPasada'
import type { DatosDeLaPasada } from './datosDeLaPasada'
import { catalogoDelMaestro } from './catalogoDelMaestro'

export const ORIGEN = 'material_aulas'

export interface Analisis {
  libro: Libro
  nombre: string
  bytes: Uint8Array
  sha256: string
  anyo: number
  datos: DatosDeLaPasada
  planes: Plan[]
  resumenes: Resumen[]
  hojasNuevas: HojaNueva[]
  columnaRef: string
  /** Si alguna hoja no tiene la forma declarada, la pasada no puede empezar. */
  bloqueada: boolean
  /**
   * `true` si este fichero **no es** el que salió de la última pasada. No
   * prohíbe nada —puede haber un motivo— pero hay que decirlo antes de aplicar:
   * un libro viejo se parece a un lado que cambió, y la fusión revertiría en la
   * base el trabajo hecho desde entonces sin dar un solo error.
   */
  libroDesconocido: boolean
  /** Cuándo se produjo el libro que la aplicación esperaba, si lo hubo. */
  ultimaSalida: string | null
}

// -----------------------------------------------------------------------------
// 1 a 3 — Analizar
// -----------------------------------------------------------------------------

export async function analizar(fichero: File, hoy = new Date()): Promise<Analisis> {
  const bytes = new Uint8Array(await fichero.arrayBuffer())
  const libro = await abrirLibro(bytes)
  const anyo = hoy.getFullYear()

  const faltan = [ESTADO, MATERIAL_2026, BOLSA_2026].filter(
    (h) => !libro.hojas.some((x) => x.nombre === h.nombre),
  )
  if (faltan.length > 0) {
    throw new Error(
      `Este libro no tiene ${faltan.map((h) => `«${h.nombre}»`).join(', ')}. Sus hojas son: ${libro.hojas
        .map((h) => h.nombre)
        .join(', ')}`,
    )
  }

  const [catalogo, datos, salida] = await Promise.all([
    catalogoDelMaestro(),
    datosDeLaPasada(anyo),
    ultimaSalida(),
  ])
  const sha256 = await sha256De(bytes)
  const indice = construirIndice(catalogo as Catalogo)

  const filasEstado = await leerHoja(libro, ESTADO.nombre)
  const columnaRef = columnaParaLaRef(filasEstado, ESTADO.cabecera, 'Ref')

  const planes: Plan[] = []

  planes.push(
    sincronizarEstado({
      hoja: ESTADO,
      filas: filasEstado,
      salas: datos.salas,
      indice,
      columnaRef,
      combinadas: await celdasCombinadas(libro, ESTADO.nombre),
      instantanea: await instantaneaDe(ESTADO.nombre),
    }),
  )

  for (const hoja of [MATERIAL_2026, MATERIAL_2025] as Hoja[]) {
    if (!libro.hojas.some((h) => h.nombre === hoja.nombre)) continue
    planes.push(
      sincronizarPartes({
        hoja,
        filas: await leerHoja(libro, hoja.nombre),
        incidencias: datos.incidencias,
        instantanea: await instantaneaDe(hoja.nombre),
      }),
    )
  }

  for (const hoja of [BOLSA_2026, BOLSA_2025] as Hoja[]) {
    if (!libro.hojas.some((h) => h.nombre === hoja.nombre)) continue
    planes.push(
      sincronizarBolsa({
        hoja,
        filas: await leerHoja(libro, hoja.nombre),
        articulos: datos.articulos,
        resolver: datos.resolverArticulo,
        instantanea: await instantaneaDe(hoja.nombre),
      }),
    )
  }

  // Las hojas de detalle se rehacen enteras cada pasada. No son un historial que
  // haya que ir completando: son la foto de lo que la base sabe hoy, y
  // reconstruirlas cuesta menos que decidir qué fila cambió.
  const hojasNuevas: HojaNueva[] = []
  const corte = corteDeAnyo({
    anyo,
    hojasExistentes: libro.hojas.map((h) => h.nombre),
    articulos: [...datos.saldos.keys()].map((id) => ({
      nombre: datos.articulos.find((a) => a.id === id)?.nombre ?? '',
      nombreAlternativo: datos.nombresAlternativos.get(id) ?? null,
      saldo: datos.saldos.get(id) ?? 0,
    })).filter((a) => a.nombre !== ''),
  })
  hojasNuevas.push(...corte.hojas)

  return {
    libro,
    nombre: fichero.name,
    bytes,
    sha256,
    anyo,
    datos,
    planes,
    resumenes: planes.map(resumir),
    hojasNuevas,
    columnaRef,
    bloqueada: planes.some((p) => p.desajustes.length > 0),
    libroDesconocido: salida !== null && salida.sha256 !== sha256,
    ultimaSalida: salida?.cuando ?? null,
  }
}

/** El libro que salió de la última pasada, para saber si es éste el que se sube. */
async function ultimaSalida(): Promise<{ sha256: string; cuando: string } | null> {
  const { data, error } = await supabase.rpc('sync_ultima_salida')
  // Un servidor sin esta función es un servidor que todavía no ha sincronizado
  // nunca: no hay con qué comparar, y parar aquí sería romper la pantalla.
  if (error || !Array.isArray(data) || data.length === 0) return null
  const fila = data[0] as { sha256: string | null; cuando: string }
  return fila.sha256 ? { sha256: fila.sha256, cuando: fila.cuando } : null
}

/** El antepasado de cada celda de una hoja, de golpe. */
async function instantaneaDe(hoja: string): Promise<Instantanea> {
  const { data, error } = await supabase.rpc('sync_instantanea', { p_hoja: hoja })
  // Sin instantánea la fusión sigue funcionando: es la primera pasada, y manda
  // la app. Parar aquí convertiría un servidor viejo en una pantalla rota.
  if (error || !data) return () => undefined

  const mapa = new Map<string, string | null>()
  for (const c of data as Array<{ ref: string; columna: string; valor_base: string | null }>) {
    mapa.set(`${c.ref}!${c.columna}`, c.valor_base)
  }
  return (clave, letra) => {
    const k = `${clave}!${letra}`
    return mapa.has(k) ? mapa.get(k)! : undefined
  }
}

// -----------------------------------------------------------------------------
// 4 — Aplicar a la base
// -----------------------------------------------------------------------------

export interface Aplicado {
  parteId: number
  aplicadas: number
  rechazadas: number
}

/**
 * Las filas del libro tal y como venían, para `sync_filas`.
 *
 * Se saca aparte de `aplicar` para poder probarla: es la única parte de la carga
 * que agrupa, y agrupar mal aquí no da un dato raro, tira la pasada entera —el
 * RPC es una transacción, así que una fila mala se lleva por delante las otras
 * mil setecientas.
 *
 * **Las celdas de filas nuevas no entran.** `anotarCeldaNueva` las marca con
 * `fila: 0` a propósito, porque describen filas que todavía no existen en el
 * libro: valen para la instantánea, que se indexa por (hoja, ref, columna), y no
 * valen aquí, donde `fila` es el número de una fila que se leyó. Colarlas hacía
 * dos daños a la vez:
 *
 *  - `sync_filas` declara `check (fila > 0)` y rechazaba la fila, y con ella la
 *    pasada entera: «new row for relation "sync_filas" violates check constraint
 *    "sync_filas_fila_check"», sin decir de qué hoja ni de qué fila hablaba;
 *  - y antes de eso, la agrupación las fundía TODAS en una sola «fila 0»,
 *    quedándose con el `ref` de la primera y mezclando en un mismo `contenido`
 *    las celdas de salas, incidencias y artículos distintos. O sea que si la
 *    restricción no hubiera estado, el registro de procedencia habría guardado
 *    una fila que no existe con los datos de doscientas sesenta y cinco.
 *
 * No se pierde nada al dejarlas fuera: una fila nueva no estaba en el libro que
 * se leyó, así que no tiene procedencia que registrar. La tendrá en la pasada
 * siguiente, cuando ya sea una fila de verdad con su número.
 */
export function filasDeLaPasada(
  planes: Analisis['planes'],
): Array<{ hoja: string; fila: number; ref: string; contenido: Record<string, unknown> }> {
  const out: Array<{ hoja: string; fila: number; ref: string; contenido: Record<string, unknown> }> = []
  for (const p of planes) {
    // Por `Map` y no buscando dentro de un `reduce`: con las dos mil y pico
    // celdas de una pasada de verdad, el `some` dentro del bucle es cuadrático y
    // esto lo hace un iPad.
    const porFila = new Map<number, { hoja: string; fila: number; ref: string; contenido: Record<string, unknown> }>()
    for (const c of p.instantanea) {
      if (c.fila <= 0) continue
      const f = porFila.get(c.fila)
      if (f) f.contenido[c.letra] = c.valor
      else porFila.set(c.fila, { hoja: p.hoja, fila: c.fila, ref: c.clave, contenido: { [c.letra]: c.valor } })
    }
    out.push(...porFila.values())
  }
  return out
}

export async function aplicar(a: Analisis): Promise<Aplicado> {
  if (a.bloqueada) throw new Error('Hay hojas con la forma cambiada: la pasada no puede empezar')

  const { data: ficheroId, error: eF } = await supabase.rpc('sync_registrar_fichero', {
    p_origen: ORIGEN,
    p_nombre: a.nombre,
    p_sha256: a.sha256,
    p_bytes: a.bytes.length,
  })
  if (eF) throw new Error(`No se pudo registrar el fichero: ${eF.message}`)

  const plan = {
    fichero_id: ficheroId,
    origen: ORIGEN,
    disparo: 'manual',
    filas: filasDeLaPasada(a.planes),
    hacia_la_base: ordenarParaElAlmacen(a.planes.flatMap((p) =>
      p.haciaLaBase.map((h) => ({
        hoja: p.hoja,
        fila: h.fila,
        // De qué habla la fila. Sin esto, la base tiene que adivinarlo por el
        // nombre del campo, y `sala.code` significa dos cosas distintas según la
        // hoja: el código del aula en la de estado y el aula de un parte en la
        // de material. Adivinándolo, las correcciones de los partes se
        // rechazaban con un motivo falso —«la matrícula no existe»— y no entraba
        // ni una.
        entidad: entidadDe(p.hoja),
        clave: claveDe(p, h.fila),
        // La letra de la columna, para que la base pueda emparejar esta
        // corrección con su celda de la instantánea: la que se rechaza no debe
        // dejar antepasado, o la pasada siguiente creerá que la app la cambió y
        // borrará del libro lo que alguien escribió a mano.
        columna: h.letra,
        campo: h.campo,
        valor: h.valor === null ? null : String(h.valor),
        motivo: h.motivo,
        // De qué año habla la hoja. `Comprado` no es «lo comprado»: es lo
        // comprado **en 2026**, y sin el año la base lo cuadra contra la compra
        // de todos los tiempos y mete la diferencia con 2025 como una compra de
        // hoy —negativa, además, que el signo no la deja pasar.
        ...(hojaPorNombre(p.hoja)?.anyo ? { anyo: hojaPorNombre(p.hoja)!.anyo } : {}),
        // El material de un parte va ya partido y resuelto: el catálogo de alias
        // vive aquí, y partir «1Pantalla 240X240» en un 1 y una pantalla es
        // exactamente el tipo de cosa que en SQL sale mal.
        ...(h.campo === 'incidencia.material'
          ? { detalle: detalleDelMaterial(String(h.valor ?? ''), a.datos.resolverArticulo) }
          : {}),
      })),
    )),
    // Solo las que hablan del libro que ya está. Las que describen el que va a
    // salir esperan a que salga: ver `instantaneaDeLaSalida`.
    instantanea: celdasDeLaInstantanea(a, false),
    cuarentena: a.planes.flatMap((p) =>
      p.cuarentena.map((q) => ({
        hoja: p.hoja,
        fila: q.fila,
        clave: claveDe(p, q.fila) ?? q.destino,
        campo: q.campo,
        crudo: q.crudo === null ? null : String(q.crudo),
        motivo: q.motivo,
      })),
    ),
    resumen: {
      filas_leidas: a.resumenes.reduce((n, r) => n + r.filas, 0),
      sin_cambios: a.resumenes.reduce((n, r) => n + r.filas, 0),
      hacia_el_excel: a.resumenes.reduce((n, r) => n + r.celdasAlExcel, 0),
      conflictos: a.resumenes.reduce((n, r) => n + r.conflictos, 0),
      descuadres: a.planes.reduce((n, p) => n + p.avisos.filter((x) => x.includes('descuadre')).length, 0),
      altas: a.resumenes.reduce((n, r) => n + r.filasNuevas, 0),
    },
  }

  const { data, error } = await supabase.rpc('sync_aplicar', { p_plan: plan })
  if (error) throw new Error(`La pasada no se pudo aplicar: ${error.message}`)

  const r = data as { parte_id: number; aplicadas: number; rechazadas: number }
  return { parteId: r.parte_id, aplicadas: r.aplicadas, rechazadas: r.rechazadas }
}

/**
 * Las compras antes que los consumos.
 *
 * La base tiene un disparador que se niega a dejar el almacén en negativo, y
 * hace bien. Pero el orden natural de las hojas pone los partes —que consumen—
 * antes que la bolsa —que compra—, así que el material de un parte que la
 * aplicación no conocía se rechazaba por no haber existencias que en la misma
 * pasada, cuatro celdas más abajo, se iban a registrar. Con las compras delante,
 * el saldo ya está cuando llega el consumo.
 */
function ordenarParaElAlmacen<T extends { campo: string }>(celdas: T[]): T[] {
  const peso = (campo: string): number => {
    if (campo === 'articulo.comprado') return 0
    if (campo === 'incidencia.material') return 2
    return 1
  }
  return [...celdas].sort((a, b) => peso(a.campo) - peso(b.campo))
}

/** El material de un parte, partido y con cada artículo resuelto al catálogo. */
function detalleDelMaterial(
  texto: string,
  resolver: (nombre: string) => string | null,
): Array<{ articulo_id: string | null; cantidad: number; texto: string }> {
  return leerMaterial(texto).map((m) => ({
    articulo_id: resolver(m.articulo),
    cantidad: m.cantidad,
    texto: m.crudo,
  }))
}

/** De qué habla cada fila de una hoja: una sala, un parte o un artículo. */
function entidadDe(hoja: string): string {
  const h = hojaPorNombre(hoja)
  if (!h) return 'sala'
  return h.identidad.tipo === 'incidencia' ? 'incidencia' : h.identidad.tipo === 'articulo' ? 'articulo' : 'sala'
}

/**
 * Cómo se guarda un valor en la instantánea.
 *
 * `sync_celdas.valor_base` es `text`, así que todo pasa por una cadena. Y lo
 * que vuelva de ahí se compara con `canonizar`, que de un booleano saca «SI»:
 * guardar `String(true)` —«true»— hacía que el antepasado no coincidiera jamás
 * con la celda, y entonces toda columna de sí/no donde la app y la hoja
 * discreparan quedaba en **choque permanente**, porque los dos lados «habían
 * cambiado» respecto a un antepasado que no era ninguno de los dos.
 *
 * Lo demás se guarda tal cual, sin canonizar: la bandeja de choques enseña este
 * valor, y «CAMARA AVER» se lee peor que «Cámara Aver».
 */
export function paraLaInstantanea(valor: Valor): string | null {
  if (valor === null) return null
  if (typeof valor === 'boolean') return valor ? 'SI' : 'NO'
  return String(valor)
}

/**
 * Las celdas de la instantánea de una pasada, de un lado o del otro.
 *
 * `trasEscribir` separa dos cosas que no valen lo mismo: lo que el libro **dice**
 * —un hecho, se puede guardar ya— y lo que el libro **va a decir** cuando alguien
 * suba el fichero que sale de aquí. Guardar lo segundo antes de tiempo es lo que
 * hacía que una pasada que no llega a terminar dejara la base creyendo que el
 * Excel vale A cuando vale V, y la siguiente metiera la V en la base deshaciendo
 * el trabajo de la aplicación.
 */
function celdasDeLaInstantanea(a: Analisis, trasEscribir: boolean): unknown[] {
  return a.planes.flatMap((p) =>
    p.instantanea
      .filter((c) => (c.trasEscribir === true) === trasEscribir)
      .map((c) => ({
        hoja: p.hoja,
        clave: c.clave,
        columna: c.letra,
        entidad: entidadDe(p.hoja),
        valor: paraLaInstantanea(c.valor),
      })),
  )
}

/** La clave estable de una fila, buscada por su número dentro de un plan. */
function claveDe(p: Plan, fila: number): string {
  return p.instantanea.find((c) => c.fila === fila)?.clave ?? ''
}

// -----------------------------------------------------------------------------
// 5 — Escribir el libro
// -----------------------------------------------------------------------------

export async function escribir(a: Analisis, cuando: string, parteId?: number): Promise<Uint8Array> {
  const ediciones: EdicionDeHoja[] = a.planes
    .filter((p) => p.celdas.length > 0 || p.insertar.length > 0 || p.borrar.length > 0)
    .map((p) => ({
      hoja: p.hoja,
      celdas: p.celdas,
      filas: { insertar: p.insertar, borrar: p.borrar },
    }))

  const nuevas: HojaNueva[] = [
    ...a.hojasNuevas,
    hojaDeRevisiones(a.datos.revisiones),
    hojaDeMovimientos(a.datos.movimientos),
    hojaDeInventario(a.datos.equipos),
    hojaDelParte(lineasDelParte(a.planes), cuando),
  ]

  // Las de detalle se rehacen: si ya están, se quitan primero. Añadir una hoja
  // que ya existe es un error, y con razón.
  const existentes = new Set(a.libro.hojas.map((h) => h.nombre))
  const aAnadir = nuevas.filter((h) => !existentes.has(h.nombre))
  const aRehacer = nuevas.filter((h) => existentes.has(h.nombre))

  let bytes = await escribirLibro(a.libro, ediciones, aAnadir)

  if (aRehacer.length > 0) {
    // Rehacer una hoja de detalle es vaciarla y volver a escribirla: no se
    // pueden borrar hojas sin tocar los índices que otras cosas usan.
    const otra = await abrirLibro(bytes)
    bytes = await escribirLibro(
      otra,
      await Promise.all(
        aRehacer.map(async (h) => rehacer(h, await ultimaFilaDe(otra, h.nombre))),
      ),
      [],
    )
  }

  // Se apunta qué libro salió de aquí. Es lo único que permite avisar la vez
  // siguiente de que se está subiendo otro.
  if (parteId !== undefined) {
    const { error } = await supabase.rpc('sync_apuntar_salida', {
      p_parte_id: parteId,
      p_sha256: await sha256De(bytes),
      // Y aquí, y no antes, los antepasados de las celdas que se han escrito: el
      // fichero ya existe, así que la promesa se puede guardar. Si esto falla,
      // lo que se pierde es que la pasada siguiente vuelva a proponer las mismas
      // escrituras, que es lo seguro.
      p_instantanea: celdasDeLaInstantanea(a, true),
    })
    // Que no se pueda apuntar no invalida la pasada: el libro ya está bien y la
    // base también. Se pierde el aviso de la vez siguiente, y nada más.
    if (error) console.warn('No se pudo apuntar el libro de salida:', error.message)
  }

  return bytes
}

/** La última fila que existe en el XML de una hoja. Cero si solo hay cabecera. */
async function ultimaFilaDe(libro: Libro, nombre: string): Promise<number> {
  const filas = await leerHoja(libro, nombre)
  return filas.reduce((max, f) => Math.max(max, f.fila), 0)
}

/**
 * Vaciar una hoja de detalle y volver a escribirla.
 *
 * Se borran todas las filas menos la cabecera y se insertan las nuevas. Es más
 * bruto que comparar fila a fila, y es lo correcto: estas hojas no tienen
 * identidad de fila —un movimiento de almacén no tiene matrícula— así que
 * «cuál cambió» no es una pregunta que se pueda contestar. Y como nadie las
 * edita a mano, no hay nada que perder.
 *
 * El borrado es la mitad que faltaba, y sin él esto no vaciaba nada: insertaba.
 * «Sincronización» pasaba de 336 filas a 671 en la segunda pasada y a 1.006 en
 * la tercera, con el mismo contenido repetido, y el libro engordaba sin techo.
 *
 * `estiloDe: 2` es la otra mitad: una fila que entra detrás de la 1 hereda el
 * estilo de la 1, que es la cabecera. Sin decirlo, la hoja entera salía en
 * negrita y con el fondo del encabezado.
 */
function rehacer(hoja: HojaNueva, ultima: number): EdicionDeHoja {
  const borrar: number[] = []
  for (let f = 2; f <= ultima; f++) borrar.push(f)

  return {
    hoja: hoja.nombre,
    filas: {
      borrar,
      insertar: hoja.filas.slice(1).map((valores) => ({
        tras: 1,
        // La 2 de la hoja de antes: se lee de la copia original de estilos, que
        // se saca antes de borrar nada, así que sigue estando aunque se borre.
        // Si la hoja venía solo con cabecera no hay de dónde copiar y se queda
        // con el de la 1, que es lo que hacía siempre.
        ...(ultima >= 2 ? { estiloDe: 2 } : {}),
        celdas: valores
          .map((v, i) => ({ celda: `${letra(i + 1)}2`, valor: v }))
          .filter((c) => c.valor !== null),
      })),
    },
  }
}

function letra(n: number): string {
  let s = ''
  let x = n
  while (x > 0) {
    const r = (x - 1) % 26
    s = String.fromCharCode(65 + r) + s
    x = Math.floor((x - 1) / 26)
  }
  return s
}

/** Lo que la pasada no pudo decidir, para la hoja `Sincronización`. */
export function lineasDelParte(planes: Plan[]): LineaDelParte[] {
  const out: LineaDelParte[] = []
  for (const p of planes) {
    for (const c of p.conflictos) {
      out.push({
        hoja: p.hoja,
        celda: `${c.letra}${c.fila}`,
        que: 'Choque',
        detalle: `${c.destino}: la aplicación dice «${c.base ?? ''}» y la hoja «${c.excel ?? ''}». No se ha tocado ninguno de los dos.`,
      })
    }
    for (const q of p.cuarentena) {
      out.push({
        hoja: p.hoja,
        celda: `${q.letra}${q.fila}`,
        que: 'No se puede leer',
        detalle: `${q.destino}: ${q.motivo}`,
      })
    }
    for (const s of p.sinCruzar) {
      out.push({ hoja: p.hoja, celda: `${s.fila}`, que: 'Sin cruzar', detalle: s.motivo })
    }
    // Y lo que la pasada HIZO por su cuenta: mudanzas, altas, bajas, filas que
    // cruzaron por número de serie, fórmulas devueltas. No está pendiente, pero
    // es lo primero que quiere saber quien abre el libro y ve que una sala ya no
    // está donde estaba. La celda va delante del texto cuando el aviso la trae
    // («Fila 2: …», «N5 (…): …»).
    for (const a of p.avisos) {
      const m = /^(?:Fila (\d+)|([A-Z]+\d+))\s*(?:\([^)]*\))?:\s*/.exec(a)
      out.push({
        hoja: p.hoja,
        celda: m ? (m[1] ?? m[2] ?? '') : '',
        que: 'Aviso',
        detalle: m ? a.slice(m[0].length) : a,
      })
    }
  }
  return out
}

// -----------------------------------------------------------------------------

/** El hash del fichero, que es lo que hace idempotente registrar el mismo libro. */
export async function sha256De(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Las hojas que la pasada va a crear porque cambió el año. */
export function hojasDelCorte(anyo: number): { material: string; bolsa: string } {
  return hojasDelAnyo(anyo)
}
