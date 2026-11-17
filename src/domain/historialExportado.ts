/**
 * El historial de intervenciones de una sala o de un edificio, como libro.
 *
 * La pantalla de la sala enseña lo que le ha pasado, pero no se lo puede llevar
 * nadie: ni a una reunión, ni a un proveedor que pregunta cuántas veces se ha
 * cambiado esa lámpara, ni a quien decide si un aula se renueva. Esto lo
 * convierte en un documento —Excel y PDF, por la misma vista previa que el
 * almacén y los equipos— con las tres preguntas que se le hacen a un historial,
 * cada una en su hoja:
 *
 *  1. **Intervenciones**: todo lo que pasó, en orden, con su día y su hora. Es
 *     la línea de tiempo de la ficha, entera.
 *  2. **Incidencias**: una fila por incidencia —y no dos, apertura y cierre—
 *     con cuándo se abrió, cuándo se resolvió, qué se hizo y qué material se
 *     gastó en ella.
 *  3. **Material usado**: una fila por movimiento de almacén apuntado a la
 *     sala, con el artículo, la cantidad y la incidencia en la que se gastó.
 *
 * Del más antiguo al más reciente, que es como se leen todos los historiales
 * del libro.
 *
 * **La hora va en su columna**, aparte de la fecha. Una celda de fecha de Excel
 * con hora dentro se filtra mal y se ordena peor en cuanto alguien la toca; dos
 * columnas se leen y se filtran solas. La hora es la del campus, no la del
 * dispositivo desde el que se descarga.
 *
 * Vive en `domain` y sin red: lo que aquí se decide —qué fila va en qué hoja,
 * cómo se suma el material de una incidencia— es lo que se rompe en silencio si
 * nadie lo prueba. Leer los datos es cosa de `features/history`.
 */

import { horaCorta } from './fechas'
import { subtipoLegible, type EventoSala, type TipoEvento } from './historial'
import type { Formato, HojaNueva, Tinte } from './libro'
import { displayRoomCode } from './normalize'
import type { IncidentKind, IncidentState, Severity } from './types'
import { INCIDENT_KIND_LABELS } from './types'
import { fechaAExcel } from './valores'
import type { HojaParaExportar } from './vistaPrevia'
import type { ValorCelda } from './xlsx'

/** Una fila de `room_timeline`, con las columnas que la pantalla no usa. */
export interface EventoDelHistorial extends EventoSala {
  /** La referencia del libro (`I260203_0051`) o el número de serie, según el tipo. */
  ref?: string | null
  room_code?: string | null
}

/** Lo que hace falta de una incidencia para su fila. */
export interface IncidenciaDelHistorial {
  id: string
  room_id: string | null
  kind: IncidentKind
  state: IncidentState
  severity: Severity
  title: string | null
  description: string | null
  opened_at: string
  opened_by: string | null
  resolved_at: string | null
  resolved_by: string | null
  resolution: string | null
  external_ref: string | null
  easyvista_ref: string | null
}

export interface DatosDelHistorial {
  eventos: EventoDelHistorial[]
  incidencias: IncidenciaDelHistorial[]
  /** De qué incidencia es cada movimiento de almacén: `{ [movimiento]: incidencia }`. */
  incidenciaDeMovimiento: Record<string, string>
  /** El código de cada sala, `{ [room_id]: '1.7' }`, para las hojas de un edificio. */
  salas: Record<string, string>
  /**
   * Si el documento es de un edificio entero. Entonces cada hoja lleva la
   * columna «Sala»; en el de una sola sala sobraría en todas las filas.
   */
  deEdificio: boolean
}

const TIPO: Record<TipoEvento, string> = {
  incidencia: 'Incidencia',
  solicitud: 'Solicitud',
  observacion: 'Observación',
  revision_ok: 'Revisión',
  revision_ko: 'Revisión con incidencias',
  material: 'Material',
  equipo: 'Equipo',
  inventario: 'Inventario',
}

const ESTADO: Record<IncidentState, string> = {
  borrador: 'Sin completar',
  abierta: 'Abierta',
  en_curso: 'En curso',
  resuelta: 'Resuelta',
}

const GRAVEDAD: Record<Severity, string> = { baja: 'Baja', media: 'Media', alta: 'Alta' }

const MOVIMIENTO: Record<string, string> = {
  consumo: 'Consumido',
  devolucion: 'Devuelto',
  compra: 'Entrada',
  ajuste: 'Ajuste',
}

const fecha = (iso: string | null): number | null => (iso ? fechaAExcel(iso) : null)
const hora = (iso: string | null): string | null => (iso ? horaCorta(iso) || null : null)
const mayuscula = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s)

/** Quita o deja la columna «Sala» de una fila, de sus anchos o de sus formatos. */
function conSala<T>(d: DatosDelHistorial, antes: T[], sala: T, despues: T[]): T[] {
  return d.deEdificio ? [...antes, sala, ...despues] : [...antes, ...despues]
}

/**
 * El material gastado en cada incidencia, ya escrito: «2 × Cable HDMI 2 m».
 *
 * Es el NETO por artículo. Un consumo de 2 y una devolución de 1 en la misma
 * incidencia son un cable gastado, no «2 consumidos, 1 devuelto»: quien lee la
 * fila de la incidencia quiere saber qué se quedó puesto. El detalle, con sus
 * dos movimientos, está en la hoja de material.
 */
export function materialPorIncidencia(d: DatosDelHistorial): Map<string, string> {
  const netos = new Map<string, Map<string, number>>()
  for (const e of d.eventos) {
    if (e.kind !== 'material' || e.qty === null) continue
    const incidencia = d.incidenciaDeMovimiento[e.ref_id]
    if (!incidencia) continue
    const porArticulo = netos.get(incidencia) ?? new Map<string, number>()
    // En el almacén sale en negativo: lo gastado es el signo contrario.
    porArticulo.set(e.title, (porArticulo.get(e.title) ?? 0) - e.qty)
    netos.set(incidencia, porArticulo)
  }
  const escrito = new Map<string, string>()
  for (const [incidencia, porArticulo] of netos) {
    const lineas = [...porArticulo.entries()]
      .filter(([, n]) => n > 0)
      .sort((a, b) => a[0].localeCompare(b[0], 'es'))
      .map(([articulo, n]) => `${n} × ${articulo}`)
    if (lineas.length > 0) escrito.set(incidencia, lineas.join('; '))
  }
  return escrito
}

const porFecha = <T extends { at: string }>(a: T, b: T): number => a.at.localeCompare(b.at)

/** Todo lo que pasó, en orden, con su día y su hora. */
export function hojaDeIntervenciones(d: DatosDelHistorial): HojaNueva {
  const material = materialPorIncidencia(d)
  const filas: ValorCelda[][] = [
    conSala<ValorCelda>(
      d,
      ['Fecha', 'Hora'],
      'Sala',
      ['Tipo', 'Estado', 'Descripción', 'Detalle', 'Material usado', 'Cantidad', 'Referencia', 'Realizado por'],
    ),
  ]
  const tintes: Array<Tinte | undefined> = []

  for (const e of [...d.eventos].sort(porFecha)) {
    const esCierre = e.kind === 'incidencia' && e.subkind === 'resuelta'
    filas.push(
      conSala<ValorCelda>(d, [fecha(e.at), hora(e.at)], salaDe(d, e.room_id, e.room_code), [
        TIPO[e.kind] ?? e.kind,
        mayuscula(subtipoLegible(e)) || null,
        e.title,
        e.detail,
        // El material va en la fila del CIERRE, que es cuando se gastó y donde
        // se cuenta qué se hizo. En la de apertura sería adelantar el final.
        esCierre ? (material.get(e.ref_id) ?? null) : null,
        // En positivo: la palabra de «Estado» ya dice si salió o volvió.
        e.kind === 'material' && e.qty !== null ? Math.abs(e.qty) : null,
        e.ref ?? null,
        e.who,
      ]),
    )
    tintes.push(tinteDelEvento(e))
  }

  return {
    nombre: 'Intervenciones',
    filas,
    anchos: conSala(d, [11, 7], 9, [22, 14, 44, 50, 36, 10, 16, 24]),
    formatos: conSala<Formato | undefined>(d, ['fecha', undefined], undefined, [
      undefined,
      undefined,
      'textoAjustado',
      'textoAjustado',
      'textoAjustado',
      'entero',
      undefined,
      undefined,
    ]),
    tintes,
    caracter: 'app',
  }
}

function tinteDelEvento(e: EventoDelHistorial): Tinte | undefined {
  if (e.kind === 'incidencia') return e.subkind === 'resuelta' ? 'ok' : 'critico'
  if (e.kind === 'revision_ko') return 'aviso'
  if (e.kind === 'equipo' && (e.subkind === 'baja' || e.subkind === 'averia')) return 'aviso'
  return undefined
}

function salaDe(d: DatosDelHistorial, roomId: string | null, codigo?: string | null): string | null {
  const c = codigo ?? (roomId ? d.salas[roomId] : null)
  return c ? displayRoomCode(c) : null
}

/** Los días enteros entre dos instantes; hasta hoy si sigue abierta. */
function diasAbierta(i: IncidenciaDelHistorial, ahora: Date): number {
  const fin = i.resolved_at ? new Date(i.resolved_at).getTime() : ahora.getTime()
  return Math.max(0, Math.floor((fin - new Date(i.opened_at).getTime()) / 86_400_000))
}

/** Una fila por incidencia: cuándo se abrió, cuándo se cerró, qué se hizo y con qué. */
export function hojaDeIncidencias(d: DatosDelHistorial, ahora = new Date()): HojaNueva {
  const material = materialPorIncidencia(d)
  // Los nombres salen de la propia línea de tiempo, que ya los trae resueltos:
  // así no hace falta otro viaje al servidor para saber quién es cada uuid.
  const nombre = new Map<string, string>()
  for (const e of d.eventos) if (e.by_user && e.who) nombre.set(e.by_user, e.who)
  const quien = (id: string | null): string | null => (id ? (nombre.get(id) ?? null) : null)

  const filas: ValorCelda[][] = [
    conSala<ValorCelda>(d, ['Abierta el', 'Hora'], 'Sala', [
      'Tipo',
      'Gravedad',
      'Estado',
      'Descripción',
      'Detalle',
      'Resuelta el',
      'Hora de cierre',
      'Solución',
      'Material usado',
      'Días abierta',
      'Referencia',
      'EasyVista',
      'Abierta por',
      'Resuelta por',
    ]),
  ]
  const tintes: Array<Tinte | undefined> = []

  const ordenadas = [...d.incidencias].sort((a, b) => a.opened_at.localeCompare(b.opened_at))
  for (const i of ordenadas) {
    filas.push(
      conSala<ValorCelda>(d, [fecha(i.opened_at), hora(i.opened_at)], salaDe(d, i.room_id), [
        INCIDENT_KIND_LABELS[i.kind] ?? i.kind,
        // La gravedad es de las averías: en una solicitud no significa nada.
        i.kind === 'incidencia' ? GRAVEDAD[i.severity] : null,
        ESTADO[i.state] ?? i.state,
        i.title,
        i.description,
        fecha(i.resolved_at),
        hora(i.resolved_at),
        i.resolution,
        material.get(i.id) ?? null,
        diasAbierta(i, ahora),
        i.external_ref,
        i.easyvista_ref,
        quien(i.opened_by),
        quien(i.resolved_by),
      ]),
    )
    tintes.push(i.state === 'resuelta' ? 'ok' : i.kind === 'incidencia' ? 'critico' : 'aviso')
  }

  return {
    nombre: 'Incidencias',
    filas,
    anchos: conSala(d, [11, 7], 9, [13, 10, 14, 44, 50, 11, 9, 50, 36, 9, 16, 14, 24, 24]),
    formatos: conSala<Formato | undefined>(d, ['fecha', undefined], undefined, [
      undefined,
      undefined,
      undefined,
      'textoAjustado',
      'textoAjustado',
      'fecha',
      undefined,
      'textoAjustado',
      'textoAjustado',
      'entero',
      undefined,
      undefined,
      undefined,
      undefined,
    ]),
    tintes,
    caracter: 'app',
  }
}

/** Una fila por movimiento de almacén apuntado a la sala. */
export function hojaDeMaterialUsado(d: DatosDelHistorial): HojaNueva {
  const porId = new Map(d.incidencias.map((i) => [i.id, i]))
  const filas: ValorCelda[][] = [
    conSala<ValorCelda>(d, ['Fecha', 'Hora'], 'Sala', [
      'Artículo',
      'Cantidad',
      'Movimiento',
      'Incidencia',
      'Referencia',
      'Nota',
      'Realizado por',
    ]),
  ]
  const tintes: Array<Tinte | undefined> = []

  for (const e of d.eventos.filter((x) => x.kind === 'material').sort(porFecha)) {
    const incidencia = porId.get(d.incidenciaDeMovimiento[e.ref_id] ?? '')
    filas.push(
      conSala<ValorCelda>(d, [fecha(e.at), hora(e.at)], salaDe(d, e.room_id, e.room_code), [
        e.title,
        e.qty === null ? null : Math.abs(e.qty),
        MOVIMIENTO[e.subkind] ?? mayuscula(e.subkind),
        incidencia?.title ?? null,
        incidencia?.external_ref ?? null,
        e.detail,
        e.who,
      ]),
    )
    // Lo devuelto, apagado: no es material gastado, y no debe pesar como tal.
    tintes.push(e.subkind === 'devolucion' ? 'apagado' : undefined)
  }

  return {
    nombre: 'Material usado',
    filas,
    anchos: conSala(d, [11, 7], 9, [34, 10, 13, 44, 16, 40, 24]),
    formatos: conSala<Formato | undefined>(d, ['fecha', undefined], undefined, [
      undefined,
      'entero',
      undefined,
      'textoAjustado',
      undefined,
      'textoAjustado',
      undefined,
    ]),
    tintes,
    caracter: 'app',
  }
}

/**
 * Las tres hojas, con lo que va de cada una al PDF.
 *
 * Al papel van menos columnas que al Excel: una hoja de dieciséis en un A4 son
 * letras de tres puntos. Se quedan las que contestan a la pregunta de la hoja;
 * las referencias y los nombres completos están en el Excel.
 */
export function hojasDelHistorial(d: DatosDelHistorial, ahora = new Date()): HojaParaExportar[] {
  const sala = d.deEdificio ? ['Sala'] : []
  return [
    {
      hoja: hojaDeIntervenciones(d),
      pdf: {
        columnas: ['Fecha', 'Hora', ...sala, 'Tipo', 'Descripción', 'Detalle', 'Material usado', 'Realizado por'],
      },
    },
    {
      hoja: hojaDeIncidencias(d, ahora),
      pdf: {
        columnas: ['Abierta el', ...sala, 'Estado', 'Descripción', 'Resuelta el', 'Solución', 'Material usado'],
      },
    },
    {
      hoja: hojaDeMaterialUsado(d),
      pdf: { columnas: ['Fecha', 'Hora', ...sala, 'Artículo', 'Cantidad', 'Movimiento', 'Incidencia'] },
    },
  ]
}

/** La línea de cifras que encabeza el documento. */
export function resumenDelHistorial(d: DatosDelHistorial): string {
  const n = (cuantos: number, uno: string, varios: string): string =>
    `${cuantos.toLocaleString('es-ES')} ${cuantos === 1 ? uno : varios}`
  const incidencias = d.incidencias.filter((i) => i.kind === 'incidencia')
  const abiertas = incidencias.filter((i) => i.state !== 'resuelta').length
  const movimientos = d.eventos.filter((e) => e.kind === 'material').length
  return [
    n(d.eventos.length, 'intervención', 'intervenciones'),
    `${n(incidencias.length, 'incidencia', 'incidencias')}${abiertas > 0 ? ` (${abiertas} sin resolver)` : ''}`,
    n(movimientos, 'movimiento de material', 'movimientos de material'),
  ].join(' · ')
}
