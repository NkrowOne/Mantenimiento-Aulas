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
import { canonizarFila, fusionarCelda, iguales } from './fusion'
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
  /**
   * `true` si este antepasado describe el libro **que va a salir**, no el que se
   * acaba de leer.
   *
   * Solo lo llevan las celdas que se escriben. Y hay que distinguirlas porque no
   * valen lo mismo: el resto son hechos sobre el libro que ya está —lo que
   * decía— y éstas son una promesa sobre uno que todavía no existe. Si la pasada
   * se cae al generar los bytes, o el navegador se cierra antes de la descarga,
   * el antepasado diría que el Excel vale lo que la app quería y el Excel
   * seguiría valiendo lo de antes: la pasada siguiente vería que «solo cambió el
   * Excel» y **metería en la base el valor viejo**, deshaciendo lo de la app.
   *
   * Así que estos se guardan aparte y solo cuando el fichero está hecho.
   */
  trasEscribir?: boolean
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
      // Una hoja congelada no escribe en la base. Ni una celda.
      //
      // Aquí antes se dejaban pasar las columnas `solo_excel`, con la idea de
      // sembrar en la base lo que 2025 sabía y la aplicación no. La idea era
      // buena y el sitio, el peor posible, porque una celda no lleva fecha:
      //
      //  - `Comprado` entra como un movimiento de compra fechado **hoy**. Las
      //    compras de 2025 aparecían en 2026, y el cuadre del año vivo las
      //    volvía a restar. Dos hojas peleándose por el mismo saldo.
      //  - Los meses (`mes:3`) no tienen dónde entrar: el consumo son
      //    movimientos, no un número por casilla. Iban a cuarentena.
      //  - Y ninguna de las dos se calla nunca: la base no las devuelve como
      //    están escritas, así que la pasada siguiente vuelve a mandarlas. Sobre
      //    este libro son 65 celdas por pasada, para siempre.
      //
      // Un cierre ya rendido entra por donde entran las cosas con fecha, que es
      // `scripts/import-excel.ts`, y una vez. Aquí se lee —para los alias, para
      // el saldo de apertura de 2026 y para saber qué artículos existían— y no
      // se toca nada.
      if (op.hoja.congelada) continue

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
        // El antepasado es lo que había, ilegible y todo. No es un capricho: sin
        // él, una celda que ya vino sucia en la primera pasada se queda **sin
        // antepasado para siempre**, y el día que alguien la arregla en la hoja
        // la fusión cae en «primera pasada: manda la app» y le escribe encima el
        // valor de la aplicación. El arreglo se pierde y no sale ni como choque
        // ni como aviso.
        //
        // Con esto, arreglarla a lo mismo que dice la base no da trabajo, y
        // arreglarla a otra cosa sale como choque, que es lo que es: la celda
        // decía una cosa, alguien escribió otra, y la base tiene una tercera.
        plan.instantanea.push({
          clave: par.clave,
          fila: par.fila,
          letra: c.letra,
          valor: crudo as Valor,
        })
        continue
      }

      // Donde un cero es un blanco, se compara en blanco: así ni se rellena el
      // libro de ceros ni un blanco del libro intenta entrar en la base como 0.
      const enBlanco = (v: Valor): Valor => (c.ceroEsBlanco && v === 0 ? null : v)
      const decision = fusionarCelda({
        base: enBlanco(base[c.letra] ?? null),
        excel: enBlanco(lectura.valor),
        antepasado: op.instantanea(par.clave, c.letra),
        dueno: c.dueno,
        tipo: c.tipo,
        medidaBase: c.dueno === 'medida' ? op.fechaDeMedida?.(par.dato, 'base', par.celdas) : undefined,
        medidaExcel: c.dueno === 'medida' ? op.fechaDeMedida?.(par.dato, 'excel', par.celdas) : undefined,
      })

      repartir(
        plan,
        par,
        c,
        decision,
        lectura.valor,
        par.noEscribir?.has(c.letra) === true,
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
      // pararlo: la regla del hueco —gana quien tiene el dato— dispara antes
      // que la del dueño en la dirección que rellena, así que una celda vacía
      // con la aplicación teniendo dato acaba proponiendo una escritura. Pasa
      // en dos sitios: el blanco de una columna arrastrada (el edificio no se
      // repite en cada fila, y ese hueco es tipografía, no un dato que falte) y
      // la mitad escondida de una celda combinada.
      if (soloLectura) {
        plan.instantanea.push({ clave: par.clave, fila: par.fila, letra: c.letra, valor: excel })
        return
      }
      const valor = escribir(decision.valor, c.tipo)
      if (valor === null && decision.valor !== null) return

      // Y lo que se escribe tiene que volver a leerse igual. Si no, escribirlo
      // es empezar un bucle: la pasada siguiente lee otra cosa, la compara con
      // la base, ve un hueco y lo vuelve a escribir, y así para siempre. Pasa
      // con los rellenos —un `-`, un `***`, un `?`—, que `leer` trata como
      // vacíos escritos a mano y `escribir` mete tal cual: la celda quedaría
      // reescribiéndose en cada pasada sin que nadie note nada.
      const vuelta = leer(valor, c.tipo)
      if (!vuelta.ok || !iguales(vuelta.valor, decision.valor, c.tipo)) {
        plan.avisos.push(
          `${c.letra}${par.fila} (${c.cabecera}): la aplicación dice «${decision.valor ?? ''}» y eso no se puede escribir en la hoja sin que deje de leerse igual. Se queda como está.`,
        )
        return
      }

      plan.celdas.push({ celda: `${c.letra}${par.fila}`, valor: valor as ValorCelda, ...formatoDe(c) })
      plan.instantanea.push({
        clave: par.clave,
        fila: par.fila,
        letra: c.letra,
        valor: decision.valor,
        trasEscribir: true,
      })
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

/**
 * El antepasado de una celda que se acaba de escribir en una fila nueva.
 *
 * Sin esto, una fila insertada llegaba a la pasada siguiente **sin antepasado**,
 * y sin antepasado manda la app: si alguien corrigió a mano una celda de esa
 * fila entre las dos pasadas, su corrección se sobrescribía sin decir nada. Con
 * el antepasado puesto, la pasada siguiente ve que el Excel se movió y la base
 * no, que es exactamente lo que pasó, y la corrección entra.
 *
 * La fila va a `0` a propósito: esta celda no estaba en ninguna fila del libro
 * que se leyó, y `claveDe` —que busca por número de fila para resolver a qué
 * habla una corrección— solo pregunta por filas de verdad, de la 2 en adelante.
 * Con el número que va a ocupar chocaría con la fila que hoy está ahí.
 */
function anotarCeldaNueva(plan: Plan, clave: string, letra: string, valor: Valor): void {
  plan.instantanea.push({ clave, fila: 0, letra, valor })
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
  const porSerialUnico = serialesUnicos(e.salas)
  const grupoDe = gruposDeFilas(e.filas, e.hoja, e.columnaRef, e.combinadas ?? [])
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
  // La última fila que era una sala, para reconocer las que la continúan.
  let cabezaAnterior: { fila: number; code: string } | null = null

  for (const f of e.filas) {
    if (f.fila <= e.hoja.cabecera) continue
    const dice = (letra: string): string => textoDe(f.celdas[letra])
    if (dice('A') !== '') edificio = dice('A')
    if (dice('B') !== '') zona = dice('B')

    const matricula = textoDe(f.celdas[e.columnaRef])
    const aula = dice('C')
    if (matricula === '' && aula === '') {
      if (Object.values(f.celdas).some((v) => !esVacio(v as Valor))) {
        // Si continúa la sala de arriba —el segundo proyector de un aula que va
        // en dos filas— se dice, que no es lo mismo que una fila perdida: esa
        // sala existe, y su segundo equipo está en «Inventario por Sala».
        const deArriba = cabezaAnterior && grupoDe(cabezaAnterior.fila).includes(f.fila) ? cabezaAnterior : null
        plan.sinCruzar.push({
          fila: f.fila,
          motivo: deArriba
            ? `continúa la fila de «${deArriba.code}»: un segundo equipo de esa sala. Esta hoja enseña uno por tipo; los demás están en «Inventario por Sala»`
            : 'la fila tiene datos pero no dice de qué aula: ni matrícula ni código',
        })
      }
      continue
    }

    const porRef = matricula !== '' ? porMatricula.get(norm(matricula)) : undefined
    let cruce: ResultadoDelCruce =
      matricula !== ''
        ? porRef
          ? { sala: porRef }
          : { motivo: `la matrícula «${matricula}» no existe en el maestro` }
        : salaPorCruce(e.indice, porMatricula, edificio, zona, aula)

    // Sin matrícula y sin cruce por nombre: los números de serie. Es la red de
    // la primera pasada, que es cuando el libro todavía no lleva matrículas y
    // una sala que se mudó de edificio en la aplicación ya no está donde su
    // fila dice. Un número de serie es de un solo aparato y un aparato está en
    // una sola sala, así que si todos los de la fila apuntan a la misma, es esa.
    // Sin esto la fila se quedaba huérfana en el bloque viejo —sin matrícula, y
    // sin cruzar en ninguna pasada— y la sala se insertaba otra vez en el nuevo:
    // la misma aula dos veces, con el mismo serial, para siempre.
    if (!cruce.sala && matricula === '') {
      const porSerial = salaPorSeriales(f.celdas, e.hoja, porSerialUnico)
      if (porSerial.sala) {
        plan.avisos.push(
          `Fila ${f.fila}: «${aula}» no cruza por nombre en «${edificio}», pero sus números de serie son los de «${porSerial.sala.code}» en «${porSerial.sala.edificio}»: es esa sala.`,
        )
        cruce = { sala: porSerial.sala }
      } else if (porSerial.motivo) {
        cruce = { motivo: `${cruce.motivo}; ${porSerial.motivo}` }
      }
    }

    if (!cruce.sala) {
      plan.sinCruzar.push({
        fila: f.fila,
        // El «qué» delante y el «por qué» detrás: el qué es lo que se busca en
        // el libro y el porqué es lo que dice qué hacer con ello.
        motivo: matricula !== '' ? cruce.motivo : `«${aula}» de «${edificio}»: ${cruce.motivo}`,
      })
      continue
    }
    const sala = cruce.sala

    cabezaAnterior = { fila: f.fila, code: sala.code }

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
      // Con sus filas de continuación, si las tiene: un aula con dos proyectores
      // va en dos filas, y dejar la segunda sería dejar un proyector sin aula.
      const grupo = grupoDe(f.fila)
      plan.borrar.push(...grupo)
      conservarCabeceraDeBloque(f, e.filas, plan)
      plan.avisos.push(
        `Fila ${f.fila}: «${sala.code}» está archivada en la aplicación; su fila sale del libro` +
          (grupo.length > 1 ? ` con sus ${grupo.length - 1} filas de continuación.` : '.'),
      )
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

    // Una sala que ya no está en el edificio que su fila dice **se muda**: la
    // fila sale de este bloque y entra en el suyo. Corregir el nombre del
    // edificio en el sitio —que es lo que se hace con un renombrado— dejaría una
    // fila de «EDIFICIO O» en mitad del bloque de «EDIFICIO P», y en una hoja
    // que se lee por bloques eso no es un aula mudada: es una errata.
    //
    // Mudanza y renombrado se parecen desde la celda —los dos son «el nombre
    // no coincide»— y no se tratan igual: un renombrado se corrige en el sitio.
    // Se distinguen por el maestro: si los dos nombres son de dos edificios
    // DISTINTOS que existen, es una mudanza; si el nombre del libro no es de
    // ninguno —un nombre viejo que la auditoría no conoce, una errata nueva— se
    // trata como renombrado, que es lo que no destruye nada.
    if (esOtroEdificio(e.indice, edificio, sala.edificio)) {
      const grupo = grupoDe(f.fila)
      if (grupo.length > 1) {
        // Un aula de dos filas —dos proyectores, celdas combinadas— no se mueve
        // desde aquí: la aplicación solo sabe reconstruir una fila, y mover la
        // primera dejando la segunda es perder un proyector. Se corrige el
        // edificio en el sitio, como en un renombrado, y se dice.
        plan.avisos.push(
          `Fila ${f.fila}: «${sala.code}» está hoy en «${sala.edificio}» pero su fila va combinada con ${grupo.length - 1} más: no se mueve de bloque, se corrige el edificio en la fila. Muévela a mano si quieres que cambie de sitio.`,
        )
      } else {
        plan.borrar.push(f.fila)
        conservarCabeceraDeBloque(f, e.filas, plan)
        plan.avisos.push(
          `Fila ${f.fila}: «${sala.code}» se muda de «${edificio}» a «${sala.edificio}»: su fila cambia de bloque.`,
        )
        // Y no se empareja: al no estar «en la hoja», se inserta en su bloque
        // nuevo con lo que la aplicación sabe de ella, matrícula incluida.
        continue
      }
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
 * Qué filas forman una sala: la suya y las de continuación que la siguen.
 *
 * Un aula con dos proyectores va en dos filas: la segunda lleva las horas, el
 * modelo y el número del segundo aparato, y ni código ni matrícula. A veces
 * además van combinadas (`B182:B183`). Para leer valores da igual —la segunda
 * es «una fila con datos y sin aula» y se deja donde está—, pero para borrar o
 * mover hay que tratarlas juntas: mover la cabeza y dejar la cola es dejar un
 * proyector sin aula.
 */
function gruposDeFilas(
  filas: FilaLeida[],
  hoja: Hoja,
  columnaRef: string,
  combinadas: string[],
): (fila: number) => number[] {
  const porFila = new Map(filas.map((f) => [f.fila, f]))
  // Las filas que una combinación vertical une a la de arriba.
  const unidaALaAnterior = new Set<number>()
  for (const rango of combinadas) {
    const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(rango.toUpperCase())
    if (!m) continue
    for (let f = Number(m[2]) + 1; f <= Number(m[4]); f++) unidaALaAnterior.add(f)
  }
  const esContinuacion = (f: FilaLeida): boolean =>
    textoDe(f.celdas.C) === '' &&
    textoDe(f.celdas[columnaRef]) === '' &&
    Object.values(f.celdas).some((v) => !esVacio(v as Valor))

  return (fila) => {
    const out = [fila]
    let f = fila + 1
    while (true) {
      const sig = porFila.get(f)
      if (!sig) break
      if (!unidaALaAnterior.has(f) && !esContinuacion(sig)) break
      if (f > hoja.cabecera) out.push(f)
      f++
    }
    return out
  }
}

/**
 * `true` si los dos nombres son de dos edificios distintos **del maestro**.
 *
 * Solo con evidencia positiva: un nombre que el maestro no resuelve no es
 * prueba de nada. Así una mudanza exige que el libro y la app nombren dos
 * edificios que existen, y todo lo demás cae en el trato del renombrado.
 */
function esOtroEdificio(ix: Indice, delLibro: string, deLaApp: string): boolean {
  const a = ix.edificioPorNombre.get(norm(delLibro))
  const b = ix.edificioPorNombre.get(norm(deLaApp))
  return a !== undefined && b !== undefined && a !== b
}

/**
 * Los números de serie que identifican una sola sala.
 *
 * Un serial que aparece en dos salas no identifica ninguna —es un dato sucio
 * del maestro, y el importador ya lo manda a cuarentena— así que se queda fuera.
 */
function serialesUnicos(salas: SalaVolcada[]): Map<string, SalaVolcada> {
  const vistos = new Map<string, SalaVolcada | null>()
  for (const s of salas) {
    if (!s.activa) continue
    for (const eq of s.equipos) {
      const k = norm(eq.serial ?? '')
      if (!k) continue
      vistos.set(k, vistos.has(k) && vistos.get(k) !== s ? null : s)
    }
  }
  const out = new Map<string, SalaVolcada>()
  for (const [k, s] of vistos) if (s) out.set(k, s)
  return out
}

/**
 * La sala a la que apuntan los números de serie de una fila, si apuntan a una.
 *
 * Solo las columnas de serial del mapa, y solo si **todos** los que hay en la
 * fila dicen la misma sala. Uno solo ya vale —es un dato exacto, no una
 * probabilidad—; dos que discrepan no valen ninguno, y se dice.
 */
function salaPorSeriales(
  celdas: Record<string, ValorCelda>,
  hoja: Hoja,
  porSerial: Map<string, SalaVolcada>,
): { sala?: SalaVolcada; motivo?: string } {
  const candidatas = new Map<string, { sala: SalaVolcada; serial: string }>()
  let vistos = 0
  for (const c of hoja.columnas) {
    if (!/^equipo:.+:serial$/.test(c.campo)) continue
    const serial = textoDe(celdas[c.letra])
    if (!serial) continue
    vistos++
    const sala = porSerial.get(norm(serial))
    if (sala) candidatas.set(sala.id, { sala, serial })
  }
  if (vistos === 0 || candidatas.size === 0) return {}
  if (candidatas.size === 1) return { sala: [...candidatas.values()][0]!.sala }
  const lista = [...candidatas.values()].map((x) => `«${x.serial}» es de «${x.sala.code}»`).join(', ')
  return { motivo: `y sus números de serie discrepan: ${lista}` }
}

/**
 * Al borrar la fila que abre un bloque, la de debajo hereda el rótulo.
 *
 * En la hoja el edificio y la planta se escriben una vez por bloque y las filas
 * siguientes los llevan en blanco. Borrar esa primera fila —porque el aula se
 * archivó o se mudó— dejaría a las de debajo heredando del bloque ANTERIOR, y
 * en una hoja que se lee por bloques eso es cambiar de edificio a diez aulas
 * sin tocarlas. Se escribe el rótulo en la siguiente fila con datos.
 */
function conservarCabeceraDeBloque(f: FilaLeida, filas: FilaLeida[], plan: Plan): void {
  const a = textoDe(f.celdas.A)
  const b = textoDe(f.celdas.B)
  if (a === '' && b === '') return
  const siguiente = filas.find(
    (x) => x.fila > f.fila && !plan.borrar.includes(x.fila) && Object.values(x.celdas).some((v) => !esVacio(v as Valor)),
  )
  if (!siguiente) return
  if (a !== '' && textoDe(siguiente.celdas.A) === '') {
    plan.celdas.push({ celda: `A${siguiente.fila}`, valor: a })
  }
  if (b !== '' && textoDe(siguiente.celdas.B) === '') {
    plan.celdas.push({ celda: `B${siguiente.fila}`, valor: b })
  }
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

/** O la sala, o el motivo por el que no la hay. Nunca las dos ni ninguna. */
type ResultadoDelCruce =
  | { sala: SalaVolcada; motivo?: undefined }
  | { sala?: undefined; motivo: string }

/**
 * El cruce por nombre, para la primera pasada y para las filas sin matrícula.
 *
 * Devuelve también el **motivo** cuando no cruza, y no solo `undefined`.
 * `resolverSala` redacta uno preciso para cada fallo —«el edificio ya no existe
 * (fusionado)», «el código existe en tres edificios»— y tirarlo era lo que
 * dejaba la pantalla repitiendo «no cruza con ninguna sala» once veces seguidas
 * sin decir nada: con ese texto, un edificio fusionado, una sala renombrada y un
 * código ambiguo se leen exactamente igual, y ninguno de los tres se arregla del
 * mismo modo.
 */
function salaPorCruce(
  indice: Indice,
  porMatricula: Map<string, SalaVolcada>,
  edificio: string,
  zona: string,
  aula: string,
): ResultadoDelCruce {
  const r = resolverSala(indice, { tipo: 'estado', edificio, zona, aula })
  if (r.estado === 'ambigua') {
    return {
      motivo: `${r.motivo}. Candidatas: ${r.candidatas.map((c) => `«${c.code}» (${c.shortRef})`).join(', ')}`,
    }
  }
  if (r.estado === 'sin_cruce') return { motivo: r.motivo }
  const sala = porMatricula.get(norm(r.sala.shortRef))
  // Cruzó contra el maestro pero esa sala no está en el volcado del año: es un
  // desajuste entre las dos lecturas, y decir «no cruza» lo escondería.
  if (!sala) {
    return {
      motivo: `cruza con «${r.sala.code}» (${r.sala.shortRef}), pero esa sala no está en los datos de la pasada`,
    }
  }
  return { sala }
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

  // Una fila que se va a borrar no puede ser el ancla de una inserción: el
  // planificador se niega —con razón— a insertar detrás de una fila que
  // desaparece. Pasaba al archivar la última sala de un bloque y dar de alta
  // otra en el mismo bloque en la misma pasada, y pasa siempre con una mudanza.
  const seBorra = new Set(plan.borrar)
  const ultimaDe = new Map<string, number>()
  const ultimaDePlanta = new Map<string, number>()
  let ultima = e.hoja.cabecera
  let edificio = ''
  let zona = ''
  for (const f of e.filas) {
    if (f.fila <= e.hoja.cabecera) continue
    const a = textoDe(f.celdas.A)
    const b = textoDe(f.celdas.B)
    if (a !== '') edificio = a
    if (b !== '') zona = b
    if (Object.values(f.celdas).every((v) => esVacio(v as Valor))) continue
    if (seBorra.has(f.fila)) continue
    ultima = Math.max(ultima, f.fila)
    if (edificio !== '') {
      ultimaDe.set(norm(edificio), f.fila)
      ultimaDePlanta.set(`${norm(edificio)}|${norm(zona)}`, f.fila)
    }
  }

  // Se ordenan por edificio y código para que varias altas del mismo bloque
  // salgan seguidas y en un orden que se pueda predecir.
  const ordenadas = [...nuevas].sort(
    (a, b) => a.edificio.localeCompare(b.edificio) || a.code.localeCompare(b.code, 'es', { numeric: true }),
  )

  return ordenadas.map((sala) => {
    // Detrás de la última fila de su planta si la planta ya está en el bloque;
    // si no, detrás de la última del edificio, y la fila lleva la planta escrita.
    const trasPlanta = ultimaDePlanta.get(`${norm(sala.edificio)}|${norm(sala.zona)}`)
    const tras = trasPlanta ?? ultimaDe.get(norm(sala.edificio))
    const abreBloque = ultimaDe.get(norm(sala.edificio)) === undefined
    const abrePlanta = trasPlanta === undefined
    const destino = tras ?? ultima
    const celdas: Cambio[] = []

    const valores = filaDeSala(sala, e.hoja)
    for (const c of e.hoja.columnas) {
      // Dentro de un bloque, el edificio va en blanco como en el resto de la
      // hoja: escribirlo en todas las filas cambiaría el aspecto de un libro que
      // la gente lee todos los días. La planta solo se escribe cuando la fila
      // abre una planta nueva dentro del bloque.
      if (c.campo === 'edificio' && !abreBloque) continue
      if (c.campo === 'zona' && !abreBloque && !abrePlanta) continue
      const dato = valores[c.letra] ?? null
      const valor = escribir(dato, c.tipo)
      if (valor === null) continue
      celdas.push({ celda: `${c.letra}${destino + 1}`, valor: valor as ValorCelda, ...formatoDe(c) })
      // Solo de lo que se escribe: la columna del edificio que se deja en
      // blanco dentro de un bloque no vale como antepasado, porque en la pasada
      // siguiente esa celda se lee arrastrada del bloque y no vacía.
      anotarCeldaNueva(plan, sala.shortRef, c.letra, dato)
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
  //
  // Solo los **abiertos en el año de la hoja**. La aplicación trae todos los
  // partes que existen —los de 2025 también, que el importador cargó igual— y
  // una hoja no puede dar por «nuevo» todo lo que no tiene: la de 2026 se
  // tragaba los 186 de 2025 en la primera pasada, uno detrás de otro, al final.
  // Un parte de otro año va en su hoja; si esa hoja está congelada o no existe,
  // no va a ninguna, y la pasada lo cuenta.
  const enLaHoja = new Set(emparejadas.map((p) => p.dato.id))
  const ultima = ultimaFilaConDatos(e.filas, e.hoja.cabecera)
  const delAnyo = (i: IncidenciaVolcada): boolean =>
    e.hoja.anyo === undefined || (i.abierta !== null && Number(i.abierta.slice(0, 4)) === e.hoja.anyo)
  const nuevos = e.incidencias
    .filter((i) => !enLaHoja.has(i.id) && delAnyo(i))
    .sort((a, b) => (a.abierta ?? '').localeCompare(b.abierta ?? '') || a.numero.localeCompare(b.numero))

  plan.insertar = nuevos.map((inc) => {
    const valores = filaDeIncidencia(inc, e.hoja)
    const celdas: Cambio[] = []
    for (const c of e.hoja.columnas) {
      const dato = valores[c.letra] ?? null
      const valor = escribir(dato, c.tipo)
      if (valor === null) continue
      celdas.push({ celda: `${c.letra}${ultima + 1}`, valor: valor as ValorCelda, ...formatoDe(c) })
      anotarCeldaNueva(plan, inc.numero, c.letra, dato)
    }
    return { tras: ultima, celdas, estiloDe: ultima }
  })
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

/**
 * Lo que daría la fórmula de una columna, con los datos que trae la aplicación.
 *
 * Solo para poder comparar antes de devolverle la fórmula a una celda que lleva
 * un número escrito a mano. Si no se sabe calcular, devuelve `null` y la fórmula
 * se restaura como siempre: la duda no puede parar el arreglo de las celdas que
 * sí cuadran.
 */
function valorDeLaFormula(c: Columna, art: ArticuloVolcado, hoja: Hoja): number | null {
  const consumido = art.meses.reduce((n, m) => n + m, 0)
  if (c.campo === 'articulo.consumido') return consumido
  if (c.campo === 'articulo.disponible') return (art.comprado ?? 0) - consumido
  void hoja
  return null
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
  //
  // Pero **solo si la fórmula da lo mismo que el número que hay escrito**. Si no,
  // eso no es devolver una fórmula: es borrar un dato. En este libro pasa tres
  // veces —N5=3, N8=2 y N9=1, con los doce meses en blanco— y son seis unidades
  // de consumo que no están en ninguna otra celda ni en la base: alguien apuntó
  // el total sin desglosarlo por meses. Poner ahí `=B5+…+M5`, con la aplicación
  // escribiendo ceros en los meses porque no tiene movimientos, convierte el 3
  // en un 0 y no queda rastro.
  //
  // Cuando no cuadra no se toca **nada de esa fila**: ni el total ni los meses.
  // La fila se queda como la escribió quien la escribió y se dice en el parte,
  // que es lo único honesto: el libro sabe algo que la aplicación no sabe.
  const filasQueNoSeTocan = new Set<number>()
  for (const par of emparejadas) {
    for (const c of e.hoja.columnas) {
      if (c.dueno !== 'formula' || !c.formula) continue
      if (tieneFormula(par.leida, c.letra)) continue

      const escrito = leer(par.celdas[c.letra] ?? null, 'numero')
      const calculado = valorDeLaFormula(c, par.dato, e.hoja)
      if (escrito.ok && escrito.valor !== null && calculado !== null && !iguales(escrito.valor, calculado)) {
        filasQueNoSeTocan.add(par.fila)
        plan.avisos.push(
          `${c.letra}${par.fila} (${c.cabecera}): la hoja dice ${escrito.valor} escrito a mano y la fórmula daría ${calculado}. No se toca la fila: devolverle la fórmula convertiría ${escrito.valor} en ${calculado} y ese dato no está en ningún otro sitio.`,
        )
        continue
      }

      plan.celdas.push({ celda: `${c.letra}${par.fila}`, valor: c.formula.replace(/\{f\}/g, String(par.fila)) })
      plan.avisos.push(
        `${c.letra}${par.fila} (${c.cabecera}) llevaba un número escrito a mano encima de la fórmula: se le devuelve la fórmula, que da lo mismo.`,
      )
    }
  }

  // Y de esas filas no se escribe ninguna celda, ni los meses: rellenar los doce
  // meses con ceros al lado de un total escrito a mano es afirmar que no hubo
  // consumo ningún mes, que es justo lo contrario de lo que dice el total.
  if (filasQueNoSeTocan.size > 0) {
    plan.celdas = plan.celdas.filter((cambio) => {
      const fila = Number(/\d+$/.exec(cambio.celda)?.[0] ?? 0)
      return !filasQueNoSeTocan.has(fila)
    })
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
        // Con `{f}` sin resolver: la fila en la que va a caer la decide el
        // editor al escribir, y es él quien lo sustituye. Resolverlo aquí con
        // `destino + 1` daba a todas las filas nuevas el número de la primera.
        celdas.push({ celda: `${c.letra}${destino + 1}`, valor: c.formula })
        continue
      }
      const dato = valores[c.letra] ?? null
      // Un mes a cero se deja en blanco también en una fila nueva: es como se
      // escriben los meses en esta hoja, y así se compara después.
      if (c.ceroEsBlanco && dato === 0) continue
      const valor = escribir(dato, c.tipo)
      if (valor === null) continue
      celdas.push({ celda: `${c.letra}${destino + 1}`, valor: valor as ValorCelda, ...formatoDe(c) })
      anotarCeldaNueva(plan, art.id, c.letra, dato)
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
