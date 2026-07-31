/**
 * El cliente de Gemini, probado sin gastar una clave.
 *
 *   npm run informe:ia
 *
 * Levanta un servidor que habla como habla la API de Gemini —incluidas las
 * partes marcadas `thought`, que es el detalle que rompe un `JSON.parse`
 * ingenuo— y comprueba las cuatro cosas que tienen que cumplirse siempre:
 *
 *   1. Se pide razonamiento de verdad: `thinkingLevel` en el cuerpo, y salida
 *      con esquema para no tener que adivinar el formato.
 *   2. El borrador del modelo no entra en el informe.
 *   3. Los asteriscos, los emojis y las viñetas que se cuelan se limpian.
 *   4. Una cifra grande que no está en los datos invalida el texto entero y el
 *      informe sale con la redacción calculada. Es la prueba que de verdad
 *      importa: un informe sobrio es mejor que uno elegante con un número falso,
 *      porque el número falso se cita en una reunión.
 *
 * Sin base de datos: los datos del informe se construyen aquí a mano.
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ReportData } from '../reports-worker/src/data.js'

let fallos = 0
const comprueba = (nombre: string, ok: boolean, detalle = ''): void => {
  if (!ok) fallos++
  console.log(`  ${ok ? '✓' : '✗'} ${nombre}${ok || !detalle ? '' : `\n      ${detalle}`}`)
}

/** Un periodo cualquiera con datos suficientes para que haya algo que contar. */
function datos(): ReportData {
  const contadores = {
    revisiones: 31,
    salasRevisadas: 31,
    registros: 13,
    incidencias: 11,
    solicitudes: 1,
    observaciones: 1,
    gravedadAlta: 2,
    resueltas: 9,
    materialConsumido: 7,
  }
  return {
    kind: 'semanal',
    period: { start: '2026-07-27', end: '2026-07-31' },
    anterior: { start: '2026-07-20', end: '2026-07-24' },
    periodoTexto: 'del 27 al 31 de julio de 2026',
    comparacionTexto: 'la semana anterior',
    dias: 5,
    ahora: contadores,
    antes: { ...contadores, revisiones: 18, registros: 9, resueltas: 12 },
    situacion: {
      salasTotal: 276,
      incidenciasAbiertas: 14,
      estancadas: 3,
      lamparasAlLimite: 11,
      salasSinRevisarHace6Meses: 158,
      salasNuncaRevisadas: 117,
      articulosBajoMinimo: 2,
    },
    serieDiaria: [
      { dia: '2026-07-27', revisiones: 6, abiertas: 3, resueltas: 1 },
      { dia: '2026-07-28', revisiones: 9, abiertas: 4, resueltas: 2 },
      { dia: '2026-07-29', revisiones: 7, abiertas: 2, resueltas: 3 },
      { dia: '2026-07-30', revisiones: 5, abiertas: 3, resueltas: 2 },
      { dia: '2026-07-31', revisiones: 4, abiertas: 1, resueltas: 1 },
    ],
    porEdificio: [
      { code: 'H', name: 'EDIFICIO H', salas: 39, revisadas: 11, abiertas: 7, pendientes: 5 },
      { code: 'CRAI', name: 'EDIFICIO CRAI', salas: 38, revisadas: 9, abiertas: 4, pendientes: 3 },
      { code: 'P', name: 'EDIFICIO P', salas: 29, revisadas: 6, abiertas: 2, pendientes: 1 },
    ],
    porTipo: [
      { tipo: 'incidencia', total: 11 },
      { tipo: 'solicitud', total: 1 },
      { tipo: 'observacion', total: 1 },
    ],
    porGravedad: [
      { gravedad: 'alta', total: 2 },
      { gravedad: 'media', total: 7 },
      { gravedad: 'baja', total: 2 },
    ],
    porMes: [
      { month: '2026-05', total: 22 },
      { month: '2026-06', total: 17 },
      { month: '2026-07', total: 13 },
    ],
    topSalas: [
      { building: 'H', room: '1.13', name: '1.13', total: 3, fiabilidad: 42, hayDatos: true },
      { building: 'CRAI', room: '0.4', name: 'Sala de grupos', total: 2, fiabilidad: null, hayDatos: false },
    ],
    resolucion: { resueltas: 9, medianaDias: 1.5, mediaDias: 6.2, enMenosDe48h: 6 },
    lamparas: [
      { building: 'P', room: '2.4P', horas: 3872, pct: 0.02 },
      { building: 'C', room: '2.5', horas: 4600, pct: 0.09 },
    ],
    estancadas: [
      {
        ref: 'I260219_0026',
        titulo: 'En el monitor del aula salen unas líneas de colores',
        building: 'H',
        room: '1.13',
        dias: 41,
        gravedad: 'media',
      },
    ],
    materiales: [{ name: 'Cable HDMI fibra 15 m', unidad: 'ud', consumido: 4, incidencias: 3 }],
    reincidentes: [{ building: 'H', room: '1.13', item: 'Cable HDMI fibra 15 m', veces: 3 }],
    olvidadas: [{ building: 'CRAI', room: '0.7', dias: null }],
    equipo: [{ nombre: 'Ana Pérez', revisiones: 18, registros: 6 }],
    revisiones: [
      {
        dia: '2026-07-27', hora: '09:14', building: 'H', room: '1.13', name: '1.13',
        quien: 'Ana Pérez', resultado: 'con_incidencias', fallos: 2, aperturas: 1,
      },
    ],
    revisionesTotal: 31,
    eventos: [
      {
        dia: '2026-07-27', hora: '09:31', tipo: 'apertura', subtipo: 'incidencia',
        titulo: 'No duplica la imagen en el monitor', detalle: null, cantidad: null,
        ref: 'I260727_0011', building: 'H', room: '1.13', quien: 'Ana Pérez',
      },
    ],
    eventosTotal: 34,
    sinSala: 1,
  }
}

/** Lo que devuelve Gemini, con su parte de razonamiento delante. */
function respuesta(cuerpoJson: unknown): unknown {
  return {
    candidates: [
      {
        finishReason: 'STOP',
        content: {
          parts: [
            // El borrador. Si se concatena con el resto, el JSON.parse revienta.
            { thought: true, text: 'El usuario quiere un informe. Miro las señales...' },
            { text: JSON.stringify(cuerpoJson) },
          ],
        },
      },
    ],
    usageMetadata: { thoughtsTokenCount: 812, totalTokenCount: 2043 },
  }
}

const REDACCION_BUENA = {
  titular: 'La cola de pendientes sube por tercera semana',
  entradilla:
    '**Se han revisado** 31 salas, trece más que la semana pasada, y aun así la cola de pendientes ' +
    'ha crecido 📈: entraron 13 registros y salieron 9. El edificio H concentra la mitad de lo abierto ' +
    'y repite el mismo cable de fibra por tercera vez en la 1.13, que es lo que conviene mirar antes ' +
    'de reponerlo otra vez.',
  hallazgos: [
    {
      titulo: 'El edificio H repite avería y repuesto',
      cuerpo: '- La 1.13 ha consumido el mismo cable tres veces en seis meses. Con esa cadencia, el problema está en la instalación.',
    },
    {
      titulo: 'Once lámparas por debajo del 20 %',
      cuerpo: 'La de P 2.4P está al 2 % con 3872 horas. Cambiarlas ahora cuesta lo mismo que cambiarlas fundidas.',
    },
  ],
  recomendaciones: [
    { accion: 'Revisar la instalación de H 1.13 antes de reponer el cable', porque: 'Tercera vez en seis meses' },
    { accion: 'Pedir lámparas de repuesto', porque: 'Once por debajo del 20 % de vida' },
  ],
}

const REDACCION_CON_FORMULAS = {
  ...REDACCION_BUENA,
  entradilla:
    'Es importante destacar que la semana ha sido intensa. De cara a los próximos días, conviene ' +
    'revisar las once lámparas por debajo del 20 %.',
}

const REDACCION_INVENTADA = {
  ...REDACCION_BUENA,
  entradilla:
    'Se han revisado 348 salas de las 412 del campus, un récord histórico, y la cola de pendientes ' +
    'ha bajado a 5 gracias al esfuerzo del equipo.',
}

async function main(): Promise<number> {
  let ultimoCuerpo: Record<string, unknown> = {}
  let ultimaCabecera = ''
  let devolver: unknown = respuesta(REDACCION_BUENA)
  let estado = 200

  const servidor = createServer((req, res) => {
    const trozos: Buffer[] = []
    req.on('data', (c: Buffer) => trozos.push(c))
    req.on('end', () => {
      ultimoCuerpo = JSON.parse(Buffer.concat(trozos).toString()) as Record<string, unknown>
      ultimaCabecera = String(req.headers['x-goog-api-key'] ?? '')
      res.writeHead(estado, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(devolver))
    })
  })
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r))
  const puerto = (servidor.address() as AddressInfo).port
  process.env['GEMINI_API_BASE'] = `http://127.0.0.1:${puerto}`

  /*
   * El import va DESPUÉS de fijar la variable, y no es un detalle de estilo: el
   * módulo resuelve el extremo de la API al cargarse. Importándolo arriba, la
   * prueba salía a Internet a preguntarle a Google de verdad y fallaba con «API
   * key not valid» — que es exactamente lo que una prueba no debe hacer.
   */
  const { configurarIA, redactar, cifrasInventadas, formulasDelatoras, expediente } = await import(
    '../reports-worker/src/ia.js'
  )
  const { senales, lecturaCalculada } = await import('../reports-worker/src/analisis.js')

  const d = datos()
  const se = senales(d)

  console.log('\n▸ Sin clave no se llama a nadie')
  delete process.env['GEMINI_API_KEY']
  comprueba('sin clave, la configuración es nula', configurarIA() === null)

  /*
   * Y una variable VACÍA no es una clave, ni anula la de app_config.
   *
   * El compose declara `GEMINI_API_KEY: ${GEMINI_API_KEY:-}`: en un despliegue
   * sin clave en el .env, la variable existe con cadena vacía. Con un `??`
   * ingenuo, ese vacío pisaba la clave que el administrador había pegado en la
   * aplicación y la IA quedaba anulada para siempre — con el registro diciendo
   * «sin clave» y la clave guardada en la base.
   */
  console.log('\n▸ Una variable vacía del compose no manda sobre app_config')
  process.env['GEMINI_API_KEY'] = ''
  process.env['GEMINI_MODEL'] = ''
  process.env['GEMINI_THINKING'] = '  '
  const desdeBase = configurarIA({ clave: 'clave-de-app-config', modelo: 'modelo-de-app-config' })
  comprueba('la clave de app_config sobrevive al GEMINI_API_KEY vacío', desdeBase?.clave === 'clave-de-app-config')
  comprueba('el modelo de app_config sobrevive al GEMINI_MODEL vacío', desdeBase?.modelo === 'modelo-de-app-config')
  comprueba('el thinking en blanco cae al valor por defecto', desdeBase?.thinking === 'high')
  comprueba('vacío y sin app_config sigue siendo «sin clave»', configurarIA() === null)
  delete process.env['GEMINI_API_KEY']
  delete process.env['GEMINI_MODEL']
  delete process.env['GEMINI_THINKING']
  comprueba(
    'la redacción calculada se sostiene sola',
    lecturaCalculada(d).entradilla.length > 80 && lecturaCalculada(d).recomendaciones.length > 0,
  )

  console.log('\n▸ Con clave, y razonando')
  const cfg = configurarIA({ clave: 'clave-de-prueba-larga-de-mentira' })
  if (!cfg) {
    console.log('  ✗ configurarIA devolvió null con clave')
    return 1
  }
  comprueba('el modelo por defecto es el último Flash', cfg.modelo === 'gemini-3.6-flash', cfg.modelo)
  comprueba('el razonamiento por defecto es alto', cfg.thinking === 'high', cfg.thinking)

  const lectura = await redactar(d, se, cfg)
  const gen = ultimoCuerpo['generationConfig'] as Record<string, unknown> | undefined
  const think = gen?.['thinkingConfig'] as Record<string, unknown> | undefined

  comprueba('la clave va en la cabecera, no en la URL', ultimaCabecera.length > 0)
  comprueba('se pide thinkingLevel (no thinkingBudget)', think?.['thinkingLevel'] === 'high', JSON.stringify(think))
  comprueba('se pide salida con esquema', gen?.['responseMimeType'] === 'application/json' && !!gen?.['responseSchema'])
  comprueba(
    'el expediente no lleva nombres de personas',
    !expediente(d, se).includes('Ana Pérez'),
    'se ha filtrado un nombre al prompt',
  )
  comprueba('hay redacción', lectura !== null)
  comprueba(
    'el borrador del modelo no entra en el informe',
    !!lectura && !lectura.entradilla.includes('El usuario quiere'),
  )
  comprueba('los asteriscos de markdown se limpian', !!lectura && !lectura.entradilla.includes('*'))
  comprueba('los emojis se quitan', !!lectura && !/📈/u.test(lectura.entradilla))
  comprueba(
    'la viñeta suelta se quita',
    !!lectura && !lectura.hallazgos[0]!.cuerpo.startsWith('-'),
    lectura?.hallazgos[0]?.cuerpo.slice(0, 30),
  )
  comprueba(
    'el pie dice con qué se redactó',
    !!lectura && lectura.origen.includes('gemini-3.6-flash') && lectura.origen.includes('high'),
    lectura?.origen,
  )

  console.log('\n▸ Una cifra que no está en los datos invalida el texto')
  comprueba(
    'cifrasInventadas caza los números grandes que no existen',
    cifrasInventadas('Se revisaron 348 de 412 salas', expediente(d, se)).length === 2,
  )
  comprueba(
    'y deja pasar los que sí están',
    cifrasInventadas('276 salas activas, 117 sin revisar', expediente(d, se)).length === 0,
  )

  devolver = respuesta(REDACCION_INVENTADA)
  const conInventos = await redactar(d, se, cfg)
  comprueba('con cifras inventadas se descarta la redacción entera', conInventos === null)

  /*
   * Y lo que delata que un texto salió de un modelo.
   *
   * El informe no lleva ninguna etiqueta que lo diga —es un documento del
   * servicio, no la ficha de una herramienta—, así que lo único que puede
   * delatarlo es la prosa. Un párrafo que empieza por «es importante destacar»
   * lo cuenta todo.
   */
  console.log('\n▸ Y el texto que suena a texto generado')
  comprueba(
    'caza las fórmulas de relleno',
    formulasDelatoras('Es importante destacar que, de cara a la próxima semana...').length === 2,
  )
  comprueba(
    'y el «como modelo de lenguaje» de manual',
    formulasDelatoras('Como modelo, no puedo acceder a los datos').length === 1,
  )
  comprueba(
    'deja en paz el español corriente',
    formulasDelatoras(
      'Por otro lado, la sala 1.13 repite avería. Además, quedan once lámparas por cambiar.',
    ).length === 0,
    'ha marcado un texto legítimo',
  )

  devolver = respuesta(REDACCION_CON_FORMULAS)
  const conFormulas = await redactar(d, se, cfg)
  comprueba('con dos fórmulas de relleno se descarta la redacción entera', conFormulas === null)

  console.log('\n▸ Cuando la API falla, el informe sigue saliendo')
  estado = 500
  devolver = { error: { message: 'algo ha ido mal por dentro' } }
  comprueba('un 500 no lanza: devuelve null', (await redactar(d, se, cfg)) === null)

  estado = 400
  devolver = { error: { message: 'modelo inexistente' } }
  const antes = Date.now()
  comprueba('un 400 no se reintenta', (await redactar(d, se, cfg)) === null)
  comprueba('y sale rápido, sin las esperas', Date.now() - antes < 1200)

  servidor.close()
  return fallos
}

const codigo = await main()
console.log(
  codigo === 0
    ? '\n✓ El análisis con IA se pide bien, se limpia y no cuela cifras inventadas'
    : `\n✗ ${codigo} fallos`,
)
process.exit(codigo === 0 ? 0 : 1)
