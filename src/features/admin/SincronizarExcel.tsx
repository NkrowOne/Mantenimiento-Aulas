import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { ofrecerFichero } from '@/lib/ficheros'
import { aplicarOperacion } from '@/features/rooms/maestro'
import { analizar, aplicar, dudasPendientes, escribir, lineasDelParte, replanificar } from './pasada'
import type { Analisis } from './pasada'
import { Dudas } from './Dudas'
import type { AltaDeSalaDesdeDuda } from './Dudas'
import type { Respuesta, Respuestas } from '@/domain/dudas'
import { columnaDeCampo, hojaPorNombre } from '@/domain/mapa'
import type { MovimientoPrevisto } from '@/domain/movimientos'
import type { Alta, Plan, Referencia } from '@/domain/sincronizar'
import { Seccion } from './Seccion'

/**
 * Sincronizar el Excel de SharePoint, en los dos sentidos.
 *
 * Se sube el `.xlsx`, se ve **qué pasaría antes de que pase**, se aplica lo que
 * el Excel corrige y se descarga el libro con todo lo que la aplicación sabe. El
 * viaje de vuelta a SharePoint lo hace una persona, que es lo que permite que
 * esto funcione sin pedirle permiso a nadie.
 *
 * Lo que esta pantalla promete y conviene que se lea aquí:
 *
 * **Se elige quién manda antes de subir el libro.** La fusión sabe decidir
 * casi todo sola —si solo cambió un lado, gana ese lado—, pero hay dos casos en
 * los que no puede: la primera pasada de un libro, que no tiene con qué
 * comparar, y una celda que cambió en los dos sitios. Ahí decide lo que se
 * eligió arriba: el Excel, la aplicación, o una persona más tarde. Se puede
 * cambiar con el libro ya leído y la pasada se recalcula al momento.
 *
 * **Lo que va a pasar se enseña en cuatro montones, y siempre los mismos**: lo
 * que se escribe en el Excel, lo que entra en la aplicación, lo que hay que
 * decidir y lo que se deja como está. Primero en total, luego hoja por hoja y
 * celda a celda, con de qué aula o parte es cada celda, qué dice hoy, qué va a
 * decir y por qué. Antes se veía qué entraba en la base y cuánto se escribía
 * en el libro; no qué. Y el almacén tiene su propio bloque: qué compras, qué
 * consumos y qué devoluciones va a apuntar la pasada, y qué material **no** se
 * va a descontar porque el catálogo no lo reconoce.
 *
 * **El fichero no sale de este ordenador.** Se abre, se cruza y se parchea en el
 * navegador. Lo único que viaja al servidor es el plan —qué celdas ganó el
 * Excel— y las filas leídas, que es lo que permite contestar «¿de dónde salió
 * este dato?» seis meses después.
 *
 * **Se aplica a la base antes de descargar el libro, y no al revés.** Si el
 * libro se escribiera primero y la base fallara, el fichero diría cosas que la
 * base no sabe y la pasada siguiente las volvería a meter — o las daría por
 * choque contra la aplicación.
 *
 * **El libro vuelve intacto en todo lo que no cambia.** No se regenera: se
 * reescriben las celdas que toca y el resto se copia con sus bytes. Sobreviven
 * las fórmulas, los formatos condicionales, el autofiltro, la fila inmovilizada,
 * los comentarios, la etiqueta de confidencialidad y los metadatos de SharePoint.
 *
 * **Lo que no se puede decidir no se toca, y se dice dos veces**: aquí y en la
 * hoja `Sincronización` del propio libro. Quien abre el Excel no abre la
 * aplicación, y una bandeja que nadie mira es una bandeja que en seis meses
 * tiene quinientos choques.
 *
 * **El libro se baja con su propio botón.** Antes se descargaba solo al acabar
 * la pasada, y en el iPad eso no bajaba nada: la hoja de compartir —que es la
 * que lleva a Archivos y a SharePoint— solo se abre mientras dura la pulsación,
 * y la pasada tarda segundos. Así que el libro generado se queda aquí, en
 * memoria, y se entrega al pulsar, tantas veces como haga falta. El mismo botón
 * sirve para ver cómo quedaría el libro sin tocar la base.
 *
 * **Lo que la pasada no sabe, lo pregunta antes de aplicar.** Una fila de la
 * hoja de estado con datos y sin código de aula, un parte nuevo cuya aula cruza
 * con ocho salas, un número de serie que crearía un equipo que la sala no tenía,
 * un ordenador de repuesto que la hoja de PCs lista y la aplicación no conoce:
 * salen como dudas, se contestan aquí y la pasada se recalcula con la respuesta.
 * Con dudas sin contestar no se sincroniza; ver el libro sí se puede.
 */
export function SincronizarExcel(): React.ReactElement {
  const entrada = useRef<HTMLInputElement>(null)
  const qc = useQueryClient()
  /**
   * El último libro leído, tal cual se subió. Hace falta para volver a leerlo
   * sin pedirlo otra vez: al dar de alta una sala desde una duda, la fila que
   * no cruzaba pasa a cruzar, y eso solo se sabe leyendo el libro contra la
   * base de nuevo —el análisis guarda el maestro de cuando se leyó—.
   */
  const ultimoFichero = useRef<File | null>(null)
  const [referencia, setReferencia] = useState<Referencia | null>(null)
  const [analisis, setAnalisis] = useState<Analisis | null>(null)
  const [fallo, setFallo] = useState<string | null>(null)
  const [aplicado, setAplicado] = useState<string | null>(null)
  const [libro, setLibro] = useState<LibroGenerado | null>(null)
  const [entregado, setEntregado] = useState<'compartido' | 'descargado' | null>(null)
  const [entregando, setEntregando] = useState(false)

  const leer = useMutation({
    mutationFn: ({ fichero, respuestas = {} }: { fichero: File; respuestas?: Respuestas }) => {
      ultimoFichero.current = fichero
      return analizar(fichero, new Date(), respuestas, referencia)
    },
    onSuccess: (a) => {
      setAnalisis(a)
      setFallo(null)
      setAplicado(null)
      setLibro(null)
      setEntregado(null)
    },
    onError: (e: Error) => {
      setAnalisis(null)
      setFallo(e.message)
    },
  })

  const sincronizar = useMutation({
    mutationFn: async () => {
      if (!analisis) return
      const r = await aplicar(analisis)
      // Con los números que la base puso a los partes nuevos: van a su fila.
      const bytes = await escribir(analisis, ahora(), r.parteId, r.altas)
      setLibro({ nombre: conSufijo(analisis.nombre, 'sincronizado'), bytes, sincronizado: true })
      setEntregado(null)
      return r
    },
    onSuccess: (r) => {
      if (!r) return
      const partes = r.altas.filter((x) => x.tipo === 'incidencia').length
      const nuevas = r.altas.length
      setAplicado(
        [
          r.rechazadas === 0
            ? `${r.aplicadas} celdas del Excel han entrado en la base.`
            : `${r.aplicadas} celdas han entrado y ${r.rechazadas} han ido a la bandeja de choques.`,
          nuevas > 0
            ? `${nuevas} filas nuevas del libro han entrado en la aplicación${partes > 0 ? `; los ${partes === 1 ? 'parte lleva' : `${partes} partes llevan`} ya su número en el libro` : ''}.`
            : '',
        ]
          .filter(Boolean)
          .join(' '),
      )
      setFallo(null)
    },
    onError: (e: Error) => setFallo(e.message),
  })

  /** Todo lo que vuelve a planificar deja obsoleto el libro que hubiera. */
  const volverAPlanificar = (siguiente: Analisis): void => {
    setAnalisis(siguiente)
    setLibro(null)
    setEntregado(null)
    setAplicado(null)
  }

  /** Contestar una duda es volver a planificar: no toca ni la base ni el libro. */
  const contestar = (id: string, respuesta: Respuesta | null): void => {
    if (!analisis) return
    const respuestas = { ...analisis.respuestas }
    if (respuesta === null) delete respuestas[id]
    else respuestas[id] = respuesta
    volverAPlanificar(replanificar(analisis, respuestas))
  }

  /**
   * Dar de alta una sala que la hoja de estado describe y la aplicación no
   * tiene, y volver a leer el libro con las respuestas que ya había.
   *
   * Pasa por la misma operación del maestro que el botón «+ Sala», así que la
   * sala nace con matrícula y equipamiento por defecto y el espejo local se
   * pone al día igual. Lo que cambia es lo de después: el libro se relee contra
   * la base, porque el análisis guardado no conoce la sala recién creada, y con
   * ella delante la fila cruza sola y recibe su matrícula en la pasada.
   */
  const crearSala = async (alta: AltaDeSalaDesdeDuda): Promise<void> => {
    if (!analisis) return
    await aplicarOperacion(
      { kind: 'nueva-sala', building: alta.edificioId, zone: alta.zona, code: alta.code, name: alta.code, tipo: 'aula' },
      qc,
    )
    const respuestas = { ...analisis.respuestas }
    // La duda deja de existir en cuanto la fila cruza; si por lo que sea sigue,
    // no se arrastra una respuesta vieja que ya no significa nada.
    delete respuestas[alta.dudaId]
    if (ultimoFichero.current) await leer.mutateAsync({ fichero: ultimoFichero.current, respuestas })
  }

  /** Cambiar quién manda también: con el libro ya leído, la pasada se recalcula al momento. */
  const elegirReferencia = (r: Referencia | null): void => {
    setReferencia(r)
    if (analisis) volverAPlanificar(replanificar(analisis, analisis.respuestas, r))
  }

  /**
   * El mismo libro que saldría de la pasada, sin la pasada: no entra nada en la
   * base y no se apunta como salida. Es para mirarlo, y el nombre lo dice.
   */
  const previsualizar = useMutation({
    mutationFn: async () => {
      if (!analisis) return
      const bytes = await escribir(analisis, ahora())
      setLibro({ nombre: conSufijo(analisis.nombre, 'vista previa'), bytes, sincronizado: false })
      setEntregado(null)
      setFallo(null)
    },
    onError: (e: Error) => setFallo(e.message),
  })

  /**
   * Sin `useMutation` a propósito: la hoja de compartir hay que pedirla dentro
   * de la pulsación, y `mutate` mete un turno de por medio antes de llamar.
   */
  const entregar = (): void => {
    if (!libro || entregando) return
    setEntregando(true)
    void ofrecerFichero(libro.nombre, blobDe(libro.bytes))
      .then((via) => setEntregado(via))
      .catch((e: Error) => setFallo(e.message))
      .finally(() => setEntregando(false))
  }

  const limpiar = (): void => {
    setAnalisis(null)
    setFallo(null)
    setAplicado(null)
    setLibro(null)
    setEntregado(null)
    if (entrada.current) entrada.current.value = ''
  }

  const ocupado = leer.isPending || sincronizar.isPending || previsualizar.isPending

  const total = analisis ? sumar(analisis.planes) : null
  const pendientes = analisis ? dudasPendientes(analisis).length : 0

  return (
    <Seccion
      id="sec-excel"
      titulo="Sincronizar el Excel de SharePoint"
      texto="Sube el libro y baja el mismo fichero con todo lo que la aplicación sabe: revisiones, horas, salidas de material, entradas y movimientos del almacén. Lo que hayas corregido en la hoja entra en la base. El fichero no sale de este ordenador."
      pendientes={pendientes}
      acciones={
        analisis ? (
          <button type="button" className="key key-quiet min-h-11 px-3 text-sm" onClick={limpiar}>
            Empezar de nuevo
          </button>
        ) : undefined
      }
    >
      <QuienManda referencia={referencia} disabled={ocupado} onElegir={elegirReferencia} />

      <div className="card mt-4 p-4">
        <p className="eyebrow">2 · El libro</p>
        <label htmlFor="excel-libro" className="sr-only">
          Libro de Excel de SharePoint
        </label>
        <input
          id="excel-libro"
          ref={entrada}
          type="file"
          accept=".xlsx"
          disabled={ocupado}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) leer.mutate({ fichero: f })
          }}
          className="mt-2 block w-full text-base file:mr-3 file:h-10 file:rounded-ctl file:border-0 file:bg-accent-fill file:px-4 file:font-semibold file:text-accent-ink"
        />
        <p className="mt-2 text-xs text-muted">
          {leer.isPending
            ? 'Leyendo el libro y el estado de la aplicación…'
            : 'Se miran las seis hojas del libro: estado, partes, bolsa y PCs de repuesto del año, y las dos de 2025. Nada se escribe hasta que pulses «Sincronizar».'}
        </p>
      </div>

      {fallo && <p className="mt-3 rounded-ctl bg-crit-fill p-3 text-sm text-crit-ink">{fallo}</p>}

      {analisis?.bloqueada && <Bloqueada planes={analisis.planes} />}

      {analisis && !analisis.bloqueada && analisis.libroDesconocido && (
        <div className="card mt-4 border-warn p-4">
          <h2 className="text-sm font-semibold text-warn">
            Este no es el libro que salió de la última sincronización
          </h2>
          <p className="mt-2 text-sm text-muted">
            {analisis.ultimaSalida
              ? `La última se hizo el ${new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(analisis.ultimaSalida))} y produjo un fichero distinto de éste.`
              : 'La aplicación esperaba otro fichero.'}{' '}
            Si es una copia de antes, lo que la hoja diga se tomará por una
            corrección y entrará en la base: se revertiría lo que se haya hecho en
            la aplicación desde entonces, y no daría ningún error. Mira lo que
            entraría antes de aplicar.
          </p>
        </div>
      )}

      {analisis && !analisis.bloqueada && total && (
        <>
          <Resumen analisis={analisis} total={total} />
          <Almacen movimientos={analisis.movimientos} />
          {analisis.dudas.length > 0 && (
            <Dudas
              dudas={analisis.dudas}
              respuestas={analisis.respuestas}
              catalogo={analisis.catalogo}
              onContestar={contestar}
              onCrearSala={crearSala}
            />
          )}

          <h2 className="eyebrow mt-6">4 · Hoja por hoja</h2>
          <div className="mt-2 space-y-3">
            {analisis.planes.map((p) => (
              <PorHoja key={p.hoja} plan={p} />
            ))}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="key key-accent h-11 px-4"
              disabled={ocupado || pendientes > 0}
              title={pendientes > 0 ? 'Contesta las dudas antes de sincronizar' : undefined}
              onClick={() => sincronizar.mutate()}
            >
              {sincronizar.isPending
                ? 'Sincronizando…'
                : pendientes > 0
                  ? `Sincronizar (${pendientes} ${pendientes === 1 ? 'duda' : 'dudas'} sin contestar)`
                  : 'Sincronizar'}
            </button>
            <button
              type="button"
              className="key key-quiet h-11 px-4"
              disabled={ocupado}
              onClick={() => previsualizar.mutate()}
            >
              {previsualizar.isPending ? 'Preparando el libro…' : 'Ver cómo quedaría el libro'}
            </button>
          </div>

          {aplicado && <p className="mt-3 text-sm text-ok">{aplicado}</p>}

          {libro && (
            <Entrega
              libro={libro}
              entregado={entregado}
              entregando={entregando}
              onEntregar={entregar}
            />
          )}
        </>
      )}
    </Seccion>
  )
}

// -----------------------------------------------------------------------------
// 1 · Quién manda
// -----------------------------------------------------------------------------

const OPCIONES: Array<{ id: Referencia | null; titulo: string; texto: string }> = [
  {
    id: null,
    titulo: 'Que decida una persona',
    texto: 'Sale como choque, no se toca ninguno de los dos lados y se ve aquí y en la hoja «Sincronización».',
  },
  {
    id: 'excel',
    titulo: 'Manda el Excel',
    texto: 'Lo que dice la hoja entra en la aplicación.',
  },
  {
    id: 'app',
    titulo: 'Manda la aplicación',
    texto: 'Lo que dice la aplicación se escribe en la hoja.',
  },
]

/**
 * La elección va ANTES del libro, y con número: es la primera decisión de la
 * pasada y la que más cambia lo que sale. Con el libro ya leído se puede
 * cambiar igual, y la pasada se recalcula.
 */
function QuienManda({
  referencia,
  disabled,
  onElegir,
}: {
  referencia: Referencia | null
  disabled: boolean
  onElegir: (r: Referencia | null) => void
}): React.ReactElement {
  return (
    <div className="card mt-4 p-4">
      <p className="eyebrow">1 · Quién manda</p>
      <h2 className="mt-1 text-sm font-semibold">
        Si una celda es distinta en los dos lados y no se puede saber quién la cambió
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        Pasa la primera vez que se sincroniza un libro —no hay con qué comparar— y cuando la
        misma celda cambió en el Excel y en la aplicación. Si solo cambió un lado, gana ese lado,
        se elija lo que se elija. Y las columnas con dueño fijo —los m², la fecha de revisión
        anterior, las fórmulas— no cambian de dueño.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-3" role="group" aria-label="Quién manda">
        {OPCIONES.map((o) => {
          const activa = referencia === o.id
          return (
            <button
              key={o.id ?? 'preguntar'}
              type="button"
              aria-pressed={activa}
              disabled={disabled}
              onClick={() => onElegir(o.id)}
              className={`key min-h-11 px-3 py-2 text-left text-sm ${activa ? 'key-accent' : 'key-quiet'}`}
            >
              <span className="block font-semibold">{o.titulo}</span>
              <span className={`mt-0.5 block text-xs leading-snug ${activa ? '' : 'text-muted'}`}>{o.texto}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Cómo se dice la elección, en una frase corta, donde haga falta recordarla. */
function nombreDeLaReferencia(r: Referencia | null): string {
  if (r === 'excel') return 'manda el Excel'
  if (r === 'app') return 'manda la aplicación'
  return 'decide una persona: los choques se quedan sin tocar'
}

// -----------------------------------------------------------------------------
// 3 · Qué va a pasar, en total
// -----------------------------------------------------------------------------

/** Los cuatro montones, sumados. Son los mismos cuatro que enseña cada hoja. */
interface Totales {
  alExcel: { celdas: number; filasNuevas: number; filasQueSalen: number }
  aLaApp: { celdas: number; filasNuevas: number }
  decidir: { dudas: number; choques: number; sinLeer: number }
  igual: { sinCruzar: number; avisos: number }
}

function sumar(planes: Plan[]): Totales {
  const t: Totales = {
    alExcel: { celdas: 0, filasNuevas: 0, filasQueSalen: 0 },
    aLaApp: { celdas: 0, filasNuevas: 0 },
    decidir: { dudas: 0, choques: 0, sinLeer: 0 },
    igual: { sinCruzar: 0, avisos: 0 },
  }
  for (const p of planes) {
    t.alExcel.celdas += p.haciaElExcel.length
    t.alExcel.filasNuevas += p.filasQueEntran.length
    t.alExcel.filasQueSalen += p.filasQueSalen.length
    t.aLaApp.celdas += p.haciaLaBase.length
    t.aLaApp.filasNuevas += p.altas.length
    t.decidir.dudas += p.dudas.length
    t.decidir.choques += p.conflictos.length
    t.decidir.sinLeer += p.cuarentena.length
    t.igual.sinCruzar += p.sinCruzar.length
    t.igual.avisos += p.avisos.length
  }
  return t
}

function Resumen({ analisis, total }: { analisis: Analisis; total: Totales }): React.ReactElement {
  const porDecidir = total.decidir.dudas + total.decidir.choques + total.decidir.sinLeer
  return (
    <div className="card mt-4 p-4">
      <p className="eyebrow">3 · Qué va a pasar</p>
      <p className="mt-1 text-sm">
        <span className="font-semibold">{analisis.nombre}</span>
        <span className="text-muted"> · {nombreDeLaReferencia(analisis.referencia)}</span>
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Monton tono="excel" titulo="Al Excel">
          <Cifra n={total.alExcel.celdas} que="celdas que se escriben" />
          <Cifra n={total.alExcel.filasNuevas} que="filas nuevas" />
          <Cifra n={total.alExcel.filasQueSalen} que="filas que salen" />
        </Monton>
        <Monton tono="app" titulo="A la aplicación">
          <Cifra n={total.aLaApp.celdas} que="celdas que entran" />
          <Cifra n={total.aLaApp.filasNuevas} que="filas nuevas" />
        </Monton>
        <Monton tono="decidir" titulo="Hay que decidir">
          <Cifra n={total.decidir.dudas} que="dudas" />
          <Cifra n={total.decidir.choques} que="choques" />
          <Cifra n={total.decidir.sinLeer} que="no se pueden leer" />
        </Monton>
        <Monton tono="igual" titulo="Se deja como está">
          <Cifra n={total.igual.sinCruzar} que="filas sin cruzar" />
          <Cifra n={total.igual.avisos} que="avisos" />
        </Monton>
      </div>

      {analisis.hojasNuevas.length > 0 && (
        <p className="mt-3 text-sm">
          Se crean {analisis.hojasNuevas.map((h) => `«${h.nombre}»`).join(' y ')}: ha cambiado el
          año.
        </p>
      )}
      <p className="mt-3 text-sm text-muted">
        Se rehacen además las hojas <strong>Revisiones</strong>,{' '}
        <strong>Movimientos de Almacén</strong>, <strong>Inventario por Sala</strong> y{' '}
        <strong>Sincronización</strong>, enteras, con lo que la aplicación sabe hoy.
        {analisis.hojasNuevas.some((h) => h.nombre.startsWith('PCs STOCK')) &&
          ' El libro no traía la hoja de PCs de repuesto: se estrena con lo que la aplicación sabe.'}
      </p>
      {analisis.datos.sinUnidades && (
        <p className="mt-2 text-sm text-warn">
          El servidor no tiene todavía la tabla de PCs de repuesto (falta aplicar la migración de
          septiembre): la hoja «PCs STOCK» se deja como está y el resto se sincroniza igual.
        </p>
      )}
      {porDecidir === 0 ? (
        <p className="mt-2 text-sm text-ok">Nada queda pendiente de decidir.</p>
      ) : (
        <p className="mt-2 text-sm text-warn">
          {porDecidir} cosas por decidir. Las dudas se contestan aquí abajo; los choques y lo que no
          se puede leer no se tocan en ninguno de los dos lados, y salen listados en la hoja
          «Sincronización» del libro.
        </p>
      )}
    </div>
  )
}

/** Los cuatro tonos, y siempre con la palabra delante: el color solo acompaña. */
const TONO: Record<'excel' | 'app' | 'decidir' | 'igual', string> = {
  excel: 'border-accent text-accent',
  app: 'border-ok text-ok',
  decidir: 'border-warn text-warn',
  igual: 'border-line text-muted',
}

function Monton({
  tono,
  titulo,
  children,
}: {
  tono: keyof typeof TONO
  titulo: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className={`border-l-2 pl-3 ${TONO[tono].split(' ')[0]}`}>
      <p className={`eyebrow ${TONO[tono].split(' ')[1]}`}>{titulo}</p>
      <div className="mt-1 space-y-1">{children}</div>
    </div>
  )
}

function Cifra({ n, que }: { n: number; que: string }): React.ReactElement {
  return (
    <p className={`text-sm ${n === 0 ? 'text-muted' : ''}`}>
      <span className="font-mono text-base font-semibold tabular-nums">{n}</span> {que}
    </p>
  )
}

// -----------------------------------------------------------------------------
// El almacén: lo que se va a apuntar
// -----------------------------------------------------------------------------

const TIPO_DE_MOVIMIENTO: Record<MovimientoPrevisto['tipo'], { titulo: string; tono: keyof typeof TONO; texto: string }> = {
  compra: {
    titulo: 'Compras',
    tono: 'app',
    texto: 'Entran en el almacén. La diferencia entre lo que dice «Total Comprado» y lo que la aplicación ya tenía apuntado ese año.',
  },
  consumo: {
    titulo: 'Salidas',
    tono: 'app',
    texto: 'Salen del almacén a nombre del parte, con su aula y con la fecha del parte. Solo la diferencia con lo que ese parte ya tenía descontado.',
  },
  devolucion: {
    titulo: 'Devoluciones',
    tono: 'app',
    texto: 'Vuelven al almacén: la hoja baja la cantidad, o ya no cuenta ese artículo en el parte.',
  },
  ajuste: {
    titulo: 'Ajustes al «Stock Disponible»',
    tono: 'excel',
    texto: 'Manda el Excel: lo que quede en el almacén después de compras y salidas se pone a lo que dice la hoja, con un movimiento de ajuste que deja rastro.',
  },
  sin_descontar: {
    titulo: 'Apuntado sin descontar',
    tono: 'igual',
    texto: 'Lleva un 0 delante en «Material Usado»: material reciclado, de garantía o de stock antiguo. Se guarda en el parte y no sale del almacén.',
  },
  historico: {
    titulo: 'Anteriores al recuento',
    tono: 'igual',
    texto: 'Partes de antes de que la aplicación llevara el almacén (1 de agosto de 2026). El material queda apuntado en el parte y no descuenta nada: esos meses de la bolsa son del libro.',
  },
  sin_articulo: {
    titulo: 'No se descuenta: artículo desconocido',
    tono: 'decidir',
    texto: 'El catálogo del almacén no reconoce el nombre. Se guarda el texto en el parte y no sale nada del almacén. Añade el alias en el catálogo y vuelve a subir el libro.',
  },
  no_entra: {
    titulo: 'No entra',
    tono: 'decidir',
    texto: 'La hoja dice menos compras que la aplicación. Una compra no se deshace desde una celda: va a la bandeja para que alguien mire cuál sobra.',
  },
}

function Almacen({ movimientos }: { movimientos: MovimientoPrevisto[] }): React.ReactElement {
  const grupos = (Object.keys(TIPO_DE_MOVIMIENTO) as Array<MovimientoPrevisto['tipo']>)
    .map((tipo) => ({ tipo, lista: movimientos.filter((m) => m.tipo === tipo) }))
    .filter((g) => g.lista.length > 0)
  const unidades = (lista: MovimientoPrevisto[]): number => lista.reduce((n, m) => n + m.cantidad, 0)

  return (
    <div className="card mt-4 p-4">
      <p className="eyebrow">Almacén</p>
      {grupos.length === 0 ? (
        <p className="mt-1 text-sm text-muted">El almacén no se toca en esta pasada.</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted">
            Lo que el almacén va a apuntar al sincronizar, calculado como lo calcula la base: solo
            las diferencias.
          </p>
          <div className="mt-3 space-y-4">
            {grupos.map(({ tipo, lista }) => {
              const t = TIPO_DE_MOVIMIENTO[tipo]
              return (
                <Grupo
                  key={tipo}
                  tono={t.tono}
                  titulo={`${t.titulo} (${lista.length}${lista.length !== unidades(lista) ? ` · ${unidades(lista)} unidades` : ''})`}
                  explicacion={t.texto}
                >
                  <Tabla
                    cabeceras={['Artículo', 'Unidades', 'De qué', 'Hoja · fila', 'Nota']}
                    filas={lista.map((m) => [m.articulo, String(m.cantidad), m.destino, `${m.hoja} · ${m.fila}`, m.nota])}
                  />
                </Grupo>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// 4 · Hoja por hoja
// -----------------------------------------------------------------------------

function PorHoja({ plan }: { plan: Plan }): React.ReactElement {
  const alExcel = plan.haciaElExcel.length + plan.filasQueEntran.length + plan.filasQueSalen.length
  const aLaApp = plan.haciaLaBase.length + plan.altas.length
  const decidir = plan.conflictos.length + plan.cuarentena.length + plan.dudas.length
  const igual = plan.sinCruzar.length
  const nada = alExcel + aLaApp + decidir + igual === 0 && plan.avisos.length === 0
  const hoja = hojaPorNombre(plan.hoja)
  const cabeceraDe = (campo: string): string => (hoja ? columnaDeCampo(hoja, campo)?.cabecera.trim() : undefined) ?? campo

  return (
    <details className="card p-4" open={alExcel + aLaApp + decidir > 0}>
      <summary className="cursor-pointer text-sm font-semibold">
        {plan.hoja}
        <span className="ml-2 font-normal text-muted">
          {nada
            ? 'sin cambios'
            : [
                alExcel > 0 && `${alExcel} al Excel`,
                aLaApp > 0 && `${aLaApp} a la aplicación`,
                decidir > 0 && `${decidir} por decidir`,
                igual > 0 && `${igual} se quedan como están`,
              ]
                .filter(Boolean)
                .join(' · ')}
        </span>
      </summary>

      <div className="mt-3 space-y-5">
        {alExcel > 0 && (
          <Grupo
            tono="excel"
            titulo={`Al Excel (${alExcel})`}
            explicacion="Lo que la aplicación escribe en esta hoja. Nada de esto toca la base."
          >
            {plan.haciaElExcel.length > 0 && (
              <Subgrupo titulo={`Celdas (${plan.haciaElExcel.length})`}>
                <Tabla
                  cabeceras={['Celda', 'De qué', 'Columna', 'Dice hoy', 'Pasará a decir', 'Por qué']}
                  filas={plan.haciaElExcel.map((h) => [
                    `${h.letra}${h.fila}`,
                    h.destino,
                    h.cabecera,
                    texto(h.antes),
                    texto(h.valor),
                    h.motivo,
                  ])}
                />
              </Subgrupo>
            )}
            {plan.filasQueEntran.length > 0 && (
              <Subgrupo titulo={`Filas nuevas (${plan.filasQueEntran.length})`}>
                <Tabla
                  cabeceras={['Qué', 'Cuál', 'Dónde']}
                  filas={plan.filasQueEntran.map((f) => [f.que, f.destino, f.donde])}
                />
              </Subgrupo>
            )}
            {plan.filasQueSalen.length > 0 && (
              <Subgrupo titulo={`Filas que salen (${plan.filasQueSalen.length})`}>
                <Tabla
                  cabeceras={['Fila', 'Cuál', 'Por qué']}
                  filas={plan.filasQueSalen.map((f) => [String(f.fila), f.destino, f.motivo])}
                />
              </Subgrupo>
            )}
          </Grupo>
        )}

        {aLaApp > 0 && (
          <Grupo
            tono="app"
            titulo={`A la aplicación (${aLaApp})`}
            explicacion="Lo que se corrigió en la hoja y entra en la base. Queda anotado, celda a celda, como corrección hecha desde el Excel."
          >
            {plan.haciaLaBase.length > 0 && (
              <Subgrupo titulo={`Celdas (${plan.haciaLaBase.length})`}>
                <Tabla
                  cabeceras={['Celda', 'De qué', 'Columna', 'Valor', 'Por qué']}
                  filas={plan.haciaLaBase.map((h) => [
                    `${h.letra}${h.fila}`,
                    h.destino,
                    cabeceraDe(h.campo),
                    texto(h.valor),
                    h.motivo,
                  ])}
                />
              </Subgrupo>
            )}
            {plan.altas.length > 0 && (
              <Subgrupo titulo={`Filas del libro que entran como nuevas (${plan.altas.length})`}>
                <p className="mb-2 text-xs text-muted">
                  Estaban en el libro y la aplicación no las tenía. A un parte le pone número la base,
                  y el número vuelve a su fila.
                </p>
                <Tabla
                  cabeceras={['Fila', 'Qué', 'Detalle']}
                  filas={plan.altas.map((a) => [String(a.fila), queEs(a), describirAlta(a)])}
                />
              </Subgrupo>
            )}
          </Grupo>
        )}

        {decidir > 0 && (
          <Grupo
            tono="decidir"
            titulo={`Hay que decidir (${decidir})`}
            explicacion="No se toca ninguno de los dos lados hasta que alguien decida."
          >
            {plan.dudas.length > 0 && (
              <p className="text-sm">
                {plan.dudas.length} {plan.dudas.length === 1 ? 'duda' : 'dudas'} de esta hoja: se
                contestan arriba, en el bloque de dudas.
              </p>
            )}
            {plan.conflictos.length > 0 && (
              <Subgrupo titulo={`Choques (${plan.conflictos.length})`}>
                <p className="mb-2 text-xs text-muted">
                  Los dos lados cambiaron desde la última sincronización, y a cosas distintas. Elige
                  arriba quién manda o resuélvelos a mano en uno de los dos sitios.
                </p>
                <Tabla
                  cabeceras={['Celda', 'De qué', 'Columna', 'Dice la aplicación', 'Dice la hoja']}
                  filas={plan.conflictos.map((c) => [
                    `${c.letra}${c.fila}`,
                    c.destino,
                    cabeceraDe(c.campo),
                    texto(c.base),
                    texto(c.excel),
                  ])}
                />
              </Subgrupo>
            )}
            {plan.cuarentena.length > 0 && (
              <Subgrupo titulo={`No se pueden leer (${plan.cuarentena.length})`}>
                <p className="mb-2 text-xs text-muted">
                  Ni entran en la base ni se pisan en la hoja. Un cero inventado en la columna de
                  lámparas mandaría a alguien a un aula que está perfectamente.
                </p>
                <Tabla
                  cabeceras={['Celda', 'De qué', 'Columna', 'Dice', 'Por qué']}
                  filas={plan.cuarentena.map((q) => [
                    `${q.letra}${q.fila}`,
                    q.destino,
                    cabeceraDe(q.campo),
                    texto(q.crudo),
                    q.motivo,
                  ])}
                />
              </Subgrupo>
            )}
          </Grupo>
        )}

        {(igual > 0 || plan.avisos.length > 0) && (
          <Grupo
            tono="igual"
            titulo={`Se deja como está${igual > 0 ? ` (${igual})` : ''}`}
            explicacion="Filas que no se han podido emparejar con nada de la aplicación, y lo que la pasada decide por su cuenta. Nada de esto cambia."
          >
            {plan.sinCruzar.length > 0 && (
              <Subgrupo titulo={`Filas sin cruzar (${plan.sinCruzar.length})`}>
                <Tabla
                  cabeceras={['Fila', 'Por qué']}
                  filas={plan.sinCruzar.map((s) => [String(s.fila), s.motivo])}
                />
              </Subgrupo>
            )}
            {plan.avisos.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-xs font-semibold text-muted">
                  Avisos ({plan.avisos.length}): lo que la pasada hace o cuenta por su cuenta
                </summary>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                  {plan.avisos.map((a, i) => (
                    <li key={`${i}-${a.slice(0, 40)}`}>{a}</li>
                  ))}
                </ul>
              </details>
            )}
          </Grupo>
        )}
      </div>
    </details>
  )
}

/** Un montón dentro de una hoja: el filete de color a la izquierda es el mismo que arriba. */
function Grupo({
  tono,
  titulo,
  explicacion,
  children,
}: {
  tono: keyof typeof TONO
  titulo: string
  explicacion: string
  children: React.ReactNode
}): React.ReactElement {
  const [borde, color] = TONO[tono].split(' ')
  return (
    <div className={`border-l-2 pl-3 ${borde}`}>
      <h3 className={`text-sm font-semibold ${color}`}>{titulo}</h3>
      {explicacion && <p className="mt-0.5 text-xs text-muted">{explicacion}</p>}
      <div className="mt-2 space-y-3">{children}</div>
    </div>
  )
}

function Subgrupo({ titulo, children }: { titulo: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div>
      <h4 className="text-xs font-semibold">{titulo}</h4>
      <div className="mt-1">{children}</div>
    </div>
  )
}

// -----------------------------------------------------------------------------

/** El libro que ha salido de la pasada, esperando a que alguien lo baje. */
interface LibroGenerado {
  nombre: string
  bytes: Uint8Array
  /** Si entró en la base antes de escribirse. Si no, es una vista previa. */
  sincronizado: boolean
}

/**
 * El botón de bajar el libro. Es un botón y no una descarga automática porque
 * en iOS la hoja de compartir solo se abre desde la pulsación, y es la única
 * forma de que el fichero llegue a Archivos o a SharePoint desde el iPad.
 */
function Entrega({
  libro,
  entregado,
  entregando,
  onEntregar,
}: {
  libro: LibroGenerado
  entregado: 'compartido' | 'descargado' | null
  entregando: boolean
  onEntregar: () => void
}): React.ReactElement {
  const que = libro.sincronizado ? 'el libro' : 'la vista previa'
  return (
    <div className="card mt-4 p-4">
      <h2 className="text-sm font-semibold">
        {libro.sincronizado ? 'El libro está listo' : 'La vista previa está lista'}
      </h2>
      <p className="mt-1 text-sm text-muted">
        {libro.sincronizado
          ? 'Lleva todo lo que la aplicación sabe. Súbelo a SharePoint sustituyendo el original.'
          : 'Es cómo quedaría el libro. No ha tocado la base, y no es el que hay que subir a SharePoint: para eso, sincroniza.'}
      </p>
      <button
        type="button"
        className="key key-accent mt-3 h-11 px-4"
        disabled={entregando}
        onClick={onEntregar}
      >
        {entregando ? 'Entregando…' : `Descargar ${que}`}
      </button>
      <p className="mt-2 text-xs text-muted">{libro.nombre}</p>
      {entregado && (
        <p className="mt-2 text-sm text-ok">
          {entregado === 'compartido'
            ? `Compartid${libro.sincronizado ? 'o' : 'a'}.`
            : `Descargad${libro.sincronizado ? 'o' : 'a'}.`}{' '}
          {libro.sincronizado
            ? 'Súbelo a SharePoint sustituyendo el original.'
            : 'Si te convence, pulsa «Sincronizar» y baja el libro de verdad.'}
        </p>
      )}
    </div>
  )
}

function Bloqueada({ planes }: { planes: Plan[] }): React.ReactElement {
  const fuera = planes.flatMap((p) => p.desajustes.map((d) => ({ hoja: p.hoja, ...d })))
  return (
    <div className="card mt-4 border-crit p-4">
      <h2 className="text-sm font-semibold text-crit">
        Una hoja no tiene la forma que la aplicación espera
      </h2>
      <p className="mt-2 text-sm text-muted">
        La pasada no empieza. Una columna insertada mueve todas las de su derecha, y escribir sin
        comprobarlo pondría cientos de números de serie en la columna de al lado sin que saltara
        nada. Corrige la cabecera en el libro o avisa de que la hoja ha cambiado.
      </p>
      <Tabla
        cabeceras={['Hoja', 'Columna', 'Debería decir', 'Dice']}
        filas={fuera.map((f) => [f.hoja, f.letra, f.esperada, f.encontrada || '(vacía)'])}
      />
    </div>
  )
}

/**
 * Una tabla que empieza corta y se abre entera si se pide.
 *
 * Se enseñan las primeras filas y se dice cuántas quedan: una tabla de 276 filas
 * dentro de una pantalla de administración no la lee nadie de una vez, y hacerla
 * scroll infinito esconde el resumen, que es lo que de verdad hay que mirar. Pero
 * «y 251 más» sin forma de verlas era esconder justo lo que se venía a
 * comprobar: el botón las abre todas.
 */
function Tabla({
  cabeceras,
  filas,
  tope = 25,
}: {
  cabeceras: string[]
  filas: string[][]
  tope?: number
}): React.ReactElement {
  const [todas, setTodas] = useState(false)
  const visibles = todas ? filas : filas.slice(0, tope)
  return (
    <div className="scroll-x">
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            {cabeceras.map((c) => (
              <th key={c} className="eyebrow pb-1 pr-4">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visibles.map((f, i) => (
            <tr key={`${f[0]}-${i}`} className="border-t border-hair">
              {f.map((v, j) => (
                <td key={j} className="py-1 pr-4 align-top">
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {filas.length > tope && (
        <button
          type="button"
          className="key key-quiet mt-2 h-9 px-3 text-xs"
          onClick={() => setTodas((v) => !v)}
        >
          {todas ? `Ver solo las ${tope} primeras` : `Ver las ${filas.length} (quedan ${filas.length - tope} más)`}
        </button>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------

function queEs(a: Alta): string {
  if (a.tipo === 'incidencia') return 'Parte'
  if (a.tipo === 'articulo') return 'Artículo del almacén'
  return 'Ordenador de repuesto'
}

function describirAlta(a: Alta): string {
  if (a.tipo === 'incidencia') {
    return `${a.aula || 'sin aula'} · ${a.abierta ?? 'sin fecha'} · ${a.problema}${a.numero ? ` · ${a.numero}` : ''}`
  }
  if (a.tipo === 'articulo') return `${a.nombre}${a.comprado !== null ? ` · ${a.comprado} comprados` : ''}`
  return `${[a.articulo, a.marca, a.modelo].filter(Boolean).join(' ')} · ${a.serial}`
}

function texto(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(vacío)'
  if (typeof v === 'boolean') return v ? 'SÍ' : 'NO'
  return String(v)
}

function ahora(): string {
  return new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(),
  )
}

/**
 * El nombre lleva sufijo a propósito: el fichero que se sube a SharePoint lo
 * elige una persona, y sobreescribir el original sin querer desde la carpeta de
 * descargas es la clase de accidente que no se deshace. Y una vista previa que
 * se llame igual que el libro bueno acaba subida en su lugar.
 */
function conSufijo(nombre: string, sufijo: string): string {
  return `${nombre.replace(/\.xlsx$/i, '')} (${sufijo}).xlsx`
}

function blobDe(bytes: Uint8Array): Blob {
  // `Uint8Array` sobre un `ArrayBuffer` normal: el tipo de Blob no acepta los
  // respaldados por `SharedArrayBuffer`.
  return new Blob([bytes as unknown as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

export { lineasDelParte }
