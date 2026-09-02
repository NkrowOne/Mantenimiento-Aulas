/**
 * La plantilla del informe.
 *
 * Devuelve un documento HTML **autocontenido**: los gráficos van dentro como
 * SVG, no hay una sola petición a la red al abrirlo y no hay una sola línea de
 * JavaScript. Eso es lo que permite archivarlo tal cual, abrirlo dentro de la
 * aplicación en un iframe aislado y sacar el PDF con «Guardar como PDF» del
 * propio navegador — sin worker, sin WeasyPrint y sin Chromium de servidor.
 *
 * Restricciones que se respetan, y que ahora sirven para las dos cosas —salió
 * de generarlo con WeasyPrint y vale igual para imprimir desde el navegador—:
 *  - Nada de JavaScript. Los gráficos entran ya como SVG.
 *  - Maquetación con `table` y cajas simples. Nada de Grid: cada motor de
 *    impresión lo trata a su manera y un informe no es sitio para averiguar
 *    cuál está delante.
 *  - Los saltos de página se controlan a mano, bloque por bloque.
 *  - Las cajas de margen de `@page` (`@top-right`, `counter(pages)`) son de
 *    CSS Paged Media: WeasyPrint las imprime y un navegador las ignora y pone
 *    su propia cabecera. Se dejan porque no estorban donde no se entienden, y
 *    porque nada del contenido del informe depende de ellas: lo que hay que
 *    leer está en el flujo del documento.
 *
 * LAS DECISIONES DE DISEÑO, que son el motivo de que este fichero sea largo:
 *
 *  · **Dos familias con dos oficios.** Serif para lo que se lee seguido —la
 *    entradilla, el análisis, los motivos—; sans para lo que se consulta a
 *    saltos —rótulos, tablas, cifras—. Es lo que separa un documento de un
 *    volcado: el ojo sabe, sin pensarlo, qué es texto y qué es dato.
 *  · **Una sola columna de lectura, estrecha.** La entradilla no ocupa los
 *    178 mm de la caja: ocupa 110. Un párrafo de línea larga no se lee, se
 *    escanea, y justo ese párrafo es el que tiene que leerse.
 *  · **Los indicadores a la derecha, no arriba.** La tira de cuatro cubos
 *    horizontales es la forma canónica del panel generado a máquina. En vertical,
 *    al lado del texto, el documento se lee como un informe y no como una
 *    plantilla rellenada.
 *  · **Ni un emoji, ni una negrita de énfasis, ni un signo de exclamación.** El
 *    énfasis se hace con jerarquía y con aire, que es lo que se ha hecho siempre
 *    en un documento impreso.
 *  · **Las secciones vacías no se imprimen** cuando no dicen nada, y sí cuando
 *    lo que dicen es una buena noticia. «Ninguna lámpara por debajo del umbral»
 *    informa; «Sin datos» no.
 */

import { ANCHO_MEDIO, ANCHO_TOTAL, actividadDiaria, barrasHorizontales, tendencia } from './graficos'
import type { ReportData } from './tipos'
import { type Indicador, type Lectura, dias as textoDias, indicadores, plural, porcentaje } from './analisis'
import { SECCIONES_POR_DEFECTO, type Opciones, type Seccion, tiene } from './opciones'
import { diaDeLaSemana, etiquetaDia, nombreDia } from '../periodos'
import { bandaDeMarcas } from './marcas'

/*
 * La paleta de la aplicación, para que el PDF y la pantalla sean el mismo
 * producto, con el papel un punto más cálido que la pantalla.
 *
 * Los grises tiraban a azul de terminal y el rojo era de señal de tráfico. Un
 * informe de mantenimiento no da malas noticias: cuenta cómo va el trabajo, y
 * casi siempre va bien. Los tonos de estado siguen ahí —hacen falta para
 * distinguir de un vistazo lo que urge—, solo que dichos en voz normal.
 *
 * Todos pasan 4,5:1 sobre el blanco Y sobre el crema del papel, que es donde de
 * verdad se leen. El más justo es MUTED, que es además el que más letra pequeña
 * lleva: 5,9 sobre blanco y 5,4 sobre crema.
 */
const ACENTO = '#0B6B70'
/** El acento aguado, para fondos teñidos: números de hallazgo, píldoras. */
const TINTE = '#E9F1F0'
const INK = '#1A2226'
const INK2 = '#42525A'
const MUTED = '#57676E'
const LINE = '#DEE2E0'
const HAIR = '#EDEFEC'
const PAPEL = '#F6F5F1'
const OK = '#1B6E4B'
const WARN = '#8A5B14'
const CRIT = '#A33529'

/*
 * Cómo se llama cada informe, que es también cómo se llama el fichero PDF y lo
 * primero que se lee de la portada.
 *
 * El de fechas elegidas a mano se llamaba «Informe a medida». Es lenguaje de
 * folleto —lo «a medida» es el traje, no el documento— y encima no dice nada:
 * quien lo abre seis meses después necesita saber DE QUÉ periodo es, y eso ya
 * va al lado en todos los sitios donde aparece el título. «Informe del periodo»
 * no promete nada y no estorba.
 */
const TITULO_TIPO: Record<string, string> = {
  diario: 'Parte diario',
  semanal: 'Informe semanal',
  personalizado: 'Informe del periodo',
}

/**
 * El nombre del edificio, sin repetir su código.
 *
 * Los datos traen `code = 'H'` y `name = 'EDIFICIO H'`, así que lo obvio
 * —código y nombre pegados— imprimía «H H». Y los nombres vienen del Excel en
 * mayúsculas: «SIMULACION CLINICA AV.» en versalitas grita, así que se pasa a
 * capitales de palabra dejando en paz las siglas cortas (CRAI, DOT, MSI).
 */
export function nombreEdificio(code: string, name: string): string {
  const limpio = name.replace(/^EDIFICIO\s+/i, '').trim()
  if (!limpio || limpio.toUpperCase() === code.toUpperCase()) return ''
  return limpio
    .split(/\s+/)
    .map((w) =>
      w.length <= 4 && w === w.toUpperCase()
        ? w
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join(' ')
}

/**
 * Los días escritos enteros, para justificar y no para resumir.
 *
 * `dias()` de `analisis.ts` redondea porque va en una cifra de cabecera: allí,
 * «3,5 días» es exactamente lo que hace falta. Aquí no. Cuando alguien pregunta
 * por qué una incidencia concreta llevó lo que llevó, «3,5 días» invita a la
 * siguiente pregunta y «3 días y 12 h» la cierra. Y por debajo de un día se
 * cuenta en horas, que es como lo cuenta quien estuvo allí.
 */
export function diasLargo(dias: number): string {
  const horasTotales = dias * 24
  if (horasTotales < 1) return `${Math.max(1, Math.round(horasTotales * 60))} min`
  if (horasTotales < 24) return `${Math.round(horasTotales)} h`
  const enteros = Math.floor(dias)
  const horas = Math.round((dias - enteros) * 24)
  // 24 h de resto son un día más, no «3 días y 24 h».
  if (horas === 24) return plural(enteros + 1, 'día')
  if (horas === 0) return plural(enteros, 'día')
  return `${plural(enteros, 'día')} y ${horas} h`
}

/** Igual con las salas: en muchas, el código ES el nombre. */
function nombreSala(code: string, name: string): string {
  return name.trim().toUpperCase() === code.trim().toUpperCase() ? '' : name.trim()
}

/**
 * La primera en mayúscula, para cuando el texto abre una línea.
 *
 * `periodoTexto` se escribe en minúscula porque casi siempre va detrás de algo
 * —«Informe semanal · del 27 al 31»—, y en la portada abre el renglón él solo.
 */
function mayuscula(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** Corta por palabra entera y avisa con puntos suspensivos. */
function recorta(t: string, n: number): string {
  const limpio = t.trim().replace(/\s+/g, ' ')
  if (limpio.length <= n) return limpio
  const corte = limpio.slice(0, n - 1)
  const ultimo = corte.lastIndexOf(' ')
  return `${ultimo > n * 0.6 ? corte.slice(0, ultimo) : corte}…`
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface Pie {
  /** Fecha y hora de emisión, ya formateada en hora de Madrid. */
  emitido: string
  /** Quién lo pidió, si lo pidió alguien. El automático del viernes no tiene solicitante. */
  solicitante?: string | undefined
}

// ── Piezas ───────────────────────────────────────────────────────────────────

/**
 * La variación, con su flecha.
 *
 * El triángulo se dibuja con bordes CSS y no con el carácter ▲: si la fuente
 * del contenedor no trae ese glifo —y ninguna de las tres IBM Plex garantiza
 * los símbolos geométricos— WeasyPrint imprime un rectángulo vacío. Un cuadrito
 * negro en medio de una cifra es exactamente el tipo de detalle que hace que un
 * documento parezca roto.
 */
function variacion(ind: Indicador): string {
  const d = ind.delta
  if (!d || d.valor === 0) {
    return `<div class="var neutra">sin cambio</div>`
  }
  const sube = d.valor > 0
  const bueno = sube === d.subirEsBueno
  const clase = `${sube ? 'sube' : 'baja'} ${bueno ? 'bien' : 'mal'}`
  const cifra = `${sube ? '+' : '−'}${Math.abs(d.valor)}`
  const rel = d.pct === null ? '' : ` <span class="var-pct">(${d.pct > 0 ? '+' : ''}${d.pct} %)</span>`
  return `<div class="var ${clase}"><i class="flecha"></i>${cifra}${rel}</div>`
}

/**
 * Los cuatro indicadores, en dos por dos.
 *
 * En una sola columna el panel medía trece líneas y la entradilla cinco: el
 * lado izquierdo de la primera página quedaba medio vacío y la página se leía
 * como una cosa mal cuadrada. En dos por dos los dos lados terminan a la misma
 * altura, que es la razón por la que existe la retícula.
 */
function panelIndicadores(inds: Indicador[], comparar: boolean, comparacion: string): string {
  /*
   * Solo se pinta de color lo que urge.
   *
   * Las cuatro cifras salían cada una del color de su tono, y el resultado era
   * un semáforo: «18 revisiones» en ámbar porque se hicieron menos que la
   * semana pasada, al lado de «23 pendientes» en rojo. Cuando todo está
   * coloreado, el color deja de decir nada y el panel parece una alarma incluso
   * en una semana buena. Ahora la cifra va en tinta y el rojo se reserva para
   * lo crítico —lo que hay que mirar hoy—; lo demás lo cuentan el detalle de
   * debajo y la flecha de la variación, que siguen con su color.
   */
  const celda = (i: Indicador | undefined): string =>
    i
      ? `<div class="panel-et">${esc(i.etiqueta)}</div>
      <div class="panel-val" style="color:${i.tono === 'critico' ? CRIT : INK}">${esc(i.valor)}</div>
      <div class="panel-det">${esc(i.detalle)}</div>
      ${comparar && i.delta ? variacion(i) : ''}`
      : ''

  return `
  <div class="panel">
    <div class="panel-t">El periodo en cuatro cifras</div>
    <table class="panel-rej">
      <tr>
        <td class="panel-c">${celda(inds[0])}</td>
        <td class="panel-c">${celda(inds[1])}</td>
      </tr>
      <tr>
        <td class="panel-c panel-c2">${celda(inds[2])}</td>
        <td class="panel-c panel-c2">${celda(inds[3])}</td>
      </tr>
    </table>
    ${comparar ? `<div class="panel-nota">La variación compara con ${esc(comparacion)}.</div>` : ''}
  </div>`
}

/** Rótulo de sección: filete fino, versalita y nada más. */
function rotulo(texto: string, apunte?: string): string {
  return `<div class="rotulo"><span>${esc(texto)}</span>${
    apunte ? `<span class="rotulo-apunte">${esc(apunte)}</span>` : ''
  }</div>`
}

function figura(titulo: string, nota: string, svg: string): string {
  return `
  <figure class="fig">
    <figcaption>
      <span class="fig-t">${esc(titulo)}</span>
      <span class="fig-n">${esc(nota)}</span>
    </figcaption>
    ${svg}
  </figure>`
}

/** Barra de proporción: la parte-del-todo se lee mejor así que en un anillo. */
function franja(partes: Array<{ nombre: string; valor: number; color: string }>): string {
  const total = partes.reduce((a, b) => a + b.valor, 0)
  if (!total) return ''
  return `
  <div class="franja">
    ${partes
      .filter((p) => p.valor > 0)
      .map(
        (p) =>
          `<span style="width:${((p.valor / total) * 100).toFixed(2)}%;background:${p.color}"></span>`,
      )
      .join('')}
  </div>
  <div class="franja-pie">
    ${partes
      .filter((p) => p.valor > 0)
      .map(
        (p) =>
          `<span class="lg"><i style="background:${p.color}"></i>${esc(p.nombre)} <b>${p.valor}</b></span>`,
      )
      .join('')}
  </div>`
}

/** Medidor de una razón contra su límite. Mismo tono en pista y relleno. */
function medidor(parte: number, total: number, tono = ACENTO): string {
  const pct = total ? Math.min(100, Math.round((parte / total) * 100)) : 0
  return `<span class="med"><span style="width:${Math.max(pct === 0 ? 0 : 2, pct)}%;background:${tono}"></span></span>`
}

function vacio(texto: string): string {
  return `<p class="vacio">${esc(texto)}</p>`
}

interface Columna<T> {
  cab: string
  /** Alineado a la derecha y en mono: es una cifra. */
  num?: boolean
  ancho?: string
  celda: (fila: T) => string
}

function tabla<T>(filas: T[], cols: Array<Columna<T>>): string {
  return `
  <table class="datos">
    <thead><tr>${cols
      .map((c) => `<th${c.num ? ' class="num"' : ''}${c.ancho ? ` style="width:${c.ancho}"` : ''}>${esc(c.cab)}</th>`)
      .join('')}</tr></thead>
    <tbody>
      ${filas
        .map(
          (f) =>
            `<tr>${cols.map((c) => `<td${c.num ? ' class="num"' : ''}>${c.celda(f)}</td>`).join('')}</tr>`,
        )
        .join('')}
    </tbody>
  </table>`
}

// ── Secciones ────────────────────────────────────────────────────────────────

/**
 * La actividad del periodo, día a día.
 *
 * Los sábados y domingos EN BLANCO no se dibujan. El servicio trabaja de lunes
 * a viernes: en un periodo de cinco semanas son diez columnas a cero que
 * estrechan a las demás y dan al gráfico un aspecto de parón que no ha
 * existido. No se esconde nada —el total de la sección se cuenta sobre el
 * periodo entero— y el fin de semana CON movimiento sí se dibuja: es
 * precisamente el dato que hay que ver, y su etiqueta lo dice sola, «S 1».
 */
function seccionActividad(d: ReportData): string {
  if (d.serieDiaria.length < 2) return ''
  const total = d.serieDiaria.reduce((a, x) => a + x.revisiones + x.abiertas + x.resueltas, 0)
  const serie = d.serieDiaria.filter(
    (x) => diaDeLaSemana(x.dia) < 6 || x.revisiones + x.abiertas + x.resueltas > 0,
  )
  const fuera = d.serieDiaria.length - serie.length

  return `
  <section class="bloque">
    ${rotulo('Actividad', d.dias === 1 ? 'la jornada' : `los ${d.dias} días del periodo`)}
    ${
      total === 0
        ? vacio('Ningún movimiento registrado en el periodo: ni revisiones, ni altas, ni cierres.')
        : figura(
            'Día a día',
            `Revisiones completadas, registros abiertos y cerrados${
              fuera > 0 ? ' · fines de semana sin actividad, fuera del gráfico' : ''
            }`,
            actividadDiaria(
              serie.map((x) => etiquetaDia(x.dia)),
              [
                { nombre: 'Revisiones', datos: serie.map((x) => x.revisiones) },
                { nombre: 'Abiertas', datos: serie.map((x) => x.abiertas) },
                { nombre: 'Cerradas', datos: serie.map((x) => x.resueltas) },
              ],
              { width: ANCHO_TOTAL, height: 212 },
            ),
          )
    }
  </section>`
}

function seccionAnalisis(l: Lectura): string {
  if (!l.hallazgos.length) return ''

  // De dos en dos: cuatro notas seguidas en una columna se leen como una lista
  // de avisos, y en dos columnas como las notas al margen de un informe.
  const pares: Array<[typeof l.hallazgos[number], typeof l.hallazgos[number] | undefined]> = []
  for (let i = 0; i < l.hallazgos.length; i += 2) {
    pares.push([l.hallazgos[i]!, l.hallazgos[i + 1]])
  }

  const nota = (h: { titulo: string; cuerpo: string }, n: number): string => `
    <div class="nota">
      <div class="nota-n">${String(n).padStart(2, '0')}</div>
      <div class="nota-t">${esc(h.titulo)}</div>
      <div class="nota-c">${esc(h.cuerpo)}</div>
    </div>`

  return `
  <section class="bloque">
    ${rotulo('Lo que dicen los datos')}
    <table class="notas">
      ${pares
        .map(
          ([a, b], fila) => `
      <tr>
        <td class="col-nota">${nota(a, fila * 2 + 1)}</td>
        <td class="col-nota">${b ? nota(b, fila * 2 + 2) : ''}</td>
      </tr>`,
        )
        .join('')}
    </table>
  </section>`
}

function seccionEdificios(d: ReportData, conTendencia: boolean): string {
  const conActividad = d.porEdificio.filter((b) => b.abiertas > 0)
  const top = conActividad.slice(0, 8)

  const izquierda = top.length
    ? figura(
        'Registros abiertos por edificio',
        'En el periodo, sin contar borradores',
        barrasHorizontales(
          top.map((b) => b.code),
          top.map((b) => b.abiertas),
          { width: ANCHO_MEDIO, height: Math.max(120, 24 + top.length * 22) },
        ),
      )
    : vacio('Ningún registro nuevo asignado a un edificio en el periodo.')

  const derecha =
    conTendencia && d.porMes.length > 1
      ? figura(
          'Aperturas por mes',
          'Últimos doce meses, todo el campus',
          tendencia(
            d.porMes.map((m) => m.month.slice(2)),
            d.porMes.map((m) => m.total),
            { width: ANCHO_MEDIO, height: 190 },
          ),
        )
      : ''

  // Con un solo tipo, la franja es una barra al 100 % que no compara nada.
  const composicion = d.porTipo.filter((t) => t.total > 0).length > 1
    ? `
    <div class="sub">
      <div class="sub-t">Composición de lo abierto</div>
      ${franja([
        {
          nombre: 'Incidencias',
          valor: d.porTipo.find((t) => t.tipo === 'incidencia')?.total ?? 0,
          color: '#4A78D4',
        },
        {
          nombre: 'Solicitudes',
          valor: d.porTipo.find((t) => t.tipo === 'solicitud')?.total ?? 0,
          color: '#12A396',
        },
        {
          nombre: 'Observaciones',
          valor: d.porTipo.find((t) => t.tipo === 'observacion')?.total ?? 0,
          color: '#B063D6',
        },
      ])}
      <p class="apunte">Una solicitud no es una avería: es trabajo pedido. Una observación
      es una nota de seguimiento. Solo las incidencias penalizan la fiabilidad de la sala.</p>
    </div>`
    : ''

  /*
   * Solo los edificios con algo que contar. Con diecisiete filas, once de ellas
   * a cero, la tabla ocupaba dos páginas para decir que no se pasó por allí. Los
   * que se quedan fuera se cuentan al pie: quitar filas sin avisar es esconder.
   *
   * El criterio es LO QUE PASÓ, no si el edificio sigue en la lista de trabajo.
   * Antes se pedía además `salas > 0` y eso borraba del informe un edificio
   * archivado entero —el que se manda a la papelera cuando se reorganiza el
   * campus— con todas sus revisiones y sus incidencias dentro. El total de
   * arriba las seguía contando, así que el documento se contradecía solo.
   */
  const conDatos = d.porEdificio.filter(
    (b) => b.revisadas > 0 || b.abiertas > 0 || b.pendientes > 0,
  )
  const cobertura = conDatos.slice(0, 12)
  // Los dos recortes por separado, porque el pie los nombra y no son lo mismo:
  // llamar «sin actividad» a un edificio que se quedó fuera por el tope de doce
  // filas TENIENDO datos es mentirle al lector en la línea que existe para no
  // esconderle nada.
  const recortados = conDatos.length - cobertura.length
  const sinActividad = d.porEdificio.length - conDatos.length
  const archivados = cobertura.filter((b) => b.archivado).length

  return `
  <section class="bloque">
    ${rotulo('Dónde está el trabajo')}
    ${
      derecha
        ? `<table class="dos"><tr>
      <td class="col-mitad">${izquierda}</td>
      <td class="col-mitad">${derecha}</td>
    </tr></table>`
        : izquierda
    }
    ${composicion}
    ${
      cobertura.length
        ? `<div class="sub">
      <div class="sub-t">Cobertura y cola por edificio</div>
      ${tabla(cobertura, [
        {
          cab: 'Edificio',
          ancho: '30%',
          celda: (b) => {
            const n = nombreEdificio(b.code, b.name)
            // La marca va pegada al nombre y no en una columna aparte: es lo
            // que explica el guion de la columna «Salas» de esa misma fila.
            const marca = b.archivado ? ' <span class="tenue">· archivado</span>' : ''
            return `<span class="mono">${esc(b.code)}</span>${n ? ` <span class="tenue">${esc(n)}</span>` : ''}${marca}`
          },
        },
        // Un edificio archivado no tiene salas en servicio, y un cero ahí se
        // leería como «no tiene aulas». El guion dice lo que es: no hay
        // denominador, no un denominador de cero.
        { cab: 'Salas', num: true, celda: (b) => (b.salas > 0 ? String(b.salas) : '—') },
        {
          cab: 'Revisadas',
          ancho: '26%',
          // `esc()` también aquí: `porcentaje()` puede devolver «<1 %», y un `<`
          // seguido de dígito es un error de parseo HTML que hoy tolera el
          // parser de WeasyPrint y mañana rompe la celda en cualquier otro.
          celda: (b) =>
            `${medidor(b.revisadas, b.salas)}<span class="med-n">${b.revisadas} · ${esc(porcentaje(b.revisadas, b.salas))}</span>`,
        },
        { cab: 'Abiertas', num: true, celda: (b) => (b.abiertas ? String(b.abiertas) : '—') },
        {
          cab: 'Pendientes hoy',
          num: true,
          celda: (b) =>
            b.pendientes
              ? `<span style="color:${b.pendientes > 3 ? CRIT : INK}">${b.pendientes}</span>`
              : '—',
        },
      ])}
      ${
        recortados > 0 || sinActividad > 0 || archivados > 0
          ? `<p class="apunte">${[
              recortados > 0
                ? `${plural(recortados, 'edificio')} con actividad fuera de la tabla por sitio`
                : '',
              sinActividad > 0
                ? `${plural(sinActividad, 'edificio')} sin actividad en el periodo`
                : '',
              // Que se sepa por qué esa fila no tiene salas: el edificio está en
              // la papelera y su trabajo del periodo se cuenta igual.
              archivados > 0
                ? `${plural(archivados, 'edificio')} archivado${archivados === 1 ? '' : 's'}: fuera de la lista de trabajo, con lo que pasó en el periodo`
                : '',
            ]
              .filter(Boolean)
              .join(' · ')}.</p>`
          : ''
      }
    </div>`
        : ''
    }
  </section>`
}

/**
 * Las revisiones del periodo, una por línea.
 *
 * El día se escribe solo cuando cambia, como en un libro de registro. Repetirlo
 * treinta y una veces convierte la primera columna en un muro y hace más difícil
 * ver dónde empieza cada jornada, que es justo lo que se viene a mirar.
 */
function seccionRevisiones(d: ReportData): string {
  if (!d.revisiones.length) {
    return `
  <section class="bloque evitar">
    ${rotulo('Revisiones del periodo')}
    ${vacio('No se ha completado ninguna revisión en el periodo.')}
  </section>`
  }

  /*
   * El histórico importado no trae autor: sin esto, la tabla de una semana de
   * datos antiguos era una columna entera de guiones. Se enseña cuando hay algo
   * que enseñar, que es la misma regla que con las secciones vacías.
   */
  const conAutor = d.revisiones.some((r) => r.quien)

  let diaAnterior = ''
  const filas = d.revisiones
    .map((r) => {
      const nuevoDia = r.dia !== diaAnterior
      diaAnterior = r.dia
      const n = nombreSala(r.room, r.name)
      const salida =
        r.resultado === 'ok'
          ? '<span class="tenue">sin incidencias</span>'
          : `<span style="color:${WARN}">${
              r.fallos ? plural(r.fallos, 'fallo') : 'con incidencias'
            }</span>${r.aperturas ? ` · ${plural(r.aperturas, 'registro')} abierto${r.aperturas === 1 ? '' : 's'}` : ''}`

      return `<tr${nuevoDia ? ' class="jornada"' : ''}>
      <td class="mono tenue">${nuevoDia ? esc(etiquetaDia(r.dia)) : ''}</td>
      <td class="mono tenue">${esc(r.hora)}</td>
      <td><span class="mono">${esc(r.building)} ${esc(r.room)}</span>${
        n ? ` <span class="tenue">${esc(n)}</span>` : ''
      }</td>
      ${conAutor ? `<td>${r.quien ? esc(r.quien) : '<span class="tenue">—</span>'}</td>` : ''}
      <td>${salida}</td>
    </tr>`
    })
    .join('')

  const fuera = d.revisionesTotal - d.revisiones.length

  return `
  <section class="bloque">
    ${rotulo('Revisiones del periodo', plural(d.revisionesTotal, 'revisión', 'revisiones'))}
    <table class="datos">
      <thead><tr>
        <th style="width:8%">Día</th><th style="width:8%">Hora</th>
        <th style="width:${conAutor ? '34' : '52'}%">Sala</th>
        ${conAutor ? '<th style="width:24%">Quién</th>' : ''}
        <th>Resultado</th>
      </tr></thead>
      <tbody>${filas}</tbody>
    </table>
    ${
      fuera > 0
        ? `<p class="apunte">Y ${plural(fuera, 'revisión', 'revisiones')} más, fuera de la tabla.
           El listado completo está en el histórico de cada sala.</p>`
        : ''
    }
  </section>`
}

/** Cómo se llama cada cosa que pasa, en la columna del diario. */
function etiquetaEvento(tipo: string, subtipo: string): string {
  if (tipo === 'apertura') {
    if (subtipo === 'solicitud') return 'Solicitud'
    if (subtipo === 'observacion') return 'Observación'
    return 'Incidencia'
  }
  if (tipo === 'cierre') return 'Cierre'
  if (tipo === 'material') {
    if (subtipo === 'consumo') return 'Material'
    if (subtipo === 'compra') return 'Compra'
    if (subtipo === 'devolucion') return 'Devolución'
    return 'Ajuste'
  }
  if (tipo === 'inventario') return 'Inventario'
  return 'Equipo'
}

/**
 * El diario del periodo: qué pasó, en orden y por días.
 *
 * Las revisiones no se repiten aquí —tienen su tabla— pero sí se cuentan en la
 * cabecera de cada jornada, para que un día con seis revisiones y ningún evento
 * no aparezca como un día en blanco.
 *
 * Va agrupado por día y no como una sola tabla de cien filas porque la pregunta
 * que se le hace a un diario es «¿qué pasó el miércoles?», y para responderla en
 * una tabla plana hay que buscar dónde cambia la fecha.
 */
function seccionEventos(d: ReportData, conRevisiones: boolean): string {
  const porDia = new Map<string, ReportData['eventos']>()
  for (const e of d.eventos) {
    const lista = porDia.get(e.dia) ?? []
    lista.push(e)
    porDia.set(e.dia, lista)
  }

  // Todos los días del periodo con algo que contar: eventos o revisiones.
  const dias = d.serieDiaria
    .filter((s) => porDia.has(s.dia) || s.revisiones > 0)
    .map((s) => s.dia)

  if (!dias.length) {
    return `
  <section class="bloque evitar">
    ${rotulo('Diario del periodo')}
    ${vacio('Ni un movimiento registrado en el periodo.')}
  </section>`
  }

  /*
   * Con el listado recortado, «Solo revisiones: ningún registro nuevo…» pasa a
   * ser una afirmación que no se puede hacer: los eventos van en orden y el
   * tope de filas corta por el final, así que del último día listado en
   * adelante puede haber movimientos que simplemente no caben. Los días
   * ANTERIORES al corte sí están completos y conservan la frase.
   */
  const truncado = d.eventosTotal > d.eventos.length
  const ultimoDiaListado = d.eventos.length ? d.eventos[d.eventos.length - 1]!.dia : ''

  const jornada = (dia: string): string => {
    const s = d.serieDiaria.find((x) => x.dia === dia)
    const resumen = [
      s?.revisiones ? plural(s.revisiones, 'revisión', 'revisiones') : '',
      s?.abiertas ? plural(s.abiertas, 'abierta') : '',
      s?.resueltas ? plural(s.resueltas, 'cerrada') : '',
    ]
      .filter(Boolean)
      .join(' · ')

    const eventos = porDia.get(dia) ?? []

    return `
    <div class="dia">
      <div class="dia-cab">
        <span class="dia-fecha">${esc(nombreDia(dia))}</span>
        ${resumen ? `<span class="dia-res">${esc(resumen)}</span>` : ''}
      </div>
      ${
        eventos.length
          ? `<table class="datos diario">
        <tbody>
          ${eventos
            .map((e) => {
              // El detalle importado repite el título tal cual en muchas filas:
              // imprimirlo dos veces solo gasta papel.
              const detalle =
                e.detalle && e.detalle.trim() !== e.titulo.trim() ? e.detalle.trim() : ''
              // Sin el separador colgando: con cantidad y sin autor salía «1 ud ·».
              const cola = [
                e.cantidad !== null && e.cantidad !== 0 ? `${Math.abs(e.cantidad)} ud` : '',
                e.quien ?? '',
              ]
                .filter(Boolean)
                .join(' · ')
              return `<tr>
            <td class="mono tenue" style="width:7%">${esc(e.hora)}</td>
            <td style="width:13%"><span class="tag">${esc(etiquetaEvento(e.tipo, e.subtipo))}</span></td>
            <td class="mono" style="width:14%">${esc(`${e.building} ${e.room}`.trim())}</td>
            <td>${esc(recorta(e.titulo, 90))}${
              detalle ? `<span class="ev-det">${esc(recorta(detalle, 110))}</span>` : ''
            }</td>
            <td class="tenue" style="width:16%">${esc(cola)}</td>
          </tr>`
            })
            .join('')}
        </tbody>
      </table>`
          : truncado && dia >= ultimoDiaListado
            ? `<p class="vacio">Jornada recortada por extensión: el detalle está en el histórico de cada sala.</p>`
            : `<p class="vacio">Solo revisiones: ningún registro nuevo ni consumo de material.</p>`
      }
    </div>`
  }

  const fuera = d.eventosTotal - d.eventos.length

  return `
  <section class="bloque">
    ${rotulo('Diario del periodo', `${plural(d.eventosTotal, 'movimiento')}${conRevisiones ? ', aparte de las revisiones' : ''}`)}
    ${dias.map(jornada).join('')}
    ${
      fuera > 0
        ? `<p class="apunte">Y ${plural(fuera, 'movimiento')} más, fuera del diario: la lista se
           corta en ${d.eventos.length}. El detalle completo está en el histórico de cada sala.</p>`
        : ''
    }
  </section>`
}

/** La tendencia por su cuenta, cuando se pide sin el reparto por edificio. */
function seccionTendencia(d: ReportData): string {
  if (d.porMes.length < 2) return ''
  return `
  <section class="bloque evitar">
    ${rotulo('Tendencia', 'últimos doce meses')}
    ${figura(
      'Aperturas por mes',
      'Todo el campus, sin contar borradores',
      tendencia(
        d.porMes.map((m) => m.month.slice(2)),
        d.porMes.map((m) => m.total),
        { width: ANCHO_TOTAL, height: 200 },
      ),
    )}
  </section>`
}

function seccionSalas(d: ReportData): string {
  if (!d.topSalas.length && !d.reincidentes.length) return ''

  return `
  <section class="bloque">
    ${rotulo('Salas señaladas')}
    ${
      d.topSalas.length
        ? tabla(d.topSalas, [
            {
              cab: 'Sala',
              ancho: '46%',
              celda: (r) => {
                const n = nombreSala(r.room, r.name)
                return `<span class="mono">${esc(r.building)} ${esc(r.room)}</span>${n ? ` <span class="tenue">${esc(n)}</span>` : ''}`
              },
            },
            { cab: 'Incidencias', num: true, celda: (r) => String(r.total) },
            {
              cab: 'Fiabilidad',
              ancho: '26%',
              celda: (r) =>
                r.hayDatos && r.fiabilidad !== null
                  ? `${medidor(r.fiabilidad, 100, r.fiabilidad < 50 ? CRIT : r.fiabilidad < 75 ? WARN : OK)}<span class="med-n">${r.fiabilidad}/100</span>`
                  : '<span class="tenue">datos insuficientes</span>',
            },
          ])
        : vacio('Ninguna sala ha acumulado incidencias en el periodo.')
    }
    ${
      d.reincidentes.length
        ? `<div class="sub">
      <div class="sub-t">Mismo repuesto, misma sala</div>
      <p class="apunte">Tres veces la misma pieza en seis meses no es mala suerte. Se agrupa por
      artículo consumido y no por el texto del parte, que cada uno escribe distinto.</p>
      ${tabla(d.reincidentes, [
        { cab: 'Sala', celda: (r) => `<span class="mono">${esc(r.building)} ${esc(r.room)}</span>` },
        { cab: 'Repuesto', ancho: '50%', celda: (r) => esc(r.item) },
        { cab: 'Veces', num: true, celda: (r) => `<span style="color:${CRIT}">${r.veces}</span>` },
      ])}
    </div>`
        : ''
    }
  </section>`
}

function seccionLamparas(d: ReportData): string {
  return `
  <section class="bloque evitar">
    ${rotulo('Lámparas al límite', 'por debajo del 20 % de vida')}
    ${
      d.lamparas.length
        ? tabla(d.lamparas, [
            { cab: 'Sala', ancho: '34%', celda: (r) => `<span class="mono">${esc(r.building)} ${esc(r.room)}</span>` },
            { cab: 'Horas de proyector', num: true, celda: (r) => (r.horas === null ? '—' : String(r.horas)) },
            {
              cab: 'Vida restante',
              ancho: '30%',
              celda: (r) =>
                `${medidor(Math.round(r.pct * 100), 100, CRIT)}<span class="med-n" style="color:${CRIT}">${Math.round(r.pct * 100)} %</span>`,
            },
          ])
        : vacio('Ninguna lámpara por debajo del umbral. Nada que pedir esta semana.')
    }
  </section>`
}

function seccionEstancadas(d: ReportData): string {
  return `
  <section class="bloque">
    ${rotulo('Sin cerrar', 'más de siete días abiertas')}
    ${
      d.estancadas.length
        ? tabla(d.estancadas, [
            { cab: 'Referencia', ancho: '15%', celda: (r) => `<span class="mono tenue">${esc(r.ref ?? '—')}</span>` },
            { cab: 'Qué pasa', ancho: '45%', celda: (r) => esc(r.titulo.slice(0, 78)) },
            { cab: 'Sala', celda: (r) => `<span class="mono">${esc(`${r.building} ${r.room}`.trim())}</span>` },
            { cab: 'Gravedad', celda: (r) => `<span class="tenue">${esc(r.gravedad)}</span>` },
            {
              cab: 'Días',
              num: true,
              celda: (r) => `<span style="color:${r.dias > 30 ? CRIT : WARN}">${r.dias}</span>`,
            },
          ])
        : vacio('Ninguna incidencia lleva más de una semana abierta.')
    }
  </section>`
}

function seccionMateriales(d: ReportData): string {
  return `
  <section class="bloque evitar">
    ${rotulo('Material consumido', 'del almacén, en el periodo')}
    ${
      d.materiales.length
        ? tabla(d.materiales, [
            { cab: 'Artículo', ancho: '52%', celda: (m) => esc(m.name) },
            { cab: 'Unidades', num: true, celda: (m) => `${m.consumido} ${esc(m.unidad)}` },
            {
              cab: 'Partes en los que se usó',
              num: true,
              celda: (m) => (m.incidencias ? String(m.incidencias) : '—'),
            },
          ])
        : vacio('Sin consumo de almacén registrado en el periodo.')
    }
  </section>`
}

/**
 * Cuánto se tarda en cerrar. Sección propia, y se puede quitar.
 *
 * Es una cifra que describe bien y justifica mal: «la mitad se cierra en 1,4
 * días» no dice nada de la que llevó veinticuatro, y en una reunión donde hay
 * que explicar UNA, el promedio se vuelve en contra de quien lo enseña. Por eso
 * se desmarca sola, y por eso el desglose de al lado es otra sección: quien
 * necesita justificar lleva los cierres uno a uno y deja fuera la media.
 */
function seccionTiempos(d: ReportData): string {
  if (d.resolucion.resueltas === 0) {
    return `
  <section class="bloque evitar">
    ${rotulo('Cuánto se tarda en cerrar')}
    ${vacio('No se ha cerrado nada en el periodo.')}
  </section>`
  }

  return `
  <section class="bloque evitar">
    ${rotulo('Cuánto se tarda en cerrar')}
    <table class="cifras">
      <tr><td>La mitad se cierra en</td><td class="num">${esc(textoDias(d.resolucion.medianaDias))}</td></tr>
      ${
        // Si la media dice lo mismo que la mediana, la fila solo repite.
        textoDias(d.resolucion.mediaDias) !== textoDias(d.resolucion.medianaDias)
          ? `<tr><td>Media, arrastrando las antiguas</td><td class="num">${esc(textoDias(d.resolucion.mediaDias))}</td></tr>`
          : ''
      }
      <tr><td>Cerradas en menos de 48 h</td><td class="num">${d.resolucion.enMenosDe48h} de ${d.resolucion.resueltas}</td></tr>
    </table>
    <p class="apunte">La mediana va primero porque la media la mueve cualquier
    parte antiguo que se cierre esta semana.</p>
  </section>`
}

/**
 * Cada cierre, con sus dos fechas y sus días escritos enteros.
 *
 * Esta es la sección que se lleva a una reunión donde hay que justificar un
 * tiempo. Un promedio no justifica nada: lo que justifica es «se abrió el 27 de
 * julio a las 09:12, se cerró el 20 de agosto a las 11:40, veinticuatro días y
 * dos horas, y lo que se hizo fue cambiar la lámpara —que hubo que pedirla—».
 * De ahí que estén las dos horas y el texto del cierre, y de ahí el orden: la
 * que más tardó primero, que es por la que se pregunta.
 */
function seccionCierres(d: ReportData): string {
  if (!d.cierres.length) {
    return `
  <section class="bloque evitar">
    ${rotulo('Cada cierre, con sus días')}
    ${vacio('No se ha cerrado ningún registro en el periodo.')}
  </section>`
  }

  const conAutor = d.cierres.some((c) => c.quien)
  const fuera = d.cierresTotal - d.cierres.length

  return `
  <section class="bloque">
    ${rotulo('Cada cierre, con sus días', plural(d.cierresTotal, 'cierre'))}
    <table class="datos">
      <thead><tr>
        <th style="width:23%">Qué se cerró</th>
        <th style="width:11%">Sala</th>
        <th style="width:13%">Se abrió</th>
        <th style="width:13%">Se cerró</th>
        <th class="num" style="width:15%">Llevó</th>
        <th>Qué se hizo${conAutor ? ' y quién' : ''}</th>
      </tr></thead>
      <tbody>
        ${d.cierres
          .map(
            (c) => `<tr>
        <td>${esc(recorta(c.titulo, 60))}${
          c.ref ? `<span class="ev-det mono">${esc(c.ref)}</span>` : ''
        }</td>
        <td class="mono tenue">${esc(c.building)} ${esc(c.room)}</td>
        <td class="mono tenue">${esc(etiquetaDia(c.abierta))} ${esc(c.horaAbierta)}</td>
        <td class="mono tenue">${esc(etiquetaDia(c.cerrada))} ${esc(c.horaCerrada)}</td>
        <td class="num"${c.dias >= 7 ? ` style="color:${WARN}"` : ''}>${esc(diasLargo(c.dias))}</td>
        <td>${
          c.resolucion
            ? esc(recorta(c.resolucion, 120))
            : '<span class="tenue">no se apuntó qué se hizo</span>'
        }${c.quien ? `<span class="ev-det">${esc(c.quien)}</span>` : ''}</td>
      </tr>`,
          )
          .join('')}
      </tbody>
    </table>
    ${
      fuera > 0
        ? `<p class="apunte">Y ${plural(fuera, 'cierre')} más, fuera de la tabla por sitio.
           Están todos en el histórico de cada sala.</p>`
        : ''
    }
  </section>`
}

/**
 * Las fotos, dentro del documento.
 *
 * Tres por fila y con su pie: sala, día y de qué incidencia es. Una foto sin
 * saber de dónde salió no prueba nada — y este documento se archiva justamente
 * para poder volver a él.
 *
 * `page-break-inside: avoid` en cada una: una foto partida entre dos páginas no
 * se lee, y en un informe que alguien firma queda como un descuido.
 */
/**
 * De qué momento es cada foto, escrito en el pie.
 *
 * Sin esto, tres fotos de la misma aula se leen como tres fotos de la misma
 * aula. Con esto, la primera es el problema encontrado, la última es el aula
 * arreglada, y entre las dos hay un trabajo hecho — que es exactamente lo que
 * un informe tiene que poder demostrar.
 */
const MOMENTO: Record<ReportData['fotos'][number]['momento'], string> = {
  revision: 'En la revisión',
  apertura: 'Incidencia abierta',
  cierre: 'Al resolverla',
}

function seccionFotos(d: ReportData): string {
  if (!d.fotos.length) {
    // Sin fotos no se imprime la sección: «no hay fotos» no informa de nada.
    return ''
  }

  const filas: Array<ReportData['fotos']> = []
  for (let i = 0; i < d.fotos.length; i += 3) filas.push(d.fotos.slice(i, i + 3))
  const fuera = d.fotosTotal - d.fotos.length

  const cuantas = (m: ReportData['fotos'][number]['momento']): number =>
    d.fotos.filter((f) => f.momento === m).length
  const reparto = (
    [
      [cuantas('revision'), 'de revisiones'],
      [cuantas('apertura'), 'de incidencias abiertas'],
      [cuantas('cierre'), 'de incidencias resueltas'],
    ] as Array<[number, string]>
  )
    .filter(([n]) => n > 0)
    .map(([n, que]) => `${n} ${que}`)
    .join(', ')

  return `
  <section class="bloque">
    ${rotulo('Fotos del periodo', plural(d.fotos.length, 'foto'))}
    <p class="apunte">Cada foto dice de cuándo es: ${esc(reparto)}. Las de una misma
    incidencia van seguidas, de cómo se encontró a cómo quedó.</p>
    <table class="fotos">
      ${filas
        .map(
          (fila) => `<tr>${[0, 1, 2]
            .map((i) => {
              const f = fila[i]
              if (!f) return '<td class="col-foto"></td>'
              return `<td class="col-foto">
        <figure class="foto">
          <img src="${f.datos}" alt="">
          <figcaption>
            <span class="momento">${esc(MOMENTO[f.momento])}</span>
            <span class="mono">${esc(f.building)} ${esc(f.room)}</span>
            <span class="tenue"> · ${esc(etiquetaDia(f.dia))} ${esc(f.hora)}</span>
            <span class="foto-de">${esc(recorta(f.titulo, 54))}</span>
          </figcaption>
        </figure>
      </td>`
            })
            .join('')}</tr>`,
        )
        .join('')}
    </table>
    ${
      fuera > 0
        ? `<p class="apunte">Hay ${plural(fuera, 'foto')} más del periodo que no caben en el
           documento. Están en la ficha de cada aula y de cada incidencia.</p>`
        : ''
    }
  </section>`
}

function seccionEquipo(d: ReportData): string {
  if (!d.equipo.length) return ''
  return `
  <section class="bloque evitar">
    ${rotulo('Reparto del trabajo')}
    <p class="apunte">No es un ranking. Una revisión rutinaria y una botonera desmontada
    cuentan igual aquí y no cuestan lo mismo.</p>
    ${tabla(d.equipo, [
      { cab: 'Persona', ancho: '52%', celda: (p) => esc(p.nombre) },
      { cab: 'Revisiones', num: true, celda: (p) => String(p.revisiones) },
      { cab: 'Registros abiertos', num: true, celda: (p) => String(p.registros) },
    ])}
  </section>`
}

function seccionRecomendaciones(l: Lectura): string {
  if (!l.recomendaciones.length) return ''
  return `
  <section class="bloque evitar">
    ${rotulo('Qué conviene hacer')}
    <ol class="acciones">
      ${l.recomendaciones
        .map(
          (r) => `<li>
        <div class="acc-t">${esc(r.accion)}</div>
        <div class="acc-p">${esc(r.porque)}</div>
      </li>`,
        )
        .join('')}
    </ol>
  </section>`
}

/**
 * Las salvedades del alcance. Nada más.
 *
 * Aquí había una «Procedencia» que volvía a decir la fecha de emisión, el
 * periodo, el tramo comparado y quién lo pidió: las cuatro cosas están en la
 * cabecera, a un palmo de distancia. Y cerraba con un párrafo explicando que un
 * informe emitido no se regenera. Un documento profesional no se explica a sí
 * mismo: dice lo que hace falta para leer sus cifras y calla el resto.
 *
 * Lo que queda es lo único que las cifras no pueden decir por su cuenta: qué se
 * ha quedado FUERA de la cuenta y por qué. Sin salvedades el bloque entero
 * desaparece, en vez de imprimir una caja con una obviedad dentro.
 *
 * Del rastro de cómo se preparó el análisis sigue sin haber nada, y a
 * propósito: vive en `reports.params` con cada informe y la pantalla de
 * Informes lo enseña. Quien tenga que auditarlo lo tiene; quien lea el PDF, no
 * lo necesita.
 */
function colofon(d: ReportData, o: Opciones): string {
  const partes: string[] = []
  if (d.situacion.salasNuncaRevisadas > 0) {
    partes.push(
      `${d.situacion.salasNuncaRevisadas} de las ${d.situacion.salasTotal} salas activas no tienen ninguna revisión registrada: no entran en ningún indicador.`,
    )
  }
  if (d.sinSala > 0) {
    partes.push(
      `${plural(d.sinSala, 'registro')} sin sala asignada: cuentan en los totales, no en el desglose por edificio.`,
    )
  }
  /*
   * Esta frase es la que faltaba cuando un edificio entero se fue a la papelera
   * y su trabajo pareció evaporarse. Ahora se cuenta, y además se dice: sin
   * esta línea, el informe y la pantalla de revisar enseñan campus distintos y
   * no hay forma de saber cuál de los dos está mal.
   */
  if (d.salasArchivadas > 0) {
    partes.push(
      `${plural(d.salasArchivadas, 'sala')} fuera de la lista de trabajo —archivadas ellas o su edificio—: lo que se hizo en ellas se cuenta igual.`,
    )
  }
  // Contra el conjunto por defecto, no contra un número escrito a mano: al
  // añadir dos secciones nuevas, el «< 10» de antes habría marcado como parcial
  // hasta el informe completo.
  if (o.secciones.length < SECCIONES_POR_DEFECTO.length) {
    partes.push('Informe parcial: se han pedido solo las secciones marcadas.')
  }
  if (!partes.length) return ''

  return `
  <section class="colofon">
    ${rotulo('Alcance de los datos')}
    <ul class="salvedades">${partes.map((p) => `<li>${p}</li>`).join('')}</ul>
  </section>`
}

// ── El documento ─────────────────────────────────────────────────────────────

export function renderReport(
  d: ReportData,
  l: Lectura,
  o: Opciones,
  pie: Pie,
): string {
  const titulo = TITULO_TIPO[d.kind] ?? 'Informe'
  const inds = indicadores(d)
  // Comparar con un tramo anterior vacío es comparar con nada: la flecha diría
  // «+2 (sin dato antes)» y ocuparía sitio para no informar.
  const comparar =
    o.comparar && d.antes.revisiones + d.antes.registros + d.antes.resueltas > 0

  /*
   * La tendencia de doce meses vive dentro de «Dónde está el trabajo», que es
   * donde tiene sentido leerla. Si alguien pide la tendencia SIN los edificios,
   * se imprime sola en vez de desaparecer: una sección marcada que no sale es un
   * informe incompleto sin avisar.
   */
  const tendenciaSola = tiene(o, 'tendencia') && !tiene(o, 'edificios')

  const secciones: Array<[Seccion, string]> = [
    ['actividad', seccionActividad(d)],
    ['analisis', seccionAnalisis(l)],
    ['revisiones', seccionRevisiones(d)],
    ['eventos', seccionEventos(d, tiene(o, 'revisiones'))],
    ['edificios', seccionEdificios(d, tiene(o, 'tendencia'))],
    ['tendencia', tendenciaSola ? seccionTendencia(d) : ''],
    ['salas', seccionSalas(d)],
    ['lamparas', seccionLamparas(d)],
    ['estancadas', seccionEstancadas(d)],
    ['materiales', seccionMateriales(d)],
    ['tiempos', seccionTiempos(d)],
    ['cierres', seccionCierres(d)],
    ['equipo', seccionEquipo(d)],
    ['fotos', seccionFotos(d)],
    ['recomendaciones', seccionRecomendaciones(l)],
  ]

  const cuerpo = secciones
    .filter(([clave, html]) => tiene(o, clave) && html)
    .map(([, html]) => html)
    .join('\n')

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${esc(titulo)} · ${esc(d.periodoTexto)}</title>
<style>
  @page {
    size: A4;
    margin: 18mm 16mm 16mm;
    @top-right {
      content: string(cabecera);
      font-family: "IBM Plex Sans", "Instrument Sans Variable", system-ui, sans-serif; font-size: 7.5pt; color: ${MUTED};
      vertical-align: bottom; padding-bottom: 3mm;
    }
    @bottom-left {
      content: "Grupo Oesia · Mantenimiento de aulas UFV";
      font-family: "IBM Plex Sans", "Instrument Sans Variable", system-ui, sans-serif; font-size: 7.5pt; color: ${MUTED};
      vertical-align: top; padding-top: 4mm;
    }
    @bottom-right {
      content: counter(page) " / " counter(pages);
      font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 7.5pt; color: ${MUTED};
      vertical-align: top; padding-top: 4mm;
    }
  }
  /* La primera página lleva la cabecera impresa en grande: repetirla arriba
     sobraría. */
  @page :first { @top-right { content: none } }

  body {
    font-family: "IBM Plex Sans", "Instrument Sans Variable", system-ui, sans-serif;
    font-size: 9.5pt; line-height: 1.45; color: ${INK}; margin: 0;
  }
  p { margin: 0 0 2.5mm; }

  /*
   * La vista previa dentro de la aplicación. Solo en pantalla.
   *
   * El documento está maquetado para la caja de texto de un A4 —178 mm, que es
   * también el ancho al que se dibujan los gráficos—. Sin esto, en el marco de
   * la pantalla los párrafos se estiran hasta donde llegue el navegador
   * mientras las figuras se quedan en su tamaño real, y lo primero que ve quien
   * acaba de generar su informe es una página descuadrada que en el PDF no lo
   * está.
   *
   * Y color-scheme en claro porque esto es papel: con el tema oscuro del
   * sistema puesto, el navegador se toma la libertad de invertir los colores
   * del marco.
   */
  @media screen {
    :root { color-scheme: light; }
    body {
      max-width: 178mm; margin: 0 auto; padding: 14mm 0 20mm;
      background: #FFFFFF;
    }
  }

  /* ── Cabecera ──
     Sin versalitas y sin tracking de cartel. La línea de arriba dice de quién
     es el documento y de qué tipo es, y para eso no hace falta levantar la voz:
     el punto de color hace el trabajo que hacían las mayúsculas. */
  .masthead { string-set: cabecera "${esc(titulo)} · ${esc(d.periodoTexto)}"; }
  .kicker {
    font-size: 9pt; color: ${MUTED}; font-weight: 500; letter-spacing: 0;
  }
  .kicker .punto {
    display: inline-block; width: 2.2mm; height: 2.2mm; border-radius: 50%;
    background: ${ACENTO}; margin-right: 1.8mm;
  }
  .kicker b { color: ${INK2}; font-weight: 600; }
  h1 {
    font-family: "IBM Plex Serif", Georgia, serif;
    font-size: 22pt; line-height: 1.22; font-weight: 600;
    letter-spacing: -0.005em; color: ${INK};
    margin: 3mm 0 0; max-width: 152mm;
  }
  .sumario {
    margin-top: 2.4mm; font-size: 9pt; color: ${MUTED};
    font-variant-numeric: tabular-nums;
  }
  /* El filete ya no corta: acompaña. Redondeado y corto, del ancho de una
     palabra. */
  .filete {
    height: 1.8pt; width: 14mm; border-radius: 1pt; background: ${ACENTO};
    margin: 4.5mm 0 0;
  }
  .nota-pedido {
    margin-top: 4.5mm; padding: 3mm 3.5mm; background: ${PAPEL};
    border-radius: 1.8mm; border-left: 2pt solid ${ACENTO};
    font-family: "IBM Plex Serif", Georgia, serif;
    font-size: 9pt; color: ${INK2};
  }

  /* ── Entrada: texto a la izquierda, cifras a la derecha ── */
  .entrada { width: 100%; border-collapse: collapse; margin-top: 6mm; }
  /* Sin selector de hijo directo a propósito: el navegador —y WeasyPrint—
     insertan un tbody que no está escrito, así que un ".entrada > tr" no casa
     con nada y la maquetación se cae a una sola columna. De ahí las clases. */
  .col-texto { width: 62%; padding-right: 10mm; vertical-align: top; }
  .col-panel { width: 38%; vertical-align: top; }

  /*
   * La entradilla, en bandera y sin partir palabras.
   *
   * Iba justificada con guiones, que es lo que se hace en un periódico porque
   * allí la columna es estrecha y la mancha tiene que ser un rectángulo. Aquí
   * no: justificar abre ríos entre palabras, y partir «acumu-lado» al final de
   * la línea obliga a montar la palabra en la cabeza. En bandera se lee más
   * rápido y suena a alguien contando algo, que es de lo que va este párrafo.
   */
  .entradilla {
    font-family: "IBM Plex Serif", Georgia, serif;
    font-size: 10.5pt; line-height: 1.68; color: ${INK2};
    text-align: left; hyphens: none;
  }

  .panel {
    background: ${PAPEL}; padding: 4mm; border-radius: 2mm;
    page-break-inside: avoid;
  }
  .panel-t {
    font-size: 8.5pt; font-weight: 600; color: ${INK2}; margin-bottom: 3mm;
  }
  .panel-rej { width: 100%; border-collapse: collapse; }
  .panel-c { width: 50%; vertical-align: top; padding: 0 3mm 0 0; }
  .panel-c2 { padding-top: 4mm; }
  .panel-et { font-size: 8pt; color: ${MUTED}; line-height: 1.3; }
  .panel-val {
    font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 16pt; font-weight: 600;
    font-variant-numeric: tabular-nums; line-height: 1.05; margin: 1mm 0 0.8mm;
  }
  .panel-det { font-size: 7.5pt; color: ${MUTED}; line-height: 1.35; }
  .panel-nota {
    font-size: 7pt; color: ${MUTED}; line-height: 1.35;
    border-top: 0.5pt solid ${LINE}; margin-top: 3.5mm; padding-top: 2mm;
  }

  .var { font-size: 7.5pt; margin-top: 1.2mm; color: ${MUTED}; }
  .var-pct { color: ${MUTED}; }
  .var .flecha {
    display: inline-block; width: 0; height: 0; margin-right: 1.2mm;
    border-left: 2.4pt solid transparent; border-right: 2.4pt solid transparent;
  }
  .var.sube .flecha { border-bottom: 3.6pt solid currentColor; }
  .var.baja .flecha { border-top: 3.6pt solid currentColor; }
  .var.bien { color: ${OK}; }
  .var.mal { color: ${WARN}; }
  .var.neutra { color: ${MUTED}; }

  /* ── Secciones ──
     El rótulo iba en versalitas con tracking y una raya negra debajo: catorce
     de esos en un documento de veinte páginas son catorce veces que alguien te
     habla en mayúsculas. En caja normal, con la serif del texto y una raya
     clara, el ojo los encuentra igual —son lo único a ese tamaño— y el
     documento baja el tono. */
  .bloque { margin-top: 11mm; }
  .bloque.evitar { page-break-inside: avoid; }
  .rotulo {
    display: flex; align-items: baseline; gap: 3mm;
    border-bottom: 0.6pt solid ${LINE}; padding-bottom: 1.8mm; margin-bottom: 4.5mm;
    /* Un rótulo suelto al pie de una página, con su sección en la siguiente, es
       el fallo de maquetación que más delata a un documento generado. */
    page-break-after: avoid;
  }
  .rotulo > span:first-child {
    font-family: "IBM Plex Serif", Georgia, serif;
    font-size: 12pt; font-weight: 600; letter-spacing: -0.005em; color: ${INK};
  }
  .rotulo-apunte { font-size: 8.5pt; color: ${MUTED}; letter-spacing: 0; }
  .sub { margin-top: 6mm; }
  .sub-t { font-size: 9.5pt; font-weight: 600; margin-bottom: 2.4mm; page-break-after: avoid; }
  /* El apunte que explica una tabla va SOBRE ella, así que necesita aire por
     abajo: sin él, la frase y la cabecera de la tabla se leían como un bloque
     de texto con una línea en negrita en medio. */
  .apunte {
    font-family: "IBM Plex Serif", Georgia, serif;
    font-size: 8.5pt; line-height: 1.5; color: ${MUTED}; margin: 2mm 0 3.5mm;
    max-width: 130mm;
  }
  /* Sin cursiva: en un documento generado, la cursiva de «sin datos» se lee
     como una disculpa del programa. Es una frase normal, y se dice normal. */
  .vacio { font-size: 8.8pt; color: ${MUTED}; }
  .tenue { color: ${MUTED}; }
  .mono { font-family: "IBM Plex Mono", ui-monospace, monospace; }

  /* ── Dos columnas de igual peso ── */
  .dos { width: 100%; border-collapse: collapse; }
  .col-mitad { width: 50%; vertical-align: top; padding-right: 6mm; }
  .col-mitad:last-child { padding-right: 0; }

  /* ── Figuras ── */
  .fig { margin: 0; page-break-inside: avoid; }
  .fig figcaption { margin-bottom: 2mm; page-break-after: avoid; }
  .fig-t { font-size: 9pt; font-weight: 600; display: block; }
  .fig-n { font-size: 8pt; color: ${MUTED}; display: block; }
  .fig svg { display: block; max-width: 100%; }

  /* ── Notas del análisis ── */
  .notas { width: 100%; border-collapse: collapse; }
  .col-nota {
    width: 50%; vertical-align: top; padding: 0 8mm 6mm 0;
    page-break-inside: avoid;
  }
  .col-nota:last-child { padding-right: 0; }
  /* El número del hallazgo, en una píldora teñida en vez de en cifras sueltas
     de máquina de escribir. Ocupa lo mismo y se lee como una etiqueta. */
  .nota-n {
    display: inline-block; font-size: 7.5pt; font-weight: 600; color: ${ACENTO};
    background: ${TINTE}; border-radius: 4mm; padding: 0.5mm 2.4mm;
    margin-bottom: 1.8mm;
  }
  .nota-t { font-size: 9.5pt; font-weight: 600; line-height: 1.3; margin-bottom: 1.4mm; }
  .nota-c {
    font-family: "IBM Plex Serif", Georgia, serif;
    font-size: 9pt; line-height: 1.55; color: ${INK2};
  }

  /* ── Tablas ── */
  table.datos { width: 100%; border-collapse: collapse; font-size: 8.8pt; }
  table.datos thead { display: table-header-group; }
  /* Las cabeceras, en caja normal: «Pendientes hoy» es más rápido de leer que
     «PENDIENTES HOY», y la raya que las separa de los datos no necesita ser
     negra para separar. */
  table.datos th {
    text-align: left; font-weight: 600; color: ${MUTED}; font-size: 8pt;
    letter-spacing: 0; line-height: 1.25;
    border-bottom: 0.6pt solid ${LINE}; padding: 0 4mm 1.6mm 0;
  }
  /* Sin sangría por la izquierda, dos rótulos contiguos se leían como uno:
     «SALASREVISADAS». La calle va por la izquierda de la columna numérica, que
     es la que la necesita. */
  table.datos th.num, table.datos td.num {
    text-align: right; padding-right: 0; padding-left: 5mm;
  }
  table.datos td {
    padding: 1.7mm 4mm 1.7mm 0; border-bottom: 0.5pt solid ${HAIR};
    vertical-align: baseline;
  }
  table.datos th:last-child, table.datos td:last-child { padding-right: 0; }
  /* La calle entre columnas se pone SIEMPRE por la izquierda de la segunda, no
     por la derecha de la primera: una columna numérica termina pegada a su
     borde derecho —es lo que la hace legible— y sin esto el rótulo siguiente se
     le juntaba encima. Se leía «SALASREVISADAS» y «1datos insuficientes». */
  table.datos th + th, table.datos td + td { padding-left: 3.5mm; }
  table.datos td.num {
    font-family: "IBM Plex Mono", ui-monospace, monospace; font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  table.datos tr { page-break-inside: avoid; }

  table.cifras { width: 100%; border-collapse: collapse; font-size: 8.8pt; }
  table.cifras td { padding: 1.7mm 0; border-bottom: 0.5pt solid ${HAIR}; }
  table.cifras td.num {
    text-align: right; font-variant-numeric: tabular-nums; font-weight: 600;
  }

  /* ── Diario y revisiones ── */
  /* Un filete fino donde empieza cada jornada: separa el bloque del día sin
     necesidad de dejar aire, que en una tabla de treinta filas se come media
     página. */
  table.datos tr.jornada td { border-top: 0.5pt solid ${LINE}; padding-top: 2.6mm; }
  table.datos tr.jornada:first-child td { border-top: 0; }

  /* La jornada SÍ se puede partir. Prohibirlo empujaba el día entero a la
     página siguiente y dejaba media en blanco. Lo que no se parte es la
     cabecera de su primera fila: un «miércoles 19» al pie de una página, con
     sus movimientos en la siguiente, es peor que el corte. */
  .dia { margin-bottom: 5mm; }
  .dia-cab {
    display: flex; align-items: baseline; gap: 3mm;
    border-bottom: 0.5pt solid ${LINE}; padding-bottom: 1.2mm; margin-bottom: 1.5mm;
    page-break-after: avoid;
  }
  .dia-fecha {
    font-family: "IBM Plex Serif", Georgia, serif;
    font-size: 9.5pt; font-weight: 600;
  }
  .dia-res { font-size: 8pt; color: ${MUTED}; }
  table.diario td { padding-top: 1.4mm; padding-bottom: 1.4mm; border-bottom: 0; }
  table.diario tr:not(:last-child) td { border-bottom: 0.5pt solid ${HAIR}; }
  .tag {
    display: inline-block; font-size: 7.5pt; letter-spacing: 0; color: ${MUTED};
    background: ${PAPEL}; border: 0.5pt solid ${LINE};
    border-radius: 3mm; padding: 0.4mm 1.8mm; white-space: nowrap;
  }
  .ev-det {
    display: block; font-family: "IBM Plex Serif", Georgia, serif;
    font-size: 8pt; color: ${MUTED}; line-height: 1.4; margin-top: 0.4mm;
  }

  /* ── Fotos ──
     Tres por fila, con su pie debajo. El salto se prohíbe en la CELDA y no en
     la fila: prohibirlo en la fila entera empuja las tres a la página siguiente
     y deja media en blanco. */
  table.fotos { width: 100%; border-collapse: collapse; }
  .col-foto {
    width: 33.33%; vertical-align: top; padding: 0 4mm 5mm 0;
    page-break-inside: avoid;
  }
  .col-foto:last-child { padding-right: 0; }
  .foto { margin: 0; }
  .foto img {
    display: block; width: 100%; height: 42mm; object-fit: cover;
    background: ${HAIR}; border: 0.5pt solid ${LINE}; border-radius: 1.5mm;
  }
  .foto figcaption { font-size: 7.5pt; color: ${MUTED}; margin-top: 1.2mm; line-height: 1.35; }
  /* El momento, en versalitas y encima de todo: es lo primero que hay que leer
     de una foto en un informe. En negro sobre el gris del resto del pie, para
     que se distinga sin necesidad de color — estos documentos se imprimen. */
  .momento {
    display: block; font-size: 7.5pt; font-weight: 600; color: ${ACENTO};
    letter-spacing: 0; margin-bottom: 0.4mm;
  }
  .foto-de {
    display: block; font-family: "IBM Plex Serif", Georgia, serif;
    font-size: 8pt; color: ${INK2}; line-height: 1.35; margin-top: 0.4mm;
  }

  /* ── Medidor ── */
  .med {
    display: inline-block; width: 14mm; height: 1.6mm; background: ${HAIR};
    border-radius: 0.8mm; margin-right: 2mm; vertical-align: middle; overflow: hidden;
  }
  .med > span { display: block; height: 100%; }
  .med-n {
    font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 8pt;
    font-variant-numeric: tabular-nums; color: ${MUTED};
  }

  /* ── Franja de composición ── */
  .franja {
    height: 3.4mm; width: 100%; overflow: hidden; background: ${HAIR};
    border-radius: 1.7mm; margin-bottom: 2mm;
  }
  .franja > span {
    display: inline-block; height: 3.4mm; vertical-align: top;
    /* 2 px de papel entre tramos: separa sin dibujar un borde. */
    box-shadow: inset -2px 0 0 #FFFFFF;
  }
  .franja-pie { font-size: 8pt; color: ${MUTED}; }
  .lg { margin-right: 5mm; white-space: nowrap; }
  .lg > i {
    display: inline-block; width: 2.2mm; height: 2.2mm; margin-right: 1.4mm;
    vertical-align: middle;
  }
  .lg b { font-family: "IBM Plex Mono", ui-monospace, monospace; color: ${INK}; font-weight: 600; }

  /* ── Acciones ── */
  .acciones { margin: 0; padding: 0; list-style: none; counter-reset: acc; }
  .acciones li {
    counter-increment: acc; position: relative;
    padding: 0 0 4mm 10mm; page-break-inside: avoid;
  }
  /* El número dentro de un disco teñido: la lista de lo que hay que hacer es lo
     único del documento que pide algo a alguien, y se agradece que no lo pida
     con una cifra a palo seco. */
  .acciones li::before {
    content: counter(acc);
    position: absolute; left: 0; top: -0.2mm;
    width: 6.4mm; height: 6.4mm; border-radius: 50%;
    background: ${TINTE}; color: ${ACENTO};
    font-size: 8.5pt; font-weight: 600; text-align: center; line-height: 6.4mm;
  }
  .acc-t { font-size: 9.5pt; font-weight: 600; line-height: 1.35; }
  .acc-p {
    font-family: "IBM Plex Serif", Georgia, serif;
    font-size: 9pt; color: ${INK2}; line-height: 1.5; margin-top: 0.8mm;
  }

  /* ── Colofón ── */
  .colofon {
    margin-top: 10mm; padding-top: 0; font-size: 8pt; color: ${MUTED};
    page-break-inside: avoid; line-height: 1.5;
  }
  .colofon .rotulo { border-bottom-color: ${LINE}; }
  .colofon p { max-width: 150mm; }
  /* En lista y no en un párrafo corrido: son salvedades independientes, y de
     seguido se leían como una sola frase larga que nadie termina. */
  .salvedades { margin: 0; padding: 0; list-style: none; max-width: 150mm; }
  .salvedades li { padding-left: 4mm; margin-bottom: 1.4mm; position: relative; }
  .salvedades li::before {
    content: "—"; position: absolute; left: 0; color: ${LINE};
  }

  /* ── Las dos marcas de la primera página ──
     La del servicio a la izquierda, la del campus a la derecha, y nada más en
     la banda: un logotipo compitiendo con el titular no es imagen corporativa,
     es ruido con colores. */
  .marcas { width: 100%; border-collapse: collapse; margin: 0 0 7mm; }
  .marca-emisor { text-align: left; vertical-align: middle; }
  .marca-cliente { text-align: right; vertical-align: middle; }
  .marcas svg { display: inline-block; vertical-align: middle; }

  /* ── El pie de la última página ──
     Una línea y se acabó. El navegador ignora las cajas de margen de @page y
     pone su propia cabecera, así que sin esto el documento impreso desde la
     aplicación no llevaría en ninguna página quién lo firma ni para quién es.
     Va en el flujo, que es lo único que imprimen los dos motores. */
  .pie-marca {
    margin-top: 8mm; padding-top: 2.5mm; border-top: 0.5pt solid ${LINE};
    font-size: 7.5pt; color: ${MUTED}; letter-spacing: 0.01em;
  }
</style>
</head>
<body>

<header class="masthead">
  ${bandaDeMarcas()}
  <div class="kicker"><span class="punto"></span><b>Mantenimiento de aulas</b> · ${esc(titulo)}</div>
  <h1>${esc(l.titular)}</h1>
  <div class="sumario">
    ${esc(mayuscula(d.periodoTexto))} · emitido el ${esc(pie.emitido)}${
      pie.solicitante ? ` · lo pidió ${esc(pie.solicitante)}` : ''
    }
  </div>
  <div class="filete"></div>
  ${o.nota ? `<div class="nota-pedido">${esc(o.nota)}</div>` : ''}
</header>

${
  tiene(o, 'resumen')
    ? `<table class="entrada"><tr>
  <td class="col-texto">
    <p class="entradilla">${esc(l.entradilla.trim())}</p>
  </td>
  <td class="col-panel">
    ${panelIndicadores(inds, comparar, d.comparacionTexto)}
  </td>
</tr></table>`
    : ''
}

${cuerpo}

${colofon(d, o)}

<footer class="pie-marca">Grupo Oesia · Servicio de mantenimiento de aulas ·
Universidad Francisco de Vitoria</footer>

</body>
</html>`
}
