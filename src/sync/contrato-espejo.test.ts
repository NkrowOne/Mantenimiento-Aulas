import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * La frontera entre `pullMaster()` y `espejo_version()`.
 *
 * El dispositivo se ahorra la bajada cuando la versión no cambia, así que la
 * versión TIENE que moverse con cualquier cosa que alimente el espejo. Lo
 * editable pasa por `audit_log`; lo solo-alta —revisiones, inventarios,
 * movimientos— por las marcas. Si alguien añade una fuente al espejo sin
 * cubrirla, o quita un disparador, compila y pasa todo, y lo que ocurre es que
 * un cambio deja de llegar a los dispositivos hasta la bajada entera de la
 * media hora. Se lee la migración y se comprueba desde fuera.
 */

const RAIZ = path.resolve(__dirname, '../..')
const sql = readFileSync(
  path.join(RAIZ, 'supabase/migrations/20260924000200_el_espejo_pregunta_antes_de_bajarse.sql'),
  'utf8',
)
const pull = readFileSync(path.join(RAIZ, 'src/sync/pull.ts'), 'utf8')

/** Las tablas y vistas que baja el espejo, tal y como las nombra `pullMaster()`. */
function tablasDelEspejo(): string[] {
  const inicio = pull.indexOf('const tablas: Array<[string, PorPagina]> = [')
  expect(inicio).toBeGreaterThanOrEqual(0)
  const fin = pull.indexOf('\n  ]\n', inicio)
  return [...pull.slice(inicio, fin).matchAll(/^\s*\['([a-z_]+)',/gm)].map((m) => m[1] ?? '')
}

/** De qué tablas de la base sale cada cosa que baja el espejo. */
const FUENTES: Record<string, string[]> = {
  buildings: ['buildings'],
  zones: ['zones'],
  room_overview: ['rooms', 'zones', 'buildings', 'inspections', 'room_inventories', 'incidents'],
  stock_items: ['stock_items'],
  stock_levels: ['stock_items', 'stock_movements'],
  incidents: ['incidents'],
  asset_types: ['asset_types'],
  assets: ['assets'],
  asset_removals: ['asset_removals'],
}

/** Lo que deja rastro en audit_log (auth_rls + migraciones posteriores). */
const AUDITADAS = new Set([
  'buildings', 'zones', 'rooms', 'stock_items', 'assets', 'incidents', 'profiles',
  'asset_types', 'asset_removals', 'asset_defaults',
])

describe('contrato del espejo: la versión se mueve con todo lo que baja', () => {
  it('espejo_version() existe, corre con permisos propios y solo la llama quien tiene sesión', () => {
    expect(sql).toContain('create or replace function public.espejo_version()')
    const cuerpo = sql.slice(sql.indexOf('function public.espejo_version()'))
    expect(cuerpo).toContain('security definer')
    expect(sql).toContain('revoke all on function public.espejo_version() from public, anon;')
    expect(sql).toContain('grant execute on function public.espejo_version() to authenticated;')
    expect(sql).toContain('create index if not exists audit_log_at_idx on audit_log (at desc);')
  })

  it('cada fuente del espejo está auditada o lleva marca', () => {
    const marcadas = [...sql.matchAll(/for each statement execute function public\.espejo_marcar\(\);/g)].length
    const conDisparador = new Set(
      [...sql.matchAll(/after insert or update or delete on ([a-z_]+)\s+for each statement/g)].map((m) => m[1] ?? ''),
    )
    expect(marcadas).toBe(conDisparador.size)
    const tablas = tablasDelEspejo()
    expect(tablas.length).toBeGreaterThan(0)
    for (const t of tablas) {
      const fuentes = FUENTES[t]
      expect(fuentes, `${t}: falta decir de qué tablas sale`).toBeDefined()
      for (const f of fuentes!) {
        expect(AUDITADAS.has(f) || conDisparador.has(f), `${f} (de ${t}) ni se audita ni lleva marca`).toBe(true)
      }
    }
    // Y las marcas nacen con su fila, para que la función no devuelva null de salida.
    for (const t of conDisparador) expect(sql).toContain(`('${t}')`)
  })

  it('la bajada periódica pregunta primero y la manual baja siempre', () => {
    expect(pull).toContain("supabase.rpc('espejo_version')")
    expect(pull).toMatch(/pullMaster\(\{ soloSiCambio: true \}\)/)
  })
})
