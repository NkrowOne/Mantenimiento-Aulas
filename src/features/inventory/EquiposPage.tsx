import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { fechaCorta } from '@/domain/fechas'
import { ASSET_STATUS_LABELS, type Role } from '@/domain/types'
import {
  DESTINO_LABEL,
  FILTRO_INICIAL,
  MOVIMIENTO_LABEL,
  filtrarEquipos,
  hojaDeEntradasYSalidas,
  hojaDeEquipos,
  ordenarEquipos,
  resumenDeEquipos,
  type ClaseDeMovimiento,
  type EquipoDelRegistro,
  type FiltroDeEquipos,
} from '@/domain/fichaDeEquipo'
import { ExportarConVistaPrevia } from './ExportarConVistaPrevia'
import { EntradaDeEquipo } from './EntradaDeEquipo'
import { EtiquetaDeVida, FichaDeEquipo } from './FichaDeEquipo'
import {
  CLAVE_MOVIMIENTOS,
  CLAVE_REGISTRO,
  cargarMovimientos,
  mensajeDeFallo,
  useMaestroDeSalas,
  useRegistro,
  useTiposDeEquipo,
  type FiltroDeMovimientos,
} from './equiposDatos'

/**
 * Equipos: el inventario entero del campus en una lista, con la ficha de cada
 * aparato y sus entradas y salidas.
 *
 * Hasta aquí el inventario solo se veía **sala a sala** —la ficha del aula, la
 * hoja impresa del edificio— y eso contesta «qué hay en el 1.7», pero no «dónde
 * está el número de serie X5LK…», «qué proyectores tienen más de seis años» ni
 * «qué ha entrado y qué ha salido este trimestre». Son las preguntas de quien
 * gestiona el parque, y las tres se contestan aquí con un buscador y tres
 * filtros.
 *
 * Tres pestañas, porque son tres preguntas distintas:
 *
 *  - **Inventario**: los equipos, uno por fila, con su ficha debajo al tocarlos.
 *  - **Entradas y salidas**: el histórico de altas, bajas y traslados de todo el
 *    parque, por fechas. Es lo que se entrega cuando se pide justificar a dónde
 *    fue un equipo.
 *  - **Vida útil por tipo**: cuántos años dura cada clase de aparato. Es lo que
 *    convierte una fecha de compra en «obsoleto» o «caduca este año».
 *
 * Cualquiera del personal la abre y busca; **cambiar es de supervisor y de
 * administrador**, y eso lo decide la base, no esta pantalla.
 */

type Pestana = 'inventario' | 'movimientos' | 'vida'

const POR_PAGINA = 100

export function EquiposPage({ role }: { role: Role }): React.ReactElement {
  const puedeEditar = role === 'supervisor' || role === 'admin'
  const [pestana, setPestana] = useState<Pestana>('inventario')

  const pestanas: Array<{ id: Pestana; label: string }> = [
    { id: 'inventario', label: 'Inventario' },
    { id: 'movimientos', label: 'Entradas y salidas' },
    { id: 'vida', label: 'Vida útil por tipo' },
  ]

  return (
    <div className="mx-auto max-w-4xl p-4">
      <h1 className="text-xl font-semibold">Equipos</h1>
      <div className="scroll-x -mx-1 mt-3 flex gap-2 px-1 pb-1">
        {pestanas.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setPestana(p.id)}
            aria-pressed={pestana === p.id}
            className={`key min-h-11 shrink-0 px-3 text-sm ${pestana === p.id ? 'key-accent' : 'key-quiet text-muted'}`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {pestana === 'inventario' && <Inventario puedeEditar={puedeEditar} />}
      {pestana === 'movimientos' && <Movimientos />}
      {pestana === 'vida' && <VidaUtilPorTipo puedeEditar={puedeEditar} />}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Inventario
// -----------------------------------------------------------------------------

function Inventario({ puedeEditar }: { puedeEditar: boolean }): React.ReactElement {
  const { data, isPending, isError, error, refetch } = useRegistro()
  const maestro = useMaestroDeSalas()
  const tipos = useTiposDeEquipo()
  const [filtro, setFiltro] = useState<FiltroDeEquipos>(FILTRO_INICIAL)
  const [abierto, setAbierto] = useState<string | null>(null)
  const [cuantos, setCuantos] = useState(POR_PAGINA)
  const [entrada, setEntrada] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)

  const equipos = useMemo(() => data ?? [], [data])
  const lista = useMemo(() => ordenarEquipos(filtrarEquipos(equipos, filtro)), [equipos, filtro])
  const resumen = useMemo(() => resumenDeEquipos(equipos), [equipos])
  const tiposConEquipos = useMemo(() => {
    const usados = new Map<string, string>()
    for (const e of equipos) usados.set(e.asset_type_id, e.type_name)
    return [...usados].sort((a, b) => a[1].localeCompare(b[1], 'es'))
  }, [equipos])

  function poner<K extends keyof FiltroDeEquipos>(k: K, v: FiltroDeEquipos[K]): void {
    setFiltro((f) => ({ ...f, [k]: v }))
    setCuantos(POR_PAGINA)
  }

  const filtrado = JSON.stringify(filtro) !== JSON.stringify(FILTRO_INICIAL)

  return (
    <>
      {isPending && <p className="mt-4 text-sm text-muted">Cargando el inventario…</p>}
      {isError && (
        <div className="mt-4 rounded-ctl bg-crit-fill p-3 text-sm text-crit-ink">
          {mensajeDeFallo(error)}{' '}
          <button type="button" onClick={() => void refetch()} className="underline">
            Reintentar
          </button>
        </div>
      )}

      {data && (
        <>
          <p className="mt-3 text-sm text-muted">
            {resumen.activos} equipos en las aulas
            {resumen.averiados > 0 && ` · ${resumen.averiados} averiados`}
            {resumen.obsoletos > 0 && ` · ${resumen.obsoletos} obsoletos`}
            {resumen.proximos > 0 && ` · ${resumen.proximos} caducan este año`}
            {` · ${resumen.sinSerie} sin número de serie · ${resumen.sinCompra} sin fecha de compra`}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {puedeEditar && (
              <button
                type="button"
                onClick={() => {
                  setEntrada((v) => !v)
                  setAviso(null)
                }}
                className="key key-accent min-h-11 px-3 text-sm"
              >
                {entrada ? 'Cancelar la entrada' : 'Registrar entrada'}
              </button>
            )}
          </div>

          {aviso && <p className="mt-3 text-sm text-ok">{aviso}</p>}

          {entrada && (
            <EntradaDeEquipo
              tipos={tipos ?? []}
              salas={maestro?.salas ?? []}
              edificios={maestro?.edificios ?? []}
              onFin={(m) => {
                setEntrada(false)
                setAviso(m)
              }}
            />
          )}

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <input
              type="search"
              value={filtro.consulta}
              onChange={(e) => poner('consulta', e.target.value)}
              placeholder="Buscar: número de serie, inventario, modelo, aula, hostname…"
              aria-label="Buscar equipos"
              className="h-11 rounded-ctl border border-line bg-surface px-3 text-base sm:col-span-2"
            />
            <select
              value={filtro.tipo}
              onChange={(e) => poner('tipo', e.target.value)}
              aria-label="Tipo de equipo"
              className="h-11 rounded-ctl border border-line bg-surface px-2 text-base"
            >
              <option value="">Todos los tipos</option>
              {tiposConEquipos.map(([id, nombre]) => (
                <option key={id} value={id}>
                  {nombre}
                </option>
              ))}
            </select>
            <select
              value={filtro.edificio}
              onChange={(e) => poner('edificio', e.target.value)}
              aria-label="Edificio"
              className="h-11 rounded-ctl border border-line bg-surface px-2 text-base"
            >
              <option value="">Todos los edificios</option>
              {(maestro?.edificios ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name}
                </option>
              ))}
            </select>
            <select
              value={filtro.estado}
              onChange={(e) => poner('estado', e.target.value as FiltroDeEquipos['estado'])}
              aria-label="Estado"
              className="h-11 rounded-ctl border border-line bg-surface px-2 text-base"
            >
              <option value="activos">En las aulas (instalados y averiados)</option>
              <option value="instalado">Solo instalados</option>
              <option value="averiado">Solo averiados</option>
              <option value="retirado">Retirados</option>
              <option value="todos">Todos, también los retirados</option>
            </select>
            <select
              value={filtro.vida}
              onChange={(e) => poner('vida', e.target.value as FiltroDeEquipos['vida'])}
              aria-label="Vida útil"
              className="h-11 rounded-ctl border border-line bg-surface px-2 text-base"
            >
              <option value="todas">Cualquier vida útil</option>
              <option value="obsoleto">Obsoletos</option>
              <option value="proximo">Caducan en menos de un año</option>
              <option value="vigente">Vigentes</option>
              <option value="sin_datos">Sin datos de vida útil</option>
            </select>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={filtro.soloOrdenadores}
                onChange={(e) => poner('soloOrdenadores', e.target.checked)}
              />
              Solo ordenadores
            </label>
            {filtrado && (
              <button
                type="button"
                onClick={() => {
                  setFiltro(FILTRO_INICIAL)
                  setCuantos(POR_PAGINA)
                }}
                className="justify-self-start text-sm text-accent underline-offset-4 hover:underline"
              >
                Quitar filtros
              </button>
            )}
          </div>

          <p className="mt-3 text-sm text-muted">
            {lista.length === 1 ? '1 equipo' : `${lista.length} equipos`}
            {filtrado ? ' con estos filtros' : ''}
          </p>

          <ul className="mt-2 divide-y divide-hair">
            {lista.slice(0, cuantos).map((e) => (
              <FilaDeEquipo
                key={e.id}
                equipo={e}
                abierto={abierto === e.id}
                onTocar={() => setAbierto((a) => (a === e.id ? null : e.id))}
              >
                {abierto === e.id && (
                  <FichaDeEquipo
                    equipo={e}
                    puedeEditar={puedeEditar}
                    salas={maestro?.salas ?? []}
                    edificios={maestro?.edificios ?? []}
                    onCerrar={() => setAbierto(null)}
                  />
                )}
              </FilaDeEquipo>
            ))}
            {lista.length === 0 && <li className="py-3 text-sm text-muted">Ningún equipo con estos filtros.</li>}
          </ul>
          {lista.length > cuantos && (
            <button
              type="button"
              onClick={() => setCuantos((n) => n + POR_PAGINA)}
              className="key key-quiet mt-3 min-h-11 w-full px-3 text-sm"
            >
              Ver {Math.min(POR_PAGINA, lista.length - cuantos)} más (quedan {lista.length - cuantos})
            </button>
          )}

          <ExportarConVistaPrevia
            titulo="Inventario de equipos: Excel y PDF"
            descripcion={`Los ${lista.length} equipos de la lista${filtrado ? ' (con los filtros de arriba)' : ''}, con toda su ficha, y sus entradas y salidas. Se ven antes de descargar.`}
            disabled={lista.length === 0}
            preparar={async () => {
              const ids = new Set(lista.map((e) => e.id))
              const movimientos = (await cargarMovimientos({ clase: '', desde: '', hasta: '', edificio: '' })).filter((m) =>
                ids.has(m.asset_id),
              )
              return {
                titulo: 'Inventario de equipos',
                resumen: describirFiltro(lista.length, filtro, tiposConEquipos, maestro?.edificios ?? []),
                nombreBase: 'Inventario de equipos',
                hojas: [
                  { hoja: hojaDeEquipos(lista), pdf: { columnas: COLUMNAS_DE_EQUIPOS_EN_PDF } },
                  { hoja: hojaDeEntradasYSalidas(movimientos), pdf: { incluir: false } },
                ],
              }
            }}
          />
        </>
      )}
    </>
  )
}

/**
 * Las columnas de la ficha que van al PDF. El Excel lleva las veintinueve; en
 * un A4 apaisado caben estas, que son las que se piden en papel: dónde está,
 * qué es, cómo se identifica y cuándo hay que renovarlo.
 */
const COLUMNAS_DE_EQUIPOS_EN_PDF = [
  'Edificio',
  'Aula',
  'Tipo',
  'Nombre en el aula',
  'Marca',
  'Modelo',
  'N.º de serie',
  'N.º de inventario',
  'Estado',
  'Adquisición',
  'Garantía hasta',
  'Fin de vida',
  'Vida útil',
  'Hostname',
]

const ESTADO_DEL_FILTRO: Record<FiltroDeEquipos['estado'], string> = {
  activos: 'en las aulas',
  instalado: 'instalados',
  averiado: 'averiados',
  retirado: 'retirados',
  todos: 'también los retirados',
}

const VIDA_DEL_FILTRO: Record<FiltroDeEquipos['vida'], string | null> = {
  todas: null,
  obsoleto: 'obsoletos',
  proximo: 'caducan en menos de un año',
  vigente: 'vigentes',
  sin_datos: 'sin datos de vida útil',
}

/** «42 equipos · Proyector · edificio H · obsoletos»: lo que dice la cabecera del papel. */
function describirFiltro(
  cuantos: number,
  f: FiltroDeEquipos,
  tipos: Array<[string, string]>,
  edificios: Array<{ id: string; code: string }>,
): string {
  return [
    `${cuantos} ${cuantos === 1 ? 'equipo' : 'equipos'} ${ESTADO_DEL_FILTRO[f.estado]}`,
    f.tipo ? tipos.find(([id]) => id === f.tipo)?.[1] : null,
    f.edificio ? `edificio ${edificios.find((b) => b.id === f.edificio)?.code ?? ''}` : null,
    VIDA_DEL_FILTRO[f.vida],
    f.soloOrdenadores ? 'solo ordenadores' : null,
    f.consulta.trim() ? `búsqueda «${f.consulta.trim()}»` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

function FilaDeEquipo({
  equipo: e,
  abierto,
  onTocar,
  children,
}: {
  equipo: EquipoDelRegistro
  abierto: boolean
  onTocar: () => void
  children: React.ReactNode
}): React.ReactElement {
  const nombre = e.label && e.label !== e.type_name ? `${e.type_name} · ${e.label}` : e.type_name
  return (
    <li className="py-2">
      <button
        type="button"
        onClick={onTocar}
        aria-expanded={abierto}
        className="flex w-full flex-col items-start gap-1 rounded-ctl py-1 text-left"
      >
        <span className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{nombre}</span>
          <span className="text-sm text-muted">
            {e.room_code ? `${e.room_code}${e.building_code ? ` ${e.building_code}` : ''}` : 'Sin sala'}
          </span>
          {e.status !== 'instalado' && (
            <span
              className={`shrink-0 rounded-tag px-1.5 py-0.5 text-[0.6875rem] font-medium ${
                e.status === 'averiado' ? 'bg-crit-tint text-crit' : 'bg-sunken text-muted'
              }`}
            >
              {ASSET_STATUS_LABELS[e.status]}
            </span>
          )}
          {e.estado_vida !== 'sin_datos' && <EtiquetaDeVida vida={e.estado_vida} />}
          {!e.confirmed && e.status !== 'retirado' && (
            <span className="shrink-0 rounded-tag bg-warn-tint px-1.5 py-0.5 text-[0.6875rem] font-medium text-warn">
              Sin validar
            </span>
          )}
        </span>
        <span className="flex w-full flex-wrap gap-x-3 text-xs text-muted">
          {(e.brand || e.model) && <span>{[e.brand, e.model].filter(Boolean).join(' ')}</span>}
          <span className="font-mono">{e.serial ? `S/N ${e.serial}` : 'Sin número de serie'}</span>
          {e.inventory_tag && <span className="font-mono">Inv. {e.inventory_tag}</span>}
          {e.hostname && <span className="font-mono">{e.hostname}</span>}
        </span>
      </button>
      {children}
    </li>
  )
}

// -----------------------------------------------------------------------------
// Entradas y salidas
// -----------------------------------------------------------------------------

const CLASES: ClaseDeMovimiento[] = ['alta', 'baja', 'traslado', 'sustitucion', 'averia']

function Movimientos(): React.ReactElement {
  const maestro = useMaestroDeSalas()
  const [filtro, setFiltro] = useState<FiltroDeMovimientos>({ clase: '', desde: '', hasta: '', edificio: '' })
  const [cuantos, setCuantos] = useState(POR_PAGINA)

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: [...CLAVE_MOVIMIENTOS, 'lista', filtro],
    queryFn: () => cargarMovimientos(filtro),
  })

  function poner<K extends keyof FiltroDeMovimientos>(k: K, v: FiltroDeMovimientos[K]): void {
    setFiltro((f) => ({ ...f, [k]: v }))
    setCuantos(POR_PAGINA)
  }

  const lista = data ?? []
  const entradas = lista.filter((m) => m.kind === 'alta').length
  const salidas = lista.filter((m) => m.kind === 'baja').length

  return (
    <>
      <p className="mt-3 text-sm text-muted">
        Cada alta, baja, traslado y sustitución de un equipo, con quién lo hizo y por qué. Los equipos que
        trajo el importador no tienen evento de alta: su entrada es anterior a la aplicación.
      </p>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <select
          value={filtro.clase}
          onChange={(e) => poner('clase', e.target.value)}
          aria-label="Clase de movimiento"
          className="h-11 rounded-ctl border border-line bg-surface px-2 text-base"
        >
          <option value="">Todos los movimientos</option>
          {CLASES.map((c) => (
            <option key={c} value={c}>
              {MOVIMIENTO_LABEL[c]}
            </option>
          ))}
        </select>
        <select
          value={filtro.edificio}
          onChange={(e) => poner('edificio', e.target.value)}
          aria-label="Edificio"
          className="h-11 rounded-ctl border border-line bg-surface px-2 text-base"
        >
          <option value="">Todos los edificios</option>
          {(maestro?.edificios ?? []).map((b) => (
            <option key={b.id} value={b.code}>
              {b.code} — {b.name}
            </option>
          ))}
        </select>
        <label className="block text-sm">
          <span className="text-muted">Desde</span>
          <input
            type="date"
            value={filtro.desde}
            onChange={(e) => poner('desde', e.target.value)}
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-base"
          />
        </label>
        <label className="block text-sm">
          <span className="text-muted">Hasta (incluido)</span>
          <input
            type="date"
            value={filtro.hasta}
            onChange={(e) => poner('hasta', e.target.value)}
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-base"
          />
        </label>
      </div>

      {isPending && <p className="mt-4 text-sm text-muted">Cargando…</p>}
      {isError && (
        <div className="mt-4 rounded-ctl bg-crit-fill p-3 text-sm text-crit-ink">
          {mensajeDeFallo(error)}{' '}
          <button type="button" onClick={() => void refetch()} className="underline">
            Reintentar
          </button>
        </div>
      )}

      {data && (
        <>
          <p className="mt-3 text-sm text-muted">
            {lista.length} movimientos · {entradas} entradas · {salidas} salidas
          </p>
          <ul className="mt-2 divide-y divide-hair">
            {lista.slice(0, cuantos).map((m) => (
              <li key={m.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span
                    className={`font-medium ${m.kind === 'alta' ? 'text-ok' : m.kind === 'baja' ? 'text-crit' : ''}`}
                  >
                    {MOVIMIENTO_LABEL[m.kind] ?? m.kind}
                  </span>
                  <span>{m.label && m.label !== m.type_name ? `${m.type_name} · ${m.label}` : m.type_name}</span>
                  <span className="text-muted">
                    {m.room_code ? `${m.room_code}${m.building_code ? ` ${m.building_code}` : ''}` : ''}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-3 text-xs text-muted">
                  <span>{fechaCorta(m.occurred_at)}</span>
                  {m.serial && <span className="font-mono">S/N {m.serial}</span>}
                  {m.destino && <span>{DESTINO_LABEL[m.destino] ?? m.destino}</span>}
                  {m.by_name && <span>{m.by_name}</span>}
                </div>
                {m.motivo && <p className="mt-0.5 text-xs text-muted">{m.motivo}</p>}
              </li>
            ))}
            {lista.length === 0 && <li className="py-3 text-sm text-muted">Ningún movimiento con estos filtros.</li>}
          </ul>
          {lista.length > cuantos && (
            <button
              type="button"
              onClick={() => setCuantos((n) => n + POR_PAGINA)}
              className="key key-quiet mt-3 min-h-11 w-full px-3 text-sm"
            >
              Ver {Math.min(POR_PAGINA, lista.length - cuantos)} más (quedan {lista.length - cuantos})
            </button>
          )}

          <ExportarConVistaPrevia
            titulo="Entradas y salidas: Excel y PDF"
            descripcion={`Los ${lista.length} movimientos de la lista, del más antiguo al más reciente. Se ven antes de descargar.`}
            disabled={lista.length === 0}
            preparar={async () => ({
              titulo: 'Entradas y salidas de equipos',
              resumen: `${lista.length} movimientos · ${entradas} entradas · ${salidas} salidas${
                filtro.desde || filtro.hasta
                  ? ` · ${filtro.desde ? `desde el ${filtro.desde.split('-').reverse().join('/')}` : ''}${filtro.desde && filtro.hasta ? ' ' : ''}${filtro.hasta ? `hasta el ${filtro.hasta.split('-').reverse().join('/')}` : ''}`
                  : ''
              }`,
              nombreBase: 'Entradas y salidas de equipos',
              hojas: [{ hoja: hojaDeEntradasYSalidas(lista) }],
            })}
          />
        </>
      )}
    </>
  )
}

// -----------------------------------------------------------------------------
// Vida útil por tipo
// -----------------------------------------------------------------------------

interface TipoConVida {
  id: string
  name: string
  vida_util_anyos: number | null
}

/**
 * Cuántos años dura cada clase de aparato.
 *
 * Va por tipo y no equipo a equipo porque es una política, no un dato del
 * aparato: «los ordenadores se renuevan a los cinco años». Con eso puesto, cada
 * equipo con fecha de compra sabe solo cuándo deja de estar vigente. Nace vacía
 * a propósito: una vida útil inventada convertiría en «obsoletos» equipos que
 * nadie ha decidido renovar.
 */
function VidaUtilPorTipo({ puedeEditar }: { puedeEditar: boolean }): React.ReactElement {
  const qc = useQueryClient()
  const registro = useRegistro()
  const { data, isPending, isError, error } = useQuery({
    queryKey: ['asset-types-vida'],
    queryFn: async (): Promise<TipoConVida[]> => {
      const { data, error } = await supabase
        .from('asset_types')
        .select('id, name, vida_util_anyos')
        .is('merged_into', null)
        .order('name')
      if (error) throw new Error(error.message)
      return (data ?? []) as TipoConVida[]
    },
  })

  const porTipo = useMemo(() => {
    const m = new Map<string, { total: number; conCompra: number }>()
    for (const e of registro.data ?? []) {
      if (e.status === 'retirado') continue
      const c = m.get(e.asset_type_id) ?? { total: 0, conCompra: 0 }
      c.total++
      if (e.acquired_at) c.conCompra++
      m.set(e.asset_type_id, c)
    }
    return m
  }, [registro.data])

  const tipos = (data ?? []).filter((t) => (porTipo.get(t.id)?.total ?? 0) > 0 || t.vida_util_anyos !== null)

  return (
    <>
      <p className="mt-3 text-sm text-muted">
        El fin de vida de un equipo es su fecha de adquisición más los años de su tipo. Un tipo sin años
        deja sus equipos «sin datos de vida útil», en vez de inventarse que están vigentes.
      </p>
      {isPending && <p className="mt-4 text-sm text-muted">Cargando…</p>}
      {isError && <p className="mt-4 text-sm text-crit">{mensajeDeFallo(error)}</p>}
      <ul className="mt-3 divide-y divide-hair">
        {tipos.map((t) => (
          <FilaDeVida
            key={t.id}
            tipo={t}
            cuenta={porTipo.get(t.id)}
            puedeEditar={puedeEditar}
            onGuardado={() => {
              void qc.invalidateQueries({ queryKey: ['asset-types-vida'] })
              void qc.invalidateQueries({ queryKey: CLAVE_REGISTRO })
            }}
          />
        ))}
      </ul>
    </>
  )
}

function FilaDeVida({
  tipo,
  cuenta,
  puedeEditar,
  onGuardado,
}: {
  tipo: TipoConVida
  cuenta: { total: number; conCompra: number } | undefined
  puedeEditar: boolean
  onGuardado: () => void
}): React.ReactElement {
  const [valor, setValor] = useState(tipo.vida_util_anyos?.toString() ?? '')
  const n = valor.trim() === '' ? null : Number(valor)
  const valido = n === null || (Number.isInteger(n) && n >= 1 && n <= 50)
  const cambiado = n !== tipo.vida_util_anyos

  const guardar = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('asset_type_vida_util', { p_type: tipo.id, p_anyos: n })
      if (error) throw error
    },
    onSuccess: onGuardado,
  })

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
      <div className="min-w-40 flex-1">
        <p className="text-sm font-medium">{tipo.name}</p>
        <p className="text-xs text-muted">
          {cuenta ? `${cuenta.total} en las aulas · ${cuenta.conCompra} con fecha de compra` : 'Ninguno en las aulas'}
        </p>
      </div>
      {puedeEditar ? (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              inputMode="numeric"
              aria-label={`Años de vida útil de ${tipo.name}`}
              aria-invalid={!valido}
              placeholder="—"
              className={`h-11 w-20 rounded-ctl border bg-surface px-2 text-center text-base ${valido ? 'border-line' : 'border-crit'}`}
            />
            años
          </label>
          <button
            type="button"
            disabled={!cambiado || !valido || guardar.isPending}
            onClick={() => guardar.mutate()}
            className="key key-accent min-h-11 px-3 text-sm"
          >
            {guardar.isPending ? 'Guardando…' : 'Guardar'}
          </button>
          {!valido && <p className="basis-full text-xs text-crit">Un número entero de años, entre 1 y 50.</p>}
          {guardar.isError && <p className="basis-full text-xs text-crit">{mensajeDeFallo(guardar.error)}</p>}
        </>
      ) : (
        <p className="text-sm">{tipo.vida_util_anyos ? `${tipo.vida_util_anyos} años` : 'Sin definir'}</p>
      )}
    </li>
  )
}
