/**
 * El cruce, en seco: ¿cuántas filas de los dos Excel encuentran su sala?
 *
 *   npm run cruce:excel -- <Material_Aulas.xlsx> [<AULAS_REVISION_UFV.xlsx>] [--seed]
 *
 * Es la fase 1 de la sincronización y **no escribe nada**: ni en la base, ni en
 * el Excel, ni en disco. Solo cuenta y explica. Si el cruce no saliera, todo lo
 * demás —la fusión a tres bandas, el parcheo del libro, los permisos de
 * SharePoint— sobra hasta arreglar los alias.
 *
 * Dos formas de conseguir el maestro contra el que cruzar:
 *
 *  - **Contra la base de datos** (por defecto, necesita `DATABASE_URL`). Es la
 *    buena: incluye los renombrados, la papelera y —a través de `audit_log`—
 *    los edificios que una fusión se llevó por delante. `merge_building` no
 *    deja alias, así que sin la auditoría una fila de un edificio fusionado no
 *    tendría explicación.
 *  - **Contra `supabase/seed.sql`** (`--seed`, sin base). Es el maestro de una
 *    instalación recién cargada: sirve para medir el cruce hoy mismo, sin
 *    depender de tener el servidor delante. Lo que no puede ver, claro, es
 *    ningún cambio posterior.
 */

import readXlsxFile from 'read-excel-file/node'
import { readFileSync } from 'node:fs'
import { construirIndice, contar, resolverSala } from '../src/domain/cruce'
import type { Catalogo, EdificioDesaparecido, Resolucion, SalaConocida } from '../src/domain/cruce'

const text = (row: unknown[], i: number): string => String(row[i] ?? '').trim()

// -----------------------------------------------------------------------------
// El maestro, desde el seed
// -----------------------------------------------------------------------------

/** Parte la lista de `values (...)` respetando las comillas y los `''` escapados. */
function partirValores(linea: string): string[] {
  const i = linea.indexOf(' values (')
  if (i < 0) return []
  const cuerpo = linea.slice(i + ' values ('.length)

  const out: string[] = []
  let actual = ''
  let enComillas = false
  let profundidad = 0

  for (let p = 0; p < cuerpo.length; p++) {
    const c = cuerpo[p]!
    if (enComillas) {
      if (c === "'" && cuerpo[p + 1] === "'") {
        actual += "'"
        p++
      } else if (c === "'") enComillas = false
      else actual += c
      continue
    }
    if (c === "'") { enComillas = true; continue }
    if (c === '(') { profundidad++; actual += c; continue }
    if (c === ')') {
      if (profundidad === 0) { out.push(actual.trim()); break }
      profundidad--
      actual += c
      continue
    }
    if (c === ',' && profundidad === 0) { out.push(actual.trim()); actual = ''; continue }
    actual += c
  }
  return out
}

function catalogoDesdeSeed(ruta: string): Catalogo {
  const lineas = readFileSync(ruta, 'utf8').split('\n')

  const edificios = new Map<string, { code: string; name: string }>()
  const zonas = new Map<string, { buildingId: string; name: string }>()
  const salas: SalaConocida[] = []
  const porId = new Map<string, SalaConocida>()

  for (const l of lineas) {
    if (l.startsWith('insert into buildings ')) {
      const v = partirValores(l)
      if (v[0]) edificios.set(v[0], { code: v[1] ?? '', name: v[2] ?? '' })
    } else if (l.startsWith('insert into zones ')) {
      const v = partirValores(l)
      if (v[0]) zonas.set(v[0], { buildingId: v[1] ?? '', name: v[2] ?? '' })
    }
  }

  for (const l of lineas) {
    if (!l.startsWith('insert into rooms ')) continue
    const v = partirValores(l)
    const [id, zoneId, code, name] = v
    if (!id || !zoneId) continue
    const zona = zonas.get(zoneId)
    const edificio = zona ? edificios.get(zona.buildingId) : undefined
    const sala: SalaConocida = {
      id,
      // El seed no lleva matrícula: la pone un disparador al insertar.
      shortRef: '',
      code: code ?? '',
      name: name ?? code ?? '',
      active: true,
      zona: zona?.name ?? 'SIN ZONA',
      edificioCodigo: edificio?.code ?? '??',
      edificioNombre: edificio?.name ?? '??',
      edificioActivo: true,
      alias: [],
    }
    salas.push(sala)
    porId.set(id, sala)
  }

  for (const l of lineas) {
    if (!l.startsWith('insert into room_aliases ')) continue
    const v = partirValores(l)
    const sala = porId.get(v[1] ?? '')
    if (sala && v[3]) sala.alias.push(v[3])
  }

  return { salas }
}

// -----------------------------------------------------------------------------
// El maestro, desde la base de datos
// -----------------------------------------------------------------------------

async function catalogoDesdeBase(url: string): Promise<Catalogo> {
  const { default: postgres } = await import('postgres')
  const sql = postgres(url, { max: 1 })
  try {
    const filas = await sql<
      Array<{
        id: string
        short_ref: string
        code: string
        name: string
        active: boolean
        zona: string
        edificio_codigo: string
        edificio_nombre: string
        edificio_activo: boolean
        alias: string[]
      }>
    >`
      select r.id, r.short_ref, r.code, r.name, r.active,
             z.name as zona,
             b.code as edificio_codigo, b.name as edificio_nombre, b.active as edificio_activo,
             coalesce(array_agg(a.alias_norm) filter (where a.alias_norm is not null), '{}') as alias
        from rooms r
        join zones z on z.id = r.zone_id
        join buildings b on b.id = z.building_id
        left join room_aliases a on a.room_id = r.id
       group by r.id, z.name, b.code, b.name, b.active
    `

    // Los edificios que ya no están. `merge_building` borra el de origen sin
    // dejar rastro en ninguna tabla viva: la auditoría es el único sitio donde
    // consta que existió.
    const muertos = await sql<Array<{ codigo: string; nombre: string; op: string }>>`
      select distinct on (old_data->>'code')
             old_data->>'code' as codigo,
             old_data->>'name' as nombre,
             op
        from audit_log
       where table_name = 'buildings'
         and (op = 'DELETE' or (op = 'UPDATE' and old_data->>'code' is distinct from new_data->>'code'))
         and old_data->>'code' is not null
       order by old_data->>'code', at desc
    `

    const vivos = new Set(filas.map((f) => f.edificio_codigo))
    const desaparecidos: EdificioDesaparecido[] = muertos
      .filter((m) => !vivos.has(m.codigo))
      .map((m) => ({
        codigo: m.codigo,
        nombre: m.nombre ?? m.codigo,
        motivo: m.op === 'DELETE' ? 'borrado o fusionado' : 'renombrado con otro código',
      }))

    return {
      salas: filas.map((f) => ({
        id: f.id,
        shortRef: f.short_ref,
        code: f.code,
        name: f.name,
        active: f.active,
        zona: f.zona,
        edificioCodigo: f.edificio_codigo,
        edificioNombre: f.edificio_nombre,
        edificioActivo: f.edificio_activo,
        alias: f.alias ?? [],
      })),
      edificiosDesaparecidos: desaparecidos,
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

// -----------------------------------------------------------------------------
// El informe
// -----------------------------------------------------------------------------

interface Bloque {
  titulo: string
  resoluciones: Resolucion[]
  etiquetas: string[]
}

function informe(bloque: Bloque): void {
  const c = contar(bloque.resoluciones)
  const pct = c.total ? Math.round((c.resueltas / c.total) * 100) : 0
  console.log(`\n── ${bloque.titulo}`)
  console.log(`   ${c.resueltas} de ${c.total} cruzan (${pct}%)`)
  for (const [via, n] of Object.entries(c.porVia).sort((a, b) => b[1] - a[1])) {
    console.log(`     · por ${via}: ${n}`)
  }
  if (c.conAviso) console.log(`   ${c.conAviso} con aviso (papelera, archivada o edificio desaparecido)`)
  if (c.ambiguas) console.log(`   ${c.ambiguas} ambiguas`)
  if (c.sinCruce) console.log(`   ${c.sinCruce} sin cruce`)

  const motivos = new Map<string, string[]>()
  bloque.resoluciones.forEach((r, i) => {
    if (r.estado === 'resuelta') return
    const clave = r.motivo.replace(/«[^»]*»/g, '«…»')
    const lista = motivos.get(clave) ?? []
    if (lista.length < 4) lista.push(bloque.etiquetas[i] ?? `fila ${i + 2}`)
    motivos.set(clave, lista)
  })
  if (motivos.size) {
    console.log('   Motivos:')
    for (const [motivo, ejemplos] of [...motivos.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`     · ${motivo}`)
      console.log(`         p. ej. ${ejemplos.join(', ')}`)
    }
  }
}

// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const usarSeed = args.includes('--seed')
  const ficheros = args.filter((a) => !a.startsWith('--'))
  const material = ficheros[0]
  const revision = ficheros[1]

  if (!material) {
    console.error('Uso: npm run cruce:excel -- <Material_Aulas.xlsx> [<AULAS_REVISION_UFV.xlsx>] [--seed]')
    process.exit(1)
  }

  let catalogo: Catalogo
  if (usarSeed) {
    catalogo = catalogoDesdeSeed('supabase/seed.sql')
    console.log(`Maestro: supabase/seed.sql — ${catalogo.salas.length} salas (instalación recién cargada)`)
  } else {
    const url = process.env.DATABASE_URL
    if (!url) {
      console.error(
        'Falta DATABASE_URL. Para cruzar sin base de datos, contra el maestro de una\n' +
          'instalación recién cargada:  npm run cruce:excel -- <xlsx> --seed',
      )
      process.exit(1)
    }
    catalogo = await catalogoDesdeBase(url)
    const enPapelera = catalogo.salas.filter((s) => !s.active || !s.edificioActivo).length
    console.log(
      `Maestro: la base de datos — ${catalogo.salas.length} salas` +
        (enPapelera ? `, ${enPapelera} archivadas` : '') +
        `, ${catalogo.edificiosDesaparecidos?.length ?? 0} edificios desaparecidos en la auditoría`,
    )
    for (const e of catalogo.edificiosDesaparecidos ?? []) {
      console.log(`   · ${e.nombre} (${e.codigo}): ${e.motivo}`)
    }
  }

  const ix = construirIndice(catalogo)
  const desconocidos = new Map<string, number>()

  /** Anota el código de edificio de una fila que no cruzó, si es que se lee uno. */
  const anotarDesconocido = (res: Resolucion, codigo: string): void => {
    if (res.estado === 'resuelta' || !codigo) return
    const c = codigo.toUpperCase()
    if (ix.edificioVivo.has(c)) return
    desconocidos.set(c, (desconocidos.get(c) ?? 0) + 1)
  }

  // --- Hoja de estado: edificio y planta van en celdas combinadas ---
  const estado = (await readXlsxFile(material, {
    sheet: 'Estado Aulas y Salas de reunion',
  })) as unknown[][]
  const resEstado: Resolucion[] = []
  const etqEstado: string[] = []
  let edificio = ''
  let zona = ''
  for (let r = 1; r < estado.length; r++) {
    const fila = estado[r]
    if (!fila) continue
    if (text(fila, 0)) edificio = text(fila, 0)
    if (text(fila, 1)) zona = text(fila, 1)
    const aula = text(fila, 2)
    if (!aula || !edificio) continue
    const res = resolverSala(ix, { tipo: 'estado', edificio, zona, aula })
    resEstado.push(res)
    etqEstado.push(`${aula} (${edificio})`)
  }
  informe({ titulo: 'Estado Aulas y Salas de reunion', resoluciones: resEstado, etiquetas: etqEstado })

  // --- Partes de material, los dos años ---
  for (const hoja of ['Material Instalado 2026', 'Material Instalado 2025']) {
    let filas: unknown[][]
    try {
      filas = (await readXlsxFile(material, { sheet: hoja })) as unknown[][]
    } catch {
      continue
    }
    const res: Resolucion[] = []
    const etq: string[] = []
    for (let r = 1; r < filas.length; r++) {
      const ref = text(filas[r] ?? [], 0)
      if (!ref) continue
      const r0 = resolverSala(ix, { tipo: 'parte', ref })
      res.push(r0)
      const sufijo = ref.trim().split(/\s+/).pop() ?? ''
      if (/^[A-Za-z]{1,4}$/.test(sufijo)) anotarDesconocido(r0, sufijo)
      etq.push(ref)
    }
    if (res.length) informe({ titulo: hoja, resoluciones: res, etiquetas: etq })
  }

  // --- Libro de revisión ---
  if (revision) {
    for (const hoja of ['Aulas Identificadas', 'Aulas No Identificadas']) {
      let filas: unknown[][]
      try {
        filas = (await readXlsxFile(revision, { sheet: hoja })) as unknown[][]
      } catch {
        continue
      }
      const res: Resolucion[] = []
      const etq: string[] = []
      // Fila 1 título, fila 2 cabecera, y filas de grupo con edificio y sin aula.
      for (let r = 2; r < filas.length; r++) {
        const fila = filas[r]
        if (!fila) continue
        const nombreAula = text(fila, 1)
        if (!nombreAula) continue
        const r0 = resolverSala(ix, {
          tipo: 'revision',
          edificio: text(fila, 0),
          nombreAula,
          codigoOficial: text(fila, 2),
        })
        res.push(r0)
        anotarDesconocido(r0, text(fila, 0).replace(/^edificio\s+/i, ''))
        etq.push(`${nombreAula} (${text(fila, 0)})`)
      }
      if (res.length) informe({ titulo: `${hoja} — ${revision.split('/').pop()}`, resoluciones: res, etiquetas: etq })
    }
  }

  // --- Los códigos de edificio que aparecen y el maestro no conoce ---
  //
  // Es el dato más accionable del informe: no son erratas, son edificios que
  // nadie ha dado de alta. Hasta que existan, ninguna de sus filas puede cruzar
  // por más listo que sea el resolutor.
  if (desconocidos.size) {
    console.log('\n── Códigos de edificio que aparecen y no están en el maestro')
    for (const [codigo, n] of [...desconocidos.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`     · ${codigo}: ${n} filas`)
    }
    console.log('   Ninguna de esas filas puede cruzar hasta que el edificio exista.')
  }

  console.log('\nNada se ha escrito: ni en la base, ni en el Excel.\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
