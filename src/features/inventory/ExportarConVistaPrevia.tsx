import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { diaEnMadrid } from '@/domain/fechas'
import { TIPO_XLSX, libroNuevo, nombreConFecha } from '@/domain/exportar'
import {
  columnasDelPdf,
  documentoDeTablas,
  filasDeDatos,
  nombreDelPdfDe,
  textoDeCelda,
  type Exportacion,
} from '@/domain/vistaPrevia'
import type { Tinte } from '@/domain/libro'
import { ofrecerFichero } from '@/lib/ficheros'
import { supabase } from '@/lib/supabase'
import { imprimirDocumento, prepararPdf } from '@/features/reports/informe/imprimir'
import { ESTILO_DE_LA_HOJA, esAppInstalada } from './pdf'
import { Confirmacion } from '@/components/Confirmacion'
import { Icono, type NombreDeIcono } from '@/components/Icono'

/**
 * Exportar con vista previa: se ve lo que sale, y luego se descarga en Excel o
 * en PDF.
 *
 * Es lo mismo que ya hace el informe. Antes la exportación era un botón ciego:
 * se preparaba el Excel y había que abrirlo en otro sitio para saber si traía
 * lo que se quería. Ahora «Ver y exportar» lee los datos y los enseña aquí
 * mismo, una pestaña por hoja, con los mismos colores que llevará el fichero; y
 * desde esa misma vista salen el Excel y el PDF. Los tres —la vista, el Excel y
 * el PDF— salen de las mismas hojas, así que lo que se ve es lo que se lleva.
 *
 * **El PDF lo hace el servidor**, con el mismo WeasyPrint que la hoja de
 * inventario de las aulas y que el informe, porque en el iPhone con la
 * aplicación instalada no hay diálogo de imprimir. Si el servidor no puede, en
 * un navegador normal queda el botón de imprimir; en la aplicación instalada
 * solo se dice qué ha pasado.
 *
 * **Todas las entregas son de dos toques**, por lo de siempre en iOS: la hoja de
 * compartir solo se abre mientras dura la pulsación que la pidió. El Excel se
 * arma al abrir la vista previa, así que «Descargar Excel» ya lo tiene en la
 * mano; el PDF tarda unos segundos en el servidor, así que va en dos botones.
 *
 * En el PDF cada hoja se puede quitar —los movimientos de todo un año son
 * páginas y páginas que no siempre se quieren en papel—, y algunas hojas llevan
 * menos columnas que en el Excel para que quepan en un A4. El Excel las lleva
 * todas, siempre.
 */
export function ExportarConVistaPrevia({
  titulo,
  descripcion,
  preparar,
  disabled = false,
  children,
  eleccion,
  plegable,
  abrir = 0,
}: {
  /** Lo que dice la tarjeta: «Exportar el almacén». */
  titulo: string
  descripcion?: string
  /** Lee los datos y devuelve las hojas. Si falla, lanza un `Error` que se pueda enseñar tal cual. */
  preparar: () => Promise<Exportacion>
  disabled?: boolean
  /**
   * Lo que se elige ANTES de leer los datos —un periodo, qué incluir—. Va entre
   * la descripción y el botón, y se quita mientras la vista previa está abierta:
   * lo que se ve es lo que se eligió, y cambiarlo con la vista delante dejaría
   * en pantalla unas hojas que ya no corresponden. Para cambiar, se cierra.
   */
  children?: React.ReactNode
  /**
   * Lo elegido, en una cadena. Cuando cambia, se retira el fallo del intento
   * anterior: «no hay nada en ese periodo» debajo de un periodo que ya es otro
   * se lee como que tampoco hay nada en este, y todavía no se ha preguntado.
   */
  eleccion?: string
  /**
   * La tarjeta nace PLEGADA, en una fila: su dibujo, su título y una línea de
   * para qué sirve. Es para cuando va al final de una pantalla que ya es larga
   * —la ficha de un aula, la lista de salas de un edificio— y dentro lleva
   * cosas que elegir: desplegada siempre, serían dos pantallas más de
   * desplazamiento para algo que se pide una vez al mes.
   */
  plegable?: { icono: NombreDeIcono; resumen: string }
  /**
   * Una señal para abrirla desde fuera y traerla a la vista: cada vez que el
   * número cambia, se despliega. Es lo que usa el botón «Historial» de la
   * cabecera del edificio, que está a cuarenta salas de distancia.
   */
  abrir?: number
}): React.ReactElement {
  const idTitulo = useId()
  const [cargando, setCargando] = useState(false)
  const [fallo, setFallo] = useState<string | null>(null)
  const [lista, setLista] = useState<{ exportacion: Exportacion; xlsx: Uint8Array; emitidaEl: string } | null>(null)
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

  useEffect(() => setFallo(null), [eleccion])

  const [abierta, setAbierta] = useState(!plegable)
  const seccion = useRef<HTMLElement>(null)
  useEffect(() => {
    if (abrir === 0) return
    setAbierta(true)
    // Tras pintar: plegada mide una fila, y llevarla arriba antes de abrirla
    // dejaría el contenido recién desplegado fuera de la pantalla.
    const id = requestAnimationFrame(() =>
      seccion.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    )
    return () => cancelAnimationFrame(id)
  }, [abrir])

  // Leer tarda: si la pantalla se cierra mientras tanto, la respuesta no tiene
  // a quién contárselo.
  const viva = useRef(true)
  useEffect(() => {
    viva.current = true
    return () => {
      viva.current = false
    }
  }, [])

  const abrirVista = (): void => {
    if (cargando) return
    setCargando(true)
    setFallo(null)
    void (async () => {
      try {
        const exportacion = await preparar()
        const xlsx = await libroNuevo(exportacion.hojas.map((h) => h.hoja))
        if (viva.current) setLista({ exportacion, xlsx, emitidaEl: diaEnMadrid() })
      } catch (e: unknown) {
        if (viva.current) setFallo(mensajeDe(e) || 'No se han podido leer los datos.')
      } finally {
        if (viva.current) setCargando(false)
      }
    })()
  }

  const cuerpo = (
    <>
      {descripcion && <p className={`text-sm text-muted ${plegable ? '' : 'mt-1'}`}>{descripcion}</p>}

      {!lista && children}

      {!lista && (
        <button
          type="button"
          // A todo el ancho en un teléfono: es la única acción de la tarjeta, y
          // un botón que mide lo que su texto se queda a la izquierda, lejos
          // del pulgar.
          className="key key-accent mt-4 min-h-touch w-full px-4 text-sm sm:w-auto"
          disabled={disabled || cargando || !enLinea}
          aria-busy={cargando}
          onClick={abrirVista}
        >
          {cargando ? 'Leyendo los datos…' : 'Ver y exportar'}
        </button>
      )}
      <span role="status" className="sr-only">
        {cargando ? 'Leyendo los datos para la vista previa' : ''}
      </span>
      {!enLinea && !lista && (
        <p className="mt-2 text-xs text-muted">Sin conexión: hace falta cobertura para leer los datos.</p>
      )}
      {fallo && (
        <p role="alert" className="mt-2 text-sm text-crit">
          {fallo}
        </p>
      )}

      {lista && (
        <VistaPrevia
          exportacion={lista.exportacion}
          xlsx={lista.xlsx}
          emitidaEl={lista.emitidaEl}
          actualizando={cargando}
          puedeActualizar={enLinea && !disabled}
          onActualizar={abrirVista}
          onCerrar={() => setLista(null)}
        />
      )}
    </>
  )

  if (!plegable) {
    return (
      <section ref={seccion} className="card mt-6 p-4" aria-labelledby={idTitulo}>
        <h2 id={idTitulo} className="text-sm font-semibold">
          {titulo}
        </h2>
        {cuerpo}
      </section>
    )
  }

  return (
    <section ref={seccion} className="card mt-6 scroll-mt-3 overflow-hidden" aria-labelledby={idTitulo}>
      {/* La misma fila que «Documentos», justo encima en la ficha: el dibujo en
          su recuadro, el nombre y una línea. Con el galón, que dice «esto se
          abre» y, girado, que está abierto. */}
      <button
        type="button"
        onClick={() => setAbierta((v) => !v)}
        aria-expanded={abierta}
        className="fila flex min-h-touch w-full items-center gap-3 px-4 py-2.5 text-left"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] bg-accent-tint text-accent">
          <Icono nombre={plegable.icono} lado={20} />
        </span>
        <span className="min-w-0 flex-1">
          <span id={idTitulo} className="block font-medium">
            {titulo}
          </span>
          <span className="mt-0.5 block text-xs leading-snug text-muted">{plegable.resumen}</span>
        </span>
        <Icono
          nombre="abajo"
          lado={18}
          className={`shrink-0 text-muted transition-transform duration-150 ${abierta ? 'rotate-180' : ''}`}
        />
      </button>

      <div className="collapse-y" data-open={abierta} inert={!abierta}>
        <div>
          <div className="border-t border-line-soft px-4 pb-4 pt-3">{cuerpo}</div>
        </div>
      </div>
    </section>
  )
}

/** Cuántas filas se pintan en pantalla por hoja. El fichero lleva todas. */
const FILAS_EN_PANTALLA = 300

const FONDO_DE_TINTE: Record<Tinte, string> = {
  ok: 'bg-ok-tint',
  aviso: 'bg-warn-tint',
  critico: 'bg-crit-tint',
  apagado: 'text-muted',
}

type EstadoPdf =
  | null
  | { fase: 'preparando' }
  | { fase: 'listo'; nombre: string; blob: Blob }
  | { fase: 'aviso'; mal: boolean; texto: string; imprimir?: boolean }

function VistaPrevia({
  exportacion,
  xlsx,
  emitidaEl,
  actualizando,
  puedeActualizar,
  onActualizar,
  onCerrar,
}: {
  exportacion: Exportacion
  xlsx: Uint8Array
  emitidaEl: string
  actualizando: boolean
  puedeActualizar: boolean
  onActualizar: () => void
  onCerrar: () => void
}): React.ReactElement {
  const [activa, setActiva] = useState(0)
  const [enPdf, setEnPdf] = useState<boolean[]>(() => exportacion.hojas.map((h) => h.pdf?.incluir !== false))
  const [pdf, setPdf] = useState<EstadoPdf>(null)
  const [excel, setExcel] = useState<string | null>(null)
  const cabeceraRef = useRef<HTMLHeadingElement>(null)

  // Al abrir, el foco va a la vista previa: el botón que se pulsó ya no está.
  useEffect(() => cabeceraRef.current?.focus(), [])
  // Datos nuevos, PDF viejo: el que estuviera preparado ya no es lo que se ve.
  useEffect(() => {
    setPdf(null)
    setEnPdf(exportacion.hojas.map((h) => h.pdf?.incluir !== false))
    setActiva((a) => Math.min(a, exportacion.hojas.length - 1))
  }, [exportacion])

  const hoja = exportacion.hojas[activa]?.hoja
  const cabecera = hoja?.filas[0] ?? []
  const datos = hoja ? filasDeDatos(hoja) : []
  const nombreXlsx = nombreConFecha(exportacion.nombreBase)
  const nombrePdf = nombreDelPdfDe(exportacion.titulo, emitidaEl)

  const documento = useMemo(
    () =>
      documentoDeTablas(
        exportacion,
        exportacion.hojas
          .filter((_, i) => enPdf[i])
          .map((h) => ({ hoja: h.hoja, columnas: columnasDelPdf(h.hoja, h.pdf?.columnas) })),
        emitidaEl,
        ESTILO_DE_LA_HOJA,
      ),
    [exportacion, enPdf, emitidaEl],
  )
  const algunaEnPdf = enPdf.some(Boolean)

  function descargarExcel(): void {
    setExcel(null)
    void ofrecerFichero(nombreXlsx, new Blob([xlsx as unknown as BlobPart], { type: TIPO_XLSX }))
      .then((via) => setExcel(via === 'compartido' ? 'Excel compartido.' : 'Excel descargado.'))
      .catch((e: Error) => setExcel(`No se ha podido guardar el Excel: ${e.message}`))
  }

  async function prepararElPdf(): Promise<void> {
    setPdf({ fase: 'preparando' })
    const { data } = await supabase.auth.getSession()
    const r = await prepararPdf(documento, nombrePdf, data.session?.access_token ?? null)
    if (r.ok) {
      setPdf({ fase: 'listo', nombre: r.nombre, blob: r.blob })
      return
    }
    // Sin servicio, en un navegador con diálogo de imprimir, queda ese camino;
    // tiene que salir de una pulsación, así que se ofrece como botón.
    const puedeImprimir = r.sinServicio && !esAppInstalada()
    setPdf({
      fase: 'aviso',
      mal: true,
      imprimir: puedeImprimir,
      texto: puedeImprimir
        ? `El servidor no ha podido preparar el PDF (${r.motivo}). Puedes imprimirlo desde el navegador y guardarlo como PDF.`
        : `No se ha podido preparar el PDF: ${r.motivo}.`,
    })
  }

  function guardarElPdf(listo: { nombre: string; blob: Blob }): void {
    void ofrecerFichero(listo.nombre, listo.blob)
      .then((via) =>
        setPdf({ fase: 'aviso', mal: false, texto: via === 'compartido' ? 'PDF compartido.' : 'PDF descargado.' }),
      )
      .catch((e: Error) => setPdf({ fase: 'aviso', mal: true, texto: `No se ha podido guardar el PDF: ${e.message}` }))
  }

  return (
    <div className="mt-3 border-t border-line-soft pt-3">
      <p className="eyebrow">Vista previa</p>
      <h3 ref={cabeceraRef} tabIndex={-1} className="mt-1 text-base font-semibold outline-none">
        {exportacion.titulo}
      </h3>
      <p className="text-sm text-muted">
        Emitido el {emitidaEl.split('-').reverse().join('/')}
        {exportacion.resumen ? ` · ${exportacion.resumen}` : ''}
      </p>

      {exportacion.hojas.length > 1 && (
        <div className="scroll-x -mx-1 mt-3 flex gap-2 px-1 pb-1" role="group" aria-label="Hojas">
          {exportacion.hojas.map((h, i) => (
            <button
              key={h.hoja.nombre}
              type="button"
              aria-pressed={activa === i}
              onClick={() => setActiva(i)}
              className={`key min-h-11 shrink-0 px-3 text-sm ${activa === i ? 'key-accent' : 'key-quiet text-muted'}`}
            >
              {h.hoja.nombre} · {filasDeDatos(h.hoja).length}
            </button>
          ))}
        </div>
      )}

      {hoja && (
        <div className="mt-3 max-h-[60vh] overflow-auto rounded-ctl border border-line bg-surface">
          <table className="w-max min-w-full text-left text-xs">
            <thead className="sticky top-0 bg-raised">
              <tr>
                {cabecera.map((c, i) => (
                  <th key={i} scope="col" className="whitespace-nowrap border-b border-line px-2 py-2 font-semibold">
                    {String(c ?? '')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {datos.slice(0, FILAS_EN_PANTALLA).map((fila, n) => {
                const tinte = hoja.tintes?.[n]
                return (
                  <tr key={n} className={`border-b border-line-soft ${tinte ? FONDO_DE_TINTE[tinte] : ''}`}>
                    {cabecera.map((_, i) => (
                      <td key={i} className="max-w-[18rem] truncate whitespace-nowrap px-2 py-1.5" title={textoDeCelda(fila[i] ?? null, hoja.formatos?.[i])}>
                        {textoDeCelda(fila[i] ?? null, hoja.formatos?.[i])}
                      </td>
                    ))}
                  </tr>
                )
              })}
              {datos.length === 0 && (
                <tr>
                  <td colSpan={Math.max(1, cabecera.length)} className="px-2 py-3 text-muted">
                    Sin filas.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {datos.length > FILAS_EN_PANTALLA && (
        <p className="mt-1 text-xs text-muted">
          Se ven las primeras {FILAS_EN_PANTALLA} de {datos.length} filas. El Excel y el PDF las llevan todas.
        </p>
      )}

      <fieldset className="mt-4">
        <legend className="eyebrow">Qué va en el PDF</legend>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
          {exportacion.hojas.map((h, i) => {
            const columnas = columnasDelPdf(h.hoja, h.pdf?.columnas).length
            const todas = (h.hoja.filas[0] ?? []).length
            return (
              <label key={h.hoja.nombre} className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enPdf[i] ?? false}
                  onChange={(e) => {
                    const v = e.target.checked
                    setEnPdf((prev) => prev.map((x, j) => (j === i ? v : x)))
                    setPdf(null)
                  }}
                />
                {h.hoja.nombre}
                {columnas < todas && <span className="text-xs text-muted">({columnas} de {todas} columnas)</span>}
              </label>
            )
          })}
        </div>
        <p className="mt-1 text-xs text-muted">El Excel lleva siempre todas las hojas y todas las columnas.</p>
      </fieldset>

      {/*
        Dos filas de dos, todas las teclas del mismo ancho.
        Eran cuatro teclas sueltas que saltaban de línea donde cayeran: en un
        teléfono salían dos arriba y dos abajo, pero cada una de un ancho, y en
        cuanto una cambiaba de texto —«Preparando el PDF…»— bailaban las cuatro.
        Arriba lo que se viene a hacer, en el color de las acciones; abajo lo
        que se hace con la vista, en el de las secundarias.
      */}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:max-w-md">
        <button type="button" onClick={descargarExcel} className="key key-accent min-h-touch w-full px-3 text-sm">
          Descargar Excel
        </button>
        {pdf?.fase === 'listo' ? (
          <button
            type="button"
            onClick={() => guardarElPdf(pdf)}
            className="key key-accent min-h-touch w-full px-3 text-sm"
            title="El PDF ya está hecho: pulsa para guardarlo"
          >
            Guardar PDF
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void prepararElPdf()}
            disabled={!algunaEnPdf || pdf?.fase === 'preparando'}
            aria-busy={pdf?.fase === 'preparando'}
            className="key key-accent min-h-touch w-full px-3 text-sm"
          >
            {pdf?.fase === 'preparando' ? 'Preparando…' : 'Preparar PDF'}
          </button>
        )}
        <button
          aria-busy={actualizando}
          type="button"
          onClick={onActualizar}
          disabled={actualizando || !puedeActualizar}
          className="key key-quiet min-h-11 w-full px-3 text-sm"
        >
          {actualizando ? 'Actualizando…' : 'Actualizar'}
        </button>
        <button type="button" onClick={onCerrar} className="key key-quiet min-h-11 w-full px-3 text-sm">
          Cerrar
        </button>
      </div>

      <p className="mt-2 text-xs text-muted">
        El PDF lo prepara el servidor en unos segundos y el botón pasa a «Guardar PDF». En el iPhone y el
        iPad, guardar abre Compartir: elige «Guardar en Archivos» o mándalo por correo.
      </p>
      {!algunaEnPdf && <p className="mt-1 text-xs text-crit">Marca al menos una hoja para el PDF.</p>}
      {excel && <Confirmacion texto={excel} className="mt-2" />}
      {pdf?.fase === 'preparando' && <p className="mt-2 text-sm text-muted">Preparando el PDF en el servidor…</p>}
      {pdf?.fase === 'listo' && <p className="mt-2 text-sm text-ok">El PDF está listo: pulsa «Guardar PDF».</p>}
      {pdf?.fase === 'aviso' && (
        <div className="mt-2">
          <p role={pdf.mal ? 'alert' : undefined} className={`text-sm ${pdf.mal ? 'text-crit' : 'text-ok'}`}>
            {pdf.texto}
          </p>
          {pdf.imprimir && (
            <button
              type="button"
              onClick={() => {
                if (imprimirDocumento(documento, null) === 'bloqueado') {
                  setPdf({ fase: 'aviso', mal: true, texto: 'El navegador ha bloqueado la ventana de impresión.' })
                }
              }}
              className="key key-quiet mt-2 min-h-11 px-3 text-sm"
            >
              Imprimir desde el navegador
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function mensajeDe(error: unknown): string {
  if (error instanceof Error) return error.message
  const m = (error as { message?: unknown } | null)?.message
  return typeof m === 'string' ? m : ''
}
