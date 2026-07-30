// Prueba del endpoint HTTP del worker: nunca se había ejercitado, solo la CLI.
import { spawn } from 'node:child_process'

const TOKEN = 'un-token-de-prueba-suficientemente-largo'
const env = { ...process.env, WORKER_TOKEN: TOKEN, DATABASE_URL: 'postgresql://postgres@127.0.0.1:5433/postgres', PORT: '8099', NODE_ENV: '' }
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
// Al grupo, no al proceso: ver el comentario del `spawn`.
try {
  process.kill(-proc.pid, 'SIGKILL')
} catch {
  proc.kill('SIGKILL')
}
console.log(fallos === 0 ? '\n✓ El endpoint del worker se comporta' : `\n✗ ${fallos} fallos`)
process.exit(fallos === 0 ? 0 : 1)
