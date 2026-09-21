import { describe, expect, it } from 'vitest'
import { columnaQueFalta, motivoDeServidorPorDetras, servidorPorDetras, sinLaColumna } from './esquema'

const MENSAJE = "Could not find the 'easyvista_ref' column of 'incident_resolutions' in the schema cache"

describe('el servidor que va por detrás de la aplicación', () => {
  it('se reconoce por el código de PostgREST o por el mensaje', () => {
    expect(servidorPorDetras({ message: MENSAJE, code: 'PGRST204', status: 400 })).toBe(true)
    expect(servidorPorDetras({ message: MENSAJE, status: 400 })).toBe(true)
    expect(servidorPorDetras({ message: 'violates row-level security', status: 403 })).toBe(false)
  })

  it('dice qué columna falta', () => {
    expect(columnaQueFalta(MENSAJE)).toBe('easyvista_ref')
    expect(columnaQueFalta('otra cosa')).toBeNull()
  })

  it('y lo explica con la columna y a quién le toca', () => {
    const m = motivoDeServidorPorDetras({ message: MENSAJE })
    expect(m).toContain('«easyvista_ref»')
    expect(m).toContain('avisa a administración')
  })

  it('la fila sin la columna es la misma fila sin esa clave', () => {
    expect(sinLaColumna({ id: 'r1', easyvista_ref: null, resolution: 'x' }, 'easyvista_ref')).toEqual({ id: 'r1', resolution: 'x' })
  })
})
