import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MOTIVO_MIN } from './motivo'

/**
 * La frontera entre la pantalla del almacén y la migración que decide quién
 * retira, renombra y da de baja, y con qué motivo.
 *
 * Las dos mitades tienen que decir lo mismo y ninguna puede ver a la otra: la
 * pantalla esconde el botón al que no es administrador y no manda un motivo de
 * menos de diez caracteres; la base rechaza al que no lo es y el motivo corto.
 * Si alguien relaja una de las dos —vuelve la baja a supervisor en el SQL, o
 * baja el mínimo en `motivo.ts`—, compila y pasa todo, y lo que ocurre es que
 * un botón promete lo que el servidor niega, o al revés. Se lee el SQL y se
 * comprueba desde fuera, como hace `contrato-hoja.test.ts` con la vista.
 */

const RAIZ = path.resolve(__dirname, '../../..')
const sql = readFileSync(
  path.join(RAIZ, 'supabase/migrations/20260923000200_el_almacen_lo_retira_el_administrador_y_dice_por_que.sql'),
  'utf8',
)

/** El cuerpo de una función, desde su `create or replace` hasta el `end $$`. */
function cuerpoDe(funcion: string): string {
  const inicio = sql.indexOf(`create or replace function public.${funcion}(`)
  expect(inicio, `la migración define ${funcion}`).toBeGreaterThanOrEqual(0)
  const fin = sql.indexOf('end $$;', inicio)
  return sql.slice(inicio, fin)
}

describe('contrato del almacén: quién retira y con qué motivo', () => {
  it('retirar, restaurar, renombrar y dar de baja son de administrador', () => {
    for (const f of ['stock_item_retirar', 'stock_item_restaurar', 'stock_item_renombrar', 'stock_unit_baja']) {
      expect(cuerpoDe(f), `${f} comprueba is_admin()`).toContain('if not public.is_admin() then')
      expect(cuerpoDe(f)).not.toContain('is_supervisor()')
    }
  })

  it('el motivo mínimo es el mismo en la base y en la pantalla', () => {
    const m = /if length\(v\) < (\d+) then/.exec(cuerpoDe('motivo_obligatorio'))
    expect(m, 'motivo_obligatorio() fija un mínimo').not.toBeNull()
    expect(Number(m![1])).toBe(MOTIVO_MIN)
    // Y lo usan las dos operaciones que piden motivo.
    expect(cuerpoDe('stock_item_retirar')).toContain('public.motivo_obligatorio(p_motivo)')
    expect(cuerpoDe('stock_unit_baja')).toContain('public.motivo_obligatorio(p_note)')
  })

  it('retirar no borra nada: solo marca la fila del artículo', () => {
    const cuerpo = cuerpoDe('stock_item_retirar')
    expect(cuerpo).not.toMatch(/\bdelete\b/i)
    expect(cuerpo).toMatch(/update stock_items\s+set\s+active\s*=\s*false/)
    expect(cuerpo).not.toContain('stock_units')
    expect(cuerpo).not.toContain('stock_movements')
    expect(cuerpo).not.toContain('assets')
  })

  it('una unidad instalada en un aula no se da de baja desde el almacén', () => {
    expect(cuerpoDe('stock_unit_baja')).toContain("if v_estado = 'instalado' then")
  })

  it('renombrar deja el nombre anterior como alias', () => {
    expect(cuerpoDe('stock_item_renombrar')).toContain('array_append(v_alias, v_actual)')
  })

  it('la validación del motivo es interna y el resto se expone solo a usuarios con sesión', () => {
    expect(sql).toContain('revoke all on function public.motivo_obligatorio(text) from public, anon, authenticated;')
    for (const firma of [
      'stock_item_retirar(uuid, text)',
      'stock_item_restaurar(uuid)',
      'stock_item_renombrar(uuid, text)',
      'stock_unit_baja(uuid, text)',
    ]) {
      expect(sql).toContain(`revoke all on function public.${firma} from public, anon;`)
      expect(sql).toContain(`grant execute on function public.${firma} to authenticated;`)
    }
  })
})

/**
 * La definición que manda es la ÚLTIMA.
 *
 * `20260923000300` sustituye a `stock_item_renombrar` para cerrarle dos huecos,
 * y el bloque de arriba sigue leyendo la migración que la trajo: vigilaría una
 * versión que ya no corre. Esto lee la última que la define, que es la que se
 * queda en la base.
 */
describe('contrato del almacén: la versión de renombrar que manda', () => {
  const dir = path.join(RAIZ, 'supabase/migrations')
  const firma = 'create or replace function public.stock_item_renombrar('
  const ultima = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => readFileSync(path.join(dir, f), 'utf8').includes(firma))
    .at(-1)!
  const texto = readFileSync(path.join(dir, ultima), 'utf8')
  const cuerpo = texto.slice(texto.indexOf(firma), texto.indexOf('end $$;', texto.indexOf(firma)))

  it('sigue siendo de administrador y sigue dejando el nombre de antes como alias', () => {
    expect(cuerpo).toContain('if not public.is_admin() then')
    expect(cuerpo).not.toContain('is_supervisor()')
    expect(cuerpo).toContain('array_append(v_alias, v_actual)')
  })

  it('no deja poner de nombre un alias de otro artículo, y lo dice con sus palabras', () => {
    expect(cuerpo).toContain('unnest(o.aliases)')
    const aviso = /raise exception '([^']*ya es otro nombre de[^']*)'[^;]*;/.exec(cuerpo)
    expect(aviso, 'rechaza el alias ajeno con un mensaje propio').not.toBeNull()
    // Ni código ni texto de duplicado: la pantalla los traduce a «búscalo en la
    // lista», que aquí mandaría a buscar algo que no está con ese nombre.
    expect(aviso![0]).not.toMatch(/unique_violation|23505/)
    expect(aviso![1]).not.toMatch(/ya hay otro artículo/i)
  })

  it('se expone solo a usuarios con sesión', () => {
    expect(texto).toContain('revoke all on function public.stock_item_renombrar(uuid, text) from public, anon;')
    expect(texto).toContain('grant execute on function public.stock_item_renombrar(uuid, text) to authenticated;')
  })
})
