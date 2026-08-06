/**
 * Mantener pulsado sobre una fila para abrir sus acciones.
 *
 * El gesto existe porque el sitio donde se ve que un nombre está mal es la
 * lista de «Revisar», no el panel de administración: quien está delante del
 * aula 1.7 y lee «1.7 (LAB 3D)» donde debería poner otra cosa es quien puede
 * corregirlo. Meter un botón de editar en cada fila convertiría una lista de
 * trabajo —lo que se recorre cien veces al día— en un panel de mantenimiento;
 * la pulsación larga no ocupa nada y solo aparece si se busca.
 *
 * Y por eso mismo **nunca es la única vía**: cada sitio que usa esto tiene un
 * botón `⋯` hermano. Un gesto sin equivalente visible es funcionalidad que no
 * existe para VoiceOver, para el teclado y para quien no sabe que está ahí.
 *
 * La máquina de estados va aparte de los eventos y se exporta: el entorno de
 * pruebas es `node`, sin DOM, así que lo único que se puede fijar con un test
 * es `reducir()`. Es también donde están todas las decisiones — el resto es
 * `setTimeout` y traducir nombres de eventos.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'

/**
 * Medio segundo.
 *
 * Menos se dispara al posar el dedo antes de arrastrar la lista; más y deja de
 * sentirse como una respuesta. Es también lo que usan iOS y Android para su
 * propio menú contextual, así que el dedo ya viene entrenado.
 */
export const MS_PULSACION_LARGA = 500

/**
 * Cuánto se puede mover el dedo sin que deje de ser una pulsación.
 *
 * `body { touch-action: pan-y }` deja que el navegador desplace la lista, y
 * desplazar empieza exactamente igual que mantener pulsado: el dedo se posa y
 * se queda. Sin este umbral, recorrer despacio una lista de cuarenta aulas
 * abría hojas por el camino. Diez píxeles es lo que se mueve un dedo quieto
 * sobre un iPad sujeto con la otra mano.
 */
export const UMBRAL_MOVIMIENTO_PX = 10

export type EventoDePulsacion =
  | { tipo: 'abajo'; x: number; y: number; puntero: 'tactil' | 'lapiz' | 'raton' }
  | { tipo: 'mueve'; x: number; y: number }
  | { tipo: 'arriba' }
  | { tipo: 'cancela' }
  | { tipo: 'cumple-el-plazo' }
  | { tipo: 'menu-contextual' }
  | { tipo: 'clic' }

export interface EstadoDePulsacion {
  /** Dónde empezó el dedo, o null si no hay pulsación viva. */
  origen: { x: number; y: number } | null
  /** Ya se abrió la hoja: el `click` que viene detrás hay que tragárselo. */
  disparada: boolean
}

export type EfectoDePulsacion = 'arranca-plazo' | 'cancela-plazo' | 'abre' | 'traga-clic' | null

export const ESTADO_INICIAL: EstadoDePulsacion = { origen: null, disparada: false }

export function reducir(
  estado: EstadoDePulsacion,
  evento: EventoDePulsacion,
): { estado: EstadoDePulsacion; efecto: EfectoDePulsacion } {
  switch (evento.tipo) {
    case 'abajo':
      /*
       * El ratón no arranca el plazo, y no es una omisión.
       *
       * Con ratón el gesto equivalente ya existe y es el clic derecho, que
       * llega como `contextmenu` y está contemplado más abajo. Mantener el
       * botón pulsado medio segundo sobre una fila, en cambio, es lo que hace
       * quien va a arrastrar para seleccionar texto: abrirle una hoja de
       * acciones en la cara es adivinarle mal la intención.
       *
       * `disparada` se limpia aquí a propósito. Si una apertura anterior no
       * llegó a recibir su `click` —Safari lo suprime a veces después de
       * bloquear el menú contextual—, la marca se quedaría puesta y sería el
       * SIGUIENTE toque, el que sí quería navegar, el que se comiera. Empezar
       * una interacción nueva la cierra.
       */
      if (evento.puntero === 'raton') return { estado: { origen: null, disparada: false }, efecto: null }
      return {
        estado: { origen: { x: evento.x, y: evento.y }, disparada: false },
        efecto: 'arranca-plazo',
      }

    case 'mueve': {
      if (!estado.origen) return { estado, efecto: null }
      const lejos =
        Math.abs(evento.x - estado.origen.x) > UMBRAL_MOVIMIENTO_PX ||
        Math.abs(evento.y - estado.origen.y) > UMBRAL_MOVIMIENTO_PX
      if (!lejos) return { estado, efecto: null }
      return { estado: { origen: null, disparada: estado.disparada }, efecto: 'cancela-plazo' }
    }

    case 'arriba':
      // Soltar antes de tiempo es un toque normal: la fila navega y el plazo
      // se cancela. Sin esto la hoja subía medio segundo DESPUÉS de haber
      // entrado en la lista de salas, encima de otra pantalla.
      return { estado: { origen: null, disparada: estado.disparada }, efecto: 'cancela-plazo' }

    case 'cancela':
      /*
       * `pointercancel` y `pointerleave` cuentan tanto como soltar. iOS emite
       * `pointercancel` en cuanto decide que el gesto es un desplazamiento —y
       * a partir de ahí **no siempre emite `pointerup`**—, así que un
       * temporizador que solo se cancelara al soltar seguiría vivo mientras la
       * lista se desliza bajo el dedo.
       */
      return { estado: { origen: null, disparada: estado.disparada }, efecto: 'cancela-plazo' }

    case 'cumple-el-plazo':
      // Sin origen no hay pulsación viva: el plazo ya se canceló y este aviso
      // llega tarde (el `clearTimeout` y el temporizador pueden cruzarse).
      if (!estado.origen) return { estado, efecto: null }
      return { estado: { origen: null, disparada: true }, efecto: 'abre' }

    case 'menu-contextual':
      // Idempotente: en Android llegan los dos —el plazo cumplido y el menú
      // contextual del sistema— y la hoja no se puede abrir dos veces.
      if (estado.disparada) return { estado, efecto: null }
      return { estado: { origen: null, disparada: true }, efecto: 'abre' }

    case 'clic':
      /*
       * El clic que viene detrás de una pulsación larga se lo queda la hoja.
       *
       * Al soltar el dedo, el navegador emite igualmente el `click` de la fila.
       * Sin tragárselo, mantener pulsado abría la hoja **y** navegaba a la
       * lista de salas: la hoja quedaba encima de una pantalla que no era la
       * suya, hablando de un edificio que ya no se estaba mirando.
       */
      if (!estado.disparada) return { estado, efecto: null }
      return { estado: { origen: estado.origen, disparada: false }, efecto: 'traga-clic' }
  }
}

export interface ManejadoresDePulsacion {
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: (e: React.PointerEvent) => void
  onPointerCancel: (e: React.PointerEvent) => void
  onPointerLeave: (e: React.PointerEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
  onClickCapture: (e: React.MouseEvent) => void
}

const NADA = (): void => {}

/**
 * Lo que se esparce sobre la fila cuando quien mira NO es administrador.
 *
 * Manejadores que no hacen nada, y no `undefined`, para que el tipo de retorno
 * sea uno solo. Ninguno llama a `preventDefault`, así que para un técnico la
 * fila se comporta exactamente igual que antes de que esto existiera: mismo
 * menú del navegador, misma lupa de iOS, misma navegación al tocar.
 */
const MANEJADORES_VACIOS: ManejadoresDePulsacion = {
  onPointerDown: NADA,
  onPointerMove: NADA,
  onPointerUp: NADA,
  onPointerCancel: NADA,
  onPointerLeave: NADA,
  onContextMenu: NADA,
  onClickCapture: NADA,
}

function tipoDePuntero(pointerType: string): 'tactil' | 'lapiz' | 'raton' {
  if (pointerType === 'touch') return 'tactil'
  if (pointerType === 'pen') return 'lapiz'
  return 'raton'
}

/** Con `activo = false` devuelve manejadores vacíos: para un técnico la fila no cambia en nada. */
export function usePulsacionLarga(alAbrir: () => void, activo: boolean): ManejadoresDePulsacion {
  /* La devolución de llamada por `ref`: el padre la pasa como flecha nueva en
     cada render y no puede ser dependencia de nada sin rehacer los
     manejadores —y el temporizador vivo— cuarenta veces por lista. */
  const abrir = useRef(alAbrir)
  abrir.current = alAbrir

  const estado = useRef<EstadoDePulsacion>(ESTADO_INICIAL)
  const plazo = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelarPlazo = useCallback((): void => {
    if (plazo.current !== null) {
      clearTimeout(plazo.current)
      plazo.current = null
    }
  }, [])

  // Si la fila se desmonta con el dedo encima —la poda del maestro se lleva el
  // edificio mientras alguien lo pulsa— el temporizador no puede sobrevivirle.
  useEffect(() => cancelarPlazo, [cancelarPlazo])

  const despachar = useCallback(
    function despachar(evento: EventoDePulsacion): EfectoDePulsacion {
      const paso = reducir(estado.current, evento)
      estado.current = paso.estado

      if (paso.efecto === 'arranca-plazo') {
        cancelarPlazo()
        plazo.current = setTimeout(() => {
          plazo.current = null
          despachar({ tipo: 'cumple-el-plazo' })
        }, MS_PULSACION_LARGA)
      } else if (paso.efecto === 'cancela-plazo') {
        cancelarPlazo()
      } else if (paso.efecto === 'abre') {
        cancelarPlazo()
        /*
         * El golpecito, cuando lo haya. En Android confirma el gesto antes de
         * que la hoja llegue a dibujarse; iOS Safari no soporta `vibrate` y ahí
         * la confirmación es la que se ve: la fila lleva medio segundo en
         * `active:bg-raised` y la hoja sube desde el borde inferior.
         */
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(10)
        abrir.current()
      }

      return paso.efecto
    },
    [cancelarPlazo],
  )

  const manejadores = useMemo<ManejadoresDePulsacion>(
    () => ({
      onPointerDown: (e) => {
        despachar({ tipo: 'abajo', x: e.clientX, y: e.clientY, puntero: tipoDePuntero(e.pointerType) })
      },
      onPointerMove: (e) => {
        despachar({ tipo: 'mueve', x: e.clientX, y: e.clientY })
      },
      onPointerUp: () => {
        despachar({ tipo: 'arriba' })
      },
      onPointerCancel: () => {
        despachar({ tipo: 'cancela' })
      },
      onPointerLeave: () => {
        despachar({ tipo: 'cancela' })
      },
      onContextMenu: (e) => {
        // Siempre, y antes de decidir nada: es lo que mata el menú del
        // navegador y —con `.sin-lupa`— la lupa de iOS, que aparecían encima de
        // la hoja justo cuando la hoja terminaba de subir.
        e.preventDefault()
        despachar({ tipo: 'menu-contextual' })
      },
      onClickCapture: (e) => {
        /*
         * En la fase de CAPTURA, que es la que llega antes. React despacha la
         * captura de todo el árbol antes que la burbuja, así que detener aquí
         * la propagación impide que el `onClick` de navegación del propio botón
         * llegue a ejecutarse. `preventDefault` a secas no bastaría: el
         * manejador de React ya estaría en camino.
         */
        if (despachar({ tipo: 'clic' }) === 'traga-clic') {
          e.stopPropagation()
          e.preventDefault()
        }
      },
    }),
    [despachar],
  )

  return activo ? manejadores : MANEJADORES_VACIOS
}
