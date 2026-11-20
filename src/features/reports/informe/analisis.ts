/**
 * Lo que el informe DICE, separado de lo que el informe ENSEÑA.
 *
 * La regla que ordena este fichero, y la que hace que se pueda firmar un
 * documento generado con ayuda de un modelo:
 *
 *   **Las cifras se calculan aquí. La IA solo escribe la prosa.**
 *
 * Ni un número del informe sale de un modelo de lenguaje. Los indicadores, las
 * variaciones, los umbrales y los avisos se calculan con las reglas de abajo,
 * que son cuatro operaciones sobre lo que devolvió Postgres y se pueden seguir
 * a mano. Lo que se le pide a Gemini es lo que un modelo hace bien y una
 * plantilla hace mal: elegir qué es lo importante de esta semana y contarlo en
 * español legible, sin repetir el mismo párrafo cincuenta viernes seguidos.
 *
 * De ahí que este módulo tenga dos salidas:
 *
 *   `indicadores()` y `senales()`   Los hechos. Siempre deterministas, siempre
 *                                   presentes, con IA o sin ella.
 *   `lecturaCalculada()`            La redacción de respaldo. Se usa cuando no
 *                                   hay clave de Gemini, cuando la petición
 *                                   falla y cuando alguien pide el informe sin
 *                                   IA. No es un mensaje de error: es un texto
 *                                   que se puede leer y archivar tal cual.
 *
 * DE QUÉ HABLA EL INFORME, que es lo que cambió y por qué.
 *
 * El informe medía el servicio por la ronda de revisión: «revisiones» era la
 * primera cifra, la entradilla abría con el porcentaje del campus revisado y la
 * primera recomendación era ampliar la ronda. Pero la revisión de aulas no es
 * trabajo de todas las semanas: se hace en campañas —antes de empezar el curso,
 * en Navidad y en Semana Santa, que es además lo que dice el pliego—. Así que
 * una semana cualquiera, con catorce partes atendidos y doce resueltos, se
 * titulaba «Cero salas revisadas» y cerraba pidiendo reforzar una ronda que no
 * tocaba hacer. El documento contaba como falta lo que era el calendario.
 *
 * Ahora el informe habla de lo que el servicio hace todos los días: los partes
 * que entran y los que se resuelven, lo rápido que se cierran, las aulas en las
 * que se ha trabajado, el material que se ha servido y cómo queda el almacén.
 * Las revisiones salen cuando las hay, como lo que son —una puesta a punto
 * hecha—, y cuando no las hay no se nombran: no hay «0 %», ni «salas sin
 * revisar», ni vuelta al campus pendiente.
 *
 * Y SE ABRE POR LO CONSEGUIDO, para las dos audiencias. No es maquillaje: cada
 * buena noticia lleva su cifra al lado, y lo que pide una decisión —una
 * incidencia de gravedad alta en curso, una lámpara a punto de fundirse, un
 * artículo por reponer— sigue saliendo, con la suya. Lo que cambia es el orden
 * y el tono: primero lo hecho, después lo que conviene hacer.
 *
 * Y NO SE INVENTAN MEJORAS. Esto es una universidad: los cables, los
 * adaptadores, las pilas y los mandos se gastan y se rompen con el uso, o los
 * rompen. Que el mismo repuesto vuelva a la misma aula es consumo, no un fallo
 * de la instalación; y que el edificio más grande sea el que más partes abre
 * no es una causa común que investigar. El informe decía las dos cosas como
 * hallazgos y las convertía en propuestas —«revisar la instalación de H 2.1 en
 * vez de reponer el cable otra vez»—, que es recomendarle al cliente un
 * trabajo que no hay que hacer. Lo que se propone ahora son los pasos
 * siguientes del propio servicio, cuando los hay: reponer lo que baja del
 * mínimo, cambiar una lámpara antes de que se funda, atender primero lo grave.
 * Si no hay ninguno, no hay sección.
 *
 * Las dos audiencias siguen sin ser el mismo documento:
 *
 *   `equipo`      El parte del servicio. Lleva además la lista de lo que sigue
 *                 abierto con sus días, que es con lo que se trabaja el lunes.
 *   `direccion`   Lo que se le entrega al cliente. NO dice cuántos días lleva
 *                 abierta nada ni señala una sala como problemática: hay aulas
 *                 difíciles, y eso no es noticia para quien dirige un campus.
 */

import type { ReportData } from './tipos'

export type Tono = 'neutro' | 'ok' | 'aviso' | 'critico'

/** Para quién se escribe. Cambia la voz y lo que se cuenta; nunca una cifra. */
export type Audiencia = 'direccion' | 'equipo'

/**
 * Lo que este informe ha decidido NO contar.
 *
 * «Cuánto se tarda en cerrar» es una sección que se puede desmarcar, y la
 * casilla promete que entonces el informe no da ese número. Antes lo cumplía la
 * sección y no el resto: la mediana se quitaba de su tabla y seguía saliendo en
 * los hallazgos. Con esto, quien desmarca los tiempos no los encuentra en la
 * cabecera, ni en el titular, ni en el análisis.
 */
export interface QueSeCuenta {
  tiempos?: boolean
}

export interface Delta {
  /** Diferencia absoluta contra el mismo tramo anterior. */
  valor: number
  /** Variación relativa, o `null` si antes era cero y no hay porcentaje que valga. */
  pct: number | null
  /** Si subir es una buena noticia. Cambia la flecha y el color, no el número. */
  subirEsBueno: boolean
  /**
   * La variación no es ni buena ni mala y se enseña sin color. Es el caso de
   * los partes que entran: que entren más no es peor —es que se está usando el
   * servicio— y que entren menos no es mérito de nadie.
   */
  neutra?: boolean
}

export interface Indicador {
  etiqueta: string
  valor: string
  detalle: string
  delta: Delta | null
  tono: Tono
}

/** Un hecho que merece salir en el informe, con su cifra y su gravedad. */
export interface Senal {
  clave: string
  titulo: string
  cuerpo: string
  tono: Tono
  /** 0 = lo primero que se lee. Ordena los hallazgos y las recomendaciones. */
  peso: number
  accion?: string
}

/**
 * De qué clase es un hallazgo. Lo pinta la plantilla: un logro lleva su marca
 * de hecho y lo que está en seguimiento la suya. No es un semáforo —ninguno va
 * en rojo—, es la diferencia entre «esto ha salido» y «esto conviene mirarlo».
 */
export type ClaseDeHallazgo = 'logro' | 'seguimiento'

export interface Lectura {
  titular: string
  entradilla: string
  hallazgos: Array<{ titulo: string; cuerpo: string; clase?: ClaseDeHallazgo }>
  recomendaciones: Array<{ accion: string; porque: string }>
  /**
   * De dónde salió la prosa.
   *
   * NO se imprime en el PDF: va a `reports.params` y a la pantalla de Informes.
   * El documento habla del campus, no de cómo se preparó; el archivo sí tiene
   * que poder decirlo, para eso está.
   */
  origen: string
}

// ── Aritmética menuda, con nombre para que las reglas se lean ────────────────

export function delta(ahora: number, antes: number, subirEsBueno = true): Delta {
  return {
    valor: ahora - antes,
    /*
     * El porcentaje solo cuando la base da para uno. De 1 a 13 son «+1200 %»,
     * que es aritméticamente cierto y periodísticamente falso: sugiere una
     * transformación cuando lo que hubo fue una semana de vacaciones. Por debajo
     * de cinco se enseña la diferencia y nada más.
     */
    pct: antes < 5 ? null : Math.round(((ahora - antes) / antes) * 100),
    subirEsBueno,
  }
}

/**
 * Redondear a entero convierte un 0,4 % en «0 %», que se lee como «nada» cuando
 * en realidad sí hubo trabajo. Por debajo del 1 % se dice así.
 */
export function porcentaje(parte: number, total: number): string {
  if (!total) return '—'
  const v = (parte / total) * 100
  if (v === 0) return '0 %'
  if (v < 1) return '<1 %'
  return `${Math.round(v)} %`
}

/** `1 sala` / `2 salas`. Un informe serio no dice «1 salas». */
export function plural(n: number, singular: string, formaPlural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : formaPlural}`
}

/** «3,5 días» con coma decimal, que es como se escribe en español. */
export function dias(v: number | null): string {
  if (v === null) return '—'
  // Menos de una hora es «el mismo día»: el histórico importado trae partes
  // cerrados en el mismo instante en que se abrieron, y «0 h» se lee como un
  // error de cálculo en vez de como lo que es.
  if (v * 24 < 1) return 'el mismo día'
  if (v < 1) return `${Math.round(v * 24)} h`
  return `${String(Math.round(v * 10) / 10).replace('.', ',')} días`
}

/**
 * Un titular no empieza con una cifra.
 *
 * «12 partes resueltos…» es lo que escribe una máquina; «Doce partes
 * resueltos…» es lo que escribe alguien. Solo hasta doce y solo al principio:
 * más allá, la cifra se lee mejor que la palabra. El uno concuerda con lo que
 * cuenta —«Un parte», «Una incidencia»— y por eso hay que decirle el género.
 */
const PALABRAS = [
  'cero',
  'un',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
  'once',
  'doce',
]

export function enPalabras(frase: string, genero: 'm' | 'f' = 'f'): string {
  const m = /^(\d{1,2})\s/.exec(frase)
  if (!m) return frase
  const n = Number(m[1])
  const palabra = n === 1 && genero === 'f' ? 'una' : PALABRAS[n]
  if (!palabra) return frase
  return palabra.charAt(0).toUpperCase() + palabra.slice(1) + frase.slice(m[1]!.length)
}

/** «9 incidencias, 4 solicitudes y 1 observación»: una lista como se dice hablando. */
function lista(partes: string[]): string {
  if (partes.length <= 1) return partes.join('')
  return `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1]}`
}

/** «en 11 aulas de 4 edificios», o nada si no se sabe dónde. */
function donde(salas: number, edificios: number): string {
  if (salas <= 0) return ''
  return ` en ${plural(salas, 'aula')}${edificios > 1 ? ` de ${edificios} edificios` : ''}`
}

/**
 * ¿Se cierra deprisa? Con tres cierres o más —por debajo, «dos de dos el mismo
 * día» es una anécdota y no un ritmo— y al menos la mitad dentro del plazo.
 */
function ritmo(d: ReportData): { enElDia: boolean; en48h: boolean } {
  const r = d.resolucion
  const basta = r.resueltas >= 3
  return {
    enElDia: basta && r.tramos.mismoDia * 2 >= r.resueltas,
    en48h: basta && r.enMenosDe48h * 2 >= r.resueltas,
  }
}

/** «la mitad, en 5 h o menos», o «la mitad, en menos de una hora». */
function laMitad(mediana: number | null): string {
  if (mediana === null) return ''
  return mediana * 24 < 1 ? 'la mitad, en menos de una hora' : `la mitad, en ${dias(mediana)} o menos`
}

/**
 * Los cuatro números de cabecera.
 *
 * Son cuatro y no ocho a propósito: una tira de ocho indicadores no se lee, se
 * hojea. Y son los cuatro que se le preguntan a cualquier servicio de soporte:
 * cuánto ha entrado, cuánto se ha resuelto, con qué rapidez y qué queda en
 * curso. Lo que no cabe aquí está en las tablas, que es donde se va a buscar el
 * detalle cuando uno de estos cuatro llama la atención.
 *
 * Las revisiones ya no son una de las cuatro. Una cifra de cabecera es la que
 * se mira todas las semanas, y la ronda de revisión se hace tres veces al año:
 * en las otras cuarenta y nueve semanas esa casilla enseñaba un cero.
 */
export function indicadores(d: ReportData, audiencia: Audiencia, o: QueSeCuenta = {}): Indicador[] {
  const dir = audiencia === 'direccion'
  const tiempos = o.tiempos !== false
  const a = d.ahora
  const r = d.resolucion
  const saldo = a.resueltas - a.registros

  const tipos = [
    a.incidencias && `${a.incidencias} incid.`,
    a.solicitudes && `${a.solicitudes} solic.`,
    a.observaciones && `${a.observaciones} observ.`,
  ]
    .filter(Boolean)
    .join(' · ')

  const rapidez: Indicador = tiempos
    ? {
        etiqueta: 'En menos de 48 h',
        valor: r.resueltas ? porcentaje(r.enMenosDe48h, r.resueltas) : '—',
        detalle: r.resueltas
          ? [`${r.enMenosDe48h} de ${plural(r.resueltas, 'cierre')}`, laMitad(r.medianaDias)]
              .filter(Boolean)
              .join(' · ')
          : 'sin cierres que medir',
        // No se compara: el tramo anterior no trae sus tiempos, y una flecha sin
        // dato detrás es peor que ninguna flecha.
        delta: null,
        tono: r.resueltas > 0 && r.enMenosDe48h * 2 >= r.resueltas ? 'ok' : 'neutro',
      }
    : {
        // Sin tiempos, la tercera cifra es dónde se ha trabajado: el informe no
        // se queda con un hueco en la cabecera por no dar la mediana.
        etiqueta: 'Aulas atendidas',
        valor: String(a.salasAtendidas),
        detalle:
          a.edificiosAtendidos > 0
            ? `en ${plural(a.edificiosAtendidos, 'edificio')}`
            : 'con un parte o con material',
        delta: delta(a.salasAtendidas, d.antes.salasAtendidas, true),
        tono: 'neutro',
      }

  return [
    {
      etiqueta: 'Partes atendidos',
      valor: String(a.registros),
      detalle:
        a.registros === 0
          ? 'ninguno nuevo en el periodo'
          : // Con los tiempos en la cabecera, aquí va el dónde; sin ellos el
            // dónde ya tiene su casilla y aquí va de qué clase son.
            tiempos && a.salasAtendidas > 0
            ? donde(a.salasAtendidas, a.edificiosAtendidos).trim()
            : tipos,
      delta: { ...delta(a.registros, d.antes.registros, true), neutra: true },
      tono: 'neutro',
    },
    {
      etiqueta: 'Resueltos',
      valor: String(a.resueltas),
      detalle:
        a.resueltas === 0
          ? 'sin cierres en el periodo'
          : a.registros === 0
            ? 'y ninguno nuevo'
            : saldo > 0
              ? `${saldo} más de los que entraron`
              : saldo === 0
                ? 'los mismos que entraron'
                : `${porcentaje(a.resueltas, a.registros)} de lo que entró`,
      delta: delta(a.resueltas, d.antes.resueltas, true),
      /*
       * UN CERO NUNCA VA EN VERDE.
       *
       * Con el periodo vacío, «resueltos ≥ entrados» se cumple —cero menos
       * cero— y el indicador pintaba un 0 de «bien». Es el peor fallo posible en
       * un documento de supervisión, porque parece una buena noticia. Sin
       * trabajo que medir, el tono es neutro.
       */
      tono: a.resueltas === 0 ? 'neutro' : 'ok',
    },
    rapidez,
    /*
     * La cuarta cifra cambia de voz con la audiencia. Al equipo se le dice
     * cuántas llevan más de una semana, porque es lo que tiene que mirar hoy. A
     * dirección se le da el saldo y nada más: el número de días de una
     * incidencia abierta no es un dato que le sirva para decidir nada, y sí es
     * el que convierte un aula difícil en un reproche.
     */
    {
      etiqueta: 'En seguimiento hoy',
      valor: String(d.situacion.incidenciasAbiertas),
      detalle: dir
        ? d.situacion.incidenciasAbiertas > 0
          ? 'trabajo en curso'
          : 'ninguna incidencia abierta'
        : d.situacion.estancadas > 0
          ? `${d.situacion.estancadas} de más de 7 días`
          : d.situacion.incidenciasAbiertas > 0
            ? 'ninguna de más de 7 días'
            : 'ninguna incidencia abierta',
      // La foto de hoy no se compara con nada: es un saldo, no un flujo.
      delta: null,
      tono: dir
        ? d.situacion.incidenciasAbiertas > 0
          ? 'neutro'
          : 'ok'
        : d.situacion.estancadas > 0
          ? 'critico'
          : d.situacion.incidenciasAbiertas > 0
            ? 'neutro'
            : 'ok',
    },
  ]
}

/**
 * Lo que ha ido bien, con su cifra.
 *
 * Es lo primero que se lee del documento, y lo que hace que lo pendiente se lea
 * como trabajo en curso y no como una lista de faltas. Cada una se apoya en un
 * recuento que está impreso al lado: sin cifra no hay buena noticia, hay
 * adjetivos. Y ninguna se dispara con el periodo vacío — un cero no se celebra.
 *
 * Van por orden de lo que más le importa a quien recibe el servicio: que se
 * resuelve, que se resuelve pronto, que lo grave está atendido; y después con
 * qué se ha hecho y qué queda preparado.
 */
export function senalesBuenas(d: ReportData, audiencia: Audiencia = 'direccion', o: QueSeCuenta = {}): Senal[] {
  const dir = audiencia === 'direccion'
  const tiempos = o.tiempos !== false
  const s: Senal[] = []
  const a = d.ahora
  const r = d.resolucion
  const saldo = a.resueltas - a.registros

  if (a.resueltas > 0 && saldo > 0) {
    s.push({
      clave: 'saldo-positivo',
      titulo: 'Se resuelve más de lo que entra',
      cuerpo:
        a.registros === 0
          ? `${plural(a.resueltas, 'parte resuelto', 'partes resueltos')} y ninguno nuevo en el periodo: la cola de trabajo baja.`
          : `${plural(a.resueltas, 'parte resuelto', 'partes resueltos')} por ${plural(a.registros, 'nuevo', 'nuevos')} en el periodo: la cola de trabajo baja.`,
      tono: 'ok',
      peso: 0,
    })
  } else if (a.resueltas > 0 && saldo === 0) {
    s.push({
      clave: 'al-dia',
      titulo: 'Se resuelve al mismo ritmo que entra',
      cuerpo: `${plural(a.resueltas, 'parte resuelto', 'partes resueltos')} y ${plural(a.registros, 'nuevo', 'nuevos')} en el periodo: la cola de trabajo no crece.`,
      tono: 'ok',
      peso: 0,
    })
  }

  const ritmoDeCierre = ritmo(d)
  if (tiempos && ritmoDeCierre.en48h) {
    const todosEnElDia = r.tramos.mismoDia === r.resueltas
    const mitad = laMitad(r.medianaDias)
    s.push({
      clave: 'resolucion-rapida',
      titulo: ritmoDeCierre.enElDia
        ? todosEnElDia
          ? `Los ${r.resueltas} cierres, el mismo día en que entró el aviso`
          : `${r.tramos.mismoDia} de ${r.resueltas} cierres, el mismo día`
        : `${r.enMenosDe48h} de ${r.resueltas} cierres, en menos de 48 horas`,
      cuerpo:
        [
          // Si el titular ya da los del mismo día, aquí va el dato que falta.
          ritmoDeCierre.enElDia && r.enMenosDe48h > r.tramos.mismoDia
            ? `En menos de 48 horas, ${r.enMenosDe48h} de ${r.resueltas}`
            : '',
          mitad ? `${mitad.charAt(0).toUpperCase()}${mitad.slice(1)} desde que entra el aviso` : '',
        ]
          .filter(Boolean)
          .join('. ') + '.',
      tono: 'ok',
      peso: 2,
    })
  }

  /*
   * La gravedad alta, cuando ya está resuelta, es de las mejores noticias que
   * puede dar el documento: es lo que impedía dar una clase. Y cuando no ha
   * habido ninguna, también. Lo que quede en curso sale abajo, en `senales()`,
   * y con el mismo tono para todo el mundo.
   */
  if (a.gravedadAlta > 0 && a.gravedadAltaResueltas >= a.gravedadAlta) {
    s.push({
      clave: 'gravedad-resuelta',
      titulo:
        a.gravedadAlta === 1
          ? 'La incidencia de gravedad alta, resuelta'
          : `Las ${a.gravedadAlta} incidencias de gravedad alta, resueltas`,
      cuerpo: 'Gravedad alta es lo que impide dar una clase, y por eso se atiende por delante de todo lo demás.',
      tono: 'ok',
      peso: 3,
    })
  } else if (a.registros > 0 && a.gravedadAlta === 0) {
    s.push({
      clave: 'sin-gravedad-alta',
      titulo: 'Ninguna incidencia de gravedad alta',
      cuerpo: `De los ${plural(a.registros, 'parte')} del periodo, ninguno impide dar clase.`,
      tono: 'ok',
      peso: 3,
    })
  }

  if (d.antes.resueltas > 0 && a.resueltas > d.antes.resueltas) {
    const dv = delta(a.resueltas, d.antes.resueltas)
    s.push({
      clave: 'mas-cierres',
      titulo: `Más cierres que ${d.comparacionTexto}`,
      cuerpo: `${a.resueltas} frente a ${d.antes.resueltas}${dv.pct !== null ? ` (+${dv.pct} %)` : ''}.`,
      tono: 'ok',
      peso: 4,
    })
  }

  /*
   * Las revisiones, cuando las hay. Se cuentan como lo que son —una puesta a
   * punto hecha— y sin denominador: no hay «del campus» ni vuelta pendiente,
   * porque la ronda es de campaña y no de todas las semanas. Y van arriba, por
   * delante de la rapidez: la semana de la campaña es la noticia de esa semana.
   */
  if (a.revisiones > 0) {
    s.push({
      clave: 'puesta-a-punto',
      titulo: `Puesta a punto: ${plural(a.salasRevisadas, 'aula revisada', 'aulas revisadas')}`,
      cuerpo:
        `${plural(a.revisiones, 'revisión completada', 'revisiones completadas')} en el periodo` +
        (a.revisionesSinIncidencias > 0
          ? `, ${a.revisionesSinIncidencias === a.revisiones ? 'todas' : `${a.revisionesSinIncidencias} de ellas`} sin ninguna incidencia.`
          : '.'),
      tono: 'ok',
      peso: 1,
    })
  }

  if (a.salasAtendidas >= 3) {
    s.push({
      clave: 'alcance',
      titulo: `Servicio${donde(a.salasAtendidas, a.edificiosAtendidos)}`,
      cuerpo: 'Son las aulas con un parte atendido, un cierre o material instalado en el periodo.',
      tono: 'ok',
      peso: 5,
    })
  }

  if (a.materialConsumido > 0) {
    s.push({
      clave: 'material',
      titulo: `${plural(a.materialConsumido, 'unidad', 'unidades')} de material, servidas desde el almacén`,
      cuerpo:
        `${plural(a.articulosConsumidos, 'artículo distinto', 'artículos distintos')}` +
        `${a.salasConMaterial > 0 ? ` para ${plural(a.salasConMaterial, 'aula')}` : ''}. ` +
        'Tener la pieza a mano es lo que convierte una reparación en cosa de minutos.',
      tono: 'ok',
      peso: 6,
    })
  }

  if (d.situacion.articulosEnAlmacen > 0 && d.situacion.articulosBajoMinimo === 0) {
    s.push({
      clave: 'almacen-al-dia',
      titulo: 'Almacén al día: ningún artículo por debajo de su mínimo',
      cuerpo: `${d.situacion.articulosConExistencias} de ${plural(d.situacion.articulosEnAlmacen, 'artículo')} con existencias hoy.`,
      tono: 'ok',
      peso: 7,
    })
  }

  if (d.situacion.pcsDeRepuesto > 0) {
    s.push({
      clave: 'pcs-repuesto',
      // Con su plural dicho: el automático escribía «4 ordenadors».
      titulo: `${plural(d.situacion.pcsDeRepuesto, 'ordenador', 'ordenadores')} de repuesto en el almacén`,
      cuerpo: dir
        ? 'Listos para sustituir el ordenador de un aula el mismo día en que falla.'
        : 'Con imagen y número de serie, listos para instalar en un aula sin esperar compra.',
      tono: 'ok',
      peso: 8,
    })
  }

  if (d.inventario.equipos > 0 || d.inventario.confirmados > 0) {
    s.push({
      clave: 'inventario',
      titulo:
        d.inventario.equipos > 0
          ? `${plural(d.inventario.equipos, 'cambio', 'cambios')} de equipamiento, ya en el inventario`
          : `Inventario confirmado en ${plural(d.inventario.confirmados, 'aula')}`,
      cuerpo:
        (d.inventario.equipos > 0 && d.inventario.confirmados > 0
          ? `Además, se ha confirmado el inventario de ${plural(d.inventario.confirmados, 'aula')}. `
          : '') +
        'Cada aparato que se instala, se mueve o se retira queda apuntado con su aula y su número de serie.',
      tono: 'ok',
      peso: 9,
    })
  }

  return s
}

/**
 * Las reglas.
 *
 * Cada una responde a algo que se ha visto de verdad en estos datos, y cada una
 * dice su cifra: un aviso que no se puede comprobar no debería estar en un
 * informe. El peso ordena; lo que no dispara, no aparece — un informe con nueve
 * secciones fijas donde seis dicen «nada que señalar» enseña a no leerlo.
 *
 * Devuelve dos juegos en una sola lista: lo conseguido (`senalesBuenas()`, en
 * tono `ok`) y lo que está en seguimiento. El orden entre los dos depende de
 * para quién se escribe: a dirección se le abre por lo conseguido; al equipo,
 * por lo que tiene que hacer, que es a lo que viene. Y dos no salen para
 * dirección de ninguna forma: las incidencias que llevan más de una semana, que
 * son el «lleva N días abierta» que ese documento no dice, y los registros sin
 * sala, que son limpieza de datos del servicio y no un asunto del cliente.
 *
 * LO QUE YA NO ESTÁ, y por qué:
 *
 *  · La cobertura de la ronda («se ha pasado por el 2 % del campus», «a este
 *    ritmo una vuelta completa lleva dos años») y las salas sin una sola
 *    revisión. Eran ciertas y no decían nada: medían contra un calendario
 *    semanal un trabajo que se hace por campañas.
 *  · El mismo repuesto en la misma sala («el problema no es la pieza: revisa la
 *    instalación»). En un campus un cable HDMI se cambia cuatro veces en seis
 *    meses porque se usa, se tira de él y se rompe. Es desgaste, no una avería
 *    de fondo, y no hay instalación que revisar.
 *  · El edificio que concentra los partes («suele tener una causa común»). El
 *    edificio con más aulas y más clases abre más partes; el reparto ya se ve
 *    en su gráfico, sin que nadie le busque un porqué.
 *
 * Las dos últimas eran además las que más «propuestas de mejora» fabricaban, y
 * aquí no se propone lo que no hay que hacer.
 */
export function senales(d: ReportData, audiencia: Audiencia, o: QueSeCuenta = {}): Senal[] {
  const dir = audiencia === 'direccion'
  const tiempos = o.tiempos !== false
  const a = d.ahora
  const s: Senal[] = []

  if (d.situacion.estancadas > 0 && !dir) {
    const mayor = d.estancadas[0]
    s.push({
      clave: 'estancadas',
      titulo: `${plural(d.situacion.estancadas, 'incidencia')} sin cerrar desde hace más de una semana`,
      cuerpo: mayor
        ? `La más antigua lleva ${mayor.dias} días abierta: «${recorta(mayor.titulo, 60)}»${
            mayor.building !== '—' ? ` en ${mayor.building} ${mayor.room}`.trimEnd() : ''
          }.`
        : 'Ninguna se ha tocado en la última semana.',
      tono: 'critico',
      peso: 0,
      accion: 'Repasar la lista de las que llevan más de una semana y cerrar o reasignar cada una.',
    })
  }

  /*
   * Gravedad alta EN CURSO se dice a todo el mundo, y con el mismo tono. Es lo
   * que impide dar una clase: callárselo a dirección para que el informe quede
   * más bonito sería exactamente el informe que no se puede firmar.
   */
  const altaEnCurso = a.gravedadAlta - a.gravedadAltaResueltas
  if (altaEnCurso > 0) {
    const yaResueltas = a.gravedadAltaResueltas
    s.push({
      clave: 'gravedad',
      titulo: `${plural(altaEnCurso, 'incidencia')} de gravedad alta en curso`,
      cuerpo:
        (dir
          ? 'Gravedad alta es lo que impide dar la clase, y por eso se atiende por delante de todo lo demás.'
          : 'Gravedad alta es lo que impide dar la clase. Va primero, aunque sea lo más reciente.') +
        (yaResueltas > 0
          ? ` ${yaResueltas === 1 ? 'Otra del periodo ya está resuelta' : `Otras ${yaResueltas} del periodo ya están resueltas`}.`
          : ''),
      tono: 'critico',
      peso: 1,
      accion: 'Dar prioridad a las de gravedad alta: son las que afectan a la clase.',
    })
  }

  if (d.situacion.lamparasAlLimite > 0) {
    const peor = d.lamparas[0]
    s.push({
      clave: 'lamparas',
      titulo: dir
        ? `${plural(d.situacion.lamparasAlLimite, 'lámpara')} para cambiar antes de que se fundan`
        : `${plural(d.situacion.lamparasAlLimite, 'lámpara')} por debajo del 20 % de vida`,
      cuerpo: peor
        ? `La${dir ? ' más gastada' : ' peor'} está en ${peor.building} ${peor.room}, al ${Math.round(peor.pct * 100)} %` +
          `${peor.horas ? ` y con ${peor.horas} horas de proyector` : ''}. ` +
          'Sustituirlas antes de que se fundan cuesta lo mismo y no interrumpe una clase.'
        : 'Conviene pedirlas antes de que se funda la primera.',
      tono: 'aviso',
      peso: 3,
      accion: dir
        ? 'Pedir las lámparas de repuesto y cambiarlas fuera del horario de clase.'
        : 'Pedir lámparas de repuesto y planificar el cambio fuera de horario de clase.',
    })
  }

  if (d.situacion.articulosBajoMinimo > 0) {
    const cuales = d.almacen.porReponer.slice(0, 3).map((x) => x.name)
    const mas = d.situacion.articulosBajoMinimo - cuales.length
    s.push({
      clave: 'almacen',
      titulo: dir
        ? `${plural(d.situacion.articulosBajoMinimo, 'artículo')} por reponer en el almacén`
        : `${plural(d.situacion.articulosBajoMinimo, 'artículo')} bajo mínimo en el almacén`,
      cuerpo:
        (cuales.length
          ? `${lista(cuales)}${mas > 0 ? ` y ${mas} más` : ''}. `
          : '') +
        (dir
          ? 'Tener la pieza a mano es lo que convierte una reparación en cosa de minutos.'
          : 'Quedarse sin la pieza convierte una reparación de diez minutos en una semana de espera.'),
      tono: 'aviso',
      peso: 4,
      accion: dir
        ? 'Reponer lo que está por debajo del mínimo.'
        : 'Reponer lo que está por debajo del mínimo antes del próximo lunes.',
    })
  }

  /*
   * Al equipo se le da el tiempo de cierre también cuando no es para presumir:
   * es un dato de trabajo. A dirección solo cuando es una buena noticia —va
   * arriba, en `senalesBuenas()`—; el resto está en su sección, con sus cifras.
   */
  const r = d.resolucion
  if (!dir && tiempos && r.resueltas >= 3 && r.medianaDias !== null && !ritmo(d).en48h) {
    s.push({
      clave: 'resolucion',
      titulo: `La mitad se cierra en ${dias(r.medianaDias)} o menos`,
      cuerpo:
        `${r.enMenosDe48h} de ${r.resueltas} cerradas en menos de 48 horas` +
        (r.mediaDias !== null && r.mediaDias > r.medianaDias * 2
          ? `. La media sube a ${dias(r.mediaDias)} por unas pocas muy antiguas, ` +
            'que es justo lo que la mediana deja ver.'
          : '.'),
      tono: 'neutro',
      peso: 6,
    })
  }

  if (d.sinSala > 0 && !dir) {
    s.push({
      clave: 'sin-sala',
      titulo: `${plural(d.sinSala, 'registro')} sin sala identificada`,
      cuerpo:
        'Cuentan en los totales pero no en ningún edificio, así que no se pueden atender ' +
        'ni asignar. Suelen venir del histórico importado.',
      tono: 'neutro',
      peso: 7,
      accion: 'Asignar sala a los registros huérfanos desde la pantalla de datos.',
    })
  }

  /*
   * Sin nada de nada —ni partes, ni cierres, ni revisiones, ni material—, al
   * equipo se le recuerda lo único que puede estar fallando. A dirección no:
   * el titular y la entradilla ya dicen que el periodo ha sido tranquilo, y un
   * tercer aviso de lo mismo no añade nada.
   */
  if (!dir && a.registros === 0 && a.resueltas === 0 && a.revisiones === 0 && a.materialConsumido === 0) {
    s.push({
      clave: 'sin-actividad',
      titulo: 'Periodo sin avisos nuevos',
      cuerpo:
        'No ha entrado ningún parte. En un periodo no lectivo es lo habitual; en una semana de ' +
        'clase, comprueba que los dispositivos estén sincronizando.',
      tono: 'neutro',
      peso: 0,
    })
  }

  /*
   * Dos juegos, y el orden entre ellos es de quien lee: lo conseguido por
   * delante para dirección, lo que hay que hacer por delante para el equipo.
   * Diez de separación para que dentro de cada juego mande su propio peso.
   */
  const buenas = senalesBuenas(d, audiencia, o).map((x) => ({ ...x, peso: x.peso + (dir ? 0 : 10) }))
  const resto = s.map((x) => ({ ...x, peso: x.peso + (dir ? 10 : 0) }))
  return [...buenas, ...resto].sort((x, y) => x.peso - y.peso)
}

function recorta(t: string, n: number): string {
  const limpio = t.trim()
  return limpio.length <= n ? limpio : `${limpio.slice(0, n - 1)}…`
}

/**
 * El titular: lo que se ha hecho, con su cifra.
 *
 * Para las dos audiencias. Antes el del equipo abría por lo que faltaba —«Cuatro
 * incidencias llevan más de una semana abiertas»— y el de dirección, a falta de
 * otra cosa, por las salas revisadas, que en una semana normal eran cero. Lo
 * que sigue abierto no se esconde: tiene su cifra en la cabecera, su hallazgo y
 * su lista. Lo que no hace es titular el documento de una semana en la que se
 * han resuelto doce partes.
 */
export function titular(d: ReportData, o: QueSeCuenta = {}): string {
  const a = d.ahora
  const r = d.resolucion
  const tiempos = o.tiempos !== false
  const saldo = a.resueltas - a.registros
  const resueltos = plural(a.resueltas, 'parte resuelto', 'partes resueltos')
  const ritmoDeCierre = ritmo(d)

  if (a.registros === 0 && a.resueltas === 0) {
    if (a.revisiones > 0) {
      return enPalabras(`${plural(a.salasRevisadas, 'aula revisada', 'aulas revisadas')} en la puesta a punto`, 'f')
    }
    return 'Periodo tranquilo, sin avisos nuevos'
  }
  if (a.resueltas === 0) {
    return enPalabras(
      `${plural(a.registros, 'parte atendido', 'partes atendidos')}${donde(a.salasAtendidas, a.edificiosAtendidos)}`,
      'm',
    )
  }
  if (a.registros === 0) return enPalabras(`${resueltos} y ningún aviso nuevo`, 'm')
  if (saldo > 0) return enPalabras(`${resueltos}, ${saldo} más de los que entraron`, 'm')
  if (tiempos && ritmoDeCierre.enElDia) {
    return enPalabras(
      r.tramos.mismoDia === r.resueltas
        ? `${resueltos}, todos el mismo día`
        : `${resueltos}, ${r.tramos.mismoDia} de ellos el mismo día`,
      'm',
    )
  }
  if (tiempos && ritmoDeCierre.en48h) {
    return enPalabras(
      r.enMenosDe48h === r.resueltas
        ? `${resueltos}, todos en menos de 48 horas`
        : `${resueltos}, ${r.enMenosDe48h} de ellos en menos de 48 horas`,
      'm',
    )
  }
  return enPalabras(
    `${plural(a.registros, 'parte atendido', 'partes atendidos')} y ${a.resueltas} ${a.resueltas === 1 ? 'resuelto' : 'resueltos'}`,
    'm',
  )
}

/**
 * La redacción de respaldo.
 *
 * Se compone de frases cortas encadenadas según lo que digan los datos, no de
 * una plantilla con huecos. No pretende parecer escrita por una persona: lo que
 * pretende es que un informe sin clave de Gemini siga siendo un informe, con su
 * párrafo de entrada y su lista de cosas que hacer, y no una hoja de cifras con
 * un hueco donde debía ir el análisis.
 */
export function lecturaCalculada(d: ReportData, audiencia: Audiencia, o: QueSeCuenta = {}): Lectura {
  const dir = audiencia === 'direccion'
  const tiempos = o.tiempos !== false
  const se = senales(d, audiencia, o)
  const a = d.ahora
  const r = d.resolucion
  const saldo = a.resueltas - a.registros
  const sinNada = a.registros === 0 && a.resueltas === 0 && a.revisiones === 0

  const frases: string[] = []

  if (sinNada) {
    frases.push(`No ha entrado ningún parte nuevo en el periodo ${d.periodoTexto}.`)
  } else {
    if (a.registros > 0) {
      const clases = [
        a.incidencias ? plural(a.incidencias, 'incidencia') : '',
        a.solicitudes ? plural(a.solicitudes, 'solicitud', 'solicitudes') : '',
        a.observaciones ? plural(a.observaciones, 'observación', 'observaciones') : '',
      ].filter(Boolean)
      frases.push(
        `Se han atendido ${plural(a.registros, 'parte')}` +
          // Con una sola clase, el desglose repetiría la cifra.
          `${clases.length > 1 ? ` —${lista(clases)}—` : ''}` +
          `${donde(a.salasAtendidas, a.edificiosAtendidos)}.`,
      )
    } else {
      frases.push('No ha entrado ningún parte nuevo en el periodo.')
    }

    /*
     * El flujo y el saldo, en frases distintas.
     *
     * Lo abierto y cerrado DENTRO del periodo no explica el total de pendientes
     * de HOY, que arrastra meses anteriores. Con un histórico importado detrás,
     * las dos cifras se contradecían en la misma línea.
     */
    if (a.resueltas > 0) {
      const ritmoDeCierre = ritmo(d)
      const pronto = !tiempos
        ? ''
        : ritmoDeCierre.enElDia
          ? r.tramos.mismoDia === r.resueltas
            ? ', todos el mismo día'
            : `, ${r.tramos.mismoDia} de ellos el mismo día`
          : ritmoDeCierre.en48h
            ? r.enMenosDe48h === r.resueltas
              ? ', todos en menos de 48 horas'
              : `, ${r.enMenosDe48h} de ellos en menos de 48 horas`
            : ''
      const cuenta =
        a.registros === 0
          ? ''
          : saldo > 0
            ? `${pronto ? ', y son ' : ', '}${saldo} más de los que entraron`
            : saldo === 0
              ? ', los mismos que entraron'
              : ''
      frases.push(`Se han resuelto ${a.resueltas}${pronto}${cuenta}.`)
    }

    if (a.materialConsumido > 0) {
      frases.push(
        `Del almacén han salido ${plural(a.materialConsumido, 'unidad', 'unidades')} de material` +
          `${a.salasConMaterial > 0 ? ` para ${plural(a.salasConMaterial, 'aula')}` : ''}.`,
      )
    }

    if (a.revisiones > 0) {
      frases.push(
        `${a.registros > 0 || a.resueltas > 0 ? 'Además, se' : 'Se'} han revisado ` +
          `${plural(a.salasRevisadas, 'aula')} dentro de la puesta a punto.`,
      )
    }
  }

  frases.push(
    d.situacion.incidenciasAbiertas === 0
      ? 'A día de hoy no queda ninguna incidencia abierta.'
      : `A día de hoy ${d.situacion.incidenciasAbiertas === 1 ? 'hay 1 incidencia' : `hay ${d.situacion.incidenciasAbiertas} incidencias`} en seguimiento` +
        // El «de ellas con más de una semana» es del parte del equipo. A
        // dirección se le da el saldo; los días los lleva el servicio.
        (d.situacion.estancadas > 0 && !dir
          ? `, ${d.situacion.estancadas} de ellas con más de una semana.`
          : '.'),
  )

  /*
   * Aquí no va ni el aviso más importante ni la comparación con el tramo
   * anterior: los dos tienen su sitio —el primer hallazgo y la flecha de la
   * cabecera— y decir lo mismo tres veces en una página no lo hace más cierto;
   * hace que el lector deje de creerse la primera.
   */

  /*
   * Los hallazgos. Para dirección, hasta tres logros y, detrás, hasta tres
   * cosas que piden una decisión: el tope existe para que una semana buena no
   * empuje fuera de la página una incidencia de gravedad alta. Para el equipo,
   * al revés: primero lo que hay que hacer —hasta cuatro— y después dos logros,
   * que también es bueno leerlos.
   */
  const buenas = se.filter((x) => x.tono === 'ok')
  const resto = se.filter((x) => x.tono !== 'ok')
  const elegidos = dir
    ? [...buenas.slice(0, resto.length >= 3 ? 3 : 4), ...resto.slice(0, 3)]
    : [...resto.slice(0, 4), ...buenas.slice(0, 2)]

  return {
    titular: titular(d, o),
    entradilla: frases.join(' '),
    hallazgos: elegidos.map((x) => ({
      titulo: x.titulo,
      cuerpo: x.cuerpo,
      clase: x.tono === 'ok' ? ('logro' as const) : ('seguimiento' as const),
    })),
    recomendaciones: se
      .filter((x) => x.accion)
      .slice(0, 4)
      .map((x) => ({ accion: x.accion!, porque: x.titulo })),
    origen: 'redacción calculada a partir de los datos, sin IA',
  }
}
