/**
 * Un fallo de red y un token malo llegan igual —como `error`— y confundirlos
 * manda a la persona equivocada a arreglar lo que no es.
 *
 * Eso es lo que pasó: el worker no llegaba a Supabase y la pantalla decía «La
 * sesión no vale o ha caducado». Quien lo leyó cerró sesión, volvió a entrar
 * con su PIN, y le salió lo mismo — porque su sesión estaba perfecta.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { deQuienEsLaSesion, esFalloDeRed, urlsDeLaApi } from './api'

/** Un Supabase de mentira que contesta lo que se le diga a `auth.getUser`. */
const fingir = (r: unknown): SupabaseClient =>
  ({ auth: { getUser: () => Promise.resolve(r) } }) as unknown as SupabaseClient

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('por dónde se intenta llegar a la API', () => {
  it('la explícita primero y la de la red interna detrás', () => {
    vi.stubEnv('SUPABASE_URL', 'https://publico.example')
    vi.stubEnv('SUPABASE_UPSTREAM', 'kong:8000')
    expect(urlsDeLaApi()).toEqual([
      { url: 'https://publico.example', de: 'SUPABASE_URL' },
      { url: 'http://kong:8000', de: 'SUPABASE_UPSTREAM' },
    ])
  })

  it('al upstream se le pone esquema, que viene como host:puerto', () => {
    vi.stubEnv('SUPABASE_URL', '')
    vi.stubEnv('SUPABASE_UPSTREAM', 'kong.railway.internal:8000')
    expect(urlsDeLaApi()).toEqual([
      { url: 'http://kong.railway.internal:8000', de: 'SUPABASE_UPSTREAM' },
    ])
  })

  it('y si ya lo trae, se respeta', () => {
    vi.stubEnv('SUPABASE_URL', '')
    vi.stubEnv('SUPABASE_UPSTREAM', 'https://kong.interno')
    expect(urlsDeLaApi()[0]?.url).toBe('https://kong.interno')
  })

  it('la misma dirección dos veces es una sola candidata', () => {
    vi.stubEnv('SUPABASE_URL', 'http://kong:8000')
    vi.stubEnv('SUPABASE_UPSTREAM', 'kong:8000')
    expect(urlsDeLaApi()).toHaveLength(1)
  })

  it('sin ninguna variable, ninguna candidata', () => {
    vi.stubEnv('SUPABASE_URL', '')
    vi.stubEnv('SUPABASE_UPSTREAM', '')
    expect(urlsDeLaApi()).toEqual([])
  })
})

describe('distinguir «ha dicho que no» de «no ha contestado»', () => {
  it('un token malo es un token malo', async () => {
    const r = await deQuienEsLaSesion(
      fingir({ data: { user: null }, error: { message: 'invalid JWT' } }),
      'x',
    )
    expect(r).toEqual({ que: 'no vale' })
  })

  it('pero «fetch failed» NO es un token malo', async () => {
    // El fallo entero. Decir «tu sesión ha caducado» aquí es acusar a quien no
    // ha hecho nada y mandarlo a cerrar sesión, que no arregla nada.
    const r = await deQuienEsLaSesion(
      fingir({ data: { user: null }, error: { message: 'fetch failed' } }),
      'x',
    )
    expect(r).toEqual({ que: 'sin respuesta', motivo: 'fetch failed' })
  })

  it('ni un ENOTFOUND, ni un ECONNREFUSED, ni un timeout', async () => {
    for (const m of ['getaddrinfo ENOTFOUND kong', 'connect ECONNREFUSED', 'ETIMEDOUT']) {
      const r = await deQuienEsLaSesion(fingir({ data: { user: null }, error: { message: m } }), 'x')
      expect(r).toMatchObject({ que: 'sin respuesta' })
    }
  })

  it('y una sesión buena es una sesión buena', async () => {
    const r = await deQuienEsLaSesion(fingir({ data: { user: { id: 'u-1' } }, error: null }), 'x')
    expect(r).toEqual({ que: 'vale', id: 'u-1' })
  })
})

describe('qué cuenta como no haber podido preguntar', () => {
  it('los fallos de red de los tres navegadores y de Node', () => {
    for (const m of [
      'fetch failed',
      'TypeError: Failed to fetch',
      'TypeError: Load failed',
      'NetworkError when attempting to fetch resource',
      'connect ECONNREFUSED 127.0.0.1:8000',
    ]) {
      expect(esFalloDeRed({ message: m })).toBe(true)
    }
  })

  it('y NO un mensaje del servidor que sí ha contestado', () => {
    expect(esFalloDeRed({ message: 'invalid JWT: unable to parse or verify signature' })).toBe(false)
    expect(esFalloDeRed({ message: 'User not found' })).toBe(false)
    expect(esFalloDeRed(null)).toBe(false)
  })
})
