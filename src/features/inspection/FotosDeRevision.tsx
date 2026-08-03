/**
 * Las fotos de una revisión: la fontanería y la tira.
 *
 * Se hacían en el aula, se comprimían, se subían a un bucket privado, se
 * enlazaban en `attachments`… y ahí acababa el viaje: ni la ficha de la sala ni
 * el histórico ni el informe las abrían. La aplicación pedía una foto de la
 * incidencia y después no se la enseñaba a nadie, que es la peor forma de pedir
 * algo — se deja de hacer en tres semanas.
 *
 * Aquí viven las tres piezas que comparten las dos presentaciones —la tira de
 * miniaturas de esta misma pantalla y la ficha del histórico
 * (`FichaDeObservacion`)—:
 *
 *  - **`useFotosDeRevision`**, que junta las subidas con las que esperan en el
 *    dispositivo. URL firmada y corta para las de arriba: el bucket es privado
 *    a propósito —las fotos enseñan instalaciones y a veces personas— y se pide
 *    un enlace de una hora al abrir el bloque, no uno público permanente. Y
 *    también las que aún no han subido: sin mirar la cola, la foto que acabas
 *    de hacer en un sótano no existe para la aplicación en toda la mañana, y
 *    quien la hizo no tiene forma de saber si salió bien.
 *  - **`VisorDeFotos`**, la foto a tamaño completo en su capa.
 *  - **`FotosDeRevision`**, la tira de miniaturas: la usa la cabecera de una
 *    corrección, donde las fotos de aquel día son contexto y no protagonista.
 */

import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, leerBytesDeFoto } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { fechaCorta } from '@/domain/fechas'

/** Una hora: sobra para mirar, y el enlace no se guarda en ningún sitio. */
const VALIDEZ_S = 3600

export interface Foto {
  id: string
  url: string
  takenAt: string
  /** Sigue en el dispositivo esperando cobertura. */
  pendiente: boolean
}

/**
 * Las fotos de una o varias revisiones, listas para pintar.
 *
 * Es una lista de revisiones y no un identificador porque una visita corregida
 * son varias filas de `inspections`, y las fotos de aquel día están repartidas
 * entre ellas: se hicieron en la misma aula el mismo rato. Enseñar solo las de
 * la última versión sería esconder las de la original sin decirlo.
 *
 * Las pendientes van primero: son las de hoy, y son las que alguien quiere
 * comprobar que han salido bien.
 */
export function useFotosDeRevision(ids: string[]): {
  fotos: Foto[]
  sinConexion: boolean
  /** La consulta de adjuntos aún no ha contestado. */
  cargando: boolean
} {
  const qc = useQueryClient()

  /*
   * Las que ya están arriba. Dos pasos —los adjuntos y luego las firmas— porque
   * el `storage_path` lo sabe la tabla y la firma la da el servicio de Storage.
   * `createSignedUrls` firma las diez de golpe: una petición, no una por foto.
   */
  const { data: subidas, isError, isPending } = useQuery({
    queryKey: ['fotos-revision', [...ids].sort().join(',')],
    enabled: ids.length > 0,
    queryFn: async (): Promise<Foto[]> => {
      const { data: adjuntos, error } = await supabase
        .from('attachments')
        .select('id, storage_path, taken_at')
        .eq('entity_type', 'inspection')
        .in('entity_id', ids)
        .order('taken_at', { ascending: true })
      if (error) throw error
      if (!adjuntos?.length) return []

      const rutas = adjuntos.map((a) => a['storage_path'] as string)
      const { data: firmas, error: errorFirma } = await supabase.storage
        .from('fotos')
        .createSignedUrls(rutas, VALIDEZ_S)
      if (errorFirma) throw errorFirma

      const porRuta = new Map((firmas ?? []).map((f) => [f.path ?? '', f.signedUrl]))

      return adjuntos
        .map((a) => ({
          id: a['id'] as string,
          url: porRuta.get(a['storage_path'] as string) ?? '',
          takenAt: a['taken_at'] as string,
          pendiente: false,
        }))
        .filter((f) => f.url !== '')
    },
  })

  /*
   * Y las que esperan en el dispositivo, que son las de hoy.
   *
   * De la fila de la cola sale el estado; **los bytes viven aparte**, en
   * `photoBlobs`, y se leen con `leerBytesDeFoto`. No es un detalle de
   * organización: un `Blob` sacado de IndexedDB es el que WebKit ya no sabe
   * volver a guardar, y meterlo en una fila que cambia de estado fue lo que
   * paraba la sincronización entera. Aquí se pide un Blob nuevo, hecho en
   * memoria, que solo va a la etiqueta `<img>`.
   */
  const pendientes = useLiveQuery(
    async () =>
      ids.length === 0
        ? []
        : // Por el índice compuesto, no con `filter`: el escaneo de tabla
          // completa suscribía este hook a TODA la tabla, y cada reintento de
          // subida de una foto de otra sala re-emitía y recreaba aquí todas
          // las object URLs.
          await db.photos
            .where('[entityType+entityId]')
            .anyOf(ids.map((id) => ['inspection', id]))
            .toArray(),
    [ids.join(',')],
    [],
  )

  const [locales, setLocales] = useState<Foto[]>([])

  /*
   * Cuando una foto sale de la cola es que acaba de subir: se pide la lista de
   * adjuntos otra vez para que la foto reaparezca en el sitio con su URL
   * firmada, en vez de desaparecer de la tarjeta hasta el próximo refetch. Es
   * lo que hace continua la transición dispositivo → servidor.
   */
  const idsEnColaAntes = useRef<Set<string>>(new Set())
  useEffect(() => {
    const ahora = new Set(pendientes.map((p) => p.id))
    const subioAlguna = [...idsEnColaAntes.current].some((id) => !ahora.has(id))
    idsEnColaAntes.current = ahora
    if (subioAlguna) void qc.invalidateQueries({ queryKey: ['fotos-revision'] })
  }, [pendientes, qc])

  useEffect(() => {
    let vivo = true
    const urls: string[] = []

    void (async () => {
      const nuevas: Foto[] = []
      for (const p of pendientes) {
        const bytes = await leerBytesDeFoto(p.id)
        // Sin bytes la foto es irrecuperable en este dispositivo, y la cola ya lo
        // dice a su manera —sale como rechazada—. Aquí simplemente no se pinta un
        // hueco roto.
        if (!bytes) continue
        const url = URL.createObjectURL(bytes)
        urls.push(url)
        nuevas.push({ id: p.id, url, takenAt: p.takenAt, pendiente: true })
      }

      // La lectura es asíncrona: si el bloque se cerró mientras leía, lo que se
      // ha creado se revoca aquí, que es donde se sabe que ya no lo espera nadie.
      if (!vivo) {
        for (const url of urls) URL.revokeObjectURL(url)
        return
      }
      setLocales(nuevas)
    })()

    return () => {
      vivo = false
      for (const url of urls) URL.revokeObjectURL(url)
    }
    // Por las CLAVES, no por la identidad del array: la URL solo depende de los
    // bytes, y un cambio de estado de la cola (attempts, backoff) no tiene por
    // qué revocar y volver a crear las URLs de imágenes que no han cambiado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendientes.map((p) => p.id).join(',')])

  /*
   * Sin repetidas: la fila local y el adjunto del servidor comparten id, y en
   * la ventana entre «el adjunto ya está arriba» y «la fila sale de la cola»
   * la misma foto llegaba por los dos lados. Gana la local, que va primera y
   * tiene los bytes en el dispositivo; al vaciarse la cola pasa sola a la
   * versión subida.
   */
  const idsLocales = new Set(locales.map((f) => f.id))
  return {
    fotos: [...locales, ...(subidas ?? []).filter((f) => !idsLocales.has(f.id))],
    sinConexion: isError,
    cargando: ids.length > 0 && isPending,
  }
}

/**
 * La marca de «aún no ha subido» va sobre la foto y con palabra, no con un
 * color: es la respuesta a «¿se ha guardado esto?».
 *
 * El fondo va SÓLIDO a propósito: con transparencia, el contraste del texto
 * pasaba a depender de la foto que hubiera debajo —una pared blanca lo dejaba
 * al borde del mínimo— y `check:contrast` solo garantiza el par sólido.
 */
export function SelloSinSubir(): React.ReactElement {
  return (
    <span className="absolute inset-x-0 bottom-0 bg-warn-fill py-0.5 text-center text-[0.625rem] font-semibold text-warn-ink">
      sin subir
    </span>
  )
}

/**
 * La tira de miniaturas. Doce fotos en rejilla son un bloque más alto que la
 * pantalla en mitad de una cabecera que ya cuenta tres cosas; en tira se
 * recorren con el pulgar y no desplazan nada.
 */
export function FotosDeRevision({ ids }: { ids: string[] }): React.ReactElement | null {
  /*
   * La foto abierta se recuerda por IDENTIDAD, no por posición. La lista
   * cambia sola por debajo —una foto local que termina de subir se va de la
   * cola y vuelve por el servidor— y con un índice el visor se reabría solo o
   * cambiaba de foto en silencio. Si la foto abierta ya no está, el visor se
   * cierra, que es lo único honesto.
   */
  const [abiertaId, setAbiertaId] = useState<string | null>(null)
  const { fotos, sinConexion } = useFotosDeRevision(ids)
  const abierta = abiertaId === null ? -1 : fotos.findIndex((f) => f.id === abiertaId)

  if (fotos.length === 0) {
    if (sinConexion) {
      return <p className="text-xs text-muted">Las fotos necesitan conexión.</p>
    }
    return null
  }

  return (
    <>
      <ul className="scroll-x -mx-1 flex gap-2 px-1 py-1">
        {fotos.map((f) => (
          <li key={f.id} className="shrink-0">
            <button
              type="button"
              onClick={() => setAbiertaId(f.id)}
              className="relative block overflow-hidden rounded-tag border border-line bg-sunken"
              aria-label={`Ver la foto del ${fechaCorta(f.takenAt)}`}
            >
              <img
                src={f.url}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-20 w-20 object-cover"
              />
              {f.pendiente && <SelloSinSubir />}
            </button>
          </li>
        ))}
      </ul>

      {abierta !== -1 && (
        <VisorDeFotos
          fotos={fotos}
          indice={abierta}
          onIr={(i) => setAbiertaId(fotos[i]?.id ?? null)}
          onCerrar={() => setAbiertaId(null)}
        />
      )}
    </>
  )
}

/**
 * La foto a tamaño completo.
 *
 * Se abre en una capa propia y no navegando a otra pantalla: mirar una foto es
 * un paréntesis dentro de la ficha, y quien lo cierra tiene que volver
 * exactamente al sitio donde estaba leyendo, no al principio de la sala.
 *
 * `Escape` cierra y las flechas pasan de una a otra, porque esto también se usa
 * con teclado desde el escritorio del coordinador.
 */
export function VisorDeFotos({
  fotos,
  indice,
  onIr,
  onCerrar,
}: {
  fotos: Foto[]
  indice: number
  onIr: (i: number) => void
  onCerrar: () => void
}): React.ReactElement {
  const cerrar = useRef<HTMLButtonElement>(null)
  const foto = fotos[indice]!

  useEffect(() => {
    // El foco entra en la capa: sin esto el tabulador sigue recorriendo la ficha
    // que hay detrás, que para un lector de pantalla no está aquí. Y al cerrar
    // VUELVE a la miniatura que lo abrió: caía en <body> y el usuario de
    // teclado reempezaba desde la cabecera en mitad de un histórico largo. El
    // visor no se desmonta al pasar de foto, así que esto solo corre al abrir
    // y al cerrar.
    const origen = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cerrar.current?.focus()
    return () => origen?.focus()
  }, [])

  useEffect(() => {
    const alPulsar = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCerrar()
      if (e.key === 'ArrowRight' && indice < fotos.length - 1) onIr(indice + 1)
      if (e.key === 'ArrowLeft' && indice > 0) onIr(indice - 1)
    }
    window.addEventListener('keydown', alPulsar)
    return () => window.removeEventListener('keydown', alPulsar)
  }, [indice, fotos.length, onIr, onCerrar])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Foto de la revisión"
      className="fixed inset-0 z-50 flex flex-col bg-black/95"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <p className="min-w-0 truncate font-mono text-xs text-white/70">
          {fechaCorta(foto.takenAt)}
          {foto.pendiente && ' · sin subir todavía'}
          {fotos.length > 1 && ` · ${indice + 1} de ${fotos.length}`}
        </p>
        <button
          ref={cerrar}
          type="button"
          onClick={onCerrar}
          className="key key-quiet min-h-11 shrink-0 px-4 text-sm"
        >
          Cerrar
        </button>
      </div>

      {/* El fondo cierra al tocarlo, que es el gesto que todo el mundo prueba
          primero. La imagen no, para poder mirarla sin miedo a perderla. Para
          teclado y lector de pantalla la salida es el botón «Cerrar» de arriba y
          `Escape`, no este hueco. */}
      <div
        onClick={onCerrar}
        className="flex min-h-0 flex-1 items-center justify-center px-2"
      >
        <img
          src={foto.url}
          alt=""
          onClick={(e) => e.stopPropagation()}
          className="max-h-full max-w-full object-contain"
        />
      </div>

      {fotos.length > 1 && (
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <button
            type="button"
            disabled={indice === 0}
            onClick={() => onIr(indice - 1)}
            className="key key-quiet min-h-touch flex-1 px-4 text-sm"
          >
            Anterior
          </button>
          <button
            type="button"
            disabled={indice === fotos.length - 1}
            onClick={() => onIr(indice + 1)}
            className="key key-quiet min-h-touch flex-1 px-4 text-sm"
          >
            Siguiente
          </button>
        </div>
      )}
    </div>
  )
}
