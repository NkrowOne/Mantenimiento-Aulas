/**
 * La fusión a tres bandas: decidir, celda a celda, quién manda.
 *
 * Esto es la fase 2 de la sincronización. La fase 1 (`cruce.ts`) contesta «¿de
 * qué sala habla esta fila?»; ésta contesta la siguiente, que es la que hace
 * que la bidireccionalidad no destroce nada: **¿este valor lo cambió el Excel,
 * lo cambió la app, o no lo ha tocado nadie?**
 *
 * Sin responderla no hay más política posible que «gana el último», que es otra
 * manera de decir que se pierden ediciones y nadie sabe cuáles. Se responde con
 * la misma idea que usa git para juntar dos ramas: guardar, después de cada
 * pasada correcta, el valor exacto de cada celda sincronizada. Esa instantánea
 * —`sync_celdas.valor_base`— es el antepasado común, y con tres valores en vez
 * de dos la decisión deja de ser una apuesta:
 *
 *   base = antepasado, excel = antepasado  → nada, que es la inmensa mayoría
 *   base ≠ antepasado, excel = antepasado  → manda la app   → se escribe el Excel
 *   base = antepasado, excel ≠ antepasado  → manda el Excel → se escribe la base
 *   los dos ≠ antepasado, y a cosas distintas → conflicto: no se toca ninguno
 *   los dos ≠ antepasado, a lo mismo       → ya coinciden
 *
 * Ahí está la respuesta a «a veces es más cómodo editarlo en el Excel»: si nadie
 * lo tocó en la app, lo que escribas en la hoja gana y entra en la base.
 *
 * Con dos matices que no salen de la teoría sino de estos dos libros:
 *
 *  - **No todas las celdas admiten las dos direcciones.** Los m² vienen de
 *    Patrimonio y la app no los edita; quién revisó un aula no cabe en una
 *    celda; el stock disponible es una fórmula. Por eso cada columna lleva
 *    dueño, y el dueño se decide antes de mirar los valores.
 *  - **La primera pasada no tiene antepasado.** Y no puede mandar 276 aulas a
 *    cuarentena por eso. Se siembra: manda quien sea dueño, y donde solo un lado
 *    tiene dato gana el que lo tiene. Nada se pierde —la base no se toca salvo
 *    en lo que es del Excel, y el libro está versionado en SharePoint— y a
 *    partir de la segunda pasada ya hay antepasado y la regla es la de arriba.
 *
 * Nada de esto escribe: devuelve decisiones. Quien las aplica es el
 * sincronizador, en una transacción y con `source = 'sharepoint'`.
 */

import { norm } from './normalize'

// -----------------------------------------------------------------------------
// Quién puede editar qué
// -----------------------------------------------------------------------------

/**
 * El dueño de una columna. Se decide una vez, por columna, y no depende de los
 * valores: es una propiedad del dato, no de la pasada.
 *
 *  - `ambos`      — fusión a tres bandas completa. El caso normal: número de
 *                   serie, marca, modelo, nombre de la sala, compras.
 *  - `solo_excel` — m², capacidad, código oficial de espacio. Vienen de
 *                   Espacios; la app los muestra e imprime pero no los edita,
 *                   así que un cambio en la base solo puede ser un error.
 *  - `solo_app`   — quién revisó, los checks, las fotos, las incidencias. Una
 *                   celda de texto no puede representar una revisión con su
 *                   autor: no es una restricción que se elija.
 *  - `medida`     — horas de proyector, % de lámpara. Son lecturas fechadas: si
 *                   las dos cambian no gana quien escribió último, gana la
 *                   medición más reciente.
 *  - `formula`    — stock disponible (`=Comprado − Instalado`). No se escribe
 *                   nunca: escribir un número encima se lleva la fórmula por
 *                   delante. Si los dos números discrepan, eso es un descuadre.
 */
export type Dueno = 'ambos' | 'solo_excel' | 'solo_app' | 'medida' | 'formula'

/** Lo que cabe en una celda una vez leída. */
export type Valor = string | number | boolean | null

/**
 * De qué es la columna, para comparar como toca.
 *
 * Solo hace falta distinguir `texto` del resto: es donde un valor que parece un
 * número no lo es —el código de un aula, un número de serie— y normalizarlo
 * junta dos cosas distintas. Se escribe con el mismo vocabulario que `Tipo` en
 * `mapa.ts`, y a propósito sin importarlo: `fusion.ts` no sabe del mapa.
 */
export type TipoDeCelda = 'texto' | 'numero' | 'fecha' | 'porcentaje' | 'si_no' | 'formula'

export interface Celda {
  base: Valor
  excel: Valor
  /** De qué es la columna. Sin él se compara como hasta ahora. */
  tipo?: TipoDeCelda
  /**
   * El valor de la última pasada correcta (`sync_celdas.valor_base`).
   * `undefined` —no `null`— cuando la celda nunca se ha sincronizado: `null` es
   * un antepasado legítimo que significa «entonces estaba vacía».
   */
  antepasado?: Valor
  dueno: Dueno
  /** Solo para `dueno: 'medida'`: cuándo se tomó cada lectura. */
  medidaBase?: string | null
  medidaExcel?: string | null
}

// -----------------------------------------------------------------------------
// Lo que se decide
// -----------------------------------------------------------------------------

export type Decision =
  /** Nadie la tocó. La inmensa mayoría de las celdas de cada pasada. */
  | { tipo: 'sin_cambios' }
  /** Los dos la cambiaron, pero a lo mismo. No hay nada que escribir. */
  | { tipo: 'ya_coinciden' }
  /** Gana el Excel: se escribe en la base, anotándolo en `import_fixes`. */
  | { tipo: 'hacia_la_base'; valor: Valor; motivo: string }
  /** Gana la app: se escribe la celda con las reglas de escritura del libro. */
  | { tipo: 'hacia_el_excel'; valor: Valor; motivo: string }
  /** Los dos lados cambiaron a cosas distintas: no se toca ninguno. */
  | {
      tipo: 'conflicto'
      motivo: string
      base: Valor
      excel: Valor
      antepasado: Valor | undefined
    }
  /** Celda de fórmula cuyo número no cuadra con la base. Ni se escribe ni se lee. */
  | { tipo: 'descuadre'; base: Valor; excel: Valor }

// -----------------------------------------------------------------------------
// Comparar dos celdas sin que la forma de teclear decida
// -----------------------------------------------------------------------------

/**
 * La forma canónica de un valor, para comparar.
 *
 * Un `12` de la base y un `'12 '` tecleado en la hoja son el mismo dato, y
 * tratarlos como distintos convierte cada pasada en cientos de escrituras
 * inútiles —y, peor, en conflictos inventados que mandan a cuarentena filas que
 * nadie tocó. Vacío es vacío: `null`, `''` y `'  '` son la misma cosa.
 */
export function canonizar(v: Valor, tipo?: TipoDeCelda): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'SI' : 'NO'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  const t = norm(v)
  if (t === '') return ''
  // `12,50` en la hoja y `12.5` en la base son la misma medición: `norm` ya pasó
  // la coma a punto, y aquí se van los ceros de cola. Hace falta porque el
  // antepasado va y vuelve por una columna `text`: el `12.5` de la base sale de
  // ahí como `'12.5'`, y sin esto no coincidirían nunca.
  //
  // Pero **solo donde el valor es un número**. En una columna de texto esto no
  // normaliza: destruye. El aula `1.10` se convertía en `1.1`, que en este libro
  // es **otra aula del mismo edificio** —siete pares así: 0.1/0.10 en el CRAI,
  // 1.1/1.10 en E, H, O y el CRAI, 2.1/2.10 en M y O—, así que las dos filas se
  // daban por la misma y un renombrado entre ellas pasaba desapercibido.
  //
  // Ya se había visto la mitad del problema por delante —`0012` y `12` son dos
  // números de serie distintos y por eso hay guarda de ceros a la izquierda— y
  // los de la derecha hacen exactamente lo mismo por el otro lado.
  if (tipo === 'texto') return t
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(t)) return String(Number(t))
  return t
}

/** `true` si los dos valores dicen lo mismo. */
export function iguales(a: Valor, b: Valor, tipo?: TipoDeCelda): boolean {
  return canonizar(a, tipo) === canonizar(b, tipo)
}

function vacio(v: Valor): boolean {
  return canonizar(v) === ''
}

function cuando(fecha: string | null | undefined): number | null {
  if (!fecha) return null
  const t = Date.parse(fecha)
  return Number.isNaN(t) ? null : t
}

// -----------------------------------------------------------------------------
// La decisión
// -----------------------------------------------------------------------------

/**
 * Decide qué hacer con una celda. No escribe: devuelve la decisión.
 */
export function fusionarCelda(c: Celda): Decision {
  // Una fórmula no se toca jamás, ni aunque el número discrepe: el valor de esa
  // celda no es un dato, es el resultado de una resta que la hoja sabe hacer.
  // Escribir el número encima se lleva la fórmula, y a partir de ahí la columna
  // miente en silencio para siempre.
  if (c.dueno === 'formula') {
    // Y si la aplicación no trae valor para la fórmula —que es lo normal: el
    // total y el disponible los calcula la hoja, no la base— no hay nada que
    // comparar. Sin esto salían 86 «descuadres» por pasada, uno por cada
    // fórmula de la bolsa, con «la base null» en el texto: ruido que tapa el
    // descuadre de verdad cuando lo hay.
    if (vacio(c.base)) return { tipo: 'sin_cambios' }
    return iguales(c.base, c.excel, c.tipo)
      ? { tipo: 'sin_cambios' }
      : { tipo: 'descuadre', base: c.base, excel: c.excel }
  }

  if (iguales(c.base, c.excel, c.tipo)) {
    // Coinciden. Si además coinciden con el antepasado no ha pasado nada; si no,
    // es que los dos se movieron a lo mismo, que tampoco da trabajo.
    const seMovieron = c.antepasado !== undefined && !iguales(c.base, c.antepasado, c.tipo)
    return seMovieron ? { tipo: 'ya_coinciden' } : { tipo: 'sin_cambios' }
  }

  // A partir de aquí los dos lados dicen cosas distintas.

  // Un lado vacío y el otro con dato no es un desacuerdo: es un hueco. Gana
  // quien tiene el dato —nunca el vacío—, y eso es lo que mete en la base los
  // 190 números de serie del libro de revisión que nunca entraron, y lo que
  // impide que la app borre una celda del Excel escribiendo un `null` encima
  // —que además se llevaría el formato por delante.
  //
  // Pero rellenar un hueco **hacia la base** es escribir en la base, y hay
  // columnas donde eso no se puede hacer aunque la base esté vacía. Que la regla
  // del hueco se mirara antes que el dueño no era un detalle: sobre este libro
  // son 42 celdas mandando a la base, cada pasada, lo mismo que la anterior.
  if (vacio(c.base) !== vacio(c.excel)) {
    if (!vacio(c.base)) {
      return { tipo: 'hacia_el_excel', valor: c.base, motivo: 'la celda estaba vacía' }
    }

    // La penúltima fecha de revisión de un aula, o el consumo de marzo. La base
    // no los tiene porque **no puede** tenerlos escritos a mano: son el segundo
    // elemento de un historial y la suma de unos movimientos. Mandarlos a la
    // base los rechaza —22 aulas de este libro, en cada pasada, para siempre— y
    // vaciar la celda perdería la única fecha que hay de esas revisiones. Así
    // que se quedan como están, que es la respuesta honesta.
    if (c.dueno === 'solo_app') {
      return { tipo: 'sin_cambios' }
    }

    // Y en una columna que la app no edita, si ya se mandó una vez y la base
    // sigue vacía, es que la base no lo guarda donde el volcado pueda
    // devolverlo: el nombre alternativo de un artículo entra como alias y no
    // vuelve. Mandarlo otra vez no lo guarda mejor; solo apunta una corrección
    // más en `import_fixes`, veinte por pasada, hasta el fin de los tiempos.
    //
    // La guarda es solo para `solo_excel` a propósito. En una columna de las dos
    // —un número de serie— que la base se haya quedado vacía sin que el Excel se
    // moviera significa que alguien lo borró **en la app**, y eso no es lo mismo
    // ni se decide aquí.
    if (c.dueno === 'solo_excel' && c.antepasado !== undefined && iguales(c.excel, c.antepasado, c.tipo)) {
      return { tipo: 'sin_cambios' }
    }

    return { tipo: 'hacia_la_base', valor: c.excel, motivo: 'la base no tenía este dato' }
  }

  // Columnas con un solo dueño: la dirección no se discute ni se mira el
  // antepasado. Si alguien escribió en la columna del otro, la pasada siguiente
  // lo devuelve a su sitio y lo deja dicho en la hoja `Sincronización`.
  if (c.dueno === 'solo_excel') {
    return {
      tipo: 'hacia_la_base',
      valor: c.excel,
      motivo: 'columna de Espacios: la app no la edita',
    }
  }
  if (c.dueno === 'solo_app') {
    return {
      tipo: 'hacia_el_excel',
      valor: c.base,
      motivo: 'columna de la app: una celda no puede representar esto',
    }
  }

  // Medidas fechadas: gana la lectura más reciente, no el último en escribir.
  // Un técnico que apunta 4.200 horas hoy no debe perder contra un 3.900 que
  // alguien tecleó en la hoja la semana pasada solo por el orden de las pasadas.
  if (c.dueno === 'medida') {
    const tb = cuando(c.medidaBase)
    const te = cuando(c.medidaExcel)
    if (tb !== null && te !== null && tb !== te) {
      return tb > te
        ? { tipo: 'hacia_el_excel', valor: c.base, motivo: 'medición más reciente' }
        : { tipo: 'hacia_la_base', valor: c.excel, motivo: 'medición más reciente' }
    }
    // Sin fechas que comparar, una medida es una celda más y sigue por abajo.
  }

  // Primera pasada: no hay antepasado, así que no se puede saber quién cambió.
  // Manda la app, que es la política por defecto, y queda anotado. Mandar todo a
  // cuarentena aquí sería paralizar la primera sincronización entera por no
  // tener una información que solo puede existir a partir de la segunda.
  if (c.antepasado === undefined) {
    return {
      tipo: 'hacia_el_excel',
      valor: c.base,
      motivo: 'primera pasada: sin instantánea previa manda la app',
    }
  }

  const baseCambio = !iguales(c.base, c.antepasado, c.tipo)
  const excelCambio = !iguales(c.excel, c.antepasado, c.tipo)

  if (baseCambio && !excelCambio) {
    return { tipo: 'hacia_el_excel', valor: c.base, motivo: 'solo cambió en la app' }
  }
  if (excelCambio && !baseCambio) {
    return { tipo: 'hacia_la_base', valor: c.excel, motivo: 'solo cambió en el Excel' }
  }

  // Los dos cambiaron a cosas distintas. Nadie pierde su trabajo: se paran los
  // dos lados y decide una persona desde la bandeja de administración.
  return {
    tipo: 'conflicto',
    motivo: 'los dos lados cambiaron desde la última sincronización',
    base: c.base,
    excel: c.excel,
    antepasado: c.antepasado,
  }
}

// -----------------------------------------------------------------------------
// La fila, antes que la celda
// -----------------------------------------------------------------------------

export interface Fila {
  /** `SALA-000087`. Vacío o ausente = fila añadida a mano en el Excel. */
  ref?: string | null
  /** `false` si la fila que había en la pasada anterior ya no está en el libro. */
  presenteEnElExcel?: boolean
  /** `false` si la entidad ya no está en la base (archivada, fusionada). */
  presenteEnLaBase?: boolean
}

export type DecisionDeFila =
  /** Fila de siempre: se fusiona celda a celda. */
  | { tipo: 'fusionar' }
  /** Fila sin `Ref`: un alta hecha desde el Excel. Se crea y se le devuelve su matrícula. */
  | { tipo: 'alta_desde_el_excel' }
  /** Estaba en la pasada anterior y hoy no está. **Nunca se borra**: se archiva y se avisa. */
  | { tipo: 'desaparecida_del_excel'; motivo: string }
  /** Está en el Excel con una `Ref` que la base no reconoce. Cuarentena. */
  | { tipo: 'ref_desconocida'; motivo: string }

export function decidirFila(f: Fila): DecisionDeFila {
  const ref = (f.ref ?? '').trim()

  if (ref === '') {
    // Sin la columna `Ref` un aula nueva es indistinguible de una renombrada, y
    // se duplica. Con ella, esto es exactamente lo que hace falta saber.
    return { tipo: 'alta_desde_el_excel' }
  }

  if (f.presenteEnElExcel === false) {
    // Que un aula desaparezca del Excel significa que alguien la borró de una
    // hoja, no que el aula haya dejado de existir. Nunca `delete`.
    return {
      tipo: 'desaparecida_del_excel',
      motivo: 'la fila ya no está en el libro: se archiva, no se borra',
    }
  }

  if (f.presenteEnLaBase === false) {
    return {
      tipo: 'ref_desconocida',
      motivo: `la matrícula ${ref} no existe en la base`,
    }
  }

  return { tipo: 'fusionar' }
}

// -----------------------------------------------------------------------------
// Idempotencia: la misma pasada dos veces no produce dos altas
// -----------------------------------------------------------------------------

/**
 * La forma canónica de una fila entera, para hashear y comparar entre pasadas.
 *
 * Las claves van ordenadas y los valores canonizados a propósito: sin eso, el
 * mismo libro leído dos veces produce dos hashes distintos —el orden de las
 * columnas de un `.xlsx` no está garantizado— y la idempotencia por hash, que
 * es lo que impide que reprocesar un fichero duplique 276 aulas, no serviría
 * para nada. Quien llame a esto le pasa el resultado a sha256.
 */
export function canonizarFila(fila: Record<string, Valor>): string {
  return Object.entries(fila)
    .map(([columna, valor]) => `${norm(columna)}=${canonizar(valor)}`)
    .sort()
    .join('\n')
}

// -----------------------------------------------------------------------------
// El parte de la pasada
// -----------------------------------------------------------------------------

export interface Parte {
  total: number
  sinCambios: number
  yaCoinciden: number
  haciaLaBase: number
  haciaElExcel: number
  conflictos: number
  descuadres: number
}

/**
 * Cuenta las decisiones de una pasada. Una sincronización que no deja parte es
 * una en la que nadie confía a los tres meses.
 */
export function resumir(decisiones: Decision[]): Parte {
  const p: Parte = {
    total: decisiones.length,
    sinCambios: 0,
    yaCoinciden: 0,
    haciaLaBase: 0,
    haciaElExcel: 0,
    conflictos: 0,
    descuadres: 0,
  }
  for (const d of decisiones) {
    if (d.tipo === 'sin_cambios') p.sinCambios++
    else if (d.tipo === 'ya_coinciden') p.yaCoinciden++
    else if (d.tipo === 'hacia_la_base') p.haciaLaBase++
    else if (d.tipo === 'hacia_el_excel') p.haciaElExcel++
    else if (d.tipo === 'conflicto') p.conflictos++
    else p.descuadres++
  }
  return p
}
