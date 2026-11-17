import { useMemo } from 'react'
import { FAMILIAS, type Familia } from '@/domain/historial'
import {
  FAMILIA_LABEL,
  PERIODOS,
  PERIODO_LABEL,
  fechasDelPeriodo,
  periodoLegible,
  problemaDeLasOpciones,
  type OpcionesDelHistorial,
  type Periodo,
} from '@/domain/historialExportado'
import { diaEnMadrid } from '@/domain/fechas'
import { ExportarConVistaPrevia } from '@/features/inventory/ExportarConVistaPrevia'
import { useEstadoDeSesion } from '@/lib/estado-de-sesion'
import { exportacionDelHistorial, type AlcanceDelHistorial } from './exportarHistorial'

/**
 * El historial de una sala o de un edificio, para llevárselo: se elige qué, se
 * ve, y se descarga en Excel o en PDF.
 *
 * **Se elige antes de descargar**, y son dos preguntas:
 *
 *  - *De cuándo.* Seis periodos de un toque —el último mes para el parte, este
 *    año para la memoria, todo para decidir si un aula se renueva— y, para lo
 *    demás, dos fechas puestas a mano. Debajo se dice siempre de qué día a qué
 *    día va lo elegido: «últimos 3 meses» no le dice a nadie si entra el 17 de
 *    agosto.
 *  - *Qué.* Revisiones, incidencias, solicitudes, material y equipos, todo
 *    marcado de entrada. Quitar una la quita de la lista y, si era la única que
 *    alimentaba una hoja, quita la hoja.
 *
 * Lo elegido **se recuerda mientras la aplicación siga abierta**: quien saca el
 * historial del último mes de cinco aulas seguidas lo elige una vez.
 *
 * Es un fichero aparte para que la ficha y la lista de salas lo carguen **solo
 * cuando hace falta** (`lazy`). Detrás de la vista previa va el motor que
 * escribe el Excel, y la ficha del aula es la pantalla que más veces se abre al
 * día y casi siempre sin cobertura de sobra: meterle ese motor en el arranque
 * para una descarga que se pide una vez al mes sería cobrárselo a todos.
 */
export default function DescargarHistorial({
  alcance,
  titulo,
  descripcion,
}: {
  alcance: AlcanceDelHistorial
  titulo: string
  descripcion: string
}): React.ReactElement {
  const [periodo, setPeriodo] = useEstadoDeSesion<Periodo>('historial-descarga.periodo', 'doce', (v) =>
    (PERIODOS as readonly unknown[]).includes(v),
  )
  const [desde, setDesde] = useEstadoDeSesion('historial-descarga.desde', '')
  const [hasta, setHasta] = useEstadoDeSesion('historial-descarga.hasta', '')
  const [familias, setFamilias] = useEstadoDeSesion<Familia[]>(
    'historial-descarga.familias',
    [...FAMILIAS],
    (v) => Array.isArray(v) && v.every((f) => (FAMILIAS as readonly unknown[]).includes(f)),
  )

  const hoy = diaEnMadrid()
  const opciones: OpcionesDelHistorial = useMemo(
    () => ({ ...fechasDelPeriodo(periodo, { desde, hasta }, hoy), familias }),
    [periodo, desde, hasta, hoy, familias],
  )
  const problema = problemaDeLasOpciones(opciones)

  const alternar = (f: Familia): void =>
    setFamilias(
      // En el orden de siempre, se marquen en el que se marquen.
      FAMILIAS.filter((x) => (x === f ? !familias.includes(f) : familias.includes(x))),
    )

  return (
    <ExportarConVistaPrevia
      titulo={titulo}
      descripcion={descripcion}
      disabled={problema !== null}
      eleccion={JSON.stringify(opciones)}
      preparar={() => exportacionDelHistorial(alcance, opciones)}
    >
      <fieldset className="mt-4">
        <legend className="eyebrow">Periodo</legend>
        <div role="group" aria-label="Periodo" className="opciones mt-2">
          {PERIODOS.map((p) => (
            <button key={p} type="button" aria-pressed={periodo === p} onClick={() => setPeriodo(p)}>
              {PERIODO_LABEL[p]}
            </button>
          ))}
        </div>

        {periodo === 'fechas' && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="text-xs text-muted">
              Desde
              <input
                type="date"
                value={desde}
                max={hasta || hoy}
                onChange={(e) => setDesde(e.target.value)}
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-base text-ink"
              />
            </label>
            <label className="text-xs text-muted">
              Hasta
              <input
                type="date"
                value={hasta}
                min={desde || undefined}
                max={hoy}
                onChange={(e) => setHasta(e.target.value)}
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-base text-ink"
              />
            </label>
          </div>
        )}

        {/* De qué día a qué día, siempre a la vista: es lo que convierte
            «últimos 3 meses» en algo que se puede comprobar. */}
        <p aria-live="polite" className="mt-2 text-xs text-muted">
          {periodoLegible(opciones)}
          {periodo === 'fechas' && !desde && !hasta ? ': pon una fecha, o las dos.' : '.'}
        </p>
      </fieldset>

      <fieldset className="mt-4">
        <legend className="eyebrow">Qué incluir</legend>
        {/* Casillas y no teclas: aquí se marcan varias a la vez, y una casilla
            dice eso sola. Las teclas de arriba son «una de seis». */}
        <div className="mt-1 grid grid-cols-2 gap-x-4 sm:grid-cols-3">
          {FAMILIAS.map((f) => (
            <label key={f} className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={familias.includes(f)} onChange={() => alternar(f)} />
              {FAMILIA_LABEL[f]}
            </label>
          ))}
        </div>
        {familias.length < FAMILIAS.length && familias.length > 0 && (
          <button
            type="button"
            onClick={() => setFamilias([...FAMILIAS])}
            className="-ml-2 inline-flex min-h-11 items-center px-2 text-sm text-accent underline-offset-4 hover:underline"
          >
            Marcar todo
          </button>
        )}
      </fieldset>

      {problema && (
        <p role="alert" className="mt-2 text-sm text-crit">
          {problema}
        </p>
      )}
    </ExportarConVistaPrevia>
  )
}
