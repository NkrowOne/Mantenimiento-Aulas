import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import type { RemovalDestino } from '@/domain/types'
import { descripcionDeUnidad, type UnidadDeAlmacen } from '@/domain/unidades'
import { Volver } from './ElegirCondicion'
import { falloDeUnidad } from './fallos'
import { buscarSalas, instalarUnidad, refrescarUnidades, useSalasParaInstalar, type SalaParaInstalar } from './unidadesDatos'

/**
 * Llevar esta unidad a un aula, desde el almacén.
 *
 * Tres preguntas, una detrás de otra y solo las que tocan: a qué aula (se
 * busca tecleando, como se dice en el pasillo: «1.7 H», «criminología»), si
 * sustituye a alguno de los que ya hay allí, y a dónde va el que se quita. Lo
 * demás —el equipo en la sala con su número de serie, el descuento del almacén,
 * el histórico de las dos cosas— lo hace la base de una vez.
 *
 * Desde aquí necesita conexión: es la pantalla del almacén, que se usa con el
 * almacén delante. Sin cobertura, el camino es el del aula —«Añadir equipo →
 * Del almacén»—, que va por la cola y elige la misma unidad.
 */
export function InstalarUnidad({
  unidad,
  onVolver,
  onHecho,
}: {
  unidad: UnidadDeAlmacen
  onVolver: () => void
  onHecho: (mensaje: string) => void
}): React.ReactElement {
  const qc = useQueryClient()
  const salas = useSalasParaInstalar()
  const [consulta, setConsulta] = useState('')
  const [sala, setSala] = useState<SalaParaInstalar | null>(null)
  const [sustituye, setSustituye] = useState<string | null>(null)
  const [destino, setDestino] = useState<RemovalDestino>('almacen')
  const [nota, setNota] = useState('')
  const [enLinea, setEnLinea] = useState(() => navigator.onLine)

  useEffect(() => {
    const alCambiar = (): void => setEnLinea(navigator.onLine)
    window.addEventListener('online', alCambiar)
    window.addEventListener('offline', alCambiar)
    return () => {
      window.removeEventListener('online', alCambiar)
      window.removeEventListener('offline', alCambiar)
    }
  }, [])

  const resultados = buscarSalas(salas, consulta)

  /* Los de su tipo que ya están en esa sala: a los que puede estar sustituyendo. */
  const mismos = useLiveQuery(
    async () => {
      if (!sala || !unidad.asset_type_id) return []
      return (await db.assets.where('room_id').equals(sala.id).toArray()).filter(
        (a) => a.asset_type_id === unidad.asset_type_id && a.status !== 'retirado',
      )
    },
    [sala?.id, unidad.asset_type_id],
    [],
  )
  useEffect(() => setSustituye(mismos.length > 0 ? null : 'no'), [mismos.length, sala?.id])

  const instalar = useMutation({
    mutationFn: () =>
      instalarUnidad({
        unidad: unidad.id,
        sala: sala!.id,
        sustituye: sustituye && sustituye !== 'no' ? sustituye : null,
        destino,
        nota,
      }),
    onSuccess: () => {
      refrescarUnidades(qc)
      onHecho(
        sustituye && sustituye !== 'no'
          ? `${unidad.serial} instalada en ${sala!.codigo} ${sala!.edificio}. Se ha pedido la retirada del que sustituye.`
          : `${unidad.serial} instalada en ${sala!.codigo} ${sala!.edificio}.`,
      )
    },
  })

  const listo = Boolean(sala) && sustituye !== null && enLinea && !instalar.isPending

  return (
    <div>
      <Volver onVolver={onVolver} />
      <p className="text-base font-semibold">
        Instalar <span className="font-mono">{unidad.serial}</span>
      </p>
      {descripcionDeUnidad(unidad) && <p className="text-sm text-muted">{descripcionDeUnidad(unidad)}</p>}

      {unidad.condicion === 'averiado' && (
        <p className="mt-2 rounded-ctl bg-warn-tint p-2 text-xs text-warn">
          Está marcada como averiada. Si ya funciona, cámbiale el estado antes de instalarla.
        </p>
      )}

      {!sala ? (
        <div className="mt-3">
          <label className="block text-xs text-muted" htmlFor="instalar-buscar-sala">
            ¿En qué aula?
          </label>
          <input
            id="instalar-buscar-sala"
            type="search"
            value={consulta}
            onChange={(e) => setConsulta(e.target.value)}
            placeholder="1.7 H, criminología, SALA-000017…"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base"
          />
          <ul className="mt-2 space-y-1.5">
            {resultados.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setSala(s)}
                  className="key key-quiet min-h-11 w-full px-3 py-2 text-left text-sm"
                >
                  {s.titulo}
                </button>
              </li>
            ))}
          </ul>
          {consulta.trim() !== '' && resultados.length === 0 && (
            <p className="mt-2 text-xs text-muted">Ningún aula coincide con «{consulta}».</p>
          )}
          {consulta.trim() === '' && (
            <p className="mt-2 text-xs text-muted">Escribe el código del aula, el edificio o su nombre.</p>
          )}
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-ctl border border-accent bg-accent-tint px-3 py-2">
          <span className="min-w-0 text-sm">
            <span className="block text-xs text-muted">Aula</span>
            <span className="block truncate font-medium">{sala.titulo}</span>
          </span>
          <button type="button" onClick={() => setSala(null)} className="key key-quiet min-h-11 shrink-0 px-3 text-sm">
            Cambiar
          </button>
        </div>
      )}

      {sala && mismos.length > 0 && (
        <fieldset role="radiogroup" className="mt-3">
          <legend className="text-xs text-muted">El aula ya tiene de este tipo. ¿Sustituye a alguno?</legend>
          <div className="mt-1 space-y-1.5">
            {[
              ...mismos.map((a) => ({
                id: a.id,
                titulo: `Sí, a «${a.label ?? 'equipo'}»`,
                detalle: [a.model, a.serial].filter(Boolean).join(' · ') || 'Sin modelo ni número de serie',
              })),
              { id: 'no', titulo: 'No, es uno más', detalle: 'Se añade sin tocar los que hay.' },
            ].map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={sustituye === o.id}
                onClick={() => setSustituye(o.id)}
                className={`flex min-h-11 w-full flex-col items-start justify-center rounded-ctl border px-3 py-2 text-left ${
                  sustituye === o.id ? 'border-accent bg-accent-tint' : 'border-line bg-surface'
                }`}
              >
                <span className="text-sm">{o.titulo}</span>
                <span className="text-xs text-muted">{o.detalle}</span>
              </button>
            ))}
          </div>
          {sustituye && sustituye !== 'no' && (
            <div className="mt-2">
              <p className="text-xs text-muted">El que se quita va a…</p>
              <div className="mt-1 flex gap-1 rounded-ctl border border-line bg-surface p-1">
                {(['almacen', 'baja'] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={destino === d}
                    onClick={() => setDestino(d)}
                    className={`min-h-11 flex-1 rounded-ctl px-2 text-sm font-semibold ${
                      destino === d ? 'key key-accent' : 'text-muted'
                    }`}
                  >
                    {d === 'almacen' ? 'Vuelve al almacén' : 'Baja definitiva'}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-muted">
                Si eres supervisor se retira ya; si no, queda pedida su retirada y sigue en la sala hasta
                que alguien la autorice.
              </p>
            </div>
          )}
        </fieldset>
      )}

      {sala && (
        <label className="mt-3 block text-xs text-muted">
          Nota (opcional)
          <input
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            placeholder="Sustituye al que no enciende"
            autoComplete="off"
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base text-ink"
          />
        </label>
      )}

      {instalar.isError && (
        <p role="alert" className="mt-3 text-sm text-crit">
          {falloDeUnidad(instalar.error)}
        </p>
      )}
      {!enLinea && (
        <p className="mt-3 text-xs text-muted">
          Sin conexión: desde el almacén se instala con red. En el aula, «Añadir equipo → Del almacén» elige esta
          misma unidad sin cobertura.
        </p>
      )}

      {sala && (
        <button
          type="button"
          disabled={!listo}
          onClick={() => instalar.mutate()}
          className="key key-accent mt-4 min-h-touch w-full px-4 text-sm"
        >
          {instalar.isPending ? 'Instalando…' : `Instalar en ${sala.codigo} ${sala.edificio}`}
        </button>
      )}
      {sala && sustituye === null && (
        <p className="mt-1 text-center text-xs text-muted">Di si sustituye a uno de los que hay.</p>
      )}
    </div>
  )
}
