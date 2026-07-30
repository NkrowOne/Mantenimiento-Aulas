import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Role } from '@/domain/types'
import { fechaCorta } from '@/domain/fechas'
import { EstadoIA, useEstadoIA } from './EstadoIA'
import { AUDIENCIAS, POR_DEFECTO, SECCIONES } from './secciones'
import { type Eleccion, construirPeticion, motivoParaNoPedir } from './peticion'
import {
  type Kind,
  type Rango,
  PRESETS,
  diasDelRango,
  hoyEnMadrid,
  nombrePeriodo,
} from './periodos'

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

/** Lo que tarda el worker en un informe con IA: consulta, razonamiento y PDF. */
const ESPERA_MAX_MS = 150_000

/**
 * Informes.
 *
 * El automático sale **los viernes a las 07:00** con la semana de trabajo
 * entera. Lo de esta pantalla es lo otro: pedirlo cuando hace falta y decidir
 * qué lleva dentro.
 *
 * Un informe emitido **no se regenera nunca**: se versiona. Si los datos cambian
 * después, el PDF del viernes tiene que seguir diciendo lo que decía el viernes,
 * o deja de servir como registro. De ahí que aquí no haya ningún botón de
 * «actualizar»: se emite otro y los dos quedan en el archivo.
 */
export function ReportsPage({ role }: { role: Role }): React.ReactElement {
  const hoy = hoyEnMadrid()

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

  /** Desde qué informe se está esperando uno nuevo, y desde cuándo. */
  const [esperando, setEsperando] = useState<{ ultimoId: string | null; desde: number } | null>(null)
  const [recien, setRecien] = useState<ReportRow | null>(null)

  const { data: estadoIA } = useEstadoIA()

  const { data: reports } = useQuery({
    queryKey: ['reports'],
    queryFn: async (): Promise<ReportRow[]> => {
      const { data } = await supabase
        .from('reports')
        .select('id, kind, period_start, period_end, storage_path, generated_at, params')
        .order('generated_at', { ascending: false })
        .limit(60)
      return (data ?? []) as ReportRow[]
    },
    // Mientras se espera un informe se pregunta cada tres segundos. El resto del
    // tiempo, nada: un archivo de informes no cambia solo.
    refetchInterval: esperando ? 3000 : false,
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
    mutationFn: async () => {
      const { error } = await supabase.rpc('request_report', construirPeticion(eleccion))
      if (error) throw error
    },
    onSuccess: () => {
      /*
       * Aquí antes había un `setTimeout` de cuatro segundos que refrescaba la
       * lista y se daba por satisfecho. Con IA de por medio un informe puede
       * tardar medio minuto, así que lo que se veía era la lista igual que
       * estaba y ninguna explicación. Ahora se espera de verdad: se recuerda cuál
       * era el último informe y se pregunta hasta que aparezca otro.
       */
      setRecien(null)
      setEsperando({ ultimoId: reports?.[0]?.id ?? null, desde: Date.now() })
    },
  })

  useEffect(() => {
    if (!esperando) return
    const primero = reports?.[0]
    if (primero && primero.id !== esperando.ultimoId) {
      setRecien(primero)
      setEsperando(null)
      return
    }
    if (Date.now() - esperando.desde > ESPERA_MAX_MS) setEsperando(null)
  }, [reports, esperando])

  async function descargar(path: string): Promise<void> {
    const { data } = await supabase.storage.from('reports').createSignedUrl(path, 60)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener')
  }

  const alternar = (clave: string): void =>
    setSecciones((s) => (s.includes(clave) ? s.filter((x) => x !== clave) : [...s, clave]))

  const esperandoDemasiado = esperando && Date.now() - esperando.desde > 40_000

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4">
      <header>
        <h1 className="text-xl font-semibold">Informes</h1>
        <p className="mt-1 text-sm text-muted">
          El automático sale los viernes a las 07:00 con la semana de trabajo entera. Aquí se pide
          cuando haga falta, y se elige qué lleva dentro.
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
              decir qué días son eso obliga a generar el PDF para averiguarlo. */}
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
                    {estadoIA?.clave_guardada || estadoIA?.ultimo_con_ia
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
            disabled={impedimento !== null || generar.isPending || esperando !== null}
            onClick={() => generar.mutate()}
            className="key key-accent min-h-11 px-4 text-sm"
          >
            {generar.isPending || esperando ? 'Generando…' : 'Generar'}
          </button>
          {/* El motivo, a la vista: un botón apagado sin explicación deja a quien
              lo mira buscando qué le falta. */}
          {impedimento && <span className="text-sm text-muted">{impedimento}</span>}
        </div>

        {generar.isError && (
          <p className="mt-3 text-sm text-crit">
            {generar.error instanceof Error
              ? generar.error.message
              : 'No se ha podido pedir el informe.'}
          </p>
        )}

        {esperando && (
          <p className="mt-3 text-sm text-muted" role="status">
            En marcha. {conIA ? 'Con IA suele tardar entre veinte segundos y un minuto.' : 'Suele tardar unos segundos.'}
            {esperandoDemasiado && ' Sigue trabajando; aparecerá en el archivo cuando termine.'}
          </p>
        )}

        {recien && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-card bg-ok-tint p-3 text-sm">
            <span className="text-ok">
              Listo: {KIND_LABEL[recien.kind]}, {nombrePeriodo({ start: recien.period_start, end: recien.period_end })}
              {recien.params?.ia === false ? ' · análisis calculado' : ''}
            </span>
            <button
              type="button"
              onClick={() => void descargar(recien.storage_path)}
              className="key key-ok ml-auto min-h-11 px-3 text-sm"
            >
              Abrir el PDF
            </button>
          </div>
        )}
      </section>

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
                  onClick={() => void descargar(r.storage_path)}
                  className="key key-quiet min-h-11 px-3 text-xs"
                >
                  Descargar
                </button>
              </li>
            )
          })}
        </ul>

        {reports?.length === 0 && (
          <p className="mt-2 text-sm text-muted">
            Aún no hay informes. El primer automático saldrá el viernes a las 07:00.
          </p>
        )}
      </section>
    </div>
  )
}
