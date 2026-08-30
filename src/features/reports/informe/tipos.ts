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
  registros: number
  incidencias: number
  solicitudes: number
  observaciones: number
  gravedadAlta: number
  resueltas: number
  materialConsumido: number
}

/** La foto de hoy. No depende del periodo y por eso se cuenta aparte. */
export interface Situacion {
  salasTotal: number
  incidenciasAbiertas: number
  estancadas: number
  lamparasAlLimite: number
  salasSinRevisarHace6Meses: number
  salasNuncaRevisadas: number
  articulosBajoMinimo: number
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
  materiales: Array<{ name: string; unidad: string; consumido: number; incidencias: number }>

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
  /**
   * Cuántas se quitaron a mano al pedir el informe.
   *
   * Se cuenta aparte de las que no caben porque no es lo mismo: una es el tope
   * del documento y la otra es una decisión de quien lo pide. El pie las dice
   * por separado — un documento que se archiva tiene que poder explicar por qué
   * no está la foto que alguien busca.
   */
  fotosDescartadas: number
  reincidentes: Array<{ building: string; room: string; item: string; veces: number }>
  olvidadas: Array<{ building: string; room: string; dias: number | null }>
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
