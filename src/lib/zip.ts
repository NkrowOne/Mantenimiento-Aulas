/**
 * Leer y escribir un `.zip` conservando intacto lo que no se toca.
 *
 * Un `.xlsx` es un zip de ficheros XML, y toda la sincronización descansa en una
 * promesa: **el libro vuelve como estaba salvo en las celdas que cambian**. Eso
 * no se consigue con cualquier librería de zip. Las normales descomprimen todo,
 * te dan los ficheros y vuelven a comprimir al guardar; aunque el contenido sea
 * idéntico, los bytes no lo son, y por el camino se pierde lo que la librería no
 * entiende — que en este libro incluye la **etiqueta de confidencialidad de
 * Purview** y los **seis ficheros de metadatos de SharePoint**.
 *
 * Aquí las entradas que no se tocan se copian **con sus bytes comprimidos tal
 * cual**: no se descomprimen ni se vuelven a comprimir, así que no hay nada que
 * perder ni interpretación que equivocar. Solo la entrada modificada se
 * comprime, y con `CompressionStream`, que viene en el navegador y en Node: cero
 * dependencias nuevas en una PWA.
 *
 * Lo que este lector **no** admite lo dice y se para, en vez de producir un zip
 * corrupto que nadie mira hasta que Excel se niega a abrirlo:
 *
 *  - **Zip64** (más de 65.535 entradas o campos de 4 GB). Los libros de este
 *    proyecto tienen decenas de entradas y pesan cientos de kB.
 *  - **Cifrado**. Un libro protegido con contraseña no es un zip normal.
 */

// -----------------------------------------------------------------------------
// Lo que hace falta guardar de cada entrada
// -----------------------------------------------------------------------------

export interface EntradaZip {
  nombre: string
  /** 0 = almacenado, 8 = deflate. Cualquier otro se copia igual, sin leerlo. */
  metodo: number
  crc32: number
  /** Los bytes tal y como estaban en el fichero. No se tocan si no hace falta. */
  comprimido: Uint8Array
  tamanoOriginal: number
  banderas: number
  fecha: number
  hora: number
  versionCreacion: number
  versionNecesaria: number
  atributosInternos: number
  atributosExternos: number
  /**
   * El campo «extra» va por duplicado a propósito: el de la cabecera local y el
   * del directorio central **no tienen por qué ser iguales**, y Excel los usa de
   * forma distinta. Copiarlos cruzados produce un zip que abre pero pierde
   * metadatos.
   */
  extraLocal: Uint8Array
  extraCentral: Uint8Array
  comentario: Uint8Array
}

const FIRMA_LOCAL = 0x04034b50
const FIRMA_CENTRAL = 0x02014b50
const FIRMA_FIN = 0x06054b50
const MAX32 = 0xffffffff

// -----------------------------------------------------------------------------
// CRC-32, que hay que recalcular en lo que se modifica
// -----------------------------------------------------------------------------

const TABLA_CRC = ((): Uint32Array => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

export function crc32(datos: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < datos.length; i++) {
    c = TABLA_CRC[(c ^ datos[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

// -----------------------------------------------------------------------------
// Leer
// -----------------------------------------------------------------------------

/**
 * Lee el zip entero. No descomprime nada: eso se pide después y solo de lo que
 * se vaya a mirar.
 */
export function leerZip(bytes: Uint8Array): EntradaZip[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // El final del zip se busca hacia atrás porque puede llevar comentario detrás.
  let fin = -1
  const desde = Math.max(0, bytes.length - 22 - 0xffff)
  for (let i = bytes.length - 22; i >= desde; i--) {
    if (v.getUint32(i, true) === FIRMA_FIN) {
      fin = i
      break
    }
  }
  if (fin < 0) throw new Error('Esto no es un fichero .zip válido: no aparece el final del directorio')

  const nEntradas = v.getUint16(fin + 10, true)
  const inicioCentral = v.getUint32(fin + 16, true)
  if (nEntradas === 0xffff || inicioCentral === MAX32) {
    throw new Error('El fichero usa Zip64 y este lector no lo admite')
  }

  const entradas: EntradaZip[] = []
  let p = inicioCentral

  for (let i = 0; i < nEntradas; i++) {
    if (v.getUint32(p, true) !== FIRMA_CENTRAL) {
      throw new Error(`El directorio central está corrupto en la entrada ${i + 1}`)
    }
    const versionCreacion = v.getUint16(p + 4, true)
    const versionNecesaria = v.getUint16(p + 6, true)
    const banderas = v.getUint16(p + 8, true)
    const metodo = v.getUint16(p + 10, true)
    const hora = v.getUint16(p + 12, true)
    const fecha = v.getUint16(p + 14, true)
    const crc = v.getUint32(p + 16, true)
    const tamComprimido = v.getUint32(p + 20, true)
    const tamOriginal = v.getUint32(p + 24, true)
    const lenNombre = v.getUint16(p + 28, true)
    const lenExtra = v.getUint16(p + 30, true)
    const lenComentario = v.getUint16(p + 32, true)
    const atributosInternos = v.getUint16(p + 36, true)
    const atributosExternos = v.getUint32(p + 38, true)
    const offsetLocal = v.getUint32(p + 42, true)

    if (banderas & 0x1) throw new Error('El fichero está cifrado y no se puede tocar sin la contraseña')
    if (tamComprimido === MAX32 || tamOriginal === MAX32 || offsetLocal === MAX32) {
      throw new Error('El fichero usa Zip64 y este lector no lo admite')
    }

    const nombre = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + lenNombre))
    const extraCentral = bytes.slice(p + 46 + lenNombre, p + 46 + lenNombre + lenExtra)
    const comentario = bytes.slice(
      p + 46 + lenNombre + lenExtra,
      p + 46 + lenNombre + lenExtra + lenComentario,
    )

    // La cabecera local dice dónde empiezan los datos de verdad: sus campos de
    // nombre y extra pueden tener longitudes distintas de las del central.
    if (v.getUint32(offsetLocal, true) !== FIRMA_LOCAL) {
      throw new Error(`La cabecera de «${nombre}» no está donde dice el directorio`)
    }
    const lenNombreLocal = v.getUint16(offsetLocal + 26, true)
    const lenExtraLocal = v.getUint16(offsetLocal + 28, true)
    const inicioDatos = offsetLocal + 30 + lenNombreLocal + lenExtraLocal
    const extraLocal = bytes.slice(offsetLocal + 30 + lenNombreLocal, inicioDatos)

    entradas.push({
      nombre,
      metodo,
      crc32: crc,
      // Los tamaños se toman del directorio central y no de la cabecera local:
      // con descriptor de datos (bandera 3) la local los lleva a cero.
      comprimido: bytes.slice(inicioDatos, inicioDatos + tamComprimido),
      tamanoOriginal: tamOriginal,
      // Y esa bandera se limpia al escribir, porque los tamaños ya se conocen.
      banderas: banderas & ~0x8,
      fecha,
      hora,
      versionCreacion,
      versionNecesaria,
      atributosInternos,
      atributosExternos,
      extraLocal,
      extraCentral,
      comentario,
    })

    p += 46 + lenNombre + lenExtra + lenComentario
  }

  return entradas
}

// -----------------------------------------------------------------------------
// Comprimir y descomprimir, con lo que ya trae la plataforma
// -----------------------------------------------------------------------------

async function porStream(
  datos: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  // Los tipos DOM declaran el lado de escritura como `BufferSource`, que en
  // TypeScript reciente no acepta un `Uint8Array` cualquiera. Es solo la firma:
  // lo que se escribe es exactamente lo que espera.
  const escritor = stream.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>
  // `void` a propósito: si se espera aquí, el búfer interno se llena y el
  // escritor no vuelve hasta que alguien lea, que es esta misma función.
  void escritor.write(datos).then(() => escritor.close())

  const trozos: Uint8Array[] = []
  let total = 0
  const lector = (stream.readable as ReadableStream<Uint8Array>).getReader()
  for (;;) {
    const { done, value } = await lector.read()
    if (done) break
    trozos.push(value)
    total += value.length
  }
  const out = new Uint8Array(total)
  let o = 0
  for (const t of trozos) {
    out.set(t, o)
    o += t.length
  }
  return out
}

/** Los bytes de verdad de una entrada. */
export async function descomprimir(e: EntradaZip): Promise<Uint8Array> {
  if (e.metodo === 0) return e.comprimido
  if (e.metodo !== 8) throw new Error(`«${e.nombre}» usa un método de compresión desconocido (${e.metodo})`)
  return porStream(e.comprimido, new DecompressionStream('deflate-raw'))
}

/**
 * Sustituye el contenido de una entrada, conservando **todo lo demás** de la
 * original: fecha, atributos, y los dos campos extra. Solo cambian los bytes,
 * su tamaño y el CRC.
 */
export async function reemplazar(original: EntradaZip, datos: Uint8Array): Promise<EntradaZip> {
  const comprimido = await porStream(datos, new CompressionStream('deflate-raw'))
  return {
    ...original,
    metodo: 8,
    crc32: crc32(datos),
    comprimido,
    tamanoOriginal: datos.length,
  }
}

// -----------------------------------------------------------------------------
// Escribir
// -----------------------------------------------------------------------------

/**
 * Vuelve a montar el zip. El orden de las entradas se respeta: algunos lectores
 * de OOXML esperan `[Content_Types].xml` al principio, y reordenar por casualidad
 * es una forma barata de romper un fichero que abría bien.
 */
export function escribirZip(entradas: EntradaZip[]): Uint8Array {
  const nombres = entradas.map((e) => new TextEncoder().encode(e.nombre))

  let tamano = 22
  entradas.forEach((e, i) => {
    tamano += 30 + nombres[i]!.length + e.extraLocal.length + e.comprimido.length
    tamano += 46 + nombres[i]!.length + e.extraCentral.length + e.comentario.length
  })

  const out = new Uint8Array(tamano)
  const v = new DataView(out.buffer)
  const offsets: number[] = []
  let p = 0

  entradas.forEach((e, i) => {
    const nombre = nombres[i]!
    offsets.push(p)
    v.setUint32(p, FIRMA_LOCAL, true)
    v.setUint16(p + 4, e.versionNecesaria, true)
    v.setUint16(p + 6, e.banderas, true)
    v.setUint16(p + 8, e.metodo, true)
    v.setUint16(p + 10, e.hora, true)
    v.setUint16(p + 12, e.fecha, true)
    v.setUint32(p + 14, e.crc32, true)
    v.setUint32(p + 18, e.comprimido.length, true)
    v.setUint32(p + 22, e.tamanoOriginal, true)
    v.setUint16(p + 26, nombre.length, true)
    v.setUint16(p + 28, e.extraLocal.length, true)
    p += 30
    out.set(nombre, p); p += nombre.length
    out.set(e.extraLocal, p); p += e.extraLocal.length
    out.set(e.comprimido, p); p += e.comprimido.length
  })

  const inicioCentral = p

  entradas.forEach((e, i) => {
    const nombre = nombres[i]!
    v.setUint32(p, FIRMA_CENTRAL, true)
    v.setUint16(p + 4, e.versionCreacion, true)
    v.setUint16(p + 6, e.versionNecesaria, true)
    v.setUint16(p + 8, e.banderas, true)
    v.setUint16(p + 10, e.metodo, true)
    v.setUint16(p + 12, e.hora, true)
    v.setUint16(p + 14, e.fecha, true)
    v.setUint32(p + 16, e.crc32, true)
    v.setUint32(p + 20, e.comprimido.length, true)
    v.setUint32(p + 24, e.tamanoOriginal, true)
    v.setUint16(p + 28, nombre.length, true)
    v.setUint16(p + 30, e.extraCentral.length, true)
    v.setUint16(p + 32, e.comentario.length, true)
    v.setUint16(p + 34, 0, true) // número de disco
    v.setUint16(p + 36, e.atributosInternos, true)
    v.setUint32(p + 38, e.atributosExternos, true)
    v.setUint32(p + 42, offsets[i]!, true)
    p += 46
    out.set(nombre, p); p += nombre.length
    out.set(e.extraCentral, p); p += e.extraCentral.length
    out.set(e.comentario, p); p += e.comentario.length
  })

  v.setUint32(p, FIRMA_FIN, true)
  v.setUint16(p + 4, 0, true)
  v.setUint16(p + 6, 0, true)
  v.setUint16(p + 8, entradas.length, true)
  v.setUint16(p + 10, entradas.length, true)
  v.setUint32(p + 12, p - inicioCentral, true)
  v.setUint32(p + 16, inicioCentral, true)
  v.setUint16(p + 20, 0, true)

  return out
}
