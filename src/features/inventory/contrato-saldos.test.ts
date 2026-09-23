import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * La frontera entre `stock_levels` y todo lo que la lee.
 *
 * La vista se reescribe sobre `stock_balances` con `create or replace`, y eso
 * solo funciona —y solo es transparente para la pantalla, el panel, el
 * informe y el espejo— si las columnas son las mismas y en el mismo orden que
 * en la original. Un desliz compila, pasa todo y revienta al aplicar la
 * migración en producción («cannot change name of view column»). Se leen las
 * dos definiciones y se comparan, como hace `contrato-hoja.test.ts`.
 *
 * Y el orden de los disparadores: el que mantiene el saldo tiene que dispararse
 * ANTES que el que impide el negativo, porque este ya no suma, lee. Postgres
 * los ordena por nombre.
 */

const RAIZ = path.resolve(__dirname, '../../..')
const original = readFileSync(path.join(RAIZ, 'supabase/migrations/20260728000200_views.sql'), 'utf8')
const nueva = readFileSync(
  path.join(RAIZ, 'supabase/migrations/20260923000400_el_saldo_del_almacen_no_se_vuelve_a_sumar.sql'),
  'utf8',
)

/** Corta la lista de columnas por las comas de primer nivel. */
function porComasDeFuera(lista: string): string[] {
  const trozos: string[] = []
  let hondura = 0
  let actual = ''
  for (const c of lista) {
    if (c === '(') hondura += 1
    else if (c === ')') hondura -= 1
    if (c === ',' && hondura === 0) {
      trozos.push(actual)
      actual = ''
    } else actual += c
  }
  if (actual.trim() !== '') trozos.push(actual)
  return trozos
}

/** Cómo se llama la columna al salir de la vista: el alias si lo lleva, si no lo último tras el punto. */
function nombreDeColumna(expr: string): string {
  const sinComentarios = expr.replace(/--[^\n]*/g, '').trim()
  const alias = /\s+as\s+([a-z_]+)\s*$/i.exec(sinComentarios)
  if (alias) return alias[1] ?? ''
  const ultimo = sinComentarios.split('.').pop() ?? ''
  return ultimo.trim()
}

function columnasDeStockLevels(sql: string): string[] {
  const inicio = sql.indexOf('view stock_levels as')
  expect(inicio).toBeGreaterThanOrEqual(0)
  const desde = sql.indexOf('select', inicio) + 'select'.length
  const hasta = sql.indexOf('\nfrom stock_items', desde)
  // Sin los comentarios: una coma dentro de uno no separa columnas.
  const lista = sql.slice(desde, hasta).replace(/--[^\n]*/g, '')
  return porComasDeFuera(lista).map(nombreDeColumna)
}

function cuerpoDe(sql: string, funcion: string): string {
  const inicio = sql.indexOf(`create or replace function public.${funcion}(`)
  expect(inicio, `define ${funcion}`).toBeGreaterThanOrEqual(0)
  return sql.slice(inicio, sql.indexOf('end $$;', inicio))
}

describe('contrato de los saldos del almacén', () => {
  it('stock_levels conserva las columnas y su orden', () => {
    const antes = columnasDeStockLevels(original)
    const despues = columnasDeStockLevels(nueva)
    expect(antes).toEqual([
      'stock_item_id', 'name', 'unit', 'min_threshold', 'on_hand', 'total_consumed', 'total_purchased', 'below_threshold',
    ])
    expect(despues).toEqual(antes)
    expect(nueva).toContain('alter view stock_levels set (security_invoker = on);')
  })

  it('el saldo se mantiene antes de comprobar el negativo, y este ya no suma', () => {
    expect(nueva).toContain('create trigger stock_movements_actualiza_saldo')
    // Por orden alfabético, que es como Postgres dispara los `after` de un mismo evento.
    expect('stock_movements_actualiza_saldo' < 'stock_movements_no_negativo').toBe(true)
    const negativo = cuerpoDe(nueva, 'stock_no_negativo')
    expect(negativo).toContain('from stock_balances')
    expect(negativo).not.toMatch(/sum\(qty\)/)
  })

  it('un consumo resta y suma a lo consumido; una compra suma a lo comprado', () => {
    const sumar = cuerpoDe(nueva, 'stock_balance_sumar').replace(/\s+/g, ' ')
    expect(sumar).toContain("case when p_kind = 'consumo' then -p_qty else 0 end")
    expect(sumar).toContain("case when p_kind = 'compra' then p_qty else 0 end")
    const mantener = cuerpoDe(nueva, 'stock_balances_mantener')
    expect(mantener).toContain('-old.qty')
    expect(mantener).toContain('new.qty')
  })

  it('la primera carga y la reparación salen del libro, y solo desde la terminal', () => {
    expect(nueva).toContain('select public.stock_balances_recalcular();')
    expect(nueva).toContain('revoke all on function public.stock_balances_recalcular() from public, anon, authenticated;')
    expect(nueva).toContain('revoke all on function public.stock_balance_sumar(uuid, int, text) from public, anon, authenticated;')
  })

  it('lo que la aplicación lee de la vista está entre sus columnas', () => {
    const columnas = new Set(columnasDeStockLevels(nueva))
    for (const fichero of ['src/features/inventory/StockPage.tsx', 'src/domain/types.ts']) {
      const src = readFileSync(path.join(RAIZ, fichero), 'utf8')
      const i = src.indexOf('interface StockLevel {')
      expect(i, `${fichero} declara StockLevel`).toBeGreaterThanOrEqual(0)
      const cuerpo = src.slice(i, src.indexOf('}', i))
      for (const m of cuerpo.matchAll(/^\s+([a-z_]+):/gm)) {
        expect(columnas.has(m[1] ?? ''), `${fichero}: ${m[1]} no sale de stock_levels`).toBe(true)
      }
    }
  })
})
