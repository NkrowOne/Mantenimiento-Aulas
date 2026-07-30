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
 */

import type { ReportData } from './data.js'

export type Tono = 'neutro' | 'ok' | 'aviso' | 'critico'

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
export function indicadores(d: ReportData): Indicador[] {
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
    {
      etiqueta: 'Pendientes hoy',
      valor: String(d.situacion.incidenciasAbiertas),
      detalle:
        d.situacion.estancadas > 0
          ? `${d.situacion.estancadas} de más de 7 días`
          : 'ninguna estancada',
      // La foto de hoy no se compara con nada: es un saldo, no un flujo.
      delta: null,
      tono: d.situacion.estancadas > 0 ? 'critico' : d.situacion.incidenciasAbiertas > 0 ? 'aviso' : 'ok',
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
 */
export function senales(d: ReportData): Senal[] {
  const s: Senal[] = []
  const cobertura = d.situacion.salasTotal
    ? (d.ahora.salasRevisadas / d.situacion.salasTotal) * 100
    : 0

  if (d.situacion.estancadas > 0) {
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
        'Cuando la misma pieza vuelve a la misma sala, el problema no es la pieza.',
      tono: 'aviso',
      peso: 1,
      accion: `Revisar la instalación de ${r.building} ${r.room} en vez de reponer «${r.item}» otra vez.`,
    })
  }

  if (d.situacion.lamparasAlLimite > 0) {
    const peor = d.lamparas[0]
    s.push({
      clave: 'lamparas',
      titulo: `${plural(d.situacion.lamparasAlLimite, 'lámpara')} por debajo del 20 % de vida`,
      cuerpo: peor
        ? `La peor está en ${peor.building} ${peor.room}, al ${Math.round(peor.pct * 100)} %` +
          `${peor.horas ? ` y con ${peor.horas} horas de proyector` : ''}. ` +
          'Sustituirlas antes de que se fundan cuesta lo mismo y no interrumpe una clase.'
        : 'Conviene pedirlas antes de que se funda la primera.',
      tono: 'aviso',
      peso: 2,
      accion: 'Pedir lámparas de repuesto y planificar el cambio fuera de horario de clase.',
    })
  }

  const cuello = d.porEdificio[0]
  if (cuello && d.ahora.registros >= 4 && cuello.abiertas / d.ahora.registros >= 0.4) {
    s.push({
      clave: 'concentracion',
      titulo: `${cuello.code} concentra ${porcentaje(cuello.abiertas, d.ahora.registros)} de lo abierto`,
      cuerpo:
        `${cuello.abiertas} de los ${d.ahora.registros} registros del periodo salen de ${cuello.name} ` +
        `(${plural(cuello.salas, 'sala')}). Un edificio que acapara así suele tener una causa común, ` +
        'no diez averías distintas.',
      tono: 'aviso',
      peso: 3,
      accion: `Mirar ${cuello.code} como conjunto: instalación, antigüedad del equipo o uso.`,
    })
  }

  if (d.ahora.gravedadAlta > 0) {
    s.push({
      clave: 'gravedad',
      titulo: `${plural(d.ahora.gravedadAlta, 'incidencia')} de gravedad alta`,
      cuerpo: 'Gravedad alta es lo que impide dar la clase. Va primero, aunque sea lo más reciente.',
      tono: 'critico',
      peso: 1,
    })
  }

  if (cobertura === 0 && d.ahora.registros === 0) {
    s.push({
      clave: 'sin-actividad',
      titulo: 'No hay actividad registrada en el periodo',
      cuerpo:
        'Ni revisiones ni registros nuevos. En una semana de vacaciones es lo esperable; ' +
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
        'A este ritmo, dar una vuelta completa lleva ' +
        `${estimaVueltas(d.ahora.salasRevisadas, d.situacion.salasTotal, d.dias)}.`,
      tono: 'aviso',
      peso: 4,
      accion: 'Repartir la ronda por edificios para que ninguno quede fuera del ciclo.',
    })
  }

  if (d.situacion.salasNuncaRevisadas > 0) {
    s.push({
      clave: 'nunca-revisadas',
      titulo: `${plural(d.situacion.salasNuncaRevisadas, 'sala')} sin una sola revisión`,
      cuerpo:
        'De estas no se sabe nada: no tienen histórico, así que tampoco tienen índice de ' +
        'fiabilidad ni aparecen en ninguna alerta. Son el punto ciego del campus.',
      tono: 'neutro',
      peso: 6,
      accion: 'Incluir las salas sin histórico en la próxima ronda, aunque nadie haya avisado de nada.',
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
        (d.resolucion.mediaDias !== null && d.resolucion.mediaDias > d.resolucion.medianaDias * 2
          ? `. La media sube a ${dias(d.resolucion.mediaDias)} por unas pocas muy antiguas, ` +
            'que es justo lo que la mediana deja ver.'
          : '.'),
      tono: rapido ? 'ok' : 'neutro',
      peso: 7,
    })
  }

  if (d.sinSala > 0) {
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
      titulo: `${plural(d.situacion.articulosBajoMinimo, 'artículo')} bajo mínimo en almacén`,
      cuerpo: 'Quedarse sin la pieza convierte una reparación de diez minutos en una semana de espera.',
      tono: 'aviso',
      peso: 5,
      accion: 'Reponer lo que está por debajo del mínimo antes del próximo lunes.',
    })
  }

  return s.sort((a, b) => a.peso - b.peso)
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
export function lecturaCalculada(d: ReportData): Lectura {
  const se = senales(d)
  const saldo = d.ahora.resueltas - d.ahora.registros
  const sinNada = d.ahora.revisiones === 0 && d.ahora.registros === 0

  const titular = enPalabras(
    sinNada
    ? 'Periodo sin actividad registrada'
    : d.situacion.estancadas > 0
      ? `${plural(d.situacion.estancadas, 'incidencia')} llevan más de una semana abiertas`
      : saldo > 0
        ? 'Se ha cerrado más de lo que se ha abierto'
        : saldo < 0
          ? 'Entra más trabajo del que sale'
          : 'Semana en equilibrio',
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
          : `Se cerraron ${d.ahora.resueltas}, ${Math.abs(saldo)} menos de las que entraron.`,
    )
    frases.push(
      d.situacion.incidenciasAbiertas === 0
        ? 'Hoy no queda ninguna incidencia abierta.'
        : `Hoy quedan ${plural(d.situacion.incidenciasAbiertas, 'incidencia')} abiertas en total` +
          (d.situacion.estancadas > 0
            ? `, ${d.situacion.estancadas} de ellas con más de una semana.`
            : '.'),
    )
    const dv = delta(d.ahora.revisiones, d.antes.revisiones)
    if (d.antes.revisiones > 0 && dv.valor !== 0) {
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

  return {
    titular,
    entradilla: frases.join(' '),
    hallazgos: se.slice(0, 5).map((x) => ({ titulo: x.titulo, cuerpo: x.cuerpo })),
    recomendaciones: se
      .filter((x) => x.accion)
      .slice(0, 4)
      .map((x) => ({ accion: x.accion!, porque: x.titulo })),
    origen: 'redacción calculada a partir de los datos, sin IA',
  }
}
