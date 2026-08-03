/**
 * Rescate de dispositivos atascados en una versión vieja.
 *
 * Este fichero viaja DENTRO del service worker generado (via `importScripts`,
 * ver `vite.config.ts`), y existe por un atasco que la política educada de
 * `src/sw.ts` no puede resolver sola: esa política vive en la PÁGINA, y un
 * dispositivo con el código de antes de la política no la tiene. Su página
 * registra el service worker nuevo, el navegador lo instala… y ahí se queda,
 * en `waiting`, esperando un toque en una barra que quizá ni se enseña. El
 * resultado medido: iPads semanas con «versión descono» mientras cada
 * redespliegue llegaba hasta la puerta y se quedaba fuera.
 *
 * El único código nuevo que EJECUTA un dispositivo atascado es este: el
 * `install` del service worker recién descargado. Así que la decisión se toma
 * aquí, preguntando a las ventanas abiertas si entienden la política:
 *
 *   - Alguna contesta → son páginas nuevas: ellas activarán en el próximo
 *     momento seguro, como siempre. No se toca nada.
 *   - Ninguna contesta → código viejo que no va a activar jamás: se fuerza la
 *     activación (`skipWaiting`), se reclaman los clientes y se les recarga.
 *     Es la recarga brusca que la política evita… una sola vez, para traer al
 *     dispositivo el código que a partir de entonces la aplica.
 *   - No hay ventanas → no hay nadie a quien interrumpir: se activa ya, y la
 *     próxima apertura sirve directamente la versión nueva.
 *
 * El plazo de la pregunta es holgado a propósito: una página nueva contesta en
 * milisegundos —el oyente se registra en el arranque, antes que el service
 * worker—, así que agotar cinco segundos solo pasa con código que no tiene el
 * oyente. Un falso positivo aquí recargaría a alguien a mitad de trabajo, que
 * es justo lo que la política existe para no hacer.
 */

/* global self */

const PLAZO_DE_RESPUESTA_MS = 5000

/** ¿La activación fue forzada por este rescate? Decide si `activate` recarga. */
let rescatado = false

function entiendeLaPolitica(cliente) {
  return new Promise((resolver) => {
    const canal = new MessageChannel()
    const tope = setTimeout(() => resolver(false), PLAZO_DE_RESPUESTA_MS)
    canal.port1.onmessage = () => {
      clearTimeout(tope)
      resolver(true)
    }
    try {
      cliente.postMessage({ tipo: 'sondeo-de-politica' }, [canal.port2])
    } catch {
      clearTimeout(tope)
      resolver(false)
    }
  })
}

async function decidirRescate() {
  // Sin service worker activo no hay atasco posible: es la primera
  // instalación y el navegador la activa solo.
  if (!self.registration.active) return

  const clientes = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })

  if (clientes.length > 0) {
    const respuestas = await Promise.all(clientes.map(entiendeLaPolitica))
    // Basta UNA página nueva: su política educada activará por todos.
    if (respuestas.some(Boolean)) return
  }

  rescatado = true
  await self.skipWaiting()
}

self.addEventListener('install', (evento) => {
  evento.waitUntil(decidirRescate())
})

self.addEventListener('activate', (evento) => {
  if (!rescatado) return
  evento.waitUntil(
    (async () => {
      await self.clients.claim()
      const clientes = await self.clients.matchAll({ type: 'window' })
      // `navigate` a su propia URL es la recarga: la página vieja no escucha
      // `controllerchange`, así que nadie más puede dársela. Si el navegador
      // la niega no pasa nada — el worker nuevo ya está activo y la próxima
      // apertura sirve la versión nueva de todos modos.
      await Promise.all(clientes.map((c) => c.navigate(c.url).catch(() => {})))
    })(),
  )
})
