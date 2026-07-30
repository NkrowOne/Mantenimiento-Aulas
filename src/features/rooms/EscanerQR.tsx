import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * El lector de QR.
 *
 * Dos motores, y el orden importa. `BarcodeDetector` es nativo, va en un hilo
 * aparte y no calienta el dispositivo; existe en Android y en el Chrome de
 * escritorio. En el WebKit de iOS —que es el 100% de los iPad del servicio— no
 * existe, así que hay un segundo motor en JavaScript. Sin el respaldo, esta
 * pantalla sería una cámara que no lee nada justo en los dispositivos para los
 * que se hizo.
 *
 * El motor de respaldo se carga solo cuando hace falta: son 40 KB que no tienen
 * por qué entrar en el arranque de un dispositivo que quizá nunca escanee.
 *
 * Tres detalles que parecen menores y no lo son:
 *
 *  - `playsInline`. Sin él, iOS abre el vídeo a pantalla completa con sus
 *    propios controles y tapa la aplicación entera.
 *  - Se analiza un recorte central reducido, no el fotograma completo. Un
 *    fotograma de 1080p son dos millones de píxeles por vuelta y el lector de
 *    JavaScript no llega; con el recorte va a la velocidad de la pantalla y
 *    además obliga a apuntar, que es lo que hace que no lea el QR de la puerta
 *    de al lado.
 *  - La cámara se apaga al salir. Un `<video>` que se desmonta sin parar sus
 *    pistas deja el piloto encendido y la batería bajando.
 */

type Estado =
  | { fase: 'arrancando' }
  | { fase: 'leyendo' }
  | { fase: 'error'; motivo: string; ayuda?: string }

/** El lado del recorte que se analiza, en píxeles del vídeo. */
const RECORTE = 512

export function EscanerQR({
  onLeido,
  onCerrar,
}: {
  onLeido: (texto: string) => void
  onCerrar: () => void
}): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const vivoRef = useRef(true)
  const [estado, setEstado] = useState<Estado>({ fase: 'arrancando' })
  const [linterna, setLinterna] = useState<boolean | null>(null)

  // El manejador se guarda en una referencia: si cambiara la identidad de la
  // función, el efecto volvería a pedir la cámara y el técnico vería el
  // parpadeo de un permiso que ya había concedido.
  const onLeidoRef = useRef(onLeido)
  onLeidoRef.current = onLeido

  const apagar = useCallback(() => {
    vivoRef.current = false
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  useEffect(() => {
    vivoRef.current = true
    let raf = 0

    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setEstado({
          fase: 'error',
          motivo: 'Este navegador no da acceso a la cámara.',
          ayuda: 'La cámara solo funciona sobre HTTPS. Busca la sala en la lista.',
        })
        return
      }

      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          // La de atrás, que es la que apunta a la puerta.
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        })
      } catch (e) {
        const nombre = e instanceof Error ? e.name : ''
        setEstado(
          nombre === 'NotAllowedError'
            ? {
                fase: 'error',
                motivo: 'No has dado permiso para usar la cámara.',
                ayuda: 'Se concede en Ajustes → Safari → Cámara, y luego recarga.',
              }
            : {
                fase: 'error',
                motivo: 'No se ha podido abrir la cámara.',
                ayuda: nombre === 'NotFoundError' ? 'Este dispositivo no tiene cámara trasera.' : undefined,
              },
        )
        return
      }

      if (!vivoRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream

      const video = videoRef.current
      if (!video) return
      video.srcObject = stream
      try {
        await video.play()
      } catch {
        // Safari rechaza la reproducción si la pestaña pierde el foco entre
        // medias. No es un fallo del que haya que informar: al volver se
        // reanuda sola.
      }

      const pista = stream.getVideoTracks()[0]
      const capacidades = pista?.getCapabilities?.() as { torch?: boolean } | undefined
      setLinterna(capacidades?.torch ? false : null)

      setEstado({ fase: 'leyendo' })

      // --- Motor 1: el nativo -------------------------------------------------
      const Detector = (
        window as unknown as {
          BarcodeDetector?: new (o: { formats: string[] }) => {
            detect: (s: CanvasImageSource) => Promise<Array<{ rawValue: string }>>
          }
        }
      ).BarcodeDetector

      const detector = Detector ? new Detector({ formats: ['qr_code'] }) : null

      // --- Motor 2: el de respaldo -------------------------------------------
      const jsQR = detector ? null : (await import('jsqr')).default

      const canvas = (canvasRef.current ??= document.createElement('canvas'))
      canvas.width = RECORTE
      canvas.height = RECORTE
      const ctx = canvas.getContext('2d', { willReadFrequently: true })

      const vuelta = async (): Promise<void> => {
        if (!vivoRef.current) return

        if (video.readyState >= 2 && ctx) {
          // El recorte central del vídeo, escalado al lienzo de análisis.
          const lado = Math.min(video.videoWidth, video.videoHeight)
          const x = (video.videoWidth - lado) / 2
          const y = (video.videoHeight - lado) / 2
          ctx.drawImage(video, x, y, lado, lado, 0, 0, RECORTE, RECORTE)

          try {
            let texto: string | null = null

            if (detector) {
              const marcas = await detector.detect(canvas)
              texto = marcas[0]?.rawValue ?? null
            } else if (jsQR) {
              const imagen = ctx.getImageData(0, 0, RECORTE, RECORTE)
              // `dontInvert`: los QR impresos son oscuros sobre claro, y probar
              // también el negativo duplica el trabajo por vuelta para nada.
              texto = jsQR(imagen.data, RECORTE, RECORTE, { inversionAttempts: 'dontInvert' })?.data ?? null
            }

            if (texto && vivoRef.current) {
              // Se para antes de avisar: si el manejador tarda, no se acumulan
              // lecturas del mismo código.
              vivoRef.current = false
              onLeidoRef.current(texto)
              return
            }
          } catch {
            // Un fotograma que no se puede analizar no es un error de la
            // pantalla: se prueba con el siguiente.
          }
        }

        raf = requestAnimationFrame(() => void vuelta())
      }

      void vuelta()
    })()

    return () => {
      cancelAnimationFrame(raf)
      apagar()
    }
  }, [apagar])

  async function alternarLinterna(): Promise<void> {
    const pista = streamRef.current?.getVideoTracks()[0]
    if (!pista || linterna === null) return
    try {
      // `torch` no está en la definición estándar de TypeScript, pero sí en
      // Chrome de Android — que es donde esta pantalla se usa a oscuras.
      await pista.applyConstraints({ advanced: [{ torch: !linterna }] } as unknown as MediaTrackConstraints)
      setLinterna(!linterna)
    } catch {
      setLinterna(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="relative flex-1 overflow-hidden">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="absolute inset-0 h-full w-full object-cover"
        />

        {/* La mirilla. Marca el recorte que de verdad se analiza, así que no es
            decoración: apuntar dentro es lo que hace que lea. */}
        {estado.fase === 'leyendo' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="relative aspect-square w-[68vmin] max-w-sm">
              <span className="absolute left-0 top-0 h-10 w-10 rounded-tl-card border-l-[3px] border-t-[3px] border-accent" />
              <span className="absolute right-0 top-0 h-10 w-10 rounded-tr-card border-r-[3px] border-t-[3px] border-accent" />
              <span className="absolute bottom-0 left-0 h-10 w-10 rounded-bl-card border-b-[3px] border-l-[3px] border-accent" />
              <span className="absolute bottom-0 right-0 h-10 w-10 rounded-br-card border-b-[3px] border-r-[3px] border-accent" />
            </div>
          </div>
        )}

        {estado.fase === 'arrancando' && (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-white/70">
            Abriendo la cámara…
          </p>
        )}

        {estado.fase === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="card max-w-sm p-4">
              <p className="text-sm font-medium text-crit">{estado.motivo}</p>
              {estado.ayuda && <p className="mt-2 text-sm text-muted">{estado.ayuda}</p>}
            </div>
          </div>
        )}
      </div>

      <div
        className="flex items-center justify-between gap-3 bg-black px-4 py-4"
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
      >
        <p className="min-w-0 flex-1 text-sm text-white/70">
          {estado.fase === 'leyendo' ? 'Apunta al QR de la puerta' : ' '}
        </p>

        {linterna !== null && (
          <button
            type="button"
            onClick={() => void alternarLinterna()}
            aria-pressed={linterna}
            className={`key min-h-touch shrink-0 px-4 text-sm ${linterna ? 'key-accent' : 'key-quiet'}`}
          >
            Linterna
          </button>
        )}

        <button
          type="button"
          onClick={() => {
            apagar()
            onCerrar()
          }}
          className="key key-quiet min-h-touch shrink-0 px-4 text-sm"
        >
          Cancelar
        </button>
      </div>
    </div>
  )
}
