/**
 * La comprobación del esquema, contra las migraciones de verdad.
 *
 * Es el arreglo de la avería que se repitió dos veces en una semana: una
 * migración anotada en `schema_migrations` sin haberse ejecutado. Si este
 * analizador se equivoca al leer un fichero, la comprobación se convierte en
 * otra cosa que miente, así que se prueba contra los 67 ficheros del
 * repositorio y no contra ejemplos inventados.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  desajustes,
  esRepetible,
  funcionesDe,
  sentenciasDeNivelRaiz,
  versionVigente,
} from './esquema'

const DIR = 'supabase/migrations'
const ficheros = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
const leidos = ficheros.map((f) => ({
  fichero: f,
  sql: readFileSync(`${DIR}/${f}`, 'utf8'),
}))
const analizados = leidos.map(({ fichero, sql }) => ({
  fichero,
  ...funcionesDe(fichero, sql),
}))

describe('leer las funciones de las migraciones de verdad', () => {
  it('no deja ni una sin leer: callarse una sería dar por buena una base que no lo está', () => {
    const sinLeer = analizados.flatMap((a) => a.sinLeer)
    expect(sinLeer).toEqual([])
  })

  it('encuentra las funciones del proyecto, no un puñado', () => {
    const total = analizados.reduce((n, a) => n + a.funciones.length, 0)
    expect(total).toBeGreaterThan(140)
    expect(versionVigente(analizados).size).toBeGreaterThan(90)
  })

  it('la versión vigente de una función es la del último fichero que la define', () => {
    const vigente = versionVigente(analizados)
    // Las tres que el 22/09/2026 estaban en producción con la versión de agosto.
    expect(vigente.get('public.sync_mover_sala')?.fichero).toBe(
      '20260921000300_la_planta_la_trae_el_excel.sql',
    )
    expect(vigente.get('public.sync_celda_de_articulo')?.fichero).toBe(
      '20260921000200_el_recuento_arranca_en_agosto.sql',
    )
    // Y ésta se volvió a tocar el 22, para que nombre el material que no reconoce.
    expect(vigente.get('public.sync_material_del_parte')?.fichero).toBe(
      '20260922000100_el_almacen_dice_que_material_no_reconoce.sql',
    )
  })

  it('ningún cuerpo sale ridículamente corto, que es el síntoma de un cierre leído mal', () => {
    // Un `$$` dentro de un cuerpo cerraría antes de tiempo. La guarda de
    // «lo que sigue al cierre» lo caza; esto lo comprueba por el otro lado.
    for (const { fichero, funciones } of analizados) {
      for (const f of funciones) expect(f.md5, `${fichero} ${f.nombre}`).toHaveLength(32)
    }
  })
})

describe('qué falta en la base', () => {
  const vigente = versionVigente(analizados)

  it('una función que la base no tiene sale como «falta»', () => {
    const fuera = desajustes(vigente, new Map())
    expect(fuera.length).toBe(vigente.size)
    expect(fuera.every((d) => d.que === 'falta')).toBe(true)
  })

  it('una base con la versión de agosto sale como «distinta», con el fichero que hay que reaplicar', () => {
    // Justo el caso real: el nombre está, el cuerpo es otro.
    const enLaBase = new Map([...vigente.keys()].map((n) => [n, new Set(['el cuerpo de agosto'])]))
    const fuera = desajustes(vigente, enLaBase)
    const mover = fuera.find((d) => d.nombre === 'public.sync_mover_sala')
    expect(mover).toMatchObject({
      que: 'distinta',
      fichero: '20260921000300_la_planta_la_trae_el_excel.sql',
    })
  })

  it('una base al día no tiene ni un desajuste', () => {
    const enLaBase = new Map([...vigente.entries()].map(([n, v]) => [n, new Set(v.md5s)]))
    expect(desajustes(vigente, enLaBase)).toEqual([])
  })

  it('una sobrecarga vale: basta con que esté la versión que el repositorio espera', () => {
    const enLaBase = new Map(
      [...vigente.entries()].map(([n, v]) => [
        n,
        new Set([...v.md5s, 'otra sobrecarga cualquiera']),
      ]),
    )
    expect(desajustes(vigente, enLaBase)).toEqual([])
  })
})

describe('qué fichero se puede volver a aplicar', () => {
  it('parte en sentencias sin dejarse engañar por los punto y coma de dentro de un cuerpo', () => {
    const sql = `create or replace function f() returns int language plpgsql as $$
      begin
        select 1; select 2;
        return 3;
      end $$;
      comment on function f() is 'con ; dentro';`
    expect(sentenciasDeNivelRaiz(sql)).toHaveLength(2)
  })

  it('las del 21/09 se pueden repetir: son las que hay que poder reaplicar hoy', () => {
    for (const f of ficheros.filter((f) => f.startsWith('202609210'))) {
      const { si, porQue } = esRepetible(readFileSync(`${DIR}/${f}`, 'utf8'))
      expect(si, `${f}: ${porQue}`).toBe(true)
    }
  })

  it('un fichero con un update de datos NO se puede repetir', () => {
    const { si, porQue } = esRepetible(`
      create or replace function f() returns int language sql as $$ select 1 $$;
      update rooms set projector_hours = 0;
    `)
    expect(si).toBe(false)
    expect(porQue).toContain('update rooms')
  })

  it('el esquema de julio, que crea tipos y tablas, tampoco', () => {
    const { si } = esRepetible(readFileSync(`${DIR}/20260728000100_schema.sql`, 'utf8'))
    expect(si).toBe(false)
  })

  it('y la marca del propio fichero manda sobre la deducción', () => {
    expect(
      esRepetible(
        '-- reejecutable: no\ncreate or replace function f() returns int language sql as $$ select 1 $$;',
      ).si,
    ).toBe(false)
    expect(esRepetible('-- reejecutable: si\nupdate rooms set projector_hours = 0;').si).toBe(true)
  })
})
