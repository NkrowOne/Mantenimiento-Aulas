import ReactECharts from 'echarts-for-react'
import { StatTile } from '@/components/StatTile'
import { baseOption, barSeries, lineSeries } from '@/design/charts'
import { LAMP_ALERT_THRESHOLD } from '@/domain/types'
import {
  useIncidentsByBuilding,
  useIncidentsByMonth,
  useLampAlerts,
  useStaleIncidents,
  useSummary,
} from './queries'

export function DashboardPage(): React.ReactElement {
  const { data: s, isLoading } = useSummary()
  const { data: lamps } = useLampAlerts()
  const { data: stale } = useStaleIncidents()
  const { data: byBuilding } = useIncidentsByBuilding()
  const { data: byMonth } = useIncidentsByMonth()

  if (isLoading || !s) {
    return <p className="p-6 text-muted">Cargando el panel…</p>
  }

  const pct = s.roomsTotal ? Math.round((s.inspectedThisMonth / s.roomsTotal) * 100) : 0

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4">
      <section>
        <h2 className="eyebrow mb-3">Situación</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Revisadas este mes"
            value={s.inspectedThisMonth}
            detail={`${pct}% de ${s.roomsTotal} salas`}
            tone={pct >= 25 ? 'ok' : 'aviso'}
          />
          <StatTile
            label="Incidencias abiertas"
            value={s.openIncidents}
            detail={s.staleIncidents > 0 ? `${s.staleIncidents} llevan más de 7 días` : 'ninguna estancada'}
            tone={s.staleIncidents > 0 ? 'critico' : s.openIncidents > 0 ? 'aviso' : 'ok'}
          />
          <StatTile
            label="Salas con problemas"
            value={s.roomsWithProblems}
            detail="con al menos una incidencia abierta"
            tone={s.roomsWithProblems > 0 ? 'aviso' : 'ok'}
          />
          <StatTile
            label="Lámparas al límite"
            value={s.lampAlerts}
            detail={`por debajo del ${LAMP_ALERT_THRESHOLD * 100}%`}
            tone={s.lampAlerts > 0 ? 'critico' : 'ok'}
          />
        </div>
      </section>

      {(s.needsReview > 0 || s.quarantine > 0) && (
        <section className="card border-warn/40 bg-warn/5 p-4">
          <h2 className="font-semibold text-warn">Datos importados pendientes de revisar</h2>
          <p className="mt-1 text-sm text-muted">
            {s.needsReview > 0 && (
              <>
                {s.needsReview} edificio{s.needsReview === 1 ? '' : 's'} aparecen en el histórico
                pero no en el maestro de salas.{' '}
              </>
            )}
            {s.quarantine > 0 && (
              <>
                {s.quarantine} filas del Excel no se pudieron interpretar y están en cuarentena en
                vez de importarse a medias.
              </>
            )}
          </p>
        </section>
      )}

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h3 className="mb-1 font-semibold">Incidencias por edificio</h3>
          <p className="mb-3 text-xs text-muted">Histórico completo, de mayor a menor</p>
          <ReactECharts
            style={{ height: 260 }}
            option={{
              ...baseOption(),
              xAxis: {
                ...(baseOption()['xAxis'] as object),
                type: 'category',
                data: (byBuilding ?? []).map((r) => r.code),
              },
              yAxis: { ...(baseOption()['yAxis'] as object), type: 'value' },
              series: [barSeries('Incidencias', (byBuilding ?? []).map((r) => r.total), 0)],
            }}
            notMerge
          />
        </div>

        <div className="card p-4">
          <h3 className="mb-1 font-semibold">Incidencias abiertas por mes</h3>
          <p className="mb-3 text-xs text-muted">Tendencia, no solo el total de hoy</p>
          <ReactECharts
            style={{ height: 260 }}
            option={{
              ...baseOption(),
              xAxis: {
                ...(baseOption()['xAxis'] as object),
                type: 'category',
                data: (byMonth ?? []).map((r) => r.month),
              },
              yAxis: { ...(baseOption()['yAxis'] as object), type: 'value' },
              series: [lineSeries('Aperturas', (byMonth ?? []).map((r) => r.total), 1)],
            }}
            notMerge
          />
        </div>
      </section>

      <section className="card p-4">
        <h3 className="font-semibold">Lámparas que van a fundirse</h3>
        <p className="mb-3 text-xs text-muted">
          Este dato ya estaba en vuestro Excel y hasta ahora no avisaba a nadie
        </p>

        {lamps?.length === 0 && <p className="text-sm text-muted">Ninguna por debajo del umbral.</p>}

        <div className="scroll-x">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-line">
              {(lamps ?? []).map((l) => (
                <tr key={l.room_id}>
                  <td className="py-2 font-mono">
                    {l.building_code} {l.room_code}
                  </td>
                  <td className="py-2 text-muted">{l.projector_hours ?? '—'} h</td>
                  <td className="py-2 text-right">
                    <span className="inline-flex items-center gap-2">
                      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-line">
                        <span
                          className="block h-full rounded-full bg-crit"
                          style={{ width: `${Math.max(2, l.lamp_pct * 100)}%` }}
                        />
                      </span>
                      <span className="w-10 text-right font-mono text-crit tabular">
                        {Math.round(l.lamp_pct * 100)}%
                      </span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card p-4">
        <h3 className="font-semibold">Incidencias estancadas</h3>
        <p className="mb-3 text-xs text-muted">Abiertas desde hace más de 7 días</p>

        {stale?.length === 0 && <p className="text-sm text-muted">Ninguna. Al día.</p>}

        <ul className="divide-y divide-line">
          {(stale ?? []).map((i) => (
            <li key={i.id} className="flex items-start gap-3 py-2 text-sm">
              <span className="mt-1 shrink-0 rounded-full bg-crit/12 px-2 py-0.5 font-mono text-xs text-crit tabular">
                {i.days_open} d
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{i.title}</span>
                <span className="text-xs text-muted">
                  {i.building_code ?? '—'} {i.room_code ?? ''} · {i.state}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
