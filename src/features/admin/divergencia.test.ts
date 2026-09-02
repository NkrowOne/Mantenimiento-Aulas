/**
 * Divergencia: la aplicación cambió y el libro que sale tiene que decirlo.
 *
 * `idaYVuelta.test.ts` comprueba que, con la aplicación siendo un espejo del
 * libro, dos pasadas seguidas lo dejan quieto. Eso descarta el vaivén y no
 * comprueba lo que de verdad hace la sincronización: **llevar al libro lo que
 * cambió en la aplicación**. Aquí se parte del espejo y se cambia la app tal y
 * como cambia de verdad —aulas nuevas, una sala que se muda de edificio, otra
 * que cambia de planta, seriales, modelos, un aula archivada, el almacén, un
 * parte nuevo y uno resuelto— y se mira, celda a celda, dónde aterrizó cada
 * cambio en el libro generado.
 *
 * Corre sobre el libro real y por eso se salta sin él:
 * `LIBRO_XLSX=…/Material_Aulas.xlsx npm test`. `SALIDA=…/prefijo` guarda los
 * libros que salen para abrirlos con Excel.
 *
 * No afirma nada a medias: recoge TODOS los fallos en una lista y la compara con
 * la vacía, para que un fallo no tape a los demás.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { abrirLibro, celdasCombinadas, leerHoja } from '@/domain/xlsx'
import type { FilaLeida } from '@/domain/xlsx'
import { BOLSA_2025, BOLSA_2026, ESTADO, MATERIAL_2025, MATERIAL_2026 } from '@/domain/mapa'
import { escribir as escribirPasada } from '@/features/admin/pasada'
import type { Analisis } from '@/features/admin/pasada'
import { datosDelLibro, formaDe, instantaneaDe, norm, pasada, txt, vaivenesDe } from './espejoDelLibro'
import type { Datos } from './espejoDelLibro'

const RUTA = process.env.LIBRO_XLSX
const SALIDA = process.env.SALIDA

/** Edificio y planta que hereda cada fila, recorriendo la hoja como se lee. */
function sitios(filas: FilaLeida[]): Map<number, { edificio: string; zona: string }> {
  const out = new Map<number, { edificio: string; zona: string }>()
  let edificio = ''
  let zona = ''
  for (const f of filas) {
    if (f.fila <= 1) continue
    if (txt(f.celdas.A) !== '') edificio = txt(f.celdas.A)
    if (txt(f.celdas.B) !== '') zona = txt(f.celdas.B)
    out.set(f.fila, { edificio, zona })
  }
  return out
}

function filaPorRef(filas: FilaLeida[], colRef: string, ref: string): FilaLeida | undefined {
  return filas.find((f) => txt(f.celdas[colRef]) === ref)
}

const datosParaLasHojasNuevas = (d: Datos) => {
  const s = d.salas[0]!
  return {
    revisiones: [
      {
        shortRef: s.shortRef,
        edificio: s.edificio,
        zona: s.zona,
        sala: s.code,
        cuando: '2026-09-01T09:30:00Z',
        quien: 'Ana',
        estado: 'cerrada',
        resultado: 'ok',
        horasProyector: 4200,
        lampara: 0.86,
        comprobaciones: 'altavoces: ok',
        incidenciasAbiertas: 0,
        notas: 'Todo bien',
      },
    ],
    movimientos: [
      {
        cuando: '2026-09-01',
        articulo: 'Cable HDMI',
        cantidad: -2,
        tipo: 'consumo',
        incidencia: 'I260901_0001',
        sala: s.code,
        quien: 'Ana',
        nota: null,
      },
    ],
    equipos: d.salas.slice(0, 3).flatMap((x) =>
      x.equipos.map((e) => ({
        shortRef: x.shortRef,
        edificio: x.edificio,
        zona: x.zona,
        sala: x.code,
        tipo: e.tipo,
        modelo: e.model,
        serial: e.serial,
        estado: 'activo',
        desde: e.desde,
        etiqueta: null,
      })),
    ),
  }
}

describe.skipIf(!RUTA)('la aplicación cambió y el libro lo dice', () => {
  it('cada cambio aterriza donde tiene que aterrizar, y la pasada siguiente no se mueve', async () => {
    const bytes0 = new Uint8Array(readFileSync(RUTA!))
    const libro0 = await abrirLibro(bytes0)
    const estado0 = await leerHoja(libro0, ESTADO.nombre)
    const datos = datosDelLibro(
      estado0,
      await leerHoja(libro0, MATERIAL_2026.nombre),
      await leerHoja(libro0, BOLSA_2026.nombre),
      { mat: await leerHoja(libro0, MATERIAL_2025.nombre), bolsa: await leerHoja(libro0, BOLSA_2025.nombre) },
    )
    // Las salas de dos filas: la cabeza de cada combinación vertical.
    const cabezasCombinadas = new Set<number>()
    for (const r of await celdasCombinadas(libro0, ESTADO.nombre)) {
      const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(r.toUpperCase())
      if (m && Number(m[4]) > Number(m[2])) cabezasCombinadas.add(Number(m[2]))
    }
    const deDosFilas = (s: { shortRef: string }) => cabezasCombinadas.has(datos.filaDe.get(s.shortRef) ?? -1)
    const fallos: string[] = []
    const falla = (que: string): void => {
      fallos.push(que)
    }

    // -------------------------------------------------------------------------
    // Lo que cambia en la aplicación. Cada cambio con nombre, para poder decir
    // después cuál no llegó.
    // -------------------------------------------------------------------------
    // En este libro casi todas las filas llevan el edificio escrito (con un
    // espacio delante); solo unas pocas lo heredan en blanco. La mudanza se
    // prueba con una de cada: la que lo lleva es el caso común, y la que lo
    // hereda es la que no dice de qué edificio es.
    const enLaHoja = datos.salas.filter((s) => datos.filaDe.has(s.shortRef))
    const heredan = enLaHoja.filter((s) => !datos.llevaEdificio.has(s.shortRef))
    const elegir = <T,>(que: string, lista: T[], pred: (x: T) => boolean): T => {
      const x = lista.find(pred)
      if (!x) throw new Error(`no hay con qué probar ${que}`)
      return x
    }
    const m3 = elegir('M3', enLaHoja, (s) => datos.llevaEdificio.has(s.shortRef) && s.equipos.length > 0 && !deDosFilas(s))
    const edificioA = m3.edificio
    const otroEdificio = elegir('otro edificio', [...new Set(datos.salas.map((s) => s.edificio))], (e) => e !== edificioA)

    // M1 — aula nueva en un edificio que ya está en la hoja.
    datos.salas.push({
      id: 'S-M1',
      shortRef: 'SALA-900001',
      edificio: edificioA,
      zona: datos.salas[0]!.zona,
      code: '9.1',
      activa: true,
      projectorHours: 120,
      lampPct: 0.5,
      botoneraEstado: 'Actualizada',
      capacidades: { altavoces: true, camara: false },
      revisiones: ['2026-08-15'],
      notas: null,
      equipos: [{ id: 'M1-P', tipo: 'Proyector', serial: 'SN-M1-PROY', model: 'EB-M1', desde: '2026-08-01' }],
    })

    // M2 — aula nueva en un edificio que NO está en la hoja: abre bloque.
    datos.salas.push({
      id: 'S-M2',
      shortRef: 'SALA-900002',
      edificio: 'EDIFICIO NUEVO ZZ',
      zona: 'PLANTA BAJA',
      code: '0.1',
      activa: true,
      projectorHours: null,
      lampPct: null,
      botoneraEstado: null,
      capacidades: {},
      revisiones: [],
      notas: null,
      equipos: [],
    })

    // M3 — una sala que hereda el edificio (no lo lleva escrito) se muda a otro.
    const m3Antes = datos.sitioDe.get(m3.shortRef)!
    m3.edificio = otroEdificio

    // M3b — la misma mudanza pedida sobre una sala DE DOS FILAS (dos proyectores,
    // celdas combinadas). No se puede mover desde la app sin perder la segunda
    // fila: se queda donde está, y la pasada lo dice.
    const m3b = enLaHoja.find((s) => s !== m3 && deDosFilas(s)) ?? null
    const m3bAntes = m3b ? datos.sitioDe.get(m3b.shortRef)! : null
    if (m3b) m3b.edificio = otroEdificio

    // M4 — otra sala cambia de planta dentro de su edificio.
    const m4 = elegir('M4', enLaHoja, (s) => s !== m3 && s !== m3b && s.edificio === edificioA)
    m4.zona = 'PLANTA NUEVA'

    console.log(
      `[divergencia] ${datos.salas.length} salas, ${heredan.length} heredan el edificio · ` +
        `M3 «${m3.code}» de «${edificioA}» → «${otroEdificio}» (fila ${datos.filaDe.get(m3.shortRef)}) · ` +
        `M3b ${m3b ? `«${m3b.code}» (fila ${datos.filaDe.get(m3b.shortRef)})` : 'sin candidata'} · ` +
        `M4 «${m4.code}» de «${m4.edificio}» (fila ${datos.filaDe.get(m4.shortRef)}) · M3 revisiones=${JSON.stringify(m3.revisiones)}`,
    )

    // M5/M6 — a una sala con proyector le cambian el número de serie y el modelo.
    const m5 = elegir('M5', enLaHoja, (s) => ![m3, m3b, m4].includes(s) && s.equipos.some((e) => e.tipo === 'Proyector' && !!e.serial))
    const proy = m5.equipos.find((e) => e.tipo === 'Proyector')!
    proy.serial = 'SN-M5-NUEVO'
    proy.model = 'MODELO-M6'

    // M7 — a una sala sin TV le ponen una, con serial y modelo.
    const m7 = elegir('M7', enLaHoja, (s) => ![m3, m3b, m4, m5].includes(s) && !s.equipos.some((e) => e.tipo === 'TV'))
    m7.equipos.push({ id: 'M7-TV', tipo: 'TV', serial: 'SN-M7-TV', model: 'TV-M7', desde: '2026-08-20' })

    // M8 — una sala se archiva: su fila sale del libro.
    const m8 = elegir('M8', enLaHoja, (s) => ![m3, m3b, m4, m5, m7].includes(s) && !deDosFilas(s))
    m8.activa = false

    // M8b — se archiva una sala DE DOS FILAS: se van las dos, no solo la cabeza.
    const m8b = enLaHoja.find((s) => ![m3, m3b, m4, m5, m7, m8].includes(s) && deDosFilas(s)) ?? null
    const m8bFila = m8b ? datos.filaDe.get(m8b.shortRef)! : -1
    const m8bSerialesDeLaCola = m8b
      ? estado0.filter((f) => f.fila > m8bFila && f.fila <= m8bFila + 2 && txt(f.celdas.C) === '').flatMap((f) => ['M', 'O', 'Q'].map((l) => txt(f.celdas[l])).filter(Boolean))
      : []
    if (m8b) m8b.activa = false

    // M9 — el almacén: cambia el consumo de marzo y lo comprado de un artículo.
    const m9 = datos.articulos[0]!
    const m9MarzoAntes = m9.meses[2]!
    m9.meses[2] = m9MarzoAntes + 5
    const m9CompradoAntes = m9.comprado ?? 0
    m9.comprado = m9CompradoAntes + 10

    // M10 — un artículo nuevo en el almacén.
    datos.articulos.push({ id: 'A-M10', nombre: 'Cable de prueba XYZ', meses: [1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0], comprado: 7 })
    const resolverAntes = datos.resolver
    datos.resolver = (n) => (norm(n) === norm('Cable de prueba XYZ') ? 'A-M10' : resolverAntes(n))

    // M11 — un parte nuevo en la aplicación.
    datos.incidencias.push({
      id: 'I260901_0001',
      numero: 'I260901_0001',
      salaCode: m5.code,
      abierta: '2026-09-01',
      resuelta: null,
      problema: 'Prueba de divergencia',
      observacion: null,
      resolucion: null,
      material: '2 Cable HDMI',
    })

    // M12 — un parte que estaba abierto se resuelve. Uno cuya celda de fecha
    // resuelta esté VACÍA de verdad: el libro trae alguna ilegible («1902-26»),
    // y ésas la pasada hace bien en no pisarlas —van a cuarentena—.
    const mat0 = await leerHoja(libro0, MATERIAL_2026.nombre)
    const vaciaC = new Set(mat0.filter((f) => f.fila > 1 && txt(f.celdas.D) !== '' && (f.celdas.C === undefined || f.celdas.C === null || txt(f.celdas.C) === '')).map((f) => txt(f.celdas.D)))
    const m12 = elegir('M12', datos.incidencias, (i) => i.resuelta === null && vaciaC.has(i.numero))
    m12.resuelta = '2026-09-02'

    // -------------------------------------------------------------------------
    // Pasada 1: la que lleva los cambios al libro.
    // -------------------------------------------------------------------------
    const p1 = await pasada(bytes0, datos, () => undefined)
    const a1 = {
      libro: p1.libro,
      planes: p1.planes,
      hojasNuevas: [],
      datos: datosParaLasHojasNuevas(datos),
    } as unknown as Analisis
    const bytes1 = await escribirPasada(a1, '2026-09-02 10:00')
    if (SALIDA) writeFileSync(`${SALIDA}-divergencia-1.xlsx`, bytes1)

    for (const p of p1.planes) {
      console.log(
        `[pasada 1] ${p.hoja}: celdas=${p.celdas.length} inserta=${p.insertar.length} borra=${p.borrar.length} ` +
          `aLaBase=${p.haciaLaBase.length} conflictos=${p.conflictos.length} cuarentena=${p.cuarentena.length} sinCruzar=${p.sinCruzar.length} avisos=${p.avisos.length}`,
      )
    }
    if (process.env.DIVERGENCIA_DUMP) {
      for (const p of p1.planes) {
        const n = (l: unknown[]) => l.length
        console.log(`\n#### ${p.hoja}`)
        console.log(`celdas (${n(p.celdas)}):`, p.celdas.slice(0, 14).map((c) => `${c.celda}=${JSON.stringify(c.valor)}`).join(' '))
        console.log(`aLaBase (${n(p.haciaLaBase)}):`, p.haciaLaBase.slice(0, 8).map((h) => `${h.letra}${h.fila} ${h.campo}=${JSON.stringify(h.valor)} [${h.motivo}]`).join(' | '))
        console.log(`cuarentena (${n(p.cuarentena)}):`, p.cuarentena.map((q) => `${q.letra}${q.fila}=${JSON.stringify(q.crudo)} (${q.motivo})`).join(' | '))
        console.log(`sinCruzar (${n(p.sinCruzar)}):`, p.sinCruzar.slice(0, 6).map((x) => `${x.fila}: ${x.motivo}`).join(' | '))
        const tipos = new Map<string, number>()
        for (const a of p.avisos) { const k = a.replace(/^[A-Z]+\d+ \([^)]*\)/, 'X').replace(/\d+/g, 'N').slice(0, 60); tipos.set(k, (tipos.get(k) ?? 0) + 1) }
        console.log(`avisos (${n(p.avisos)}):`, [...tipos.entries()].map(([k, v]) => `${v}× ${k}`).join(' | '))
      }
    }
    const libro1 = await abrirLibro(bytes1)
    const estado1 = await leerHoja(libro1, ESTADO.nombre)
    const mat1 = await leerHoja(libro1, MATERIAL_2026.nombre)
    const bolsa1 = await leerHoja(libro1, BOLSA_2026.nombre)
    const ref = datos.columnaRef
    const sitio1 = sitios(estado1)

    // M1
    {
      const f = filaPorRef(estado1, ref, 'SALA-900001')
      if (!f) falla('M1: el aula nueva 9.1 no está en el libro')
      else {
        const s = sitio1.get(f.fila)!
        if (s.edificio !== edificioA) falla(`M1: el aula nueva quedó en «${s.edificio}» y no en «${edificioA}»`)
        if (txt(f.celdas.C) !== '9.1') falla(`M1: C dice «${txt(f.celdas.C)}»`)
        if (txt(f.celdas.M) !== 'SN-M1-PROY') falla(`M1: S/N Proyector dice «${txt(f.celdas.M)}»`)
        if (txt(f.celdas.L) !== 'EB-M1') falla(`M1: Modelo Proyector dice «${txt(f.celdas.L)}»`)
        if (txt(f.celdas.K) !== 'Actualizada') falla(`M1: Botonera dice «${txt(f.celdas.K)}»`)
        if (txt(f.celdas.H) !== 'SI') falla(`M1: Altavoces dice «${txt(f.celdas.H)}»`)
        if (f.celdas.F !== 120) falla(`M1: Horas dice «${String(f.celdas.F)}»`)
        if (f.celdas.D === undefined) falla('M1: la fecha de revisión no se escribió')
      }
    }
    // M2
    {
      const f = filaPorRef(estado1, ref, 'SALA-900002')
      if (!f) falla('M2: el aula del edificio nuevo no está en el libro')
      else {
        if (txt(f.celdas.A) !== 'EDIFICIO NUEVO ZZ') falla(`M2: A dice «${txt(f.celdas.A)}» (tenía que abrir bloque)`)
        if (txt(f.celdas.B) !== 'PLANTA BAJA') falla(`M2: B dice «${txt(f.celdas.B)}»`)
        if (txt(f.celdas.C) !== '0.1') falla(`M2: C dice «${txt(f.celdas.C)}»`)
      }
    }
    // M3 — la mudanza de edificio
    {
      const f = filaPorRef(estado1, ref, m3.shortRef)
      if (!f) falla(`M3: la sala mudada «${m3.code}» desapareció del libro`)
      else {
        const s = sitio1.get(f.fila)!
        if (s.edificio !== otroEdificio) {
          falla(
            `M3: «${m3.code}» se mudó de «${m3Antes.edificio}» a «${otroEdificio}» en la app, pero en el libro sigue en «${s.edificio}» (fila ${f.fila})`,
          )
        }
      }
    }
    // Y la fila vieja se fue con ella: una sola fila con ese código en el libro.
    for (const [nombre, sala, antes] of [['M3', m3, m3Antes], ...(m3b ? [['M3b', m3b, m3bAntes!] as const] : [])] as const) {
      const filas = estado1.filter((f) => txt(f.celdas.C) === sala.code && sitio1.get(f.fila)?.edificio === antes.edificio)
      if (filas.length) falla(`${nombre}: «${sala.code}» sigue teniendo fila en «${antes.edificio}» (${filas.map((f) => f.fila).join(', ')}), huérfana y sin matrícula`)
      const conRef = estado1.filter((f) => txt(f.celdas[ref]) === sala.shortRef)
      if (conRef.length !== 1) falla(`${nombre}: «${sala.code}» tiene ${conRef.length} filas con su matrícula`)
    }
    // M3b — la sala de dos filas no se mueve: sigue donde estaba, entera, y avisa.
    if (m3b) {
      const filas = estado1.filter((f) => txt(f.celdas[ref]) === m3b.shortRef)
      if (filas.length !== 1) falla(`M3b: «${m3b.code}» tiene ${filas.length} filas y tenía que seguir teniendo una`)
      const f = filas[0]
      // Sigue en su bloque de siempre —la fila no se ha movido— aunque su celda de
      // edificio ya diga el nuevo: eso es lo que hace un renombrado en el sitio.
      if (f && !(sitio1.get(f.fila)?.edificio === m3bAntes!.edificio || txt(f.celdas.A) === otroEdificio)) falla(`M3b: la sala de dos filas se movió y no debía: está en «${sitio1.get(f.fila)?.edificio}»`)
      if (f && Math.abs(f.fila - datos.filaDe.get(m3b.shortRef)!) > 6) falla(`M3b: la fila de la sala de dos filas se ha ido lejos (${datos.filaDe.get(m3b.shortRef)} → ${f.fila})`)
      // Y su cola sigue justo debajo.
      if (f && !(estado1.find((x) => x.fila === f.fila + 1) && txt(estado1.find((x) => x.fila === f.fila + 1)!.celdas.C) === '')) falla('M3b: la fila de continuación ya no está debajo de la cabeza')
      const avisos = p1.planes.find((p) => p.hoja === ESTADO.nombre)!.avisos
      if (!avisos.some((a) => a.includes(m3b.code) && a.includes('combinada'))) falla('M3b: la pasada no avisó de que la sala de dos filas no se mueve')
    }
    // M8b — archivar una sala de dos filas se lleva las dos
    if (m8b) {
      const s8b = datos.sitioDe.get(m8b.shortRef)!
      if (estado1.some((f) => txt(f.celdas.C) === m8b.code && sitio1.get(f.fila)?.edificio === s8b.edificio)) falla(`M8b: la sala archivada de dos filas «${m8b.code}» sigue en «${s8b.edificio}»`)
      if (estado1.some((f) => txt(f.celdas[ref]) === m8b.shortRef)) falla('M8b: la sala archivada de dos filas sigue con matrícula en el libro')
      for (const sn of m8bSerialesDeLaCola) {
        if (estado1.some((f) => ['M', 'O', 'Q'].some((l) => txt(f.celdas[l]) === sn))) falla(`M8b: el serial «${sn}» de la fila de continuación sigue en el libro: quedó huérfana`)
      }
    }
    // Bolsa — los meses en blanco siguen en blanco: la app dice 0 y eso no se escribe
    {
      const bolsa0 = await leerHoja(libro0, BOLSA_2026.nombre)
      const ceros = bolsa1.filter((f) => f.fila > 1 && f.fila !== Number(m9.id.slice(1)) && txt(f.celdas.A) !== 'Cable de prueba XYZ').flatMap((f) =>
        'BCDEFGHIJKLM'.split('').filter((l) => f.celdas[l] === 0 && (bolsa0.find((x) => x.fila === f.fila)?.celdas[l] ?? null) === null).map((l) => `${l}${f.fila}`),
      )
      if (ceros.length) falla(`Bolsa: ${ceros.length} meses en blanco se rellenaron con 0 (${ceros.slice(0, 6).join(', ')}…)`)
    }
    // M4 — el cambio de planta
    {
      const f = filaPorRef(estado1, ref, m4.shortRef)
      if (!f) falla(`M4: «${m4.code}» desapareció del libro`)
      else {
        const s = sitio1.get(f.fila)!
        if (s.zona !== 'PLANTA NUEVA') {
          falla(`M4: «${m4.code}» cambió a «PLANTA NUEVA» en la app, pero en el libro sigue en «${s.zona}» (fila ${f.fila})`)
        }
      }
    }
    // M5/M6
    {
      const f = filaPorRef(estado1, ref, m5.shortRef)!
      if (txt(f.celdas.M) !== 'SN-M5-NUEVO') falla(`M5: el serial nuevo del proyector no llegó: M dice «${txt(f.celdas.M)}»`)
      if (txt(f.celdas.L) !== 'MODELO-M6') falla(`M6: el modelo nuevo del proyector no llegó: L dice «${txt(f.celdas.L)}»`)
    }
    // M7
    {
      const f = filaPorRef(estado1, ref, m7.shortRef)!
      if (txt(f.celdas.Q) !== 'SN-M7-TV') falla(`M7: el serial de la TV nueva no llegó: Q dice «${txt(f.celdas.Q)}»`)
      if (txt(f.celdas.P) !== 'TV-M7') falla(`M7: el modelo de la TV nueva no llegó: P dice «${txt(f.celdas.P)}»`)
    }
    // M8
    {
      if (filaPorRef(estado1, ref, m8.shortRef)) falla(`M8: la sala archivada «${m8.code}» sigue en el libro`)
      // Y su código no puede seguir en ninguna fila: sería la misma sala sin matrícula.
      const s8 = datos.sitioDe.get(m8.shortRef)!
      const huerfana = estado1.find(
        (f) => txt(f.celdas.C) === m8.code && sitio1.get(f.fila)?.edificio === s8.edificio && txt(f.celdas[ref]) === '',
      )
      if (huerfana) falla(`M8: la sala archivada sigue como fila sin matrícula (fila ${huerfana.fila})`)
    }
    // M9
    {
      const f = bolsa1.find((x) => x.fila === Number(m9.id.slice(1)))!
      if (f.celdas.D !== m9MarzoAntes + 5) falla(`M9: marzo (D) dice «${String(f.celdas.D)}» y tenía que decir ${m9MarzoAntes + 5}`)
      if (f.celdas.P !== m9CompradoAntes + 10) falla(`M9: Comprado (P) dice «${String(f.celdas.P)}» y tenía que decir ${m9CompradoAntes + 10}`)
    }
    // M10
    {
      const f = bolsa1.find((x) => txt(x.celdas.A) === 'Cable de prueba XYZ')
      if (!f) falla('M10: el artículo nuevo no está en la bolsa')
      else {
        if (f.celdas.B !== 1 || f.celdas.D !== 2) falla(`M10: meses del artículo nuevo: B=${String(f.celdas.B)} D=${String(f.celdas.D)}`)
        if (f.celdas.P !== 7) falla(`M10: Comprado del artículo nuevo dice «${String(f.celdas.P)}»`)
        if (!f.formulas?.N) falla('M10: el artículo nuevo no lleva la fórmula del total en N')
        if (!f.formulas?.O) falla('M10: el artículo nuevo no lleva la fórmula del disponible en O')
      }
      // Y TODAS las filas de la bolsa —las de siempre y las nuevas— suman su
      // propia fila: la segunda fila nueva sumaba la de la primera.
      for (const x of bolsa1) {
        if (x.fila <= 1 || !x.formulas?.N) continue
        const filasCitadas = [...new Set([...x.formulas.N.matchAll(/[A-Z]+(\d+)/g)].map((m) => Number(m[1])))]
        if (filasCitadas.some((n) => n !== x.fila)) falla(`Bolsa: la fórmula de N${x.fila} cita otra fila: ${x.formulas.N}`)
      }
    }
    // M11
    {
      const f = mat1.find((x) => txt(x.celdas.D) === 'I260901_0001')
      if (!f) falla('M11: el parte nuevo no está en Material Instalado 2026')
      else {
        if (txt(f.celdas.A) !== m5.code) falla(`M11: el aula del parte nuevo dice «${txt(f.celdas.A)}»`)
        if (typeof f.celdas.B !== 'number') falla(`M11: la fecha del parte nuevo no es una fecha: «${String(f.celdas.B)}»`)
        if (txt(f.celdas.E) !== 'Prueba de divergencia') falla(`M11: el problema dice «${txt(f.celdas.E)}»`)
        if (txt(f.celdas.G) !== '2 Cable HDMI') falla(`M11: el material dice «${txt(f.celdas.G)}»`)
      }
    }
    // Los partes de 2025 no entran en la hoja de 2026: cada año en su hoja.
    {
      const numeros2026 = new Set(mat0.filter((f) => f.fila > 1).map((f) => txt(f.celdas.D)).filter(Boolean))
      const mat25 = await leerHoja(libro0, MATERIAL_2025.nombre)
      const soloDe2025 = new Set(mat25.filter((f) => f.fila > 1).map((f) => txt(f.celdas.D)).filter((n) => n && !numeros2026.has(n)))
      const colados = mat1.filter((f) => f.fila > 1 && soloDe2025.has(txt(f.celdas.D)))
      if (colados.length) falla(`la hoja de 2026 se ha tragado ${colados.length} partes de 2025 (p.ej. «${txt(colados[0]!.celdas.D)}» en la fila ${colados[0]!.fila})`)
    }
    // M12
    {
      const f = mat1.find((x) => txt(x.celdas.D) === m12.numero)!
      if (typeof f.celdas.C !== 'number') falla(`M12: la fecha de resolución de «${m12.numero}» no llegó: C dice «${String(f.celdas.C)}»`)
    }
    // M13 — las hojas que se rehacen enteras
    {
      const forma = await formaDe(bytes1)
      const esperadas = { Revisiones: 2, 'Movimientos de Almacén': 2, 'Inventario por Sala': 1 + a1.datos.equipos.length }
      for (const [hoja, n] of Object.entries(esperadas)) {
        if (forma[hoja] !== n) falla(`M13: «${hoja}» tiene ${String(forma[hoja])} filas y tenía que tener ${n}`)
      }
      if (!forma['Sincronización']) falla('M13: falta la hoja «Sincronización»')
    }

    // Ninguna sala que ya estaba en el libro puede entrar como «nueva»: si
    // entra, es que su fila no cruzó y ahora está dos veces.
    const nuevasInesperadas = p1.planes
      .find((p) => p.hoja === ESTADO.nombre)!
      .avisos.filter((a) => a.includes('entra en el bloque') || a.includes('abre bloque'))
      .filter((a) => !['9.1', '0.1', m3.code].some((c) => a.includes(`«${c}»`)))
    if (nuevasInesperadas.length) falla(`salas que ya estaban y entran como nuevas: ${nuevasInesperadas.join(' | ')}`)

    // Lo que la pasada avisó de las mudanzas, para leerlo cuando falle.
    const avisosEstado = p1.planes.find((p) => p.hoja === ESTADO.nombre)!.avisos
    const conflictosEstado = p1.planes.find((p) => p.hoja === ESTADO.nombre)!.conflictos
    if (fallos.length) {
      fallos.push(`--- avisos de la hoja de estado (${avisosEstado.length}) ---`, ...avisosEstado.slice(0, 12))
      fallos.push(`--- conflictos (${conflictosEstado.length}) ---`, ...conflictosEstado.slice(0, 6).map((c) => `${c.letra}${c.fila} ${c.campo}: ${c.motivo}`))
    }

    // -------------------------------------------------------------------------
    // Pasada 2 sobre lo que salió: con los mismos datos no queda nada que hacer.
    // -------------------------------------------------------------------------
    const p2 = await pasada(bytes1, datos, instantaneaDe(p1.planes))
    const vaivenes = vaivenesDe(p2.planes)
    if (vaivenes.length) fallos.push(`--- la segunda pasada todavía escribe (${vaivenes.length}) ---`, ...vaivenes.slice(0, 30))

    const a2 = { libro: p2.libro, planes: p2.planes, hojasNuevas: [], datos: datosParaLasHojasNuevas(datos) } as unknown as Analisis
    const bytes2 = await escribirPasada(a2, '2026-09-02 11:00')
    if (SALIDA) writeFileSync(`${SALIDA}-divergencia-2.xlsx`, bytes2)
    // Sin el parte de la pasada: cuenta lo que hizo cada una, y la segunda hace
    // menos cosas a propósito. Las demás hojas sí tienen que medir lo mismo.
    const sinParte = (f: Record<string, number>) => Object.fromEntries(Object.entries(f).filter(([h]) => h !== 'Sincronización'))
    const forma1 = sinParte(await formaDe(bytes1))
    const forma2 = sinParte(await formaDe(bytes2))
    if (JSON.stringify(forma1) !== JSON.stringify(forma2)) {
      fallos.push(`--- la forma cambia entre pasadas ---`, JSON.stringify(forma1), JSON.stringify(forma2))
    }

    expect(fallos).toEqual([])
  }, 300_000)
})
