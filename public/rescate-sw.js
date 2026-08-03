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
 *   - Alguna contesta con una política que SÍ activa → son páginas nuevas:
 *     ellas activarán en el próximo momento seguro, como siempre. No se toca
 *     nada.
 *   - Ninguna → código que no va a activar jamás: se fuerza la activación
 *     (`skipWaiting`), se reclaman los clientes y se les recarga. Es la recarga
 *     brusca que la política evita… una sola vez, para traer al dispositivo el
 *     código que a partir de entonces la aplica.
 *   - No hay ventanas → no hay nadie a quien interrumpir: se activa ya, y la
 *     próxima apertura sirve directamente la versión nueva.
 *
 * El plazo de la pregunta es holgado a propósito: una página nueva contesta en
 * milisegundos —el oyente se registra en el arranque, antes que el service
 * worker—, así que agotar cinco segundos solo pasa con código que no tiene el
 * oyente. Un falso positivo aquí recargaría a alguien a mitad de trabajo, que
 * es justo lo que la política existe para no hacer.
 *
 * ── Por qué la respuesta lleva número ──────────────────────────────────────
 *
 * Porque «entiendo la política» no es lo mismo que «voy a poder cumplirla», y
 * confundirlas dejó tirados justo a los dispositivos que este fichero existe
 * para rescatar.
 *
 * La primera versión daba por buena CUALQUIER respuesta. Y toda página con el
 * oyente contestaba que sí… incluidas todas aquellas cuya activación estaba
 * rota: llamaban a `updateSW()` de vite-plugin-pwa, que sin worker en espera no
 * hace nada y no lo dice (ver el comentario de `relevar()` en `src/sw.ts`). O
 * sea que el rescate preguntaba, oía «tranquilo, yo me encargo», se retiraba
 * educadamente… y se iba dejando atascado exactamente al dispositivo que venía
 * a rescatar. Y no había segunda oportunidad: `install` corre una vez por
 * worker, y el `update()` de la página vieja no vuelve a instalar nada mientras
 * el `sw.js` del servidor no cambie.
 *
 * Con número, la pregunta deja de ser «¿me oyes?» y pasa a ser «¿qué versión de
 * la política ejecutas?». La respuesta vale solo si llega a `POLITICA_MINIMA`;
 * lo de antes —una cadena suelta, o nada— cuenta como código incapaz de
 * activar, que es lo que demostró ser.
 *
 * El coste está medido y se acepta: los dispositivos con código anterior se
 * llevan UNA recarga brusca, quizá con alguien delante. Es lo que ya costaba
 * rescatar a los de antes de la política, y lo que se compra es que dejen de
 * ser irrecuperables. El borrador vive en Dexie con autoguardado, la cola de
 * salida es idempotente y rescata lo que estuviera a medio subir; lo único que
 * una recarga puede perder de verdad es una foto a medio comprimir. Frente a
 * eso, la alternativa era un iPad que no se actualiza nunca más.
 *
 * SUBIR ESTE NÚMERO ES LA FORMA DE FORZAR UN RESCATE. Al cambiar algo de lo que
 * depende que la página sepa activar, se sube aquí y en `src/sw.ts`: los
 * dispositivos que se queden por debajo se rescatan solos en el siguiente
 * despliegue en vez de esperar un toque que quizá no llegue.
 */

/* global self */

const PLAZO_DE_RESPUESTA_MS = 5000

/**
 * La política que hay que ejecutar para que este rescate se retire.
 *
 * Tiene que coincidir con `POLITICA_DE_ACTIVACION` de `src/sw.ts`, que es quien
 * contesta. Los dos números viven separados a la fuerza —este fichero entra por
 * `importScripts` dentro del worker y aquel se compila en el bundle de la
 * página, así que no pueden compartir un `import`—, y por eso cada uno nombra al
 * otro.
 *
 *   1 · contestaba «entendida» y activaba con `updateSW()`, que podía no hacer
 *       nada en silencio. Incapaz de actualizarse sola: se rescata.
 *   2 · conduce el relevo desde el registro y, si no ocurre, recarga igual.
 */
const POLITICA_MINIMA = 2

/** ¿La activación fue forzada por este rescate? Decide si `activate` recarga. */
let rescatado = false

function sabeActivar(cliente) {
  return new Promise((resolver) => {
    const canal = new MessageChannel()
    const tope = setTimeout(() => resolver(false), PLAZO_DE_RESPUESTA_MS)
    canal.port1.onmessage = (evento) => {
      clearTimeout(tope)
      // Una respuesta sin número es la de la política 1 —la cadena
      // «entendida»—, y esa no sabe activar: cuenta como un no.
      const politica = Number(evento.data && evento.data.politica)
      resolver(politica >= POLITICA_MINIMA)
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
    const respuestas = await Promise.all(clientes.map(sabeActivar))
    // Basta UNA página capaz: al activar, el relevo alcanza a todas.
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
