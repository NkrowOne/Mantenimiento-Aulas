import { describe, expect, it } from 'vitest'
import { REFRESCO_COMPLETO_MS, claveDeVersion, hayQueBajar } from './version'

const V1 = claveDeVersion({ auditoria: '2026-09-23T10:00:00Z', revisiones: null, inventarios: null, movimientos: null })!
const V2 = claveDeVersion({ auditoria: '2026-09-23T10:00:01Z', revisiones: null, inventarios: null, movimientos: null })!

describe('claveDeVersion', () => {
  it('no depende del orden de las claves', () => {
    expect(claveDeVersion({ a: 1, b: 2 })).toBe(claveDeVersion({ b: 2, a: 1 }))
  })
  it('devuelve null para lo que no es un objeto (servidor viejo, error, nada)', () => {
    expect(claveDeVersion(null)).toBeNull()
    expect(claveDeVersion(undefined)).toBeNull()
    expect(claveDeVersion('x')).toBeNull()
    expect(claveDeVersion([1])).toBeNull()
  })
})

describe('hayQueBajar', () => {
  const ahora = 1_000_000_000
  it('sin versión del servidor, se baja como siempre', () => {
    expect(hayQueBajar(null, { version: V1, at: ahora }, ahora)).toBe(true)
  })
  it('sin bajada completa guardada, se baja', () => {
    expect(hayQueBajar(V1, null, ahora)).toBe(true)
    expect(hayQueBajar(V1, undefined, ahora)).toBe(true)
  })
  it('con una versión distinta, se baja', () => {
    expect(hayQueBajar(V2, { version: V1, at: ahora }, ahora)).toBe(true)
  })
  it('con la misma versión y la bajada reciente, no se baja', () => {
    expect(hayQueBajar(V1, { version: V1, at: ahora - 2 * 60_000 }, ahora)).toBe(false)
    expect(hayQueBajar(V1, { version: V1, at: ahora - REFRESCO_COMPLETO_MS + 1 }, ahora)).toBe(false)
  })
  it('con la misma versión pero media hora sin bajar, se baja entero (red de seguridad)', () => {
    expect(hayQueBajar(V1, { version: V1, at: ahora - REFRESCO_COMPLETO_MS }, ahora)).toBe(true)
  })
})
