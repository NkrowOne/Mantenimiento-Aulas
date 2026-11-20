// Prueba del endpoint HTTP del worker: nunca se había ejercitado, solo la CLI.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const TOKEN = 'un-token-de-prueba-suficientemente-largo'

/*
 * Un Supabase de mentira, para poder ejercitar `/informe/pdf` de verdad.
 *
 * Ese endpoint no lleva el token del worker —quien llama es un navegador— sino
 * la sesión de la persona, y lo que hay que comprobar es justo eso: que un
 * token inventado no imprime, que una cuenta dada de baja tampoco, y que la
 * buena sí. Sin este doble haría falta un GoTrue entero para probar tres ramas.
 */
const SESIONES = {
  bueno: { id: '11111111-1111-4111-8111-111111111111', role: 'tecnico', active: true },
  debaja: { id: '22222222-2222-4222-8222-222222222222', role: 'tecnico', active: false },
  visita: { id: '33333333-3333-4333-8333-333333333333', role: 'none', active: true },
  // Generar un informe es de administrador; convertirlo a PDF, de cualquiera
  // del personal. Hacen falta los dos para comprobar que no se confunden.
  jefa: { id: '44444444-4444-4444-8444-444444444444', role: 'admin', active: true },
}
/** Las filas de `report_jobs` que el worker va apuntando: lo que la pantalla leería. */
const trabajos = []
const cuerpoDe = (req) =>
  new Promise((resolve) => {
    const t = []
    req.on('data', (c) => t.push(c))
    req.on('end', () => resolve(Buffer.concat(t).toString()))
  })
const supabaseFalso = createServer((req, res) => {
  const jwt = (req.headers.authorization ?? '').replace(/^Bearer /, '')
  if (req.url.startsWith('/auth/v1/user')) {
    const s = SESIONES[jwt]
    if (!s) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"message":"invalid jwt"}')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: s.id, aud: 'authenticated' }))
    return
  }
  if (req.url.startsWith('/rest/v1/profiles')) {
    const id = decodeURIComponent(req.url).match(/id=eq\.([0-9a-f-]+)/)?.[1]
    const s = Object.values(SESIONES).find((x) => x.id === id)
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(s ? { role: s.role, active: s.active } : null))
    return
  }
  /*
   * La cuenta de los informes en segundo plano. Lo justo de PostgREST: apuntar
   * una fila y devolverla, y cambiarla por id. El resto de la base NO está —ni
   * salas, ni incidencias—, y es a propósito: el informe va a fallar al leer, y
   * lo que se comprueba es que ese fallo acaba escrito en la fila en vez de
   * dejarla «en curso» para siempre.
   */
  if (req.url.startsWith('/rest/v1/report_jobs')) {
    void cuerpoDe(req).then((texto) => {
      if (req.method === 'POST') {
        const fila = { id: `trabajo-${trabajos.length + 1}`, ...JSON.parse(texto || '{}') }
        trabajos.push(fila)
        res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify(fila))
        return
      }
      if (req.method === 'PATCH') {
        const url = decodeURIComponent(req.url)
        const id = url.match(/[?&]id=eq\.([^&]+)/)?.[1]
        const varios = url.match(/[?&]id=in\.\(([^)]*)\)/)?.[1]?.split(',')
        // El barrido filtra por estado y por pulso, no por id: aquí no toca nada.
        if (id || (varios && !/[?&]estado=/.test(url))) {
          for (const f of trabajos) if (f.id === id || varios?.includes(f.id)) Object.assign(f, JSON.parse(texto || '{}'))
        }
      }
      res.writeHead(204).end()
    })
    return
  }
  res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"message":"no existe en esta base de mentira"}')
})
await new Promise((r) => supabaseFalso.listen(8098, '127.0.0.1', r))

const env = { ...process.env, WORKER_TOKEN: TOKEN, DATABASE_URL: 'postgresql://postgres@127.0.0.1:5433/postgres', PORT: '8099', NODE_ENV: '', SUPABASE_URL: 'http://127.0.0.1:8098', SUPABASE_SERVICE_ROLE_KEY: 'clave-de-servicio-de-mentira' }
/*
 * `detached`, para poder matarlo de verdad al terminar.
 *
 * `spawn('npx', …)` crea DOS procesos: npx y el tsx que él lanza. El `kill()`
 * del final solo alcanzaba al primero, así que el worker se quedaba vivo
 * escuchando en el 8099 después de cada ejecución. La siguiente no conseguía
 * enlazar el puerto y sus peticiones iban al proceso viejo —con el código
 * anterior y con su conexión a la base ya caducada—: fallaba una prueba de cada
 * tres, siempre distinta, y siempre parecía un fallo del endpoint.
 *
 * Con grupo de procesos propio se mata al grupo entero y no queda nada detrás.
 */
const proc = spawn('npx', ['tsx', 'src/server.ts'], {
  cwd: 'reports-worker', env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
proc.stdout.on('data', d => process.stdout.write('  [worker] ' + d))
proc.stderr.on('data', d => process.stderr.write('  [worker!] ' + d))

await new Promise(r => setTimeout(r, 4000))
const url = 'http://127.0.0.1:8099'
let fallos = 0
const check = async (nombre, fn) => {
  try { await fn(); console.log('  ✓', nombre) }
  catch (e) { console.log('  ✗', nombre, '→', e.message); fallos++ }
}

await check('/salud responde sin token', async () => {
  const r = await fetch(url + '/salud')
  if (r.status !== 200) throw new Error('status ' + r.status)
})
await check('sin token → 401', async () => {
  const r = await fetch(url + '/generate', { method: 'POST', body: '{}' })
  if (r.status !== 401) throw new Error('status ' + r.status)
})
await check('token equivocado → 401', async () => {
  const r = await fetch(url + '/generate', { method: 'POST', headers: { Authorization: 'Bearer no' }, body: '{}' })
  if (r.status !== 401) throw new Error('status ' + r.status)
})
await check('tipo de informe inventado → 400', async () => {
  const r = await fetch(url + '/generate', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify({ kind: 'loquesea' }) })
  if (r.status !== 400) throw new Error('status ' + r.status)
})
await check('fecha con formato malo → 400', async () => {
  const r = await fetch(url + '/generate', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify({ kind: 'personalizado', start: "2026-01-01'; drop table rooms; --", end: '2026-01-02' }) })
  if (r.status !== 400) throw new Error('status ' + r.status)
})
await check('cuerpo gigante → 413', async () => {
  const r = await fetch(url + '/generate', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: 'x'.repeat(50000) })
  if (r.status !== 413) throw new Error('status ' + r.status)
})
await check('el error no filtra la traza interna', async () => {
  const r = await fetch(url + '/generate', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify({ kind: 'diario' }) })
  const txt = await r.text()
  if (/at |\/home\/|postgres|Error:/.test(txt)) throw new Error('filtra: ' + txt.slice(0,120))
})
/*
 * ── El PDF del informe ──
 * Autoriza con la sesión de quien llama, no con el token del worker.
 */
const INFORME = `<!doctype html><html lang="es"><head><meta charset="utf-8">
  <title>Informe de prueba</title><style>@page { size: A4; margin: 18mm }</style></head>
  <body><h1>Informe de prueba</h1><p>Un párrafo con contenido suficiente para que
  el documento tenga cuerpo y no lo rechace el tope mínimo de la ruta.</p></body></html>`
const pdf = (jwt, cuerpo) =>
  fetch(url + '/informe/pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(jwt ? { Authorization: 'Bearer ' + jwt } : {}) },
    body: JSON.stringify(cuerpo ?? { html: INFORME, nombre: 'informe semanal ñ.pdf' }),
  })

await check('el PDF sin sesión → 401', async () => {
  const r = await pdf(null)
  if (r.status !== 401) throw new Error('status ' + r.status)
})
await check('el PDF con una sesión inventada → 401', async () => {
  const r = await pdf('no-existe-esta-sesion')
  if (r.status !== 401) throw new Error('status ' + r.status)
})
await check('una cuenta dada de baja no imprime → 403', async () => {
  const r = await pdf('debaja')
  if (r.status !== 403) throw new Error('status ' + r.status)
})
await check('una cuenta sin rol de personal tampoco → 403', async () => {
  const r = await pdf('visita')
  if (r.status !== 403) throw new Error('status ' + r.status)
})
await check('sin informe que imprimir → 400', async () => {
  const r = await pdf('bueno', { html: '<p>nada</p>' })
  if (r.status !== 400) throw new Error('status ' + r.status)
})
await check('el token del worker NO sirve para esta ruta', async () => {
  const r = await pdf(TOKEN)
  if (r.status !== 401) throw new Error('status ' + r.status)
})

// La conversión de verdad. Sin WeasyPrint instalado la ruta responde 502 y eso
// también es correcto: se comprueba lo que se pueda comprobar en esta máquina.
await check('con sesión buena sale un PDF (o un 502 claro si falta WeasyPrint)', async () => {
  const r = await pdf('bueno')
  if (r.status === 502) {
    const txt = await r.text()
    if (!txt.includes('No se ha podido convertir')) throw new Error('502 sin explicación: ' + txt)
    console.log('    (sin weasyprint en esta máquina: solo se comprueba el 502)')
    return
  }
  if (r.status !== 200) throw new Error('status ' + r.status)
  if (!r.headers.get('content-type')?.includes('application/pdf')) {
    throw new Error('no viene como PDF: ' + r.headers.get('content-type'))
  }
  // Y el nombre, saneado a ASCII: con la eñe dentro, `writeHead` tumba la
  // respuesta entera con `ERR_INVALID_CHAR`.
  const dis = r.headers.get('content-disposition') ?? ''
  if (!dis.startsWith('attachment;') || !dis.includes('.pdf')) {
    throw new Error('no viene como descarga: ' + dis)
  }
  if (/[^\x00-\x7f]/.test(dis)) throw new Error('el nombre no es ASCII: ' + dis)
  const bytes = new Uint8Array(await r.arrayBuffer())
  if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new Error('no empieza por %PDF-')
})

/*
 * ── El informe en segundo plano ──
 * Se pide, se contesta «aceptado» al momento y el worker lo genera después,
 * con el código de la aplicación. Autoriza con la sesión de quien llama, y de
 * administrador.
 */
const PETICION = {
  kind: 'semanal',
  start: '2026-11-16',
  end: '2026-11-20',
  params: { secciones: ['resumen', 'analisis'], comparar: true, ia: false, audiencia: 'direccion' },
}
const generar = (jwt, cuerpo = PETICION) =>
  fetch(url + '/informe/generar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(jwt ? { Authorization: 'Bearer ' + jwt } : {}) },
    body: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo),
  })

await check('generar sin sesión → 401', async () => {
  const r = await generar(null)
  if (r.status !== 401) throw new Error('status ' + r.status)
})
await check('generar con el token del worker → 401: esta ruta es de personas', async () => {
  const r = await generar(TOKEN)
  if (r.status !== 401) throw new Error('status ' + r.status)
})
await check('un técnico puede sacar el PDF pero NO generar el informe → 403', async () => {
  const r = await generar('bueno')
  if (r.status !== 403) throw new Error('status ' + r.status)
  if (!(await r.text()).includes('administrador')) throw new Error('no dice por qué')
})
await check('una cuenta de administrador dada de baja tampoco → 403', async () => {
  SESIONES.jefa.active = false
  const r = await generar('jefa')
  SESIONES.jefa.active = true
  if (r.status !== 403) throw new Error('status ' + r.status)
})
await check('fechas imposibles → 400, y no se apunta ningún trabajo', async () => {
  const antes = trabajos.length
  for (const mal of [{ start: '2026-02-30' }, { start: '2026-11-20', end: '2026-11-16' }, { start: "2026-01-01'; drop table rooms; --" }, { start: '2020-01-01' }]) {
    const r = await generar('jefa', { ...PETICION, ...mal })
    if (r.status !== 400) throw new Error(JSON.stringify(mal) + ' → status ' + r.status)
  }
  if (trabajos.length !== antes) throw new Error('ha apuntado un trabajo con una petición mala')
})
await check('una petición que no es JSON → 400', async () => {
  const r = await generar('jefa', '{esto no')
  if (r.status !== 400) throw new Error('status ' + r.status)
})
await check('una petición desmedida → 413', async () => {
  const r = await generar('jefa', JSON.stringify({ ...PETICION, relleno: 'x'.repeat(40_000) }))
  if (r.status !== 413) throw new Error('status ' + r.status)
})
let pedido = null
await check('petición buena → 202 con su id, sin esperar al informe', async () => {
  const t0 = Date.now()
  const r = await generar('jefa', { ...PETICION, clave: 'una-clave-de-gemini-que-no-debe-quedar-escrita' })
  const c = await r.json()
  if (r.status !== 202 || c.ok !== true || !c.id) throw new Error(`status ${r.status}: ${JSON.stringify(c)}`)
  if (Date.now() - t0 > 4000) throw new Error('ha tardado en aceptar: ' + (Date.now() - t0) + ' ms')
  pedido = trabajos.find((f) => f.id === c.id)
  if (!pedido) throw new Error('no ha apuntado la fila')
  if (pedido.pedido_por !== SESIONES.jefa.id) throw new Error('no dice quién lo pidió')
  if (pedido.period_start !== '2026-11-16' || pedido.params?.audiencia !== 'direccion') throw new Error('no guarda lo que se pidió')
})
await check('la clave de Gemini del dispositivo no se guarda en la fila', async () => {
  if (JSON.stringify(trabajos).includes('una-clave-de-gemini')) throw new Error('la clave está en report_jobs')
})
await check('si el informe no puede salir, la fila acaba en «fallido» con su motivo, no «en curso» para siempre', async () => {
  // Esta base de mentira no tiene salas: la primera lectura falla.
  for (let i = 0; i < 120; i++) {
    if (pedido?.estado === 'fallido') {
      if (!pedido.error || !pedido.terminado_at) throw new Error('fallido sin motivo o sin hora')
      if (/at .*\.ts:|\/home\/|node_modules/.test(pedido.error)) throw new Error('el motivo lleva una traza: ' + pedido.error)
      if (pedido.paso !== null) throw new Error('fallido y todavía dice en qué paso va')
      return
    }
    if (pedido?.estado === 'hecho') throw new Error('ha dado por hecho un informe sin datos ni archivo')
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('no termina: ' + JSON.stringify(pedido))
})
await check('y el worker sigue en pie después de un informe fallido', async () => {
  const r = await fetch(url + '/salud')
  if (r.status !== 200) throw new Error('status ' + r.status)
})

supabaseFalso.close()

// Al grupo, no al proceso: ver el comentario del `spawn`.
try {
  process.kill(-proc.pid, 'SIGKILL')
} catch {
  proc.kill('SIGKILL')
}
console.log(fallos === 0 ? '\n✓ El endpoint del worker se comporta' : `\n✗ ${fallos} fallos`)
process.exit(fallos === 0 ? 0 : 1)
