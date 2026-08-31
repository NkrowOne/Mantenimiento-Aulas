/**
 * Cruzar una fila de Excel con la sala que le corresponde en el maestro de hoy.
 *
 * Esto es la fase 1 de la sincronización: antes de escribir nada, hace falta
 * saber cuántas filas de los dos libros encuentran su sala y cuántas no. Si el
 * cruce fallara, todo lo demás sobra.
 *
 * El problema no es la comparación de cadenas, es que **el maestro ya no es el
 * Excel del que salió**. Desde la importación se han renombrado edificios y
 * salas, se han fusionado duplicados y algunas cosas se han archivado en la
 * papelera. Un cruce que compare contra los nombres de hoy pierde justo las
 * filas que alguien tocó, que son las interesantes. Por eso resuelve contra
 * cuatro cosas a la vez:
 *
 *  1. La **matrícula** (`SALA-000087`), si el libro ya la lleva. Es la única que
 *     no cambia nunca — ni al renombrar, ni al mover de planta, ni al fusionar.
 *  2. Los **alias**, que es donde han ido quedando las referencias viejas:
 *     `rename_building` y `rename_room` insertan en `room_aliases` la clave
 *     anterior (`1.7 H`) precisamente para que esto siga cruzando.
 *  3. El **maestro actual**, edificio + código de sala.
 *  4. El **histórico de la auditoría** para los edificios que ya no existen.
 *     `merge_building` mueve las zonas y borra el edificio de origen **sin
 *     dejar ningún alias**: es el único cambio de nomenclatura que no se
 *     autodocumenta, y sin `audit_log` una fila que diga `EDIFICIO CRAI` se
 *     quedaría sin explicación. Con él, al menos se sabe por qué no cruza.
 *
 * Nada de esto escribe. Devuelve por qué cada fila cruza o no cruza, que es lo
 * que hay que mirar antes de decidir si la sincronización es viable.
 */

import {
  cleanRoomRef,
  norm,
  splitIncidentKey,
  stripParenthetical,
  BUILDING_TYPOS,
  OLD_BUILDING_CODES,
} from './normalize'

// -----------------------------------------------------------------------------
// Lo que hace falta saber del maestro
// -----------------------------------------------------------------------------

export interface SalaConocida {
  id: string
  /** `SALA-000087`. La única referencia estable. */
  shortRef: string
  /** El código de la puerta, tal cual: `0.1P`, `-1.3`, `Aula 6`. */
  code: string
  name: string
  /** `false` = archivada en la papelera. Cruza igual, pero se avisa. */
  active: boolean
  zona: string
  edificioCodigo: string
  edificioNombre: string
  edificioActivo: boolean
  /** Alias tal y como están en `room_aliases.alias_norm`, ya normalizados. */
  alias: string[]
}

/**
 * Un edificio que existió y hoy no está: renombrado con otro código, borrado o
 * absorbido por una fusión. Sale de `audit_log`, que sí guarda `buildings`.
 */
export interface EdificioDesaparecido {
  codigo: string
  nombre: string
  /** `borrado` o `fusionado`: la auditoría no distingue, pero el motivo ayuda. */
  motivo: string
}

export interface EdificioConocido {
  codigo: string
  nombre: string
  activo: boolean
  /** `buildings.needs_review`: lo creó el importador sin saber qué era. */
  sinIdentificar?: boolean
}

export interface Catalogo {
  /**
   * Los edificios del maestro. Hace falta aparte de las salas porque **hay
   * edificios sin ninguna sala**: el importador creó `S`, `G`, `TM`, `BC`, `CC`
   * y `CEFF` como «Edificio X (sin identificar)» al ver esas referencias en los
   * partes, y la hoja de estado —la única que define salas— no lista ninguna
   * dentro de ellos. Un catálogo construido solo desde las salas los pierde, y
   * entonces el cruce dice «ese edificio no está en el maestro», que es falso y
   * manda a buscar en el sitio equivocado.
   */
  edificios?: EdificioConocido[]
  /**
   * Equivalencias de nomenclatura vieja para este catálogo. Por defecto las
   * declaradas en `OLD_BUILDING_CODES`; se puede pasar otra cosa para probar.
   */
  equivalencias?: Record<string, string>
  /**
   * Nombres que un edificio **de hoy** tuvo antes, reconstruidos desde la
   * auditoría. No es lo mismo que `equivalencias`: ahí el que cambió fue el
   * *código*, y aquí el edificio es el mismo, con el mismo código, y lo único
   * que cambió fue cómo se llama.
   *
   * Hace falta porque el libro lleva el nombre con el que se escribió. Si en la
   * aplicación se renombra «EDIFICIO CENTRAL» a «ED. CENTRAL», el maestro deja
   * de conocer el nombre viejo y las filas del libro —que siguen diciendo
   * «EDIFICIO CENTRAL»— dejan de cruzar de golpe, todas a la vez, sin que nadie
   * haya tocado ni el libro ni las salas.
   */
  nombresViejos?: Array<{ codigo: string; nombre: string }>
  salas: SalaConocida[]
  edificiosDesaparecidos?: EdificioDesaparecido[]
}

// -----------------------------------------------------------------------------
// Lo que se quiere cruzar
// -----------------------------------------------------------------------------

export type ReferenciaDeSala =
  /** Hoja «Estado Aulas»: edificio y planta arrastrados, más el código de aula. */
  | { tipo: 'estado'; edificio: string; zona?: string; aula: string }
  /** Hoja «Aulas Identificadas»: el edificio viene por su código (`Edificio C`). */
  | { tipo: 'revision'; edificio: string; nombreAula: string; codigoOficial?: string }
  /** Partes de material: `0.1 BC`, `Sotano -1.5 BC`, `Aula 6 CD`. */
  | { tipo: 'parte'; ref: string }
  /** La columna `Ref` que la sincronización escribirá en el libro. */
  | { tipo: 'matricula'; ref: string }

export type ViaDeCruce =
  /** Traducido por una equivalencia declarada en `OLD_BUILDING_CODES`. */
  | 'nomenclatura-vieja'
  | 'matricula'
  | 'alias'
  | 'edificio+codigo'
  | 'edificio+nombre'
  | 'codigo-unico-en-el-maestro'

export type Resolucion =
  | { estado: 'resuelta'; sala: SalaConocida; via: ViaDeCruce; aviso?: string }
  | { estado: 'ambigua'; candidatas: SalaConocida[]; motivo: string }
  | { estado: 'sin_cruce'; motivo: string }

// -----------------------------------------------------------------------------
// El índice
// -----------------------------------------------------------------------------

export interface Indice {
  porMatricula: Map<string, SalaConocida>
  porAlias: Map<string, SalaConocida>
  /** `H|1.7` → sala. La clave que usó el importador. */
  porEdificioYCodigo: Map<string, SalaConocida>
  /** Código de sala normalizado → todas las salas que lo llevan, en cualquier edificio. */
  porCodigoSuelto: Map<string, SalaConocida[]>
  /** Nombre normalizado de edificio → código. Incluye erratas conocidas. */
  edificioPorNombre: Map<string, string>
  /** Código de edificio → sigue vivo. */
  edificioVivo: Map<string, boolean>
  /** Código de edificio → no tiene ninguna sala en el maestro. */
  edificioVacio: Map<string, EdificioConocido>
  /** Código viejo declarado → código del edificio de hoy. */
  equivalencias: Map<string, string>
  /** Nombre anterior de un edificio que sigue vivo → su código de hoy. */
  nombreAnterior: Map<string, string>
  desaparecidos: Map<string, EdificioDesaparecido>
}

/**
 * Quita la letra del edificio pegada al código: en el EDIFICIO P las salas se
 * llaman `0.1P` y los partes escriben `0.1 P`. El importador ya lo hace al
 * generar alias; aquí hace falta otra vez para cruzar en el sentido contrario.
 */
function sinSufijoDeEdificio(codeNorm: string, edificioCodigo: string): string {
  if (!edificioCodigo || !codeNorm.endsWith(edificioCodigo)) return ''
  return codeNorm.slice(0, -edificioCodigo.length).trim()
}

/**
 * Todas las formas en que un mismo código puede aparecer escrito.
 *
 * Las tres reglas **se componen**, y esa es la parte que importa: `AULA -2.1 -
 * LAB. DE LA SALUD` necesita las tres seguidas —quitar la palabra `AULA`,
 * quitar la descripción de después del guion y quedarse con `-2.1`— y
 * aplicándolas por separado no sale ninguna que valga.
 *
 * El guion que separa la descripción lleva espacios a los lados: `AULA 0.7 -
 * HISTOLOGÍA` se parte, y `-1.1` no, que es justo lo que hace falta para no
 * destrozar los sótanos.
 */
export function formasDeEscribir(texto: string, edificioCodigo = ''): string[] {
  const out = new Set<string>()

  const añadir = (v: string): void => {
    const n = norm(v)
    if (!n) return
    out.add(n)
    const desnudo = sinSufijoDeEdificio(n, edificioCodigo)
    if (desnudo) out.add(desnudo)
  }

  let base = norm(texto)
  añadir(base)

  // `AULA 1.2` del libro de revisión es la sala `1.2` del maestro.
  base = base.replace(/^(AULA|SALA)\s+/, '')
  añadir(base)

  // `5.4 (Lab 3D)` en la hoja de estado es `5.4` en todas partes.
  base = norm(stripParenthetical(base))
  añadir(base)

  // `0.7 - HISTOLOGÍA`: el nombre descriptivo va detrás del guion.
  const guion = base.split(/\s+-\s+/)[0]
  if (guion) añadir(guion)

  out.delete('')
  return [...out]
}

function variantesDeCodigo(sala: SalaConocida): string[] {
  return formasDeEscribir(sala.code, sala.edificioCodigo)
}

export function construirIndice(catalogo: Catalogo): Indice {
  const ix: Indice = {
    porMatricula: new Map(),
    porAlias: new Map(),
    porEdificioYCodigo: new Map(),
    porCodigoSuelto: new Map(),
    edificioPorNombre: new Map(),
    edificioVivo: new Map(),
    edificioVacio: new Map(),
    equivalencias: new Map(),
    nombreAnterior: new Map(),
    desaparecidos: new Map(),
  }

  // Primero los edificios, salas o no: un edificio vacío existe igual.
  for (const e of catalogo.edificios ?? []) {
    const codigo = norm(e.codigo)
    if (!codigo) continue
    ix.edificioVivo.set(codigo, e.activo)
    ix.edificioPorNombre.set(codigo, codigo)
    ix.edificioPorNombre.set(norm(e.nombre), codigo)
    ix.edificioPorNombre.set(norm(`EDIFICIO ${codigo}`), codigo)
    ix.edificioVacio.set(codigo, e)
  }

  for (const sala of catalogo.salas) {
    ix.porMatricula.set(norm(sala.shortRef), sala)
    // Tiene salas: ya no está vacío.
    ix.edificioVacio.delete(norm(sala.edificioCodigo))
    for (const a of sala.alias) ix.porAlias.set(norm(a), sala)

    for (const v of variantesDeCodigo(sala)) {
      const clave = `${sala.edificioCodigo}|${v}`
      // El primero gana: dos salas con el mismo código en el mismo edificio ya
      // son un problema del maestro, no del cruce, y el importador las manda a
      // cuarentena. Aquí basta con no perder la primera.
      if (!ix.porEdificioYCodigo.has(clave)) ix.porEdificioYCodigo.set(clave, sala)

      const lista = ix.porCodigoSuelto.get(v)
      if (lista) lista.push(sala)
      else ix.porCodigoSuelto.set(v, [sala])
    }

    ix.edificioPorNombre.set(norm(sala.edificioNombre), sala.edificioCodigo)
    ix.edificioPorNombre.set(norm(sala.edificioCodigo), sala.edificioCodigo)
    // «Edificio C» del libro de revisión contra «EDIFICIO CENTRAL» del maestro.
    ix.edificioPorNombre.set(norm(`EDIFICIO ${sala.edificioCodigo}`), sala.edificioCodigo)
    ix.edificioVivo.set(sala.edificioCodigo, sala.edificioActivo)
  }

  // Las erratas conocidas del Excel apuntan al nombre bueno, no a un edificio
  // nuevo. `EDIFICO E` es `EDIFICIO E` y siempre lo fue.
  for (const [errata, bueno] of Object.entries(BUILDING_TYPOS)) {
    const codigo = ix.edificioPorNombre.get(norm(bueno))
    if (codigo) ix.edificioPorNombre.set(norm(errata), codigo)
  }

  // Las equivalencias declaradas de nomenclatura vieja. Solo se registran las
  // que apuntan a un edificio que existe: una línea con un destino que ya no
  // está es una errata, y traducir hacia la nada es peor que no traducir.
  for (const [viejo, actual] of Object.entries(catalogo.equivalencias ?? OLD_BUILDING_CODES)) {
    const codigo = norm(actual)
    if (!ix.edificioVivo.has(codigo)) continue
    // Las dos formas, porque las hojas escriben tanto `1.4 S` como `EDIFICIO S`
    // y las dos tienen que quedar marcadas como traducción y no como cruce.
    for (const forma of [norm(viejo), norm(`EDIFICIO ${viejo}`)]) {
      ix.equivalencias.set(forma, codigo)
      ix.edificioPorNombre.set(forma, codigo)
    }
  }

  for (const e of catalogo.edificiosDesaparecidos ?? []) {
    ix.desaparecidos.set(norm(e.nombre), e)
    ix.desaparecidos.set(norm(e.codigo), e)
    ix.desaparecidos.set(norm(`EDIFICIO ${e.codigo}`), e)
  }

  // Los nombres anteriores, los últimos de todos y a propósito: son el recurso
  // más débil del índice y no pueden pisar a ninguno de los otros.
  //
  //  - Si el nombre viejo es hoy el nombre —o el código— de otro edificio, se
  //    deja como está: el maestro de hoy manda sobre lo que hubo.
  //  - Si es el nombre de un edificio que desapareció, tampoco: eso era otro
  //    edificio, y mandar sus filas al que se quedó con el nombre sería
  //    inventarse una fusión que nadie hizo.
  for (const { codigo, nombre } of catalogo.nombresViejos ?? []) {
    const c = norm(codigo)
    const n = norm(nombre)
    if (!c || !n || !ix.edificioVivo.has(c)) continue
    if (ix.edificioPorNombre.has(n) || ix.desaparecidos.has(n)) continue
    ix.edificioPorNombre.set(n, c)
    ix.nombreAnterior.set(n, c)
  }

  return ix
}

// -----------------------------------------------------------------------------
// La resolución
// -----------------------------------------------------------------------------

function conAviso(sala: SalaConocida, via: ViaDeCruce, extra?: string): Resolucion {
  const avisos: string[] = []
  if (!sala.edificioActivo) avisos.push('el edificio está en la papelera')
  if (!sala.active) avisos.push('la sala está archivada')
  if (extra) avisos.unshift(extra)
  return { estado: 'resuelta', sala, via, aviso: avisos.length ? avisos.join('; ') : undefined }
}

/**
 * Busca una sala por su código en todo el maestro, sin edificio.
 *
 * Es el último recurso y solo vale si el código es único: `1.4` existe en medio
 * campus, pero `0.1P` o `AULA -1.1` no. Se usa cuando el edificio de la fila ya
 * no existe —lo típico tras una fusión—, que es justo el caso en que la fila
 * es correcta y el maestro ha cambiado debajo.
 */
function porCodigoEnTodoElMaestro(ix: Indice, codigo: string, contexto: string): Resolucion {
  let candidatas: SalaConocida[] = []
  for (const forma of formasDeEscribir(codigo)) {
    candidatas = ix.porCodigoSuelto.get(forma) ?? []
    if (candidatas.length) break
  }
  if (candidatas.length === 1) {
    return conAviso(candidatas[0]!, 'codigo-unico-en-el-maestro', contexto)
  }
  if (candidatas.length > 1) {
    return {
      estado: 'ambigua',
      candidatas,
      motivo: `${contexto}, y el código «${codigo}» existe en ${candidatas.length} edificios`,
    }
  }
  return { estado: 'sin_cruce', motivo: `${contexto}, y no hay ninguna sala con el código «${codigo}»` }
}

/** Resuelve el edificio de una fila: nombre actual, errata, código o desaparecido. */
function resolverEdificio(
  ix: Indice,
  bruto: string,
): { codigo: string } | { desaparecido: EdificioDesaparecido } | null {
  const n = norm(bruto)
  if (!n) return null

  const directo = ix.edificioPorNombre.get(n)
  if (directo) return { codigo: directo }

  const muerto = ix.desaparecidos.get(n)
  if (muerto) return { desaparecido: muerto }

  return null
}

export function resolverSala(ix: Indice, ref: ReferenciaDeSala): Resolucion {
  // 1 — La matrícula. Si está, no hay nada más que mirar.
  if (ref.tipo === 'matricula') {
    const sala = ix.porMatricula.get(norm(ref.ref))
    return sala
      ? conAviso(sala, 'matricula')
      : { estado: 'sin_cruce', motivo: `la matrícula «${ref.ref}» no existe en el maestro` }
  }

  // 2 — Un parte (`1.7 H`): alias primero, que es donde viven los renombrados.
  if (ref.tipo === 'parte') {
    const limpio = cleanRoomRef(ref.ref)
    const porAlias = ix.porAlias.get(limpio)
    if (porAlias) return conAviso(porAlias, 'alias')

    const partes = splitIncidentKey(ref.ref)
    if (!partes) {
      return { estado: 'sin_cruce', motivo: `«${ref.ref}» no tiene la forma «sala EDIFICIO»` }
    }
    const sala = ix.porEdificioYCodigo.get(`${partes.buildingCode}|${norm(partes.roomCode)}`)
    if (sala) return conAviso(sala, 'edificio+codigo')

    // El código de edificio puede ser de los de antes. Si hay equivalencia
    // declarada se traduce, y se dice: haber cruzado por una tabla escrita a
    // mano no es lo mismo que haber cruzado por el maestro de hoy.
    const actual = ix.equivalencias.get(norm(partes.buildingCode))
    if (actual) {
      for (const c of formasDeEscribir(partes.roomCode, actual)) {
        const traducida = ix.porEdificioYCodigo.get(`${actual}|${c}`)
        if (traducida) {
          return conAviso(
            traducida,
            'nomenclatura-vieja',
            `«${partes.buildingCode}» es nomenclatura vieja de «${traducida.edificioNombre}»`,
          )
        }
      }
    }

    const vacio = ix.edificioVacio.get(norm(partes.buildingCode))
    if (vacio) {
      // Un edificio «sin identificar» y sin una sola sala no es donde está el
      // aula: es el hueco que el importador abrió al ver esta misma referencia
      // y no saber a qué edificio llevarla. Así que se busca el código por todo
      // el maestro, igual que con un edificio desaparecido — que es lo que en la
      // práctica es.
      if (vacio.sinIdentificar) {
        return porCodigoEnTodoElMaestro(
          ix,
          partes.roomCode,
          `«${vacio.codigo}» es un edificio sin identificar y sin ninguna sala`,
        )
      }
      return {
        estado: 'sin_cruce',
        motivo: `el edificio «${vacio.nombre}» existe pero no tiene ninguna sala`,
      }
    }

    if (!ix.edificioVivo.has(partes.buildingCode)) {
      const muerto = ix.desaparecidos.get(norm(partes.buildingCode))
      return porCodigoEnTodoElMaestro(
        ix,
        partes.roomCode,
        muerto
          ? `el edificio «${muerto.nombre}» ya no existe (${muerto.motivo})`
          : `el código de edificio «${partes.buildingCode}» no está en el maestro`,
      )
    }
    return {
      estado: 'sin_cruce',
      motivo: `el edificio «${partes.buildingCode}» existe, pero no tiene ninguna sala «${partes.roomCode}»`,
    }
  }

  // 3 — Las dos hojas de aulas. Cambian en cómo nombran al edificio y a la sala,
  //     pero el camino es el mismo: edificio, y dentro del edificio, código.
  const bruto = ref.tipo === 'estado' ? ref.edificio : ref.edificio
  const aula = ref.tipo === 'estado' ? ref.aula : ref.nombreAula
  const via: ViaDeCruce = ref.tipo === 'estado' ? 'edificio+codigo' : 'edificio+nombre'

  const edificio = resolverEdificio(ix, bruto)

  if (edificio && 'desaparecido' in edificio) {
    return porCodigoEnTodoElMaestro(
      ix,
      formasDeEscribir(aula).at(-1) ?? aula,
      `el edificio «${edificio.desaparecido.nombre}» ya no existe (${edificio.desaparecido.motivo})`,
    )
  }

  if (!edificio) {
    return {
      estado: 'sin_cruce',
      motivo: `el edificio «${bruto}» no está en el maestro ni consta que lo haya estado`,
    }
  }

  // Si el edificio se resolvió por una equivalencia declarada, la fila cruza
  // pero no por el maestro de hoy, y eso tiene que verse en el informe.
  const traducido = ix.equivalencias.get(norm(bruto)) === edificio.codigo
  // Lo mismo con el nombre: la fila cruza, pero llama al edificio como se
  // llamaba antes, y quien lea el informe tiene que poder saberlo sin adivinar
  // por qué su libro nombra un edificio que en la aplicación ya no se llama así.
  const conNombreAnterior = !traducido && ix.nombreAnterior.get(norm(bruto)) === edificio.codigo

  // Dentro del edificio, todas las formas de escribir el mismo código.
  for (const c of formasDeEscribir(aula, edificio.codigo)) {
    const sala = ix.porEdificioYCodigo.get(`${edificio.codigo}|${c}`)
    if (sala) {
      if (traducido) {
        return conAviso(sala, 'nomenclatura-vieja', `«${bruto}» es nomenclatura vieja de «${sala.edificioNombre}»`)
      }
      if (conNombreAnterior) {
        return conAviso(
          sala,
          'nomenclatura-vieja',
          `«${bruto}» es el nombre anterior de «${sala.edificioNombre}»`,
        )
      }
      return conAviso(sala, via)
    }
  }

  // Antes de rendirse: un alias puede llevar la referencia vieja de esta sala.
  const porAlias = ix.porAlias.get(norm(`${aula} ${edificio.codigo}`))
  if (porAlias) return conAviso(porAlias, 'alias')

  const vacio = ix.edificioVacio.get(edificio.codigo)
  if (vacio) {
    if (vacio.sinIdentificar) {
      return porCodigoEnTodoElMaestro(
        ix,
        formasDeEscribir(aula).at(-1) ?? aula,
        `«${vacio.codigo}» es un edificio sin identificar y sin ninguna sala`,
      )
    }
    return {
      estado: 'sin_cruce',
      motivo: `el edificio «${vacio.nombre}» existe pero no tiene ninguna sala`,
    }
  }

  return {
    estado: 'sin_cruce',
    motivo: `el edificio «${bruto}» existe (${edificio.codigo}), pero no tiene ninguna sala «${aula}»`,
  }
}

// -----------------------------------------------------------------------------
// El recuento, que es lo que se mira
// -----------------------------------------------------------------------------

export interface Recuento {
  total: number
  resueltas: number
  porVia: Record<string, number>
  conAviso: number
  ambiguas: number
  sinCruce: number
}

export function contar(resoluciones: Resolucion[]): Recuento {
  const r: Recuento = { total: resoluciones.length, resueltas: 0, porVia: {}, conAviso: 0, ambiguas: 0, sinCruce: 0 }
  for (const res of resoluciones) {
    if (res.estado === 'resuelta') {
      r.resueltas++
      r.porVia[res.via] = (r.porVia[res.via] ?? 0) + 1
      if (res.aviso) r.conAviso++
    } else if (res.estado === 'ambigua') r.ambiguas++
    else r.sinCruce++
  }
  return r
}

// -----------------------------------------------------------------------------
// Los códigos de edificio que ya no existen: a quién corresponden hoy
// -----------------------------------------------------------------------------

/**
 * Lo observado de un código de edificio que el maestro no tiene: qué aulas
 * aparecen escritas con él.
 */
export interface Huerfano {
  codigo: string
  /** Los códigos de aula vistos junto a ese código de edificio, tal cual venían. */
  aulas: string[]
}

export interface Candidata {
  edificioCodigo: string
  edificioNombre: string
  /** Cuántas de las aulas observadas existen en ese edificio. */
  aciertos: number
  /**
   * Cuántas existen **solo** ahí. Es lo único que discrimina de verdad: un aula
   * `1.1` que está en ocho edificios no señala a ninguno.
   */
  exclusivos: number
}

export interface Equivalencia {
  codigo: string
  /** Cuántas aulas distintas se vieron con ese código. */
  aulas: number
  /** Cuántas de ellas existen en algún sitio del maestro. */
  reconocibles: number
  candidatas: Candidata[]
  /**
   * `unica`         — un solo edificio tiene aulas que no están en ningún otro,
   *                   y además es el que más encaja. Es lo único aplicable sin
   *                   preguntar.
   * `ambigua`       — varios edificios tienen aulas exclusivas, o ninguno la
   *                   tiene y entonces lo que hay es tamaño, no evidencia.
   * `sin_candidata` — ninguna de esas aulas existe hoy en ninguna parte.
   */
  veredicto: 'unica' | 'ambigua' | 'sin_candidata'
  /** Por qué ese veredicto, en una línea, para el informe. */
  motivo: string
}

/**
 * Propone a qué edificio de hoy corresponde cada código viejo, **deduciéndolo de
 * las aulas** y no del parecido de los nombres.
 *
 * El problema real: `S`, `G`, `TM`, `BC`… no son edificios que falten por dar de
 * alta, son la nomenclatura anterior a los renombrados. Pero `merge_building` y
 * los cambios de código de edificio no dejan alias para el **edificio**, solo
 * para las salas que existían entonces, así que un parte antiguo que dice `1.4 S`
 * se queda sin traducción y no hay heurística de nombres que la invente: `S`
 * puede ser Salud, Servicios o Seminarios.
 *
 * Lo que sí hay es evidencia. Un código viejo arrastra la lista de aulas que se
 * nombraron con él, y esas aulas siguen existiendo en el edificio al que fueron
 * a parar.
 *
 * Con una trampa que hay que esquivar y que es la razón de que esto cuente dos
 * cosas y no una: **contar coincidencias premia al edificio más grande**. Los
 * códigos de aula son genéricos —`1.1`, `2.3`, `-1.2`— y el edificio con cien
 * salas contiene casi cualquier lista que se le ponga delante. Medido sobre
 * estos libros, `S` encaja «30 de 30» con el edificio P y «26 de 30» con el M, y
 * eso no dice que `S` fuera P: dice que P es grande.
 *
 * Lo que discrimina son las aulas que están en **un solo** edificio. Si de las
 * treinta hay doce que solo existen en P, la equivalencia es evidencia. Si no
 * hay ninguna exclusiva, no se ha demostrado nada por mucho que los totales
 * cuadren, y el veredicto lo dice.
 *
 * Aplicar una equivalencia equivocada cuelga treinta partes del edificio que no
 * era sin que salte nada, y no se descubre hasta que alguien busca un histórico
 * y no está.
 */
export function proponerEquivalencias(ix: Indice, huerfanos: Huerfano[]): Equivalencia[] {
  return huerfanos
    .map((h) => {
      const porEdificio = new Map<string, Candidata>()
      let reconocibles = 0

      for (const aula of new Set(h.aulas.map((a) => norm(a)))) {
        // Las mismas formas de escribir que usa el cruce: un parte que dice
        // `AULA 1.4` y una sala que se llama `1.4` son la misma aula.
        const encontradas = new Map<string, SalaConocida>()
        for (const forma of formasDeEscribir(aula)) {
          for (const s of ix.porCodigoSuelto.get(forma) ?? []) encontradas.set(s.id, s)
        }
        if (encontradas.size === 0) continue
        reconocibles++

        // Un edificio suma **una vez por aula**, aunque tenga dos salas que
        // encajen: si no, un edificio grande gana dos veces por el mismo dato.
        const edificios = new Map<string, SalaConocida>()
        for (const s of encontradas.values()) {
          if (!edificios.has(s.edificioCodigo)) edificios.set(s.edificioCodigo, s)
        }
        const exclusiva = edificios.size === 1

        for (const [codigo, s] of edificios) {
          const c = porEdificio.get(codigo) ?? {
            edificioCodigo: codigo,
            edificioNombre: s.edificioNombre,
            aciertos: 0,
            exclusivos: 0,
          }
          c.aciertos++
          if (exclusiva) c.exclusivos++
          porEdificio.set(codigo, c)
        }
      }

      const candidatas = [...porEdificio.values()].sort(
        (a, b) => b.exclusivos - a.exclusivos || b.aciertos - a.aciertos,
      )
      const conExclusivas = candidatas.filter((c) => c.exclusivos > 0)
      const mejor = candidatas[0]

      if (!mejor) {
        return {
          codigo: h.codigo,
          aulas: new Set(h.aulas.map((a) => norm(a))).size,
          reconocibles,
          candidatas,
          veredicto: 'sin_candidata' as const,
          motivo: 'ninguna de esas aulas existe hoy: no hay de dónde deducir nada',
        }
      }

      let veredicto: Equivalencia['veredicto'] = 'ambigua'
      let motivo: string
      if (conExclusivas.length === 0) {
        motivo =
          'ninguna de esas aulas es exclusiva de un edificio: los totales que cuadran son tamaño, no evidencia'
      } else if (conExclusivas.length > 1) {
        motivo = `${conExclusivas.length} edificios tienen aulas que solo están ahí: o se repartieron, o el código nombraba a más de uno`
      } else if (mejor.aciertos < Math.max(...candidatas.map((c) => c.aciertos))) {
        motivo = 'el que tiene las aulas exclusivas no es el que más encaja: los datos se contradicen'
      } else {
        veredicto = 'unica'
        motivo = `${mejor.exclusivos} de esas aulas solo existen en ${mejor.edificioNombre}`
      }

      return {
        codigo: h.codigo,
        aulas: new Set(h.aulas.map((a) => norm(a))).size,
        reconocibles,
        candidatas,
        veredicto,
        motivo,
      }
    })
    .sort((a, b) => b.aulas - a.aulas)
}

// -----------------------------------------------------------------------------
// La equivalencia que sí consta: la auditoría
// -----------------------------------------------------------------------------

/**
 * Lo que `audit_log` guarda de los cambios de nomenclatura, en crudo.
 *
 * Las cuatro piezas juntas reconstruyen el camino completo de un edificio, y
 * ninguna sirve sola.
 */
export interface RastroDeAuditoria {
  /** Los edificios de hoy: `id` → código actual. */
  vivos: Array<{ id: string; codigo: string }>
  /**
   * Cada vez que `rename_building` cambió el código: la fila es la misma
   * (`rowId`), así que el código viejo y el nuevo son el mismo edificio.
   */
  renombrados: Array<{ rowId: string; codigoViejo: string }>
  /**
   * Cada `update zones set building_id` de `merge_building`: el edificio de
   * origen se quedó sin zonas y después se borró.
   */
  fusiones: Array<{ deId: string; aId: string }>
  /** Los `delete from buildings`, con el código que tenían al morir. */
  borrados: Array<{ rowId: string; codigo: string }>
  /**
   * Cada vez que a un edificio le cambió el **nombre** sin cambiarle el código.
   * La fila es la misma (`rowId`), así que el nombre viejo es de ese edificio.
   * Un edificio renombrado tres veces deja aquí sus tres nombres anteriores.
   */
  nombresCambiados?: Array<{ rowId: string; nombreViejo: string }>
}

/**
 * Sigue la cadena de fusiones desde una fila de la auditoría hasta el edificio
 * que existe hoy. Devuelve su código, o nada si la cadena no llega a ninguno.
 */
function seguidorDeCadenas(r: RastroDeAuditoria): (id: string) => string | undefined {
  const codigoDe = new Map(r.vivos.map((v) => [v.id, norm(v.codigo)]))
  const absorbidoPor = new Map(r.fusiones.map((f) => [f.deId, f.aId]))
  return (id: string): string | undefined => {
    const visto = new Set<string>()
    let actual: string | undefined = id
    while (actual && !visto.has(actual)) {
      const vivo = codigoDe.get(actual)
      if (vivo) return vivo
      visto.add(actual)
      actual = absorbidoPor.get(actual)
    }
    return undefined
  }
}

/**
 * Reconstruye, desde la auditoría, a qué edificio de hoy corresponde cada código
 * que se usó alguna vez. Sin heurísticas: es lo que pasó.
 *
 * Es la respuesta correcta al problema de la nomenclatura vieja, y es exacta
 * donde la deducción por aulas solo podía ser probable. Los cambios se hicieron
 * en la aplicación y la aplicación los apuntó:
 *
 *  - `rename_building` hace `update buildings set code = …` **sobre la misma
 *    fila**, así que la auditoría deja el código viejo y el nuevo con el mismo
 *    `row_id`. La equivalencia está escrita, no hay que adivinarla.
 *  - `merge_building` mueve las zonas con `update zones set building_id = …`
 *    —y `zones` también se audita— y después borra el edificio de origen. El
 *    salto de `building_id` es la equivalencia, y el `DELETE` da el código con
 *    el que murió.
 *
 * Lo que hay que seguir son las cadenas: un edificio renombrado dos veces y
 * fusionado después tiene tres códigos históricos y todos apuntan al mismo sitio
 * de hoy. Por eso esto camina el grafo en vez de mirar un solo salto.
 *
 * Solo puede saber lo que pasó **dentro de la aplicación**. Un código que ya era
 * viejo cuando se cargó la base —los que traen los partes de 2025— no dejó
 * rastro aquí, y ése sí hay que declararlo a mano.
 */
export function equivalenciasDesdeAuditoria(r: RastroDeAuditoria): Record<string, string> {
  const vivosHoy = new Set(r.vivos.map((v) => norm(v.codigo)))
  const codigoActual = seguidorDeCadenas(r)

  const out: Record<string, string> = {}
  const anotar = (viejo: string, id: string): void => {
    const destino = codigoActual(id)
    const v = norm(viejo)
    // Un código que sigue vivo con su propio nombre no es una equivalencia: si
    // `H` se renombró a `X` y después alguien dio de alta otro edificio `H`, la
    // fila vieja no puede secuestrar un código que hoy es de otro.
    if (!destino || !v || v === destino || vivosHoy.has(v)) return
    out[v] = destino
  }

  for (const x of r.renombrados) anotar(x.codigoViejo, x.rowId)
  for (const x of r.borrados) anotar(x.codigo, x.rowId)
  return out
}

/**
 * Los nombres que tuvieron antes los edificios que siguen vivos.
 *
 * Es el hermano de `equivalenciasDesdeAuditoria` para el otro cambio, el que no
 * toca el código: renombrar «EDIFICIO CENTRAL» a «ED. CENTRAL» deja el edificio
 * `C` exactamente donde estaba, pero el libro sigue diciendo el nombre viejo, y
 * sin esto sus filas dejan de cruzar en el momento del renombrado.
 *
 * Aquí no se decide nada: solo se junta lo que la auditoría apuntó. Quién gana
 * si un nombre viejo choca con un nombre de hoy lo decide `construirIndice`, que
 * es el único sitio que conoce el maestro entero.
 *
 * Solo ve lo que pasó **dentro de la aplicación**, igual que las equivalencias:
 * un nombre que ya era viejo cuando se cargó la base no dejó rastro.
 */
export function nombresAnterioresDesdeAuditoria(
  r: RastroDeAuditoria,
): Array<{ codigo: string; nombre: string }> {
  const codigoActual = seguidorDeCadenas(r)
  const vistos = new Set<string>()
  const out: Array<{ codigo: string; nombre: string }> = []

  for (const x of r.nombresCambiados ?? []) {
    const codigo = codigoActual(x.rowId)
    const nombre = norm(x.nombreViejo)
    if (!codigo || !nombre) continue
    const clave = `${codigo}|${nombre}`
    if (vistos.has(clave)) continue
    vistos.add(clave)
    out.push({ codigo, nombre })
  }
  return out
}
