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
  useVelocidadDeCierre,
  type VelocidadDeCierre,
} from './queries'

/**
 * Qué se lee debajo de «Días en cerrar».
 *
 * Un número de días suelto no dice si eso es bueno. Al lado va cuántas se
 * cerraron —tres cierres no sostienen una mediana— y, cuando hay con qué
 * comparar, si el mes va mejor o peor que el anterior. Sin datos se dice que no
 * los hay, en vez de enseñar un cero que se leería como «se cierran el mismo día».
 */
function detalleDeVelocidad(v: VelocidadDeCierre | null): string {
  if (!v || v.cerradas_30d === 0) return 'Nada cerrado en 30 días'

  const cierres = `${v.cerradas_30d} cerrada${v.cerradas_30d === 1 ? '' : 's'}`
  if (v.dias_medio_30d == null || v.dias_medio_previo == null) return `${cierres} · mediana`

  const salto = Math.round((v.dias_medio_30d - v.dias_medio_previo) * 10) / 10
  if (salto === 0) return `${cierres} · igual que el mes pasado`
  return `${cierres} · ${salto < 0 ? '−' : '+'}${Math.abs(salto)} d vs. mes pasado`
}

/**
 * A dónde lleva cada cifra del panel.
 *
 * El cuadro de mando decía cuatro cosas y no llevaba a ninguna: «11 lámparas por
 * debajo del 20 %» y ahí se acababa. Enterarse de un problema y no poder ir a él
 * desde donde te enteras es lo que convierte un panel en un cartel — se mira dos
 * semanas y luego se deja de mirar.
 */
export interface Destinos {
  revisar: () => void
  incidencias: () => void
  datos: () => void
}

export function DashboardPage({ ir }: { ir: Destinos }): React.ReactElement {
  const { data: s, isPending, isError, refetch } = useSummary()
  const { data: lamps } = useLampAlerts()
  const { data: stale } = useStaleIncidents()
  const { data: velocidad } = useVelocidadDeCierre()
  const { data: byBuilding } = useIncidentsByBuilding()
  const { data: byMonth } = useIncidentsByMonth()

  if (isPending) {
    return <p className="p-6 text-muted">Cargando el panel…</p>
  }

  // Antes esto caía en el mismo `if` que la carga y pintaba ceros en verde:
  // el peor fallo posible en una pantalla de supervisión, porque parece una
  // buena noticia.
  if (isError || !s) {
    return (
      <div className="mx-auto max-w-md p-6">
        <div className="card p-4">
          <h2 className="font-semibold text-crit">No se ha podido leer el panel</h2>
          <p className="mt-1 text-sm text-muted">
            Necesita conexión. Las revisiones que hagas sin cobertura se guardan igual.
          </p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="key key-quiet mt-3 min-h-11 px-3 text-sm"
          >
            Reintentar
          </button>
        </div>
      </div>
    )
  }

  const pct = s.roomsTotal ? Math.round((s.inspectedThisMonth / s.roomsTotal) * 100) : 0

  return (
    /*
     * `space-y-8` y no 6: con seis tarjetas seguidas del mismo tamaño, seis
     * unidades de aire entre ellas las convierte en una sola columna continua.
     * Ocho, más las cabeceras con filete, es lo que hace que la pantalla se
     * recorra por secciones en vez de leerse entera de arriba abajo.
     */
    <div className="mx-auto max-w-5xl space-y-8 p-4">
      <section aria-labelledby="sec-situacion">
        <div className="section-head">
          <h2 id="sec-situacion" className="eyebrow">
            Situación
          </h2>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Revisadas este mes"
            value={s.inspectedThisMonth}
            detail={`${pct}% de ${s.roomsTotal}`}
            tone={pct >= 25 ? 'ok' : 'aviso'}
            onClick={ir.revisar}
            accion={pct >= 100 ? 'Ver la ronda' : 'Seguir la ronda'}
          />
          <StatTile
            label="Incidencias abiertas"
            value={s.openIncidents}
            detail={s.staleIncidents > 0 ? `${s.staleIncidents} estancadas` : undefined}
            tone={s.staleIncidents > 0 ? 'critico' : s.openIncidents > 0 ? 'aviso' : 'ok'}
            onClick={ir.incidencias}
            accion={s.openIncidents > 0 ? 'Atenderlas' : 'Ver el histórico'}
          />
          {/*
            Cuánto se tarda en cerrar. Sustituye a «Salas con problemas», que
            decía casi lo mismo que la baldosa de al lado —las incidencias
            abiertas viven en salas— y llevaba al mismo sitio. Esta contesta la
            pregunta que ninguna otra contestaba: si el trabajo sale o se
            acumula.
          */}
          <StatTile
            label="Días en cerrar"
            value={
              velocidad?.dias_mediana_30d != null
                ? velocidad.dias_mediana_30d.toLocaleString('es-ES')
                : '—'
            }
            detail={detalleDeVelocidad(velocidad ?? null)}
            tone={
              velocidad?.dias_mediana_30d == null
                ? 'neutro'
                : velocidad.dias_mediana_30d <= 7
                  ? 'ok'
                  : velocidad.dias_mediana_30d <= 21
                    ? 'aviso'
                    : 'critico'
            }
            onClick={ir.incidencias}
            accion="Ver la cola"
          />
          <StatTile
            label="Salas con problemas"
            value={s.roomsWithProblems}
            tone={s.roomsWithProblems > 0 ? 'aviso' : 'ok'}
            onClick={ir.incidencias}
            accion={s.roomsWithProblems > 0 ? 'Ver cuáles' : 'Ver incidencias'}
          />
          {/*
            Esta no cambia de pestaña: la lista de lámparas está más abajo, en
            esta misma pantalla. Llevar a otro sitio para enseñar algo que ya
            está aquí sería hacerle dar una vuelta al usuario.
          */}
          <StatTile
            label={`Lámparas < ${LAMP_ALERT_THRESHOLD * 100}%`}
            value={s.lampAlerts}
            tone={s.lampAlerts > 0 ? 'critico' : 'ok'}
            onClick={
              s.lampAlerts > 0
                ? () =>
                    document
                      .getElementById('sec-lamparas')
                      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                : undefined
            }
            accion={s.lampAlerts > 0 ? 'Cuáles y cuánto' : undefined}
          />
        </div>
      </section>

      {(s.needsReview > 0 || s.quarantine > 0) && (
        <button
          type="button"
          onClick={ir.datos}
          className="key card flex w-full items-center gap-4 border-warn/40 bg-warn-tint p-4 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="block font-semibold text-warn">Datos por revisar</span>
            <span className="mt-1 block text-sm text-muted">
              {[
                s.needsReview > 0 && `${s.needsReview} edificios sin identificar`,
                s.quarantine > 0 && `${s.quarantine} filas en cuarentena`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
          <span aria-hidden className="shrink-0 text-lg text-warn">
            →
          </span>
        </button>
      )}

      {/*
        El inventario pendiente va en su propia tarjeta y en gris, no con las
        alertas. No hay nada roto: hay salas por las que nadie ha pasado a mirar
        todavía, y pintarlo de naranja junto a «lámparas al 20%» le quitaría
        urgencia a lo que sí la tiene. Desaparece sola cuando se acaba.
      */}
      {s.roomsUninventoried > 0 && (
        <section className="card p-4">
          <h2 className="font-semibold">Inventario por levantar</h2>
          <p className="mt-1 text-sm text-muted">
            {s.roomsUninventoried} de {s.roomsTotal} salas sin que nadie haya confirmado qué hay
            dentro. Se resuelve desde la ficha de la sala, en «Equipos de la sala».
          </p>
        </section>
      )}

      <section aria-labelledby="sec-graficos">
        <div className="section-head">
          <h2 id="sec-graficos" className="eyebrow">
            Cómo viene el año
          </h2>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h3 className="mb-1 font-semibold">Incidencias por edificio</h3>
          <p className="mb-3 text-xs text-muted">Histórico</p>
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
          <p className="mb-3 text-xs text-muted">Últimos 12 meses</p>
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
        </div>
      </section>

      <section id="sec-lamparas" className="scroll-mt-4">
        <div className="section-head">
          <h2 className="eyebrow">Lo que va a dar guerra</h2>
        </div>
        <div className="card p-4">
        <h3 className="font-semibold">Lámparas que van a fundirse</h3>
        <p className="mb-3 text-xs text-muted">
          Por debajo del {LAMP_ALERT_THRESHOLD * 100} % de vida restante
        </p>

        {lamps?.length === 0 && <p className="text-sm text-muted">Ninguna.</p>}

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
                      {/* Es una medida leída de un proyector, no una barra de
                          progreso: recta, y sin animarse al entrar — animarla
                          obligaría a esperar para poder leerla. */}
                      <span className="h-1.5 w-16 overflow-hidden bg-line">
                        <span
                          className="block h-full bg-crit"
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
        </div>

        <div className="card mt-4 p-4">
        <h3 className="font-semibold">Incidencias estancadas</h3>
        <p className="mb-3 text-xs text-muted">Más de 7 días abiertas</p>

        {stale?.length === 0 && <p className="text-sm text-muted">Ninguna estancada.</p>}

        <ul className="divide-y divide-line">
          {(stale ?? []).map((i) => (
            <li key={i.id} className="flex items-start gap-3 py-2 text-sm">
              <span className="mt-1 shrink-0 rounded-tag bg-crit-tint px-2 py-0.5 font-mono text-xs text-crit tabular">
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
        </div>
      </section>
    </div>
  )
}
