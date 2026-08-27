import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { crc32, descomprimir, escribirZip, leerZip, reemplazar } from './zip'

/** El libro real, si está a mano. Las pruebas que lo usan se saltan si no. */
const LIBRO = process.env.LIBRO_XLSX
const libro = LIBRO ? readFileSync(LIBRO) : null

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const texto = (b: Uint8Array): string => new TextDecoder().decode(b)

async function zipDePrueba(): Promise<Uint8Array> {
  const base = {
    metodo: 8,
    banderas: 0,
    fecha: 0x5a21,
    hora: 0x1234,
    versionCreacion: 20,
    versionNecesaria: 20,
    atributosInternos: 0,
    atributosExternos: 0,
    extraLocal: new Uint8Array(0),
    extraCentral: new Uint8Array(0),
    comentario: new Uint8Array(0),
    crc32: 0,
    comprimido: new Uint8Array(0),
    tamanoOriginal: 0,
  }
  const uno = await reemplazar({ ...base, nombre: 'uno.xml' }, bytes('<a>1</a>'))
  const dos = await reemplazar({ ...base, nombre: 'dos.xml' }, bytes('<b>2</b>'))
  return escribirZip([uno, dos])
}

describe('el zip da la vuelta entera', () => {
  it('lo que se escribe se vuelve a leer igual', async () => {
    const entradas = leerZip(await zipDePrueba())
    expect(entradas.map((e) => e.nombre)).toEqual(['uno.xml', 'dos.xml'])
    expect(texto(await descomprimir(entradas[0]!))).toBe('<a>1</a>')
    expect(texto(await descomprimir(entradas[1]!))).toBe('<b>2</b>')
  })

  it('el orden de las entradas se conserva', async () => {
    const entradas = leerZip(await zipDePrueba())
    const vuelta = leerZip(escribirZip(entradas))
    expect(vuelta.map((e) => e.nombre)).toEqual(entradas.map((e) => e.nombre))
  })

  it('reescribir sin cambiar nada devuelve los mismos bytes', async () => {
    // Es la propiedad que sostiene toda la promesa: si una vuelta completa sin
    // tocar nada ya moviera bytes, no habría forma de saber qué cambió de verdad.
    const original = await zipDePrueba()
    expect(escribirZip(leerZip(original))).toEqual(original)
  })

  it('cambiar una entrada deja la otra byte a byte idéntica', async () => {
    const entradas = leerZip(await zipDePrueba())
    const antes = entradas[1]!.comprimido
    entradas[0] = await reemplazar(entradas[0]!, bytes('<a>MODIFICADO</a>'))
    const vuelta = leerZip(escribirZip(entradas))
    expect(vuelta[1]!.comprimido).toEqual(antes)
    expect(texto(await descomprimir(vuelta[0]!))).toBe('<a>MODIFICADO</a>')
  })

  it('el CRC de lo modificado se recalcula', async () => {
    const entradas = leerZip(await zipDePrueba())
    const nueva = await reemplazar(entradas[0]!, bytes('otra cosa'))
    expect(nueva.crc32).toBe(crc32(bytes('otra cosa')))
    expect(nueva.crc32).not.toBe(entradas[0]!.crc32)
  })

  it('la fecha y los atributos de la entrada modificada no se pierden', async () => {
    const entradas = leerZip(await zipDePrueba())
    const nueva = await reemplazar(entradas[0]!, bytes('x'))
    expect(nueva.fecha).toBe(entradas[0]!.fecha)
    expect(nueva.hora).toBe(entradas[0]!.hora)
    expect(nueva.atributosExternos).toBe(entradas[0]!.atributosExternos)
  })
})

describe('lo que no se sabe hacer se dice', () => {
  it('un fichero que no es un zip no se intenta interpretar', () => {
    expect(() => leerZip(bytes('esto no es un zip'))).toThrow(/no es un fichero .zip/i)
  })

  it('un zip truncado tampoco', async () => {
    const z = await zipDePrueba()
    expect(() => leerZip(z.slice(0, z.length - 10))).toThrow()
  })
})

describe('el CRC-32 es el de verdad', () => {
  it('coincide con el valor conocido de «123456789»', () => {
    expect(crc32(bytes('123456789')) >>> 0).toBe(0xcbf43926)
  })

  it('el de la cadena vacía es cero', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })
})

describe.skipIf(!libro)('sobre el libro real', () => {
  it('se lee entero y vuelve idéntico si no se toca nada', () => {
    const entradas = leerZip(new Uint8Array(libro!))
    expect(entradas.length).toBeGreaterThan(10)
    const vuelta = leerZip(escribirZip(entradas))
    expect(vuelta.map((e) => e.nombre)).toEqual(entradas.map((e) => e.nombre))
    for (let i = 0; i < entradas.length; i++) {
      expect(vuelta[i]!.comprimido).toEqual(entradas[i]!.comprimido)
      expect(vuelta[i]!.crc32).toBe(entradas[i]!.crc32)
    }
  })

  it('sigue teniendo lo que una librería de zip normal se lleva por delante', () => {
    const nombres = leerZip(new Uint8Array(libro!)).map((e) => e.nombre)
    expect(nombres).toContain('[Content_Types].xml')
    // Las piezas que no son OOXML y que regenerar el libro destruye en silencio.
    expect(nombres.some((n) => /customXml/i.test(n))).toBe(true)
  })
})
