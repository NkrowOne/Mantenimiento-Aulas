/**
 * Importador del Excel de mantenimiento → seed SQL.
 *
 *   npm run import:excel -- <ruta-al-xlsx> [--out supabase/seed.sql]
 *
 * Convierte las 5 hojas en el esquema append-only. Tres reglas que gobiernan
 * todo el fichero:
 *
 *  1. Nada se corrige en silencio. Cada arreglo (fechas imposibles, erratas de
 *     edificio) queda registrado en `import_fixes` con el valor original.
 *  2. Lo que no se puede interpretar con confianza no se inventa: va a
 *     `import_quarantine` para que una persona lo resuelva.
 *  3. El histórico entra con `by_user = NULL` y `source = 'import'`. El Excel no
 *     dice quién hizo cada cosa, y atribuirlo a alguien falsearía justo la
 *     trazabilidad que la app existe para dar.
 */

import readXlsxFile from 'read-excel-file/node'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import {
  BUILDING_CODES,
  BUILDING_TYPOS,
  canonicalZone,
  capabilitiesFromRow,
  classifyRoom,
  incidentDedupeKey,
  norm,
  parseLooseDate,
  parseMaterialUsed,
  splitIncidentKey,
  stripParenthetical,
  cleanRoomRef,
} from '../src/domain/normalize'
import { canonAlmacen, esFragmentoAlmacen } from '../src/domain/almacen'
import type { RoomCapabilities } from '../src/domain/types'

// -----------------------------------------------------------------------------
// Utilidades
// -----------------------------------------------------------------------------

/** UUID determinista: reimportar el mismo Excel produce exactamente los mismos ids. */
function uuidFor(kind: string, key: string): string {
  const h = createHash('sha1').update(`mantenimiento-aulas:${kind}:${key}`).digest('hex')
  const v = `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
  return v
}

function sql(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value instanceof Date) return `'${value.toISOString()}'`
  return `'${String(value).replace(/'/g, "''")}'`
}

function jsonb(value: unknown): string {
  return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`
}

const cell = (row: unknown[], i: number): unknown => row[i] ?? null
const text = (row: unknown[], i: number): string => String(row[i] ?? '').trim()

// -----------------------------------------------------------------------------
// Acumuladores
// -----------------------------------------------------------------------------

interface Fix {
  source: string
  rowRef: string
  field: string
  original: string
  corrected: string
  reason: string
}
interface Quarantined {
  source: string
  rowRef: string
  raw: unknown
  reason: string
}

/**
 * De qué fila habla una entrada de cuarentena.
 *
 * Lleva el número de fila **siempre**, aunque haya número de incidencia, y no es
 * redundante: el número de incidencia se repite —`I241111_0040` sale dos veces
 * en la hoja de 2025— y las dos filas tienen su propio material que arreglar.
 * Con la ref sola las dos entradas eran la misma y la segunda se perdía, contra
 * el índice de `import_quarantine_abierta_idx`, que existe justo para que el
 * mismo problema no se apunte dos veces. Un problema por celda, y la celda es la
 * fila.
 */
const refDeFila = (ref: string, r: number): string =>
  ref ? `${ref} (fila ${r + 1})` : `fila ${r + 1}`

/**
 * Los números de incidencia que trae una celda.
 *
 * Casi siempre es uno, `I260203_0051`. Pero seis filas del libro traen dos —a
 * veces separados por cuarenta espacios— porque una misma intervención se apuntó
 * como dos incidencias y se contó en un renglón. Y `incidents.external_ref`
 * lleva desde la migración 1400 un `check` de forma, que existe para que «el
 * mayor del día» siga siendo una cuenta: una celda con dos números dentro no
 * pasa por ahí, y con razón.
 *
 * Devuelve los que haya, en orden. Cero si lo que hay no es un número de
 * incidencia, que también pasa.
 */
const numerosDeIncidencia = (celda: string): string[] =>
  celda.toUpperCase().match(/[A-Z]\d{6}_\d{4}/g) ?? []

const statements: string[] = []
const fixes: Fix[] = []
const quarantine: Quarantined[] = []

const buildings = new Map<string, { id: string; code: string; name: string; order: number; needsReview: boolean }>()
const zones = new Map<string, { id: string; buildingId: string; name: string; order: number }>()
const rooms = new Map<string, {
  id: string
  zoneId: string
  code: string
  name: string
  buildingCode: string
  capabilities: RoomCapabilities
  hours: number | null
  lamp: number | null
}>()
/** Índice `CÓDIGO_EDIFICIO|CÓDIGO_SALA` → id de sala, para resolver las incidencias. */
const roomIndex = new Map<string, string>()
const aliases: Array<{ roomId: string; alias: string; aliasNorm: string }> = []

/** Códigos ya asignados, para no violar el `unique` de buildings.code. */
const usedCodes = new Set<string>()

function deriveCode(name: string): string {
  const explicit = BUILDING_CODES[name]
  if (explicit) return explicit

  // Iniciales de las palabras significativas: `SALA VIP` → `SVIP` antes que `SALA`.
  const words = name.split(/\s+/).filter((w) => w.length > 2)
  const base =
    (words.length > 1 ? words.map((w) => w[0]).join('') : name.replace(/[^A-Z0-9]/g, '')).slice(0, 6) ||
    'X'

  let code = base
  let n = 2
  while (usedCodes.has(code)) code = `${base}${n++}`
  return code
}

function ensureBuilding(rawName: string, order: number, needsReview = false): string {
  const fixedName = BUILDING_TYPOS[norm(rawName)] ?? norm(rawName)
  if (fixedName !== norm(rawName)) {
    fixes.push({
      source: 'Estado Aulas',
      rowRef: rawName,
      field: 'EDIFICIO',
      original: rawName,
      corrected: fixedName,
      reason: 'Errata de nombre de edificio',
    })
  }

  const existing = buildings.get(fixedName)
  if (existing) return existing.id

  const code = deriveCode(fixedName)
  usedCodes.add(code)
  const id = uuidFor('building', code)
  buildings.set(fixedName, { id, code, name: fixedName, order, needsReview })
  return id
}

function ensureZone(buildingId: string, buildingName: string, rawZone: string, order: number): string {
  const name = canonicalZone(rawZone)
  const key = `${buildingName}|${name}`
  const existing = zones.get(key)
  if (existing) return existing.id

  if (norm(rawZone) !== name && rawZone) {
    fixes.push({
      source: 'Estado Aulas',
      rowRef: `${buildingName} / ${rawZone}`,
      field: 'PLANTA/MÓDULO',
      original: rawZone,
      corrected: name,
      reason: 'Nombre de zona unificado',
    })
  }

  const id = uuidFor('zone', key)
  zones.set(key, { id, buildingId, name, order })
  return id
}

// -----------------------------------------------------------------------------
// Hoja 1 — Estado de aulas
// -----------------------------------------------------------------------------

const COL = {
  edificio: 0,
  planta: 1,
  aula: 2,
  fechaRevision: 3,
  horas: 5,
  lamparas: 6,
  altavoces: 7,
  camara: 8,
  microfono: 9,
  botonera: 10,
  modeloProyector: 11,
  snProyector: 12,
  modeloCamara: 13,
  snCamara: 14,
  modeloTv: 15,
  snTv: 16,
  snMonitor: 17,
  snOrdenador: 18,
  modeloOrdenador: 19,
} as const

interface AssetSeed {
  id: string
  typeName: string
  roomId: string
  serial: string | null
  model: string | null
}
const assets: AssetSeed[] = []
const inspectionsFromExcel: Array<{ id: string; roomId: string; at: Date }> = []

function importRooms(rows: unknown[][]): void {
  let currentBuilding = ''
  let currentBuildingRaw = ''
  let currentBuildingId = ''
  let currentZone = ''
  let currentZoneRaw = ''
  let currentZoneId = ''
  let buildingOrder = 0
  let zoneOrder = 0

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row) continue

    const edificio = text(row, COL.edificio)
    const planta = text(row, COL.planta)
    const aula = text(row, COL.aula)

    // Las celdas de edificio y planta vienen combinadas: se arrastra la última.
    if (edificio) {
      const fixedName = BUILDING_TYPOS[norm(edificio)] ?? norm(edificio)
      if (fixedName !== currentBuilding) {
        currentBuilding = fixedName
        currentBuildingRaw = edificio
        currentBuildingId = ''
        currentZone = ''
        currentZoneRaw = ''
        currentZoneId = ''
      }
    }
    if (planta) {
      const zoneName = canonicalZone(planta)
      if (zoneName !== currentZone) {
        currentZone = zoneName
        currentZoneRaw = planta
        currentZoneId = ''
      }
    }

    if (!aula || !currentBuilding) continue

    // Edificio y zona se materializan al encontrar la primera sala. Al final de
    // la hoja hay filas sueltas con nombre en la columna EDIFICIO y sin aulas
    // ("SALA VIP", "DESPACHO CAJERO RECTOR"): crearlas como edificios vacíos
    // ensuciaba el maestro y provocaba colisiones de código.
    if (!currentBuildingId) currentBuildingId = ensureBuilding(currentBuildingRaw, ++buildingOrder)
    if (!currentZoneId) {
      currentZoneId = ensureZone(currentBuildingId, currentBuilding, currentZoneRaw, ++zoneOrder)
    }

    const buildingCode = buildings.get(currentBuilding)?.code ?? '??'
    const roomKey = `${buildingCode}|${norm(aula)}`

    if (roomIndex.has(roomKey)) {
      quarantine.push({
        source: 'Estado Aulas',
        rowRef: `fila ${r + 1}`,
        raw: { edificio: currentBuilding, zona: currentZone, aula },
        reason: 'Sala duplicada dentro del mismo edificio',
      })
      continue
    }

    const roomId = uuidFor('room', roomKey)
    const capabilities = capabilitiesFromRow({
      altavoces: cell(row, COL.altavoces),
      camara: cell(row, COL.camara),
      microfono: cell(row, COL.microfono),
      botonera: cell(row, COL.botonera),
      modeloProyector: cell(row, COL.modeloProyector),
      modeloTv: cell(row, COL.modeloTv),
      modeloCamara: cell(row, COL.modeloCamara),
    })

    const horasRaw = cell(row, COL.horas)
    const hours = typeof horasRaw === 'number' ? Math.round(horasRaw) : null
    const lampRaw = cell(row, COL.lamparas)
    const lamp = typeof lampRaw === 'number' && lampRaw >= 0 && lampRaw <= 1 ? lampRaw : null

    rooms.set(roomKey, {
      id: roomId,
      zoneId: currentZoneId,
      code: aula,
      name: aula,
      buildingCode,
      capabilities,
      hours,
      lamp,
    })
    roomIndex.set(roomKey, roomId)

    // Cómo aparece esta sala en las incidencias: `1.7 H`.
    //
    // En el EDIFICIO P las salas se llaman `0.1P`, con la letra del edificio
    // pegada al código, mientras que las incidencias escriben `0.1 P`. Sin
    // registrar también la variante sin sufijo, 23 incidencias de ese edificio
    // se quedaban sin sala.
    const codeNorm = norm(aula)
    const stripped = codeNorm.endsWith(buildingCode)
      ? codeNorm.slice(0, -buildingCode.length).trim()
      : ''

    const addAlias = (value: string): void => {
      const aliasNorm = norm(value)
      if (!aliasNorm || aliases.some((a) => a.aliasNorm === aliasNorm)) return
      aliases.push({ roomId, alias: value, aliasNorm })
    }
    addAlias(`${aula} ${buildingCode}`)
    if (stripped) {
      addAlias(`${stripped} ${buildingCode}`)
      roomIndex.set(`${buildingCode}|${stripped}`, roomId)
    }

    // `5.4 (Lab 3D)` en la hoja de estado es `5.4 C` en las incidencias:
    // el nombre descriptivo va entre paréntesis y allí no se escribe.
    const bare = norm(stripParenthetical(aula))
    if (bare && bare !== codeNorm) {
      addAlias(`${bare} ${buildingCode}`)
      roomIndex.set(`${buildingCode}|${bare}`, roomId)
    }

    // Equipo instalado con número de serie: pasa a ser inventario real.
    const addAsset = (typeName: string, model: unknown, serial: unknown): void => {
      const s = String(serial ?? '').trim()
      const m = String(model ?? '').trim()
      if (!s || norm(s) === 'N/D' || norm(s) === 'NO TIENE') return
      assets.push({
        id: uuidFor('asset', `${typeName}|${s}`),
        typeName,
        roomId,
        serial: s,
        model: m || null,
      })
    }
    addAsset('Proyector', cell(row, COL.modeloProyector), cell(row, COL.snProyector))
    addAsset('Cámara', cell(row, COL.modeloCamara), cell(row, COL.snCamara))
    addAsset('TV', cell(row, COL.modeloTv), cell(row, COL.snTv))
    addAsset('Monitor', null, cell(row, COL.snMonitor))
    addAsset('Ordenador', cell(row, COL.modeloOrdenador), cell(row, COL.snOrdenador))

    // La fecha de revisión del Excel se conserva como revisión histórica, sin
    // checks: sabemos que se revisó y cuándo, no qué se comprobó.
    const { date, fixed } = parseLooseDate(cell(row, COL.fechaRevision))
    if (date) {
      if (fixed) {
        fixes.push({
          source: 'Estado Aulas',
          rowRef: `${buildingCode} ${aula}`,
          field: 'Fecha Revisión',
          original: String(cell(row, COL.fechaRevision)),
          corrected: date.toISOString().slice(0, 10),
          reason: fixed,
        })
      }
      inspectionsFromExcel.push({
        id: uuidFor('inspection', `${roomKey}|${date.toISOString()}`),
        roomId,
        at: date,
      })
    }
  }
}

// -----------------------------------------------------------------------------
// Hojas 2 y 4 — Incidencias históricas
// -----------------------------------------------------------------------------

interface IncidentSeed {
  id: string
  roomId: string | null
  ref: string | null
  title: string
  description: string | null
  openedAt: Date
  resolvedAt: Date | null
  resolution: string | null
}
const incidents: IncidentSeed[] = []
const incidentMaterials: Array<{ id: string; incidentId: string; itemName: string; qty: number; serial: string | null; raw: string | null }> = []
const seenIncidents = new Set<string>()

/** Códigos que salen en las incidencias y no existen en la hoja de estado. */
const orphanBuildingCodes = new Map<string, number>()

function resolveRoom(rawAula: string): string | null {
  const n = cleanRoomRef(rawAula)
  if (!n) return null

  const direct = aliases.find((a) => a.aliasNorm === n)
  if (direct) return direct.roomId

  const split = splitIncidentKey(rawAula)
  if (!split) return null

  const key = `${split.buildingCode}|${split.roomCode}`
  const hit = roomIndex.get(key)
  if (hit) return hit

  // `buildings` está indexado por nombre, no por código: comprobarlo con
  // `buildings.has(code)` marcaba como desconocidos a edificios reales (P, O, H…)
  // y ensuciaba el informe con 15 edificios provisionales falsos.
  if (!knownBuildingCodes().has(split.buildingCode)) {
    orphanBuildingCodes.set(split.buildingCode, (orphanBuildingCodes.get(split.buildingCode) ?? 0) + 1)
  }
  return null
}

let buildingCodeCache: Set<string> | null = null
function knownBuildingCodes(): Set<string> {
  if (!buildingCodeCache) {
    buildingCodeCache = new Set([...buildings.values()].map((b) => b.code))
  }
  return buildingCodeCache
}

function importIncidents(rows: unknown[][], sheet: string, hasObservacion: boolean): void {
  const cAula = 0
  const cFecha = 1
  const cResuelta = 2
  const cRef = 3
  const cProblema = 4
  const cResolucion = hasObservacion ? 6 : 5
  const cMaterial = hasObservacion ? 7 : 6

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row || row.every((c) => c === null || c === '')) continue

    const aula = text(row, cAula)
    const problema = text(row, cProblema)
    const crudo = text(row, cRef)
    const numeros = numerosDeIncidencia(crudo)
    const ref = numeros[0] ?? ''
    if (!aula && !problema) continue

    // Seis filas del libro traen DOS números en la misma celda —«I250324_0002
    // S250324_0004»—: son una intervención que el técnico apuntó como dos
    // incidencias y contó en un renglón. Se queda el primero, que es el de esta
    // fila, y el segundo se apunta para que alguien pueda separarlas: perder el
    // número entero dejaría la fila sin poder cruzarse nunca con el Excel.
    if (numeros.length > 1) {
      fixes.push({
        source: sheet, rowRef: refDeFila(ref, r), field: 'N.º Incidencia',
        original: crudo, corrected: ref,
        reason: 'La celda traía más de un número: se queda el primero',
      })
      quarantine.push({
        source: sheet,
        rowRef: refDeFila(ref, r),
        raw: { crudo, numeros },
        reason: 'La fila cuenta más de una incidencia en un solo renglón',
      })
    } else if (crudo !== '' && numeros.length === 0) {
      quarantine.push({
        source: sheet,
        rowRef: `fila ${r + 1}`,
        raw: { crudo },
        reason: 'El número de incidencia no tiene la forma <letra><AAMMDD>_<NNNN>',
      })
    }

    const opened = parseLooseDate(cell(row, cFecha))
    if (!opened.date) {
      quarantine.push({
        source: sheet,
        rowRef: `fila ${r + 1}`,
        raw: { aula, ref, problema, fecha: String(cell(row, cFecha)) },
        reason: 'Fecha de apertura ilegible',
      })
      continue
    }
    if (opened.fixed) {
      fixes.push({
        source: sheet, rowRef: ref || `fila ${r + 1}`, field: 'Fecha',
        original: String(cell(row, cFecha)), corrected: opened.date.toISOString().slice(0, 10),
        reason: opened.fixed,
      })
    }

    const dedupe = incidentDedupeKey({
      ref, room: aula, date: opened.date.toISOString().slice(0, 10), problem: problema,
    })
    if (seenIncidents.has(dedupe)) {
      fixes.push({
        source: sheet, rowRef: ref || `fila ${r + 1}`, field: '(fila completa)',
        original: 'duplicada', corrected: 'descartada',
        reason: 'Fila idéntica repetida en el Excel',
      })
      continue
    }
    seenIncidents.add(dedupe)

    let resolved = parseLooseDate(cell(row, cResuelta))
    if (resolved.fixed) {
      fixes.push({
        source: sheet, rowRef: ref || `fila ${r + 1}`, field: 'Fecha resuelta',
        original: String(cell(row, cResuelta)), corrected: resolved.date?.toISOString().slice(0, 10) ?? '',
        reason: resolved.fixed,
      })
    }
    // Resuelta antes de abrirse: casi siempre un año mal tecleado.
    if (resolved.date && resolved.date < opened.date) {
      const bumped = new Date(resolved.date)
      bumped.setFullYear(opened.date.getFullYear())
      const corrected = bumped >= opened.date ? bumped : opened.date
      fixes.push({
        source: sheet, rowRef: ref || `fila ${r + 1}`, field: 'Fecha resuelta',
        original: resolved.date.toISOString().slice(0, 10),
        corrected: corrected.toISOString().slice(0, 10),
        reason: 'La resolución era anterior a la apertura',
      })
      resolved = { date: corrected, fixed: null }
    }
    /*
     * Y la fecha que `parseLooseDate` se negó a adivinar (un «27-03-296» que
     * admite más de una lectura, o un año del futuro). Antes esto acababa en
     * una fecha inventada —dos incidencias del CRAI se pasaron meses fechadas
     * en 2296 encabezando el Historial—; ahora, si la fila trae resolución
     * escrita se cierra con la fecha de la apertura, y si no la trae se queda
     * abierta. En ambos casos, con su rastro.
     */
    if (!resolved.date && String(cell(row, cResuelta) ?? '').trim()) {
      const hayResolucion = Boolean(text(row, cResolucion))
      fixes.push({
        source: sheet, rowRef: ref || `fila ${r + 1}`, field: 'Fecha resuelta',
        original: String(cell(row, cResuelta)),
        corrected: hayResolucion ? opened.date.toISOString().slice(0, 10) : '',
        reason: hayResolucion
          ? 'Fecha de resolución ilegible → la de la apertura'
          : 'Fecha de resolución ilegible: la incidencia queda abierta',
      })
      if (hayResolucion) resolved = { date: opened.date, fixed: null }
    }

    const roomId = resolveRoom(aula)
    if (!roomId && aula) {
      quarantine.push({
        source: sheet, rowRef: refDeFila(ref, r),
        raw: { aula, ref, problema },
        reason: 'No se pudo identificar la sala',
      })
    }

    // El id sale de la clave de deduplicación completa, no del nº de incidencia:
    // el histórico repite refs (`I250219_0016  I250220_0044` en una sola celda,
    // y refs reutilizadas en filas distintas), y usar solo la ref hacía que la
    // segunda fila se descartara en silencio por colisión de clave.
    const id = uuidFor('incident', dedupe)
    incidents.push({
      id,
      roomId,
      ref: ref || null,
      title: problema.slice(0, 160) || 'Incidencia sin descripción',
      description: problema || null,
      openedAt: opened.date,
      resolvedAt: resolved.date,
      resolution: text(row, cResolucion) || null,
    })

    const materialRaw = text(row, cMaterial)
    if (materialRaw) {
      const { items, leftover } = parseMaterialUsed(materialRaw)
      for (const it of items) {
        incidentMaterials.push({
          id: uuidFor('incmat', `${id}|${it.item}|${it.qty}|${it.serial ?? ''}`),
          incidentId: id,
          itemName: it.item,
          qty: it.qty,
          serial: it.serial,
          raw: null,
        })
      }
      if (leftover) {
        // Se guarda el texto tal cual junto a la incidencia y se marca para revisión.
        incidentMaterials.push({
          id: uuidFor('incmat', `${id}|raw`),
          incidentId: id, itemName: '', qty: 0, serial: null, raw: leftover,
        })
        quarantine.push({
          source: sheet, rowRef: refDeFila(ref, r),
          raw: { material: materialRaw },
          reason: 'Material usado no interpretable automáticamente',
        })
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Hoja 3 — Bolsa (stock)
// -----------------------------------------------------------------------------

const stockItems = new Map<string, { id: string; name: string; onHand: number; active: boolean }>()

/**
 * Da de alta un artículo con su nombre canónico.
 *
 * La clave es el nombre canónico normalizado, así que las seis grafías de un
 * mismo cable entran una sola vez y con el saldo sumado. Sin esto la lista de
 * almacén nacía con «Cable Hdmi 10mts Fibra», «cable hdmi Fibra 10mts» y
 * «Cables Hdmi 10mts» como tres artículos distintos, y el informe de consumo
 * repartía el gasto del cable entre las tres.
 */
function addStockItem(original: string, onHand: number, source: string): string {
  const name = canonAlmacen(original)
  const activo = !esFragmentoAlmacen(original)

  if (name !== original) {
    fixes.push({
      source, rowRef: original, field: 'Artículo de almacén',
      original, corrected: name,
      reason: 'Nomenclatura unificada del almacén',
    })
  }
  if (!activo) {
    fixes.push({
      source, rowRef: original, field: 'Artículo de almacén',
      original, corrected: '(archivado)',
      reason: 'No identifica un artículo: se archiva, pero sigue enlazado a las incidencias que lo citan',
    })
  }

  const key = norm(name)
  const id = uuidFor('stockitem', key)
  const ya = stockItems.get(key)
  if (ya) {
    ya.onHand += onHand
    ya.active = ya.active || activo
  } else {
    stockItems.set(key, { id, name, onHand, active: activo })
  }
  return id
}

function importStock(rows: unknown[][]): void {
  const cName = 0
  const cStock = 14

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row) continue
    const name = text(row, cName)
    if (!name) continue

    const raw = cell(row, cStock)
    let onHand = typeof raw === 'number' ? Math.round(raw) : 0

    if (onHand < 0) {
      fixes.push({
        source: 'Bolsa 2026', rowRef: name, field: 'Stock Disponible',
        original: String(onHand), corrected: '0',
        reason: 'Stock negativo: se importa a 0 y queda pendiente de recuento físico',
      })
      onHand = 0
    }

    addStockItem(name, onHand, 'Bolsa 2026')
  }
}

// -----------------------------------------------------------------------------
// Generación del SQL
// -----------------------------------------------------------------------------

function emit(): void {
  const out: string[] = []
  out.push('-- Generado por scripts/import-excel.ts — no editar a mano.')
  out.push('-- Reimportar el mismo Excel produce exactamente los mismos identificadores.')
  out.push('begin;')
  out.push('')

  out.push('-- Edificios')
  for (const b of buildings.values()) {
    out.push(
      `insert into buildings (id, code, name, sort_order, needs_review) values (${sql(b.id)}, ${sql(b.code)}, ${sql(b.name)}, ${b.order}, ${sql(b.needsReview)}) on conflict (id) do nothing;`,
    )
  }

  // Los códigos huérfanos entran como edificio provisional en vez de perder
  // las incidencias que los mencionan. Un humano decide después qué son.
  out.push('')
  out.push('-- Edificios provisionales: aparecen en las incidencias pero no en la hoja de estado')
  for (const [code, count] of orphanBuildingCodes) {
    const id = uuidFor('building', code)
    out.push(
      `insert into buildings (id, code, name, sort_order, needs_review, review_note) values (${sql(id)}, ${sql(code)}, ${sql(`Edificio ${code} (sin identificar)`)}, 999, true, ${sql(`Aparece en ${count} incidencias del histórico pero no en la hoja de estado. Fusionar con el edificio correcto o confirmar como propio.`)}) on conflict (id) do nothing;`,
    )
  }

  out.push('')
  out.push('-- Zonas')
  for (const z of zones.values()) {
    out.push(
      `insert into zones (id, building_id, name, sort_order) values (${sql(z.id)}, ${sql(z.buildingId)}, ${sql(z.name)}, ${z.order}) on conflict (id) do nothing;`,
    )
  }

  out.push('')
  out.push('-- Salas')
  for (const r of rooms.values()) {
    out.push(
      `insert into rooms (id, zone_id, code, name, kind, capabilities, projector_hours, lamp_pct) values (${sql(r.id)}, ${sql(r.zoneId)}, ${sql(r.code)}, ${sql(r.name)}, ${sql(classifyRoom(r.name))}, ${jsonb(r.capabilities)}, ${sql(r.hours)}, ${sql(r.lamp)}) on conflict (id) do nothing;`,
    )
  }

  out.push('')
  out.push('-- Alias de sala: la forma en que cada sala aparece en las incidencias')
  for (const a of aliases) {
    out.push(
      `insert into room_aliases (id, room_id, alias, alias_norm) values (${sql(uuidFor('alias', a.aliasNorm))}, ${sql(a.roomId)}, ${sql(a.alias)}, ${sql(a.aliasNorm)}) on conflict (alias_norm) do nothing;`,
    )
  }

  out.push('')
  out.push('-- Tipos de equipo')
  // El catálogo base ya viene de la migración de inventario, con sus alias. Aquí
  // solo se da de alta lo que no resuelve a nada, y se marca confirmado porque
  // viene del Excel oficial.
  //
  // `TV` y `Monitor` resolvían a `Pantalla` hasta que
  // `20260830000100_lo_que_el_excel_distingue.sql` los volvió a separar: la hoja
  // lleva `S/N TV` y `S/N Monitor` en dos columnas y con un solo tipo no había
  // forma de escribirlas de vuelta. Desde entonces `asset_type_id('TV')` da el
  // tipo `TV`, no `Pantalla`, y una base cargada de nuevo ya nace separada. La
  // que se cargó antes conserva sus equipos como `Pantalla`, y de reconocerlos
  // por su número de serie se encarga `sync_aplicar_equipo`.
  const typeNames = [...new Set(assets.map((a) => a.typeName))]
  for (const t of typeNames) {
    out.push(
      `insert into asset_types (name, tracks_lamp_hours, confirmed) ` +
        `select ${sql(t)}, ${sql(t === 'Proyector')}, true ` +
        `where public.asset_type_id(${sql(t)}) is null;`,
    )
  }

  out.push('')
  out.push('-- Equipo instalado (solo lo que tiene número de serie)')
  // El tipo se resuelve por nombre en el momento del insert, nunca por un id
  // calculado aquí: si el tipo ya existía con otro id —el caso normal ahora que
  // hay catálogo base— un id calculado apuntaría a una fila que no existe.
  const seenSerials = new Set<string>()
  for (const a of assets) {
    if (seenSerials.has(a.serial ?? '')) continue
    seenSerials.add(a.serial ?? '')
    out.push(
      `insert into assets (id, asset_type_id, room_id, serial, model) values (${sql(a.id)}, public.asset_type_id(${sql(a.typeName)}), ${sql(a.roomId)}, ${sql(a.serial)}, ${sql(a.model)}) on conflict (id) do nothing;`,
    )
  }

  out.push('')
  // El material del histórico se resuelve aquí, antes de emitir nada: las seis
  // grafías del mismo cable ("Cable Hdmi 10mts Fibra", "cable hdmi Fibra
  // 10mts", "Cables Hdmi 10mts") acaban en un único artículo, y el que ya
  // existe en la Bolsa lo absorbe en vez de duplicarse a su lado. Lo que no
  // llega a ser un artículo —"mts", "pulgadas", una frase cortada— entra
  // archivado: sigue enlazado a su incidencia pero no ensucia el almacén.
  const materialItemId = new Map<string, string>()
  for (const m of incidentMaterials) {
    if (!m.itemName) continue
    const key = norm(m.itemName)
    if (!materialItemId.has(key)) {
      materialItemId.set(key, addStockItem(m.itemName, 0, 'Material Usado'))
    }
  }

  // Cuánto se llevó el histórico de cada artículo. Es el saldo de apertura: sin
  // él, meter los consumos descontaría dos veces —la cifra de la Bolsa ya viene
  // con el histórico restado— y medio almacén quedaría en negativo.
  //
  // Lo que quedó apuntado contra un artículo archivado no cuenta. «50 pulgadas»
  // o «20 mts Fibra» son un monitor y un cable, pero el número que traen es de
  // pulgadas y de metros, no de unidades: convertirlo en un consumo de 50
  // unidades de «pulgadas» no es un dato incompleto, es falso —y se colocaba en
  // cabeza del informe de material más consumido—. La línea se queda en
  // `incident_materials` con su texto original y no toca el almacén.
  const activo = new Map([...stockItems.values()].map((s) => [s.id, s.active]))
  const consumidoPorItem = new Map<string, number>()
  for (const m of incidentMaterials) {
    if (!m.itemName || m.qty <= 0) continue
    const id = materialItemId.get(norm(m.itemName))
    if (!id) continue
    if (!activo.get(id)) {
      fixes.push({
        source: 'Material Usado', rowRef: `${m.qty} ${m.itemName}`, field: 'Material Usado',
        original: `${m.qty} ${m.itemName}`, corrected: '(sin movimiento de almacén)',
        reason: 'Cantidad sin artículo identificable: queda en la incidencia pero no descuenta stock',
      })
      continue
    }
    consumidoPorItem.set(id, (consumidoPorItem.get(id) ?? 0) + m.qty)
  }

  // Un día antes de la primera incidencia: el almacén empieza lleno y se va
  // gastando, que es lo que de verdad pasó.
  const primeraIncidencia = incidents
    .map((i) => i.openedAt)
    .filter((d): d is Date => d instanceof Date)
    .reduce<Date | null>((min, d) => (min === null || d < min ? d : min), null)
  const apertura = new Date((primeraIncidencia ?? new Date('2025-01-01T00:00:00Z')).getTime() - 86_400_000)

  out.push('-- Artículos de almacén, saldo de apertura y saldo inicial')
  for (const s of stockItems.values()) {
    out.push(
      `insert into stock_items (id, name, active) values (${sql(s.id)}, ${sql(s.name)}, ${sql(s.active)}) on conflict (id) do nothing;`,
    )
    const apertura_qty = consumidoPorItem.get(s.id) ?? 0
    if (apertura_qty !== 0) {
      out.push(
        `insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, source, note) values (${sql(uuidFor('stockmov', `apertura|${s.id}`))}, ${sql(s.id)}, ${apertura_qty}, 'ajuste', ${sql(apertura)}, 'import', 'Saldo de apertura: las unidades que el histórico de incidencias consumió después') on conflict (id) do nothing;`,
      )
    }
    if (s.onHand !== 0) {
      out.push(
        `insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, source, note) values (${sql(uuidFor('stockmov', `inicial|${s.id}`))}, ${sql(s.id)}, ${s.onHand}, 'ajuste', '2026-01-01T00:00:00Z', 'import', 'Saldo inicial importado de Bolsa 2026') on conflict (id) do nothing;`,
      )
    }
  }

  out.push('')
  out.push('-- Revisiones históricas (sin checks: el Excel solo guarda la fecha)')
  for (const i of inspectionsFromExcel) {
    out.push(
      `insert into inspections (id, room_id, by_user, occurred_at, status, overall, source) values (${sql(i.id)}, ${sql(i.roomId)}, NULL, ${sql(i.at)}, 'completa', 'ok', 'import') on conflict (id) do nothing;`,
    )
  }

  out.push('')
  out.push('-- Incidencias históricas — by_user NULL a propósito: el Excel no dice quién')
  for (const inc of incidents) {
    const state = inc.resolvedAt ? 'resuelta' : 'abierta'
    out.push(
      `insert into incidents (id, room_id, external_ref, title, description, severity, state, opened_at, opened_by, resolved_at, resolution, source) values (${sql(inc.id)}, ${sql(inc.roomId)}, ${sql(inc.ref)}, ${sql(inc.title)}, ${sql(inc.description)}, 'media', ${sql(state)}, ${sql(inc.openedAt)}, NULL, ${sql(inc.resolvedAt)}, ${sql(inc.resolution)}, 'import') on conflict (id) do nothing;`,
    )
  }

  out.push('')
  out.push('-- Material consumido por incidencia')
  //
  // Cada línea entra dos veces y las dos hacen falta: como `incident_materials`,
  // que conserva el texto original y el número de serie, y como movimiento de
  // almacén, que es lo que alimenta el saldo y los informes de consumo. Sin lo
  // segundo el histórico existía pero el almacén no se enteraba: no había ni un
  // solo movimiento de tipo `consumo` en toda la base, y el top de material del
  // informe diario salía en blanco.
  const salaDeIncidencia = new Map(incidents.map((i) => [i.id, i.roomId]))
  const fechaDeIncidencia = new Map(incidents.map((i) => [i.id, i.openedAt]))
  for (const m of incidentMaterials) {
    const itemId = m.itemName ? materialItemId.get(norm(m.itemName)) ?? null : null
    out.push(
      `insert into incident_materials (id, incident_id, stock_item_id, qty, serial, raw_text) values (${sql(m.id)}, ${sql(m.incidentId)}, ${sql(itemId)}, ${m.qty}, ${sql(m.serial)}, ${sql(m.raw)}) on conflict (id) do nothing;`,
    )
    if (!itemId || m.qty <= 0 || !activo.get(itemId)) continue
    // La fecha es la de apertura y no la de resolución: el material se coge
    // cuando se va a arreglar, y es la única de las dos que está siempre puesta.
    const cuando = fechaDeIncidencia.get(m.incidentId) ?? null
    out.push(
      `insert into stock_movements (id, stock_item_id, qty, kind, incident_id, room_id, occurred_at, source, note) values (${sql(uuidFor('stockmov', `consumo|${m.id}`))}, ${sql(itemId)}, ${-m.qty}, 'consumo', ${sql(m.incidentId)}, ${sql(salaDeIncidencia.get(m.incidentId) ?? null)}, ${sql(cuando)}, 'import', ${sql(m.serial ? `N/S ${m.serial}` : null)}) on conflict (id) do nothing;`,
    )
  }

  out.push('')
  out.push('-- Correcciones aplicadas: cada una con su valor original')
  for (const f of fixes) {
    out.push(
      `insert into import_fixes (source, row_ref, field, original, corrected, reason) values (${sql(f.source)}, ${sql(f.rowRef)}, ${sql(f.field)}, ${sql(f.original)}, ${sql(f.corrected)}, ${sql(f.reason)});`,
    )
  }

  // Por la función y no con un `insert`: `import_quarantine` tiene desde la
  // migración 600 una entrada por problema, y meterlas a pelo choca contra el
  // índice en cuanto dos filas comparten motivo. La función es la que sabe qué
  // hacer entonces —sumar una vez, no duplicar—, y es la misma que usa la
  // sincronización, así que el seed no puede quedarse con otra idea.
  out.push('')
  out.push('-- Cuarentena: lo que NO se interpretó, para resolver a mano')
  for (const q of quarantine) {
    out.push(
      `select public.cuarentena_apuntar(${sql(q.source)}, ${sql(q.rowRef)}, ${jsonb(q.raw)}, ${sql(q.reason)});`,
    )
  }

  // El puente entre el almacén y el catálogo de equipos. Va aquí y no en la
  // migración porque en una instalación limpia las migraciones corren antes que
  // esto: allí `stock_items` está todavía vacía. La función es idempotente y
  // vive en un solo sitio —la migración—, así que el mapa no se duplica.
  out.push('')
  out.push('-- Qué artículo del almacén es cada tipo de equipo')
  out.push('select public.enlazar_almacen_con_catalogo();')

  out.push('')
  out.push('commit;')
  statements.push(...out)
}

// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const file = process.argv[2]
  if (!file) {
    console.error('Uso: npm run import:excel -- <ruta-al-xlsx> [--out supabase/seed.sql]')
    process.exit(1)
  }
  const outIdx = process.argv.indexOf('--out')
  const outPath = outIdx > -1 ? process.argv[outIdx + 1]! : 'supabase/seed.sql'

  const estado = await readXlsxFile(file, { sheet: 'Estado Aulas y Salas de reunion' })
  importRooms(estado as unknown[][])

  const stock = await readXlsxFile(file, { sheet: 'Bolsa 2026' })
  importStock(stock as unknown[][])

  const inc2026 = await readXlsxFile(file, { sheet: 'Material Instalado 2026' })
  importIncidents(inc2026 as unknown[][], 'Material Instalado 2026', false)

  const inc2025 = await readXlsxFile(file, { sheet: 'Material Instalado 2025' })
  importIncidents(inc2025 as unknown[][], 'Material Instalado 2025', true)

  emit()
  writeFileSync(outPath, statements.join('\n') + '\n', 'utf8')

  const unresolved = quarantine.filter((q) => q.reason === 'No se pudo identificar la sala').length
  console.log(`
Importación completada → ${outPath}

  Edificios .................. ${buildings.size}${orphanBuildingCodes.size ? ` (+${orphanBuildingCodes.size} provisionales)` : ''}
  Zonas ...................... ${zones.size}
  Salas ...................... ${rooms.size}
  Equipos con nº de serie .... ${new Set(assets.map((a) => a.serial)).size}
  Artículos de almacén ....... ${stockItems.size}
  Revisiones históricas ...... ${inspectionsFromExcel.length}
  Incidencias ................ ${incidents.length}
  Materiales parseados ....... ${incidentMaterials.filter((m) => m.itemName).length}

  Correcciones registradas ... ${fixes.length}
  En cuarentena .............. ${quarantine.length}${unresolved ? ` (${unresolved} sin sala identificada)` : ''}
${orphanBuildingCodes.size ? `\n  Códigos sin identificar: ${[...orphanBuildingCodes.entries()].map(([c, n]) => `${c} (${n})`).join(', ')}` : ''}
`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
