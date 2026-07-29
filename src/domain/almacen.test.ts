import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CATALOGO_ALMACEN, FRAGMENTOS_ALMACEN, canonAlmacen, esFragmentoAlmacen } from './almacen'
import { norm } from './normalize'

const MIGRACION = 'supabase/migrations/20260729000200_almacen_nomenclatura.sql'

describe('catálogo del almacén', () => {
  it('no repite nombre canónico', () => {
    const vistos = new Map<string, string>()
    for (const a of CATALOGO_ALMACEN) {
      const previo = vistos.get(norm(a.canonico))
      expect(previo, `«${a.canonico}» y «${previo}» son el mismo nombre`).toBeUndefined()
      vistos.set(norm(a.canonico), a.canonico)
    }
  })

  /**
   * Lo que de verdad hay que impedir: que una misma grafía apunte a dos
   * artículos. Con eso el resultado dependería del orden de la tabla, y el
   * arreglo de la base movería material de un sitio a otro según el día.
   */
  it('ninguna grafía apunta a dos artículos', () => {
    const dueño = new Map<string, string>()
    for (const a of CATALOGO_ALMACEN) {
      for (const v of [a.canonico, ...a.variantes]) {
        const previo = dueño.get(norm(v))
        expect(previo ?? a.canonico, `«${v}» está en dos artículos`).toBe(a.canonico)
        dueño.set(norm(v), a.canonico)
      }
    }
  })

  it('no lista variantes que ya cubre la normalización', () => {
    for (const a of CATALOGO_ALMACEN) {
      const claves = [a.canonico, ...a.variantes].map(norm)
      expect(new Set(claves).size, `«${a.canonico}» repite una variante`).toBe(claves.length)
    }
  })

  it('ningún fragmento es también un artículo', () => {
    for (const f of FRAGMENTOS_ALMACEN) {
      expect(canonAlmacen(f), `«${f}» está en las dos listas`).toBe(f)
    }
  })

  it('aplicarlo dos veces no cambia nada', () => {
    for (const a of CATALOGO_ALMACEN) {
      for (const v of [a.canonico, ...a.variantes]) {
        expect(canonAlmacen(v)).toBe(a.canonico)
        expect(canonAlmacen(canonAlmacen(v))).toBe(a.canonico)
      }
    }
  })

  it('deja en paz lo que no conoce', () => {
    // Un artículo dado de alta desde la app mañana no se toca: corregir a
    // ciegas lo que no se conoce es como se llegó a esta lista.
    expect(canonAlmacen('Ventilador de sala')).toBe('Ventilador de sala')
    // Los espacios de más sí, que no son una decisión de nadie.
    expect(canonAlmacen('  Ventilador   de sala ')).toBe('Ventilador de sala')
  })

  it('funde las redundancias que traía la lista', () => {
    expect(canonAlmacen('Matriz Hdmi')).toBe(canonAlmacen('Matriz HDMI'))
    expect(canonAlmacen('mando a distancia pantalla proyección')).toBe(
      canonAlmacen('mando a distancia para pantalla de proyección'),
    )
    expect(canonAlmacen('cables Hdmi 10mts Fibra')).toBe('Cable HDMI fibra 10 m')
    expect(canonAlmacen('teclados de pc')).toBe('Teclado')
    expect(esFragmentoAlmacen('metros red')).toBe(true)
    expect(esFragmentoAlmacen('m fibra')).toBe(true)
    expect(esFragmentoAlmacen('Cable HDMI 3 m')).toBe(false)
  })
})

/**
 * El catálogo vive en dos sitios porque hacen falta en dos sitios: aquí para el
 * importador, y en SQL para arreglar la base que ya está en producción. Este
 * test es lo que impide que se separen.
 */
describe('la migración dice lo mismo que el catálogo', () => {
  const sql = readFileSync(MIGRACION, 'utf8')

  const bloque = (tabla: string): string => {
    const desde = sql.indexOf(`insert into ${tabla}`)
    expect(desde, `falta el insert de ${tabla}`).toBeGreaterThan(-1)
    return sql.slice(desde, sql.indexOf(';', desde))
  }

  it('mapea las mismas grafías a los mismos artículos', () => {
    const enSql = new Set(
      [...bloque('tmp_almacen_map').matchAll(/\('((?:[^']|'')*)', '((?:[^']|'')*)'\)/g)].map(
        (m) => `${m[1]!.replace(/''/g, "'")} → ${m[2]!.replace(/''/g, "'")}`,
      ),
    )
    const enTs = new Set(
      CATALOGO_ALMACEN.flatMap((a) =>
        [a.canonico, ...a.variantes].map((v) => `${v} → ${a.canonico}`),
      ),
    )
    expect([...enSql].sort()).toEqual([...enTs].sort())
  })

  it('archiva los mismos fragmentos', () => {
    const enSql = [...bloque('tmp_almacen_fragmento').matchAll(/\('((?:[^']|'')*)'\)/g)].map((m) =>
      m[1]!.replace(/''/g, "'"),
    )
    expect(enSql.sort()).toEqual([...FRAGMENTOS_ALMACEN].sort())
  })
})
