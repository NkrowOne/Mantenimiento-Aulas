import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { v7 as uuidv7 } from 'uuid'
import { db, enqueue } from '@/db/dexie'
import { flush } from '@/sync/outbox'
import { supabase } from '@/lib/supabase'
import { norm } from '@/domain/normalize'

/**
 * El material que se ha gastado en una incidencia.
 *
 * Faltaba entera, y era el agujero que dejaba sin datos a media aplicación. El
 * Excel sí lo tenía —la columna «Material Usado»— y la importación lo trajo:
 * 320 líneas, 230 con artículo identificado. Pero de ahí no salía a ningún
 * sitio. El almacén no tenía **ni un solo movimiento de consumo**, así que el
 * top de material del informe diario y semanal salía en blanco y el consumo por
 * meses —las doce columnas Enero..Diciembre que estas vistas venían a
 * sustituir— también.
 *
 * El `−` de la pantalla de Almacén tampoco lo arreglaba: descuenta la unidad
 * pero no dice para qué, así que el gasto queda sin destino y no hay forma de
 * responder cuánto material se llevó un edificio. Aquí sí: el movimiento nace
 * con su incidencia y su sala.
 *
 * Va por la cola de salida y no directo contra el servidor —a diferencia del
 * resto del almacén— porque este apunte se hace en el aula, que es justo donde
 * no hay cobertura. El id nace con la pulsación, así que reenviarlo no duplica.
 */
export function MaterialUsado({
  incidentId,
  roomId,
}: {
  incidentId: string
  roomId: string | null
}): React.ReactElement {
  const [query, setQuery] = useState('')
  const [elegido, setElegido] = useState<{ id: string; name: string } | null>(null)
  const [qty, setQty] = useState(1)
  const [error, setError] = useState<string | null>(null)

  // Del espejo local: la lista de artículos ya está en el dispositivo.
  const articulos = useLiveQuery(() => db.stockItems.toArray(), [], [])

  const coincidencias = useMemo(() => {
    const q = norm(query)
    if (!q) return []
    return articulos
      .filter((a) => norm(a.name).includes(q))
      .sort((a, b) => {
        const empieza = (n: string): number => (norm(n).startsWith(q) ? 0 : 1)
        return empieza(a.name) - empieza(b.name) || a.name.localeCompare(b.name)
      })
      .slice(0, 6)
  }, [articulos, query])

  /*
   * Lo ya apuntado en esta incidencia. Necesita conexión y por eso no bloquea
   * nada: sin ella se apunta igual. Está para lo de siempre —dos técnicos, o el
   * mismo técnico dos veces— que sin verlo acaba en el material contado doble.
   */
  const { data: yaApuntado } = useQuery({
    queryKey: ['incident-materials', incidentId],
    queryFn: async () => {
      const { data, error: err } = await supabase
        .from('stock_movements')
        .select('id, qty, stock_item_id')
        .eq('incident_id', incidentId)
        .eq('kind', 'consumo')
      if (err) throw err
      return (data ?? []) as Array<{ id: string; qty: number; stock_item_id: string }>
    },
    retry: false,
  })

  const nombreDe = (id: string): string =>
    articulos.find((a) => a.id === id)?.name ?? 'Artículo retirado del catálogo'

  async function apuntar(): Promise<void> {
    if (!elegido || qty < 1) return
    setError(null)
    try {
      const { data } = await supabase.auth.getSession()
      // El id va en los dos sitios: es la clave de la cola y la de la fila. Con
      // el mismo valor, reenviar el apunte es no hacer nada.
      const id = uuidv7()
      await enqueue('stock_movement', id, {
        id,
        stock_item_id: elegido.id,
        qty: -qty,
        kind: 'consumo',
        incident_id: incidentId,
        room_id: roomId,
        occurred_at: new Date().toISOString(),
        by_user: data.session?.user.id ?? null,
      })
      void flush()
      setElegido(null)
      setQuery('')
      setQty(1)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se ha podido apuntar')
    }
  }

  return (
    <div className="mt-3 rounded-ctl border border-line bg-raised p-3">
      {(yaApuntado ?? []).length > 0 && (
        <ul className="mb-3 space-y-1 text-xs text-muted">
          {(yaApuntado ?? []).map((m) => (
            <li key={m.id}>
              <span className="font-mono tabular">{-m.qty}</span> · {nombreDe(m.stock_item_id)}
            </li>
          ))}
        </ul>
      )}

      {elegido ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{elegido.name}</span>
          <span className="inline-flex items-center gap-2">
            <button
              type="button"
              onClick={() => setQty((n) => Math.max(1, n - 1))}
              className="key key-quiet h-11 w-11"
              aria-label="Una unidad menos"
            >
              −
            </button>
            <span className="w-6 text-center font-mono tabular">{qty}</span>
            <button
              type="button"
              onClick={() => setQty((n) => n + 1)}
              className="key key-quiet h-11 w-11"
              aria-label="Una unidad más"
            >
              +
            </button>
          </span>
          <button
            type="button"
            onClick={() => void apuntar()}
            className="key key-accent min-h-11 px-3 text-sm"
          >
            Apuntar
          </button>
          <button
            type="button"
            onClick={() => {
              setElegido(null)
              setQty(1)
            }}
            className="key key-quiet min-h-11 px-3 text-sm"
          >
            Otro
          </button>
        </div>
      ) : (
        <>
          <label className="block">
            <span className="sr-only">Buscar artículo del almacén</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Material usado: busca el artículo"
              enterKeyHint="search"
              className="h-touch w-full rounded-ctl border border-line bg-sunken px-3 text-sm"
            />
          </label>

          {coincidencias.length > 0 && (
            <ul className="mt-2 divide-y divide-line">
              {coincidencias.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => setElegido({ id: a.id, name: a.name })}
                    className="min-h-11 w-full py-2 text-left text-sm"
                  >
                    {a.name}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Que no aparezca lo que se busca no es un callejón sin salida, pero
              tampoco se puede inventar el artículo desde aquí: el almacén es
              maestro y darle de alta un artículo es cosa del administrador. */}
          {query && coincidencias.length === 0 && (
            <p className="mt-2 text-xs text-muted">
              Ningún artículo coincide. Si es material nuevo, tiene que darlo de alta un
              administrador desde Almacén.
            </p>
          )}
        </>
      )}

      {error && <p className="mt-2 text-sm text-crit">{error}</p>}
    </div>
  )
}
