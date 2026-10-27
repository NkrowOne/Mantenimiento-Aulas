/**
 * Qué decir cuando algo del almacén falla.
 *
 * Vivía dentro de `StockPage`, y la hoja de cada artículo y la de cada unidad
 * necesitan exactamente lo mismo: los mensajes de la base ya vienen en español y
 * dicen qué pasó («Esa unidad no está disponible»), y solo los que llegan en
 * jerga —permisos, duplicados, red— se traducen. Con dos copias acabarían
 * diciendo cosas distintas del mismo fallo.
 */

/**
 * El texto del fallo, venga de donde venga.
 *
 * `fetch` lanza un `Error`; PostgREST devuelve un objeto pelado
 * —`{ message, code, hint }`— que supabase-js reenvía tal cual. Preguntar solo
 * por `instanceof Error` daba falso justo para los fallos del servidor, que son
 * los únicos que traen algo que traducir.
 */
export function mensajeDe(error: unknown): string {
  if (error instanceof Error) return error.message
  const m = (error as { message?: unknown } | null)?.message
  return typeof m === 'string' ? m : ''
}

export function codigoDe(error: unknown): string {
  const c = (error as { code?: unknown } | null)?.code
  return typeof c === 'string' ? c : ''
}

/**
 * ¿El fallo es de red o del servidor?
 *
 * Es la única distinción que cambia lo que el técnico hace después: buscar
 * cobertura, o hablar con administración.
 */
export function esFalloDeRed(error: unknown): boolean {
  return /fetch|network|failed to fetch|networkerror|load failed/i.test(mensajeDe(error))
}

/**
 * El movimiento dejaría el almacén en negativo.
 *
 * El botón `−` ya sale apagado a cero, así que esto salta cuando la cifra de la
 * pantalla se ha quedado vieja: otro técnico gastó la última unidad hace un
 * minuto. Sin distinguirlo, el mensaje que aparecía era «Solo un supervisor
 * registra compras», que manda a pedir un permiso que no falta.
 */
export function esSinExistencias(error: unknown): boolean {
  return /no hay tantas unidades|en negativo|no quedan tantas/i.test(mensajeDe(error))
}

/**
 * Qué decir cuando un menos o un más del almacén no se ha registrado.
 *
 * Lo mismo que la tarjeta de debajo de la lista, en una línea: es lo que se
 * pinta dentro de la hoja del artículo, que tapa esa tarjeta mientras está
 * abierta. Cuando lo que falta es de un estado —«No quedan tantas en estado
 * «Usado» de «Teclado»: hay 0»— la base ya lo dice con las cifras, y va tal cual.
 */
export function falloAlMover(error: unknown): string {
  if (/no quedan tantas en estado/i.test(mensajeDe(error))) return mensajeDe(error)
  if (esSinExistencias(error)) return 'No quedan tantas: el movimiento no se ha registrado.'
  if (!navigator.onLine || esFalloDeRed(error)) return 'Sin conexión: no se ha registrado. Busca cobertura y repítelo.'
  if (esFaltaDePermiso(error) || codigoDe(error) === '42501') return 'Solo un supervisor registra entradas en el almacén.'
  return mensajeDe(error) || 'No se ha podido registrar.'
}

/** Lo mismo para cambiar el estado de unas cuantas. */
export function falloDeEstado(error: unknown): string {
  if (!navigator.onLine || esFalloDeRed(error)) return 'Sin conexión: no se ha guardado. Busca cobertura y repítelo.'
  if (/stock_cambiar_estado|schema cache|does not exist/i.test(mensajeDe(error))) {
    return 'El servidor todavía no sabe de estados: falta aplicar la migración del 27 de octubre.'
  }
  return mensajeDe(error) || 'No se ha podido guardar.'
}

/**
 * El nombre ya existe con otras mayúsculas o tildes.
 *
 * Lo frena el índice único sobre el nombre normalizado, que es lo que impide
 * que vuelvan a convivir «Teclado» y «teclado». Sin traducirlo, el técnico ve
 * `duplicate key value violates unique constraint "stock_items_norm_idx"` y
 * concluye que la aplicación está rota, cuando lo que pasa es que el artículo
 * que quiere crear ya está en la lista dos filas más arriba.
 */
export function esDuplicado(error: unknown): boolean {
  if (codigoDe(error) === '23505') return true
  return /duplicate key|stock_items_norm_idx|already exists|ya hay otro artículo/i.test(mensajeDe(error))
}

/** El servidor ha dicho que no por el rol: el botón no debía estar, o el rol cambió después de abrir. */
export function esFaltaDePermiso(error: unknown): boolean {
  return (
    codigoDe(error) === '42501' ||
    /solo un administrador|solo un supervisor|insufficient_privilege/i.test(mensajeDe(error))
  )
}

/**
 * Qué decir cuando retirar, restaurar o renombrar ha fallado. Los mensajes de
 * la base ya vienen en español y dicen qué pasó («Ese artículo ya está
 * retirado»); solo los que llegan en jerga se traducen.
 */
export function falloDeAdministracion(error: unknown): string {
  if (esFaltaDePermiso(error)) return 'Solo un administrador puede hacer esto.'
  if (esDuplicado(error)) return 'Ya hay otro artículo con ese nombre: búscalo en la lista.'
  if (!navigator.onLine || esFalloDeRed(error)) return 'Sin conexión: no se ha guardado. Busca cobertura y repítelo.'
  return mensajeDe(error) || 'No se ha podido guardar.'
}

/**
 * Lo mismo para lo que se hace con una unidad: el número de serie repetido lo
 * explica la base nombrando la otra, así que su mensaje va tal cual.
 */
export function falloDeUnidad(error: unknown): string {
  if (!navigator.onLine || esFalloDeRed(error)) return 'Sin conexión: no se ha guardado. Busca cobertura y repítelo.'
  if (/stock_unit|schema cache|does not exist/i.test(mensajeDe(error)) && !/ya |está/i.test(mensajeDe(error))) {
    return 'El servidor todavía no sabe de unidades con estado: falta aplicar la migración del 27 de octubre.'
  }
  if (esFaltaDePermiso(error) && !mensajeDe(error).startsWith('Solo')) return 'No tienes permiso para hacer esto.'
  return mensajeDe(error) || 'No se ha podido guardar.'
}
