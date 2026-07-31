import { describe, expect, it } from 'vitest'
import { descargaEntera, type Pagina } from './paginada'

/** Un servidor de mentira con `total` filas y, si se pide, un tope por respuesta. */
function servidor(total: number, tope?: number) {
  const llamadas: Array<[number, number]> = []
  const porPagina = (desde: number, hasta: number): Promise<Pagina<number>> => {
    llamadas.push([desde, hasta])
    const fin = Math.min(hasta + 1, total, tope !== undefined ? desde + tope : Infinity)
    const data = Array.from({ length: Math.max(0, fin - desde) }, (_, i) => desde + i)
    return Promise.resolve({ data, error: null })
  }
  return { porPagina, llamadas }
}

describe('descargaEntera', () => {
  it('con menos filas que una página, una sola petición y completa', async () => {
    const { porPagina, llamadas } = servidor(3)
    const res = await descargaEntera(porPagina, 10)
    expect(res.data).toEqual([0, 1, 2])
    expect(res.completa).toBe(true)
    expect(llamadas).toEqual([[0, 9]])
  })

  it('sigue pidiendo hasta la página corta y junta el conjunto entero', async () => {
    // El caso del tope de PostgREST: 25 filas con páginas de 10 son tres
    // peticiones, y sin la tercera las últimas cinco no existirían para nadie.
    const { porPagina, llamadas } = servidor(25)
    const res = await descargaEntera(porPagina, 10)
    expect(res.data).toHaveLength(25)
    expect(res.completa).toBe(true)
    expect(llamadas).toHaveLength(3)
  })

  it('un total exacto de página pide una más para confirmar el final', async () => {
    // 20 filas en páginas de 10: la segunda llega llena, así que no se puede
    // saber si es el final o el tope callándose. La tercera, vacía, lo dice.
    const { porPagina, llamadas } = servidor(20)
    const res = await descargaEntera(porPagina, 10)
    expect(res.data).toHaveLength(20)
    expect(res.completa).toBe(true)
    expect(llamadas).toHaveLength(3)
  })

  it('un fallo a mitad devuelve lo recibido pero NUNCA como completo', async () => {
    // Es la regla que protege la poda: media descarga sirve para escribir,
    // no para deducir que algo ya no existe.
    let n = 0
    const res = await descargaEntera<number>((desde) => {
      n++
      if (n === 2) return Promise.resolve({ data: null, error: { message: 'se fue la red' } })
      return Promise.resolve({ data: Array.from({ length: 10 }, (_, i) => desde + i), error: null })
    }, 10)

    expect(res.data).toHaveLength(10)
    expect(res.completa).toBe(false)
    expect(res.error?.message).toBe('se fue la red')
  })

  it('un lanzamiento del cliente se trata como el mismo fallo temporal', async () => {
    const res = await descargaEntera<number>(() => Promise.reject(new Error('Failed to fetch')), 10)
    expect(res.data).toBeNull()
    expect(res.completa).toBe(false)
    expect(res.error?.message).toBe('Failed to fetch')
  })

  it('el error de la primera página no inventa un conjunto vacío', async () => {
    // `data: null` y no `[]`: una lista vacía con error se leería como «la
    // tabla está vacía», que es justo la confusión que el pull diagnostica.
    const res = await descargaEntera<number>(
      () => Promise.resolve({ data: null, error: { message: 'RLS' } }),
      10,
    )
    expect(res.data).toBeNull()
    expect(res.completa).toBe(false)
  })
})
