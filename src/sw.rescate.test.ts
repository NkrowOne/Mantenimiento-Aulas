import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

/**
 * El rescate de dispositivos atascados, ejecutado de verdad.
 *
 * `public/rescate-sw.js` no se puede importar: viaja por `importScripts` dentro
 * del service worker, así que no exporta nada y habla con un `self` que aquí no
 * existe. Pero es el único código que corre en un dispositivo que ya no sabe
 * actualizarse solo, o sea que es exactamente el que no puede fallar — y lo que
 * decide es si un iPad vuelve a recibir versiones o se queda fuera para
 * siempre. Así que se le monta el `self` que le falta y se le mira decidir.
 *
 * Lo que se protege aquí es la lección que costó el fallo: la primera versión
 * daba por buena cualquier respuesta, y toda página con el oyente contestaba
 * que sí — incluidas las que tenían la activación rota. El rescate preguntaba,
 * oía «yo me encargo» y se retiraba dejando atascado justo al dispositivo que
 * venía a rescatar.
 */

const RAIZ = path.resolve(__dirname, '..')

const fuenteRescate = readFileSync(path.join(RAIZ, 'public/rescate-sw.js'), 'utf8')
const fuenteSw = readFileSync(path.join(RAIZ, 'src/sw.ts'), 'utf8')

/** Saca una constante numérica de un fuente sin ejecutarlo. */
function numero(fuente: string, nombre: string): number {
  const encontrado = new RegExp(`${nombre}\\s*=\\s*(\\d+)`).exec(fuente)
  if (!encontrado?.[1]) throw new Error(`No se encuentra ${nombre}`)
  return Number(encontrado[1])
}

interface ClienteFalso {
  url: string
  navigate: (url: string) => Promise<void>
  postMessage: (datos: unknown, puertos: { postMessage: (d: unknown) => void }[]) => void
}

/**
 * Una ventana abierta que contesta al sondeo lo que se le diga.
 * `sinRespuesta` es el código tan viejo que ni siquiera tiene el oyente.
 */
function ventana(respuesta: unknown | 'sinRespuesta'): ClienteFalso {
  return {
    url: 'https://aulas/',
    navigate: async () => {},
    postMessage: (_datos, [puerto]) => {
      if (respuesta === 'sinRespuesta' || !puerto) return
      queueMicrotask(() => puerto.postMessage(respuesta))
    },
  }
}

/** Monta el `self` de un service worker, ejecuta el fichero y dispara `install`. */
async function decidir(opciones: {
  hayWorkerActivo?: boolean
  clientes?: ClienteFalso[]
}): Promise<{ rescatado: boolean }> {
  const { hayWorkerActivo = true, clientes = [] } = opciones
  const oyentes = new Map<string, (evento: { waitUntil: (p: Promise<unknown>) => void }) => void>()
  const skipWaiting = vi.fn(async () => {})

  const self = {
    registration: { active: hayWorkerActivo ? {} : null },
    clients: {
      matchAll: async () => clientes,
      claim: async () => {},
    },
    skipWaiting,
    addEventListener: (tipo: string, fn: never) => oyentes.set(tipo, fn),
  }

  /*
   * Un canal de mensajes de mentira, y a propósito: el `MessageChannel` de Node
   * es un puerto real que mantiene vivo el bucle de eventos, y el código bajo
   * prueba no cierra los suyos —no le hace falta en un navegador—. Con el de
   * verdad, la suite se queda colgada al terminar.
   */
  class CanalFalso {
    port1: { onmessage: ((e: { data: unknown }) => void) | null } = { onmessage: null }
    port2 = { postMessage: (datos: unknown) => this.port1.onmessage?.({ data: datos }) }
  }

  const contexto = vm.createContext({
    self,
    MessageChannel: CanalFalso,
    // Envueltos, no pasados directamente: los temporizadores falsos de vitest
    // reemplazan los globales, y una referencia capturada al crear el contexto
    // se quedaría apuntando a los de verdad.
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: unknown) => globalThis.clearTimeout(id as number),
    queueMicrotask,
    Promise,
    Number,
  })
  vm.runInContext(fuenteRescate, contexto)

  const instalar = oyentes.get('install')
  if (!instalar) throw new Error('rescate-sw.js no registró el oyente de install')

  let enCurso: Promise<unknown> = Promise.resolve()
  instalar({ waitUntil: (p) => (enCurso = p) })

  // El plazo del sondeo es de cinco segundos y aquí no se esperan de verdad:
  // el caso «no contesta nadie» es justo el que hay que probar.
  await vi.advanceTimersByTimeAsync(10_000)
  await enCurso

  return { rescatado: skipWaiting.mock.calls.length > 0 }
}

describe('rescate de dispositivos atascados', () => {
  it('los dos números de la política van juntos', () => {
    // Si se separan, el rescate deja de reconocer a la página que sí sabe
    // activar y la recarga a la fuerza en cada despliegue — o, peor, reconoce
    // como capaz a una que no lo es y no la rescata nunca.
    expect(numero(fuenteSw, 'POLITICA_DE_ACTIVACION')).toBe(
      numero(fuenteRescate, 'POLITICA_MINIMA'),
    )
  })

  it('se retira ante una página que sabe activar', async () => {
    vi.useFakeTimers()
    try {
      const politica = numero(fuenteRescate, 'POLITICA_MINIMA')
      const { rescatado } = await decidir({ clientes: [ventana({ politica })] })
      expect(rescatado).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('RESCATA a la página que contesta «entendida»: es la política vieja', async () => {
    // El fallo que trajo todo esto. Esa cadena la contestan todas las versiones
    // desplegadas hasta ahora, y todas activan con `updateSW()`, que sin worker
    // en espera no hace nada y no lo dice. Dar por buena esa respuesta es
    // dejarlas atascadas para siempre: `install` corre una vez por worker y no
    // hay segunda oportunidad.
    vi.useFakeTimers()
    try {
      const { rescatado } = await decidir({ clientes: [ventana('entendida')] })
      expect(rescatado).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rescata a la página que no contesta nada', async () => {
    vi.useFakeTimers()
    try {
      const { rescatado } = await decidir({ clientes: [ventana('sinRespuesta')] })
      expect(rescatado).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('basta una página capaz para no molestar a las demás', async () => {
    vi.useFakeTimers()
    try {
      const politica = numero(fuenteRescate, 'POLITICA_MINIMA')
      const { rescatado } = await decidir({
        clientes: [ventana('entendida'), ventana({ politica })],
      })
      expect(rescatado).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sin ventanas abiertas activa sin preguntar: no hay a quién interrumpir', async () => {
    vi.useFakeTimers()
    try {
      const { rescatado } = await decidir({ clientes: [] })
      expect(rescatado).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('no toca nada en la primera instalación', async () => {
    // Sin worker activo no hay atasco posible: el navegador activa solo. Forzar
    // aquí sería recargar a alguien que acaba de abrir la aplicación.
    vi.useFakeTimers()
    try {
      const { rescatado } = await decidir({ hayWorkerActivo: false, clientes: [] })
      expect(rescatado).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('la página contesta con número, no con la cadena de antes', () => {
    // El otro lado del apretón de manos: si `src/sw.ts` volviera a contestar
    // una cadena suelta, se rescataría a sí misma en cada despliegue.
    expect(fuenteSw).toContain('politica: POLITICA_DE_ACTIVACION')
    expect(fuenteSw).not.toContain("postMessage('entendida')")
  })
})
