import { useMutation } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { ofrecerFichero } from '@/lib/ficheros'
import { analizar, aplicar, escribir, lineasDelParte } from './pasada'
import type { Analisis } from './pasada'
import type { Plan, Resumen as ResumenDeHoja } from '@/domain/sincronizar'

/**
 * Sincronizar el Excel de SharePoint, en los dos sentidos.
 *
 * Se sube el `.xlsx`, se ve **qué pasaría antes de que pase**, se aplica lo que
 * el Excel corrige y se descarga el libro con todo lo que la aplicación sabe. El
 * viaje de vuelta a SharePoint lo hace una persona, que es lo que permite que
 * esto funcione sin pedirle permiso a nadie.
 *
 * Cuatro cosas que esta pantalla promete y conviene que se lean aquí:
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
 */
export function SincronizarExcel(): React.ReactElement {
  const entrada = useRef<HTMLInputElement>(null)
  const [analisis, setAnalisis] = useState<Analisis | null>(null)
  const [fallo, setFallo] = useState<string | null>(null)
  const [aplicado, setAplicado] = useState<string | null>(null)
  const [libro, setLibro] = useState<LibroGenerado | null>(null)
  const [entregado, setEntregado] = useState<'compartido' | 'descargado' | null>(null)
  const [entregando, setEntregando] = useState(false)

  const leer = useMutation({
    mutationFn: (fichero: File) => analizar(fichero),
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
      const bytes = await escribir(analisis, ahora(), r.parteId)
      setLibro({ nombre: conSufijo(analisis.nombre, 'sincronizado'), bytes, sincronizado: true })
      setEntregado(null)
      return r
    },
    onSuccess: (r) => {
      if (!r) return
      setAplicado(
        r.rechazadas === 0
          ? `${r.aplicadas} celdas del Excel han entrado en la base.`
          : `${r.aplicadas} celdas han entrado y ${r.rechazadas} han ido a la bandeja de choques.`,
      )
      setFallo(null)
    },
    onError: (e: Error) => setFallo(e.message),
  })

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

  const total = analisis ? sumar(analisis.resumenes) : null

  return (
    <section>
      <h1 className="text-xl font-semibold">Sincronizar el Excel de SharePoint</h1>
      <p className="mt-1 text-sm text-muted">
        Sube el libro y baja el mismo fichero con todo lo que la aplicación sabe: revisiones,
        horas, salidas de material, entradas y movimientos del almacén. Lo que hayas corregido en
        la hoja entra en la base. El fichero no sale de este ordenador.
      </p>

      <div className="card mt-4 p-4">
        <input
          ref={entrada}
          type="file"
          accept=".xlsx"
          disabled={ocupado}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) leer.mutate(f)
          }}
          className="block w-full text-base file:mr-3 file:h-10 file:rounded-ctl file:border-0 file:bg-accent-fill file:px-4 file:font-semibold file:text-accent-ink"
        />
        <p className="mt-2 text-xs text-muted">
          {leer.isPending
            ? 'Leyendo el libro y el estado de la aplicación…'
            : 'Se miran las cinco hojas del libro.'}
        </p>
      </div>

      {fallo && <p className="mt-3 rounded-ctl bg-crit-fill p-3 text-sm text-crit-ink">{fallo}</p>}

      {analisis?.bloqueada && <Bloqueada planes={analisis.planes} />}

      {analisis && !analisis.bloqueada && analisis.libroDesconocido && (
        <div className="card mt-4 border-warn p-4">
          <h2 className="text-sm font-semibold text-warn-ink">
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
          <Cabecera analisis={analisis} total={total} />
          <div className="mt-4 space-y-3">
            {analisis.planes.map((p, i) => (
              <PorHoja key={p.hoja} plan={p} resumen={analisis.resumenes[i]!} />
            ))}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="key key-accent h-11 px-4"
              disabled={ocupado}
              onClick={() => sincronizar.mutate()}
            >
              {sincronizar.isPending ? 'Sincronizando…' : 'Sincronizar'}
            </button>
            <button
              type="button"
              className="key key-quiet h-11 px-4"
              disabled={ocupado}
              onClick={() => previsualizar.mutate()}
            >
              {previsualizar.isPending ? 'Preparando el libro…' : 'Ver cómo quedaría el libro'}
            </button>
            <button type="button" className="key key-quiet h-11 px-4" onClick={limpiar}>
              Empezar de nuevo
            </button>
          </div>

          {aplicado && <p className="mt-3 text-sm text-ok-ink">{aplicado}</p>}

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
    </section>
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
        <p className="mt-2 text-sm text-ok-ink">
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
      <h2 className="text-sm font-semibold text-crit-ink">
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

function Cabecera({
  analisis,
  total,
}: {
  analisis: Analisis
  total: ReturnType<typeof sumar>
}): React.ReactElement {
  const pendientes = total.conflictos + total.cuarentena
  return (
    <div className="card mt-4 p-4">
      <p className="eyebrow">{analisis.nombre}</p>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Cifra n={total.celdasAlExcel} que="celdas al Excel" />
        <Cifra n={total.celdasALaBase} que="celdas a la base" />
        <Cifra n={total.filasNuevas} que="filas nuevas" />
        <Cifra n={total.filasBorradas} que="filas que salen" />
      </div>
      {analisis.hojasNuevas.length > 0 && (
        <p className="mt-3 text-sm">
          Se crean {analisis.hojasNuevas.map((h) => `«${h.nombre}»`).join(' y ')}: ha cambiado el
          año.
        </p>
      )}
      <p className="mt-3 text-sm text-muted">
        Se añaden además las hojas <strong>Revisiones</strong>,{' '}
        <strong>Movimientos de Almacén</strong>, <strong>Inventario por Sala</strong> y{' '}
        <strong>Sincronización</strong>, que se rehacen enteras en cada pasada.
      </p>
      {pendientes === 0 ? (
        <p className="mt-2 text-sm text-ok-ink">Nada queda pendiente de decidir.</p>
      ) : (
        <p className="mt-2 text-sm text-warn-ink">
          {pendientes} celdas quedan sin decidir. No se toca ninguno de los dos lados, y salen
          listadas en la hoja «Sincronización» del libro.
        </p>
      )}
    </div>
  )
}

function Cifra({ n, que }: { n: number; que: string }): React.ReactElement {
  return (
    <div>
      <p className="text-2xl font-semibold tabular-nums">{n}</p>
      <p className="text-xs text-muted">{que}</p>
    </div>
  )
}

function PorHoja({ plan, resumen }: { plan: Plan; resumen: ResumenDeHoja }): React.ReactElement {
  const nada =
    resumen.celdasAlExcel === 0 &&
    resumen.celdasALaBase === 0 &&
    resumen.filasNuevas === 0 &&
    resumen.filasBorradas === 0 &&
    resumen.conflictos === 0 &&
    resumen.cuarentena === 0 &&
    resumen.sinCruzar === 0

  return (
    <details className="card p-4" open={resumen.conflictos + resumen.cuarentena > 0}>
      <summary className="cursor-pointer text-sm font-semibold">
        {plan.hoja}
        <span className="ml-2 font-normal text-muted">
          {nada
            ? 'sin cambios'
            : [
                resumen.celdasAlExcel > 0 && `${resumen.celdasAlExcel} al Excel`,
                resumen.celdasALaBase > 0 && `${resumen.celdasALaBase} a la base`,
                resumen.filasNuevas > 0 && `${resumen.filasNuevas} filas nuevas`,
                resumen.filasBorradas > 0 && `${resumen.filasBorradas} salen`,
                resumen.conflictos > 0 && `${resumen.conflictos} choques`,
                resumen.cuarentena > 0 && `${resumen.cuarentena} sin leer`,
              ]
                .filter(Boolean)
                .join(' · ')}
        </span>
      </summary>

      <div className="mt-3 space-y-4">
        {plan.conflictos.length > 0 && (
          <Bloque
            titulo={`Choques (${plan.conflictos.length})`}
            explicacion="Los dos lados cambiaron desde la última sincronización y a cosas distintas. No se toca ninguno: decide una persona."
          >
            <Tabla
              cabeceras={['Celda', 'Dónde', 'Dice la aplicación', 'Dice la hoja']}
              filas={plan.conflictos.map((c) => [
                `${c.letra}${c.fila}`,
                c.destino,
                texto(c.base),
                texto(c.excel),
              ])}
            />
          </Bloque>
        )}

        {plan.cuarentena.length > 0 && (
          <Bloque
            titulo={`No se pueden leer (${plan.cuarentena.length})`}
            explicacion="Ni entran en la base ni se pisan en la hoja. Un cero inventado en la columna de lámparas mandaría a alguien a un aula que está perfectamente."
          >
            <Tabla
              cabeceras={['Celda', 'Dónde', 'Dice', 'Por qué']}
              filas={plan.cuarentena.map((q) => [
                `${q.letra}${q.fila}`,
                q.destino,
                texto(q.crudo),
                q.motivo,
              ])}
            />
          </Bloque>
        )}

        {plan.sinCruzar.length > 0 && (
          <Bloque
            titulo={`Filas sin cruzar (${plan.sinCruzar.length})`}
            explicacion="No se han podido emparejar con nada de la aplicación. Se dejan exactamente como están."
          >
            <Tabla
              cabeceras={['Fila', 'Por qué']}
              filas={plan.sinCruzar.map((s) => [String(s.fila), s.motivo])}
            />
          </Bloque>
        )}

        {plan.haciaLaBase.length > 0 && (
          <Bloque
            titulo={`Entran en la base (${plan.haciaLaBase.length})`}
            explicacion="Lo que se corrigió en la hoja y la aplicación no había tocado."
          >
            <Tabla
              cabeceras={['Celda', 'Dónde', 'Qué', 'Valor', 'Por qué']}
              filas={plan.haciaLaBase.map((h) => [
                `${h.letra}${h.fila}`,
                h.destino,
                h.campo,
                texto(h.valor),
                h.motivo,
              ])}
            />
          </Bloque>
        )}

        {plan.avisos.length > 0 && (
          <Bloque titulo={`Avisos (${plan.avisos.length})`} explicacion="">
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {plan.avisos.slice(0, 25).map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
            {plan.avisos.length > 25 && (
              <p className="mt-2 text-xs text-muted">y {plan.avisos.length - 25} más.</p>
            )}
          </Bloque>
        )}
      </div>
    </details>
  )
}

function Bloque({
  titulo,
  explicacion,
  children,
}: {
  titulo: string
  explicacion: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div>
      <h3 className="text-sm font-semibold">{titulo}</h3>
      {explicacion && <p className="mt-1 text-xs text-muted">{explicacion}</p>}
      <div className="mt-2">{children}</div>
    </div>
  )
}

function Tabla({
  cabeceras,
  filas,
}: {
  cabeceras: string[]
  filas: string[][]
}): React.ReactElement {
  // Se enseñan las primeras y se dice cuántas quedan: una tabla de 276 filas
  // dentro de una pantalla de administración no la lee nadie, y hacerla scroll
  // infinito esconde el resumen, que es lo que de verdad hay que mirar.
  const tope = 25
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
          {filas.slice(0, tope).map((f, i) => (
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
        <p className="mt-2 text-xs text-muted">y {filas.length - tope} más.</p>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------

function sumar(resumenes: ResumenDeHoja[]): {
  celdasAlExcel: number
  celdasALaBase: number
  filasNuevas: number
  filasBorradas: number
  conflictos: number
  cuarentena: number
} {
  return resumenes.reduce(
    (a, r) => ({
      celdasAlExcel: a.celdasAlExcel + r.celdasAlExcel,
      celdasALaBase: a.celdasALaBase + r.celdasALaBase,
      filasNuevas: a.filasNuevas + r.filasNuevas,
      filasBorradas: a.filasBorradas + r.filasBorradas,
      conflictos: a.conflictos + r.conflictos,
      cuarentena: a.cuarentena + r.cuarentena,
    }),
    {
      celdasAlExcel: 0,
      celdasALaBase: 0,
      filasNuevas: 0,
      filasBorradas: 0,
      conflictos: 0,
      cuarentena: 0,
    },
  )
}

function texto(v: unknown): string {
  if (v === null || v === undefined) return '(vacío)'
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
