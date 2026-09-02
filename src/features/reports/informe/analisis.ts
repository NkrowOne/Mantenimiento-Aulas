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
 * Y las tres saben PARA QUIÉN escriben, porque no es el mismo documento:
 *
 *   `equipo`      El parte del servicio. Dice lo que hay tal como está, lo
 *                 grave primero: una incidencia con veinte días abierta es lo
 *                 primero que hay que leer el lunes.
 *   `direccion`   Lo que se le entrega al cliente. Da cuenta del trabajo con
 *                 buena imagen y sin faltar a los datos: abre por lo que ha
 *                 mejorado, cuenta lo pendiente como trabajo en curso y margen
 *                 de mejora, y NO dice cuántos días lleva abierta nada ni
 *                 señala una sala como problemática: hay aulas difíciles, y eso
 *                 no es noticia para quien dirige un campus. Los problemas de
 *                 verdad —una incidencia de gravedad alta, una lámpara a punto
 *                 de fundirse, la misma pieza tres veces en la misma sala— sí
 *                 se dicen, con su cifra, como algo visto y una decisión que
 *                 conviene tomar.
 */

import type { ReportData } from './tipos'

export type Tono = 'neutro' | 'ok' | 'aviso' | 'critico'

/** Para quién se escribe. Cambia la voz y lo que se cuenta; nunca una cifra. */
export type Audiencia = 'direccion' | 'equipo'

export interface Delta {
  /** Diferencia absoluta contra el mismo tramo anterior. */
  valor: number
  /** Variación relativa, o `null` si antes era cero y no hay porcentaje que valga. */
  pct: number | null
  /** Si subir es una buena noticia. Cambia la flecha y el color, no el número. */
  subirEsBueno: boolean
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
  /** 0 = lo primero que hay que mirar. Ordena el bloque de recomendaciones. */
  peso: number
  accion?: string
}

export interface Lectura {
  titular: string
  entradilla: string
  hallazgos: Array<{ titulo: string; cuerpo: string }>
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
 * «2 incidencias llevan…» es lo que escribe una máquina; «Dos incidencias
 * llevan…» es lo que escribe alguien. Solo del uno al nueve y solo al principio:
 * más allá, la cifra se lee mejor que la palabra.
 */
const PALABRAS = ['cero', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve']

export function enPalabras(frase: string): string {
  const m = /^(\d)\s/.exec(frase)
  if (!m) return frase
  const palabra = PALABRAS[Number(m[1])]!
  return palabra.charAt(0).toUpperCase() + palabra.slice(1) + frase.slice(1)
}

/**
 * Los cuatro números de cabecera.
 *
 * Son cuatro y no ocho a propósito: una tira de ocho indicadores no se lee, se
 * hojea. Lo que no cabe aquí está en las tablas, que es donde se va a buscar el
 * detalle cuando uno de estos cuatro llama la atención.
 */
export function indicadores(d: ReportData, audiencia: Audiencia): Indicador[] {
  const cobertura = d.situacion.salasTotal
    ? (d.ahora.salasRevisadas / d.situacion.salasTotal) * 100
    : 0
  const saldo = d.ahora.resueltas - d.ahora.registros

  return [
    {
      etiqueta: 'Revisiones',
      valor: String(d.ahora.revisiones),
      detalle: `${plural(d.ahora.salasRevisadas, 'sala')} · ${porcentaje(
        d.ahora.salasRevisadas,
        d.situacion.salasTotal,
      )} del campus`,
      delta: delta(d.ahora.revisiones, d.antes.revisiones, true),
      tono: cobertura >= 10 ? 'ok' : 'aviso',
    },
    {
      etiqueta: 'Registros abiertos',
      valor: String(d.ahora.registros),
      detalle:
        d.ahora.registros === 0
          ? 'ninguno en el periodo'
          : [
              d.ahora.incidencias && `${d.ahora.incidencias} incid.`,
              d.ahora.solicitudes && `${d.ahora.solicitudes} solic.`,
              d.ahora.observaciones && `${d.ahora.observaciones} observ.`,
            ]
              .filter(Boolean)
              .join(' · '),
      // Abrir más registros no es malo en sí: significa que se está mirando.
      delta: delta(d.ahora.registros, d.antes.registros, false),
      tono: d.ahora.gravedadAlta > 0 ? 'aviso' : 'neutro',
    },
    {
      etiqueta: 'Cerradas',
      valor: String(d.ahora.resueltas),
      detalle:
        saldo >= 0
          ? `saldo +${saldo} sobre lo abierto`
          : `${Math.abs(saldo)} más abiertas que cerradas`,
      delta: delta(d.ahora.resueltas, d.antes.resueltas, true),
      /*
       * UN CERO NUNCA VA EN VERDE.
       *
       * Con el periodo vacío, `saldo >= 0` se cumple —cero cerradas menos cero
       * abiertas— y el indicador pintaba un 0 en verde de «bien». Es el peor
       * fallo posible en un documento de supervisión, porque parece una buena
       * noticia. Sin trabajo que medir, el tono es neutro.
       */
      tono: d.ahora.resueltas === 0 ? 'neutro' : saldo >= 0 ? 'ok' : 'aviso',
    },
    /*
     * La cuarta cifra cambia de voz con la audiencia. Al equipo se le dice
     * cuántas llevan más de una semana, en rojo, porque es lo que tiene que
     * mirar hoy. A dirección se le da el saldo y nada más: el número de días
     * de una incidencia abierta no es un dato que le sirva para decidir nada,
     * y sí es el que convierte un aula difícil en un reproche.
     */
    audiencia === 'direccion'
      ? {
          etiqueta: 'Pendientes hoy',
          valor: String(d.situacion.incidenciasAbiertas),
          detalle: d.situacion.incidenciasAbiertas > 0 ? 'en seguimiento' : 'ninguna pendiente',
          delta: null,
          tono: d.situacion.incidenciasAbiertas > 0 ? 'neutro' : 'ok',
        }
      : {
          etiqueta: 'Pendientes hoy',
          valor: String(d.situacion.incidenciasAbiertas),
          detalle:
            d.situacion.estancadas > 0
              ? `${d.situacion.estancadas} de más de 7 días`
              : 'ninguna estancada',
          // La foto de hoy no se compara con nada: es un saldo, no un flujo.
          delta: null,
          tono:
            d.situacion.estancadas > 0
              ? 'critico'
              : d.situacion.incidenciasAbiertas > 0
                ? 'aviso'
                : 'ok',
        },
  ]
}

/**
 * Las reglas.
 *
 * Cada una responde a algo que se ha visto de verdad en estos datos, y cada una
 * dice su cifra: un aviso que no se puede comprobar no debería estar en un
 * informe. El peso ordena; lo que no dispara, no aparece — un informe con nueve
 * secciones fijas donde seis dicen «nada que señalar» enseña a no leerlo.
 *
 * Para dirección se reparten en dos juegos: las que dicen que algo ha ido bien
 * —en `senalesBuenas()`— y las de aquí, que para esa audiencia cambian de voz:
 * la misma cifra, contada como margen de mejora y con una decisión al lado en
 * vez de una tarea de taller. Y dos no salen para dirección de ninguna forma:
 * las incidencias estancadas, que son el «lleva N días abierta» que este
 * documento no dice, y los registros sin sala, que son limpieza de datos del
 * servicio y no un asunto del cliente.
 */
export function senales(d: ReportData, audiencia: Audiencia): Senal[] {
  const dir = audiencia === 'direccion'
  const s: Senal[] = dir ? senalesBuenas(d) : []
  const cobertura = d.situacion.salasTotal
    ? (d.ahora.salasRevisadas / d.situacion.salasTotal) * 100
    : 0

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
      accion: 'Repasar la lista de estancadas y cerrar o reasignar cada una.',
    })
  }

  if (d.reincidentes.length > 0) {
    const r = d.reincidentes[0]!
    s.push({
      clave: 'reincidencia',
      titulo: `${d.reincidentes.length === 1 ? 'Una sala repite' : `${d.reincidentes.length} salas repiten`} el mismo consumo`,
      cuerpo:
        `En ${r.building} ${r.room} se ha puesto «${r.item}» ${r.veces} veces en seis meses. ` +
        (dir
          ? 'Cuando la misma pieza vuelve a la misma sala conviene mirar la instalación: es la mejora que más repuestos ahorra.'
          : 'Cuando la misma pieza vuelve a la misma sala, el problema no es la pieza.'),
      tono: 'aviso',
      peso: dir ? 3 : 1,
      accion: `Revisar la instalación de ${r.building} ${r.room} en vez de reponer «${r.item}» otra vez.`,
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
      peso: dir ? 4 : 2,
      accion: dir
        ? 'Aprobar la compra de lámparas de repuesto y cambiarlas fuera del horario de clase.'
        : 'Pedir lámparas de repuesto y planificar el cambio fuera de horario de clase.',
    })
  }

  const cuello = d.porEdificio[0]
  if (cuello && d.ahora.registros >= 4 && cuello.abiertas / d.ahora.registros >= 0.4) {
    s.push({
      clave: 'concentracion',
      titulo: `${cuello.code} concentra ${porcentaje(cuello.abiertas, d.ahora.registros)} de lo abierto`,
      cuerpo:
        `${cuello.abiertas} de los ${d.ahora.registros} registros del periodo salen de ${cuello.name} ` +
        `(${plural(cuello.salas, 'sala')}). Un edificio que acapara así suele tener una causa común` +
        (dir ? ': resolverla mejora varias aulas de golpe.' : ', no diez averías distintas.'),
      tono: 'aviso',
      peso: dir ? 5 : 3,
      accion: dir
        ? `Plantear una revisión de conjunto de ${cuello.code}: instalación, antigüedad del equipo o uso.`
        : `Mirar ${cuello.code} como conjunto: instalación, antigüedad del equipo o uso.`,
    })
  }

  /*
   * Gravedad alta se dice a todo el mundo, y con el mismo tono. Es lo que impide
   * dar una clase: callárselo a dirección para que el informe quede más bonito
   * sería exactamente el informe que no se puede firmar.
   */
  if (d.ahora.gravedadAlta > 0) {
    s.push({
      clave: 'gravedad',
      titulo: `${plural(d.ahora.gravedadAlta, 'incidencia')} de gravedad alta`,
      cuerpo: dir
        ? 'Gravedad alta es lo que impide dar la clase, y por eso se atiende por delante de todo lo demás.'
        : 'Gravedad alta es lo que impide dar la clase. Va primero, aunque sea lo más reciente.',
      tono: 'critico',
      peso: dir ? 2 : 1,
      ...(dir ? { accion: 'Dar prioridad a las de gravedad alta: son las que afectan a la clase.' } : {}),
    })
  }

  if (cobertura === 0 && d.ahora.registros === 0) {
    s.push({
      clave: 'sin-actividad',
      titulo: 'No hay actividad registrada en el periodo',
      cuerpo: dir
        ? 'Ni revisiones ni registros nuevos. En un periodo de vacaciones es lo esperable.'
        : 'Ni revisiones ni registros nuevos. En una semana de vacaciones es lo esperable; ' +
          'en una semana de clase, revisa que los dispositivos estén sincronizando.',
      tono: 'aviso',
      peso: 0,
    })
  } else if (cobertura < 5 && d.situacion.salasTotal > 0) {
    s.push({
      clave: 'cobertura',
      titulo: `Se ha pasado por ${porcentaje(d.ahora.salasRevisadas, d.situacion.salasTotal)} del campus`,
      cuerpo:
        `${plural(d.ahora.salasRevisadas, 'sala')} de ${d.situacion.salasTotal}. ` +
        (dir
          ? 'Ampliar la ronda es la mejora con más recorrido: cada sala revisada es una avería que se ve antes de que la vea una clase.'
          : 'A este ritmo, dar una vuelta completa lleva ' +
            `${estimaVueltas(d.ahora.salasRevisadas, d.situacion.salasTotal, d.dias)}.`),
      tono: 'aviso',
      peso: dir ? 7 : 4,
      accion: dir
        ? 'Reforzar la ronda por edificios hasta completar la vuelta al campus.'
        : 'Repartir la ronda por edificios para que ninguno quede fuera del ciclo.',
    })
  }

  if (d.situacion.salasNuncaRevisadas > 0) {
    s.push({
      clave: 'nunca-revisadas',
      titulo: dir
        ? `${plural(d.situacion.salasNuncaRevisadas, 'sala')} pendientes de incorporar a la ronda`
        : `${plural(d.situacion.salasNuncaRevisadas, 'sala')} sin una sola revisión`,
      cuerpo: dir
        ? 'Todavía no tienen histórico, así que no aparecen en ningún indicador. ' +
          'Incorporarlas completa la foto del campus.'
        : 'De estas no se sabe nada: no tienen histórico, así que tampoco tienen índice de ' +
          'fiabilidad ni aparecen en ninguna alerta. Son el punto ciego del campus.',
      tono: 'neutro',
      peso: dir ? 8 : 6,
      accion: dir
        ? 'Incluir las salas sin histórico en la próxima ronda.'
        : 'Incluir las salas sin histórico en la próxima ronda, aunque nadie haya avisado de nada.',
    })
  }

  if (d.resolucion.resueltas >= 3 && d.resolucion.medianaDias !== null) {
    const rapido = d.resolucion.medianaDias <= 2
    s.push({
      clave: 'resolucion',
      titulo:
        d.resolucion.medianaDias * 24 < 1
          ? 'La mitad de los cierres se hacen el mismo día'
          : `La mitad se cierra en ${dias(d.resolucion.medianaDias)} o menos`,
      cuerpo:
        `${d.resolucion.enMenosDe48h} de ${d.resolucion.resueltas} cerradas en menos de 48 horas` +
        // A dirección no se le explica que la media la mueven «unas pocas muy
        // antiguas»: es la puerta de atrás del «lleva N días» que no se dice.
        (!dir && d.resolucion.mediaDias !== null && d.resolucion.mediaDias > d.resolucion.medianaDias * 2
          ? `. La media sube a ${dias(d.resolucion.mediaDias)} por unas pocas muy antiguas, ` +
            'que es justo lo que la mediana deja ver.'
          : '.'),
      tono: rapido ? 'ok' : 'neutro',
      // Una buena noticia va arriba en el informe de dirección y abajo en el
      // del equipo, que ya sabe cómo cierra y viene a por lo que falta.
      peso: dir ? (rapido ? 1 : 9) : 7,
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
      peso: 8,
      accion: 'Asignar sala a los registros huérfanos desde la pantalla de datos.',
    })
  }

  if (d.situacion.articulosBajoMinimo > 0) {
    s.push({
      clave: 'almacen',
      titulo: dir
        ? `${plural(d.situacion.articulosBajoMinimo, 'artículo')} por reponer en almacén`
        : `${plural(d.situacion.articulosBajoMinimo, 'artículo')} bajo mínimo en almacén`,
      cuerpo: dir
        ? 'Tener la pieza a mano es lo que convierte una reparación en cosa de minutos.'
        : 'Quedarse sin la pieza convierte una reparación de diez minutos en una semana de espera.',
      tono: 'aviso',
      peso: dir ? 6 : 5,
      accion: dir
        ? 'Aprobar la reposición de lo que está por debajo del mínimo.'
        : 'Reponer lo que está por debajo del mínimo antes del próximo lunes.',
    })
  }

  return s.sort((a, b) => a.peso - b.peso)
}

/**
 * Lo que ha ido bien, con su cifra. Solo para dirección.
 *
 * Al equipo no se le cuenta: sabe lo que ha hecho, y en su parte cada línea
 * que no pide nada es una línea que tapa a una que sí. Para dirección es al
 * revés: es lo primero que se lee, y lo que hace que lo pendiente se lea como
 * trabajo en curso y no como una lista de faltas. Cada una se apoya en una
 * comparación o en un saldo que está impreso al lado: sin cifra no hay buena
 * noticia, hay adjetivos.
 */
export function senalesBuenas(d: ReportData): Senal[] {
  const s: Senal[] = []
  const saldo = d.ahora.resueltas - d.ahora.registros

  if (d.antes.revisiones > 0 && d.ahora.revisiones > d.antes.revisiones) {
    const dv = delta(d.ahora.revisiones, d.antes.revisiones)
    s.push({
      clave: 'mas-revisiones',
      titulo: `Suben las revisiones frente a ${d.comparacionTexto}`,
      cuerpo:
        `${d.ahora.revisiones} frente a ${d.antes.revisiones}` +
        `${dv.pct !== null ? ` (+${dv.pct} %)` : ''}: ` +
        `${plural(d.ahora.salasRevisadas, 'sala')} distintas, ${porcentaje(
          d.ahora.salasRevisadas,
          d.situacion.salasTotal,
        )} del campus.`,
      tono: 'ok',
      peso: 0,
    })
  }

  if (d.ahora.resueltas > 0 && saldo > 0) {
    s.push({
      clave: 'saldo-positivo',
      titulo: 'Se cierra más de lo que entra',
      cuerpo:
        `${d.ahora.resueltas} cerradas por ${plural(d.ahora.registros, 'registro')} ` +
        `${d.ahora.registros === 1 ? 'abierto' : 'abiertos'} en el periodo: la cola de trabajo baja.`,
      tono: 'ok',
      peso: 0,
    })
  }

  if (d.ahora.registros > 0 && d.ahora.gravedadAlta === 0) {
    s.push({
      clave: 'sin-gravedad-alta',
      titulo: 'Ninguna incidencia de gravedad alta',
      cuerpo: `De los ${plural(d.ahora.registros, 'registro')} del periodo, ninguno impide dar clase.`,
      tono: 'ok',
      peso: 1,
    })
  }

  return s
}

function estimaVueltas(revisadas: number, total: number, diasPeriodo: number): string {
  if (revisadas === 0) return 'un tiempo indefinido'
  const diasNecesarios = (total / revisadas) * diasPeriodo
  if (diasNecesarios > 700) return 'más de dos años'
  if (diasNecesarios > 400) return 'más de un año'
  const meses = Math.round(diasNecesarios / 30)
  return `unos ${meses} meses`
}

function recorta(t: string, n: number): string {
  const limpio = t.trim()
  return limpio.length <= n ? limpio : `${limpio.slice(0, n - 1)}…`
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
export function lecturaCalculada(d: ReportData, audiencia: Audiencia): Lectura {
  const dir = audiencia === 'direccion'
  const se = senales(d, audiencia)
  const saldo = d.ahora.resueltas - d.ahora.registros
  const sinNada = d.ahora.revisiones === 0 && d.ahora.registros === 0
  const subenRevisiones = d.antes.revisiones > 0 && d.ahora.revisiones > d.antes.revisiones
  // «Semana en equilibrio» sobre un informe de treinta y nueve días era mentira.
  const tramo = d.kind === 'diario' ? 'Jornada' : d.kind === 'semanal' ? 'Semana' : 'Periodo'

  /*
   * El titular de dirección abre por lo que ha mejorado, y si nada ha mejorado,
   * por lo que se ha hecho. Nunca por lo que falta: eso va en los hallazgos,
   * con su cifra, donde se lee como margen de mejora y no como el titular de
   * un documento que llega al cliente.
   */
  const titular = enPalabras(
    sinNada
      ? 'Periodo sin actividad registrada'
      : dir
        ? subenRevisiones && saldo > 0
          ? `Más revisiones y más cierres que ${d.comparacionTexto}`
          : saldo > 0
            ? 'Se ha cerrado más de lo que se ha abierto'
            : subenRevisiones
              ? `Suben las revisiones frente a ${d.comparacionTexto}`
              : d.ahora.resueltas > 0
                ? `${plural(d.ahora.salasRevisadas, 'sala')} revisadas y ${plural(d.ahora.resueltas, 'cierre')} en el periodo`
                : `${plural(d.ahora.salasRevisadas, 'sala')} revisadas en el periodo`
        : d.situacion.estancadas > 0
          // Con una sola, el verbo y el participio concuerdan: «Una incidencia
          // llevan… abiertas» en el H1 de un PDF firmado se lee como descuido.
          ? d.situacion.estancadas === 1
            ? 'Una incidencia lleva más de una semana abierta'
            : `${plural(d.situacion.estancadas, 'incidencia')} llevan más de una semana abiertas`
          : saldo > 0
            ? 'Se ha cerrado más de lo que se ha abierto'
            : saldo < 0
              ? 'Entra más trabajo del que sale'
              : `${tramo} en equilibrio`,
  )

  const frases: string[] = []

  if (sinNada) {
    frases.push(`No hay revisiones ni registros nuevos en el periodo ${d.periodoTexto}.`)
  } else {
    frases.push(
      `Se han hecho ${plural(d.ahora.revisiones, 'revisión', 'revisiones')} sobre ` +
        `${plural(d.ahora.salasRevisadas, 'sala')} —${porcentaje(
          d.ahora.salasRevisadas,
          d.situacion.salasTotal,
        )} del campus— y se han abierto ${plural(d.ahora.registros, 'registro')}` +
        `${d.ahora.gravedadAlta ? `, ${d.ahora.gravedadAlta} de gravedad alta` : ''}.`,
    )
    /*
     * El flujo y el saldo, en frases distintas.
     *
     * Antes iban juntas —«la cola baja en 3 y queda en 2»— y era una mezcla de
     * dos cosas que no se suman: lo abierto y cerrado DENTRO del periodo no
     * explica el total de pendientes de HOY, que arrastra meses anteriores. Con
     * un histórico importado detrás, las dos cifras se contradecían en la misma
     * línea.
     */
    frases.push(
      saldo === 0
        ? `Se cerraron ${d.ahora.resueltas}, las mismas que entraron.`
        : saldo > 0
          ? `Se cerraron ${d.ahora.resueltas}, ${plural(saldo, 'registro')} más de los que entraron.`
          // «los que», como la rama de arriba: habla de registros, no de incidencias.
          : `Se cerraron ${d.ahora.resueltas}, ${Math.abs(saldo)} menos de los que entraron.`,
    )
    frases.push(
      d.situacion.incidenciasAbiertas === 0
        ? 'Hoy no queda ninguna incidencia abierta.'
        : `Hoy quedan ${plural(d.situacion.incidenciasAbiertas, 'incidencia')} abiertas en total` +
          // El «de ellas con más de una semana» es del parte del equipo. A
          // dirección se le da el saldo; los días los lleva el servicio.
          (d.situacion.estancadas > 0 && !dir
            ? `, ${d.situacion.estancadas} de ellas con más de una semana.`
            : '.'),
    )
    const dv = delta(d.ahora.revisiones, d.antes.revisiones)
    // Para dirección, la subida ya es el titular y el primer hallazgo, con sus
    // cifras: decirla una tercera vez aquí es lo que hace que deje de creerse.
    // La bajada sí se dice: es un dato, y este es el único sitio donde va.
    if (d.antes.revisiones > 0 && dv.valor !== 0 && !(dir && subenRevisiones)) {
      frases.push(
        `Frente a ${d.comparacionTexto}, ${dv.valor > 0 ? 'suben' : 'bajan'} ` +
          `${Math.abs(dv.valor)} revisiones${dv.pct !== null ? ` (${dv.pct > 0 ? '+' : ''}${dv.pct} %)` : ''}.`,
      )
    }
  }

  /*
   * Aquí iba una cuarta frase con el aviso más importante, y sobraba: ese aviso
   * ya es el titular del informe y vuelve a estar, con su detalle, en el primer
   * punto del análisis. Decirlo tres veces en la misma página no lo hace más
   * urgente; hace que el lector deje de creerse la primera.
   */

  /*
   * Los hallazgos de dirección: dos buenas noticias como mucho y, detrás, lo
   * que pide una decisión. El tope de dos existe para que una semana buena no
   * empuje fuera de la página una incidencia de gravedad alta: lo que ha ido
   * bien abre el informe; lo que hay que decidir tiene que seguir en él.
   */
  const buenas = se.filter((x) => x.tono === 'ok')
  const resto = se.filter((x) => x.tono !== 'ok')
  const elegidos = dir ? [...buenas.slice(0, 2), ...resto.slice(0, 3)] : se.slice(0, 5)

  return {
    titular,
    entradilla: frases.join(' '),
    hallazgos: elegidos.map((x) => ({ titulo: x.titulo, cuerpo: x.cuerpo })),
    recomendaciones: se
      .filter((x) => x.accion)
      .slice(0, 4)
      .map((x) => ({ accion: x.accion!, porque: x.titulo })),
    origen: 'redacción calculada a partir de los datos, sin IA',
  }
}
