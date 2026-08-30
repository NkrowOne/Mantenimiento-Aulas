/**
 * La pasada: juntar las dos caras de cada hoja y decidir qué se escribe dónde.
 *
 * Aquí se junta todo lo demás. `cruce.ts` dice de qué sala habla una fila,
 * `mapa.ts` dice qué es cada columna y de quién, `valores.ts` traduce entre la
 * celda y la base, `volcado.ts` dice qué tiene la aplicación que decir, y
 * `fusion.ts` decide celda a celda quién manda. Lo que falta —y es lo que hay
 * aquí— es la pasada entera: recorrer las filas, emparejarlas, preguntar por
 * cada celda, y salir con un plan.
 *
 * **Un plan, no una escritura.** Nada de esto toca el fichero ni la base:
 * devuelve qué habría que escribir en cada sitio, qué habría que insertar, qué
 * habría que borrar y qué no se puede decidir. Que se vea antes de que pase no
 * es una comodidad de la pantalla: es lo que permite que la primera pasada
 * contra un libro de 295 filas se pueda revisar en vez de creer.
 *
 * Cuatro decisiones que sostienen el resto:
 *
 * **La fila se identifica por la matrícula, y solo por ella cuando la lleva.** Un
 * `.xlsx` no tiene identidad de fila: la 87 de hoy no es la de ayer en cuanto
 * alguien ordena por edificio. El cruce por nombre existe para la primera pasada
 * —cuando la columna `Ref` todavía está vacía— y para explicar por qué una fila
 * no cruza; en cuanto hay matrícula, manda la matrícula aunque el nombre no
 * cuadre. Si no, renombrar un aula la duplicaría.
 *
 * **Una fila que no cruza no se borra ni se pisa: se cuenta.** Es la regla que
 * hace que esto se pueda ejecutar sin miedo contra el libro de la gente. Las 19
 * filas sin código de aula de la hoja de estado —restos, mitades de una celda
 * combinada, una fila con solo un número de serie— no son salas, y tratarlas
 * como tales sería inventarse 19 aulas o borrar 19 filas con datos.
 *
 * **Las salas archivadas se borran del libro y las nuevas se insertan en su
 * bloque de edificio.** Es lo que se pidió y no es gratis: mover filas obliga a
 * rehacer las celdas combinadas, el autofiltro, los formatos condicionales y las
 * anclas de los comentarios. Eso lo resuelve `estructura.ts`; lo que se resuelve
 * aquí es **dónde** va cada fila nueva, que es una pregunta de este libro: detrás
 * de la última de su edificio, y si su edificio no está en la hoja, al final,
 * abriendo bloque.
 *
 * **Lo sucio no entra ni se toca.** Un `********` en la columna de horas, un
 * `19/0672025` en la de fecha, un número de serie que ya está en otra aula: no se
 * interpreta, no se corrige y no se sobreescribe. Va a cuarentena con su fila,
 * su celda y el motivo, y lo resuelve una persona. Es la diferencia entre una
 * sincronización que se puede dejar corriendo y una que hay que vigilar.
 */

import { resolverSala } from './cruce'
import type { Indice } from './cruce'
import { canonizarFila, fusionarCelda } from './fusion'
import type { Decision, Dueno, Valor } from './fusion'
import { comprobarCabeceras, mesDe } from './mapa'
import type { Columna, Hoja } from './mapa'
import { escribir, esVacio, leer, limpiar } from './valores'
import type { FilaNueva } from './estructura'
import { columnaANumero, numeroAColumna } from './xlsx'
import type { Cambio, FilaLeida, ValorCelda } from './xlsx'
import { filaDeArticulo, filaDeIncidencia, filaDeSala } from './volcado'
import type { ArticuloVolcado, IncidenciaVolcada, SalaVolcada } from './volcado'

// -----------------------------------------------------------------------------
// Lo que sale de una pasada
// -----------------------------------------------------------------------------

/** Una celda que hay que escribir en la base, con de dónde salió. */
export interface HaciaLaBase {
  fila: number
  letra: string
  campo: string
  /** La matrícula de la sala, el número de incidencia o el id del artículo. */
  destino: string
  valor: Valor
  motivo: string
}

export interface Conflicto {
  fila: number
  letra: string
  campo: string
  destino: string
  base: Valor
  excel: Valor
  antepasado: Valor | undefined
  motivo: string
}

export interface EnCuarentena {
  fila: number
  letra: string
  campo: string
  destino: string
  crudo: ValorCelda
  motivo: string
}

export interface CeldaDeInstantanea {
  /** La clave estable de la fila: la matrícula, el nº de parte, el id del artículo. */
  clave: string
  /** Dónde estaba en esta pasada. Solo para contarlo: la fila de mañana es otra. */
  fila: number
  letra: string
  valor: Valor
}

export interface Plan {
  hoja: string
  /** Lo que se escribe en el libro, con las direcciones de la hoja de entrada. */
  celdas: Cambio[]
  insertar: FilaNueva[]
  borrar: number[]
  haciaLaBase: HaciaLaBase[]
  conflictos: Conflicto[]
  cuarentena: EnCuarentena[]
  instantanea: CeldaDeInstantanea[]
  /** Filas del libro que no se pudieron emparejar con nada. Ni se tocan. */
  sinCruzar: Array<{ fila: number; motivo: string }>
  avisos: string[]
  /** Si la hoja no tiene la forma que declara el mapa, la pasada no empieza. */
  desajustes: Array<{ letra: string; esperada: string; encontrada: string }>
}

function planVacio(hoja: string): Plan {
  return {
    hoja,
    celdas: [],
    insertar: [],
    borrar: [],
    haciaLaBase: [],
    conflictos: [],
    cuarentena: [],
    instantanea: [],
    sinCruzar: [],
    avisos: [],
    desajustes: [],
  }
}

/**
 * El valor de cada celda en la última pasada correcta (`sync_celdas`).
 *
 * Se pregunta por **la clave estable de la fila**, no por su número. Es la misma
 * razón por la que la tabla se indexa por `(hoja, ref, columna)`: entre dos
 * pasadas alguien ordena la hoja por edificio y la fila 87 pasa a ser la 214.
 * Un antepasado buscado por número de fila sería el de otra aula, y con él la
 * fusión daría por cambiado lo que nadie tocó — o peor, por sin cambios lo que
 * sí.
 */
export type Instantanea = (clave: string, letra: string) => Valor | undefined

/** La instantánea vacía: primera pasada, no hay antepasado de nada. */
export const SIN_INSTANTANEA: Instantanea = () => undefined

/**
 * El título de la columna de matrículas.
 *
 * Es el mismo que busca `columnaParaLaRef`, y tiene que escribirse en la hoja:
 * es lo único que permite que la pasada siguiente encuentre la columna en vez de
 * estrenar una nueva.
 */
export const TITULO_DE_LA_REF = 'Ref'

// -----------------------------------------------------------------------------
// El motor, que es el mismo para las tres formas de hoja
// -----------------------------------------------------------------------------

interface Emparejada<T> {
  fila: number
  celdas: Record<string, ValorCelda>
  /** La fila tal y como vino del libro, para poder preguntar por sus fórmulas. */
  leida: FilaLeida
  dato: T
  /** La clave estable: la matrícula, el nº de parte, el id del artículo. */
  clave: string
  /** Cómo se llama esto cuando lo lee una persona. */
  destino: string
  /**
   * Columnas de esta fila que **se comparan pero no se escriben**. Son dos
   * casos, y los dos existen en este libro:
   *
   *  - El blanco de una **columna arrastrada**: no es un hueco, es «lo mismo que
   *    arriba». Rellenarlo cambia cómo se lee la hoja.
   *  - La mitad escondida de una **celda combinada**. El libro tiene 59 pares;
   *    escribir en la celda de abajo de `E67:E68` guarda un valor que no se ve y
   *    que reaparece el día que alguien deshaga la combinación.
   */
  noEscribir?: Set<string>
}

interface Opciones<T> {
  hoja: Hoja
  filas: FilaLeida[]
  /** La fecha de la medida en cada lado, para las columnas de tipo `medida`. */
  fechaDeMedida?: (dato: T, lado: 'base' | 'excel', celdas: Record<string, ValorCelda>) => string | null
  instantanea: Instantanea
}

/**
 * Recorre las filas emparejadas y decide celda a celda.
 *
 * El bucle es corto a propósito: todo lo que decide está en `fusion.ts` y todo
 * lo que traduce está en `valores.ts`. Lo que pasa aquí es solo el reparto de lo
 * que cada uno decidió al montón que le toca.
 */
function fusionarFilas<T>(
  plan: Plan,
  emparejadas: Array<Emparejada<T>>,
  valoresDeLaApp: (dato: T) => Record<string, Valor>,
  op: Opciones<T>,
): void {
  for (const par of emparejadas) {
    const base = valoresDeLaApp(par.dato)

    for (const c of op.hoja.columnas) {
      // De una hoja congelada solo interesa lo que puede venir de ella hacia la
      // base. El resto de columnas ni se miran.
      if (op.hoja.congelada && c.dueno !== 'solo_excel') continue

      const crudo = par.celdas[c.letra] ?? null
      const lectura = leer(crudo, c.tipo)
      if (!lectura.ok) {
        plan.cuarentena.push({
          fila: par.fila,
          letra: c.letra,
          campo: c.campo,
          destino: par.destino,
          crudo,
          motivo: lectura.motivo,
        })
        continue
      }

      const decision = fusionarCelda({
        base: base[c.letra] ?? null,
        excel: lectura.valor,
        antepasado: op.instantanea(par.clave, c.letra),
        dueno: c.dueno,
        medidaBase: c.dueno === 'medida' ? op.fechaDeMedida?.(par.dato, 'base', par.celdas) : undefined,
        medidaExcel: c.dueno === 'medida' ? op.fechaDeMedida?.(par.dato, 'excel', par.celdas) : undefined,
      })

      repartir(
        plan,
        par,
        c,
        decision,
        lectura.valor,
        op.hoja.congelada === true || par.noEscribir?.has(c.letra) === true,
      )
    }
  }
}

function repartir<T>(
  plan: Plan,
  par: Emparejada<T>,
  c: Columna,
  decision: Decision,
  excel: Valor,
  soloLectura: boolean,
): void {
  switch (decision.tipo) {
    case 'sin_cambios':
    case 'ya_coinciden':
      plan.instantanea.push({ clave: par.clave, fila: par.fila, letra: c.letra, valor: excel })
      return

    case 'hacia_el_excel': {
      // Hay celdas que se comparan y no se escriben, y aquí es donde hay que
      // pararlo: la regla del hueco —gana quien tiene el dato— dispara antes que
      // la del dueño, así que una celda vacía con la aplicación teniendo dato
      // acaba proponiendo una escritura. Pasa en tres sitios: un cierre ya
      // rendido («Bolsa 2025», 137 celdas), el blanco de una columna arrastrada,
      // y la mitad escondida de una celda combinada.
      if (soloLectura) {
        plan.instantanea.push({ clave: par.clave, fila: par.fila, letra: c.letra, valor: excel })
        return
      }
      const valor = escribir(decision.valor, c.tipo)
      if (valor === null && decision.valor !== null) return
      plan.celdas.push({ celda: `${c.letra}${par.fila}`, valor: valor as ValorCelda, ...formatoDe(c) })
      plan.instantanea.push({ clave: par.clave, fila: par.fila, letra: c.letra, valor: decision.valor })
      return
    }

    case 'hacia_la_base':
      plan.haciaLaBase.push({
        fila: par.fila,
        letra: c.letra,
        campo: c.campo,
        destino: par.destino,
        valor: decision.valor,
        motivo: decision.motivo,
      })
      plan.instantanea.push({ clave: par.clave, fila: par.fila, letra: c.letra, valor: decision.valor })
      return

    case 'conflicto':
      // No se toca ninguno de los dos lados, y **tampoco la instantánea**: dejar
      // el valor de hoy como antepasado haría que la pasada siguiente creyera
      // que el conflicto se resolvió solo, y el que perdiera sería el que no
      // volviese a escribir.
      plan.conflictos.push({
        fila: par.fila,
        letra: c.letra,
        campo: c.campo,
        destino: par.destino,
        base: decision.base,
        excel: decision.excel,
        antepasado: decision.antepasado,
        motivo: decision.motivo,
      })
      return

    case 'descuadre':
      plan.avisos.push(
        `${c.letra}${par.fila} (${c.cabecera}): la hoja calcula ${decision.excel} y la base ${decision.base}. Es una fórmula: no se toca ninguno de los dos.`,
      )
      return
  }
}

// -----------------------------------------------------------------------------
// Hoja de estado — una fila por sala
// -----------------------------------------------------------------------------

export interface EntradaDeEstado {
  hoja: Hoja
  filas: FilaLeida[]
  /** Todas las salas de la base, archivadas incluidas. */
  salas: SalaVolcada[]
  indice: Indice
  /** La columna donde vive la matrícula. La calcula `preparar.ts`. */
  columnaRef: string
  /** Los rangos combinados de la hoja (`E67:E68`), de `celdasCombinadas`. */
  combinadas?: string[]
  instantanea?: Instantanea
}

export function sincronizarEstado(e: EntradaDeEstado): Plan {
  const plan = planVacio(e.hoja.nombre)
  const cabecera = e.filas.find((f) => f.fila === e.hoja.cabecera)
  plan.desajustes = comprobarCabeceras(e.hoja, cabecera?.celdas ?? {}).map((d) => ({
    letra: d.letra,
    esperada: d.esperada,
    encontrada: d.encontrada,
  }))
  if (plan.desajustes.length > 0) return plan

  const porMatricula = new Map(e.salas.map((s) => [norm(s.shortRef), s]))
  const emparejadas: Array<Emparejada<SalaVolcada>> = []
  const vistas = new Set<string>()
  const tapadas = celdasTapadas(e.combinadas ?? [])

  // La cabecera de la columna de matrículas, si no la lleva ya.
  //
  // Sin esto la pasada siguiente **no encuentra la columna**: `columnaParaLaRef`
  // busca el título `Ref` en la fila de cabecera y, al no verlo, devuelve la
  // primera columna libre. Resultado: cada pasada estrena una columna de
  // matrículas —`Y`, `Z`, `AA`…— y, mucho peor, desde la segunda **ninguna fila
  // tiene matrícula en la columna que se está leyendo**, así que todo vuelve a
  // cruzarse por nombre. Que es justo lo que la matrícula existe para evitar:
  // un aula renombrada deja de cruzar y se duplica.
  const tituloActual = textoDe(cabecera?.celdas[e.columnaRef])
  if (norm(tituloActual) !== norm(TITULO_DE_LA_REF)) {
    plan.celdas.push({ celda: `${e.columnaRef}${e.hoja.cabecera}`, valor: TITULO_DE_LA_REF })
  }

  // El edificio y la planta se arrastran hacia abajo: en la hoja solo se
  // escriben cuando cambian, y 10 filas los llevan en blanco a propósito.
  let edificio = ''
  let zona = ''

  for (const f of e.filas) {
    if (f.fila <= e.hoja.cabecera) continue
    const dice = (letra: string): string => textoDe(f.celdas[letra])
    if (dice('A') !== '') edificio = dice('A')
    if (dice('B') !== '') zona = dice('B')

    const matricula = textoDe(f.celdas[e.columnaRef])
    const aula = dice('C')
    if (matricula === '' && aula === '') {
      if (Object.values(f.celdas).some((v) => !esVacio(v as Valor))) {
        plan.sinCruzar.push({
          fila: f.fila,
          motivo: 'la fila tiene datos pero no dice de qué aula: ni matrícula ni código',
        })
      }
      continue
    }

    const sala =
      matricula !== ''
        ? porMatricula.get(norm(matricula))
        : salaPorCruce(e.indice, porMatricula, edificio, zona, aula)

    if (!sala) {
      plan.sinCruzar.push({
        fila: f.fila,
        motivo:
          matricula !== ''
            ? `la matrícula «${matricula}» no existe en el maestro`
            : `«${aula}» de «${edificio}» no cruza con ninguna sala`,
      })
      continue
    }

    if (vistas.has(sala.id)) {
      plan.sinCruzar.push({
        fila: f.fila,
        motivo: `«${sala.code}» ya salió en una fila anterior: dos filas para la misma sala`,
      })
      continue
    }
    vistas.add(sala.id)

    // Una sala archivada en la aplicación se lleva su fila del libro.
    if (!sala.activa) {
      plan.borrar.push(f.fila)
      plan.avisos.push(`Fila ${f.fila}: «${sala.code}» está archivada en la aplicación; su fila sale del libro.`)
      continue
    }

    // La matrícula, si no la lleva. Es lo que hace que la pasada siguiente no
    // dependa de que nadie ordene la hoja.
    if (matricula === '') {
      plan.celdas.push({ celda: `${e.columnaRef}${f.fila}`, valor: sala.shortRef })
    } else if (norm(matricula) !== norm(sala.shortRef)) {
      plan.avisos.push(`Fila ${f.fila}: la matrícula escrita no es la que sale del cruce. No se pisa.`)
    }

    // El edificio y la planta se comparan con lo que la fila **hereda**, no con
    // su celda: en blanco no quiere decir «no hay dato». Y donde estaban en
    // blanco se comparan y no se escriben, para que la hoja siga leyéndose como
    // se lee — si el edificio se renombra, se corrige la fila que lo lleva
    // escrito y las de debajo lo heredan solas.
    const noEscribir = new Set<string>(tapadas.get(f.fila) ?? [])
    const celdas = { ...f.celdas }
    for (const c of e.hoja.columnas) {
      if (!c.arrastrada) continue
      if (!esVacio(celdas[c.letra] as Valor)) continue
      noEscribir.add(c.letra)
      celdas[c.letra] = c.campo === 'edificio' ? edificio : zona
    }

    emparejadas.push({
      fila: f.fila,
      celdas,
      leida: f,
      dato: sala,
      clave: sala.shortRef,
      destino: sala.code,
      noEscribir,
    })
  }

  fusionarFilas(plan, emparejadas, (s) => filaDeSala(s, e.hoja), {
    hoja: e.hoja,
    filas: e.filas,
    instantanea: e.instantanea ?? SIN_INSTANTANEA,
    fechaDeMedida: (sala, lado, celdas) =>
      lado === 'base' ? (sala.revisiones[0] ?? null) : fechaDeCelda(celdas.D),
  })

  // Las salas vivas que el libro no tiene: fila nueva en su bloque de edificio.
  const enLaHoja = new Set(emparejadas.map((p) => p.dato.id))
  const nuevas = e.salas.filter((s) => s.activa && !enLaHoja.has(s.id))
  plan.insertar = filasNuevasDeSalas(nuevas, e, plan)

  return plan
}

/**
 * Qué celdas de cada fila están tapadas por una combinación.
 *
 * De `E67:E68` la que se ve es `E67`; `E68` existe, se lee vacía, y escribir en
 * ella guarda un valor que no enseña nadie. Solo se marcan las de debajo: la
 * primera fila del rango es la que manda y esa sí se escribe.
 */
function celdasTapadas(rangos: string[]): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>()
  for (const rango of rangos) {
    const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(rango.toUpperCase())
    if (!m) continue
    const desde = Number(m[2])
    const hasta = Number(m[4])
    const columnas = letrasEntre(m[1]!, m[3]!)
    for (let fila = desde + 1; fila <= hasta; fila++) {
      const suyas = out.get(fila) ?? new Set<string>()
      for (const c of columnas) suyas.add(c)
      out.set(fila, suyas)
    }
    // Una combinación horizontal (`B44:C45`) tapa además las columnas de la
    // derecha en su primera fila: de `B44:C45` solo se ve `B44`.
    if (columnas.length > 1) {
      const suyas = out.get(desde) ?? new Set<string>()
      for (const c of columnas.slice(1)) suyas.add(c)
      out.set(desde, suyas)
    }
  }
  return out
}

function letrasEntre(a: string, b: string): string[] {
  const desde = columnaANumero(a)
  const hasta = columnaANumero(b)
  const out: string[] = []
  for (let n = Math.min(desde, hasta); n <= Math.max(desde, hasta); n++) out.push(numeroAColumna(n))
  return out
}

/** El cruce por nombre, para la primera pasada y para las filas sin matrícula. */
function salaPorCruce(
  indice: Indice,
  porMatricula: Map<string, SalaVolcada>,
  edificio: string,
  zona: string,
  aula: string,
): SalaVolcada | undefined {
  const r = resolverSala(indice, { tipo: 'estado', edificio, zona, aula })
  if (r.estado !== 'resuelta') return undefined
  return porMatricula.get(norm(r.sala.shortRef))
}

/**
 * Dónde va cada sala nueva.
 *
 * Detrás de la última fila de su edificio, para que el bloque siga junto y la
 * hoja se pueda seguir leyendo como se lee hoy. Un edificio que no está en la
 * hoja abre bloque al final, y su fila lleva el nombre del edificio y la planta
 * escritos —dentro de un bloque no hace falta, porque se arrastran, pero la
 * primera fila del bloque sí los necesita.
 */
function filasNuevasDeSalas(nuevas: SalaVolcada[], e: EntradaDeEstado, plan: Plan): FilaNueva[] {
  if (nuevas.length === 0) return []

  const ultimaDe = new Map<string, number>()
  let ultima = e.hoja.cabecera
  let edificio = ''
  for (const f of e.filas) {
    if (f.fila <= e.hoja.cabecera) continue
    const a = textoDe(f.celdas.A)
    if (a !== '') edificio = a
    if (Object.values(f.celdas).every((v) => esVacio(v as Valor))) continue
    ultima = Math.max(ultima, f.fila)
    if (edificio !== '') ultimaDe.set(norm(edificio), f.fila)
  }

  // Se ordenan por edificio y código para que varias altas del mismo bloque
  // salgan seguidas y en un orden que se pueda predecir.
  const ordenadas = [...nuevas].sort(
    (a, b) => a.edificio.localeCompare(b.edificio) || a.code.localeCompare(b.code, 'es', { numeric: true }),
  )

  return ordenadas.map((sala) => {
    const tras = ultimaDe.get(norm(sala.edificio))
    const abreBloque = tras === undefined
    const destino = tras ?? ultima
    const celdas: Cambio[] = []

    for (const c of e.hoja.columnas) {
      // Dentro de un bloque, el edificio y la planta van en blanco como en el
      // resto de la hoja: escribirlos en todas las filas cambiaría el aspecto
      // de un libro que la gente lee todos los días.
      if (c.campo === 'edificio' && !abreBloque) continue
      const valor = escribir(filaDeSala(sala, e.hoja)[c.letra] ?? null, c.tipo)
      if (valor === null) continue
      celdas.push({ celda: `${c.letra}${destino + 1}`, valor: valor as ValorCelda, ...formatoDe(c) })
    }
    celdas.push({ celda: `${e.columnaRef}${destino + 1}`, valor: sala.shortRef })

    plan.avisos.push(
      abreBloque
        ? `«${sala.code}» abre bloque: «${sala.edificio}» no estaba en la hoja.`
        : `«${sala.code}» entra en el bloque de «${sala.edificio}».`,
    )
    return { tras: destino, celdas, estiloDe: tras }
  })
}

// -----------------------------------------------------------------------------
// Material instalado — una fila por parte
// -----------------------------------------------------------------------------

export interface EntradaDePartes {
  hoja: Hoja
  filas: FilaLeida[]
  incidencias: IncidenciaVolcada[]
  instantanea?: Instantanea
}

export function sincronizarPartes(e: EntradaDePartes): Plan {
  const plan = planVacio(e.hoja.nombre)
  const cabecera = e.filas.find((f) => f.fila === e.hoja.cabecera)
  plan.desajustes = comprobarCabeceras(e.hoja, cabecera?.celdas ?? {}).map((d) => ({
    letra: d.letra,
    esperada: d.esperada,
    encontrada: d.encontrada,
  }))
  if (plan.desajustes.length > 0) return plan

  const colNumero = e.hoja.identidad.tipo === 'incidencia' ? e.hoja.identidad.columna : 'D'
  const porNumero = new Map(e.incidencias.map((i) => [norm(i.numero), i]))
  const emparejadas: Array<Emparejada<IncidenciaVolcada>> = []
  const vistas = new Set<string>()

  for (const f of e.filas) {
    if (f.fila <= e.hoja.cabecera) continue
    if (Object.values(f.celdas).every((v) => esVacio(v as Valor))) continue

    const numero = textoDe(f.celdas[colNumero])
    if (numero === '') {
      plan.sinCruzar.push({ fila: f.fila, motivo: 'el parte no lleva número de incidencia' })
      continue
    }
    const inc = porNumero.get(norm(numero))
    if (!inc) {
      // Un parte del libro que la aplicación no conoce **no es un error**: es
      // histórico que se tecleó aquí y nunca entró. Ni se toca ni se borra.
      plan.sinCruzar.push({ fila: f.fila, motivo: `«${numero}» no está en la aplicación` })
      continue
    }
    if (vistas.has(inc.id)) {
      plan.sinCruzar.push({ fila: f.fila, motivo: `«${numero}» ya salió en una fila anterior` })
      continue
    }
    vistas.add(inc.id)
    emparejadas.push({
      fila: f.fila,
      celdas: f.celdas,
      leida: f,
      dato: inc,
      clave: inc.numero,
      destino: numero,
    })
  }

  fusionarFilas(plan, emparejadas, (i) => filaDeIncidencia(i, e.hoja), {
    hoja: e.hoja,
    filas: e.filas,
    instantanea: e.instantanea ?? SIN_INSTANTANEA,
  })

  if (e.hoja.congelada) return plan

  // Los partes que la aplicación tiene y el libro no, al final y por fecha.
  const enLaHoja = new Set(emparejadas.map((p) => p.dato.id))
  const ultima = ultimaFilaConDatos(e.filas, e.hoja.cabecera)
  const nuevos = e.incidencias
    .filter((i) => !enLaHoja.has(i.id))
    .sort((a, b) => (a.abierta ?? '').localeCompare(b.abierta ?? '') || a.numero.localeCompare(b.numero))

  plan.insertar = nuevos.map((inc) => ({
    tras: ultima,
    celdas: e.hoja.columnas
      .map((c) => ({
        celda: `${c.letra}${ultima + 1}`,
        valor: escribir(filaDeIncidencia(inc, e.hoja)[c.letra] ?? null, c.tipo) as ValorCelda,
        ...formatoDe(c),
      }))
      .filter((c) => c.valor !== null),
    estiloDe: ultima,
  }))
  if (nuevos.length > 0) {
    plan.avisos.push(`${nuevos.length} partes de la aplicación que el libro no tenía se añaden al final.`)
  }

  return plan
}

// -----------------------------------------------------------------------------
// Bolsa — una fila por artículo
// -----------------------------------------------------------------------------

export interface EntradaDeBolsa {
  hoja: Hoja
  filas: FilaLeida[]
  articulos: ArticuloVolcado[]
  /** Resuelve un nombre escrito como sea al id del artículo. Sale de la base. */
  resolver: (nombre: string) => string | null
  instantanea?: Instantanea
}

export function sincronizarBolsa(e: EntradaDeBolsa): Plan {
  const plan = planVacio(e.hoja.nombre)
  const cabecera = e.filas.find((f) => f.fila === e.hoja.cabecera)
  plan.desajustes = comprobarCabeceras(e.hoja, cabecera?.celdas ?? {}).map((d) => ({
    letra: d.letra,
    esperada: d.esperada,
    encontrada: d.encontrada,
  }))
  if (plan.desajustes.length > 0) return plan

  const colNombre = e.hoja.identidad.tipo === 'articulo' ? e.hoja.identidad.columna : 'A'
  const porId = new Map(e.articulos.map((a) => [a.id, a]))
  const emparejadas: Array<Emparejada<ArticuloVolcado>> = []
  const vistas = new Set<string>()
  const ultima = ultimaFilaConDatos(e.filas, e.hoja.cabecera)
  // Las últimas filas de la hoja de 2025 son la suma, el IVA y el total: no son
  // artículos y tratarlas como tales escribiría números encima de las cuentas.
  const finDeDatos = ultima - (e.hoja.filasDeTotales ?? 0)

  for (const f of e.filas) {
    if (f.fila <= e.hoja.cabecera || f.fila > finDeDatos) continue
    const nombre = textoDe(f.celdas[colNombre])
    if (nombre === '') continue

    const id = e.resolver(nombre)
    if (!id || !porId.has(id)) {
      plan.sinCruzar.push({ fila: f.fila, motivo: `«${nombre}» no está en el catálogo del almacén` })
      continue
    }
    if (vistas.has(id)) {
      plan.sinCruzar.push({ fila: f.fila, motivo: `«${nombre}» ya salió en una fila anterior` })
      continue
    }
    vistas.add(id)
    emparejadas.push({
      fila: f.fila,
      celdas: f.celdas,
      leida: f,
      dato: porId.get(id)!,
      clave: id,
      destino: nombre,
    })
  }

  fusionarFilas(plan, emparejadas, (a) => filaDeArticulo(a, e.hoja), {
    hoja: e.hoja,
    filas: e.filas,
    instantanea: e.instantanea ?? SIN_INSTANTANEA,
  })

  if (e.hoja.congelada) return plan

  // Las fórmulas pisadas se devuelven a su sitio. Es lo único que se escribe en
  // una columna de fórmula, y no es una excepción a la regla: la regla dice que
  // no se escribe un **número** encima de una fórmula, y esto es lo contrario.
  for (const par of emparejadas) {
    for (const c of e.hoja.columnas) {
      if (c.dueno !== 'formula' || !c.formula) continue
      if (tieneFormula(par.leida, c.letra)) continue
      plan.celdas.push({ celda: `${c.letra}${par.fila}`, valor: c.formula.replace(/\{f\}/g, String(par.fila)) })
      plan.avisos.push(
        `${c.letra}${par.fila} (${c.cabecera}) llevaba un número escrito a mano encima de la fórmula: se le devuelve la fórmula.`,
      )
    }
  }

  const enLaHoja = new Set(emparejadas.map((p) => p.dato.id))
  const nuevos = e.articulos
    .filter((a) => !enLaHoja.has(a.id))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))

  plan.insertar = nuevos.map((art) => {
    const destino = finDeDatos
    const valores = filaDeArticulo(art, e.hoja)
    const celdas: Cambio[] = []
    for (const c of e.hoja.columnas) {
      if (c.dueno === 'formula' && c.formula) {
        celdas.push({ celda: `${c.letra}${destino + 1}`, valor: c.formula.replace(/\{f\}/g, String(destino + 1)) })
        continue
      }
      const valor = escribir(valores[c.letra] ?? null, c.tipo)
      if (valor === null) continue
      celdas.push({ celda: `${c.letra}${destino + 1}`, valor: valor as ValorCelda, ...formatoDe(c) })
    }
    return { tras: destino, celdas, estiloDe: destino }
  })
  if (nuevos.length > 0) {
    plan.avisos.push(`${nuevos.length} artículos del almacén que el libro no tenía se añaden con su fórmula.`)
  }

  return plan
}

// -----------------------------------------------------------------------------

/**
 * El formato que hay que asegurarle a la celda.
 *
 * Solo para fechas y porcentajes: en la hoja los dos son números y lo que los
 * convierte en lo que son es el formato de la celda, no el valor. El resto de
 * columnas conservan el estilo que ya tuvieran.
 */
function formatoDe(c: Columna): { formato?: 'fecha' | 'porcentaje' } {
  if (c.tipo === 'fecha') return { formato: 'fecha' }
  if (c.tipo === 'porcentaje') return { formato: 'porcentaje' }
  return {}
}

/**
 * `true` si la celda del libro trae una fórmula y no un número tecleado.
 *
 * Se pregunta a `fila.formulas`, no al valor: una celda de fórmula **se lee como
 * su valor cacheado**, así que mirando ahí `=P5-N5` y un `35` escrito a mano son
 * exactamente lo mismo. Con esa confusión, el bucle que devuelve las fórmulas
 * pisadas creía que las 43 filas de la bolsa estaban pisadas y las reescribía
 * todas — y como la serialización de celda no tenía rama para `=`, las
 * reescribía **como texto**. Las 86 fórmulas de la hoja se perdían en la primera
 * pasada, la columna dejaba de calcular, y el libro abría sin decir nada.
 */
function tieneFormula(fila: FilaLeida, letra: string): boolean {
  if (fila.formulas && letra in fila.formulas) return true
  // Una fila armada a mano puede traer la fórmula como texto en el valor.
  const v = fila.celdas[letra]
  return typeof v === 'string' && v.startsWith('=')
}

function ultimaFilaConDatos(filas: FilaLeida[], cabecera: number): number {
  let ultima = cabecera
  for (const f of filas) {
    if (f.fila <= cabecera) continue
    if (Object.values(f.celdas).every((v) => esVacio(v as Valor))) continue
    ultima = Math.max(ultima, f.fila)
  }
  return ultima
}

function textoDe(v: ValorCelda | undefined): string {
  if (v === null || v === undefined) return ''
  return limpiar(String(v))
}

function fechaDeCelda(v: ValorCelda | undefined): string | null {
  const l = leer(v ?? null, 'fecha')
  return l.ok && typeof l.valor === 'string' ? l.valor : null
}

/**
 * La forma canónica de una clave de cruce.
 *
 * Colapsa los espacios de dentro además de los de los extremos, y eso no es
 * cosmética: `textoDe` ya los colapsa al leer la celda, así que si aquí no se
 * hiciera lo mismo los dos lados de la comparación no se normalizarían igual. En
 * este libro pasa de verdad — la fila 101 de los partes de 2026 lleva
 * `I260415_0029` y `I260414_0007` en la misma celda separados por 38 espacios—,
 * y el efecto es que ese parte no se reconoce a sí mismo entre dos pasadas y se
 * vuelve a añadir cada vez.
 */
function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}

// -----------------------------------------------------------------------------
// El parte de la pasada
// -----------------------------------------------------------------------------

export interface Resumen {
  hoja: string
  filas: number
  celdasAlExcel: number
  celdasALaBase: number
  filasNuevas: number
  filasBorradas: number
  conflictos: number
  cuarentena: number
  sinCruzar: number
}

export function resumir(plan: Plan): Resumen {
  return {
    hoja: plan.hoja,
    filas: plan.instantanea.length,
    celdasAlExcel: plan.celdas.length,
    celdasALaBase: plan.haciaLaBase.length,
    filasNuevas: plan.insertar.length,
    filasBorradas: plan.borrar.length,
    conflictos: plan.conflictos.length,
    cuarentena: plan.cuarentena.length,
    sinCruzar: plan.sinCruzar.length,
  }
}

/**
 * La huella de la pasada, para no repetir trabajo.
 *
 * Si el libro no ha cambiado y la base tampoco, la huella es la misma y la
 * pasada se puede saltar entera. Usa la misma función que `fusion.ts` para que
 * dos pasadas equivalentes den lo mismo aunque las columnas vengan en otro orden.
 */
export function huellaDelPlan(planes: Plan[]): string {
  return planes
    .map((p) =>
      canonizarFila(
        Object.fromEntries(p.instantanea.map((c) => [`${p.hoja}!${c.clave}!${c.letra}`, c.valor])),
      ),
    )
    .join('|')
}

/** Los meses que la pasada va a rellenar, para poder decirlo en la pantalla. */
export function mesesEscritos(plan: Plan, hoja: Hoja): number[] {
  const letras = new Map(hoja.columnas.map((c) => [c.letra, mesDe(c.campo)]))
  const meses = new Set<number>()
  for (const c of plan.celdas) {
    const letra = /^([A-Z]+)/.exec(c.celda)?.[1] ?? ''
    const mes = letras.get(letra)
    if (mes !== null && mes !== undefined) meses.add(mes)
  }
  return [...meses].sort((a, b) => a - b)
}

export type { Dueno }
