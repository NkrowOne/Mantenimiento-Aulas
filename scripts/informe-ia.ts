/**
 * El cliente de Gemini, probado sin gastar una clave.
 *
 *   npm run informe:ia
 *
 * Levanta un servidor que habla como habla la API de Gemini —incluidas las
 * partes marcadas `thought`, que es el detalle que rompe un `JSON.parse`
 * ingenuo— y comprueba las cinco cosas que tienen que cumplirse siempre:
 *
 *   1. Se pide razonamiento de verdad: `thinkingLevel` en el cuerpo, y salida
 *      con esquema para no tener que adivinar el formato.
 *   2. El borrador del modelo no entra en el informe.
 *   3. Los asteriscos, los emojis y las viñetas que se cuelan se limpian.
 *   4. Una cifra grande que no está en los datos invalida el texto entero y el
 *      informe sale con la redacción calculada. Es la prueba que de verdad
 *      importa: un informe sobrio es mejor que uno elegante con un número falso,
 *      porque el número falso se cita en una reunión.
 *   5. Los cierres del rayo —la avería y su cierre con la misma frase— se
 *      separan en «qué fallaba» y «qué se hizo» con otra pregunta, más corta y
 *      con razonamiento `low`. Lo que la IA devuelve mal (una cifra que no está
 *      en el texto) no entra, y esa incidencia se separa por la puntuación. En
 *      el diario, la apertura y el cierre salen enteros, sin el tope de 90.
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
  const se = senales(d, 'equipo')

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
    lecturaCalculada(d, 'equipo').entradilla.length > 80 && lecturaCalculada(d, 'equipo').recomendaciones.length > 0,
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
    !expediente(d, se, 'equipo').includes('Ana Pérez'),
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
    cifrasInventadas('Se revisaron 348 de 412 salas', expediente(d, se, 'equipo')).length === 2,
  )
  comprueba(
    'y deja pasar los que sí están',
    cifrasInventadas('276 salas activas, 117 sin revisar', expediente(d, se, 'equipo')).length === 0,
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

  /*
   * Los cierres del rayo.
   *
   * Es otra pregunta al mismo servidor, y lo que se comprueba es lo mismo que
   * arriba más una cosa propia: que cada incidencia se valida por su lado. Una
   * respuesta con un cierre bueno y otro con una cifra inventada no puede tirar
   * el bueno ni colar el malo.
   */
  console.log('\n▸ Los cierres del rayo se separan en lo que fallaba y lo que se hizo')
  estado = 200
  const { separarConIA } = await import('../reports-worker/src/ia.js')
  const { cierresDelRayo, aplicarSeparacion, separarTodos, separarSinIA } = await import(
    '../reports-worker/src/cierres.js'
  )

  const PROYECCION =
    'No se proyecta pantalla del ordenador del aula Se le indica al usuario por teléfono cómo proyectar'
  const ALTAVOCES = 'No funcionan los altavoces del aula Se conecta el cable a la regleta'
  const ID_PROYECCION = '5b0c2f1e-3f55-4d3e-9d0a-0d2f6a1b7c01'
  const ID_ALTAVOCES = '9a7e4c20-61b8-4a52-8c3d-4e1f9b2d8a02'
  const textos = new Map([
    [ID_PROYECCION, PROYECCION],
    [ID_ALTAVOCES, ALTAVOCES],
  ])

  const BUENO = {
    id: '1',
    problema: 'No se proyecta la pantalla del ordenador del aula.',
    resumen: 'No se proyecta la pantalla del aula',
    solucion: 'Se le indica al usuario por teléfono cómo proyectar',
  }
  // Un cable de «15 metros» que el técnico nunca escribió.
  const INVENTADO = {
    id: '2',
    problema: 'No funcionan los altavoces del aula',
    resumen: 'No suenan los altavoces',
    solucion: 'Se cambia el cable de 15 metros por otro nuevo',
  }
  // Un id que no se mandó: no corresponde a ninguna incidencia.
  const AJENO = { ...BUENO, id: '99' }

  devolver = respuesta({ cierres: [BUENO, INVENTADO, AJENO] })
  const separacion = await separarConIA(textos, cfg)
  const genCierres = ultimoCuerpo['generationConfig'] as Record<string, unknown> | undefined
  const thinkCierres = genCierres?.['thinkingConfig'] as Record<string, unknown> | undefined
  const prompt = JSON.stringify(ultimoCuerpo['contents'])

  comprueba(
    'se pide thinkingLevel low, no el del análisis',
    thinkCierres?.['thinkingLevel'] === 'low',
    JSON.stringify(thinkCierres),
  )
  comprueba(
    'se pide salida con esquema',
    genCierres?.['responseMimeType'] === 'application/json' && !!genCierres?.['responseSchema'],
  )
  comprueba(
    'al modelo le llegan ids cortos, no los de la base',
    prompt.includes(PROYECCION) && !prompt.includes(ID_PROYECCION) && !prompt.includes(ID_ALTAVOCES),
  )
  comprueba(
    'el borrador del modelo no rompe la respuesta',
    separacion.motivo === null,
    `${separacion.motivo}`,
  )
  const bueno = separacion.separados.get(ID_PROYECCION)
  comprueba('el bueno vuelve con el id de la incidencia, no con el del modelo', !!bueno)
  comprueba(
    'con su problema sin el punto final, su resumen y lo que se hizo',
    bueno?.problema === 'No se proyecta la pantalla del ordenador del aula' &&
      bueno.resumen === BUENO.resumen &&
      bueno.solucion === BUENO.solucion,
    JSON.stringify(bueno),
  )
  comprueba(
    'un cierre con un número que no estaba en el texto se descarta',
    !separacion.separados.has(ID_ALTAVOCES),
  )
  comprueba(
    'y un id que nadie mandó no se cuela',
    separacion.separados.size === 1,
    `${separacion.separados.size} separados`,
  )

  // Lo descartado no se queda sin separar: cae a la puntuación.
  const todos = separarTodos(textos, separacion.separados)
  comprueba(
    'lo que la IA no devuelve bien se separa por la puntuación',
    todos.get(ID_ALTAVOCES)?.problema === 'No funcionan los altavoces del aula' &&
      todos.get(ID_ALTAVOCES)?.solucion === 'Se conecta el cable a la regleta',
    JSON.stringify(todos.get(ID_ALTAVOCES)),
  )
  comprueba('y lo que sí devolvió se queda como lo devolvió', todos.get(ID_PROYECCION) === bueno)
  comprueba(
    'sin IA, la frase del tirón se corta donde empieza lo que se hizo',
    separarSinIA(PROYECCION).solucion === 'Se le indica al usuario por teléfono cómo proyectar',
    JSON.stringify(separarSinIA(PROYECCION)),
  )

  // El diario: la apertura y el cierre salen cada uno con lo suyo.
  const fila = (tipo: string, incidencia: string, titulo: string, detalle: string | null) => ({
    dia: '2026-07-27', hora: '10:05', tipo, subtipo: 'incidencia', incidencia, titulo, detalle,
    cantidad: null, ref: null, building: 'H', room: '1.13', quien: 'Ana Pérez',
  })
  const conRayo: ReportData = {
    ...d,
    eventos: [
      fila('apertura', ID_PROYECCION, PROYECCION, null),
      fila('cierre', ID_PROYECCION, PROYECCION, PROYECCION),
      // Un cierre de los de siempre: el título solo está DENTRO de la explicación.
      fila('cierre', ID_ALTAVOCES, 'Proyector', 'Se cambia la lámpara del proyector'),
    ],
  }
  const delRayo = cierresDelRayo(conRayo)
  comprueba(
    'solo es del rayo el cierre cuyo texto es el título',
    delRayo.size === 1 && delRayo.get(ID_PROYECCION) === PROYECCION,
    JSON.stringify([...delRayo]),
  )
  const impreso = aplicarSeparacion(conRayo, separarTodos(delRayo, separacion.separados))
  comprueba(
    'la apertura lleva el problema entero y el cierre su resumen y lo que se hizo',
    impreso.eventos[0]?.titulo === 'No se proyecta la pantalla del ordenador del aula' &&
      impreso.eventos[1]?.titulo === BUENO.resumen &&
      impreso.eventos[1]?.detalle === BUENO.solucion,
    JSON.stringify(impreso.eventos.slice(0, 2).map((e) => [e.titulo, e.detalle])),
  )
  comprueba(
    'el cierre normal no se toca, y el expediente de origen tampoco',
    impreso.eventos[2] === conRayo.eventos[2] && conRayo.eventos[1]?.titulo === PROYECCION,
  )

  // Y en el papel, la apertura y el cierre salen enteros; el resto del diario, con su tope.
  const { renderReport } = await import('../reports-worker/src/template.js')
  const { leerOpciones } = await import('../reports-worker/src/opciones.js')
  const LARGA =
    'Se le indica al usuario por teléfono cómo proyectar desde el ordenador del aula, ' +
    'se comprueba que el cable está bien conectado a la regleta y se deja funcionando'
  const LARGO_AJENO = 'Material con un nombre larguísimo '.repeat(5).trim()
  const material = { ...fila('material', 'x', LARGO_AJENO, null), incidencia: null }
  const largos: ReportData = aplicarSeparacion(
    { ...conRayo, eventos: [...conRayo.eventos, material] },
    new Map([[ID_PROYECCION, { problema: PROYECCION, resumen: BUENO.resumen, solucion: LARGA }]]),
  )
  const solo = leerOpciones({ ia: false, secciones: ['eventos'] })
  const html = renderReport(largos, lecturaCalculada(largos, 'equipo'), solo, {
    emitido: '27/07/26, 10:30',
  })
  comprueba('el cierre del diario lleva entero lo que se hizo', html.includes(LARGA))
  comprueba('y la apertura su problema entero', html.includes(`>${PROYECCION}</td>`))
  comprueba(
    'las filas que no son de una incidencia siguen con su tope',
    !html.includes(LARGO_AJENO) && html.includes('…'),
  )

  // Si la IA no sirve de nada, se dice por qué y el informe sigue por la puntuación.
  devolver = respuesta({ cierres: [INVENTADO] })
  const sinNada = await separarConIA(textos, cfg)
  comprueba(
    'si ninguno viene bien separado, devuelve el motivo y ningún cierre',
    sinNada.separados.size === 0 && !!sinNada.motivo,
    sinNada.motivo ?? '',
  )
  estado = 400
  devolver = { error: { message: 'modelo inexistente' } }
  const aprisa = Date.now()
  const caida = await separarConIA(textos, cfg)
  comprueba('un 400 no lanza ni se reintenta', caida.separados.size === 0 && Date.now() - aprisa < 1200)
  comprueba('sin cierres del rayo no se pregunta a nadie', (await separarConIA(new Map(), cfg)).motivo === null)

  servidor.close()
  return fallos
}

const codigo = await main()
console.log(
  codigo === 0
    ? '\n✓ El análisis con IA se pide bien, se limpia y no cuela cifras inventadas; los cierres del rayo se separan'
    : `\n✗ ${codigo} fallos`,
)
process.exit(codigo === 0 ? 0 : 1)
