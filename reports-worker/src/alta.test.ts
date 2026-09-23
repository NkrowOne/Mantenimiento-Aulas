/**
 * El canje del código de alta, en lo único que aquí puede torcerse sin que se
 * note: confundir «no he podido mirar» con «no está».
 *
 * Pasó. El worker no llegaba a la base, la consulta del perfil volvía con
 * `data: null` —igual que un email que no existe—, y la pantalla de alta decía
 * «Email o código incorrectos». La persona volvió a teclearlo, se pidió otro
 * código, y nada podía funcionar: el código estaba bien.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Lo que devuelve cada consulta, por tabla. */
let respuestas: Record<string, { data: unknown; error: { message: string } | null }> = {}

/** Un Supabase de mentira: cualquier cadena de filtros acaba en lo que diga la tabla. */
function supabaseFalso(): unknown {
  const cadena = (tabla: string): unknown => {
    const fin = (): Promise<unknown> => Promise.resolve(respuestas[tabla] ?? { data: null, error: null })
    const proxy: Record<string, unknown> = {}
    for (const m of ['select', 'ilike', 'eq', 'is', 'gt', 'update']) proxy[m] = () => proxy
    proxy['maybeSingle'] = fin
    proxy['then'] = (ok: (v: unknown) => unknown) => fin().then(ok)
    return proxy
  }
  return {
    from: (tabla: string) => cadena(tabla),
    auth: { admin: { updateUserById: () => Promise.resolve({ error: null }) } },
  }
}

vi.mock('./api.js', () => ({
  apiQueResponde: () => Promise.resolve({ ok: true, admin: supabaseFalso(), de: 'SUPABASE_UPSTREAM' }),
}))

/*
 * La clave ANTES de importar: `alta.ts` la lee al cargarse. Puesta en un
 * `beforeEach`, llegaba tarde, el módulo arrancaba sin clave, y TODAS las
 * pruebas acababan en el 503 de «no hay cliente» — las del 503 pasaban por el
 * motivo equivocado y solo las del 400 lo delataban.
 */
process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'clave'
const { canjearAlta } = await import('./alta')

/** Una respuesta HTTP de mentira que apunta lo que se le escribe. */
function respuesta(): { res: ServerResponse; status: () => number; cuerpo: () => { ok?: boolean; error?: string } } {
  let status = 0
  let texto = ''
  const res = {
    writeHead(s: number) {
      status = s
      return res
    },
    end(t: string) {
      texto = t
      return res
    },
  }
  return {
    res: res as unknown as ServerResponse,
    status: () => status,
    cuerpo: () => JSON.parse(texto || '{}') as { ok?: boolean; error?: string },
  }
}

const peticion = { headers: { 'user-agent': 'iPhone' } } as unknown as IncomingMessage
const cuerpo = (email: string, code: string): Buffer => Buffer.from(JSON.stringify({ email, code }))

beforeEach(() => {
  respuestas = {}
})

afterEach(() => {
  vi.useRealTimers()
})

describe('canjear un código cuando el servidor no llega a la base', () => {
  it('NO dice «código incorrecto» si no ha podido leer el perfil', async () => {
    respuestas['profiles'] = { data: null, error: { message: 'fetch failed' } }
    const r = respuesta()
    await canjearAlta(peticion, r.res, cuerpo('pdebergia@oesia.com', 'WAZU-RXYE-AG6P'))

    expect(r.status()).toBe(503)
    expect(r.cuerpo().error).toMatch(/No es tu código/)
    expect(r.cuerpo().error).not.toMatch(/incorrectos/)
  })

  it('ni si ha leído el perfil pero no ha podido leer el código', async () => {
    respuestas['profiles'] = { data: { id: 'p-1' }, error: null }
    respuestas['enrollment_codes'] = { data: null, error: { message: 'connect ECONNREFUSED' } }
    const r = respuesta()
    await canjearAlta(peticion, r.res, cuerpo('pdebergia@oesia.com', 'WAZU-RXYE-AG6P'))

    expect(r.status()).toBe(503)
    expect(r.cuerpo().error).toMatch(/No es tu código/)
  })

  it('y el mensaje no cuenta por dentro contra qué dirección falla: la ruta es pública', async () => {
    respuestas['profiles'] = { data: null, error: { message: 'getaddrinfo ENOTFOUND kong' } }
    const r = respuesta()
    await canjearAlta(peticion, r.res, cuerpo('pdebergia@oesia.com', 'WAZU-RXYE-AG6P'))

    expect(r.cuerpo().error).not.toMatch(/kong|SUPABASE|ENOTFOUND/)
  })
})

describe('y cuando sí ha mirado', () => {
  it('un código que no está sigue siendo un código incorrecto', async () => {
    vi.useFakeTimers()
    respuestas['profiles'] = { data: { id: 'p-1' }, error: null }
    respuestas['enrollment_codes'] = { data: null, error: null }
    const r = respuesta()
    const hecho = canjearAlta(peticion, r.res, cuerpo('pdebergia@oesia.com', 'MAL0-MAL0-MAL0'))
    await vi.runAllTimersAsync()
    await hecho

    expect(r.status()).toBe(400)
    expect(r.cuerpo().error).toMatch(/incorrectos/)
  })

  it('y un email que no existe, también', async () => {
    vi.useFakeTimers()
    respuestas['profiles'] = { data: null, error: null }
    const r = respuesta()
    const hecho = canjearAlta(peticion, r.res, cuerpo('nadie@oesia.com', 'WAZU-RXYE-AG6P'))
    await vi.runAllTimersAsync()
    await hecho

    expect(r.status()).toBe(400)
  })
})
