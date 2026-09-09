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
import {
  construirIndice,
  contar,
  equivalenciasDesdeAuditoria,
  nombresAnterioresDesdeAuditoria,
  codigosAnterioresDeSalaDesdeAuditoria,
  proponerEquivalencias,
  resolverSala,
} from '../src/domain/cruce'
import { OLD_BUILDING_CODES } from '../src/domain/normalize'
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

  const edificios = new Map<string, { code: string; name: string; sinIdentificar?: boolean }>()
  const zonas = new Map<string, { buildingId: string; name: string }>()
  const salas: SalaConocida[] = []
  const porId = new Map<string, SalaConocida>()

  for (const l of lineas) {
    if (l.startsWith('insert into buildings ')) {
      const v = partirValores(l)
      // v[4] es `needs_review`: el importador lo pone en los que vio en los
      // partes y no supo identificar.
      if (v[0]) edificios.set(v[0], { code: v[1] ?? '', name: v[2] ?? '', sinIdentificar: /true/i.test(v[4] ?? '') })
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

  return {
    salas,
    // Todos los edificios, tengan salas o no. Los seis «sin identificar» que el
    // importador creó desde los partes no tienen ninguna, y sin esta lista el
    // cruce diría que no existen.
    edificios: [...edificios.values()].map((e) => ({
      codigo: e.code,
      nombre: e.name,
      activo: true,
      sinIdentificar: e.sinIdentificar,
    })),
  }
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

    // Y a dónde fueron a parar, que es distinto de saber que se fueron.
    //
    // `rename_building` hace `update buildings set code` sobre la misma fila, y
    // `merge_building` mueve las zonas con `update zones set building_id` antes
    // de borrar el origen. Las dos cosas se auditan, así que la equivalencia
    // entre el código viejo y el edificio de hoy **está escrita**: no hay que
    // deducirla de las aulas ni preguntársela a nadie.
    const edificiosVivos = await sql<
      Array<{ id: string; codigo: string; nombre: string; activo: boolean; sin_identificar: boolean }>
    >`
      select id, code as codigo, name as nombre, active as activo,
             needs_review as sin_identificar
        from buildings
    `
    const renombrados = await sql<Array<{ row_id: string; codigo_viejo: string }>>`
      select row_id, old_data->>'code' as codigo_viejo
        from audit_log
       where table_name = 'buildings' and op = 'UPDATE'
         and old_data->>'code' is distinct from new_data->>'code'
         and old_data->>'code' is not null
    `
    const fusiones = await sql<Array<{ de_id: string; a_id: string }>>`
      select distinct old_data->>'building_id' as de_id,
                      new_data->>'building_id' as a_id
        from audit_log
       where table_name = 'zones' and op = 'UPDATE'
         and old_data->>'building_id' is distinct from new_data->>'building_id'
         and old_data->>'building_id' is not null
         and new_data->>'building_id' is not null
    `
    const borrados = await sql<Array<{ row_id: string; codigo: string }>>`
      select row_id, old_data->>'code' as codigo
        from audit_log
       where table_name = 'buildings' and op = 'DELETE'
         and old_data->>'code' is not null
    `
    // El renombrado que no toca el código: el edificio es el mismo y sigue
    // donde estaba, pero el libro lo llama como se llamaba antes.
    const renombresDeNombre = await sql<Array<{ row_id: string; nombre_viejo: string }>>`
      select row_id, old_data->>'name' as nombre_viejo
        from audit_log
       where table_name = 'buildings' and op = 'UPDATE'
         and old_data->>'name' is distinct from new_data->>'name'
         and old_data->>'name' is not null
    `

    // La otra rama de `merge_building`: cuando todas las plantas del origen
    // chocan de nombre con las del destino, se mueven las aulas y se borra la
    // planta sin que ningún `building_id` cambie, y la fusión no deja rastro. La
    // lápida `merged_into` la hace visible.
    const lapidas = await sql<Array<{ de_id: string; a_id: string }>>`
      select row_id as de_id, old_data->>'merged_into' as a_id
        from audit_log
       where table_name = 'buildings' and op = 'DELETE'
         and old_data->>'merged_into' is not null
    `
    // Los códigos que cada sala tuvo antes. Es lo que rescata un renombrado
    // cuando el alias ya no alcanza: va anclado al `id` de la sala, que no cambia
    // ni al renombrarla, ni al moverla de planta, ni al fusionar su edificio.
    const salasRenombradas = await sql<Array<{ row_id: string; codigo_viejo: string }>>`
      select row_id, old_data->>'code' as codigo_viejo
        from audit_log
       where table_name = 'rooms' and op = 'UPDATE'
         and old_data->>'code' is distinct from new_data->>'code'
         and old_data->>'code' is not null
    `

    const rastro = {
      vivos: edificiosVivos.map((e) => ({ id: e.id, codigo: e.codigo })),
      renombrados: renombrados.map((r) => ({ rowId: r.row_id, codigoViejo: r.codigo_viejo })),
      fusiones: [
        ...fusiones.map((f) => ({ deId: f.de_id, aId: f.a_id })),
        ...lapidas.map((l) => ({ deId: l.de_id, aId: l.a_id })),
      ],
      borrados: borrados.map((b) => ({ rowId: b.row_id, codigo: b.codigo })),
      salasRenombradas: salasRenombradas.map((r) => ({
        rowId: r.row_id,
        codigoViejo: r.codigo_viejo,
      })),
      nombresCambiados: renombresDeNombre.map((r) => ({
        rowId: r.row_id,
        nombreViejo: r.nombre_viejo,
      })),
    }
    const equivalencias = equivalenciasDesdeAuditoria(rastro)
    const nombresViejos = nombresAnterioresDesdeAuditoria(rastro)
    const codigosViejosDeSala = codigosAnterioresDeSalaDesdeAuditoria(rastro)

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
      edificios: edificiosVivos.map((e) => ({
        codigo: e.codigo,
        nombre: e.nombre,
        activo: e.activo,
        sinIdentificar: e.sin_identificar,
      })),
      edificiosDesaparecidos: desaparecidos,
      // Lo declarado a mano manda sobre lo deducido: si alguien escribió una
      // línea en `OLD_BUILDING_CODES` es porque sabe algo que la auditoría no
      // puede saber —los códigos que ya eran viejos antes de cargar la base.
      equivalencias: { ...equivalencias, ...OLD_BUILDING_CODES },
      nombresViejos,
      codigosViejosDeSala,
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
    console.log(
      '   ⚠ El seed no tiene auditoría ni renombrados: en este maestro ningún\n' +
        '     edificio ha cambiado nunca de nombre. Lo que salga abajo sobre\n' +
        '     nomenclatura vieja no dice qué pasó de verdad — para eso hace falta\n' +
        '     la base, que es donde están los cambios: DATABASE_URL=… sin --seed.',
    )
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
    const n = Object.keys(catalogo.equivalencias ?? {}).length
    if (n) {
      console.log(`   ${n} equivalencias de nomenclatura vieja reconstruidas desde la auditoría:`)
      for (const [viejo, actual] of Object.entries(catalogo.equivalencias ?? {})) {
        console.log(`   · ${viejo} → ${actual}`)
      }
    }
    const nombres = catalogo.nombresViejos ?? []
    if (nombres.length) {
      console.log(`   ${nombres.length} nombres anteriores de edificios que siguen vivos:`)
      for (const x of nombres) console.log(`   · «${x.nombre}» era ${x.codigo}`)
    }
    const salas = catalogo.codigosViejosDeSala ?? []
    if (salas.length) {
      console.log(`   ${salas.length} códigos anteriores de sala reconstruidos desde la auditoría`)
    }
  }

  const ix = construirIndice(catalogo)
  const desconocidos = new Map<string, { filas: number; aulas: string[] }>()

  /**
   * Anota el código de edificio de una fila que no cruzó, **y con qué aula
   * venía**. El aula es lo que después permite deducir a qué edificio de hoy
   * corresponde el código viejo: los nombres no se parecen, las aulas sí están.
   */
  const anotarDesconocido = (res: Resolucion, codigo: string, aula: string): void => {
    if (res.estado === 'resuelta' || !codigo) return
    const c = codigo.toUpperCase()
    if (ix.edificioVivo.has(c)) return
    const v = desconocidos.get(c) ?? { filas: 0, aulas: [] }
    v.filas++
    if (aula) v.aulas.push(aula)
    desconocidos.set(c, v)
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
      const trozos = ref.trim().split(/\s+/)
      const sufijo = trozos[trozos.length - 1] ?? ''
      if (/^[A-Za-z]{1,4}$/.test(sufijo)) {
        anotarDesconocido(r0, sufijo, trozos.slice(0, -1).join(' '))
      }
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
        anotarDesconocido(r0, text(fila, 0).replace(/^edificio\s+/i, ''), nombreAula)
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
    console.log('   Es nomenclatura anterior a los renombrados: no son edificios que dar de')
    console.log('   alta. Los cambios hechos en la aplicación ya se han traducido arriba con')
    console.log('   la auditoría; lo que queda aquí es lo que la aplicación no puede saber:')
    console.log('   códigos que ya eran viejos antes de cargar la base. Para ésos se intenta')
    console.log('   deducir de las aulas, con la cautela de abajo.\n')

    const equivalencias = proponerEquivalencias(
      ix,
      [...desconocidos.entries()].map(([codigo, v]) => ({ codigo, aulas: v.aulas })),
    )
    const filasDe = (c: string): number => desconocidos.get(c)?.filas ?? 0

    for (const eq of equivalencias.sort((a, b) => filasDe(b.codigo) - filasDe(a.codigo))) {
      const n = filasDe(eq.codigo)
      console.log(
        `     · ${eq.codigo}: ${n} ${n === 1 ? 'fila' : 'filas'}, ` +
          `${eq.aulas} ${eq.aulas === 1 ? 'aula' : 'aulas'}` +
          (eq.reconocibles < eq.aulas ? ` (${eq.reconocibles} siguen existiendo)` : ''),
      )
      for (const c of eq.candidatas.slice(0, 3)) {
        console.log(
          `         ${c.edificioNombre} (${c.edificioCodigo}): ${c.aciertos} de ${eq.reconocibles}` +
            `, ${c.exclusivos} solo suyas`,
        )
      }
      console.log(
        eq.veredicto === 'unica'
          ? `         → aplicable: ${eq.motivo}`
          : `         → no: ${eq.motivo}`,
      )
    }

    const unicas = equivalencias.filter((e) => e.veredicto === 'unica')
    const pendientes = equivalencias.filter((e) => e.veredicto !== 'unica')
    const filasDeUnicas = unicas.reduce((n, e) => n + filasDe(e.codigo), 0)
    const filasPendientes = pendientes.reduce((n, e) => n + filasDe(e.codigo), 0)

    console.log(
      `\n   ${unicas.length} de ${equivalencias.length} códigos los decide la evidencia ` +
        `(${filasDeUnicas} filas). Los otros ${pendientes.length} (${filasPendientes} filas) ` +
        `no los decide nadie más que tú.`,
    )
    console.log('   Las equivalencias se declaran en `OLD_BUILDING_CODES`, en src/domain/normalize.ts:\n')
    // `ARTES Y DISEÑO 2` no es un identificador: si sale sin comillas, la línea
    // pegada tal cual no compila.
    const clave = (c: string): string => (/^[A-Za-z_$][\w$]*$/.test(c) ? c : `'${c}'`)
    const cuantas = (c: string): string => {
      const n = filasDe(c)
      return `${n} ${n === 1 ? 'fila' : 'filas'}`
    }
    for (const eq of unicas) {
      console.log(`     ${clave(eq.codigo)}: '${eq.candidatas[0]?.edificioCodigo}',   // ${cuantas(eq.codigo)} — ${eq.motivo}`)
    }
    for (const eq of pendientes) {
      const sugerencia = eq.candidatas[0]?.edificioCodigo ?? '???'
      console.log(`     // ${clave(eq.codigo)}: '${sugerencia}',   // ${cuantas(eq.codigo)} — ${eq.motivo}`)
    }
    console.log('\n   Cada línea que añadas hace cruzar sus filas en la pasada siguiente,')
    console.log('   marcadas como `nomenclatura-vieja` y no como si fueran del maestro de hoy.')
  }

  console.log('\nNada se ha escrito: ni en la base, ni en el Excel.\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
