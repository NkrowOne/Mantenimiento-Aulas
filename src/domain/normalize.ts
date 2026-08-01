/**
 * Normalización y resolución de claves de sala.
 *
 * El problema que resuelve: la hoja de estado identifica una sala como
 * `EDIFICIO H / 1ª PLANTA / 1.7` y el histórico de incidencias como `1.7 H`.
 * Sin esto, los dos sistemas no se pueden cruzar — que es exactamente lo que
 * pasa hoy en el Excel.
 */

import type { RoomCapabilities, RoomKind } from './types'
import { EMPTY_CAPABILITIES } from './types'

/** Mayúsculas, sin tildes, comas decimales a puntos, espacios colapsados. */
export function norm(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/,/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Códigos de edificio tal y como aparecen como sufijo en las incidencias.
 * Se declaran a mano porque no son derivables del nombre: `EDIFICIO CENTRAL`
 * es `C`, y `CENTRO DEPORTIVO` es `CD`.
 */
export const BUILDING_CODES: Record<string, string> = {
  'EDIFICIO P': 'P',
  'EDIFICIO O': 'O',
  'EDIFICIO M': 'M',
  'EDIFICIO E': 'E',
  'EDIFICIO CENTRAL': 'C',
  'EDIFICIO H': 'H',
  'EDIFICIO EPS': 'EPS',
  'EDIFICIO CRAI': 'CRAI',
  'CENTRO DEPORTIVO': 'CD',
  'SIMULACION QUIRURGICA': 'CSQ',
  'SIMULACION CLINICA AV.': 'CSC',
  COMUNICACION: 'COM',
  PROYECTA: 'PRY',
  'BELLAS ARTES': 'BBAA',
  MSI: 'MSI',
  DOT: 'DOT',
  'COLEGIO MAYOR': 'CM',
}

/**
 * Erratas del Excel que apuntan a un edificio que ya existe. Se corrigen al
 * importar y cada corrección queda registrada en `import_fixes`.
 */
export const BUILDING_TYPOS: Record<string, string> = {
  'EDIFICO E': 'EDIFICIO E',
}

/** Erratas de nombre de zona. `MODULO 3` y `MÓDULO 3` son la misma planta. */
export function canonicalZone(raw: string): string {
  const n = norm(raw)
  if (!n) return 'SIN ZONA'
  return n
    .replace(/^MODULO/, 'MÓDULO')
    .replace(/^PLANTA BAJA$/, 'PLANTA BAJA')
    .replace(/^2º PLANTA$/, '2ª PLANTA')
}

/** Códigos que aparecen en las incidencias pero no en la hoja de estado. */
export const UNKNOWN_BUILDING_CODES = ['BC', 'CEFF'] as const

export function classifyRoom(name: string): RoomKind {
  const n = norm(name)
  if (/LABORATORIO|^LAB\b|LAB /.test(n)) return 'laboratorio'
  if (/SALA DE REUNION|SALA REUNION|SALA DE JUNTAS|SALA PROFESORES|VICERRECTORADO/.test(n)) {
    return 'sala_reunion'
  }
  if (/^\d|^-\d|^AULA|^AGORA|^POLIVALENTE|^PROYECTA/.test(n)) return 'aula'
  return 'otro'
}

/** `SÍ`, `SI`, `si`, `X` → true. Vacío → false (no consta equipamiento). */
export function truthy(value: unknown): boolean {
  const n = norm(value)
  return n === 'SI' || n === 'X' || n === 'TRUE' || n === 'OK'
}

/**
 * Deduce qué tiene instalado una sala a partir de la fila de la hoja de estado.
 * Esto es lo que hace que el formulario de revisión llegue medio relleno: si la
 * sala no tiene micrófono, ese check nace en "No aplica".
 */
export function capabilitiesFromRow(row: {
  altavoces?: unknown
  camara?: unknown
  microfono?: unknown
  botonera?: unknown
  modeloProyector?: unknown
  modeloTv?: unknown
  modeloCamara?: unknown
}): RoomCapabilities {
  const botoneraRaw = norm(row.botonera)
  const proyectorRaw = norm(row.modeloProyector)

  return {
    ...EMPTY_CAPABILITIES,
    altavoces: truthy(row.altavoces),
    microfono: truthy(row.microfono),
    // La cámara consta o por la casilla o porque hay modelo de cámara anotado.
    camara: truthy(row.camara) || (norm(row.modeloCamara) !== '' && norm(row.modeloCamara) !== 'NO TIENE'),
    // La columna Botonera no es un sí/no: dice "Actualizada", "Actaulizada" o
    // "No tiene". Cualquier cosa que no sea vacío ni "No tiene" significa que existe.
    botonera: botoneraRaw !== '' && botoneraRaw !== 'NO TIENE',
    proyector: proyectorRaw !== '' && proyectorRaw !== 'NO TIENE' && proyectorRaw !== 'N/D',
    tv: norm(row.modeloTv) !== '' && norm(row.modeloTv) !== 'NO TIENE',
  }
}

/**
 * Separa `1.7 H` en código de sala y código de edificio.
 * Devuelve null si el texto no tiene la forma `<sala> <EDIFICIO>`.
 */
export function splitIncidentKey(raw: string): { roomCode: string; buildingCode: string } | null {
  const n = cleanRoomRef(raw)
  if (!n) return null

  // El sufijo es la última palabra si son letras, y hasta 4 caracteres.
  const m = n.match(/^(.*?)\s+([A-Z]{1,4})$/)
  if (!m || !m[1] || !m[2]) return null

  return { roomCode: m[1].trim(), buildingCode: m[2] }
}

/**
 * Limpia los adornos que el histórico añade delante del código de sala.
 *
 * `Sotano -1.3 BC` y `-1.3 BC` son la misma sala: la planta ya va en el código.
 * `´-1.1 BC` arrastra un acento suelto de teclear con prisa.
 */
export function cleanRoomRef(raw: string): string {
  return norm(raw)
    .replace(/^[´`'"\s.]+/, '')
    .replace(/^S[OÓ]TANO\s+/, '')
    .replace(/^PLANTA\s+/, '')
    .trim()
}

/** `5.4 (LAB 3D)` → `5.4`. El nombre descriptivo va entre paréntesis. */
export function stripParenthetical(raw: string): string {
  return String(raw ?? '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Fechas del Excel que son texto mal tecleado, como `29-01-026`.
 *
 * `añoMax` acota lo creíble por arriba (por defecto, el año que viene): una
 * fecha de mantenimiento no puede ser futura. Devolver null ante lo increíble
 * es deliberado — quien llama decide con contexto (cuarentena, o el año de la
 * apertura), que siempre es mejor que una fecha inventada con seguridad.
 * Costó una lección: «27-03-296» convertido a ciegas en 2296 puso dos
 * incidencias del CRAI doscientos setenta años en el futuro, encabezando el
 * Historial desde entonces.
 */
export function parseLooseDate(
  value: unknown,
  añoMax = new Date().getUTCFullYear() + 1,
): { date: Date | null; fixed: string | null } {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // Un año de 2005 en una hoja de 2025 es un dedazo, no un dato.
    if (value.getFullYear() < 2015) {
      const corrected = new Date(value)
      corrected.setFullYear(value.getFullYear() + 20)
      return { date: corrected, fixed: `año ${value.getFullYear()} → ${corrected.getFullYear()}` }
    }
    // Y uno del futuro también: mejor ilegible que creído.
    if (value.getFullYear() > añoMax) return { date: null, fixed: null }
    return { date: value, fixed: null }
  }

  const s = String(value ?? '').trim()
  if (!s) return { date: null, fixed: null }

  // `29-01-026` → día-mes-año con el año mal tecleado.
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/)
  if (m && m[1] && m[2] && m[3]) {
    let year = Number(m[3])
    if (year < 100) year += 2000
    else if (year < 1000) {
      /*
       * Tres cifras nunca son un año: son dos cifras con un dedazo — «026» le
       * sobra un cero, a «296» le sobra un nueve. Se prueba a quitar cada
       * dígito y solo se acepta si UNA única lectura cae en la ventana creíble;
       * con dos lecturas posibles, mejor no adivinar.
       */
      const candidatos = new Set<number>()
      for (let i = 0; i < m[3].length; i++) {
        const dosCifras = Number(m[3].slice(0, i) + m[3].slice(i + 1)) + 2000
        if (dosCifras >= 2015 && dosCifras <= añoMax) candidatos.add(dosCifras)
      }
      if (candidatos.size !== 1) return { date: null, fixed: null }
      year = [...candidatos][0]!
    }
    if (year > añoMax) return { date: null, fixed: null }
    const d = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[1])))
    if (!Number.isNaN(d.getTime())) {
      return { date: d, fixed: `texto "${s}" → ${d.toISOString().slice(0, 10)}` }
    }
  }

  return { date: null, fixed: null }
}

/**
 * Parsea `Material Usado`, que hoy es texto libre del tipo
 * `1 Camara 520 PRO N/S 5310306900024  1 Cable exteder UDB`.
 *
 * Devuelve solo lo que se puede extraer con confianza. Lo que no encaje se
 * manda a cuarentena en vez de inventárselo: un inventario con datos
 * adivinados es peor que un inventario incompleto.
 */
export interface ParsedMaterial {
  qty: number
  item: string
  serial: string | null
}

export function parseMaterialUsed(raw: string): { items: ParsedMaterial[]; leftover: string | null } {
  const text = String(raw ?? '').trim()
  if (!text) return { items: [], leftover: null }

  // Los números de serie van tras `S/N`, `N/S` o `SN`.
  const serials: string[] = []
  const withoutSerials = text.replace(
    /\b(?:S\/N|N\/S|SN)\b[.: ]*([A-Z0-9,\s-]{5,})/gi,
    (_full, captured: string) => {
      captured
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 5)
        .forEach((s) => serials.push(s))
      return ' '
    },
  )

  // Cada partida empieza por una cantidad: `1 Cable Hdmi 10mts`, `2 cables ...`.
  const items: ParsedMaterial[] = []
  const chunkRe = /(\d+)\s*([A-Za-zÁÉÍÓÚÑáéíóúñ][^0-9]*?(?:\d+[.,]?\d*\s*(?:mts?|metros|m|")\s*\w*)?)(?=\s+\d+\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]|$)/g

  let match: RegExpExecArray | null
  while ((match = chunkRe.exec(withoutSerials)) !== null) {
    const qty = Number(match[1])
    const item = (match[2] ?? '').replace(/\s+/g, ' ').trim()
    if (item.length >= 3 && qty > 0 && qty < 500) {
      items.push({ qty, item, serial: null })
    }
  }

  // Los seriales encontrados se reparten en orden entre las partidas.
  serials.forEach((serial, i) => {
    const target = items[i] ?? items[0]
    if (target && !target.serial) target.serial = serial
  })

  if (items.length === 0) {
    return { items: [], leftover: text }
  }

  return { items, leftover: null }
}

/** Clave estable para deduplicar incidencias idénticas repetidas en el Excel. */
export function incidentDedupeKey(parts: {
  ref: string
  room: string
  date: string
  problem: string
}): string {
  return [norm(parts.ref), norm(parts.room), parts.date, norm(parts.problem).slice(0, 80)].join('|')
}

/**
 * El código tal y como debe verse en pantalla.
 *
 * Los códigos de plantas bajo rasante empiezan por guion (`-2.1`), y ese guion
 * se lee como un error de tecleo más que como un menos. Se sustituye por el
 * signo menos real (U+2212), que es más ancho y va a la altura de los dígitos:
 * se ve intencionado, no como una errata.
 *
 * Solo afecta a la presentación. El dato guardado no se toca, porque es la
 * clave con la que cruzan las incidencias del histórico.
 */
export function displayRoomCode(code: string): string {
  return code.replace(/^-/, '\u2212')
}
