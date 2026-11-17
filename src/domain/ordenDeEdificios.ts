/**
 * El orden de los edificios en cualquier lista: alfabético, por su código.
 *
 * Cada lista tenía el suyo. Las que salen del espejo iban por `sort_order`, que
 * es el orden en que el Excel traía los edificios el día de la importación —P,
 * O, M, E, C, H…—: un orden que nadie eligió y que solo se aprende de memoria.
 * Las que preguntan al servidor (la papelera, los edificios sin identificar) ya
 * iban por código. O sea que el mismo desplegable de edificios salía en dos
 * órdenes según la pantalla, y en ninguno de los dos se encontraba la «H» sin
 * leer la lista entera.
 *
 * Por el CÓDIGO y no por el nombre, porque el código es lo que se lee primero
 * en todas partes —la placa de la tarjeta, «H — EDIFICIO H» en un desplegable—
 * y es como se nombra un aula en voz alta: «la 1.7 del H». Por nombre, «C —
 * EDIFICIO CENTRAL» caería detrás de «COM — COMUNICACIÓN», y un desplegable que
 * empieza por el código parecería desordenado.
 *
 * Con `numeric`, para que un hipotético «M2» vaya antes que «M10»; sin
 * distinguir mayúsculas ni tildes; y con el nombre de desempate, para que dos
 * edificios con el mismo código —no debería haberlos— no bailen entre cargas.
 */

interface ConCodigo {
  code: string
  name?: string | null
}

const comparar = new Intl.Collator('es', { numeric: true, sensitivity: 'base' }).compare

export function porCodigoDeEdificio(a: ConCodigo, b: ConCodigo): number {
  return comparar(a.code, b.code) || comparar(a.name ?? '', b.name ?? '')
}

/** Una copia ordenada: no toca la lista que recibe. */
export function ordenarEdificios<T extends ConCodigo>(edificios: readonly T[]): T[] {
  return [...edificios].sort(porCodigoDeEdificio)
}
