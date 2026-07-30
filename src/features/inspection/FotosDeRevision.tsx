/**
 * Las fotos de una revisión, que hasta ahora no se veían en ninguna parte.
 *
 * Se hacían en el aula, se comprimían, se subían a un bucket privado, se
 * enlazaban en `attachments`… y ahí acababa el viaje: ni la ficha de la sala ni
 * el histórico ni el informe las abrían. La aplicación pedía una foto de la
 * incidencia y después no se la enseñaba a nadie, que es la peor forma de pedir
 * algo — se deja de hacer en tres semanas.
 *
 * Tres decisiones que importan:
 *
 *  - **URL firmada y corta.** El bucket es privado a propósito: las fotos
 *    enseñan instalaciones y a veces personas. Se pide un enlace de una hora al
 *    abrir el bloque, no un enlace público permanente.
 *  - **También las que aún no han subido.** La cola de fotos guarda el `Blob` en
 *    el dispositivo hasta que hay cobertura. Sin mirarla, la foto que acabas de
 *    hacer en un sótano no existe para la aplicación durante toda la mañana, y
 *    quien la hizo no tiene forma de saber si salió bien.
 *  - **Miniaturas en una tira, no una rejilla.** Doce fotos en rejilla son un
 *    bloque más alto que la pantalla en mitad de una ficha que ya tiene siete
 *    secciones; en tira se recorren con el pulgar y no desplazan nada.
 */

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { fechaCorta } from '@/domain/fechas'

/** Una hora: sobra para mirar, y el enlace no se guarda en ningún sitio. */
const VALIDEZ_S = 3600

interface Foto {
  id: string
  url: string
  takenAt: string
  /** Sigue en el dispositivo esperando cobertura. */
  pendiente: boolean
}

export function FotosDeRevision({
  ids,
  vacio,
}: {
  /**
   * Las revisiones de las que traer fotos.
   *
   * Es una lista y no un identificador porque una visita corregida son varias
   * filas de `inspections`, y las fotos de aquel día están repartidas entre
   * ellas: se hicieron en la misma aula el mismo rato. Enseñar solo las de la
   * última versión sería esconder las de la original sin decirlo.
   */
  ids: string[]
  /** Qué poner cuando no hay ninguna. Sin texto, no se dibuja nada. */
  vacio?: string
}): React.ReactElement | null {
  const [abierta, setAbierta] = useState<number | null>(null)

  /*
   * Las que ya están arriba. Dos pasos —los adjuntos y luego las firmas— porque
   * el `storage_path` lo sabe la tabla y la firma la da el servicio de Storage.
   * `createSignedUrls` firma las diez de golpe: una petición, no una por foto.
   */
  const { data: subidas, isError } = useQuery({
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
   * Y las que esperan en el dispositivo. Se leen los `Blob` y se convierten en
   * URL de objeto, que hay que revocar: sin eso, cada redibujado deja una copia
   * de la imagen en memoria hasta recargar la aplicación.
   */
  const pendientes = useLiveQuery(
    async () =>
      ids.length === 0
        ? []
        : await db.photos.filter((p) => p.entityType === 'inspection' && ids.includes(p.entityId)).toArray(),
    [ids.join(',')],
    [],
  )

  const [locales, setLocales] = useState<Foto[]>([])
  const urlsVivas = useRef<string[]>([])

  useEffect(() => {
    const nuevas = pendientes.map((p) => ({
      id: p.id,
      url: URL.createObjectURL(p.blob),
      takenAt: p.takenAt,
      pendiente: true,
    }))
    urlsVivas.current = nuevas.map((f) => f.url)
    setLocales(nuevas)

    return () => {
      for (const url of urlsVivas.current) URL.revokeObjectURL(url)
      urlsVivas.current = []
    }
  }, [pendientes])

  // Las pendientes primero: son las de hoy, y son las que alguien quiere
  // comprobar que han salido bien.
  const fotos = [...locales, ...(subidas ?? [])]

  if (fotos.length === 0) {
    if (isError) {
      return <p className="text-xs text-muted">Las fotos necesitan conexión.</p>
    }
    return vacio ? <p className="text-xs text-muted">{vacio}</p> : null
  }

  return (
    <>
      <ul className="scroll-x -mx-1 flex gap-2 px-1 py-1">
        {fotos.map((f, i) => (
          <li key={f.id} className="shrink-0">
            <button
              type="button"
              onClick={() => setAbierta(i)}
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
              {/* La marca de «aún no ha subido» va sobre la foto y con palabra,
                  no con un color: es la respuesta a «¿se ha guardado esto?». */}
              {f.pendiente && (
                <span className="absolute inset-x-0 bottom-0 bg-warn-fill/90 py-0.5 text-center text-[0.625rem] font-semibold text-warn-ink">
                  sin subir
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>

      {abierta !== null && fotos[abierta] && (
        <Visor
          fotos={fotos}
          indice={abierta}
          onIr={setAbierta}
          onCerrar={() => setAbierta(null)}
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
function Visor({
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
    // que hay detrás, que para un lector de pantalla no está aquí.
    cerrar.current?.focus()
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
