/**
 * Pedir el informe al servidor, y saber cuándo NO se le puede pedir.
 *
 * La mitad de este fichero es una sola pregunta: ante cada respuesta posible,
 * ¿el informe se genera aquí o se enseña un error? Equivocarse hacia un lado
 * deja a alguien sin informe por una pieza que antes ni existía; hacia el otro,
 * tapa con un informe local lo que el servidor estaba diciendo.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type Trabajo,
  SILENCIO_MS,
  eleccionDe,
  estaAMedias,
  paraEnsenar,
  pedirAlServidor,
  rutaDelPdf,
  sigueVivo,
} from './enElServidor'
import type { Eleccion } from '../peticion'

const eleccion: Eleccion = {
  kind: 'semanal',
  rango: { start: '2026-11-16', end: '2026-11-20' },
  secciones: ['resumen', 'analisis'],
  comparar: true,
  ia: true,
  audiencia: 'direccion',
  enfoque: ' Céntrate en el edificio H ',
  nota: '',
}

/** Sustituye `fetch` por uno que contesta lo que se le diga, y deja ver qué se le pidió. */
function servidorQueContesta(status: number, cuerpo: string): ReturnType<typeof vi.fn> {
  const f = vi.fn(() => Promise.resolve(new Response(cuerpo, { status })))
  vi.stubGlobal('fetch', f)
  return f
}

afterEach(() => vi.unstubAllGlobals())

describe('pedir el informe al servidor', () => {
  it('aceptado: vuelve el id, y lo que viaja es lo mismo que arma la pantalla', async () => {
    const f = servidorQueContesta(202, '{"ok":true,"id":"abc"}')
    expect(await pedirAlServidor(eleccion, 'mi-sesion')).toEqual({ ok: true, id: 'abc' })

    const [url, opciones] = f.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/informe/generar')
    expect((opciones.headers as Record<string, string>)['Authorization']).toBe('Bearer mi-sesion')
    expect(JSON.parse(String(opciones.body))).toEqual({
      kind: 'semanal',
      start: '2026-11-16',
      end: '2026-11-20',
      // El enfoque, recortado; la nota en blanco no viaja.
      params: { secciones: ['resumen', 'analisis'], comparar: true, ia: true, audiencia: 'direccion', enfoque: 'Céntrate en el edificio H' },
    })
  })

  it('sale aunque la página se cierre en el acto', async () => {
    // `keepalive` es lo que permite pulsar «Generar» y guardar el teléfono.
    const f = servidorQueContesta(202, '{"ok":true,"id":"abc"}')
    await pedirAlServidor(eleccion, 't')
    expect((f.mock.calls[0] as [string, RequestInit])[1].keepalive).toBe(true)
  })

  it('la clave de Gemini del dispositivo viaja solo si la hay', async () => {
    const f = servidorQueContesta(202, '{"ok":true,"id":"abc"}')
    await pedirAlServidor(eleccion, 't')
    await pedirAlServidor(eleccion, 't', 'clave-local')
    const cuerpo = (i: number): Record<string, unknown> =>
      JSON.parse(String((f.mock.calls[i] as [string, RequestInit])[1].body)) as Record<string, unknown>
    expect('clave' in cuerpo(0)).toBe(false)
    expect(cuerpo(1)['clave']).toBe('clave-local')
  })

  describe('cuando el servidor no puede, el informe se hace aquí', () => {
    const casos: Array<[string, number, string]> = [
      ['la ruta no existe (un servidor sin actualizar)', 404, 'No encontrado'],
      ['el servidor de informes está caído', 502, '<html>Bad Gateway</html>'],
      ['le falta la tabla o no llega a la API', 503, '{"ok":false,"error":"El servidor no puede llevar la cuenta"}'],
      // Un proxy sin la regla devuelve la página de la aplicación, con 200.
      ['contesta la aplicación y no el servidor de informes', 200, '<!doctype html><html></html>'],
      ['un 200 que no trae id', 200, '{"ok":true}'],
      ['dice que no a una sesión que la base sí acepta', 401, '{"ok":false,"error":"La sesión no vale o ha caducado."}'],
      ['hay algo delante que ni deja llegar', 403, '<html>Forbidden</html>'],
      ['revienta', 500, 'Internal Server Error'],
    ]
    for (const [nombre, status, cuerpo] of casos) {
      it(nombre, async () => {
        servidorQueContesta(status, cuerpo)
        const r = await pedirAlServidor(eleccion, 't')
        expect(r.ok).toBe(false)
        expect(r.ok === false && r.sinServicio).toBe(true)
      })
    }

    it('no se ha podido ni hablar con él', async () => {
      vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Load failed'))))
      const r = await pedirAlServidor(eleccion, 't')
      expect(r).toEqual({ ok: false, motivo: 'no se ha podido hablar con el servidor', sinServicio: true })
    })

    it('no contesta a tiempo', async () => {
      const silencio = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })
      vi.stubGlobal('fetch', vi.fn(() => Promise.reject(silencio)))
      const r = await pedirAlServidor(eleccion, 't')
      expect(r.ok === false && r.sinServicio).toBe(true)
      expect(r.ok === false && r.motivo).toMatch(/no ha contestado en 15 segundos/)
    })

    it('no hay sesión con la que pedirlo', async () => {
      const f = servidorQueContesta(202, '{"ok":true,"id":"abc"}')
      const r = await pedirAlServidor(eleccion, null)
      expect(r.ok === false && r.sinServicio).toBe(true)
      expect(f).not.toHaveBeenCalled()
    })

    it('y el motivo es el suyo cuando lo da', async () => {
      servidorQueContesta(503, '{"ok":false,"error":"Falta aplicar la migración."}')
      const r = await pedirAlServidor(eleccion, 't')
      expect(r.ok === false && r.motivo).toBe('Falta aplicar la migración.')
    })
  })

  describe('lo que se enseña tal cual, sin generarlo aquí', () => {
    it('una petición mal hecha', async () => {
      servidorQueContesta(400, '{"ok":false,"error":"El periodo no puede superar un año."}')
      expect(await pedirAlServidor(eleccion, 't')).toEqual({
        ok: false,
        motivo: 'El periodo no puede superar un año.',
        sinServicio: false,
      })
    })

    it('ya hay varios en marcha: hacerlo aquí además lo empeoraría', async () => {
      servidorQueContesta(429, '{"ok":false,"error":"Ya hay varios informes generándose."}')
      const r = await pedirAlServidor(eleccion, 't')
      expect(r.ok === false && r.sinServicio).toBe(false)
    })

    it('pero un 400 que no es suyo sí es «no está»', async () => {
      servidorQueContesta(400, '<html>Bad Request</html>')
      const r = await pedirAlServidor(eleccion, 't')
      expect(r.ok === false && r.sinServicio).toBe(true)
    })
  })
})

const AHORA = Date.parse('2026-11-20T12:00:00Z')
const hace = (ms: number): string => new Date(AHORA - ms).toISOString()

function trabajo(extra: Partial<Trabajo> = {}): Trabajo {
  return {
    id: 't1',
    kind: 'semanal',
    period_start: '2026-11-16',
    period_end: '2026-11-20',
    params: { secciones: ['resumen'], comparar: false, ia: false, audiencia: 'equipo', enfoque: 'Mira el CRAI', nota: 'Para Luis' },
    estado: 'en_curso',
    paso: 'datos',
    detalle: null,
    error: null,
    storage_path: null,
    pedido_at: hace(30_000),
    latido_at: hace(5_000),
    terminado_at: null,
    ...extra,
  }
}

describe('cómo está un trabajo', () => {
  it('con el pulso reciente, sigue vivo: en cola o en curso', () => {
    expect(sigueVivo(trabajo(), AHORA)).toBe(true)
    expect(sigueVivo(trabajo({ estado: 'en_cola' }), AHORA)).toBe(true)
    expect(estaAMedias(trabajo(), AHORA)).toBe(false)
  })

  it('con el pulso parado, está a medias: el servidor se paró y nadie lo ha barrido', () => {
    const callado = trabajo({ latido_at: hace(SILENCIO_MS + 1000) })
    expect(estaAMedias(callado, AHORA)).toBe(true)
    // Y entonces ya no se sigue preguntando cada dos segundos por él.
    expect(sigueVivo(callado, AHORA)).toBe(false)
  })

  it('un reloj del dispositivo un par de minutos mal no mata un informe que iba bien', () => {
    expect(estaAMedias(trabajo({ latido_at: hace(3 * 60_000) }), AHORA)).toBe(false)
    // Ni uno adelantado: el pulso «en el futuro» es un pulso reciente.
    expect(sigueVivo(trabajo({ latido_at: new Date(AHORA + 120_000).toISOString() }), AHORA)).toBe(true)
  })

  it('terminado no es ni lo uno ni lo otro, lleve el pulso que lleve', () => {
    for (const estado of ['hecho', 'fallido'] as const) {
      const t = trabajo({ estado, latido_at: hace(SILENCIO_MS * 3) })
      expect(sigueVivo(t, AHORA)).toBe(false)
      expect(estaAMedias(t, AHORA)).toBe(false)
    }
  })
})

describe('qué se enseña en la lista', () => {
  it('lo que está en ello y lo que falló, siempre; lo hecho, un día', () => {
    const UN_DIA = 24 * 60 * 60_000
    const lista = [
      trabajo({ id: 'vivo' }),
      trabajo({ id: 'fallo-viejo', estado: 'fallido', terminado_at: hace(5 * UN_DIA) }),
      trabajo({ id: 'hecho-hoy', estado: 'hecho', terminado_at: hace(60_000) }),
      trabajo({ id: 'hecho-anteayer', estado: 'hecho', terminado_at: hace(2 * UN_DIA) }),
    ]
    expect(paraEnsenar(lista, AHORA).map((t) => t.id)).toEqual(['vivo', 'fallo-viejo', 'hecho-hoy'])
  })
})

describe('volver a pedir lo mismo', () => {
  it('la fila devuelve el periodo, las casillas y las instrucciones', () => {
    expect(eleccionDe(trabajo())).toEqual({
      kind: 'semanal',
      rango: { start: '2026-11-16', end: '2026-11-20' },
      secciones: ['resumen'],
      comparar: false,
      ia: false,
      audiencia: 'equipo',
      enfoque: 'Mira el CRAI',
      nota: 'Para Luis',
    })
  })

  it('una fila sin `params` no revienta: sale lo de por defecto', () => {
    const e = eleccionDe(trabajo({ params: null }))
    expect(e.secciones).toEqual([])
    expect(e.comparar).toBe(true)
    expect(e.ia).toBe(true)
    expect(e.audiencia).toBe('direccion')
    expect(e.enfoque).toBe('')
  })
})

describe('dónde vive el PDF de un informe', () => {
  it('al lado del documento, con otra extensión', () => {
    expect(rutaDelPdf('semanal/2026-11-16_2026-11-20_abc123.html')).toBe('semanal/2026-11-16_2026-11-20_abc123.pdf')
  })

  it('y el de un informe antiguo, que ya se archivó en PDF, es él mismo', () => {
    expect(rutaDelPdf('semanal/2026-07-27_2026-07-31_abc.pdf')).toBe('semanal/2026-07-27_2026-07-31_abc.pdf')
  })
})
