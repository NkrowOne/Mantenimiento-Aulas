/**
 * La redacción del informe con Gemini, razonando antes de escribir.
 *
 * Qué se le pide y qué NO se le pide, porque ahí está todo:
 *
 *   SÍ   Elegir qué es lo importante de este periodo y contarlo en español
 *        legible. Encadenar tres hechos en una idea. Decir qué conviene hacer.
 *   NO   Calcular. Ni una cifra del informe sale de aquí: los indicadores, las
 *        variaciones y los umbrales los calcula `analisis.ts` con SQL y cuatro
 *        operaciones. Al modelo se le entrega el expediente ya cerrado y se le
 *        prohíbe expresamente añadir números que no estén en él.
 *
 * Sin clave configurada esto devuelve `null` y el informe sale con la redacción
 * calculada. No es un modo degradado con un hueco: es un informe completo con
 * otra voz.
 *
 * EL INFORME NO DICE EN NINGUNA PARTE QUE HAYA PASADO POR AQUÍ, y es una
 * decisión de quien lo firma: el PDF es un documento del servicio de
 * mantenimiento y habla del estado del campus, no de las herramientas con las
 * que se preparó. El rastro queda donde tiene que quedar —en `reports.params` y
 * en la pantalla de Informes—, no en el papel que se lleva a una reunión.
 *
 * Eso traslada aquí toda la responsabilidad: si el texto no lleva etiqueta, lo
 * único que puede delatarlo es cómo está escrito. De ahí que se limpie lo que
 * llega y que se descarte entero si suena a relleno.
 *
 * Contrato de la API (v1beta, `generateContent`):
 *   - la clave va en la cabecera `x-goog-api-key`, nunca en la URL —la URL
 *     acaba en los registros del proxy y en el historial del contenedor—;
 *   - `thinkingLevel` es el parámetro de la serie 3.x; `thinkingBudget` era el
 *     de la 2.5 y aquí no se usa;
 *   - con razonamiento activo, la respuesta trae partes marcadas `thought`.
 *     Concatenarlas todas mete el borrador del modelo dentro del JSON y el
 *     `JSON.parse` revienta. Se filtran.
 */

import type { ReportData } from './data.js'
import { type Lectura, type Senal, dias, porcentaje } from './analisis.js'

/** El último Flash. `gemini-flash-latest` sigue al día solo; esto fija la versión. */
const MODELO_POR_DEFECTO = 'gemini-3.6-flash'

/**
 * Nivel de razonamiento. `high` porque el trabajo que se le pide es justamente
 * el que se nota con razonamiento: mirar nueve señales, decidir cuáles cuentan
 * la misma historia y ordenarlas. Con `minimal` sale una lista parafraseada.
 */
const THINKING_POR_DEFECTO = 'high'
const THINKING_VALIDOS = ['minimal', 'low', 'medium', 'high'] as const

/**
 * El extremo de la API.
 *
 * Configurable por dos motivos, y ninguno es capricho: hay despliegues que salen
 * por una pasarela propia en vez de por Google directamente, y —sobre todo— es
 * lo que permite probar todo este fichero contra un servidor de mentira. Sin
 * eso, la única forma de comprobar que el razonamiento se pide bien, que las
 * partes de pensamiento se descartan y que una cifra inventada se caza sería
 * gastar cuota de una clave de verdad, y entonces no se comprobaría nunca.
 */
const API = process.env['GEMINI_API_BASE'] ?? 'https://generativelanguage.googleapis.com/v1beta/models'

/** Un informe no puede esperar indefinidamente: hay un PDF detrás y un cron delante. */
const TIMEOUT_MS = Number(process.env['GEMINI_TIMEOUT_MS'] ?? 60_000)

export type Audiencia = 'direccion' | 'equipo'

export interface OpcionesIA {
  clave: string
  modelo: string
  thinking: string
  audiencia: Audiencia
  /** Instrucción libre del usuario: «céntrate en el edificio H», «sé muy breve». */
  enfoque?: string
}

export interface Ajustes {
  clave?: string | undefined
  modelo?: string | undefined
  thinking?: string | undefined
  audiencia?: string | undefined
  enfoque?: string | undefined
}

/**
 * La configuración efectiva, o `null` si no hay clave.
 *
 * El entorno manda sobre la base de datos a propósito: `GEMINI_API_KEY` es lo
 * que se pone en un despliegue serio, y `app_config` es la comodidad de poder
 * activar la IA desde la propia aplicación sin reconstruir el contenedor. Si
 * están las dos, gana la del entorno, que es la que el administrador del
 * servidor controla.
 *
 * **Manda si DICE algo.** El compose declara las tres variables con
 * `${GEMINI_API_KEY:-}`, así que en un despliegue sin clave en el `.env` la
 * variable EXISTE con cadena vacía — y `''` no es nulo: con un `??` ingenuo, esa
 * cadena vacía pisaba la clave que el administrador había pegado en la
 * aplicación, y la IA quedaba anulada para siempre mientras el registro decía
 * «sin clave» con la clave guardada en app_config. Una variable vacía es una
 * variable que no dice nada, y lo que no dice nada no manda sobre nadie.
 */
function delEntorno(nombre: string): string | undefined {
  const v = process.env[nombre]?.trim()
  return v ? v : undefined
}

export function configurarIA(ajustes: Ajustes = {}): OpcionesIA | null {
  const clave = (delEntorno('GEMINI_API_KEY') ?? ajustes.clave ?? '').trim()
  if (!clave) return null

  const thinking = (delEntorno('GEMINI_THINKING') ?? ajustes.thinking ?? THINKING_POR_DEFECTO).trim()
  return {
    clave,
    modelo: (delEntorno('GEMINI_MODEL') ?? ajustes.modelo ?? MODELO_POR_DEFECTO).trim(),
    // Un valor inventado en la configuración devolvería 400 en cada informe.
    thinking: (THINKING_VALIDOS as readonly string[]).includes(thinking)
      ? thinking
      : THINKING_POR_DEFECTO,
    audiencia: ajustes.audiencia === 'equipo' ? 'equipo' : 'direccion',
    ...(ajustes.enfoque ? { enfoque: ajustes.enfoque.slice(0, 400) } : {}),
  }
}

// ── El encargo ───────────────────────────────────────────────────────────────

/*
 * Las prohibiciones de estilo son la mitad del trabajo.
 *
 * Un modelo al que se le pide «resume estos datos» devuelve siempre lo mismo:
 * un titular con dos puntos, tres viñetas que empiezan por sustantivo en
 * negrita, «es importante destacar», «de cara a», un cierre que repite la
 * entrada y un emoji de gráfico. Eso no es un problema de gusto: es que el
 * lector reconoce la forma en dos segundos y deja de leer el contenido. Se
 * prohíbe explícitamente, con ejemplos, porque prohibirlo en abstracto
 * («escribe con naturalidad») no funciona.
 */
const INSTRUCCION = `Eres el redactor de un informe interno de mantenimiento de aulas de un campus universitario español. Lo leen el responsable del servicio y el equipo técnico. Escribes en español de España.

Cómo se escribe aquí:
- Prosa corriente, en párrafos. Frases de longitud desigual. Voz sobria, sin entusiasmo y sin alarmismo.
- Concreto siempre: sala, edificio, pieza, número de días. Nada de «diversos aspectos» ni «ciertas incidencias».
- Se dice qué ha cambiado y qué conviene hacer. Un informe que solo describe la tabla que está al lado no aporta nada.
- Si los datos no dan para una conclusión, se dice que no dan. Nunca se rellena.

Prohibido, sin excepciones:
- Emojis, negritas, markdown, viñetas, títulos con dos puntos, MAYÚSCULAS de énfasis.
- Estas fórmulas y cualquier variante: «es importante destacar», «cabe señalar», «en resumen», «en conclusión», «de cara a», «a nivel de», «clave», «robusto», «óptimo», «sinergia», «no solo... sino también», «en el contexto actual», «se recomienda encarecidamente».
- Empezar dos frases seguidas con la misma palabra. Cerrar repitiendo lo que ya dice la entradilla.
- Inventar, redondear o recalcular cifras. Solo se usan las del expediente, tal como están. Si una cifra que querrías citar no está, se escribe la frase sin ella.
- Dar por hecho el motivo de algo. «Puede deberse a» es aceptable; «se debe a» no, salvo que el expediente lo diga.`

const ESQUEMA = {
  type: 'OBJECT',
  properties: {
    titular: {
      type: 'STRING',
      description:
        'Una frase de menos de 80 caracteres que diga lo más importante del periodo. Sin dos puntos y sin punto final.',
    },
    entradilla: {
      type: 'STRING',
      description:
        'Un párrafo de tres a cinco frases: qué se ha hecho, cómo ha quedado el saldo de trabajo y qué es lo que pide atención. Es lo primero que se lee del informe.',
    },
    hallazgos: {
      type: 'ARRAY',
      minItems: 2,
      maxItems: 4,
      items: {
        type: 'OBJECT',
        properties: {
          titulo: { type: 'STRING', description: 'Frase corta, sin dos puntos, menos de 70 caracteres.' },
          cuerpo: {
            type: 'STRING',
            description:
              'Dos o tres frases. Explica por qué importa y qué lo sostiene. No repite el título.',
          },
        },
        required: ['titulo', 'cuerpo'],
        propertyOrdering: ['titulo', 'cuerpo'],
      },
    },
    recomendaciones: {
      type: 'ARRAY',
      minItems: 2,
      maxItems: 4,
      items: {
        type: 'OBJECT',
        properties: {
          accion: {
            type: 'STRING',
            description: 'Qué hacer, en infinitivo y accionable esta semana. Menos de 90 caracteres.',
          },
          porque: { type: 'STRING', description: 'Una frase con el motivo y su cifra.' },
        },
        required: ['accion', 'porque'],
        propertyOrdering: ['accion', 'porque'],
      },
    },
  },
  required: ['titular', 'entradilla', 'hallazgos', 'recomendaciones'],
  propertyOrdering: ['titular', 'entradilla', 'hallazgos', 'recomendaciones'],
}

/**
 * El expediente: los hechos, en texto plano y sin nombres de personas.
 *
 * Se manda como texto y no como el JSON crudo de la consulta por dos razones. La
 * primera, que un volcado de doscientas líneas con `room_id` y `hay_datos`
 * gasta contexto en cosas que el modelo no debe mirar. La segunda, y la que
 * importa: aquí es donde se decide QUÉ sale del sistema. La actividad del equipo
 * va sin nombres —al informe sí van, porque es interno, pero a un servicio de
 * terceros no tiene por qué ir quién revisó cuántas aulas—, y los títulos de
 * incidencia van recortados.
 */
export function expediente(d: ReportData, se: Senal[]): string {
  const l: string[] = []
  const v = (n: number, antes: number): string =>
    antes === 0 ? `${n} (antes ninguno)` : `${n} (antes ${antes})`

  l.push(`PERIODO: ${d.periodoTexto} (${d.dias} días, tipo «${d.kind}»).`)
  l.push(`Se compara con ${d.comparacionTexto}: del ${d.anterior.start} al ${d.anterior.end}.`)
  l.push('')
  l.push('EN EL PERIODO')
  l.push(`- revisiones completadas: ${v(d.ahora.revisiones, d.antes.revisiones)}`)
  l.push(
    `- salas distintas revisadas: ${v(d.ahora.salasRevisadas, d.antes.salasRevisadas)} de ${d.situacion.salasTotal} activas (${porcentaje(d.ahora.salasRevisadas, d.situacion.salasTotal)})`,
  )
  l.push(`- registros abiertos: ${v(d.ahora.registros, d.antes.registros)}`)
  l.push(
    `  · incidencias ${d.ahora.incidencias}, solicitudes ${d.ahora.solicitudes}, observaciones ${d.ahora.observaciones}`,
  )
  l.push(`- de gravedad alta: ${v(d.ahora.gravedadAlta, d.antes.gravedadAlta)}`)
  l.push(`- cerradas: ${v(d.ahora.resueltas, d.antes.resueltas)}`)
  l.push(`- unidades de material consumidas: ${v(d.ahora.materialConsumido, d.antes.materialConsumido)}`)
  if (d.resolucion.resueltas > 0) {
    l.push(
      `- tiempo hasta el cierre: mediana ${dias(d.resolucion.medianaDias)}, media ${dias(d.resolucion.mediaDias)}; ${d.resolucion.enMenosDe48h} de ${d.resolucion.resueltas} en menos de 48 h`,
    )
  }
  if (d.sinSala > 0) l.push(`- registros sin sala identificada: ${d.sinSala}`)

  l.push('')
  l.push('SITUACIÓN A DÍA DE HOY (no del periodo)')
  l.push(`- incidencias abiertas en total: ${d.situacion.incidenciasAbiertas}`)
  l.push(`- de ellas con más de 7 días: ${d.situacion.estancadas}`)
  l.push(`- lámparas por debajo del 20 % de vida: ${d.situacion.lamparasAlLimite}`)
  l.push(`- salas nunca revisadas: ${d.situacion.salasNuncaRevisadas}`)
  l.push(`- salas sin revisar desde hace más de 6 meses: ${d.situacion.salasSinRevisarHace6Meses}`)
  l.push(`- artículos de almacén bajo mínimo: ${d.situacion.articulosBajoMinimo}`)

  if (d.serieDiaria.length > 1) {
    l.push('')
    l.push('DÍA A DÍA (día: revisiones / abiertas / cerradas)')
    l.push(
      d.serieDiaria
        .map((x) => `${x.dia}: ${x.revisiones} / ${x.abiertas} / ${x.resueltas}`)
        .join('; '),
    )
  }

  const conActividad = d.porEdificio.filter((b) => b.abiertas > 0 || b.revisadas > 0)
  if (conActividad.length) {
    l.push('')
    l.push('POR EDIFICIO EN EL PERIODO (código: abiertas, salas revisadas de N, pendientes hoy)')
    for (const b of conActividad.slice(0, 10)) {
      l.push(`- ${b.code}: ${b.abiertas} abiertas, ${b.revisadas} de ${b.salas} salas, ${b.pendientes} pendientes`)
    }
  }

  if (d.topSalas.length) {
    l.push('')
    l.push('SALAS CON MÁS INCIDENCIAS EN EL PERIODO')
    for (const r of d.topSalas.slice(0, 6)) {
      l.push(
        `- ${r.building} ${r.room}: ${r.total}` +
          (r.hayDatos && r.fiabilidad !== null ? ` (fiabilidad ${r.fiabilidad}/100)` : ''),
      )
    }
  }

  if (d.estancadas.length) {
    l.push('')
    l.push('LAS MÁS ANTIGUAS SIN CERRAR')
    for (const e of d.estancadas.slice(0, 6)) {
      l.push(`- ${e.dias} días · ${e.building} ${e.room} · gravedad ${e.gravedad} · ${e.titulo.slice(0, 70)}`)
    }
  }

  if (d.reincidentes.length) {
    l.push('')
    l.push('MISMO CONSUMO REPETIDO EN LA MISMA SALA (6 meses)')
    for (const r of d.reincidentes) l.push(`- ${r.building} ${r.room}: «${r.item}» ${r.veces} veces`)
  }

  if (d.materiales.length) {
    l.push('')
    l.push('MATERIAL MÁS CONSUMIDO EN EL PERIODO')
    for (const m of d.materiales.slice(0, 6)) l.push(`- ${m.name}: ${m.consumido} ${m.unidad}`)
  }

  if (d.lamparas.length) {
    l.push('')
    l.push('LÁMPARAS AL LÍMITE')
    for (const x of d.lamparas.slice(0, 6)) {
      l.push(`- ${x.building} ${x.room}: ${Math.round(x.pct * 100)} % de vida, ${x.horas ?? '?'} horas`)
    }
  }

  if (d.equipo.length) {
    l.push('')
    // Sin nombres: para escribir «el trabajo se reparte entre cuatro personas»
    // basta saber que son cuatro y cuánto hizo cada una.
    l.push('REPARTO DEL TRABAJO (anonimizado)')
    l.push(
      d.equipo
        .map((p, i) => `persona ${i + 1}: ${p.revisiones} revisiones, ${p.registros} registros`)
        .join('; '),
    )
  }

  if (se.length) {
    l.push('')
    l.push('AVISOS QUE YA HA CALCULADO EL SISTEMA (por orden de importancia)')
    for (const x of se) l.push(`- [${x.tono}] ${x.titulo}. ${x.cuerpo}`)
  }

  return l.join('\n')
}

function encargo(d: ReportData, se: Senal[], o: OpcionesIA): string {
  const paraQuien =
    o.audiencia === 'direccion'
      ? 'Lo lee el responsable del servicio, que no entra en cada aula: le interesa el estado general, la tendencia y las decisiones que hay que tomar (compras, refuerzos, prioridades).'
      : 'Lo lee el equipo técnico que va a las aulas: le interesa qué salas tocar, con qué material y en qué orden.'

  return `${paraQuien}

Escribe el análisis del informe del periodo ${d.periodoTexto}.

Con estas condiciones:
- Los avisos calculados del final del expediente son el punto de partida, no un guion: agrúpalos si cuentan lo mismo, descarta el que no aporte y añade lo que veas tú en los datos.
- La entradilla no repite la lista de indicadores. Los indicadores ya están impresos justo encima, con sus cifras y sus variaciones.
- Entre dos hallazgos igual de ciertos, elige el que cambie una decisión.
${o.enfoque ? `- Instrucción de quien pide el informe, que va por delante de lo anterior: ${o.enfoque}\n` : ''}
EXPEDIENTE
${expediente(d, se)}`
}

// ── Limpieza de la respuesta ─────────────────────────────────────────────────

/*
 * Aunque se le prohíba, de vez en cuando devuelve un `**` o un guion de viñeta.
 * Colarlo tal cual en el HTML no rompe nada, pero deja un asterisco impreso en
 * medio de un PDF, y eso delata la costura más que cualquier otra cosa.
 */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/gu

function limpia(t: unknown, max: number): string {
  return String(t ?? '')
    .replace(EMOJI, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/[*_`#]/g, '')
    .replace(/^\s*[-–—•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/**
 * Una cifra grande que no está en el expediente es una cifra inventada.
 *
 * Los números de una o dos cifras se dejan pasar: el modelo escribe legítimamente
 * «tres de las cuatro» o un porcentaje que sale de dividir dos datos que sí tiene.
 * Los de tres o más no: «276 salas» o «118 registros» solo pueden venir del
 * expediente, y si no están es que se los ha imaginado. Con dos o más así, se
 * descarta el texto entero y se usa la redacción calculada. Preferimos un informe
 * sobrio a un informe elegante con un número falso, porque el número falso se
 * cita en una reunión.
 */
export function cifrasInventadas(texto: string, hechos: string): string[] {
  const enHechos = new Set(hechos.match(/\d+/g) ?? [])
  const sospechosas = new Set<string>()
  for (const n of texto.match(/\d+/g) ?? []) {
    if (n.length >= 3 && !enHechos.has(n)) sospechosas.add(n)
  }
  return [...sospechosas]
}

/*
 * Las fórmulas que delatan a un texto generado.
 *
 * Están prohibidas en la instrucción del sistema, y aun así se cuelan: son el
 * camino de menor resistencia de cualquier modelo. Prohibirlas y no comprobarlo
 * es confiar en que el modelo se acuerde, que es exactamente lo que no hay que
 * hacer con la parte del informe que se ve.
 *
 * La lista es corta a propósito. Solo entran expresiones que un técnico de
 * mantenimiento no escribiría en un parte ni por accidente: nada de «por otro
 * lado» o «además», que son español corriente y saltarían con cualquier texto
 * bien escrito.
 */
const FORMULAS = [
  /\bes importante (destacar|señalar|mencionar|recordar)\b/i,
  /\bcabe (destacar|señalar|mencionar)\b/i,
  /\ben (resumen|conclusión|definitiva)\b/i,
  /\bde cara a\b/i,
  /\ba nivel de\b/i,
  /\bse recomienda encarecidamente\b/i,
  /\bjuega un papel\b/i,
  /\besencial para garantizar\b/i,
  /\bsinergia/i,
  /\ben el (contexto|panorama) actual\b/i,
  /\bno solo\b[^.]{0,60}\bsino también\b/i,
  /\bcomo (asistente|modelo|IA)\b/i,
  /\bbasándome en los datos (proporcionados|facilitados)\b/i,
]

export function formulasDelatoras(texto: string): string[] {
  return FORMULAS.filter((r) => r.test(texto)).map((r) => {
    const m = r.exec(texto)
    return m ? m[0] : r.source
  })
}

interface Respuesta {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> }
    finishReason?: string
  }>
  usageMetadata?: { thoughtsTokenCount?: number; totalTokenCount?: number }
  error?: { message?: string; status?: string }
}

async function pedir(cuerpo: unknown, o: OpcionesIA): Promise<Respuesta> {
  const corta = AbortSignal.timeout(TIMEOUT_MS)
  const r = await fetch(`${API}/${encodeURIComponent(o.modelo)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // En la cabecera y no en la URL: una clave en la cadena de consulta
      // termina en los registros de cualquier proxy que haya en medio.
      'x-goog-api-key': o.clave,
    },
    body: JSON.stringify(cuerpo),
    signal: corta,
  })

  const json = (await r.json()) as Respuesta
  if (!r.ok) {
    const err = new Error(json.error?.message ?? `HTTP ${r.status}`)
    // El código de estado decide si merece la pena reintentar; el mensaje, no.
    ;(err as Error & { estado?: number }).estado = r.status
    throw err
  }
  return json
}

const REINTENTABLE = new Set([429, 500, 502, 503, 504])

/**
 * Redacta el análisis, o devuelve `null` y deja que el informe siga.
 *
 * Nunca lanza. Un fallo de la IA no puede impedir que salga el informe del
 * viernes: el documento se emite igual con la redacción calculada, y en el pie
 * queda escrito qué pasó. Que el aviso salga por los registros del contenedor y
 * no por una excepción es deliberado — el que llama es `pg_cron`.
 */
export async function redactar(
  d: ReportData,
  se: Senal[],
  o: OpcionesIA,
): Promise<Lectura | null> {
  const prompt = encargo(d, se, o)
  const cuerpo = {
    systemInstruction: { parts: [{ text: INSTRUCCION }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: ESQUEMA,
      // `thinkingLevel`, no `thinkingBudget`: este último es de la serie 2.5 y
      // en la 3.x se ignora en silencio, que es la peor forma de fallar.
      thinkingConfig: { thinkingLevel: o.thinking },
      // Holgado porque el razonamiento también consume de aquí: si se agota,
      // `finishReason` es MAX_TOKENS y el JSON llega cortado por la mitad.
      maxOutputTokens: 8192,
    },
  }

  const esperas = [0, 1500, 4000]
  let ultimo = ''

  for (const espera of esperas) {
    if (espera) await new Promise((r) => setTimeout(r, espera))
    try {
      const res = await pedir(cuerpo, o)
      const cand = res.candidates?.[0]

      if (cand?.finishReason && !['STOP', 'MAX_TOKENS'].includes(cand.finishReason)) {
        throw new Error(`la respuesta terminó por ${cand.finishReason}`)
      }

      // Solo las partes que NO son razonamiento. Con `thinking` activo el
      // borrador viene en el mismo array marcado con `thought: true`.
      const texto = (cand?.content?.parts ?? [])
        .filter((p) => !p.thought && typeof p.text === 'string')
        .map((p) => p.text)
        .join('')

      if (!texto.trim()) throw new Error('respuesta vacía')

      const bruto = JSON.parse(texto) as {
        titular?: unknown
        entradilla?: unknown
        hallazgos?: Array<{ titulo?: unknown; cuerpo?: unknown }>
        recomendaciones?: Array<{ accion?: unknown; porque?: unknown }>
      }

      const lectura: Lectura = {
        titular: limpia(bruto.titular, 110).replace(/[.:]$/, ''),
        entradilla: limpia(bruto.entradilla, 1200),
        hallazgos: (bruto.hallazgos ?? [])
          .slice(0, 4)
          .map((h) => ({ titulo: limpia(h.titulo, 90).replace(/[.:]$/, ''), cuerpo: limpia(h.cuerpo, 600) }))
          .filter((h) => h.titulo && h.cuerpo),
        recomendaciones: (bruto.recomendaciones ?? [])
          .slice(0, 4)
          .map((r) => ({ accion: limpia(r.accion, 140), porque: limpia(r.porque, 260) }))
          .filter((r) => r.accion),
        origen: `redactado con ${o.modelo}, razonamiento ${o.thinking}`,
      }

      if (!lectura.titular || !lectura.entradilla || lectura.hallazgos.length === 0) {
        throw new Error('la respuesta no traía titular, entradilla o hallazgos')
      }

      const hechos = expediente(d, se)
      const todo = [
        lectura.titular,
        lectura.entradilla,
        ...lectura.hallazgos.flatMap((h) => [h.titulo, h.cuerpo]),
        ...lectura.recomendaciones.flatMap((r) => [r.accion, r.porque]),
      ].join(' ')
      const inventadas = cifrasInventadas(todo, hechos)
      if (inventadas.length >= 2) {
        throw new Error(`cifras que no están en los datos: ${inventadas.join(', ')}`)
      }

      /*
       * Y el texto se descarta también si suena a lo que es.
       *
       * El informe no dice en ninguna parte cómo se redactó —es un documento del
       * servicio de mantenimiento, no la ficha técnica de una herramienta— así
       * que lo único que puede delatarlo es la prosa. Con dos fórmulas de
       * relleno, el texto entero se cae y sale la redacción calculada: un
       * párrafo sobrio no levanta ninguna sospecha, y uno que empieza por «es
       * importante destacar» las levanta todas.
       */
      const formulas = formulasDelatoras(todo)
      if (formulas.length >= 2) {
        throw new Error(`fórmulas de relleno: ${formulas.join('; ')}`)
      }

      const pensado = res.usageMetadata?.thoughtsTokenCount
      console.log(
        `Análisis redactado con ${o.modelo} (razonamiento ${o.thinking}` +
          `${pensado ? `, ${pensado} tokens de razonamiento` : ''}).` +
          (inventadas.length ? ` Aviso: cifra sin respaldo «${inventadas[0]}».` : '') +
          (formulas.length ? ` Aviso: fórmula de relleno «${formulas[0]}».` : ''),
      )
      return lectura
    } catch (err) {
      ultimo = err instanceof Error ? err.message : String(err)
      const estado = (err as { estado?: number }).estado
      // Un 400 (esquema mal, modelo inexistente) o un 403 (clave sin permiso) no
      // mejoran repitiendo: se sale a la primera y se dice por qué.
      if (estado !== undefined && !REINTENTABLE.has(estado)) break
    }
  }

  console.warn(`Sin análisis de IA (${ultimo}); el informe sale con la redacción calculada.`)
  return null
}
