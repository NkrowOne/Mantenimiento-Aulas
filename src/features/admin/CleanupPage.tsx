import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { supabase } from '@/lib/supabase'
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

/**
 * El panel de administración, por secciones.
 *
 * Era una sola página con doce cosas una debajo de otra: usuarios, retiradas,
 * equipos y tipos sin validar, auditoría, equipamiento por defecto, el maestro
 * de salas, el Excel, los edificios sin identificar, las copias, las
 * incidencias sin sala y la cuarentena. Todo amontonado en la última pestaña,
 * y quien venía a sincronizar el Excel pasaba antes por el alta de usuarios y
 * por el maestro entero. Cinco secciones, cada una con lo que se viene a hacer
 * en ella:
 *
 *  1. **Usuarios** — lo que se viene a buscar cuando algo va mal.
 *  2. **Por decidir** — lo único que crece solo: cada ronda de revisiones deja
 *     retiradas, equipos y tipos por validar, y la auditoría de duplicados.
 *  3. **Maestro** — salas, edificios y equipamiento por defecto: se toca
 *     cuando cambia el campus. Los edificios sin identificar van aquí porque
 *     resolverlos es editar el maestro.
 *  4. **Excel** — la sincronización con el libro de SharePoint, sola, que es
 *     una pantalla larga y con sus propias decisiones.
 *  5. **Importación** — las copias, las incidencias sin sala y la cuarentena:
 *     importante, y se hace una vez.
 *
 * Solo se monta la sección abierta. Cada una lee lo suyo del servidor, y
 * montarlas todas era lanzar una docena de consultas para enseñar una.
 *
 * La sección se recuerda en este navegador: quien sincroniza el Excel los
 * viernes no tiene que volver a buscar la pestaña cada viernes.
 */
type Seccion = 'usuarios' | 'pendientes' | 'maestro' | 'excel' | 'importacion'

const SECCIONES: Array<{ id: Seccion; titulo: string; texto: string }> = [
  { id: 'usuarios', titulo: 'Usuarios', texto: 'Altas, roles y códigos' },
  { id: 'pendientes', titulo: 'Por decidir', texto: 'Retiradas, equipos y tipos sin validar, auditoría' },
  { id: 'maestro', titulo: 'Maestro', texto: 'Salas, edificios y equipamiento por defecto' },
  { id: 'excel', titulo: 'Excel', texto: 'Sincronizar el libro de SharePoint' },
  { id: 'importacion', titulo: 'Importación', texto: 'Copias, incidencias sin sala y cuarentena' },
]

const CLAVE_DE_SECCION = 'datos.seccion'

function seccionRecordada(): Seccion {
  try {
    const guardada = localStorage.getItem(CLAVE_DE_SECCION)
    if (SECCIONES.some((s) => s.id === guardada)) return guardada as Seccion
  } catch {
    // Sin almacenamiento —modo privado, datos bloqueados— se abre la primera.
  }
  return 'usuarios'
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

  const abrir = (s: Seccion): void => {
    setSeccion(s)
    recordarSeccion(s)
  }

  return (
    <div className="mx-auto max-w-4xl p-4">
      {/* Arriba, y no en la barra de abajo: la barra es de la aplicación
          entera, y estas cinco son las partes de una sola pestaña. Con la
          palabra y la línea de debajo, no solo con el color. */}
      <nav aria-label="Secciones de Datos" className="scroll-x -mx-4 border-b border-line px-4">
        <ul className="flex gap-1">
          {SECCIONES.map((s) => {
            const activa = s.id === seccion
            return (
              <li key={s.id} className="shrink-0">
                <button
                  type="button"
                  aria-current={activa ? 'page' : undefined}
                  onClick={() => abrir(s.id)}
                  title={s.texto}
                  className={`-mb-px min-h-11 border-b-2 px-3 text-sm ${
                    activa ? 'border-accent font-semibold text-accent' : 'border-transparent text-muted'
                  }`}
                >
                  {s.titulo}
                </button>
              </li>
            )
          })}
        </ul>
      </nav>
      <p className="mt-2 text-xs text-muted">{SECCIONES.find((s) => s.id === seccion)?.texto}</p>

      <div className="mt-4 space-y-8">
        {seccion === 'usuarios' && <UsersPage yo={yo} />}

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
            <EquipoPorDefecto />
            <MaestroSalas />
            <EdificiosSinIdentificar />
          </>
        )}

        {/* Sola en su sección: lee del maestro —la matrícula que escribe en el
            libro sale de las salas— y prepararlo con el maestro a medio
            arreglar deja el Excel apuntando a lo que había antes. Por eso el
            maestro va antes en la lista. */}
        {seccion === 'excel' && <SincronizarExcel />}

        {seccion === 'importacion' && (
          <>
            <RecuperarCopia />
            {/* Antes que la cuarentena cruda: es su mitad accionable. Cada
                asignación cierra además su fila de ahí abajo. */}
            <IncidenciasSinSala />
            <Cuarentena />
          </>
        )}
      </div>
    </div>
  )
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
  const [mergeInto, setMergeInto] = useState<Record<string, string>>({})

  const { data: provisional } = useQuery({
    queryKey: ['buildings', 'provisional'],
    queryFn: async (): Promise<ProvisionalBuilding[]> => {
      const { data } = await supabase
        .from('buildings')
        .select('id, code, name, review_note')
        .eq('needs_review', true)
        // Los archivados no: un edificio provisional que ya se dio de baja no
        // es trabajo pendiente, y seguiría pidiendo aquí una decisión que
        // alguien ya tomó al mandarlo a la papelera.
        .eq('active', true)
        .order('code')
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

  const merge = useMutation({
    mutationFn: async (input: { fromId: string; intoId: string }) => {
      const { error } = await supabase.rpc('merge_building', {
        from_building: input.fromId,
        into_building: input.intoId,
      })
      if (error) throw error
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['buildings'] }),
  })

  const confirm = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('buildings')
        .update({ needs_review: false, review_note: null })
        .eq('id', id)
      if (error) throw error
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['buildings'] }),
  })

  return (
    <section>
      <h1 className="text-xl font-semibold">Edificios sin identificar</h1>
      <p className="mt-1 text-sm text-muted">Están en el histórico pero no en el maestro.</p>

      <ul className="mt-4 space-y-3">
        {(provisional ?? []).map((b) => (
          <li key={b.id} className="card p-4">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-lg font-semibold">{b.code}</span>
              <span className="text-sm text-muted">{b.name}</span>
            </div>
            {b.review_note && <p className="mt-1 text-sm text-muted">{b.review_note}</p>}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                value={mergeInto[b.id] ?? ''}
                onChange={(e) => setMergeInto((m) => ({ ...m, [b.id]: e.target.value }))}
                className="h-10 rounded-ctl border border-line bg-surface px-2 text-base"
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
                disabled={!mergeInto[b.id]}
                onClick={() => merge.mutate({ fromId: b.id, intoId: mergeInto[b.id]! })}
                className="key key-accent h-10 px-3 text-sm"
              >
                Fusionar
              </button>

              <button
                type="button"
                onClick={() => confirm.mutate(b.id)}
                className="key key-quiet h-10 px-3 text-sm"
              >
                Es un edificio propio
              </button>
            </div>
          </li>
        ))}
      </ul>

      {provisional?.length === 0 && <p className="mt-4 text-sm text-muted">Ninguno pendiente.</p>}
    </section>
  )
}

// -----------------------------------------------------------------------------
// Cuarentena de importación
// -----------------------------------------------------------------------------

interface QuarantineRow {
  id: number
  source: string
  row_ref: string | null
  raw: Record<string, unknown>
  reason: string
}

function Cuarentena(): React.ReactElement {
  const qc = useQueryClient()

  const { data: quarantine } = useQuery({
    queryKey: ['quarantine'],
    queryFn: async (): Promise<QuarantineRow[]> => {
      const { data } = await supabase
        .from('import_quarantine')
        .select('*')
        .eq('resolved', false)
        // Sin `order`, Postgres no garantiza ninguno y el `update` de «Revisada»
        // puede mover la fila dentro del heap: la lista se reordenaba bajo el
        // dedo del coordinador.
        .order('at', { ascending: true })
        .limit(100)
      return (data ?? []) as QuarantineRow[]
    },
  })

  const dismiss = useMutation({
    mutationFn: async (id: number) => {
      const { data: user } = await supabase.auth.getUser()
      const { error } = await supabase
        .from('import_quarantine')
        .update({
          resolved: true,
          resolved_by: user.user?.id ?? null,
          resolved_at: new Date().toISOString(),
        })
        .eq('id', id)
      if (error) throw error
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['quarantine'] }),
  })

  return (
    <section>
      <h2 className="text-xl font-semibold">Cuarentena de importación</h2>
      <p className="mt-1 text-sm text-muted">
        No se pudieron interpretar al importar o al sincronizar el Excel.
      </p>

      <ul className="mt-4 divide-y divide-line">
        {(quarantine ?? []).map((q) => (
          <li key={q.id} className="flex items-start gap-3 py-3 text-sm">
            <div className="min-w-0 flex-1">
              <p className="text-muted">{q.reason}</p>
              <p className="mt-1 truncate font-mono text-xs">
                {Object.values(q.raw).filter(Boolean).join(' · ')}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                {q.source} · {q.row_ref}
              </p>
            </div>
            <button
              type="button"
              onClick={() => dismiss.mutate(q.id)}
              className="key key-quiet shrink-0 px-2 py-1 text-xs"
            >
              Revisada
            </button>
          </li>
        ))}
      </ul>

      {quarantine?.length === 0 && <p className="mt-4 text-sm text-muted">Nada pendiente de revisar.</p>}
    </section>
  )
}
