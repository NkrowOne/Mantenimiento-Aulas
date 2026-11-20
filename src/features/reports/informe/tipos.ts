/**
 * La forma del expediente de un informe.
 *
 * Vive aparte de quien lo rellena (`datos.ts`) y de quien lo lee
 * (`analisis.ts`, `plantilla.ts`) para que esos dos últimos no sepan nada de
 * dónde salen las cifras. Es lo que permite probarlos con un expediente escrito
 * a mano, sin base de datos y sin red.
 *
 * Es el mismo contrato que usaba el worker de informes en `data.ts`: los
 * nombres de campo se conservan uno a uno, así que un informe generado aquí y
 * uno generado allí dicen exactamente lo mismo.
 */

import type { Rango } from '../periodos'

export type Periodo = Rango

/** Lo que se puede contar dentro de un periodo. Se calcula dos veces: ahora y antes. */
export interface Contadores {
  revisiones: number
  salasRevisadas: number
  /** Revisiones que salieron sin ninguna incidencia. Solo dice algo si hubo revisiones. */
  revisionesSinIncidencias: number
  registros: number
  incidencias: number
  solicitudes: number
  observaciones: number
  gravedadAlta: number
  /** De las de gravedad alta que entraron en el periodo, las que ya están resueltas. */
  gravedadAltaResueltas: number
  resueltas: number
  /** Cierres hechos el mismo día —de Madrid— en que se abrió el parte. */
  resueltasEnElDia: number
  /**
   * Aulas distintas en las que el servicio hizo algo: un parte abierto o
   * cerrado, o material servido. Las revisiones no cuentan aquí —tienen su
   * cifra—: esto mide la atención del día a día, que es la que hay todas las
   * semanas.
   */
  salasAtendidas: number
  /** En cuántos edificios están esas aulas. */
  edificiosAtendidos: number
  materialConsumido: number
  /** Artículos distintos del almacén que se han usado. */
  articulosConsumidos: number
  /** Aulas distintas a las que ha ido ese material. */
  salasConMaterial: number
  /** Unidades que han entrado en el almacén: compras y devoluciones. */
  materialEntrado: number
}

/** La foto de hoy. No depende del periodo y por eso se cuenta aparte. */
export interface Situacion {
  salasTotal: number
  incidenciasAbiertas: number
  estancadas: number
  lamparasAlLimite: number
  articulosBajoMinimo: number
  /** Artículos activos del almacén, y cuántos de ellos tienen existencias hoy. */
  articulosEnAlmacen: number
  articulosConExistencias: number
  /** Ordenadores de repuesto disponibles en el almacén, por número de serie. */
  pcsDeRepuesto: number
}

export interface ReportData {
  kind: string
  period: Periodo
  anterior: Periodo
  /** El periodo escrito para una portada: «del 27 al 31 de julio de 2026». */
  periodoTexto: string
  /** Cómo se llama el tramo con el que se compara: «la semana anterior». */
  comparacionTexto: string
  dias: number

  ahora: Contadores
  antes: Contadores
  situacion: Situacion

  serieDiaria: Array<{ dia: string; revisiones: number; abiertas: number; resueltas: number }>
  porEdificio: Array<{
    code: string
    name: string
    salas: number
    revisadas: number
    abiertas: number
    /** Partes cerrados en el periodo en aulas de este edificio. */
    cerradas: number
    /** Aulas distintas del edificio con un parte abierto o cerrado, o con material servido. */
    atendidas: number
    pendientes: number
    /**
     * El edificio ya no está en la lista de trabajo, pero en el periodo pasaron
     * cosas en él. Sale con lo que pasó y marcado, porque un edificio archivado
     * con cuatro revisiones no es un edificio sin revisar.
     */
    archivado: boolean
  }>
  porTipo: Array<{ tipo: string; total: number }>
  porGravedad: Array<{ gravedad: string; total: number }>
  porMes: Array<{ month: string; total: number }>

  topSalas: Array<{
    building: string
    room: string
    name: string
    total: number
    fiabilidad: number | null
    hayDatos: boolean
  }>
  resolucion: {
    resueltas: number
    medianaDias: number | null
    mediaDias: number | null
    enMenosDe48h: number
    /**
     * Los mismos cierres, repartidos por lo que llevaron. Los cuatro tramos no
     * se pisan y suman `resueltas`: el mismo día de Madrid; otro día pero en
     * menos de 48 horas; hasta una semana; y más.
     */
    tramos: { mismoDia: number; hasta48h: number; hastaUnaSemana: number; mas: number }
  }
  lamparas: Array<{ building: string; room: string; horas: number | null; pct: number }>
  estancadas: Array<{
    ref: string | null
    titulo: string
    building: string
    room: string
    dias: number
    gravedad: string
  }>
  materiales: Array<{
    name: string
    unidad: string
    consumido: number
    incidencias: number
    /**
     * Lo que queda hoy en el almacén de ese artículo y su mínimo (0 es «sin
     * mínimo»). `null` cuando no se sabe: un artículo retirado no está en la
     * vista de existencias.
     */
    quedan: number | null
    minimo: number
  }>

  /**
   * El almacén, visto desde el periodo: lo que se movió y cómo queda hoy.
   *
   * Es el resumen que va en el documento. El detalle —cada movimiento con su
   * saldo, el stock al abrir y al cerrar el periodo y el stock de hoy— va en el
   * Excel que acompaña al informe, que es donde se filtra y se suma.
   */
  almacen: {
    /** Apuntes del periodo, del tipo que sean. */
    movimientos: number
    /** Unidades que salieron (consumo) y que entraron (compras y devoluciones). */
    salidas: number
    entradas: number
    /** Lo que hay que reponer, de menos a más margen. Vacío es buena noticia. */
    porReponer: Array<{ name: string; unidad: string; quedan: number; minimo: number }>
  }

  /**
   * El inventario que se ha tocado en el periodo: aulas cuyo inventario se
   * confirmó y aparatos que se instalaron, movieron o retiraron. Mantenerlo al
   * día es parte del encargo, y hasta ahora solo salía en el diario.
   */
  inventario: { confirmados: number; equipos: number }

  /**
   * Cada cierre del periodo, con sus dos fechas y lo que llevó.
   *
   * Es el desglose del que sale la mediana, y existe por separado porque
   * responde a otra pregunta. «La mitad se cierra en 1,4 días» describe; «esta
   * se abrió el martes a las 09:12, se cerró el 19 de agosto y llevó 24 días,
   * porque hubo que pedir la lámpara» justifica. Lo primero se lee en una
   * reunión; lo segundo es lo que hace falta cuando alguien pregunta por una en
   * concreto.
   */
  cierres: Array<{
    ref: string | null
    /** De qué incidencia es. Lo usa `cierres.ts` para separar los del rayo. */
    incidencia?: string | null
    titulo: string
    building: string
    room: string
    /** `AAAA-MM-DD`, en hora de Madrid. */
    abierta: string
    horaAbierta: string
    cerrada: string
    horaCerrada: string
    /** Días con decimales: la plantilla decide cómo escribirlo. */
    dias: number
    resolucion: string | null
    quien: string | null
  }>
  cierresTotal: number

  /**
   * Las fotos del periodo, ya dentro del documento como `data:`.
   *
   * No como enlace: el informe se archiva y se abre años después, y un enlace
   * firmado caduca en un minuto. Si la foto no viaja dentro, el documento de
   * mañana tiene un hueco donde hoy hay una prueba.
   */
  fotos: Array<{
    dia: string
    hora: string
    building: string
    room: string
    titulo: string
    ref: string | null
    /**
     * En qué momento se hizo, que es lo que la convierte en prueba.
     *
     * `revision` la hizo quien revisaba el aula —el problema recién
     * encontrado—, `cierre` es la de la incidencia ya resuelta —el después— y
     * `apertura` es la de una incidencia que sigue abierta. Una foto sin decir
     * de cuándo es no demuestra nada: la misma imagen vale para «así estaba» y
     * para «así lo dejamos».
     */
    momento: 'revision' | 'apertura' | 'cierre'
    /** `data:image/jpeg;base64,…` */
    datos: string
  }>
  fotosTotal: number
  reincidentes: Array<{ building: string; room: string; item: string; veces: number }>
  equipo: Array<{ nombre: string; revisiones: number; registros: number }>

  /**
   * Cada revisión hecha en el periodo, con su sala, su hora y su resultado.
   *
   * Es el registro del trabajo, no un agregado: «31 revisiones» dice cuánto se
   * hizo y no dice qué se hizo. Quien quiere saber si se pasó por el CRAI el
   * martes necesita las filas, no el total.
   */
  revisiones: Array<{
    dia: string
    hora: string
    building: string
    room: string
    name: string
    quien: string | null
    resultado: string
    fallos: number
    aperturas: number
  }>
  /** Cuántas hubo en total, para decirlo cuando la tabla se corta. */
  revisionesTotal: number

  /** Todo lo demás que pasó, en orden: altas, cierres, material, inventarios, equipos. */
  eventos: Array<{
    dia: string
    hora: string
    tipo: string
    subtipo: string
    /**
     * De qué incidencia es la fila, en las aperturas y los cierres.
     *
     * La apertura y el cierre del rayo son dos filas con el mismo texto, y es
     * lo único que las une: `cierres.ts` las reescribe juntas.
     */
    incidencia?: string | null
    titulo: string
    detalle: string | null
    cantidad: number | null
    ref: string | null
    building: string
    room: string
    quien: string | null
  }>
  eventosTotal: number

  /** Registros del periodo cuya sala no se pudo identificar (el histórico importado los trae). */
  sinSala: number

  /**
   * Salas del periodo que ya no están en la lista de trabajo.
   *
   * Archivadas ellas, o archivado su edificio. Su trabajo se cuenta entero
   * —archivar limpia la pantalla de revisar, no el pasado— pero el documento
   * tiene que decirlo: si no, el mismo edificio sale en el informe y no sale en
   * la aplicación, y quien compara las dos cosas concluye que una de las dos
   * miente.
   */
  salasArchivadas: number
}
