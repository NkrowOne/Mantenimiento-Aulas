import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Role } from '@/domain/types'
import { fechaCorta } from '@/domain/fechas'
import { EstadoIA, useEstadoIA } from './EstadoIA'
import { AUDIENCIAS, POR_DEFECTO, SECCIONES } from './secciones'
import { type Eleccion, motivoParaNoPedir } from './peticion'
import {
  type Kind,
  type Rango,
  PRESETS,
  diasDelRango,
  hoyEnMadrid,
  nombrePeriodo,
} from './periodos'
import {
  type InformeGenerado,
  type Paso,
  generarInforme,
  nombreDeArchivo,
} from './informe/generar'
import { descargarDocumento, imprimirMarco } from './informe/imprimir'

interface ReportRow {
  id: string
  kind: Kind
  period_start: string
  period_end: string
  storage_path: string
  generated_at: string
  params: {
    ia?: boolean
    analisis?: string
    secciones?: string[]
    audiencia?: string
    nota?: string
  } | null
}

const KIND_LABEL: Record<Kind, string> = {
  diario: 'Diario',
  semanal: 'Semanal',
  personalizado: 'A medida',
}

const PASOS: Record<Paso, string> = {
  datos: 'Leyendo los datos del periodo…',
  analisis: 'Calculando las cifras y redactando el análisis…',
  documento: 'Componiendo el documento…',
  archivo: 'Guardándolo en el archivo…',
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
 * El PDF lo hace el navegador: el documento está maquetado para A4 y «Guardar
 * como PDF» es un destino de impresión más. Eso ahorra media librería en el
 * arranque de una aplicación que se abre desde un iPad en un pasillo.
 *
 * Un informe emitido **no se regenera nunca**: se versiona. Si los datos cambian
 * después, el documento del viernes tiene que seguir diciendo lo que decía el
 * viernes, o deja de servir como registro. De ahí que aquí no haya ningún botón
 * de «actualizar»: se emite otro y los dos quedan en el archivo.
 */
export function ReportsPage({ role }: { role: Role }): React.ReactElement {
  const hoy = hoyEnMadrid()
  const qc = useQueryClient()

  const [preset, setPreset] = useState<string>('semana')
  const [desde, setDesde] = useState('')
  const [hasta, setHasta] = useState('')
  const [secciones, setSecciones] = useState<string[]>(POR_DEFECTO)
  const [comparar, setComparar] = useState(true)
  const [conIA, setConIA] = useState(true)
  const [audiencia, setAudiencia] = useState<'direccion' | 'equipo'>('direccion')
  const [enfoque, setEnfoque] = useState('')
  const [nota, setNota] = useState('')
  const [ajustes, setAjustes] = useState(false)

  const [paso, setPaso] = useState<Paso | null>(null)
  const [recien, setRecien] = useState<InformeGenerado | null>(null)
  /* El fallo de una descarga, a la vista. `createSignedUrl` puede denegar por
     permisos o red, y descartarlo dejaba el botón «Abrir» como un botón que a
     veces no hace nada. */
  const [falloDescarga, setFalloDescarga] = useState<string | null>(null)

  const marco = useRef<HTMLIFrameElement>(null)

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
      return generarInforme(eleccion, setPaso)
    },
    onSettled: () => setPaso(null),
    onSuccess: (informe) => {
      setRecien(informe)
      // El archivo acaba de cambiar, y la tarjeta de la IA también: la
      // procedencia del último informe es justo lo que enseña.
      void qc.invalidateQueries({ queryKey: ['reports'] })
      void qc.invalidateQueries({ queryKey: ['ia-estado'] })
    },
  })

  async function abrir(path: string): Promise<void> {
    setFalloDescarga(null)
    const { data, error } = await supabase.storage.from('reports').createSignedUrl(path, 60)
    if (error || !data?.signedUrl) {
      setFalloDescarga(`No se ha podido preparar la descarga${error ? `: ${error.message}` : ''}.`)
      return
    }
    // Si el navegador bloquea la pestaña —el gesto caducó mientras se firmaba
    // la URL— se dice, en vez de fingir que el botón no hizo nada.
    const abierta = window.open(data.signedUrl, '_blank', 'noopener')
    if (!abierta) setFalloDescarga('El navegador ha bloqueado la pestaña: vuelve a pulsar Abrir.')
  }

  const alternar = (clave: string): void =>
    setSecciones((s) => (s.includes(clave) ? s.filter((x) => x !== clave) : [...s, clave]))

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4">
      <header>
        <h1 className="text-xl font-semibold">Informes</h1>
        <p className="mt-1 text-sm text-muted">
          El informe se arma aquí mismo con los datos del periodo que elijas, y sale listo para
          imprimir o guardar como PDF. Queda archivado, y un informe emitido no se regenera: se
          emite otro y los dos quedan.
        </p>
      </header>

      <EstadoIA esAdmin={role === 'admin'} />

      <section className="card p-4">
        <h2 className="font-semibold">Generar un informe</h2>

        {/* ── Periodo ── */}
        <div className="mt-3">
          <span className="eyebrow">Periodo</span>
          <div className="mt-2 flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPreset(p.id)}
                aria-pressed={preset === p.id}
                className={`key min-h-11 px-3 text-sm ${
                  preset === p.id ? 'key-accent' : 'key-quiet'
                }`}
              >
                {p.etiqueta}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPreset('medida')}
              aria-pressed={preset === 'medida'}
              className={`key min-h-11 px-3 text-sm ${
                preset === 'medida' ? 'key-accent' : 'key-quiet'
              }`}
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
          className="key key-quiet mt-4 min-h-11 px-3 text-sm"
        >
          {ajustes ? 'Ocultar los ajustes' : 'Ajustar qué lleva'}
          <span className="ml-2 text-muted">
            {secciones.length} de {SECCIONES.length} secciones
            {conIA ? ' · con IA' : ' · sin IA'}
          </span>
        </button>

        {ajustes && (
          <div className="mt-4 space-y-5 border-t border-line pt-4">
            <fieldset>
              <legend className="eyebrow">Secciones</legend>
              <div className="mt-2 grid gap-1 sm:grid-cols-2">
                {SECCIONES.map((s) => (
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
                  onClick={() => setSecciones(SECCIONES.map((s) => s.clave))}
                  className="text-accent underline"
                >
                  Todas
                </button>
                <button
                  type="button"
                  onClick={() => setSecciones(POR_DEFECTO)}
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
                <div className="mt-1 flex flex-wrap gap-2">
                  {AUDIENCIAS.map((a) => (
                    <button
                      key={a.clave}
                      type="button"
                      onClick={() => setAudiencia(a.clave)}
                      aria-pressed={audiencia === a.clave}
                      className={`key min-h-11 px-3 text-sm ${
                        audiencia === a.clave ? 'key-accent' : 'key-quiet'
                      }`}
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

              <label className="mt-4 block text-sm">
                <span className="text-muted">En qué quieres que se fije (opcional)</span>
                <input
                  type="text"
                  value={enfoque}
                  maxLength={400}
                  onChange={(e) => setEnfoque(e.target.value)}
                  placeholder="Céntrate en el edificio H y en el consumo de cable"
                  className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-sm"
                />
                <span className="mt-1 block text-xs text-muted">
                  Va a la redacción del análisis. No cambia ninguna cifra.
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
                  className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-sm"
                />
                <span className="mt-1 block text-xs text-muted">
                  Se imprime tal cual, bajo el título. No pasa por la IA.
                </span>
              </label>
            </fieldset>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={impedimento !== null || generar.isPending}
            onClick={() => generar.mutate()}
            className="key key-accent min-h-11 px-4 text-sm"
          >
            {generar.isPending ? 'Generando…' : 'Generar'}
          </button>
          {/* El motivo, a la vista: un botón apagado sin explicación deja a quien
              lo mira buscando qué le falta. */}
          {impedimento && <span className="text-sm text-muted">{impedimento}</span>}
        </div>

        {/* En qué paso va. No es decoración: con IA la espera pasa del medio
            minuto, y una barra que no dice nada se lee como una pantalla
            colgada. */}
        {generar.isPending && (
          <p className="mt-3 text-sm text-muted" role="status">
            {paso ? PASOS[paso] : 'Preparando…'}
            {paso === 'analisis' && conIA && ' Con IA suele tardar entre veinte segundos y un minuto.'}
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
        <section className="card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-semibold">
                Listo: {KIND_LABEL[recien.kind as Kind]}, {recien.periodoTexto}
              </h2>
              <p className="mt-1 text-sm text-muted">
                {recien.conIA
                  ? 'El análisis lo ha redactado la IA. Las cifras no salen de ahí: se calculan con los datos.'
                  : 'Con el análisis calculado a partir de los datos.'}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  if (!imprimirMarco(marco.current)) {
                    setFalloDescarga('La vista previa aún no está lista: espera un segundo y vuelve a pulsar.')
                  }
                }}
                className="key key-accent min-h-11 px-3 text-sm"
              >
                Guardar como PDF
              </button>
              <button
                type="button"
                onClick={() => descargarDocumento(recien.html, nombreDeArchivo(recien.kind, recien.rango))}
                className="key key-quiet min-h-11 px-3 text-sm"
              >
                Descargar
              </button>
            </div>
          </div>

          {/* Lo que no ha salido como se pidió, dicho. Que el análisis venga
              calculado cuando se marcó «con IA» no es un detalle: quien lo pidió
              tiene que saber por qué, y casi siempre se arregla en un minuto. */}
          {recien.avisoIA && (
            <p className="mt-3 rounded-ctl border border-warn/40 bg-warn-tint p-3 text-sm text-warn">
              El análisis ha salido calculado y no redactado por la IA: {recien.avisoIA}.
            </p>
          )}

          {recien.motivoArchivo && (
            <p role="alert" className="mt-3 rounded-ctl border border-warn/40 bg-warn-tint p-3 text-sm text-warn">
              El informe está hecho, pero {recien.motivoArchivo}. Descárgalo para no perderlo.
            </p>
          )}

          {/*
            La vista previa, en un marco aislado.
            El documento trae sus propios estilos de página —cuerpos en puntos,
            márgenes en milímetros— y soltarlos en la aplicación repintaría media
            pantalla. Sin `allow-scripts`: el informe no lleva ni una línea de
            JavaScript y así se queda.
          */}
          <iframe
            ref={marco}
            title={`Informe · ${recien.periodoTexto}`}
            srcDoc={recien.html}
            sandbox="allow-same-origin allow-modals"
            className="mt-4 h-[70vh] w-full rounded-card border border-line bg-white"
          />
          <p className="mt-2 text-xs text-muted">
            «Guardar como PDF» abre la impresión del navegador: elige ese destino y sale el documento
            en A4.
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
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-sm">
                <span className="w-20 shrink-0 font-medium">{KIND_LABEL[r.kind]}</span>
                <span className="min-w-0 flex-1">
                  <span className="block">
                    {nombrePeriodo({ start: r.period_start, end: r.period_end })}
                  </span>
                  <span className="block text-xs text-muted">
                    {fechaCorta(r.generated_at)}
                    {r.params?.ia === true && ' · con IA'}
                    {r.params?.ia === false && ' · análisis calculado'}
                    {parcial && ` · ${r.params?.secciones?.length} secciones`}
                    {r.params?.nota && ` · «${r.params.nota}»`}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void abrir(r.storage_path)}
                  className="key key-quiet min-h-11 px-3 text-xs"
                >
                  Abrir
                </button>
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
    </div>
  )
}
