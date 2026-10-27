import { useId, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { v7 as uuidv7 } from 'uuid'
import {
  ESTADO_EN_PLURAL,
  claseAlMeter,
  cuentaDe,
  cuentaDelReparto,
  estadoParaSacar,
  type NivelPorEstado,
  type Reparto,
} from '@/domain/estados'
import {
  CONDICIONES,
  ESTADOS_EN_ORDEN,
  cuantasEnEstado,
  palabraDelEstado,
  resumenDeCuentas,
  type Condicion,
} from '@/domain/unidades'
import { Volver } from './ElegirCondicion'
import { PUNTO_DE_CONDICION } from './ElegirUnidad'
import { cambiarEstados, type CambioDeEstado, type MovimientoPedido } from './estadosDatos'
import { falloDeEstado } from './fallos'

/** Lo que estas vistas necesitan saber del artículo: lo de la fila de `stock_levels`. */
interface Articulo {
  stock_item_id: string
  name: string
  unit: string
  on_hand: number
  below_threshold: boolean
}

/**
 * Un id que no cambia mientras no cambie lo que se pide.
 *
 * Cambiar estados va contra el servidor y sin cola, y el caso que importa es el
 * de siempre: la petición llegó y la respuesta se perdió. Si al repetir se
 * mandara un id nuevo, la base no podría saber que ya lo hizo. Con el mismo id
 * para la misma petición, repetir es no hacer nada; y si se cambia la cantidad o
 * el estado, ya es otra petición y lleva otro.
 */
function useIdsEstables(): (clave: string) => string {
  const ids = useRef(new Map<string, string>())
  return (clave) => {
    let id = ids.current.get(clave)
    if (!id) {
      id = uuidv7()
      ids.current.set(clave, id)
    }
    return id
  }
}

function Punto({ condicion }: { condicion: Condicion }): React.ReactElement {
  return <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${PUNTO_DE_CONDICION[condicion]}`} />
}

/**
 * Lo que hay de un artículo que se cuenta, partido por estados.
 *
 * Arriba el total, que es lo que se busca al abrirlo. Debajo una fila por estado
 * —nuevas, usadas, reacondicionadas, averiadas— con su cifra y su menos y su
 * más: sacar una usada o meter una nueva es un toque, sin elegir nada antes.
 * Están siempre las cuatro, también a cero, porque el más de una fila a cero es
 * justo el que hace falta cuando vuelve la primera averiada.
 *
 * **Lo que nadie ha clasificado se pregunta, no se esconde.** Al principio todo
 * está «sin estado» —el almacén se contaba sin estados— y eso sale arriba, en
 * ámbar, con la respuesta a un toque: «Todas nuevas», «Todas usadas», o
 * repartirlas. Contestado, desaparece.
 */
export function ExistenciasPorEstado({
  articulo,
  nivel,
  esSupervisor,
  ocupado,
  fallo,
  onMover,
  onCambiar,
  onRepartir,
}: {
  articulo: Articulo
  nivel: NivelPorEstado
  esSupervisor: boolean
  ocupado: boolean
  /** Por qué no se ha registrado el último menos o más, si no se ha registrado. */
  fallo: string | null
  onMover: (m: MovimientoPedido) => void
  onCambiar: (de?: Condicion) => void
  onRepartir: () => void
}): React.ReactElement {
  const qc = useQueryClient()
  const cuenta = cuentaDe(nivel)
  const sinEstado = cuenta.sin_indicar
  const [varias, setVarias] = useState(false)
  const [hecho, setHecho] = useState<string | null>(null)
  const idDe = useIdsEstables()

  const todas = useMutation({
    mutationFn: (c: CambioDeEstado) => cambiarEstados([c]),
    onSuccess: (_d, c) => setHecho(`Guardado: ${cuantasEnEstado(c.a, c.cantidad)} más.`),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['stock-levels'] }),
  })

  function clasificarTodas(a: 'nuevo' | 'usado'): void {
    setHecho(null)
    todas.mutate({
      id: idDe(`todas:${a}:${sinEstado}`),
      stockItemId: articulo.stock_item_id,
      cantidad: sinEstado,
      de: 'sin_indicar',
      a,
    })
  }

  const lineas: Condicion[] = sinEstado > 0 ? [...CONDICIONES, 'sin_indicar'] : [...CONDICIONES]
  const pregunta =
    sinEstado === articulo.on_hand
      ? sinEstado === 1
        ? '¿Cómo está?'
        : `¿Cómo están estas ${sinEstado}?`
      : sinEstado === 1
        ? '¿Cómo está la que no tiene estado?'
        : `¿Cómo están las ${sinEstado} sin estado?`

  return (
    <section aria-label="Existencias" className="rounded-ctl border border-line bg-surface p-3">
      <p className={`font-mono text-3xl font-semibold tabular ${articulo.below_threshold ? 'text-crit' : ''}`}>
        {articulo.on_hand}
      </p>
      <p className="text-xs text-muted">
        {articulo.unit} en el almacén
        {articulo.below_threshold ? ' · por debajo del mínimo' : ''}
        {nivel.averiado > 0 ? ` · ${nivel.disponibles} se pueden usar` : ''}
      </p>

      {sinEstado > 0 && (
        <div className="mt-3 rounded-ctl bg-warn-tint p-3">
          <p className="text-sm font-semibold text-ink">{pregunta}</p>
          <p className="mt-0.5 text-xs text-ink-2">
            Nadie lo ha dicho todavía. Con un toque queda apuntado, y se puede cambiar después.
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={todas.isPending}
              onClick={() => clasificarTodas('nuevo')}
              className="key key-quiet min-h-11 px-3 text-sm"
            >
              {sinEstado === 1 ? 'Nueva' : 'Todas nuevas'}
            </button>
            <button
              type="button"
              disabled={todas.isPending}
              onClick={() => clasificarTodas('usado')}
              className="key key-quiet min-h-11 px-3 text-sm"
            >
              {sinEstado === 1 ? 'Usada' : 'Todas usadas'}
            </button>
          </div>
          <button
            type="button"
            onClick={() => (sinEstado === 1 ? onCambiar('sin_indicar') : onRepartir())}
            className="mt-1 min-h-11 text-sm text-accent underline-offset-4 hover:underline"
          >
            {sinEstado === 1 ? 'Otro estado…' : 'Unas nuevas y otras usadas…'}
          </button>
          {todas.isError && (
            <p role="alert" className="mt-1 text-sm text-crit">
              {falloDeEstado(todas.error)}
            </p>
          )}
        </div>
      )}

      {hecho && (
        <p role="status" className="mt-3 text-sm text-ok">
          {hecho}
        </p>
      )}

      <ul aria-label="Por estado" className="mt-3 divide-y divide-line-soft border-t border-line-soft">
        {lineas.map((c) => {
          const n = cuenta[c]
          return (
            <li key={c} className="flex min-h-12 items-center gap-2 py-1">
              <Punto condicion={c} />
              <span className={`min-w-0 flex-1 text-sm ${n === 0 ? 'text-muted' : 'font-medium'}`}>
                {ESTADO_EN_PLURAL[c]}
              </span>
              <span className={`w-10 text-right font-mono text-lg tabular ${n === 0 ? 'text-muted' : ''}`}>{n}</span>
              <button
                type="button"
                disabled={ocupado || n <= 0}
                onClick={() => {
                  setHecho(null)
                  onMover({ qty: -1, kind: 'consumo', condicion: c })
                }}
                className="key key-quiet h-11 w-11"
                aria-label={
                  n <= 0
                    ? `No quedan ${palabraDelEstado(c, 2)} de ${articulo.name}`
                    : `Sacar una ${palabraDelEstado(c, 1)} de ${articulo.name}`
                }
              >
                −
              </button>
              {esSupervisor &&
                (c === 'sin_indicar' ? (
                  // Meter una «sin estado» no tiene sentido: quien la mete la tiene delante.
                  <span aria-hidden className="w-11" />
                ) : (
                  <button
                    type="button"
                    disabled={ocupado}
                    onClick={() => {
                      setHecho(null)
                      onMover({ qty: 1, kind: claseAlMeter(c), condicion: c })
                    }}
                    className="key key-quiet h-11 w-11"
                    aria-label={`Meter una ${palabraDelEstado(c, 1)} de ${articulo.name}`}
                  >
                    +
                  </button>
                ))}
            </li>
          )
        })}
      </ul>

      {fallo && (
        <p role="alert" className="mt-2 text-sm text-crit">
          {fallo}
        </p>
      )}

      <div className="mt-1 flex flex-wrap gap-x-4">
        <button
          type="button"
          disabled={articulo.on_hand <= 0}
          onClick={() => onCambiar()}
          className="min-h-11 text-sm text-accent underline-offset-4 hover:underline disabled:text-muted disabled:no-underline"
        >
          Cambiar el estado de algunas…
        </button>
        <button
          type="button"
          onClick={() => setVarias((v) => !v)}
          aria-expanded={varias}
          className="min-h-11 text-sm text-accent underline-offset-4 hover:underline"
        >
          Varias de golpe…
        </button>
      </div>

      {varias && (
        <VariasDeGolpe
          articulo={articulo}
          cuenta={cuenta}
          esSupervisor={esSupervisor}
          ocupado={ocupado}
          onMover={(m) => {
            setHecho(null)
            onMover(m)
          }}
        />
      )}
    </section>
  )
}

/** La caja de veinte cables: cuántas, de qué estado, y sacar o meter. */
function VariasDeGolpe({
  articulo,
  cuenta,
  esSupervisor,
  ocupado,
  onMover,
}: {
  articulo: Articulo
  cuenta: Record<Condicion, number>
  esSupervisor: boolean
  ocupado: boolean
  onMover: (m: MovimientoPedido) => void
}): React.ReactElement {
  const [cuantas, setCuantas] = useState('')
  const [estado, setEstado] = useState<Condicion>(() => estadoParaSacar(cuenta) ?? 'nuevo')
  const n = Number.parseInt(cuantas, 10)
  const nValido = Number.isInteger(n) && n > 0
  const hay = cuenta[estado]
  const opciones: Condicion[] = cuenta.sin_indicar > 0 ? [...CONDICIONES, 'sin_indicar'] : [...CONDICIONES]

  return (
    <div className="mt-2 border-t border-line-soft pt-2">
      <label className="flex items-center gap-2 text-sm text-muted">
        <input
          value={cuantas}
          onChange={(e) => setCuantas(e.target.value.replace(/\D/g, ''))}
          inputMode="numeric"
          placeholder="Cuántas"
          aria-label="Cuántas unidades"
          autoComplete="off"
          autoFocus
          className="h-11 w-24 rounded-ctl border border-line bg-raised px-3 text-center font-mono text-base text-ink"
        />
        {articulo.unit}
      </label>
      <ElegirEstado etiqueta="De qué estado" opciones={opciones} valor={estado} cuenta={cuenta} onCambio={setEstado} />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={!nValido || ocupado || n > hay}
          onClick={() => {
            onMover({ qty: -n, kind: 'consumo', condicion: estado })
            setCuantas('')
          }}
          className="key key-quiet min-h-11 flex-1 px-3 text-sm"
        >
          Sacar{nValido ? ` ${n}` : ''}
        </button>
        {esSupervisor && (
          <button
            type="button"
            disabled={!nValido || ocupado || estado === 'sin_indicar'}
            onClick={() => {
              onMover({ qty: n, kind: claseAlMeter(estado), condicion: estado })
              setCuantas('')
            }}
            className="key key-accent min-h-11 flex-1 px-3 text-sm"
          >
            Meter{nValido ? ` ${n}` : ''}
          </button>
        )}
      </div>
      {nValido && n > hay && (
        <p className="mt-1 text-xs text-muted">
          {hay === 0 ? `No hay ninguna ${palabraDelEstado(estado, 1)}` : `Solo hay ${cuantasEnEstado(estado, hay)}`}: no se
          pueden sacar {n}.
        </p>
      )}
    </div>
  )
}

/**
 * Elegir un estado entre unos cuantos, con cuántas hay de cada uno.
 *
 * Como `ElegirCondicion`, botones y no un desplegable: se ven todas las
 * respuestas a la vez. Este además admite «Sin estado» como origen —es de donde
 * sale casi todo lo que se clasifica— y enseña la cifra de cada uno.
 */
export function ElegirEstado({
  etiqueta,
  opciones,
  valor,
  cuenta,
  onCambio,
}: {
  etiqueta: string
  opciones: Condicion[]
  valor: Condicion | null
  cuenta?: Record<Condicion, number>
  onCambio: (c: Condicion) => void
}): React.ReactElement {
  const id = useId()
  return (
    <fieldset role="radiogroup" aria-labelledby={id} className="mt-3">
      <legend id={id} className="text-xs text-muted">
        {etiqueta}
      </legend>
      <div className="mt-1 grid grid-cols-2 gap-1 rounded-ctl border border-line bg-surface p-1">
        {opciones.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={valor === c}
            onClick={() => onCambio(c)}
            className={`flex min-h-11 items-center justify-center gap-1.5 rounded-ctl px-2 text-sm font-semibold ${
              valor === c ? 'key key-accent' : 'text-muted'
            }`}
          >
            {ESTADO_EN_PLURAL[c]}
            {cuenta && <span className="font-mono text-xs font-normal opacity-80">{cuenta[c]}</span>}
          </button>
        ))}
      </div>
    </fieldset>
  )
}

/**
 * Cambiar el estado de unas cuantas: «2 de usadas a averiadas».
 *
 * Es lo que pasa con el almacén delante: se prueba un teclado y no va, se repara
 * uno que estaba averiado. El total no cambia —siguen en el almacén—, cambia en
 * qué cifra están. Debajo se ve cómo quedará antes de guardarlo.
 */
export function CambiarEstado({
  articulo,
  nivel,
  deInicial,
  onVolver,
  onHecho,
}: {
  articulo: Articulo
  nivel: NivelPorEstado
  deInicial?: Condicion
  onVolver: () => void
  onHecho: (mensaje: string) => void
}): React.ReactElement {
  const qc = useQueryClient()
  const cuenta = cuentaDe(nivel)
  const origenes = ESTADOS_EN_ORDEN.filter((c) => cuenta[c] > 0)
  const [de, setDe] = useState<Condicion>(
    deInicial && cuenta[deInicial] > 0 ? deInicial : (origenes[0] ?? 'sin_indicar'),
  )
  const [a, setA] = useState<Condicion | null>(null)
  const [cuantas, setCuantas] = useState('1')
  const [nota, setNota] = useState('')
  const idDe = useIdsEstables()

  const destino = a && a !== de ? a : null
  const n = Number.parseInt(cuantas, 10)
  const hay = cuenta[de]
  const nValido = Number.isInteger(n) && n >= 1
  const valido = nValido && n <= hay && destino !== null
  const quedara = valido ? { ...cuenta, [de]: hay - n, [destino]: cuenta[destino] + n } : null

  const cambiar = useMutation({
    mutationFn: (c: CambioDeEstado) => cambiarEstados([c]),
    onSuccess: (_d, c) =>
      onHecho(
        `Cambiado: ${c.cantidad === 1 ? 'una' : c.cantidad} de ${ESTADO_EN_PLURAL[c.de].toLowerCase()} a ${ESTADO_EN_PLURAL[c.a].toLowerCase()}.`,
      ),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['stock-levels'] }),
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (!valido || !destino || cambiar.isPending) return
        cambiar.mutate({
          id: idDe(`${de}:${destino}:${n}:${nota.trim()}`),
          stockItemId: articulo.stock_item_id,
          cantidad: n,
          de,
          a: destino,
          nota,
        })
      }}
    >
      <Volver onVolver={onVolver} />
      <p className="text-base font-semibold">Cambiar el estado</p>
      <p className="text-sm text-muted">{resumenDeCuentas(cuenta) || 'No queda ninguna en el almacén.'}</p>

      <label className="mt-3 flex items-center gap-2 text-sm text-muted">
        <input
          value={cuantas}
          onChange={(e) => setCuantas(e.target.value.replace(/\D/g, ''))}
          inputMode="numeric"
          aria-label="Cuántas"
          autoComplete="off"
          className="h-11 w-20 rounded-ctl border border-line bg-surface px-3 text-center font-mono text-base text-ink"
        />
        {n === 1 ? 'unidad' : 'unidades'}
      </label>

      <ElegirEstado etiqueta="Que ahora están" opciones={origenes} valor={de} cuenta={cuenta} onCambio={setDe} />
      <ElegirEstado
        etiqueta="Pasan a"
        opciones={CONDICIONES.filter((c) => c !== de)}
        valor={destino}
        onCambio={setA}
      />

      <label className="mt-3 block text-xs text-muted">
        Por qué (opcional)
        <input
          name="motivo-del-cambio-de-estado"
          value={nota}
          onChange={(e) => setNota(e.target.value)}
          placeholder="Se ha roto la tecla Intro"
          autoComplete="off"
          className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base text-ink"
        />
      </label>

      <p className="mt-3 text-xs text-muted">
        {nValido && n > hay
          ? hay === 0
            ? `No hay ninguna ${palabraDelEstado(de, 1)}.`
            : `Solo hay ${cuantasEnEstado(de, hay)}: no se pueden cambiar ${n}.`
          : quedara
            ? `Quedarán: ${resumenDeCuentas(quedara)}. El total no cambia.`
            : 'Elige a qué estado pasan.'}
      </p>

      {cambiar.isError && (
        <p role="alert" className="mt-2 text-sm text-crit">
          {falloDeEstado(cambiar.error)}
        </p>
      )}

      <button
        type="submit"
        disabled={!valido || cambiar.isPending}
        className="key key-accent mt-3 min-h-touch w-full px-4 text-sm"
      >
        {cambiar.isPending ? 'Guardando…' : 'Cambiar el estado'}
      </button>
    </form>
  )
}

/**
 * Repartir las que no tienen estado: «de las 8, 5 nuevas y 3 usadas».
 *
 * Una fila por estado con su cifra, que se teclea o se sube y baja con los
 * botones. Lo que no se reparte sigue sin estado: se puede hacer en dos veces.
 */
export function Repartir({
  articulo,
  nivel,
  onVolver,
  onHecho,
}: {
  articulo: Articulo
  nivel: NivelPorEstado
  onVolver: () => void
  onHecho: (mensaje: string) => void
}): React.ReactElement {
  const qc = useQueryClient()
  const sinEstado = nivel.sin_indicar
  const [reparto, setReparto] = useState<Reparto>({})
  const { repartidas, quedan, pasado } = cuentaDelReparto(sinEstado, reparto)
  const idDe = useIdsEstables()

  const guardar = useMutation({
    mutationFn: (cambios: CambioDeEstado[]) => cambiarEstados(cambios),
    onSuccess: (_d, cambios) =>
      onHecho(`Guardado: ${resumenDeCuentas(Object.fromEntries(cambios.map((c) => [c.a, c.cantidad])))}.`),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['stock-levels'] }),
  })

  function poner(c: Exclude<Condicion, 'sin_indicar'>, valor: number): void {
    setReparto((r) => ({ ...r, [c]: Math.max(0, valor) }))
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (repartidas === 0 || pasado || guardar.isPending) return
        const cambios = CONDICIONES.filter((c) => (reparto[c] ?? 0) > 0).map((c) => ({
          id: idDe(`${c}:${reparto[c]}`),
          stockItemId: articulo.stock_item_id,
          cantidad: reparto[c]!,
          de: 'sin_indicar' as Condicion,
          a: c as Condicion,
        }))
        guardar.mutate(cambios)
      }}
    >
      <Volver onVolver={onVolver} />
      <p className="text-base font-semibold">
        {sinEstado === 1 ? '¿Cómo está la que no tiene estado?' : `¿Cómo están las ${sinEstado} sin estado?`}
      </p>
      <p className="text-sm text-muted">{articulo.name}. Pon cuántas hay de cada; las que no pongas siguen sin estado.</p>

      <ul className="mt-3 divide-y divide-line-soft rounded-ctl border border-line bg-surface px-3">
        {CONDICIONES.map((c) => {
          const v = reparto[c] ?? 0
          return (
            <li key={c} className="flex min-h-14 items-center gap-2 py-1">
              <Punto condicion={c} />
              <span className="min-w-0 flex-1 text-sm font-medium">{ESTADO_EN_PLURAL[c]}</span>
              <button
                type="button"
                disabled={v <= 0}
                onClick={() => poner(c, v - 1)}
                className="key key-quiet h-11 w-11"
                aria-label={`Una ${palabraDelEstado(c, 1)} menos`}
              >
                −
              </button>
              <input
                value={v === 0 ? '' : String(v)}
                onChange={(e) => poner(c, Number.parseInt(e.target.value.replace(/\D/g, '') || '0', 10))}
                inputMode="numeric"
                placeholder="0"
                aria-label={`Cuántas ${palabraDelEstado(c, 2)}`}
                autoComplete="off"
                className="h-11 w-14 rounded-ctl border border-line bg-surface text-center font-mono text-base text-ink"
              />
              <button
                type="button"
                disabled={quedan <= 0}
                onClick={() => poner(c, v + 1)}
                className="key key-quiet h-11 w-11"
                aria-label={`Una ${palabraDelEstado(c, 1)} más`}
              >
                +
              </button>
            </li>
          )
        })}
      </ul>

      <p className={`mt-2 text-sm ${pasado ? 'text-crit' : 'text-muted'}`}>
        {pasado
          ? `Son ${repartidas}: más de las ${sinEstado} que hay sin estado.`
          : quedan === 0
            ? 'Todas repartidas.'
            : quedan === 1
              ? 'Queda 1 sin estado.'
              : `Quedan ${quedan} sin estado.`}
      </p>

      {guardar.isError && (
        <p role="alert" className="mt-2 text-sm text-crit">
          {falloDeEstado(guardar.error)}
        </p>
      )}

      <button
        type="submit"
        disabled={repartidas === 0 || pasado || guardar.isPending}
        className="key key-accent mt-3 min-h-touch w-full px-4 text-sm"
      >
        {guardar.isPending ? 'Guardando…' : 'Guardar'}
      </button>
    </form>
  )
}
