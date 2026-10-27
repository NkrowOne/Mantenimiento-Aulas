import { useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MAXIMO_DE_UNA_LISTA, resumenDeLasAltas, seriesDeUnaLista, type ResultadoDeAlta } from '@/domain/estados'
import { entraPorDefecto, sinNumeroDeSerie, type Condicion } from '@/domain/unidades'
import { ElegirCondicion, Volver } from './ElegirCondicion'
import { falloDeUnidad } from './fallos'
import { darDeAltaUnidad, darDeAltaVarias, refrescarUnidades } from './unidadesDatos'

/**
 * Apuntar unidades de un artículo, una detrás de otra.
 *
 * Lo normal no es una: es la caja de seis proyectores que acaba de llegar, o los
 * ocho teclados que el almacén ya contaba y por fin se numeran. Por eso, al
 * guardar, el formulario se queda abierto con el número de serie vacío y el
 * cursor en él, y conserva todo lo demás —estado, marca, modelo—: la segunda
 * unidad cuesta teclear su número y pulsar Intro.
 *
 * **¿Entra ahora o ya estaba contada?** Es la única pregunta que no es obvia y
 * la que más daño hace si se contesta mal: numerar los ocho teclados del
 * almacén no puede dejarlo en dieciséis. Viene contestada con lo probable —si
 * todas las que cuenta el almacén ya tienen número, esta es nueva— y dice
 * debajo, con las cifras, qué va a pasar.
 *
 * **O todas de golpe.** Con veinte números en el albarán, en una columna del
 * Excel o en el lector de códigos de barras, teclearlos uno a uno es la tarde
 * entera. «Pegar una lista» los toma todos —uno por línea, o separados por
 * comas— con el mismo estado, marca y modelo, y la base contesta por cada uno:
 * apuntado, ya estaba, o por qué no. Los que fallan se quedan en la caja para
 * corregirlos y repetir.
 */
export function NuevaUnidad({
  stockItemId,
  articulo,
  existencias,
  conSerieEnAlmacen,
  puedeSumar,
  sugerencia,
  onVolver,
}: {
  stockItemId: string
  articulo: string
  existencias: number
  conSerieEnAlmacen: number
  /** Sumar al almacén es registrar una entrada: de supervisor, como el «+». */
  puedeSumar: boolean
  /** La marca y el modelo de la última unidad de este artículo, para no teclearlos otra vez. */
  sugerencia: { marca: string; modelo: string }
  onVolver: () => void
}): React.ReactElement {
  const qc = useQueryClient()
  const serialRef = useRef<HTMLInputElement>(null)
  const [modo, setModo] = useState<'una' | 'lista'>('una')
  const [lista, setLista] = useState('')
  const [resultado, setResultado] = useState<ResultadoDeAlta[] | null>(null)
  const [serial, setSerial] = useState('')
  const [condicion, setCondicion] = useState<Exclude<Condicion, 'sin_indicar'>>('nuevo')
  const [marca, setMarca] = useState(sugerencia.marca)
  const [modelo, setModelo] = useState(sugerencia.modelo)
  const [observaciones, setObservaciones] = useState('')
  const [apuntadas, setApuntadas] = useState<string[]>([])
  // Las que se van apuntando en esta tanda también cuentan para decidir si la
  // siguiente entra o ya estaba: la quinta de una caja de cinco sigue entrando.
  const [sumadas, setSumadas] = useState(0)
  const conSerie = conSerieEnAlmacen + apuntadas.length
  const total = existencias + sumadas
  const [sumar, setSumar] = useState(() => puedeSumar && entraPorDefecto(existencias, conSerieEnAlmacen))
  const [tocadoSumar, setTocadoSumar] = useState(false)
  const sumarAhora = tocadoSumar ? sumar : puedeSumar && entraPorDefecto(total, conSerie)

  const alta = useMutation({
    mutationFn: () =>
      darDeAltaUnidad({ stockItemId, serial, condicion, marca, modelo, observaciones, sumar: sumarAhora }),
    onSuccess: () => {
      setApuntadas((a) => [serial.trim().toUpperCase(), ...a])
      if (sumarAhora) setSumadas((n) => n + 1)
      setSerial('')
      setObservaciones('')
      refrescarUnidades(qc)
      serialRef.current?.focus()
    },
  })

  const sinNumero = sinNumeroDeSerie(total, conSerie)
  const pegadas = useMemo(() => seriesDeUnaLista(lista), [lista])
  const n = pegadas.series.length
  const demasiadas = n > MAXIMO_DE_UNA_LISTA

  const varias = useMutation({
    mutationFn: () =>
      darDeAltaVarias({ stockItemId, seriales: pegadas.series, condicion, marca, modelo, observaciones, sumar: sumarAhora }),
    onSuccess: (r) => {
      setResultado(r)
      const nuevas = r.filter((x) => x.resultado === 'nueva')
      setApuntadas((a) => [...nuevas.map((x) => x.serial.trim().toUpperCase()), ...a])
      if (sumarAhora) setSumadas((k) => k + nuevas.length)
      // En la caja se quedan solo los que no se han podido apuntar, para
      // corregirlos y volver a pulsar.
      setLista(
        r
          .filter((x) => x.resultado === 'error')
          .map((x) => x.serial)
          .join('\n'),
      )
      refrescarUnidades(qc)
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (modo === 'una') {
          if (serial.trim() && !alta.isPending) alta.mutate()
        } else if (n > 0 && !demasiadas && !varias.isPending) {
          setResultado(null)
          varias.mutate()
        }
      }}
    >
      <Volver onVolver={onVolver} texto={apuntadas.length > 0 ? 'Terminar' : 'Volver'} />
      <p className="text-base font-semibold">Añadir unidades</p>
      <p className="text-sm text-muted">{articulo}</p>

      <div role="radiogroup" aria-label="Cómo se apuntan" className="mt-3 grid grid-cols-2 gap-1 rounded-ctl border border-line bg-surface p-1">
        {(
          [
            ['una', 'Una a una'],
            ['lista', 'Pegar una lista'],
          ] as const
        ).map(([m, texto]) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={modo === m}
            onClick={() => setModo(m)}
            className={`min-h-11 rounded-ctl px-2 text-sm font-semibold ${modo === m ? 'key key-accent' : 'text-muted'}`}
          >
            {texto}
          </button>
        ))}
      </div>

      {modo === 'una' ? (
        <label className="mt-3 block text-xs text-muted">
          Número de serie
          <input
            ref={serialRef}
            name="numero-de-serie"
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            placeholder="Como viene en la pegatina"
            required
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="characters"
            spellCheck={false}
            enterKeyHint="done"
            className="mt-1 h-12 w-full rounded-ctl border border-line bg-surface px-3 font-mono text-lg uppercase text-ink"
          />
        </label>
      ) : (
        <label className="mt-3 block text-xs text-muted">
          Números de serie
          <textarea
            name="numeros-de-serie"
            value={lista}
            onChange={(e) => {
              setLista(e.target.value)
              setResultado(null)
            }}
            rows={6}
            placeholder={'Uno por línea, o separados por comas.\nSirve el lector de códigos de barras.'}
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="mt-1 w-full rounded-ctl border border-line bg-surface px-3 py-2 font-mono text-base uppercase text-ink"
          />
          <span className={`mt-1 block ${demasiadas ? 'text-crit' : ''}`}>
            {n === 0
              ? 'Todavía ninguno.'
              : demasiadas
                ? `Son ${n}: de una vez se apuntan ${MAXIMO_DE_UNA_LISTA} como mucho.`
                : `${n === 1 ? '1 número de serie' : `${n} números de serie`}${
                    pegadas.repetidas > 0
                      ? ` (${pegadas.repetidas === 1 ? '1 repetido' : `${pegadas.repetidas} repetidos`}: se ${pegadas.repetidas === 1 ? 'apunta' : 'apuntan'} una vez)`
                      : ''
                  }.`}
          </span>
        </label>
      )}

      <ElegirCondicion valor={condicion} onCambio={setCondicion} />

      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="block text-xs text-muted">
          Marca
          <input
            name="marca-de-la-unidad"
            value={marca}
            onChange={(e) => setMarca(e.target.value)}
            placeholder="Marca"
            autoComplete="off"
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base text-ink"
          />
        </label>
        <label className="block text-xs text-muted">
          Modelo
          <input
            name="modelo-de-la-unidad"
            value={modelo}
            onChange={(e) => setModelo(e.target.value)}
            placeholder="Modelo"
            autoComplete="off"
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base text-ink"
          />
        </label>
      </div>

      <label className="mt-3 block text-xs text-muted">
        Observaciones (opcional)
        <input
          name="observaciones-de-la-unidad"
          value={observaciones}
          onChange={(e) => setObservaciones(e.target.value)}
          placeholder="Lo que convenga saber de esta"
          autoComplete="off"
          className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 text-base text-ink"
        />
      </label>

      {puedeSumar && (
        <label className="mt-3 flex min-h-11 items-start gap-3 rounded-ctl border border-line bg-surface p-3 text-sm">
          <input
            type="checkbox"
            checked={sumarAhora}
            onChange={(e) => {
              setTocadoSumar(true)
              setSumar(e.target.checked)
            }}
            className="mt-0.5 h-5 w-5 shrink-0"
          />
          <span>
            <span className="block font-medium">{modo === 'lista' ? 'Entran ahora en el almacén' : 'Entra ahora en el almacén'}</span>
            <span className="block text-xs text-muted">
              {modo === 'lista'
                ? sumarAhora
                  ? `Suman ${n}: quedarán ${total + n}.`
                  : `No suman: son de las ${total} que ya cuenta el almacén${sinNumero > 0 ? ` (${sinNumero} aún sin número)` : ''}.`
                : sumarAhora
                  ? `Suma una: quedarán ${total + 1}.`
                  : `No suma: es una de las ${total} que ya cuenta el almacén${sinNumero > 0 ? ` (${sinNumero} aún sin número)` : ''}.`}
            </span>
            {modo === 'lista' && !sumarAhora && n > sinNumero && (
              <span className="mt-1 block text-xs text-warn">
                Son más de las {sinNumero} que el almacén cuenta sin número: si llegan ahora, márcalo.
              </span>
            )}
          </span>
        </label>
      )}

      {modo === 'una' && alta.isError && (
        <p role="alert" className="mt-3 text-sm text-crit">
          {falloDeUnidad(alta.error)}
        </p>
      )}
      {modo === 'lista' && varias.isError && (
        <p role="alert" className="mt-3 text-sm text-crit">
          {falloDeUnidad(varias.error)}
        </p>
      )}

      {modo === 'una' ? (
        <button
          type="submit"
          disabled={!serial.trim() || alta.isPending}
          className="key key-accent mt-4 min-h-touch w-full px-4 text-sm"
        >
          {alta.isPending ? 'Guardando…' : apuntadas.length > 0 ? 'Guardar y seguir' : 'Guardar'}
        </button>
      ) : (
        <button
          type="submit"
          disabled={n === 0 || demasiadas || varias.isPending}
          className="key key-accent mt-4 min-h-touch w-full px-4 text-sm"
        >
          {varias.isPending ? 'Apuntando…' : n > 0 ? `Apuntar ${n}` : 'Apuntar'}
        </button>
      )}

      {resultado && (
        <div role="status" className="mt-3 rounded-ctl border border-line bg-surface p-3 text-sm">
          <p className="font-medium">{resumenDeLasAltas(resultado)}</p>
          {resultado.some((x) => x.resultado === 'ya_estaba') && (
            <p className="mt-1 text-xs text-muted">
              Ya estaban (no se han tocado):{' '}
              <span className="font-mono">
                {resultado
                  .filter((x) => x.resultado === 'ya_estaba')
                  .map((x) => x.serial)
                  .join(' · ')}
              </span>
            </p>
          )}
          {resultado.some((x) => x.resultado === 'error') && (
            <ul className="mt-1 space-y-0.5 text-xs text-crit">
              {resultado
                .filter((x) => x.resultado === 'error')
                .map((x) => (
                  <li key={x.serial}>
                    <span className="font-mono">{x.serial}</span>: {x.mensaje || 'no se ha podido apuntar'}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      {apuntadas.length > 0 && (
        <div className="mt-3 rounded-ctl bg-ok-tint p-3 text-sm text-ok">
          <p className="font-medium">
            {apuntadas.length === 1 ? '1 unidad apuntada' : `${apuntadas.length} unidades apuntadas`}.{' '}
            {modo === 'lista' ? 'Pega más o pulsa «Terminar».' : 'Escribe la siguiente o pulsa «Terminar».'}
          </p>
          <p className="mt-1 font-mono text-xs">{apuntadas.join(' · ')}</p>
        </div>
      )}
    </form>
  )
}
