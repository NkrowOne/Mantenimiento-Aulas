import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { StatTile } from '@/components/StatTile'
import { fechaCorta } from '@/domain/fechas'
import { AssetTypeTray } from './AssetTypeTray'
import { AuditoriaInventario } from './AuditoriaInventario'
import { EquipoPorDefecto } from './EquipoPorDefecto'
import { IncidenciasSinSala } from './IncidenciasSinSala'
import { EquiposPendientes } from './EquiposPendientes'
import { MaestroSalas } from './MaestroSalas'
import { RecuperarCopia } from './RecuperarCopia'
import { RetiradasPendientes } from './RetiradasPendientes'
import { SincronizarExcel } from './SincronizarExcel'
import { UsersPage } from './UsersPage'
import { Cargando, Contador, EstadoVacio, FalloDeCarga, Nota, Seccion, mensajeDe } from './Seccion'
import { porSeccion, usePendientesDeDatos, useRefrescarPendientes } from './pendientes'

/**
 * El panel de administración, por secciones y con el trabajo contado.
 *
 * Era una sola página con doce cosas una debajo de otra: usuarios, retiradas,
 * equipos y tipos sin validar, auditoría, equipamiento por defecto, el maestro
 * de salas, el Excel, los edificios sin identificar, las copias, las
 * incidencias sin sala y la cuarentena. Todo amontonado en la última pestaña,
 * y quien venía a sincronizar el Excel pasaba antes por el alta de usuarios y
 * por el maestro entero. Cinco secciones, cada una con lo que se viene a hacer
 * en ella:
 *
 *  1. **Por decidir** — lo único que crece solo: cada ronda de revisiones deja
 *     retiradas, equipos y tipos por validar, y la auditoría de duplicados. Es
 *     la sección por defecto porque es la del día a día.
 *  2. **Maestro** — salas, edificios y equipamiento por defecto: se toca
 *     cuando cambia el campus. Los edificios sin identificar van aquí porque
 *     resolverlos es editar el maestro.
 *  3. **Excel** — la sincronización con el libro de SharePoint, sola, que es
 *     una pantalla larga y con sus propias decisiones.
 *  4. **Importación** — las copias, las incidencias sin sala y la cuarentena:
 *     importante, y se hace una vez.
 *  5. **Usuarios** — roles y bajas. Lo que se viene a buscar cuando algo va
 *     mal, y por eso está al final y no al principio: no es trabajo diario.
 *
 * **Y el trabajo está contado antes de entrar.** Cada sección lleva al lado
 * cuántas cosas esperan decisión, y las cuatro baldosas de arriba lo resumen
 * y llevan a la sección que toca. Sin eso, saber si había una retirada por
 * autorizar exigía abrir la sección y bajar hasta ella.
 *
 * Solo se monta la sección abierta. Cada una lee lo suyo del servidor, y
 * montarlas todas era lanzar una docena de consultas para enseñar una. La
 * sección se recuerda en este navegador: quien sincroniza el Excel los viernes
 * no tiene que volver a buscar la pestaña cada viernes.
 */
type Seccion = 'pendientes' | 'maestro' | 'excel' | 'importacion' | 'usuarios'

const SECCIONES: Array<{ id: Seccion; titulo: string; texto: string }> = [
  { id: 'pendientes', titulo: 'Por decidir', texto: 'Retiradas, equipos y tipos sin validar, y la auditoría de duplicados' },
  { id: 'maestro', titulo: 'Maestro', texto: 'Salas, edificios, equipamiento por defecto y edificios sin identificar' },
  { id: 'excel', titulo: 'Excel', texto: 'Sincronizar el libro de SharePoint en los dos sentidos' },
  { id: 'importacion', titulo: 'Importación', texto: 'Recuperar una copia, incidencias sin sala y cuarentena' },
  { id: 'usuarios', titulo: 'Usuarios', texto: 'Roles, bajas y cómo se da de alta a alguien' },
]

const CLAVE_DE_SECCION = 'datos.seccion'

function seccionRecordada(): Seccion {
  try {
    const guardada = localStorage.getItem(CLAVE_DE_SECCION)
    if (SECCIONES.some((s) => s.id === guardada)) return guardada as Seccion
  } catch {
    // Sin almacenamiento —modo privado, datos bloqueados— se abre la primera.
  }
  return 'pendientes'
}

function recordarSeccion(s: Seccion): void {
  try {
    localStorage.setItem(CLAVE_DE_SECCION, s)
  } catch {
    // Igual: recordarla es una comodidad, no un dato.
  }
}

export function CleanupPage({ yo }: { yo: string | null }): React.ReactElement {
  const [seccion, setSeccion] = useState<Seccion>(seccionRecordada)
  const pendientes = usePendientesDeDatos()
  const cuentas = porSeccion(pendientes)
  const contadorDe: Partial<Record<Seccion, number>> = {
    pendientes: cuentas.pendientes,
    maestro: cuentas.maestro,
    importacion: cuentas.importacion,
  }

  const abrir = (s: Seccion): void => {
    setSeccion(s)
    recordarSeccion(s)
    // Que el usuario ya esté abajo del todo no importa: cambiar de sección es
    // cambiar de pantalla, y una pantalla nueva empieza por arriba.
    window.scrollTo({ top: 0 })
  }

  const actual = SECCIONES.find((s) => s.id === seccion)!

  return (
    <div className="mx-auto max-w-4xl px-4 pb-4">
      {/* Arriba, y no en la barra de abajo: la barra es de la aplicación
          entera, y estas cinco son las partes de una sola pestaña. Con la
          palabra, el recuento y la línea de debajo, no solo con el color. */}
      <nav aria-label="Secciones de Datos" className="scroll-x -mx-4 border-b border-line px-4">
        <ul className="flex gap-1">
          {SECCIONES.map((s) => {
            const activa = s.id === seccion
            const n = contadorDe[s.id] ?? 0
            return (
              <li key={s.id} className="shrink-0">
                <button
                  type="button"
                  aria-current={activa ? 'page' : undefined}
                  onClick={() => abrir(s.id)}
                  title={s.texto}
                  className={`-mb-px flex min-h-12 items-center gap-1.5 border-b-2 px-3 text-sm ${
                    activa ? 'border-accent font-semibold text-accent' : 'border-transparent text-muted'
                  }`}
                >
                  {s.titulo}
                  {n > 0 && <Contador n={n} tono={activa ? 'aviso' : 'neutro'} />}
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{actual.titulo}</h1>
        <p className="text-sm text-muted">{actual.texto}</p>
      </div>

      {/* El resumen, en la sección que se abre por defecto y solo ahí: en las
          demás, quien ha entrado ya sabe a qué venía y cuatro baldosas encima
          de un formulario de alta serían el mismo amontonamiento con otra
          forma. */}
      {seccion === 'pendientes' && (
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Por decidir"
            value={cuentas.pendientes}
            detail={
              cuentas.pendientes === 0
                ? 'Nada espera una decisión'
                : [
                    pendientes.retiradas > 0 && `${pendientes.retiradas} retiradas`,
                    pendientes.equiposSinValidar > 0 && `${pendientes.equiposSinValidar} equipos`,
                    pendientes.tiposSinValidar > 0 && `${pendientes.tiposSinValidar} tipos`,
                    pendientes.duplicados > 0 && `${pendientes.duplicados} duplicados`,
                  ]
                    .filter(Boolean)
                    .join(' · ')
            }
            tone={cuentas.pendientes > 0 ? 'aviso' : 'ok'}
          />
          <StatTile
            label="Maestro"
            value={cuentas.maestro}
            detail={cuentas.maestro === 0 ? 'Ningún edificio sin identificar' : 'edificios sin identificar'}
            tone={cuentas.maestro > 0 ? 'aviso' : 'ok'}
            onClick={() => abrir('maestro')}
            accion="Abrir"
          />
          <StatTile
            label="Importación"
            value={cuentas.importacion}
            detail={
              cuentas.importacion === 0
                ? 'Nada en cuarentena'
                : [
                    pendientes.incidenciasSinSala > 0 && `${pendientes.incidenciasSinSala} sin sala`,
                    pendientes.cuarentena > 0 && `${pendientes.cuarentena} en cuarentena`,
                  ]
                    .filter(Boolean)
                    .join(' · ')
            }
            tone={cuentas.importacion > 0 ? 'aviso' : 'ok'}
            onClick={() => abrir('importacion')}
            accion="Abrir"
          />
          <StatTile
            label="Excel"
            value={pendientes.ultimaSincronizacion ? diasDesde(pendientes.ultimaSincronizacion) : '—'}
            detail={
              pendientes.ultimaSincronizacion
                ? `días desde la última sincronización, el ${fechaCorta(pendientes.ultimaSincronizacion)}`
                : 'El libro no se ha sincronizado nunca desde aquí'
            }
            tone={
              !pendientes.ultimaSincronizacion || diasDesde(pendientes.ultimaSincronizacion) > 14 ? 'aviso' : 'neutro'
            }
            onClick={() => abrir('excel')}
            accion="Sincronizar"
          />
        </div>
      )}

      <div className="mt-6 space-y-10">
        {seccion === 'pendientes' && (
          <>
            {/* Las retiradas van las primeras: bloquean a alguien que ya no puede
                tocar ese equipo hasta que se decidan. La auditoría cierra el
                grupo: también crece sola —cada choque de etiqueta deja un par
                por decidir— y es donde se recupera el inventario que se apuntó
                dos veces. */}
            <RetiradasPendientes />
            <EquiposPendientes />
            <AssetTypeTray />
            <AuditoriaInventario />
          </>
        )}

        {seccion === 'maestro' && (
          <>
            <MaestroSalas />
            <EdificiosSinIdentificar />
            <EquipoPorDefecto />
          </>
        )}

        {/* Sola en su sección: lee del maestro —la matrícula que escribe en el
            libro sale de las salas— y prepararlo con el maestro a medio
            arreglar deja el Excel apuntando a lo que había antes. Por eso el
            maestro va antes en la lista. */}
        {seccion === 'excel' && <SincronizarExcel />}

        {seccion === 'importacion' && (
          <>
            {/* Antes que la cuarentena cruda: es su mitad accionable. Cada
                asignación cierra además su fila de ahí abajo. */}
            <IncidenciasSinSala />
            <Cuarentena />
            <RecuperarCopia />
          </>
        )}

        {seccion === 'usuarios' && <UsersPage yo={yo} />}
      </div>
    </div>
  )
}

function diasDesde(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000))
}

// -----------------------------------------------------------------------------
// Edificios sin identificar
//
// Lo que resuelve que el importador no adivine. Cuando el Excel dice `BC` y no
// existe tal edificio, inventarse que es el CRAI metería datos falsos en el
// inventario. En su lugar el edificio entra marcado y aquí se resuelve con un
// clic: fusionarlo con el correcto o confirmarlo como propio.
// -----------------------------------------------------------------------------

interface ProvisionalBuilding {
  id: string
  code: string
  name: string
  review_note: string | null
}

function EdificiosSinIdentificar(): React.ReactElement {
  const qc = useQueryClient()
  const refrescar = useRefrescarPendientes()
  const [mergeInto, setMergeInto] = useState<Record<string, string>>({})
  const [nota, setNota] = useState<string | null>(null)

  const { data: provisional, isPending, isError, error, refetch } = useQuery({
    queryKey: ['buildings', 'provisional'],
    queryFn: async (): Promise<ProvisionalBuilding[]> => {
      const { data, error: err } = await supabase
        .from('buildings')
        .select('id, code, name, review_note')
        .eq('needs_review', true)
        // Los archivados no: un edificio provisional que ya se dio de baja no
        // es trabajo pendiente, y seguiría pidiendo aquí una decisión que
        // alguien ya tomó al mandarlo a la papelera.
        .eq('active', true)
        .order('code')
      if (err) throw err
      return (data ?? []) as ProvisionalBuilding[]
    },
  })

  const { data: known } = useQuery({
    queryKey: ['buildings', 'known'],
    queryFn: async () => {
      const { data } = await supabase
        .from('buildings')
        .select('id, code, name')
        .eq('needs_review', false)
        // Estos son los DESTINOS de una fusión, y ahí un edificio archivado es
        // una trampa: `merge_building` movería las zonas y las salas del origen
        // a un edificio invisible —y borraría el origen— así que desaparecerían
        // las dos cosas a la vez, sin ningún mensaje de error.
        .eq('active', true)
        .order('code')
      return (data ?? []) as Array<{ id: string; code: string; name: string }>
    },
  })

  const hecho = (mensaje: string): void => {
    setNota(mensaje)
    void qc.invalidateQueries({ queryKey: ['buildings'] })
    void qc.invalidateQueries({ queryKey: ['maestro'] })
    refrescar()
  }

  const merge = useMutation({
    mutationFn: async (input: { fromId: string; intoId: string; codigo: string; destino: string }) => {
      const { error: err } = await supabase.rpc('merge_building', {
        from_building: input.fromId,
        into_building: input.intoId,
      })
      if (err) throw err
      return `«${input.codigo}» fusionado con «${input.destino}»: sus salas e incidencias ya cuelgan de él.`
    },
    onSuccess: hecho,
  })

  const confirm = useMutation({
    mutationFn: async (b: ProvisionalBuilding) => {
      const { error: err } = await supabase
        .from('buildings')
        .update({ needs_review: false, review_note: null })
        .eq('id', b.id)
      if (err) throw err
      return `«${b.code}» confirmado como edificio propio.`
    },
    onSuccess: hecho,
  })

  const lista = provisional ?? []

  return (
    <Seccion
      id="sec-edificios-sin-identificar"
      titulo="Edificios sin identificar"
      texto="Códigos que aparecen en el histórico de incidencias y no en la hoja de estado del Excel. Fusionarlo con el edificio bueno mueve sus salas e incidencias; confirmarlo lo deja como edificio propio."
      pendientes={lista.length}
    >
      {isPending && <Cargando />}
      {isError && <FalloDeCarga que="los edificios" error={error} onReintentar={() => void refetch()} />}
      {provisional && lista.length === 0 && (
        <EstadoVacio titulo="Todos los edificios están identificados" />
      )}

      <ul className="space-y-3">
        {lista.map((b) => (
          <li key={b.id} className="card p-4">
            <div className="flex items-baseline gap-2">
              <span className="rounded-tag bg-raised px-2 py-1 font-mono text-sm font-semibold text-accent">{b.code}</span>
              <span className="text-sm text-muted">{b.name}</span>
            </div>
            {b.review_note && <p className="mt-1 text-sm text-muted">{b.review_note}</p>}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                value={mergeInto[b.id] ?? ''}
                onChange={(e) => setMergeInto((m) => ({ ...m, [b.id]: e.target.value }))}
                aria-label={`Edificio con el que fusionar ${b.code}`}
                className="h-11 min-w-48 flex-1 rounded-ctl border border-line bg-surface px-2 text-base"
              >
                <option value="">Fusionar con…</option>
                {(known ?? []).map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.code} — {k.name}
                  </option>
                ))}
              </select>

              <button
                type="button"
                disabled={!mergeInto[b.id] || merge.isPending || confirm.isPending}
                onClick={() => {
                  const destino = (known ?? []).find((k) => k.id === mergeInto[b.id])
                  if (!destino) return
                  if (window.confirm(`¿Fusionar «${b.code}» con «${destino.code} — ${destino.name}»? Sus salas e incidencias pasan a él y «${b.code}» desaparece. No se deshace.`)) {
                    merge.mutate({ fromId: b.id, intoId: destino.id, codigo: b.code, destino: destino.code })
                  }
                }}
                className="key key-accent min-h-11 px-3 text-sm"
              >
                Fusionar
              </button>

              <button
                type="button"
                disabled={merge.isPending || confirm.isPending}
                onClick={() => confirm.mutate(b)}
                className="key key-quiet min-h-11 px-3 text-sm"
              >
                Es un edificio propio
              </button>
            </div>
          </li>
        ))}
      </ul>

      <Nota
        texto={merge.isError || confirm.isError ? mensajeDe(merge.error ?? confirm.error) : nota}
        tono={merge.isError || confirm.isError ? 'crit' : 'ok'}
      />
    </Seccion>
  )
}

// -----------------------------------------------------------------------------
// Cuarentena de importación
//
// Agrupada por motivo, que es como se decide: doscientas filas sueltas no las
// lee nadie, pero «118 con el aula sin identificar» es una sola decisión —se
// resuelven arriba, en Incidencias sin sala— y «3 fechas ilegibles» es otra.
// Cada grupo se puede dar por revisado de una vez.
// -----------------------------------------------------------------------------

interface QuarantineRow {
  id: number
  source: string
  row_ref: string | null
  raw: Record<string, unknown>
  reason: string
  at: string
}

const LIMITE_CUARENTENA = 500

function Cuarentena(): React.ReactElement {
  const qc = useQueryClient()
  const refrescar = useRefrescarPendientes()
  const [nota, setNota] = useState<string | null>(null)

  const { data: quarantine, isPending, isError, error, refetch } = useQuery({
    queryKey: ['quarantine'],
    queryFn: async (): Promise<{ filas: QuarantineRow[]; total: number }> => {
      const { data, error: err, count } = await supabase
        .from('import_quarantine')
        .select('id, source, row_ref, raw, reason, at', { count: 'exact' })
        .eq('resolved', false)
        // Sin `order`, Postgres no garantiza ninguno y el `update` de «Revisada»
        // puede mover la fila dentro del heap: la lista se reordenaba bajo el
        // dedo del coordinador.
        .order('at', { ascending: true })
        .limit(LIMITE_CUARENTENA)
      if (err) throw err
      return { filas: (data ?? []) as QuarantineRow[], total: count ?? 0 }
    },
  })

  const hecho = (mensaje: string): void => {
    setNota(mensaje)
    void qc.invalidateQueries({ queryKey: ['quarantine'] })
    refrescar()
  }

  const revisar = useMutation({
    mutationFn: async (ids: number[]): Promise<string> => {
      const { data: user } = await supabase.auth.getUser()
      const { error: err } = await supabase
        .from('import_quarantine')
        .update({
          resolved: true,
          resolved_by: user.user?.id ?? null,
          resolved_at: new Date().toISOString(),
        })
        .in('id', ids)
      if (err) throw err
      return ids.length === 1 ? 'Revisada.' : `${ids.length} filas dadas por revisadas.`
    },
    onSuccess: hecho,
  })

  const filas = quarantine?.filas ?? []
  const grupos = new Map<string, QuarantineRow[]>()
  for (const q of filas) grupos.set(q.reason, [...(grupos.get(q.reason) ?? []), q])
  const ordenados = [...grupos.entries()].sort((a, b) => b[1].length - a[1].length)

  return (
    <Seccion
      id="sec-cuarentena"
      titulo="Cuarentena"
      texto="Lo que la importación o el Excel no pudieron interpretar, con su texto original. Nada de esto ha entrado en la base. Dar una fila por revisada solo la quita de aquí: lo que haya que corregir se corrige en el maestro, en el Excel o en las incidencias sin sala."
      pendientes={quarantine?.total ?? 0}
    >
      {isPending && <Cargando texto="Leyendo la cuarentena…" />}
      {isError && <FalloDeCarga que="la cuarentena" error={error} onReintentar={() => void refetch()} />}
      {quarantine && filas.length === 0 && <EstadoVacio titulo="Nada pendiente de revisar" />}

      {quarantine && quarantine.total > filas.length && (
        <p className="mb-3 text-xs text-muted">
          Se enseñan las {filas.length} más antiguas de {quarantine.total}. Revisa estas y vuelve a entrar.
        </p>
      )}

      <div className="space-y-3">
        {ordenados.map(([motivo, lista]) => (
          <details key={motivo} className="card p-4" open={ordenados.length <= 2}>
            <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm font-semibold">
              <span className="min-w-0 flex-1">{motivo}</span>
              <Contador n={lista.length} tono="neutro" que="filas" />
            </summary>
            <ul className="mt-3 divide-y divide-line-soft">
              {lista.map((q) => (
                <li key={q.id} className="flex items-start gap-3 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs">
                      {Object.values(q.raw).filter(Boolean).join(' · ') || '(sin contenido)'}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {[q.source, q.row_ref, fechaCorta(q.at)].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={revisar.isPending}
                    onClick={() => revisar.mutate([q.id])}
                    className="key key-quiet min-h-11 shrink-0 px-3 text-xs text-muted"
                  >
                    Revisada
                  </button>
                </li>
              ))}
            </ul>
            {lista.length > 1 && (
              <button
                type="button"
                disabled={revisar.isPending}
                onClick={() => {
                  if (window.confirm(`¿Dar por revisadas las ${lista.length} filas de «${motivo}»? Salen de la cuarentena; no cambia nada más.`)) {
                    revisar.mutate(lista.map((q) => q.id))
                  }
                }}
                className="key key-quiet mt-3 min-h-11 px-3 text-sm"
              >
                Dar las {lista.length} por revisadas
              </button>
            )}
          </details>
        ))}
      </div>

      <Nota texto={revisar.isError ? mensajeDe(revisar.error) : nota} tono={revisar.isError ? 'crit' : 'ok'} />
    </Seccion>
  )
}
