/**
 * Las hojas que el libro no tiene y hacen falta para que diga la verdad entera.
 *
 * Las cinco de siempre están construidas alrededor de una idea: **una fila por
 * cosa, y el estado de hoy**. Una fila por aula con su última revisión, una fila
 * por artículo con lo que queda. Eso vale para mirar cómo está el parque, y no
 * vale para nada de lo que se pidió aquí: *revisiones, horas, salidas de
 * material, entradas, movimientos al stock*. Ninguna de esas cosas es un estado;
 * todas son **un historial**, y un historial no cabe en una celda.
 *
 * La hoja de estado tiene dos columnas de fecha de revisión. Dos. La aplicación
 * guarda todas, con quién la hizo, a qué hora, qué comprobó y qué salió mal.
 * Meter eso en la hoja de siempre exigiría o inventarse cuarenta columnas o
 * tirar lo que no cupiera, así que va donde cabe: en tres hojas nuevas con una
 * fila por evento.
 *
 * Cinco decisiones sobre cómo se ven:
 *
 * **Llevan la matrícula, y por eso se pueden cruzar.** `Revisiones` y
 * `Inventario por Sala` traen `Ref`, la misma columna que la hoja de estado, así
 * que un `BUSCARV` las une sin que nadie tenga que casar nombres a mano. Es la
 * diferencia entre tres hojas nuevas y tres hojas útiles.
 *
 * **Los historiales van de lo más antiguo a lo más reciente.** Es el orden de
 * las hojas que la gente lleva a mano (`Material Instalado`), y tener unas
 * pestañas al derecho y otras al revés era lo que hacía que nadie se fiara de
 * ninguna. Lo último sincronizado está abajo del todo, donde se llega con un
 * Ctrl+Fin.
 *
 * **Los movimientos llevan el saldo detrás.** Una lista de entradas y salidas
 * contesta «qué pasó» y no contesta «cuánto queda», que es la que se hace la
 * gente. Va calculado, por artículo, en el mismo orden de fecha que se lee.
 *
 * **Las fechas se escriben como fechas** y los porcentajes como porcentajes:
 * la hoja declara el formato de cada columna y `libro.ts` pone el estilo. Una
 * hoja de revisiones que enseña `45831` no la mira nadie dos veces.
 *
 * **El color dice quién escribe y cómo está.** Cabecera azul claro en cursiva
 * en las hojas de la aplicación, gris en las de apoyo; y un tinte por fila
 * donde ayuda a leer —una revisión con incidencias en rojo, una compra en
 * verde— sin que nadie tenga que pintarlo a mano.
 *
 * **No hay fotos.** Se pidió expresamente, y además una foto en una celda pesa
 * más que todo el resto del libro junto.
 */

import { ESTADO, TITULO_DE_SITUACION, arranqueDelAnyo, hojasDelAnyo } from './mapa'
import type { Hoja } from './mapa'
import { situacionDeUnidad, valorDeUnidad } from './volcado'
import type { UnidadVolcada } from './volcado'
import type { ValorCelda } from './xlsx'
import { fechaAExcel } from './valores'

// Las claves de estilo, los formatos, los tintes y la forma de una hoja nueva
// los declara `libro.ts`, que es quien los convierte en estilos de verdad.
import type { ClaveDeEstilo, Formato, HojaNueva, Tinte } from './libro'

export type { ClaveDeEstilo, Formato, HojaNueva, Tinte }

// -----------------------------------------------------------------------------
// Revisiones
// -----------------------------------------------------------------------------

export interface RevisionParaHoja {
  shortRef: string
  edificio: string
  zona: string
  sala: string
  /** ISO completo: de aquí salen la fecha y la hora, que van en columnas aparte. */
  cuando: string
  quien: string | null
  estado: string
  resultado: string | null
  horasProyector: number | null
  lampara: number | null
  /** `altavoces: ok · cámara: incidencia`, ya montado. */
  comprobaciones: string | null
  incidenciasAbiertas: number
  notas: string | null
}

const COL_REVISIONES = [
  'Ref',
  'Edificio',
  'Planta/Módulo',
  'Aula',
  'Fecha',
  'Hora',
  'Quién revisó',
  'Estado',
  'Resultado',
  'Horas proyector',
  '% Lámparas',
  'Comprobaciones',
  'Incidencias abiertas',
  'Observaciones',
]

export function hojaDeRevisiones(revisiones: RevisionParaHoja[]): HojaNueva {
  const filas: ValorCelda[][] = [COL_REVISIONES]
  const tintes: Array<Tinte | undefined> = []

  // De la más antigua a la más reciente, como las hojas que la gente lleva a
  // mano: lo que se acaba de sincronizar queda al final, donde se sigue leyendo.
  const ordenadas = [...revisiones].sort((a, b) => a.cuando.localeCompare(b.cuando))

  for (const r of ordenadas) {
    filas.push([
      r.shortRef,
      r.edificio,
      r.zona,
      r.sala,
      fechaAExcel(r.cuando),
      horaDe(r.cuando),
      r.quien,
      estadoLegible(r.estado),
      resultadoLegible(r.resultado),
      r.horasProyector,
      r.lampara,
      r.comprobaciones,
      r.incidenciasAbiertas,
      r.notas,
    ])
    tintes.push(tinteDeRevision(r))
  }

  return {
    nombre: 'Revisiones',
    filas,
    anchos: [14, 22, 16, 16, 11, 8, 22, 12, 16, 14, 12, 40, 10, 46],
    formatos: formatos({
      4: 'fecha',
      9: 'entero',
      10: 'porcentaje',
      11: 'textoAjustado',
      12: 'entero',
      13: 'textoAjustado',
    }),
    tintes,
    caracter: 'app',
  }
}

/**
 * El color de una revisión se decide por lo que se quiere ver de un vistazo:
 * primero si es de verdad una revisión terminada —un borrador o una cerrada
 * sin terminar se apagan, sea cual sea su resultado— y luego cómo salió.
 */
function tinteDeRevision(r: RevisionParaHoja): Tinte | undefined {
  if (r.estado !== 'completa') return 'apagado'
  if (r.resultado === 'con_incidencias') return 'critico'
  if (r.resultado === 'ok') return 'ok'
  return undefined
}

/**
 * Lo que la base guarda como `completa` u `ok` se lee mal en una hoja: son
 * claves de programa. Se escriben como palabras, que es lo que cualquiera
 * espera leer en una columna de resultado; lo que no se reconozca sale tal cual.
 */
const ESTADO_LEGIBLE: Record<string, string> = { completa: 'Completa', borrador: 'Borrador', cerrada: 'Cerrada' }
const RESULTADO_LEGIBLE: Record<string, string> = { ok: 'Sin incidencias', con_incidencias: 'Con incidencias' }

function estadoLegible(estado: string): string {
  return ESTADO_LEGIBLE[estado] ?? estado
}

function resultadoLegible(resultado: string | null): string | null {
  if (resultado === null) return null
  return RESULTADO_LEGIBLE[resultado] ?? resultado
}

/**
 * La hora, como texto y en 24 horas.
 *
 * Va aparte de la fecha y no junta con ella a propósito: en una sola celda con
 * formato de fecha y hora, filtrar «las revisiones del martes» deja de funcionar
 * porque cada instante es distinto. Separadas, la columna de fecha filtra por
 * día y la de hora sigue estando cuando hace falta.
 */
function horaDe(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  // Si solo vino la fecha, no hay hora que enseñar.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// -----------------------------------------------------------------------------
// Movimientos de almacén
// -----------------------------------------------------------------------------

export interface MovimientoParaHoja {
  cuando: string
  articulo: string
  /** En positivo entra y en negativo sale, como está en la base. */
  cantidad: number
  tipo: string
  /** El número del parte que gastó el material (`I260102_0007`, `S260301_0004`), si lo hubo. */
  incidencia: string | null
  /**
   * De qué clase es ese parte: decide en qué columna va el número. `null` es
   * «sin parte» o un parte que no es ni lo uno ni lo otro (una observación),
   * y entonces el número no va en ninguna de las dos.
   */
  claseDeParte: 'incidencia' | 'solicitud' | null
  sala: string | null
  quien: string | null
  nota: string | null
}

const COL_MOVIMIENTOS = [
  'Fecha',
  'Artículo',
  'Movimiento',
  'Entrada',
  'Salida',
  'Saldo',
  'Incidencia',
  'Solicitud',
  'Aula',
  'Quién',
  'Nota',
]

/** Cómo se llama cada movimiento cuando lo lee una persona. */
const NOMBRE_DEL_MOVIMIENTO: Record<string, string> = {
  compra: 'Compra',
  consumo: 'Consumo',
  ajuste: 'Ajuste',
  devolucion: 'Devolución',
}

/**
 * Una compra es la buena noticia y se ve en verde; un consumo es lo normal y no
 * se pinta; una devolución o un ajuste son una corrección de algo que se apuntó
 * mal o no se gastó, y conviene que llamen la atención sin alarmar.
 */
const TINTE_DEL_MOVIMIENTO: Record<string, Tinte> = {
  compra: 'ok',
  devolucion: 'aviso',
  ajuste: 'aviso',
}

export function hojaDeMovimientos(movimientos: MovimientoParaHoja[]): HojaNueva {
  const filas: ValorCelda[][] = [COL_MOVIMIENTOS]
  const tintes: Array<Tinte | undefined> = []

  // Por fecha, de la más antigua a la más reciente, que es como se lee un
  // historial; dentro del mismo día, por artículo, para que los movimientos de
  // una misma cosa queden juntos; y a igual artículo, el orden de llegada: dos
  // movimientos del mismo día no se pueden ordenar mejor sin inventarse una
  // hora. `sort` es estable, así que el orden de llegada se conserva solo.
  const ordenados = [...movimientos].sort(
    (a, b) => a.cuando.localeCompare(b.cuando) || a.articulo.localeCompare(b.articulo, 'es'),
  )

  // El saldo se lleva por artículo aunque las filas vayan entrelazadas: cada
  // renglón dice cuánto quedaba de ESA cosa justo después de ese movimiento.
  const saldo = new Map<string, number>()
  for (const m of ordenados) {
    const acumulado = (saldo.get(m.articulo) ?? 0) + m.cantidad
    saldo.set(m.articulo, acumulado)
    filas.push([
      fechaAExcel(m.cuando),
      m.articulo,
      NOMBRE_DEL_MOVIMIENTO[m.tipo] ?? m.tipo,
      m.cantidad > 0 ? m.cantidad : null,
      m.cantidad < 0 ? -m.cantidad : null,
      acumulado,
      m.claseDeParte === 'incidencia' ? m.incidencia : null,
      m.claseDeParte === 'solicitud' ? m.incidencia : null,
      m.sala,
      m.quien,
      m.nota,
    ])
    tintes.push(TINTE_DEL_MOVIMIENTO[m.tipo])
  }

  return {
    nombre: 'Movimientos de Almacén',
    filas,
    anchos: [11, 38, 14, 10, 10, 10, 16, 16, 16, 22, 40],
    formatos: formatos({ 0: 'fecha', 3: 'entero', 4: 'entero', 5: 'entero', 10: 'textoAjustado' }),
    tintes,
    caracter: 'app',
  }
}

// -----------------------------------------------------------------------------
// Inventario por sala
// -----------------------------------------------------------------------------

export interface EquipoParaHoja {
  shortRef: string
  edificio: string
  zona: string
  sala: string
  /** El nombre canónico: el de la columna del libro (`TV`, `Monitor`, `Ordenador`) cuando responde a una. */
  tipo: string
  /** Cómo llama la aplicación al tipo cuando no coincide con el canónico (`Ordenador Tiny`); si coincide, `null`. */
  nombreEnLaApp: string | null
  modelo: string | null
  serial: string | null
  estado: string
  desde: string | null
  etiqueta: string | null
}

const COL_INVENTARIO = [
  'Ref',
  'Edificio',
  'Planta/Módulo',
  'Aula',
  'Tipo de equipo',
  'Nombre en la app',
  'Modelo',
  'N.º de serie',
  'Estado',
  'Desde',
  'Etiqueta',
]

/**
 * Una fila por equipo instalado.
 *
 * Es la hoja que contesta lo que la de estado no puede: **un aula con dos
 * proyectores**. La hoja de siempre tiene una columna `S/N Proyector` y por
 * fuerza enseña uno solo; aquí salen los dos, con su fecha de alta, y se ve cuál
 * es el que la otra hoja está enseñando.
 *
 * «Tipo de equipo» habla como el libro y «Nombre en la app» como la aplicación,
 * y solo cuando no dicen lo mismo: así se ve que el «Ordenador Tiny» de la
 * ficha es el `S/N Ordenador` de la hoja de estado, sin que nadie tenga que
 * saberlo de memoria.
 */
export function hojaDeInventario(equipos: EquipoParaHoja[]): HojaNueva {
  const filas: ValorCelda[][] = [COL_INVENTARIO]
  const tintes: Array<Tinte | undefined> = []

  // No es un historial: se lee como se recorre el edificio, planta a planta y
  // aula a aula, con el número del aula en orden numérico (1.2 antes que 1.10).
  const ordenados = [...equipos].sort(
    (a, b) =>
      a.edificio.localeCompare(b.edificio, 'es') ||
      a.zona.localeCompare(b.zona, 'es', { numeric: true }) ||
      a.sala.localeCompare(b.sala, 'es', { numeric: true }) ||
      a.tipo.localeCompare(b.tipo, 'es'),
  )

  for (const e of ordenados) {
    filas.push([
      e.shortRef,
      e.edificio,
      e.zona,
      e.sala,
      e.tipo,
      // Vacío si coinciden: la columna solo existe para señalar la diferencia.
      e.nombreEnLaApp && e.nombreEnLaApp !== e.tipo ? e.nombreEnLaApp : null,
      e.modelo,
      e.serial,
      e.estado,
      e.desde ? fechaAExcel(e.desde) : null,
      e.etiqueta,
    ])
    // Lo que no está instalado (retirado, en reparación) sigue saliendo por si
    // alguien lo busca por número de serie, pero apagado: no está en el aula.
    tintes.push(e.estado === 'instalado' ? undefined : 'apagado')
  }

  return {
    nombre: 'Inventario por Sala',
    filas,
    anchos: [14, 22, 16, 16, 16, 20, 26, 22, 12, 11, 14],
    formatos: formatos({ 9: 'fecha' }),
    tintes,
    caracter: 'app',
  }
}

// -----------------------------------------------------------------------------
// PCs de repuesto, cuando el libro todavía no lleva la hoja
// -----------------------------------------------------------------------------

/**
 * La hoja de ordenadores de repuesto estrenada desde la aplicación.
 *
 * Solo se usa la primera vez, cuando el libro no la trae: a partir de ahí es
 * una hoja de las de dos caras y se sincroniza como las demás. Lleva las
 * columnas del mapa y, al final, «Situación», que es la que la aplicación
 * escribe siempre. Nace `editable` porque es de la gente: cabecera azul oscuro
 * y autofiltro, como sus hermanas, y no tabla.
 */
export function hojaDeUnidades(hoja: Hoja, unidades: UnidadVolcada[]): HojaNueva {
  const filas: ValorCelda[][] = [[...hoja.columnas.map((c) => c.cabecera as ValorCelda), TITULO_DE_SITUACION]]
  const ordenadas = [...unidades].sort(
    (a, b) =>
      a.articulo.localeCompare(b.articulo, 'es') ||
      (a.modelo ?? '').localeCompare(b.modelo ?? '', 'es') ||
      a.serial.localeCompare(b.serial, 'es'),
  )
  for (const u of ordenadas) {
    filas.push([...hoja.columnas.map((c) => valorDeUnidad(u, c) as ValorCelda), situacionDeUnidad(u)])
  }
  return { nombre: hoja.nombre, filas, anchos: [30, 20, 14, 28, 42, 34], caracter: 'editable' }
}

// -----------------------------------------------------------------------------
// El parte de la pasada
// -----------------------------------------------------------------------------

export interface LineaDelParte {
  hoja: string
  celda: string
  que: string
  detalle: string
}

const COL_PARTE = ['Hoja', 'Celda', 'Qué pasó', 'Detalle']

/**
 * Lo que hay que mirar primero se ve primero: un choque o una duda sin decidir
 * paran algo y van en rojo; una celda que no se pudo leer o una fila sin cruzar
 * se pueden arreglar con calma y van en ámbar; un aviso solo cuenta lo que la
 * pasada hizo por su cuenta y no se pinta.
 */
const TINTE_DEL_PARTE: Record<string, Tinte> = {
  Choque: 'critico',
  'Pendiente de decidir': 'critico',
  'No se puede leer': 'aviso',
  'Sin cruzar': 'aviso',
}

/**
 * Lo que la pasada no pudo decidir, dentro del propio libro.
 *
 * Existe por una razón muy concreta: **quien abre el Excel no abre la
 * aplicación**. Si los choques y la cuarentena solo se ven en una bandeja de
 * administración, en seis meses hay quinientos y nadie los ha mirado. Aquí los
 * ve la misma persona que está mirando la celda.
 *
 * Se reescribe entera en cada pasada, y eso es lo correcto: no es un historial,
 * es la lista de lo que sigue pendiente hoy. Y es una hoja de apoyo, no de
 * datos: va discreta, al final y con la pestaña gris.
 */
export function hojaDelParte(lineas: LineaDelParte[], cuando: string): HojaNueva {
  const filas: ValorCelda[][] = [COL_PARTE]
  const tintes: Array<Tinte | undefined> = []

  if (lineas.length === 0) {
    filas.push(['', '', 'Todo cuadra', `Última sincronización: ${cuando}. Nada quedó pendiente.`])
    tintes.push('ok')
  } else {
    filas.push(['', '', `Última sincronización`, cuando])
    tintes.push('apagado')
    for (const l of lineas) {
      filas.push([l.hoja, l.celda, l.que, l.detalle])
      tintes.push(TINTE_DEL_PARTE[l.que])
    }
  }

  return {
    nombre: 'Sincronización',
    filas,
    anchos: [30, 10, 26, 80],
    formatos: formatos({ 3: 'textoAjustado' }),
    tintes,
    autofiltro: lineas.length > 0,
    caracter: 'discreta',
  }
}

// -----------------------------------------------------------------------------
// El Léeme
// -----------------------------------------------------------------------------

/** Ancho de la columna de texto del Léeme, en caracteres: de él sale el alto de cada fila. */
const ANCHO_DEL_TEXTO = 110

/**
 * La página de instrucciones del libro, escrita por la aplicación.
 *
 * Antes la mantenía alguien a mano y se quedaba vieja en cuanto cambiaba una
 * hoja: la generó la aplicación una vez y ya decía «Sincronización» sin decir
 * qué colores llevaba ni por qué las pestañas iban en ese orden. Aquí sale de
 * la misma fuente que las hojas —los nombres de `mapa.ts`, el año en curso, la
 * fecha de arranque— y se rehace en cada pasada, así que no puede desmentir al
 * libro en el que va.
 *
 * Dos columnas: la etiqueta y el texto. Cada fila cuenta una sola cosa y en
 * pocas líneas: quien abre un Léeme lo lee de pie.
 */
export function hojaDeLeeme(opciones: { cuando: string; anyo: number }): HojaNueva {
  const { cuando, anyo } = opciones
  const deEsteAnyo = hojasDelAnyo(anyo)
  const delAnterior = hojasDelAnyo(anyo - 1)
  const arranque = arranqueDelAnyo(anyo)

  const entradas: Array<[string, string]> = [
    [
      'Qué es este libro',
      'El inventario de aulas y salas de reunión y el almacén de material. Es la misma información que tiene la aplicación «Mantenimiento de Aulas»: se sincronizan en las dos direcciones desde Datos → Excel.',
    ],
    [
      'Cabeceras',
      'Las cabeceras de la fila 1 son el contrato con la aplicación. No las cambies ni insertes columnas en medio: si una no cuadra, la sincronización se niega a empezar y dice cuál.',
    ],
    [
      'Colores de cabecera',
      'Azul oscuro: columna que se puede editar aquí. Azul claro en cursiva: columna que escribe la aplicación; lo que se teclee ahí se pierde en la siguiente sincronización. Gris: hoja de apoyo de la aplicación, solo para consultar.',
    ],
    [
      'Orden de pestañas',
      `Primero las hojas que se editan a mano (${ESTADO.nombre}, ${deEsteAnyo.material}, ${deEsteAnyo.bolsa}, ${deEsteAnyo.pcs} y las del año anterior). Después las hojas de datos de la aplicación, con la pestaña azul claro (Revisiones, Movimientos de Almacén, Inventario por Sala). Al final, con la pestaña gris, las de apoyo (Sincronización, Léeme, Cambios…). El libro se abre siempre en la hoja de estado.`,
    ],
    [
      'Tablas y filtros',
      'Las hojas de datos de la aplicación son tablas de Excel con las filas en bandas: se filtran y ordenan desde la cabecera y las fórmulas pueden llamarlas por su nombre (Revisiones, MovimientosDeAlmacen, InventarioPorSala). Las hojas que se editan a mano llevan autofiltro y bandas, pero no son tablas: una tabla no admite celdas combinadas ni filas de totales.',
    ],
    [
      ESTADO.nombre,
      'Una fila por sala, con edificio y planta en todas las filas para poder filtrar. «Ref» es la matrícula de la sala en la aplicación: no la toques. Una sala nueva se añade sin Ref y la aplicación pregunta al sincronizar. «Fecha Revisión» escrita a mano crea una revisión sin autor. «% Lámparas» es fracción (0,86 = 86 %). Altavoces, Cámara y Microfono Jabra los escribe la aplicación desde su inventario.',
    ],
    [
      deEsteAnyo.material,
      `Un parte por fila. Los partes nuevos se escriben sin «N.º Incidencia»: lo pone la base. «Material Usado» se escribe «cantidad artículo» separados por coma, con el nombre de la ${deEsteAnyo.bolsa} (o su alias). Un 0 delante significa «apuntado pero no descontado del almacén»: material reciclado, de garantía o de stock antiguo. En «Aula», «Varias aulas» o «Almacén» significa que el parte no es de ninguna sala y la aplicación no lo pregunta.`,
    ],
  ]

  if (arranque) {
    entradas.push([
      `El recuento arranca el ${fechaLarga(arranque)}`,
      `La aplicación tomó el almacén ese día con lo que decía «Total Comprado» como saldo de partida. Los meses anteriores de la ${deEsteAnyo.bolsa} no los toca, y los partes anteriores a esa fecha se leen y se guardan pero no descuentan del almacén. Desde entonces, la Bolsa y los partes cuadran entre sí y con la aplicación.`,
    ])
  }

  entradas.push(
    [
      deEsteAnyo.bolsa,
      `Un artículo por fila. «Total Comprado» se escribe a mano: lo que había al arrancar más lo comprado después. Los meses los escribe la aplicación sumando los partes. «Total Instalado» y «Stock Disponible» son fórmulas. La última columna es el otro nombre (alias) del artículo: de ahí salen los alias, no la reescribas. Si al sincronizar se elige «Manda el Excel», la aplicación ajusta su almacén al «Stock Disponible» de esta hoja. Un artículo retirado del almacén en la aplicación sale de esta hoja en la siguiente sincronización (el parte dice qué llevaba su fila); para volver a llevarlo, se restaura en Datos → Almacén.`,
    ],
    [
      deEsteAnyo.pcs,
      'Los ordenadores de repuesto, uno por número de serie. «Situación» la escribe la aplicación: en almacén, instalado en qué aula y desde cuándo, o baja.',
    ],
    [
      `${delAnterior.material} y ${delAnterior.bolsa}`,
      'Cerradas: la aplicación las lee (alias, saldo de apertura) y no las escribe.',
    ],
    [
      'Revisiones',
      'Una fila por revisión, de la más antigua a la más reciente, con la fecha y la hora en columnas separadas para poder filtrar por día. Se cruza con la hoja de estado por «Ref» (BUSCARV). En rojo, las que salieron con incidencias; en verde, las que salieron bien; en gris, las que no se terminaron.',
    ],
    [
      'Movimientos de Almacén',
      'Una fila por entrada o salida de material, de la más antigua a la más reciente, y detrás de cada una el saldo que quedaba de ese artículo. El parte que gastó el material va en «Incidencia» (I…) o en «Solicitud» (S…), según lo que sea. Las compras en verde; las devoluciones y los ajustes en ámbar.',
    ],
    [
      'Inventario por Sala',
      'Una fila por aparato instalado, por edificio, planta y aula. «Tipo de equipo» habla como la hoja de estado (TV, Monitor, Ordenador…); «Nombre en la app» solo se rellena cuando la aplicación lo llama de otra forma (por ejemplo «Ordenador Tiny»). Un aparato que ya no está instalado sale en gris. Se cruza con la hoja de estado por «Ref».',
    ],
    [
      'Sincronización',
      'Lo que la última sincronización no pudo decidir, con su hoja y su celda: en rojo los choques y lo pendiente de decidir; en ámbar las celdas que no se pudieron leer y las filas sin cruzar; y como aviso lo que la pasada hizo por su cuenta. Se rehace entera en cada pasada: es lo pendiente hoy, no un historial.',
    ],
    [
      'Hacer el libro de hoy',
      'En la aplicación, Datos → Excel, la tarjeta «El libro para SharePoint» dice cuánto ha cambiado la aplicación desde el último libro. «Hacer el libro de hoy» lo pone al día con la base y lo deja listo para descargar, siempre con «Manda la aplicación»: la copia salió de la aplicación y no trae nada del Excel que pueda mandar. Para que mande el Excel hay que subir el libro de SharePoint de nuevo. Lo que la pasada preguntaría se deja como está y se dice cuántas cosas fueron.',
    ],
    [
      'Cambios…',
      'Las hojas cuyo nombre empieza por «Cambios» son la lista, celda a celda, de lo que se corrigió en el libro al reformatearlo, con el motivo. No se editan.',
    ],
    ['', `Generado por la aplicación el ${cuando}; se rehace en cada sincronización.`],
  )

  const filas: ValorCelda[][] = [['Material de aulas y salas de reunión — cómo usar este libro', null], [null, null]]
  const estilos: Record<string, ClaveDeEstilo> = { A1: 'titulo', B1: 'textoSinBorde' }
  const altos: Record<number, number> = { 1: 24 }

  for (const [etiqueta, texto] of entradas) {
    filas.push([etiqueta, texto])
    const fila = filas.length
    estilos[`A${fila}`] = 'etiqueta'
    estilos[`B${fila}`] = 'textoSinBorde'
    altos[fila] = altoDeFila(texto)
  }

  return {
    nombre: 'Léeme',
    filas,
    anchos: [34, ANCHO_DEL_TEXTO],
    inmovilizar: false,
    autofiltro: false,
    estilos,
    altos,
    caracter: 'discreta',
    tabla: false,
  }
}

/**
 * Alto de una fila del Léeme: Excel no ajusta solo el alto de una celda con
 * texto ajustado cuando la escribe un programa, así que se calcula a ojo, a
 * unos 15 puntos por cada línea de texto que quepa en el ancho de la columna.
 */
function altoDeFila(texto: string): number {
  const lineas = Math.max(1, Math.ceil(texto.length / ANCHO_DEL_TEXTO))
  return Math.max(15, lineas * 15)
}

const MESES_LARGOS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
]

/** `2026-08-01` → `1 de agosto de 2026`, que es como se dice una fecha en un Léeme. */
function fechaLarga(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  return `${Number(m[3])} de ${MESES_LARGOS[Number(m[2]) - 1] ?? m[2]} de ${m[1]}`
}

// -----------------------------------------------------------------------------

/** `{ 4: 'fecha' }` → el array de formatos que espera `HojaNueva`. */
function formatos(porIndice: Record<number, Formato>): Array<Formato | undefined> {
  const maximo = Math.max(...Object.keys(porIndice).map(Number))
  const out = new Array<Formato | undefined>(maximo + 1).fill(undefined)
  for (const [i, f] of Object.entries(porIndice)) out[Number(i)] = f
  return out
}
