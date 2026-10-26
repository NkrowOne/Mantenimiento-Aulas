import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * La bandeja de duplicados, vigilada desde fuera.
 *
 * Fusionar es la única operación del panel que **retira un equipo que está
 * puesto**, y por eso es la única cuyo error no se ve: la fila desaparece de la
 * sala, el aparato sigue encima de la mesa, y quien entra al aula seis meses
 * después se encuentra treinta ordenadores que el inventario no conoce. Pasó
 * —los treinta puestos del laboratorio de informática 6, fusionados de uno en
 * uno porque todos se llaman «Puesto algo»— y lo que lo impide ahora es una
 * regla de tres líneas en SQL que ninguna prueba de TypeScript puede ver.
 *
 * Así que se lee el SQL, igual que `contrato-almacen.test.ts` y por el mismo
 * motivo: el compilador no entra ahí, y lo que vigila esto no es el estilo de
 * una consulta sino que la regla siga existiendo el día que alguien reescriba
 * la función por otra cosa.
 */

const RAIZ = path.resolve(__dirname, '../../..')
const MIGRACIONES = path.join(RAIZ, 'supabase/migrations')

const ficheros = readdirSync(MIGRACIONES)
  .filter((f) => f.endsWith('.sql'))
  .sort()

/** El texto de la ÚLTIMA migración que contiene algo: la que manda en la base. */
function ultimaQueContiene(aguja: string): string {
  const fichero = ficheros.filter((f) => leer(f).includes(aguja)).at(-1)
  if (fichero === undefined) throw new Error(`Ninguna migración contiene «${aguja}»`)
  return leer(fichero)
}

function leer(fichero: string): string {
  return readFileSync(path.join(MIGRACIONES, fichero), 'utf8')
}

/** El cuerpo de una función, desde su cabecera hasta el `$$;` que la cierra. */
function cuerpoDe(texto: string, cabecera: string): string {
  const desde = texto.indexOf(cabecera)
  expect(desde, `la migración declara ${cabecera}`).toBeGreaterThanOrEqual(0)
  const hasta = texto.indexOf('$$;', desde)
  return texto.slice(desde, hasta)
}

describe('fusionar duplicados: dos series distintas son dos aparatos', () => {
  const texto = ultimaQueContiene('create or replace function public.fusionar_equipo_duplicado(')
  const cuerpo = cuerpoDe(texto, 'create or replace function public.fusionar_equipo_duplicado(')

  it('rechaza el par cuando las dos filas traen números de serie distintos', () => {
    expect(cuerpo).toContain('d.serial is not null and b.serial is not null')
    expect(cuerpo).toContain(
      'public.norm_text(d.serial) is distinct from public.norm_text(b.serial)',
    )
  })

  it('y lo dice con las dos series delante, que es lo que hay que corregir', () => {
    const aviso = /raise exception\s+'([^']*números de serie distintos[^']*)'/.exec(cuerpo)
    expect(aviso, 'el rechazo explica por qué, con sus palabras').not.toBeNull()
    expect(cuerpo.slice(cuerpo.indexOf(aviso![0]))).toMatch(/d\.serial, b\.serial/)
  })

  it('sigue comprobando el rol, la sala y el tipo antes que nada', () => {
    // La guarda nueva se añade a las de siempre; quitarlas por el camino
    // dejaría fusionar equipos de otra aula a quien no puede.
    expect(cuerpo).toContain('if not public.is_supervisor() then')
    expect(cuerpo).toContain('Solo se fusionan dos equipos de la misma sala')
    expect(cuerpo).toContain('Solo se fusionan dos equipos del mismo tipo')
  })

  it('se expone solo a usuarios con sesión', () => {
    expect(texto).toContain(
      'grant execute on function public.fusionar_equipo_duplicado(uuid, uuid)  to authenticated;',
    )
  })
})

describe('la bandeja de duplicados: lo que ni siquiera se propone', () => {
  const cuerpo = cuerpoDe(
    ultimaQueContiene('create or replace function public.auditoria_duplicados()'),
    'create or replace function public.auditoria_duplicados()',
  )

  it('no propone un par con dos series distintas', () => {
    const unaLinea = cuerpo.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ')
    expect(unaLinea).toContain(
      'and ( d.serial is null or c.serial is null or public.norm_text(d.serial) = public.norm_text(c.serial) )',
    )
  })

  it('pero sigue proponiendo el duplicado típico, el que no tiene serie', () => {
    // La guarda es `or ... is null` a propósito: una fila apuntada a mano y sin
    // leer la pegatina es justo para lo que existe la bandeja.
    expect(cuerpo).toContain('d.serial is null')
    expect(cuerpo).toContain('c.serial is null')
  })
})

describe('el laboratorio 6 recupera sus puestos', () => {
  const nombre = '20261026000300_el_laboratorio_6_recupera_sus_treinta_puestos.sql'
  const texto = leer(nombre)

  it('se puede volver a ejecutar y lo declara', () => {
    expect(texto.startsWith('-- reejecutable: si')).toBe(true)
  })

  it('solo toca lo retirado POR UNA FUSIÓN, no todo lo retirado', () => {
    expect(texto).toContain("e.kind = 'baja'")
    expect(texto).toContain("e.meta ->> 'fusionado_en' is not null")
    expect(texto).toContain("a.status = 'retirado'")
  })

  it('devuelve el equipo con un alta en el histórico, no solo con el estado', () => {
    // Sin el evento, la hoja de inventario los seguiría leyendo como bajas
    // —`inventory_sheet` decide por el último evento— y el PDF de la sala
    // seguiría sin traerlos, que es por donde se vio el fallo.
    expect(texto).toContain("set status     = 'instalado'")
    expect(texto).toMatch(/insert into asset_events[\s\S]*'alta'/)
  })

  it('con la fecha de alta que dio quien estuvo allí: el 22 de octubre', () => {
    expect(texto).toContain("timestamptz '2026-10-22 09:00+02'")
    expect(texto).toContain('created_at = v_instalacion')
  })

  it('y el alta va por delante de la baja que deshace', () => {
    expect(texto).toContain('greatest(')
    expect(texto).toContain("max(e.occurred_at) + interval '1 minute'")
  })

  it('renumera en dos pasadas, que es lo que no choca contra el índice', () => {
    expect(texto).toContain("set label = 'renumerando ' || a.id")
    expect(texto).toContain('set label = n.etiqueta')
  })

  it('no borra la baja de la fusión: el histórico cuenta lo que pasó', () => {
    expect(texto).not.toMatch(/delete\s+from\s+asset_events/i)
  })
})
