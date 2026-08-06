/**
 * Las reglas de la nomenclatura: qué se puede escribir en un código y cuándo
 * dos nombres son el mismo nombre.
 *
 * Vive aparte de la interfaz porque es lo único de este trabajo que se puede
 * probar sin red y sin pantalla, y porque lo comparten tres formularios que
 * **tienen que decidir igual**: renombrar un edificio, renombrar o mover una
 * sala y renombrar una planta. Si cada uno validara por su cuenta, el mismo
 * texto sería válido en un sitio e inválido en otro, y el usuario aprendería
 * que la aplicación no sabe lo que quiere.
 *
 * La regla de fondo de todo el fichero: **estas comprobaciones son un aviso
 * temprano, no la autoridad**. Quien decide es el servidor, que es el único que
 * ve las 276 salas de los 23 dispositivos a la vez; lo de aquí existe para que
 * el administrador se entere del choque mientras todavía tiene el teclado
 * delante, en vez de recibir un 23505 medio segundo después de pulsar.
 */

import type { Zone } from './types'

/**
 * Normalización IDÉNTICA a `public.norm_text()` del servidor.
 *
 * No se reutiliza `norm()` de `normalize.ts` a propósito, y la diferencia es de
 * una línea con consecuencias: `norm()` convierte las comas en puntos (`1,7` →
 * `1.7`) porque nació para leer el Excel, donde una coma decimal es un punto
 * mal tecleado. `norm_text()` no hace nada de eso. Validar aquí con una regla y
 * allí con otra produce el peor de los mensajes: un «no hay duplicados» en el
 * iPad y un 23505 del servidor un segundo después, sobre el mismo texto.
 *
 * Lo que sí difiere, y es a propósito: el servidor quita las tildes con un
 * `translate()` de la lista castellana, y esto usa la descomposición Unicode,
 * que además alcanza a lo que no está en esa lista. La asimetría solo puede
 * hacer que el cliente avise de un choque que el servidor aceptaría —nunca al
 * revés—, que es el lado bueno en el que equivocarse.
 */
export function normServidor(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Revierte el signo menos de presentación (U+2212) al guion que se guarda.
 *
 * `displayRoomCode` pinta `−2.1` porque el guion se lee como una errata más que
 * como un menos. El problema aparece en cuanto hay un campo editable: si se
 * rellena con ESE texto —o alguien lo pega desde la propia pantalla— el U+2212
 * acaba en la columna `code`, y a partir de ahí `roomMatches` (que quita `^-`,
 * no `^−`), `cleanRoomRef`, `splitIncidentKey` y el cruce con
 * `room_aliases.alias_norm` dejan de encontrar la sala. La sala sigue ahí, pero
 * su histórico de incidencias ya no la reconoce.
 *
 * No recorta espacios: esto corre en cada pulsación de tecla y quitarle los
 * espacios a alguien mientras escribe es lo que impide teclear «AULA MAGNA».
 * El recorte va en la validación, que corre al enviar.
 */
export function sanearCodigo(code: string): string {
  return String(code ?? '').replace(/\u2212/g, '-')
}

/** El código de un edificio es una matrícula: mayúsculas, sin tildes, sin dobles espacios. */
export function sanearCodigoDeEdificio(code: string): string {
  return normServidor(code)
}

export interface Choque {
  /** El id del que ya ocupa ese código, o null si está libre. */
  con: string | null
  /** Cómo se llama el que lo ocupa. Para el mensaje. */
  etiqueta: string | null
}

const SIN_CHOQUE: Choque = { con: null, etiqueta: null }

/**
 * ¿Choca este código con otro de la lista, ignorando mayúsculas y tildes?
 *
 * Se compara con `normServidor` y no con `===`, y esa elección es la que evita
 * un duplicado invisible: el `unique (zone_id, code)` de Postgres distingue
 * mayúsculas, así que `a1` y `A1` entran las dos como salas distintas de la
 * misma planta. Nadie las ve como dos cosas distintas al mirar la lista, pero
 * las incidencias se reparten entre ambas y ninguna de las dos tiene el
 * histórico entero.
 *
 * `excepto` es el id del que se está editando: renombrar una sala sin tocarle
 * el código —se abrió el formulario solo para corregir el nombre— no puede ser
 * un choque consigo misma.
 */
export function chocaCodigo(
  nuevo: string,
  existentes: Array<{ id: string; code: string; name?: string }>,
  excepto?: string,
): Choque {
  const objetivo = normServidor(sanearCodigo(nuevo))
  if (!objetivo) return SIN_CHOQUE

  const ocupado = existentes.find(
    (e) => e.id !== excepto && normServidor(sanearCodigo(e.code)) === objetivo,
  )
  if (!ocupado) return SIN_CHOQUE

  return { con: ocupado.id, etiqueta: ocupado.name?.trim() || ocupado.code }
}

/** ¿Son la misma planta escrita de dos formas? Misma regla que el servidor. */
export function mismaPlanta(a: string, b: string): boolean {
  const na = normServidor(a)
  return na !== '' && na === normServidor(b)
}

/**
 * La planta del mismo edificio con la que fusionaría este nombre, si la hay.
 *
 * `rename_zone` fusiona cuando el nombre nuevo ya existe en el edificio: mueve
 * las aulas a la otra planta y borra esta. Es lo correcto —rechazar obligaría a
 * mover el aula una a una y no hay ninguna herramienta para eso— pero es una
 * consecuencia grande para descubrirla en el mensaje de éxito. Esto es lo que
 * permite avisar ANTES de pedirlo, con el número de aulas delante, porque el
 * cliente ya tiene las zonas del edificio en el espejo local.
 */
export function plantaQueAbsorbe(nuevo: string, zonas: Zone[], excepto: string): Zone | null {
  return zonas.find((z) => z.id !== excepto && mismaPlanta(z.name, nuevo)) ?? null
}

/**
 * Un salto de línea pegado dentro del texto.
 *
 * Suena a rareza y es el caso corriente: los códigos se copian de la hoja de
 * Excel de la que salió todo esto, y una celda copiada arrastra el salto de
 * línea final. Se guardaría tal cual —el servidor hace `btrim`, que quita el
 * blanco de los extremos, pero no el de en medio— y un código con un `\n`
 * dentro no vuelve a cruzar con nada.
 */
const HAY_SALTO = /[\n\r\t]/

/** `null` = se puede enviar. Si no, la frase concreta que se pinta en `text-crit`. */
export function validarSala(code: string, name: string): string | null {
  if (HAY_SALTO.test(code) || HAY_SALTO.test(name)) {
    return 'Hay un salto de línea pegado dentro del texto. Quítalo: se guardaría tal cual y la sala dejaría de cruzar con su histórico.'
  }
  if (sanearCodigo(code).trim() === '') {
    return 'La sala necesita un código: es lo que va en la placa y con lo que las incidencias la nombran.'
  }
  return null
}

export function validarEdificio(code: string, name: string): string | null {
  if (HAY_SALTO.test(code) || HAY_SALTO.test(name)) {
    return 'Hay un salto de línea pegado dentro del texto. Quítalo antes de guardar.'
  }
  if (sanearCodigoDeEdificio(code) === '') return 'El edificio necesita un código.'
  if (name.trim() === '') return 'El edificio necesita un nombre: el código solo no dice cuál es.'
  return null
}

export function validarPlanta(name: string): string | null {
  if (HAY_SALTO.test(name)) return 'Hay un salto de línea pegado dentro del texto. Quítalo antes de guardar.'
  if (normServidor(name) === '') return 'La planta necesita un nombre.'
  return null
}

/**
 * Aviso, no bloqueo.
 *
 * El código de edificio es el sufijo con el que el histórico nombra sus salas
 * —«1.7 H»—, y `splitIncidentKey` solo reconoce como sufijo una última palabra
 * de una a cuatro LETRAS. Un código más largo, o con dígitos o signos dentro,
 * hace que las incidencias importadas de ese edificio dejen de resolverse y
 * caigan en `import_quarantine`.
 *
 * Aun así no se prohíbe: el servidor no tiene esa regla, y una regla que solo
 * existe en el cliente es una regla que alguien se salta desde el panel sin
 * enterarse de nada. Se dice lo que va a pasar y decide quien lo escribe.
 */
export function avisoDeCodigoDeEdificio(code: string): string | null {
  const c = sanearCodigoDeEdificio(code)
  if (c === '') return null
  if (!/^[A-Z]{1,4}$/.test(c)) {
    return 'Las incidencias nombran sus salas con el código detrás —«1.7 H»—, y ahí solo se reconoce un sufijo de una a cuatro letras. Con este código, las importaciones de ese edificio irán a cuarentena.'
  }
  return null
}
