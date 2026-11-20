import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { fechaCorta } from '@/domain/fechas'
import { EstadoIA, useEstadoIA } from './EstadoIA'
import { AUDIENCIAS, SECCIONES, porDefectoDe, seccionesDe } from './secciones'
import { type HuellaDeRedaccion, redaccionDe } from './redaccion'
import { type Eleccion, motivoParaNoPedir } from './peticion'
import { TOPE_ENFOQUE } from './informe/opciones'
import {
  type Kind,
  type Rango,
  PRESETS,
  diasDelRango,
  hoyEnMadrid,
  nombrePeriodo,
} from './periodos'
import {
  type Fichero,
  type InformeGenerado,
  type Paso,
  excelDeUnInforme,
  generarInforme,
  nombreDeArchivo,
  nombreDelPdf,
} from './informe/generar'
import {
  type ResultadoPdf,
  descargarDocumento,
  imprimirDocumento,
  mostrarEn,
  prepararPdf,
  ventanaEnBlanco,
} from './informe/imprimir'
import { ofrecerFicheros } from '@/lib/ficheros'
import { TOPE_CONSULTA_MS, TOPE_PDF_MS, conPlazo } from './informe/espera'
import { VistaPrevia } from './VistaPrevia'

interface ReportRow {
  id: string
  kind: Kind
  period_start: string
  period_end: string
  storage_path: string
  generated_at: string
  params:
    | (HuellaDeRedaccion & {
        analisis?: string
        secciones?: string[]
        audiencia?: string
        nota?: string
      })
    | null
}

const KIND_LABEL: Record<Kind, string> = {
  diario: 'Diario',
  semanal: 'Semanal',
  personalizado: 'Del periodo',
}

/**
 * Lo que se dice entre las dos pulsaciones.
 *
 * Es el texto que sostiene todo el arreglo del iPhone: el fichero ya existe y
 * la única forma de que llegue a Archivos es un segundo toque. Sin decirlo, el
 * botón cambia de nombre y parece que no ha pasado nada.
 */
const DONDE_VA =
  'En el iPhone y el iPad se abre la hoja de compartir, y desde ahí va a Archivos, a Correo o a SharePoint; en el ordenador cae en la carpeta de descargas.'
const PDF_LISTO = `El PDF ya está hecho. Pulsa «Guardar PDF» para llevártelo. ${DONDE_VA}`
const EXCEL_LISTO = `El Excel ya está hecho. Pulsa «Guardar Excel» para llevártelo. ${DONDE_VA}`

const PASOS: Record<Paso, string> = {
  datos: 'Leyendo los datos del periodo',
  analisis: 'Calculando las cifras',
  documento: 'Componiendo el documento',
  almacen: 'Terminando el Excel del almacén',
  archivo: 'Guardándolo en el archivo',
}

/** De qué informe es un fichero: el recién hecho, o la fila del archivo con ese id. */
type Para = string
const RECIEN: Para = 'recien'

/** Los ficheros ya hechos de UN informe, esperando el toque que los guarda. */
interface Hechos {
  para: Para
  pdf?: Fichero
  excel?: Fichero
}

/**
 * Informes.
 *
 * El informe se arma **aquí**, en el propio navegador: se leen los datos, se
 * calculan las cifras, se le pide a Gemini que redacte el análisis y se compone
 * el documento. No hay un servicio detrás que pueda estar caído, ni una cola de
 * la que nadie se entera, ni un token que sincronizar. Lo único que hay que
 * configurar para que el análisis lo escriba una IA es la clave de Gemini, y se
 * pega en la tarjeta de arriba.
 *
 * DE CADA INFORME SALEN DOS FICHEROS, sueltos y sin comprimir: el informe en
 * PDF y el Excel del almacén de esos días —el stock al abrir y al cerrar el
 * periodo, cada movimiento con su saldo, el consumo por aula y el stock de
 * hoy—. Se pueden guardar de uno en uno o los dos de una vez.
 *
 * El PDF lo convierte el servidor, y empieza a convertirse solo en cuanto el
 * informe está hecho: antes había que pedirlo con un botón y esperar, y era un
 * paso que no decidía nada —nadie genera un informe para no llevárselo—. El
 * Excel se arma en el propio navegador mientras se redacta el análisis.
 *
 * Un informe emitido **no se regenera nunca**: se versiona. Si los datos cambian
 * después, el documento del viernes tiene que seguir diciendo lo que decía el
 * viernes, o deja de servir como registro. De ahí que aquí no haya ningún botón
 * de «actualizar»: se emite otro y los dos quedan en el archivo.
 */
export function ReportsPage(): React.ReactElement {
  const hoy = hoyEnMadrid()
  const qc = useQueryClient()

  const [preset, setPreset] = useState<string>('semana')
  const [desde, setDesde] = useState('')
  const [hasta, setHasta] = useState('')
  const [audiencia, setAudiencia] = useState<'direccion' | 'equipo'>('direccion')
  const [secciones, setSecciones] = useState<string[]>(porDefectoDe('direccion'))
  const [comparar, setComparar] = useState(true)
  const [conIA, setConIA] = useState(true)
  /* Las casillas que existen para esta audiencia. «Sin cerrar» no se ofrece
     para dirección: ese documento no dice cuántos días lleva abierta nada. */
  const ofrecidas = seccionesDe(audiencia)
  const [enfoque, setEnfoque] = useState('')
  const [nota, setNota] = useState('')
  const [ajustes, setAjustes] = useState(false)

  /* En qué paso va y QUÉ está leyendo. Lo segundo no es adorno: cuando algo se
     atasca, la diferencia entre «Leyendo los datos» y «leyendo el diario del
     periodo» es la diferencia entre volver a llamar y saber dónde mirar. */
  const [paso, setPaso] = useState<{ fase: Paso; detalle?: string; fallo?: boolean } | null>(null)
  const [recien, setRecien] = useState<InformeGenerado | null>(null)
  /* El fallo de una descarga, a la vista. `createSignedUrl` puede denegar por
     permisos o red, y descartarlo dejaba el botón «Abrir» como un botón que a
     veces no hace nada. */
  const [falloDescarga, setFalloDescarga] = useState<string | null>(null)
  /*
   * Los ficheros ya hechos, esperando el toque que los guarda.
   *
   * Hacerlos y guardarlos son dos momentos, y no por gusto: en iOS la hoja de
   * compartir —lo único que lleva un fichero a Archivos o a SharePoint desde el
   * iPhone— solo se abre mientras dura la pulsación que la pidió, y hacer el
   * PDF es una vuelta al servidor. Con una sola pulsación el permiso caducaba
   * por el camino, `navigator.share` fallaba, y el `<a download>` de red sobre
   * un `blob:` fuera del gesto en iOS no hace nada: ni descarga, ni abre, ni
   * avisa.
   *
   * `para` dice de qué informe son: el recién hecho o la fila del archivo. Así
   * un fichero preparado no se ofrece desde el botón de otro. Solo se guardan
   * los de uno a la vez: preparar los de otro informe suelta los anteriores.
   */
  const [hechos, setHechos] = useState<Hechos | null>(null)
  /** Qué se está preparando ahora mismo, para no dejar el botón mudo. */
  const [ocupado, setOcupado] = useState<{ para: Para; que: 'pdf' | 'excel' } | null>(null)
  /*
   * El PDF del informe recién hecho no ha salido solo. Entonces se ofrece el
   * botón de prepararlo a mano, que es el que puede caer al diálogo de imprimir:
   * abrir una ventana pide una pulsación, y la conversión automática no la
   * tiene.
   */
  const [pdfPendiente, setPdfPendiente] = useState(false)
  /*
   * Y el aviso, **con el informe al que pertenece dentro**.
   *
   * Antes esto era `falloDescarga`, que se pinta al final de la página, detrás
   * del archivo entero. El botón está arriba, en la tarjeta del informe recién
   * hecho: quien lo pulsaba veía «Preparando…», luego el botón volver a su
   * sitio, y nada más — ni el «ya está, pulsa para guardarlo» ni el error, los
   * dos a varias pantallas de scroll por debajo, pasado todo el archivo. En un
   * móvil eso es exactamente lo mismo que no decir nada.
   */
  const [aviso, setAviso] = useState<{ para: Para; texto: string; mal: boolean } | null>(null)
  /*
   * A qué petición pertenece lo que vuelve. Una conversión tarda, y mientras
   * tanto se puede haber generado otro informe: el PDF que llega tarde es del
   * anterior, y guardarlo con el nombre del nuevo sería el peor fallo posible
   * de esta pantalla. Cada petición coge su número y solo cuenta la última.
   */
  const turno = useRef(0)

  const marco = useRef<HTMLIFrameElement>(null)
  /* La tarjeta del informe recién hecho, para llevar la pantalla hasta ella. */
  const tarjeta = useRef<HTMLElement>(null)

  const { data: estadoIA } = useEstadoIA()

  const { data: reports, isError: falloArchivo } = useQuery({
    queryKey: ['reports'],
    queryFn: async (): Promise<ReportRow[]> => {
      // El error se lanza en vez de tragarse: sin esto, un permiso denegado o
      // un fallo de red pintaban «Aún no hay informes» sobre un archivo lleno.
      const { data, error } = await supabase
        .from('reports')
        .select('id, kind, period_start, period_end, storage_path, generated_at, params')
        .order('generated_at', { ascending: false })
        .limit(60)
      if (error) throw error
      return (data ?? []) as ReportRow[]
    },
  })

  const rango: Rango = useMemo(() => {
    if (preset === 'medida') return { start: desde, end: hasta }
    const p = PRESETS.find((x) => x.id === preset)
    return p ? p.rango(hoy) : { start: '', end: '' }
  }, [preset, desde, hasta, hoy])

  const kind: Kind =
    preset === 'medida'
      ? 'personalizado'
      : (PRESETS.find((x) => x.id === preset)?.kind ?? 'personalizado')
  const dias = diasDelRango(rango)

  const eleccion: Eleccion = { kind, rango, secciones, comparar, ia: conIA, audiencia, enfoque, nota }
  const impedimento = motivoParaNoPedir(eleccion, dias)

  const generar = useMutation({
    mutationFn: async (): Promise<InformeGenerado> => {
      setRecien(null)
      // Un informe nuevo deja obsoletos los ficheros del anterior, y el botón
      // dice «Guardar PDF» sin distinguirlos: se guardaría el de antes.
      turno.current += 1
      setHechos(null)
      setOcupado(null)
      setPdfPendiente(false)
      setAviso(null)
      setFalloDescarga(null)
      return generarInforme(eleccion, (fase, detalle, fallo) =>
        setPaso({ fase, ...(detalle ? { detalle } : {}), ...(fallo ? { fallo: true } : {}) }),
      )
    },
    onSettled: () => setPaso(null),
    onSuccess: (informe) => {
      setRecien(informe)
      // El Excel ya viene hecho; el PDF se pide solo, sin esperar a un botón.
      setHechos({ para: RECIEN, ...(informe.excel ? { excel: informe.excel } : {}) })
      convertirElRecien(informe, false)
      /*
       * Y la pantalla, hasta el resultado. En un teléfono la tarjeta sale por
       * debajo del formulario —con las opciones abiertas, dos pantallas más
       * abajo—, y lo que se veía al terminar era el botón «Generar informe»
       * otra vez quieto, como si no hubiera pasado nada. Tras el pintado, que
       * es cuando la tarjeta existe.
       */
      requestAnimationFrame(() => {
        const sinAnimar = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        tarjeta.current?.scrollIntoView({ block: 'start', behavior: sinAnimar ? 'auto' : 'smooth' })
      })
      // El archivo acaba de cambiar, y la tarjeta de la IA también: la
      // procedencia del último informe es justo lo que enseña.
      void qc.invalidateQueries({ queryKey: ['reports'] })
      void qc.invalidateQueries({ queryKey: ['ia-estado'] })
    },
  })

  /**
   * Abre un informe del archivo, renderizado y no como código.
   *
   * La pestaña se pide ANTES de descargar: el permiso para abrirla dura lo que
   * dura el gesto, y una espera por medio lo convierte en un bloqueo. Y el
   * documento se vuelve a servir desde aquí con su tipo real porque el almacén
   * puede entregar un HTML subido por un usuario como texto plano —es lo
   * prudente por su parte—, y entonces lo que se ve es el código fuente.
   */
  async function abrir(path: string): Promise<void> {
    setFalloDescarga(null)
    const ventana = ventanaEnBlanco()
    if (!ventana) {
      setFalloDescarga('El navegador ha bloqueado la pestaña: vuelve a pulsar Abrir.')
      return
    }
    const { data, error } = await supabase.storage.from('reports').download(path)
    if (error || !data) {
      ventana.close()
      setFalloDescarga(`No se ha podido abrir el informe${error ? `: ${error.message}` : ''}.`)
      return
    }
    mostrarEn(ventana, data)
  }

  /** Añade un fichero hecho a los de ese informe, soltando los de cualquier otro. */
  const anotar = (para: Para, que: 'pdf' | 'excel', fichero: Fichero): void =>
    setHechos((h) => ({ ...(h?.para === para ? h : { para }), [que]: fichero }))

  /** Convierte un documento a PDF con la sesión de quien lo pide. Nunca lanza. */
  async function convertir(html: string, nombre: string): Promise<ResultadoPdf> {
    try {
      const { data } = await conPlazo('La sesión', TOPE_CONSULTA_MS, supabase.auth.getSession())
      return await prepararPdf(html, nombre, data.session?.access_token ?? null)
    } catch (err) {
      // Ninguna espera de esta pantalla puede ser infinita: los botones se
      // deshabilitan mientras dura, así que una promesa que no termina los
      // deja muertos hasta recargar.
      return { ok: false, motivo: err instanceof Error ? err.message : String(err), sinServicio: false }
    }
  }

  /**
   * El PDF del informe recién hecho.
   *
   * Se llama sola al terminar de generar, y también desde el botón de
   * reintento. La diferencia es `conDialogo`: si el servidor no puede —un
   * despliegue sin la ruta, el worker caído— el camino de siempre es abrir el
   * informe con el diálogo de imprimir, que también da un PDF, y eso solo se
   * puede hacer desde una pulsación.
   */
  function convertirElRecien(informe: InformeGenerado, conDialogo: boolean): void {
    const mio = ++turno.current
    setOcupado({ para: RECIEN, que: 'pdf' })
    setPdfPendiente(false)
    setAviso(null)
    void convertir(informe.html, nombreDelPdf(informe.kind, informe.rango)).then((r) => {
      if (turno.current !== mio) return
      setOcupado(null)
      if (r.ok) {
        anotar(RECIEN, 'pdf', { nombre: r.nombre, blob: r.blob })
        return
      }
      setPdfPendiente(true)
      if (r.sinServicio && conDialogo) {
        const via = imprimirDocumento(informe.html, marco.current)
        setAviso({
          para: RECIEN,
          mal: true,
          texto:
            via === 'bloqueado'
              ? `No se ha podido preparar el PDF (${r.motivo}) y el navegador ha bloqueado la ventana del informe. Permite las ventanas emergentes de esta página, o usa «Descargar el original».`
              : `El servidor no ha podido preparar el PDF (${r.motivo}): se ha abierto el informe con el diálogo de imprimir, que también lo guarda como PDF.`,
        })
        return
      }
      setAviso({
        para: RECIEN,
        mal: true,
        texto: r.sinServicio
          ? `El servidor no ha podido preparar el PDF (${r.motivo}). Pulsa «Preparar el PDF»: si sigue sin poder, se abre el informe con el diálogo de imprimir, que también lo guarda como PDF.`
          : `No se ha podido preparar el PDF: ${r.motivo}.`,
      })
    })
  }

  /**
   * El PDF de un informe que ya está archivado.
   *
   * Quien entra al archivo suele venir a mandarle a alguien el informe del mes
   * pasado, y con «Abrir» lo que se llevaba era un HTML que en el correo del
   * cliente se abre como código.
   *
   * El original se guarda entero y autocontenido —los gráficos son SVG y las
   * fotos van dentro—, así que basta con recuperarlo y pasarlo por el mismo
   * conversor que el informe recién hecho. No se vuelve a consultar la base ni
   * se recalcula nada: el PDF de un informe de marzo dice lo que decía en
   * marzo, que es justo lo que se espera de un archivo.
   */
  async function pdfArchivado(r: ReportRow): Promise<void> {
    const mio = ++turno.current
    setFalloDescarga(null)
    setAviso(null)
    setOcupado({ para: r.id, que: 'pdf' })
    const mal = (texto: string): void => setAviso({ para: r.id, texto, mal: true })
    try {
      // Con plazo, como todo lo de esta pantalla: `storage.download` no acepta
      // señal, así que lo que se corta es la espera. Sin esto, un almacén mudo
      // dejaba el botón en «Preparando…» antes siquiera de llegar al PDF.
      const { data, error } = await conPlazo(
        'El archivo de informes',
        TOPE_PDF_MS,
        supabase.storage.from('reports').download(r.storage_path),
      )
      if (turno.current !== mio) return
      if (error || !data) {
        mal(`No se ha podido leer el informe del archivo${error ? `: ${error.message}` : ''}.`)
        return
      }
      const html = await data.text()
      const hecho = await convertir(html, nombreDelPdf(r.kind, { start: r.period_start, end: r.period_end }))
      if (turno.current !== mio) return
      if (!hecho.ok) {
        mal(
          hecho.sinServicio
            ? `No se ha podido preparar el PDF (${hecho.motivo}). Con «Abrir» sale el informe y desde ahí se imprime a PDF.`
            : `No se ha podido preparar el PDF: ${hecho.motivo}.`,
        )
        return
      }
      anotar(r.id, 'pdf', { nombre: hecho.nombre, blob: hecho.blob })
      setAviso({ para: r.id, texto: PDF_LISTO, mal: false })
    } catch (err) {
      // El plazo salta aquí. Antes no había nada que saltara: la promesa no
      // terminaba y el `finally` no llegaba, así que el botón se quedaba
      // deshabilitado en «Preparando…» hasta recargar la página.
      if (turno.current !== mio) return
      mal(`No se ha podido preparar el PDF: ${err instanceof Error ? err.message : String(err)}.`)
    } finally {
      if (turno.current === mio) setOcupado(null)
    }
  }

  /**
   * El Excel del almacén de un informe: el de una fila del archivo, o el del
   * recién hecho cuando no salió a la primera.
   *
   * No está guardado en ninguna parte y no hace falta: se rehace de los
   * movimientos del almacén, que no se editan ni se borran, así que el libro de
   * un periodo cerrado sale igual se pida cuando se pida.
   */
  async function hacerExcel(para: Para, kind: string, rango: Rango): Promise<void> {
    const mio = ++turno.current
    setFalloDescarga(null)
    setAviso(null)
    setOcupado({ para, que: 'excel' })
    try {
      const excel = await excelDeUnInforme(kind, rango)
      if (turno.current !== mio) return
      anotar(para, 'excel', excel)
      setAviso({ para, texto: EXCEL_LISTO, mal: false })
    } catch (err) {
      if (turno.current !== mio) return
      setAviso({
        para,
        mal: true,
        texto: `No se ha podido preparar el Excel: ${err instanceof Error ? err.message : String(err)}`,
      })
    } finally {
      if (turno.current === mio) setOcupado(null)
    }
  }

  /**
   * Entregar lo que ya está hecho. **Se llama desde la pulsación**, sin un solo
   * `await` por delante: la hoja de compartir de iOS se abre mientras dura el
   * gesto y un turno de espera la cierra.
   *
   * Uno o los dos, y los dos van sueltos: la hoja de compartir los lleva a
   * Correo como dos adjuntos, no como un paquete que haya que descomprimir.
   *
   * Los ficheros no se tiran al entregarlos: quien cancela la hoja de compartir
   * sin querer —o comparte por correo y además quiere guardarlo en Archivos—
   * vuelve a pulsar y ya está, sin otra vuelta al servidor.
   */
  function guardar(para: Para, ficheros: Fichero[]): void {
    const que = ficheros.length > 1 ? 'Los dos archivos' : ficheros[0]?.nombre.endsWith('.pdf') ? 'El PDF' : 'El Excel'
    const varios = ficheros.length > 1
    setAviso(null)
    void ofrecerFicheros(ficheros)
      .then((via) =>
        setAviso({
          para,
          texto:
            via === 'compartido'
              ? `${que}, ${varios ? 'compartidos. Ya los' : 'compartido. Ya lo'} tienes donde ${varios ? 'los' : 'lo'} hayas mandado.`
              : `${que}, ${varios ? 'descargados' : 'descargado'}.`,
          mal: false,
        }),
      )
      .catch((e: Error) => setAviso({ para, texto: `No se ha podido guardar: ${e.message}`, mal: true }))
  }

  /**
   * El aviso de un informe, pegado a los botones que lo produjeron y no al
   * final de la página.
   *
   * Y mientras se prepara algo, cuánto puede tardar. No es relleno: el informe
   * se sube entero al servidor —con las fotos del periodo dentro van varios
   * megas—, WeasyPrint lo compone y vuelve el fichero. Son decenas de segundos
   * por 5G, y un botón que solo pone «Preparando…» durante medio minuto se lee
   * como un botón roto.
   */
  function Aviso({ para }: { para: Para }): React.ReactElement | null {
    if (ocupado?.para === para) {
      return (
        <p aria-live="polite" className="mt-2 w-full text-sm text-muted sm:basis-full">
          {ocupado.que === 'pdf'
            ? 'Convirtiendo el informe a PDF en el servidor. Puede tardar medio minuto, y algo más si lleva fotos. No cierres la pantalla.'
            : 'Leyendo el almacén y armando el Excel. Son unos segundos.'}
        </p>
      )
    }
    if (aviso?.para !== para) return null
    return (
      <p
        {...(aviso.mal ? { role: 'alert' as const } : { 'aria-live': 'polite' as const })}
        /* A todo lo ancho: en la fila del archivo, que es flexible, se metía
           al lado de los botones y estrujaba la fecha a palabra por línea. */
        className={`mt-2 w-full text-sm sm:basis-full ${aviso.mal ? 'text-crit' : 'text-ok'}`}
      >
        {aviso.texto}
      </p>
    )
  }

  const alternar = (clave: string): void =>
    setSecciones((s) => (s.includes(clave) ? s.filter((x) => x !== clave) : [...s, clave]))

  /* Cambiar de audiencia cambia el documento, no solo la voz: lo marcado era
     para la otra, así que se vuelve a lo que lleva esta por defecto. */
  const elegirAudiencia = (a: 'direccion' | 'equipo'): void => {
    setAudiencia(a)
    setSecciones(porDefectoDe(a))
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Informes</h1>
        <p className="mt-1 text-sm text-muted">
          El informe se genera con los datos del periodo elegido y sale en dos archivos: el
          informe en PDF y un Excel con el almacén de esos días. Queda archivado. Un informe
          emitido no se modifica: se emite uno nuevo y se conservan los dos.
        </p>
      </header>

      <section className="card p-4">
        <h2 className="font-semibold">Generar un informe</h2>

        {/* ── Periodo ── */}
        <div className="mt-3">
          <span className="eyebrow">Periodo</span>
          {/*
            En rejilla de dos columnas, y no en teclas que saltan de línea.
            Sueltas, los seis periodos caían en tres filas de anchos distintos
            —dos, tres y uno— y había que leerlos todos para dar con uno. En dos
            columnas el propio sitio los ordena: a la izquierda lo que está en
            curso, a la derecha lo pasado; una fila para la semana, otra para el
            mes, y la última para lo que se sale de eso. El orden de `PRESETS`
            ya era este; lo que faltaba era que se viera.
          */}
          <div role="group" aria-label="Periodo" className="opciones mt-2">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPreset(p.id)}
                aria-pressed={preset === p.id}
              >
                {p.etiqueta}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPreset('medida')}
              aria-pressed={preset === 'medida'}
            >
              Otras fechas
            </button>
          </div>

          {preset === 'medida' && (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted">Desde</span>
                <input
                  type="date"
                  value={desde}
                  max={hoy}
                  onChange={(e) => setDesde(e.target.value)}
                  className="h-11 rounded-ctl border border-line bg-surface px-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted">Hasta</span>
                <input
                  type="date"
                  value={hasta}
                  max={hoy}
                  onChange={(e) => setHasta(e.target.value)}
                  className="h-11 rounded-ctl border border-line bg-surface px-2"
                />
              </label>
            </div>
          )}

          {/* Qué va a cubrir, escrito. Un botón que dice «semana en curso» sin
              decir qué días son eso obliga a generar el informe para averiguarlo. */}
          <p className="mt-3 text-sm">
            {!impedimento || impedimento.includes('sección') ? (
              <>
                Cubrirá <span className="font-medium">{nombrePeriodo(rango)}</span>
                <span className="text-muted">
                  {' '}
                  · {dias === 1 ? 'un día' : `${dias} días`} · se compara con los {dias === 1 ? 'del día' : `${dias} días`}{' '}
                  anteriores
                </span>
              </>
            ) : (
              <span className="text-muted">{impedimento}</span>
            )}
          </p>
        </div>

        {/* ── Ajustes ── */}
        <button
          type="button"
          onClick={() => setAjustes((v) => !v)}
          aria-expanded={ajustes}
          /* A todo el ancho en un teléfono, como el botón de generar que tiene
             debajo: dos botones de anchos distintos, uno encima del otro y los
             dos pegados a la izquierda, eran otro escalón en la misma tarjeta. */
          className="key key-quiet mt-4 flex min-h-11 w-full flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-3 py-2 text-left text-sm sm:w-auto sm:justify-start"
        >
          {ajustes ? 'Ocultar las opciones' : 'Contenido del informe'}
          <span className="text-muted">
            {secciones.length} de {ofrecidas.length} secciones
            {conIA ? ' · con IA' : ' · sin IA'}
          </span>
        </button>

        {ajustes && (
          <div className="mt-4 space-y-5 border-t border-line pt-4">
            <fieldset>
              <legend className="eyebrow">Secciones</legend>
              <div className="mt-2 grid gap-1 sm:grid-cols-2">
                {ofrecidas.map((s) => (
                  <label
                    key={s.clave}
                    className="flex cursor-pointer items-start gap-2 rounded-ctl px-2 py-2 text-sm hover:bg-raised"
                  >
                    <input
                      type="checkbox"
                      checked={secciones.includes(s.clave)}
                      onChange={() => alternar(s.clave)}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--accent))]"
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">{s.etiqueta}</span>
                      <span className="block text-xs text-muted">{s.detalle}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="mt-2 flex gap-3 text-xs">
                <button
                  type="button"
                  onClick={() => setSecciones(ofrecidas.map((s) => s.clave))}
                  className="text-accent underline"
                >
                  Todas
                </button>
                <button
                  type="button"
                  onClick={() => setSecciones(porDefectoDe(audiencia))}
                  className="text-accent underline"
                >
                  Las de siempre
                </button>
              </div>
            </fieldset>

            <fieldset>
              <legend className="eyebrow">Análisis</legend>
              <label className="mt-2 flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={conIA}
                  onChange={(e) => setConIA(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--accent))]"
                />
                <span>
                  <span className="block font-medium">Redactar el análisis con IA</span>
                  <span className="block text-xs text-muted">
                    {estadoIA?.clave_guardada
                      ? `Con ${estadoIA?.modelo}, razonando antes de escribir. Si falla, sale el análisis calculado.`
                      : 'No hay clave configurada, así que saldrá el análisis calculado de todas formas.'}
                  </span>
                </span>
              </label>

              <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={comparar}
                  onChange={(e) => setComparar(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--accent))]"
                />
                <span>
                  <span className="block font-medium">Comparar con el periodo anterior</span>
                  <span className="block text-xs text-muted">
                    Añade la variación a cada indicador
                  </span>
                </span>
              </label>

              <div className="mt-4">
                <span className="text-sm text-muted">Escrito para</span>
                <div role="group" aria-label="Escrito para" className="segmento mt-1 grid w-full grid-cols-2">
                  {AUDIENCIAS.map((a) => (
                    <button
                      key={a.clave}
                      type="button"
                      onClick={() => elegirAudiencia(a.clave)}
                      aria-pressed={audiencia === a.clave}
                      title={a.detalle}
                    >
                      {a.etiqueta}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-xs text-muted">
                  {AUDIENCIAS.find((a) => a.clave === audiencia)?.detalle}
                </p>
              </div>

              {/*
                El encargo a la IA, y una caja en la que quepa.

                Era una línea de texto de 400 caracteres, y una línea pide una
                frase: «mira el CRAI». Pero quien pide el informe suele tener
                media página de contexto que no está en los datos —lo que se
                habló en la reunión del lunes, la obra del edificio H, el
                proveedor que va tarde— y con una caja de una línea o no lo
                escribía o lo escribía a ciegas, sin ver lo que llevaba puesto.
                Ahora cabe, se lee entera y se puede alargar. Los saltos de
                línea llegan tal cual a la instrucción.
              */}
              <label className="mt-4 block text-sm">
                <span className="text-muted">Qué quieres contarle a la IA (opcional)</span>
                <textarea
                  value={enfoque}
                  maxLength={TOPE_ENFOQUE}
                  rows={7}
                  onChange={(e) => setEnfoque(e.target.value)}
                  placeholder={
                    'Céntrate en el edificio H, que arrastra la obra desde julio.\n' +
                    'El consumo de cable HDMI es alto porque se cambió toda la planta 2.\n' +
                    'Este informe lo lee el vicerrector: que se note lo que se ha cerrado.'
                  }
                  className="mt-1 min-h-[10rem] w-full resize-y rounded-ctl border border-line bg-surface p-3 text-base leading-relaxed"
                />
                <span className="mt-1 flex flex-wrap justify-between gap-x-3 text-xs text-muted">
                  <span>
                    Va a la redacción del análisis, por delante de lo demás. No cambia ninguna cifra.
                  </span>
                  {/* Lo que queda, y solo cuando ya importa: un contador en cero
                      caracteres es ruido, y uno que aparece a falta de cien es
                      un aviso a tiempo de que la frase se va a cortar. */}
                  {enfoque.length > TOPE_ENFOQUE - 150 && (
                    <span className={enfoque.length >= TOPE_ENFOQUE ? 'text-warn' : ''}>
                      {TOPE_ENFOQUE - enfoque.length} caracteres
                    </span>
                  )}
                </span>
              </label>

              <label className="mt-4 block text-sm">
                <span className="text-muted">Nota en la portada (opcional)</span>
                <input
                  type="text"
                  value={nota}
                  maxLength={300}
                  onChange={(e) => setNota(e.target.value)}
                  placeholder="Para la reunión de dirección del lunes"
                  className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base"
                />
                <span className="mt-1 block text-xs text-muted">
                  Se imprime tal cual, bajo el título. No pasa por la IA.
                </span>
              </label>
            </fieldset>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            aria-busy={generar.isPending}
            type="button"
            disabled={impedimento !== null || generar.isPending}
            onClick={() => generar.mutate()}
            className="key key-accent min-h-touch w-full px-4 sm:w-auto sm:min-w-40"
          >
            {generar.isPending ? 'Generando…' : 'Generar informe'}
          </button>
          {/* El motivo, a la vista: un botón apagado sin explicación deja a quien
              lo mira buscando qué le falta. */}
          {impedimento && <span className="text-sm text-muted">{impedimento}</span>}
        </div>

        {/* En qué paso va. No es decoración: con IA la espera pasa del medio
            minuto, y una barra que no dice nada se lee como una pantalla
            colgada. */}
        {generar.isPending && (
          <p className={`mt-3 text-sm ${paso?.fallo ? 'text-warn' : 'text-muted'}`} role="status">
            {paso ? `${PASOS[paso.fase]}${paso.detalle ? `: ${paso.detalle}` : ''}…` : 'Preparando…'}
            {/* La espera larga se anuncia solo mientras de verdad se está
                esperando. Después de un fallo de la IA ya no hay nada que
                esperar, y decir «suele tardar un minuto» sobre un aviso de
                error lo convierte en ruido. */}
            {paso?.fase === 'analisis' &&
              conIA &&
              !paso.fallo &&
              ' Con IA suele tardar entre veinte segundos y un minuto.'}
          </p>
        )}

        {generar.isError && (
          <p role="alert" className="mt-3 text-sm text-crit">
            {generar.error instanceof Error
              ? generar.error.message
              : 'No se ha podido generar el informe.'}
          </p>
        )}
      </section>

      {recien && (
        <section ref={tarjeta} className="card scroll-mt-20 p-4">
          <div className="min-w-0">
            <h2 className="font-semibold">
              Listo: {KIND_LABEL[recien.kind as Kind]}, {recien.periodoTexto}
            </h2>
            <p className="mt-1 text-sm text-muted">
              Son dos archivos, sin comprimir: el informe en PDF y el Excel del almacén —el stock
              de esos días, sus movimientos y el stock de hoy—.{' '}
              {recien.conIA
                ? 'El análisis lo ha redactado la IA; las cifras no salen de ahí: se calculan con los datos.'
                : 'El análisis sale calculado a partir de los datos.'}
            </p>
          </div>

          {/*
            Tres botones, y el primero es el que se viene a pulsar: los dos
            archivos de una vez. Los otros dos son para quien solo quiere uno.

            Aparecen ya en su sitio y apagados mientras el PDF se convierte, en
            vez de aparecer cuando está: un botón que sale de la nada mueve los
            de al lado justo cuando el dedo va hacia ellos.
          */}
          {(() => {
            const mios = hechos?.para === RECIEN ? hechos : null
            const pdf = mios?.pdf
            const excel = mios?.excel
            const convirtiendo = ocupado?.para === RECIEN && ocupado.que === 'pdf'
            const armando = ocupado?.para === RECIEN && ocupado.que === 'excel'
            return (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!pdf || !excel}
                  onClick={() => pdf && excel && guardar(RECIEN, [pdf, excel])}
                  className="key key-accent min-h-11 w-full px-4 text-sm sm:w-auto"
                >
                  Guardar los dos archivos
                </button>
                {pdfPendiente && !pdf ? (
                  <button
                    type="button"
                    disabled={ocupado !== null}
                    onClick={() => convertirElRecien(recien, true)}
                    className="key key-quiet min-h-11 flex-1 px-3 text-sm sm:flex-none"
                  >
                    Preparar el PDF
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={!pdf}
                    onClick={() => pdf && guardar(RECIEN, [pdf])}
                    className="key key-quiet min-h-11 flex-1 px-3 text-sm sm:flex-none"
                  >
                    {convirtiendo ? 'Preparando el PDF…' : 'Guardar PDF'}
                  </button>
                )}
                {excel ? (
                  <button
                    type="button"
                    onClick={() => guardar(RECIEN, [excel])}
                    className="key key-quiet min-h-11 flex-1 px-3 text-sm sm:flex-none"
                  >
                    Guardar Excel
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={ocupado !== null}
                    onClick={() => void hacerExcel(RECIEN, recien.kind, recien.rango)}
                    className="key key-quiet min-h-11 flex-1 px-3 text-sm sm:flex-none"
                  >
                    {armando ? 'Preparando el Excel…' : 'Preparar el Excel'}
                  </button>
                )}
              </div>
            )
          })()}

          {/* Pegado a los botones: lo que falta y lo que ha pasado se dice
              donde está el dedo. */}
          <Aviso para={RECIEN} />

          {/* Lo que no ha salido como se pidió, dicho. Que el análisis venga
              calculado cuando se marcó «con IA» no es un detalle: quien lo pidió
              tiene que saber por qué, y casi siempre se arregla en un minuto. */}
          {recien.avisoIA && (
            <p className="mt-3 rounded-ctl border border-warn/40 bg-warn-tint p-3 text-sm text-warn">
              El análisis ha salido calculado y no redactado por la IA: {recien.avisoIA}.
            </p>
          )}

          {/* El Excel que no salió: el informe está entero y el libro se puede
              volver a pedir, pero hay que decir que ahora mismo falta uno de
              los dos archivos. */}
          {recien.motivoExcel && !(hechos?.para === RECIEN && hechos.excel) && (
            <p className="mt-3 rounded-ctl border border-warn/40 bg-warn-tint p-3 text-sm text-warn">
              El informe está hecho, pero el Excel del almacén no ha salido:{' '}
              {recien.motivoExcel.replace(/[.\s]+$/, '')}. Pulsa «Preparar el Excel» para volver a
              intentarlo.
            </p>
          )}

          {recien.motivoArchivo && (
            <p role="alert" className="mt-3 rounded-ctl border border-warn/40 bg-warn-tint p-3 text-sm text-warn">
              El informe está hecho, pero {recien.motivoArchivo}. Guárdalo para no perderlo.
            </p>
          )}

          {/* La vista previa, a escala: la hoja entera también en un teléfono. */}
          <VistaPrevia html={recien.html} titulo={`Informe · ${recien.periodoTexto}`} marco={marco} />

          {/*
            Lo que hace cada botón, en dos líneas, y el original al final: es el
            HTML del que sale el PDF, y casi nadie lo necesita.
          */}
          <p className="mt-2 text-xs text-muted">
            El PDF lo convierte el servidor en cuanto el informe está hecho; el Excel se arma aquí
            mismo. {DONDE_VA}{' '}
            <button
              type="button"
              onClick={() => descargarDocumento(recien.html, nombreDeArchivo(recien.kind, recien.rango))}
              className="text-accent underline"
              title="El original en HTML, del que sale el PDF"
            >
              Descargar el original
            </button>
            , que es el mismo informe en HTML.
          </p>
        </section>
      )}

      <section>
        <div className="section-head">
          <h2 className="eyebrow">Archivo</h2>
        </div>
        <ul className="divide-y divide-line">
          {(reports ?? []).map((r) => {
            const parcial =
              r.params?.secciones && r.params.secciones.length < SECCIONES.length - 1
            const redaccion = redaccionDe(r.params)
            return (
              /*
                En columna en el móvil y en fila a partir de `sm`.
                Estaba en fila siempre, con la fecha en un `flex-1` y la
                etiqueta y los dos botones detrás sin dejar hueco. En un iPhone
                eso deja la columna de la fecha en unos sesenta píxeles y
                «del 9 al 23 de septiembre de 2026» sale **a palabra por línea**
                —seis renglones para una fecha—, y al pulsar empeora, porque
                «Preparando…» es más ancho que «PDF» y se come lo poco que
                quedaba.
              */
              <li
                key={r.id}
                className="flex flex-col gap-2 py-3 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-1"
              >
                <span className="font-medium sm:w-20 sm:shrink-0">{KIND_LABEL[r.kind]}</span>
                <span className="min-w-0 sm:flex-1">
                  <span className="block">
                    {nombrePeriodo({ start: r.period_start, end: r.period_end })}
                  </span>
                  <span className="block text-xs text-muted">
                    {fechaCorta(r.generated_at)}
                    {parcial && ` · ${r.params?.secciones?.length} secciones`}
                    {r.params?.nota && ` · «${r.params.nota}»`}
                  </span>
                  {/* El motivo, escrito. Un informe marcado en ámbar sin decir
                      por qué obliga a abrirlo para averiguar qué le pasó, y lo
                      que le pasó no está dentro del documento. */}
                  {redaccion?.aviso && (
                    <span className="mt-0.5 block text-xs text-warn">
                      El análisis salió calculado: {redaccion.aviso}
                    </span>
                  )}
                </span>
                {/* La etiqueta y los botones, juntos: en el móvil bajan a su
                    propia línea en vez de estrangular la fecha. */}
                <div className="flex flex-wrap items-center gap-2">
                {redaccion && (
                  <span
                    className={`shrink-0 rounded-tag px-2 py-0.5 text-[0.6875rem] font-medium ${redaccion.clase}`}
                  >
                    {redaccion.etiqueta}
                  </span>
                )}
                {hechos?.para === r.id && hechos.pdf ? (
                  <button
                    type="button"
                    onClick={() => hechos.pdf && guardar(r.id, [hechos.pdf])}
                    className="key key-accent min-h-11 px-3 text-xs"
                    title="El PDF ya está hecho: pulsa para guardarlo"
                  >
                    Guardar PDF
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={ocupado !== null}
                    onClick={() => void pdfArchivado(r)}
                    className="key key-accent min-h-11 px-3 text-xs"
                    title="El informe archivado, en PDF"
                  >
                    {ocupado?.para === r.id && ocupado.que === 'pdf' ? 'Preparando…' : 'PDF'}
                  </button>
                )}
                {hechos?.para === r.id && hechos.excel ? (
                  <button
                    type="button"
                    onClick={() => hechos.excel && guardar(r.id, [hechos.excel])}
                    className="key key-accent min-h-11 px-3 text-xs"
                    title="El Excel ya está hecho: pulsa para guardarlo"
                  >
                    Guardar Excel
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={ocupado !== null}
                    onClick={() =>
                      void hacerExcel(r.id, r.kind, { start: r.period_start, end: r.period_end })
                    }
                    className="key key-quiet min-h-11 px-3 text-xs"
                    title="El almacén de ese periodo, en Excel: stock, movimientos y stock de hoy"
                  >
                    {ocupado?.para === r.id && ocupado.que === 'excel' ? 'Preparando…' : 'Excel'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void abrir(r.storage_path)}
                  className="key key-quiet min-h-11 px-3 text-xs"
                >
                  Abrir
                </button>
                </div>
                {/* Debajo de su propia fila, no entre los botones de otra. */}
                <Aviso para={r.id} />
              </li>
            )
          })}
        </ul>

        {falloArchivo && (
          <p role="alert" className="mt-2 text-sm text-crit">
            No se ha podido leer el archivo de informes. Hace falta conexión.
          </p>
        )}

        {!falloArchivo && reports?.length === 0 && (
          <p className="mt-2 text-sm text-muted">
            Aún no hay informes archivados. Genera el primero aquí arriba.
          </p>
        )}

        {falloDescarga && (
          <p role="alert" className="mt-2 text-sm text-crit">
            {falloDescarga}
          </p>
        )}
      </section>

      {/*
        El estado del análisis con IA, al final.
        Estaba ARRIBA, entre el título y «Generar un informe»: tres párrafos
        sobre la clave de Gemini y el modelo, que es algo que se configura una
        vez. En un teléfono empujaba lo único que se viene a hacer aquí —elegir
        el periodo y generar— una pantalla entera hacia abajo, todas las veces.
      */}
      <EstadoIA />
    </div>
  )
}
