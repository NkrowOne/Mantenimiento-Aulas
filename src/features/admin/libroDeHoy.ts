/**
 * El libro de hoy: lo que hace falta para que «descargar» signifique «con lo
 * que la aplicación sabe ahora», y no «la copia de la última vez».
 *
 * La tarjeta «El libro para SharePoint» guardaba el fichero que salió de la
 * última sincronización y lo ofrecía tal cual. Quien lo bajaba el viernes se
 * llevaba el martes: tres días de revisiones y partes que la aplicación ya
 * tenía y el libro no. Ponerlo al día existía, pero eran cuatro pasos —poner al
 * día, mirar, sincronizar, bajar— y el segundo preguntaba cosas.
 *
 * Aquí va la parte de eso que se puede probar sin pantalla ni base: qué se
 * contesta a las dudas cuando nadie va a contestarlas, cómo se cuentan los
 * cambios desde la última vez, y cómo se llama el fichero que sale.
 */

import { db } from '@/db/dexie'
import type { Duda, Respuestas } from '@/domain/dudas'
import { pendientes } from '@/domain/dudas'
import { flush } from '@/sync/outbox'

// -----------------------------------------------------------------------------
// Las dudas, cuando se quiere el libro y no una decisión
// -----------------------------------------------------------------------------

/**
 * Deja como está todo lo que la pasada pregunta.
 *
 * «Hacer el libro de hoy» parte de la copia que salió de la última pasada, así
 * que del lado del Excel no hay nada nuevo que decidir: lo que la pasada
 * pregunte es lo mismo que preguntó entonces —un Panacast que la sala no tiene,
 * un parte tecleado sin aula— y que alguien ya dejó como estaba. Volver a
 * preguntarlo para bajar un fichero con las revisiones de esta semana es lo que
 * convertía cuatro pasos en «no se puede».
 *
 * Contestar «se deja como está» no toca nada en ningún lado y no se recuerda:
 * la próxima vez que se suba el libro por el camino normal, la pregunta vuelve.
 */
export function dejarComoEsta(dudas: Duda[], respuestas: Respuestas): Respuestas {
  const out: Respuestas = { ...respuestas }
  for (const d of pendientes(dudas, respuestas)) {
    out[d.id] = d.tipo === 'alta' ? { tipo: 'alta', aceptar: false } : { tipo: 'ignorar' }
  }
  return out
}

// -----------------------------------------------------------------------------
// El nombre del fichero
// -----------------------------------------------------------------------------

/**
 * El nombre del libro que sale, con el día.
 *
 * Los sufijos de pasadas anteriores se quitan antes de poner el nuevo. Hacía
 * falta porque SharePoint cambia los paréntesis y los espacios por guiones
 * bajos al subir, y el libro volvía como `…_sincronizado_sincronizado.xlsx`:
 * cada vuelta le colgaba una palabra más y ninguna decía de qué día era.
 */
export function nombreDelLibro(nombre: string, sufijo: string): string {
  let base = nombre.replace(/\.xlsx$/i, '')
  // `(sincronizado)`, `(sincronizado 2026-09-22)`, `(vista previa)`, repetidos o no.
  base = base.replace(/(\s*\((?:sincronizado|vista previa)[^)]*\))+$/i, '')
  // Y la forma en que SharePoint los devuelve: `_sincronizado_2026-09-22`,
  // con o sin el `(1)` que le cuelga el navegador a la segunda descarga.
  const restos = /(?:[\s_-]+(?:sincronizado|vista[\s_]+previa)(?:[\s_-]+\d{4}-\d{2}-\d{2})?|\s*\(\d+\)|[\s_-]+\(\d+\))+$/i
  base = base.replace(restos, '')
  base = base.replace(/(\s*\((?:sincronizado|vista previa)[^)]*\))+$/i, '').replace(restos, '')
  // Sin el separador que quedara colgando: `Material_Aulas_` no es un nombre.
  base = base.replace(/[\s_-]+$/, '')
  return `${base.trim() || 'Libro'} (${sufijo}).xlsx`
}

// -----------------------------------------------------------------------------
// Cuánto ha cambiado la aplicación desde la última vez
// -----------------------------------------------------------------------------

export interface CambiosDesde {
  /** Revisiones completas hechas después. */
  revisiones: number
  /** Partes abiertos o resueltos después. */
  incidencias: number
  /**
   * Lo que este aparato hizo y todavía no ha subido al servidor. El libro se
   * hace con lo que el servidor sabe, así que esto no está en ningún libro,
   * sea de cuándo sea: la tarjeta tiene que decirlo antes que nada.
   */
  sinSubir: number
  /**
   * `false` si el espejo de este aparato está vacío: entonces no se puede
   * decir ni que hay cambios ni que no los hay, y la frase tiene que ser otra.
   */
  conocido: boolean
}

/**
 * Lo que la aplicación tiene desde `cuando`, contado en el espejo local.
 *
 * Se cuenta aquí y no en el servidor porque es un letrero, no una decisión: la
 * pasada mira la base entera igualmente. Lo que hace falta es que quien abre la
 * tarjeta vea que el libro guardado se ha quedado viejo sin tener que saberlo.
 */
export async function cambiosDesde(cuando: string): Promise<CambiosDesde> {
  const [total, sinSubir, revisiones, abiertas, resueltas] = await Promise.all([
    db.inspections.count().then(async (n) => n + (await db.incidents.count())),
    db.outbox.where('status').anyOf('pendiente', 'enviando').count(),
    // Por la fecha de la visita, o por la de la corrección: una revisión de
    // marzo corregida ayer conserva `occurred_at` a propósito, y en el libro
    // es una fila más. Una hecha y corregida después de la copia cuenta una.
    db.inspections
      .filter(
        (i) =>
          i.status === 'completa' &&
          (i.occurred_at > cuando || (i.corrected_at !== null && i.corrected_at !== undefined && i.corrected_at > cuando)),
      )
      .toArray()
      .then((nuevas) => {
        // Una hecha y corregida después de la copia es un cambio, no dos: la
        // corregida no cuenta si su corrección ya cuenta.
        const corregidas = new Set(nuevas.map((i) => i.corrects).filter((c): c is string => typeof c === 'string'))
        return nuevas.filter((i) => !corregidas.has(i.id)).length
      }),
    db.incidents.where('opened_at').above(cuando).count(),
    db.incidents
      .filter((i) => i.resolved_at !== null && i.resolved_at > cuando && i.opened_at <= cuando)
      .count(),
  ])
  return { revisiones, incidencias: abiertas + resueltas, sinSubir, conocido: total > 0 }
}

/**
 * Antes de leer la base para hacer un libro: lo que este aparato tenga en la
 * cola, arriba. Una revisión hecha sin cobertura vive en el espejo local y en
 * la cola, y el libro se hace con lo que el servidor sabe: si no ha subido, el
 * libro sale sin ella y la tarjeta diría después que «no ha cambiado nada».
 * Se fuerza la subida y se dice qué queda; con algo todavía en cola no se
 * hace el libro. Lo rechazado no se va a mover solo: se cuenta aparte y no
 * para nada, porque el aviso de «rechazados» ya está en la barra de arriba.
 */
export async function colaAntesDelLibro(): Promise<{ sinSubir: number; rechazados: number }> {
  try {
    await flush({ forzar: true })
  } catch {
    // Que no se pueda subir ahora no cambia la pregunta: lo que queda, queda.
  }
  const [sinSubir, rechazados] = await Promise.all([
    db.outbox.where('status').anyOf('pendiente', 'enviando').count(),
    db.outbox.where('status').equals('rechazado').count(),
  ])
  return { sinSubir, rechazados }
}

/** La frase de la tarjeta, a partir de los recuentos. */
export function fraseDeCambios(c: CambiosDesde): { texto: string; viejo: boolean } {
  if (c.sinSubir > 0) {
    return {
      texto: `Este aparato tiene ${c.sinSubir} ${c.sinSubir === 1 ? 'cambio' : 'cambios'} sin subir al servidor: ningún libro los lleva todavía. Al hacer el libro de hoy se suben primero.`,
      viejo: true,
    }
  }
  if (!c.conocido) {
    return {
      texto: 'Este aparato todavía no tiene el espejo de la aplicación: no se sabe si ha cambiado algo desde entonces.',
      viejo: true,
    }
  }
  if (c.revisiones === 0 && c.incidencias === 0) {
    return { texto: 'La aplicación no tiene revisiones ni partes nuevos desde entonces.', viejo: false }
  }
  const partes: string[] = []
  if (c.revisiones > 0) partes.push(`${c.revisiones} ${c.revisiones === 1 ? 'revisión' : 'revisiones'}`)
  if (c.incidencias > 0) partes.push(`${c.incidencias} ${c.incidencias === 1 ? 'parte' : 'partes'}`)
  return {
    texto: `Desde entonces la aplicación tiene ${partes.join(' y ')} más: este libro se ha quedado viejo.`,
    viejo: true,
  }
}
