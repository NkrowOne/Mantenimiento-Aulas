import { useEffect, useId, useRef, useState } from 'react'
import { TIPO_XLSX } from '@/domain/exportar'
import { ofrecerFichero } from '@/lib/ficheros'

/**
 * La tarjeta de «sacar esto a un Excel»: preparar y descargar, en dos pasos.
 *
 * **Son dos botones y no uno, y no es por gusto.** Preparar el fichero lleva
 * segundos —leer la base, armar el libro— y la hoja de compartir de iOS solo se
 * abre mientras dura la pulsación que la pidió: si la pulsación fuera una sola,
 * para cuando el libro estuviera hecho el permiso habría caducado y en el iPad
 * no se guardaría nada. Por eso primero se prepara, y el segundo botón —que ya
 * tiene el fichero en la mano— llama a `ofrecerFichero` directamente desde el
 * gesto. Es el mismo reparto que usa la sincronización con SharePoint.
 *
 * Preparar necesita cobertura (lee del servidor); descargar no, porque el
 * fichero ya está en memoria. Por eso sin conexión se apaga solo el primer
 * botón, y con una línea que dice por qué: un botón apagado sin explicación
 * parece una avería.
 *
 * Quien la usa solo aporta `preparar`: qué se lee y cómo se arma. Si falla,
 * debe lanzar un `Error` con un mensaje que se pueda enseñar tal cual.
 */
export function ExportarExcel({
  titulo,
  descripcion,
  preparar,
  disabled = false,
}: {
  /** Lo que dice la tarjeta: «Exportar el almacén». */
  titulo: string
  descripcion?: string
  /** Lee, arma el libro y devuelve el fichero con el nombre con el que se ofrecerá. */
  preparar: () => Promise<{ nombre: string; bytes: Uint8Array }>
  disabled?: boolean
}): React.ReactElement {
  const [listo, setListo] = useState<{ nombre: string; bytes: Uint8Array } | null>(null)
  const [preparando, setPreparando] = useState(false)
  const [entregando, setEntregando] = useState(false)
  const [entregado, setEntregado] = useState<'compartido' | 'descargado' | null>(null)
  const [fallo, setFallo] = useState<string | null>(null)
  const idTitulo = useId()

  /*
   * La cobertura se vigila mientras la tarjeta está en pantalla: entre abrirla y
   * pulsar pasa el tiempo que pasa en el sótano de un edificio.
   */
  const [enLinea, setEnLinea] = useState(() => navigator.onLine)
  useEffect(() => {
    const alCambiar = (): void => setEnLinea(navigator.onLine)
    window.addEventListener('online', alCambiar)
    window.addEventListener('offline', alCambiar)
    return () => {
      window.removeEventListener('online', alCambiar)
      window.removeEventListener('offline', alCambiar)
    }
  }, [])

  // Preparar tarda: si la pantalla se cierra mientras tanto, la respuesta no
  // tiene a quién contárselo.
  const viva = useRef(true)
  useEffect(() => {
    viva.current = true
    return () => {
      viva.current = false
    }
  }, [])

  /*
   * Al terminar de preparar, el foco se va al botón de descargar.
   *
   * El botón que se acaba de pulsar —«Preparar Excel»— desaparece del árbol en
   * ese mismo render, así que el foco caería al `<body>` y quien navega con
   * VoiceOver o con teclado se quedaría sin saber qué ha pasado.
   */
  const botonDeDescarga = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (listo) botonDeDescarga.current?.focus()
  }, [listo])

  const hacer = (): void => {
    if (preparando) return
    setPreparando(true)
    setFallo(null)
    setEntregado(null)
    setListo(null)
    // Dentro de una función `async` y no encadenando `.then` a `preparar()`: si
    // quien la aporta lanza antes de devolver la promesa, el botón se quedaría
    // en «Preparando…» para siempre.
    void (async () => {
      try {
        const r = await preparar()
        if (viva.current) setListo(r)
      } catch (e: unknown) {
        if (viva.current) setFallo(mensajeDe(e) || 'No se ha podido preparar el Excel.')
      } finally {
        if (viva.current) setPreparando(false)
      }
    })()
  }

  /**
   * Sin `useMutation` y sin `await` antes: la hoja de compartir hay que pedirla
   * dentro de la pulsación, y cualquier turno de por medio la deja caducar.
   */
  const entregar = (): void => {
    if (!listo || entregando) return
    setEntregando(true)
    setFallo(null)
    void ofrecerFichero(listo.nombre, blobDe(listo.bytes))
      .then((via) => {
        if (viva.current) setEntregado(via)
      })
      .catch((e: unknown) => {
        if (viva.current) setFallo(mensajeDe(e) || 'No se ha podido entregar el fichero.')
      })
      .finally(() => {
        if (viva.current) setEntregando(false)
      })
  }

  const sinPreparar = disabled || preparando || !enLinea

  return (
    <section className="card mt-6 p-4" aria-labelledby={idTitulo}>
      <h2 id={idTitulo} className="text-sm font-semibold">
        {titulo}
      </h2>
      {descripcion && <p className="mt-1 text-sm text-muted">{descripcion}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {listo ? (
          <>
            <button
              ref={botonDeDescarga}
              type="button"
              className="key key-accent min-h-11 max-w-full break-words px-4 py-2 text-left text-sm"
              disabled={entregando}
              onClick={entregar}
            >
              {entregando ? 'Entregando…' : `Descargar ${listo.nombre}`}
            </button>
            <button
              type="button"
              className="key key-quiet min-h-11 px-3 text-sm"
              disabled={sinPreparar || entregando}
              onClick={hacer}
            >
              Preparar de nuevo
            </button>
          </>
        ) : (
          <button
            type="button"
            className="key key-accent min-h-11 px-4 text-sm"
            disabled={sinPreparar}
            aria-busy={preparando}
            onClick={hacer}
          >
            {preparando ? 'Preparando…' : 'Preparar Excel'}
          </button>
        )}
      </div>

      {/* Lo que el botón dice al cambiar de texto no se anuncia; esto sí. */}
      <span role="status" className="sr-only">
        {preparando ? 'Preparando el Excel' : ''}
      </span>

      {!enLinea && (
        <p className="mt-2 text-xs text-muted">
          Sin conexión: hace falta cobertura para preparar el Excel.
        </p>
      )}

      {fallo && (
        <p role="alert" className="mt-2 text-sm text-crit">
          {fallo}
        </p>
      )}

      {entregado && (
        <p className="mt-2 text-sm text-ok">{entregado === 'compartido' ? 'Compartido.' : 'Descargado.'}</p>
      )}
    </section>
  )
}

/**
 * El texto del fallo, venga de donde venga: `fetch` lanza un `Error` y
 * PostgREST devuelve un objeto pelado `{ message }` que supabase-js reenvía.
 */
function mensajeDe(error: unknown): string {
  if (error instanceof Error) return error.message
  const m = (error as { message?: unknown } | null)?.message
  return typeof m === 'string' ? m : ''
}

function blobDe(bytes: Uint8Array): Blob {
  // `Uint8Array` sobre un `ArrayBuffer` normal: el tipo de Blob no acepta los
  // respaldados por `SharedArrayBuffer`.
  return new Blob([bytes as unknown as BlobPart], { type: TIPO_XLSX })
}
