import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * La frontera entre el apunte de material del aula y la migración que decide
 * cuándo sale del almacén.
 *
 * La pantalla manda filas del parte —`incident_materials`, origen `app`— y no
 * asientos; la base descuenta al cerrar y solo entonces. Si alguien relaja una
 * de las dos mitades —vuelve a encolar `stock_movement` desde la pantalla, o
 * quita el disparador del cierre— compila y pasa todo, y lo que vuelve es el
 * Historial con «+1 +1 −1 −1 −1» para un hub. Se lee el SQL y se comprueba
 * desde fuera, como hace `contrato-almacen.test.ts`.
 */

const RAIZ = path.resolve(__dirname, '../../..')
const sql = readFileSync(
  path.join(
    RAIZ,
    'supabase/migrations/20260924000100_el_material_sale_del_almacen_cuando_se_cierra_la_incidencia.sql',
  ),
  'utf8',
)

/** El cuerpo de una función, desde su `create or replace` hasta el `end $$`. */
function cuerpoDe(funcion: string): string {
  const inicio = sql.indexOf(`create or replace function public.${funcion}(`)
  expect(inicio, `la migración define ${funcion}`).toBeGreaterThanOrEqual(0)
  const fin = sql.indexOf('$$;', inicio)
  return sql.slice(inicio, fin)
}

describe('contrato del material: se descuenta al cerrar la incidencia', () => {
  it('el parte de material sabe de dónde viene cada fila y el personal escribe en él', () => {
    expect(sql).toContain("add column if not exists origen text not null default 'excel'")
    expect(sql).toContain("check (origen in ('excel', 'app'))")
    // Dar de alta y corregir, y lo corregido pasa a ser de la aplicación.
    expect(sql).toMatch(/create policy "personal apunta material" on incident_materials\s+for insert/)
    expect(sql).toMatch(/create policy "personal corrige el parte de material" on incident_materials\s+for update/)
    expect(sql).toContain("with check ((select public.is_staff()) and origen = 'app')")
  })

  it('el almacén se descuenta cuando la incidencia pasa a resuelta, venga el cierre de donde venga', () => {
    expect(sql).toMatch(/create trigger incidents_material_al_cerrar\s+after update of state on incidents/)
    expect(sql).toContain("when (new.state = 'resuelta' and old.state is distinct from 'resuelta')")
    // Con la fecha del cierre y a nombre de quien cerró.
    expect(cuerpoDe('material_al_cerrar_la_incidencia')).toContain(
      'new.id, null, coalesce(new.resolved_at, now()), new.resolved_by',
    )
  })

  it('la cuenta es la diferencia neta por artículo, la misma que hace el Excel', () => {
    const cuerpo = cuerpoDe('material_de_incidencia_al_almacen')
    // Lo que el parte dice: la suma de sus filas, sin negativos.
    expect(cuerpo).toContain('greatest(sum(qty), 0)::int as unidades')
    // Menos lo que ya salió, neto de devoluciones.
    expect(cuerpo).toContain('select coalesce(-sum(qty), 0)::int into v_ya')
    expect(cuerpo).toContain("and kind in ('consumo', 'devolucion')")
    // Más es consumo, menos es devolución, y un asiento por artículo.
    expect(cuerpo).toMatch(/if v_falta > 0 then\s+insert into stock_movements[\s\S]*'consumo'/)
    expect(cuerpo).toMatch(/elsif v_falta < 0 then\s+insert into stock_movements[\s\S]*'devolucion'/)
  })

  it('un parte que solo tiene lo que trajo el Excel no es asunto de la aplicación', () => {
    // El Excel sabe si el parte es anterior al arranque del recuento; esto no.
    expect(cuerpoDe('material_de_incidencia_al_almacen')).toMatch(
      /if not exists \(\s+select 1 from incident_materials\s+where incident_id = p_incidencia and origen = 'app'\s+\) then\s+return;/,
    )
  })

  it('el parte que llega detrás del cierre se descuenta al llegar, y solo si es de la aplicación', () => {
    expect(sql).toMatch(
      /create trigger incident_materials_de_incidencia_cerrada\s+after insert or update or delete on incident_materials/,
    )
    const cuerpo = cuerpoDe('material_de_incidencia_cerrada')
    expect(cuerpo).toContain("if coalesce(new.origen, '') <> 'app' and coalesce(old.origen, '') <> 'app' then")
    expect(cuerpo).toContain("select state = 'resuelta' into v_cerrada")
  })

  it('lo ya apuntado en las incidencias abiertas pasa al parte sin descontarse otra vez', () => {
    const desde = sql.indexOf("insert into incident_materials (id, incident_id, stock_item_id, qty, origen)")
    expect(desde).toBeGreaterThanOrEqual(0)
    const relleno = sql.slice(desde, sql.indexOf(';', desde))
    expect(relleno).toContain("where i.state <> 'resuelta'")
    expect(relleno).toContain("(-sum(sm.qty))::int, 'app'")
    expect(relleno).toContain('having -sum(sm.qty) > 0')
    // Y no pisa lo que el Excel ya hubiera puesto del mismo artículo.
    expect(relleno).toContain('and not exists (')
  })

  it('la cuenta es interna y se hace con permisos de la base, no del técnico', () => {
    for (const f of ['material_de_incidencia_al_almacen', 'material_al_cerrar_la_incidencia', 'material_de_incidencia_cerrada']) {
      expect(cuerpoDe(f), `${f} es security definer`).toContain('security definer')
    }
    expect(sql).toContain(
      'revoke all on function public.material_de_incidencia_al_almacen(uuid, uuid, timestamptz, uuid)\n  from public, anon, authenticated;',
    )
    expect(sql).toContain("notify pgrst, 'reload schema';")
  })
})
