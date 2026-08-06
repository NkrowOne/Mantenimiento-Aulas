import { describe, expect, it } from 'vitest'
import {
  ESTADO_INICIAL,
  reducir,
  type EfectoDePulsacion,
  type EstadoDePulsacion,
  type EventoDePulsacion,
} from './pulsacion-larga'

/**
 * La máquina de la pulsación larga, evento a evento.
 *
 * Se prueba `reducir` y no el hook porque el entorno es `node`: no hay DOM que
 * emita `pointercancel` ni temporizador que fingir. Y porque todas las
 * decisiones están aquí — el hook solo traduce nombres de eventos y llama a
 * `setTimeout`.
 */

/** Reproduce una secuencia entera y devuelve el estado final y el último efecto. */
function reproducir(
  eventos: EventoDePulsacion[],
  desde: EstadoDePulsacion = ESTADO_INICIAL,
): { estado: EstadoDePulsacion; efecto: EfectoDePulsacion; efectos: EfectoDePulsacion[] } {
  let estado = desde
  let efecto: EfectoDePulsacion = null
  const efectos: EfectoDePulsacion[] = []
  for (const evento of eventos) {
    const paso = reducir(estado, evento)
    estado = paso.estado
    efecto = paso.efecto
    efectos.push(paso.efecto)
  }
  return { estado, efecto, efectos }
}

const DEDO_ABAJO: EventoDePulsacion = { tipo: 'abajo', x: 100, y: 100, puntero: 'tactil' }

describe('reducir · el dedo quieto', () => {
  it('abre la hoja cuando el dedo aguanta el plazo entero', () => {
    const { estado, efectos } = reproducir([DEDO_ABAJO, { tipo: 'cumple-el-plazo' }])
    expect(efectos).toEqual(['arranca-plazo', 'abre'])
    expect(estado.disparada).toBe(true)
  })

  it('no abre nada al soltar antes de tiempo', () => {
    // El toque normal de toda la vida: la fila navega a la lista de salas.
    const { efectos } = reproducir([DEDO_ABAJO, { tipo: 'arriba' }])
    expect(efectos).toEqual(['arranca-plazo', 'cancela-plazo'])
  })
})

describe('reducir · desplazar la lista', () => {
  it('cancela el plazo en cuanto el dedo se va más de diez píxeles', () => {
    const { estado, efecto } = reproducir([DEDO_ABAJO, { tipo: 'mueve', x: 100, y: 115 }])
    expect(efecto).toBe('cancela-plazo')
    expect(estado.origen).toBeNull()
  })

  it('y entonces el plazo cumplido ya no abre nada', () => {
    // Es la mitad que faltaba: cancelar el temporizador y que llegue igual —se
    // cruzan— no puede abrir una hoja sobre una lista que se está deslizando.
    const { efecto } = reproducir([
      DEDO_ABAJO,
      { tipo: 'mueve', x: 100, y: 115 },
      { tipo: 'cumple-el-plazo' },
    ])
    expect(efecto).toBeNull()
  })

  it('aguanta el temblor de una mano que sujeta el iPad', () => {
    // Ocho píxeles no llegan al umbral: la pulsación sigue viva y abre.
    const { efectos } = reproducir([
      DEDO_ABAJO,
      { tipo: 'mueve', x: 104, y: 108 },
      { tipo: 'cumple-el-plazo' },
    ])
    expect(efectos).toEqual(['arranca-plazo', null, 'abre'])
  })
})

describe('reducir · lo que iOS emite de verdad', () => {
  it('cancelar el puntero cuenta tanto como soltarlo', () => {
    // iOS emite `pointercancel` al decidir que el gesto es un desplazamiento, y
    // a partir de ahí no siempre emite `pointerup`. Un temporizador que solo se
    // cancelara al soltar seguiría vivo con la lista deslizándose.
    const { estado, efecto } = reproducir([DEDO_ABAJO, { tipo: 'cancela' }])
    expect(efecto).toBe('cancela-plazo')
    expect(estado.origen).toBeNull()
  })
})

describe('reducir · el clic que viene detrás', () => {
  it('se lo traga la hoja recién abierta', () => {
    // Sin esto, mantener pulsado abría la hoja Y navegaba a la lista de salas:
    // la hoja quedaba encima de una pantalla que no era la suya.
    const { estado, efecto } = reproducir([
      DEDO_ABAJO,
      { tipo: 'cumple-el-plazo' },
      { tipo: 'arriba' },
      { tipo: 'clic' },
    ])
    expect(efecto).toBe('traga-clic')
    expect(estado.disparada).toBe(false)
  })

  it('un toque normal llega entero a la fila', () => {
    const { efecto } = reproducir([DEDO_ABAJO, { tipo: 'arriba' }, { tipo: 'clic' }])
    expect(efecto).toBeNull()
  })

  it('y una apertura que nunca recibió su clic no se come el toque siguiente', () => {
    // Safari suprime a veces el `click` posterior a bloquear el menú
    // contextual. Con la marca puesta a la espera, el siguiente toque —el que
    // sí quería entrar en el edificio— se perdía sin que nada lo explicara.
    const { efectos } = reproducir([
      { tipo: 'menu-contextual' },
      DEDO_ABAJO,
      { tipo: 'arriba' },
      { tipo: 'clic' },
    ])
    expect(efectos).toEqual(['abre', 'arranca-plazo', 'cancela-plazo', null])
  })
})

describe('reducir · ratón y menú contextual', () => {
  it('el ratón no arranca ningún plazo', () => {
    // Con ratón el gesto ya existe: el clic derecho. Mantener el botón pulsado
    // es lo que hace quien va a arrastrar para seleccionar.
    const { estado, efecto } = reproducir([{ tipo: 'abajo', x: 5, y: 5, puntero: 'raton' }])
    expect(efecto).toBeNull()
    expect(estado.origen).toBeNull()
  })

  it('el clic derecho abre la hoja igual que el dedo', () => {
    const { efecto } = reproducir([
      { tipo: 'abajo', x: 5, y: 5, puntero: 'raton' },
      { tipo: 'menu-contextual' },
    ])
    expect(efecto).toBe('abre')
  })

  it('y no la abre dos veces cuando llegan el plazo y el menú', () => {
    // En Android llegan los dos para el mismo gesto.
    const { efectos } = reproducir([
      DEDO_ABAJO,
      { tipo: 'cumple-el-plazo' },
      { tipo: 'menu-contextual' },
    ])
    expect(efectos).toEqual(['arranca-plazo', 'abre', null])
  })

  it('el lápiz sí abre: es un dedo con punta', () => {
    const { efecto } = reproducir([{ tipo: 'abajo', x: 5, y: 5, puntero: 'lapiz' }])
    expect(efecto).toBe('arranca-plazo')
  })
})
