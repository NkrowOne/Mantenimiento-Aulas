import { useDeferredValue, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useConfirmar, type PeticionConfirmar } from '@/components/Confirmar'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { pullMaster } from '@/sync/pull'
import { identifyAsset, modelLabel, resolveModel, resolveType } from '@/domain/inventory'
import { norm, displayRoomCode } from '@/domain/normalize'
import { diaEnMadrid, diaMasDias, fechaCorta } from '@/domain/fechas'
import {
  ASSET_STATUS_LABELS,
  REMOVAL_DESTINO_HINTS,
  REMOVAL_DESTINO_LABELS,
  type Asset,
  type AssetModel,
  type AssetStatus,
  type AssetType,
  type RemovalDestino,
  type Role,
} from '@/domain/types'
import { SelectorDeModelo } from './SelectorDeModelo'
import { CamposPropios } from './CamposPropios'
import { asignarModelo, guardarAsset, pedirRetirada, type ModeloElegido } from './useRoomInventory'

/**
 * El inventario entero, para trabajarlo sentado.
 *
 * Es la pieza que faltaba y la que el iPad no puede dar. En el aula se corrige
 * lo que se tiene delante —un equipo cada vez— y eso está bien: es el sitio
 * donde se sabe la verdad. Pero hay 1.094 equipos y ninguno tiene marca; ir uno
 * por uno desde las aulas son 1.094 viajes, y ese trabajo no se hace nunca.
 *
 * Aquí se hace en bloque: se filtra por tipo y edificio, se seleccionan
 * cuarenta, se les pone el modelo de una vez. Y se exporta, que es lo que
 * permite cruzar el inventario con una factura o con el listado del proveedor
 * sin pedirle nada a nadie.
 *
 * Todo sale del espejo local, así que también funciona sin cobertura y en el
 * móvil — donde la misma lista se pinta como fichas en vez de como tabla, porque
 * una tabla de nueve columnas en un iPhone no es una tabla, es un rompecabezas.
 */

type Orden = 'sala' | 'tipo' | 'modelo' | 'instalado' | 'estado'

interface Fila {
  asset: Asset
  ident: ReturnType<typeof identifyAsset>
  tipo: AssetType | null
  modelo: AssetModel | null
  salaCodigo: string
  salaNombre: string
  edificioId: string | null
  edificioCodigo: string
  /** Todo lo buscable, ya normalizado. Se calcula una vez, no por tecla. */
  busqueda: string
}

const SIN_MODELO = '__sin_modelo__'
const SIN_SERIE = '__sin_serie__'
const SIN_VALIDAR = '__sin_validar__'
const SIN_FECHA = '__sin_fecha__'
/*
 * Y los dos de la garantía.
 *
 * `warranty_until` se podía escribir desde el primer día y no había forma de
 * preguntar por él: un dato que solo se escribe es un dato que nadie rellena, y
 * la pregunta que lo justifica —«¿esto lo arreglamos nosotros o lo manda el
 * fabricante?»— llega siempre con el aparato ya roto y con prisa.
 *
 * `EN_GARANTIA` es el que se usa con la avería delante. `GARANTIA_PRONTO` es el
 * que se mira una vez al trimestre: los 90 días son el margen en el que todavía
 * se puede reclamar algo que va justo antes de que deje de poderse.
 */
const EN_GARANTIA = '__en_garantia__'
const GARANTIA_PRONTO = '__garantia_pronto__'
const DIAS_DE_AVISO = 90
/*
 * Y el fin de soporte, que es del MODELO y no del aparato.
 *
 * `asset_models.eol_on` se pintaba en dos pantallas y no había forma de
 * escribirlo ni de preguntar por él, así que la pregunta que justifica la columna
 * —«qué hay que cambiar el curso que viene»— seguía siendo una conversación. Con
 * esto es un filtro: sale la lista de aparatos concretos, con su aula, que es lo
 * que hace falta para presupuestarlo.
 */
const SIN_SOPORTE = '__sin_soporte__'

export function EquiposPage({ role, userId }: { role: Role; userId: string | null }): React.ReactElement {
  const [texto, setTexto] = useState('')
  const consulta = useDeferredValue(texto)
  const [edificio, setEdificio] = useState('')
  const [tipoId, setTipoId] = useState('')
  const [estado, setEstado] = useState<AssetStatus | ''>('')
  const [pega, setPega] = useState('')
  const [orden, setOrden] = useState<Orden>('sala')
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set())
  const [editando, setEditando] = useState<string | null>(null)
  const [nota, setNota] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const { pedir, dialogo } = useConfirmar()

  const puedeValidar = role === 'supervisor' || role === 'admin'

  /*
   * Todo el inventario, resuelto de una pasada.
   *
   * Son ~1.100 equipos: cabe de sobra en memoria y evita cuatro consultas por
   * fila. Se recalcula solo cuando Dexie avisa de un cambio, así que corregir un
   * equipo actualiza la lista sin recargar nada.
   */
  const datos = useLiveQuery(async () => {
    const [assets, tipos, modelos, salas, zonas, edificios] = await Promise.all([
      db.assets.toArray(),
      db.assetTypes.toArray(),
      db.assetModels.toArray(),
      db.rooms.toArray(),
      db.zones.toArray(),
      db.buildings.orderBy('sort_order').toArray(),
    ])

    const tiposById = new Map(tipos.map((t) => [t.id, t]))
    const modelosById = new Map(modelos.map((m) => [m.id, m]))
    const salasById = new Map(salas.map((r) => [r.id, r]))
    const zonasById = new Map(zonas.map((z) => [z.id, z]))
    const edificiosById = new Map(edificios.map((b) => [b.id, b]))

    const filas: Fila[] = assets.map((asset) => {
      const ident = identifyAsset(asset, tiposById, modelosById)
      const sala = asset.room_id ? salasById.get(asset.room_id) : undefined
      const zona = sala ? zonasById.get(sala.zone_id) : undefined
      const edif = zona ? edificiosById.get(zona.building_id) : undefined

      return {
        asset,
        ident,
        tipo: resolveType(tiposById, asset.asset_type_id),
        modelo: resolveModel(modelosById, asset.asset_model_id),
        salaCodigo: sala ? displayRoomCode(sala.code) : '',
        salaNombre: sala?.name ?? 'Sin sala',
        edificioId: edif?.id ?? null,
        edificioCodigo: edif?.code ?? '',
        busqueda: norm(
          [
            ident.etiqueta,
            ident.tipo,
            ident.marca,
            ident.modelo,
            ident.serie,
            asset.model ?? '',
            sala ? displayRoomCode(sala.code) : '',
            sala?.name ?? '',
            edif?.code ?? '',
            edif?.name ?? '',
          ].join(' '),
        ),
      }
    })

    return { filas, tipos: tipos.filter((t) => !t.merged_into), edificios }
  }, [])

  const filas = datos?.filas ?? []

  const visibles = useMemo(() => {
    const q = norm(consulta)
    /* Se resuelven una vez por filtrado y no por fila: son 1.094 equipos y
       `Intl.DateTimeFormat` no es gratis. */
    const hoy = diaEnMadrid()
    const limiteAviso = diaMasDias(DIAS_DE_AVISO)
    const out = filas.filter((f) => {
      if (q && !f.busqueda.includes(q)) return false
      if (edificio && f.edificioId !== edificio) return false
      if (tipoId && f.asset.asset_type_id !== tipoId && f.tipo?.id !== tipoId) return false
      if (estado && f.asset.status !== estado) return false
      if (pega === SIN_MODELO && f.asset.asset_model_id) return false
      if (pega === SIN_SERIE && f.asset.serial) return false
      if (pega === SIN_VALIDAR && f.asset.confirmed && !f.ident.modeloSinValidar) return false
      if (pega === SIN_FECHA && f.asset.installed_at) return false
      /* Se comparan cadenas `AAAA-MM-DD` y no fechas: `warranty_until` es un
         `date` sin hora, y convertirlo a `Date` lo mete en un huso —el aparato
         dejaría de estar en garantía a las 02:00 del día anterior en verano. */
      if (pega === EN_GARANTIA && !(f.asset.warranty_until && f.asset.warranty_until >= hoy)) {
        return false
      }
      if (
        pega === GARANTIA_PRONTO &&
        !(
          f.asset.warranty_until &&
          f.asset.warranty_until >= hoy &&
          f.asset.warranty_until <= limiteAviso
        )
      ) {
        return false
      }
      // Del modelo, no del equipo: es el fabricante quien deja de dar soporte, y
      // eso vale para las cuarenta unidades a la vez.
      if (pega === SIN_SOPORTE && !(f.modelo?.eol_on && f.modelo.eol_on <= hoy)) return false
      return true
    })

    const cmp = (a: Fila, b: Fila): number => {
      switch (orden) {
        case 'tipo':
          return (
            a.ident.tipo.localeCompare(b.ident.tipo, 'es') ||
            a.ident.etiqueta.localeCompare(b.ident.etiqueta, 'es', { numeric: true })
          )
        case 'modelo':
          return (
            a.ident.modeloLargo.localeCompare(b.ident.modeloLargo, 'es', { numeric: true }) ||
            a.salaCodigo.localeCompare(b.salaCodigo, 'es', { numeric: true })
          )
        case 'instalado':
          // Sin fecha al final, no al principio: «no consta» no es «lo más
          // antiguo», y ordenándolo como tal tapa lo que de verdad lleva años.
          return (
            (b.asset.installed_at ?? '').localeCompare(a.asset.installed_at ?? '') ||
            a.salaCodigo.localeCompare(b.salaCodigo, 'es', { numeric: true })
          )
        case 'estado':
          return (
            a.asset.status.localeCompare(b.asset.status, 'es') ||
            a.salaCodigo.localeCompare(b.salaCodigo, 'es', { numeric: true })
          )
        default:
          return (
            a.edificioCodigo.localeCompare(b.edificioCodigo, 'es', { numeric: true }) ||
            a.salaCodigo.localeCompare(b.salaCodigo, 'es', { numeric: true }) ||
            a.ident.etiqueta.localeCompare(b.ident.etiqueta, 'es', { numeric: true })
          )
      }
    }

    return [...out].sort(cmp)
  }, [filas, consulta, edificio, tipoId, estado, pega, orden])

  const elegidas = useMemo(
    () => visibles.filter((f) => seleccion.has(f.asset.id)),
    [visibles, seleccion],
  )

  /*
   * Asignar un modelo en bloque solo tiene sentido dentro de un mismo tipo.
   *
   * Es el error que se comete de verdad al seleccionar cuarenta filas de un
   * tirón: dejar un proyector con modelo de pantalla no lo detecta nadie
   * después. Se resuelve enseñando el botón solo cuando la selección es de un
   * tipo, y diciendo por qué cuando no lo es.
   */
  const tipoComun = useMemo(() => {
    const tipos = new Set(elegidas.map((f) => f.tipo?.id ?? f.asset.asset_type_id))
    return tipos.size === 1 ? [...tipos][0]! : null
  }, [elegidas])

  const alternar = (id: string): void =>
    setSeleccion((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const todasVisibles = visibles.length > 0 && visibles.every((f) => seleccion.has(f.asset.id))

  async function asignarEnBloque(modelo: ModeloElegido | null): Promise<void> {
    setOcupado(true)
    try {
      for (const f of elegidas) await asignarModelo(f.asset, modelo, userId)
      setNota(
        modelo
          ? `Modelo asignado a ${elegidas.length} equipo(s).`
          : `Modelo quitado de ${elegidas.length} equipo(s).`,
      )
      setSeleccion(new Set())
    } finally {
      setOcupado(false)
    }
  }

  async function cambiarEstadoEnBloque(status: AssetStatus): Promise<void> {
    setOcupado(true)
    try {
      for (const f of elegidas) await guardarAsset(f.asset, { status })
      setNota(`${elegidas.length} equipo(s) marcados como ${ASSET_STATUS_LABELS[status].toLowerCase()}.`)
      setSeleccion(new Set())
    } finally {
      setOcupado(false)
    }
  }

  /**
   * Pedir la retirada de los equipos elegidos.
   *
   * Antes esto escribía `status = 'retirado'` en cada uno con `guardarAsset`, y
   * era la puerta de atrás del control que el aula acababa de estrenar: cuarenta
   * equipos fuera del inventario de un clic, sin que ningún coordinador lo
   * autorizara, sin fila en «Retiradas por autorizar», sin el evento de baja en el
   * histórico de cada sala —así que el aparato desaparecía sin dejar rastro de
   * quién lo quitó— y sin que el almacén ingresara ni una unidad de los que
   * volvían a la estantería. Y lo podía pulsar un técnico, mientras en el aula el
   * mismo gesto sobre UN aparato exigía autorización.
   *
   * Ahora es el mismo camino que el del aula, en bloque: una solicitud por equipo
   * con su destino. Lo que las autoriza sigue siendo `decide_asset_removal`, que
   * es quien sabe hacer las cuatro escrituras juntas.
   *
   * Los que ya tenían una solicitud viva no cuentan como fallo: es el caso normal
   * de volver a seleccionar «todo» después de haber pedido unos cuantos.
   */
  async function pedirRetiradaEnBloque(destino: RemovalDestino, motivo: string): Promise<void> {
    setOcupado(true)
    try {
      let pedidas = 0
      let repetidas = 0
      for (const f of elegidas) {
        const r = await pedirRetirada(f.asset, destino, motivo, userId)
        if (r.ok) pedidas += 1
        else repetidas += 1
      }
      setNota(
        [
          pedidas > 0
            ? `Retirada pedida para ${pedidas} equipo(s) (${REMOVAL_DESTINO_LABELS[destino].toLowerCase()}).`
            : null,
          repetidas > 0 ? `${repetidas} ya la tenían pedida.` : null,
          pedidas > 0
            ? 'Siguen en sus salas hasta que un coordinador las autorice, en Datos → Retiradas por autorizar.'
            : null,
        ]
          .filter(Boolean)
          .join(' '),
      )
      setSeleccion(new Set())
    } finally {
      setOcupado(false)
    }
  }

  async function validarEnBloque(): Promise<void> {
    setOcupado(true)
    try {
      const { data, error } = await supabase.rpc('confirm_assets', {
        p_ids: elegidas.map((f) => f.asset.id),
      })
      if (error) throw error
      setNota(`${data as number} equipo(s) validado(s).`)
      setSeleccion(new Set())
      await pullMaster()
    } catch (err) {
      setNota(err instanceof Error ? err.message : 'No se ha podido validar.')
    } finally {
      setOcupado(false)
    }
  }

  function exportar(): void {
    const cabecera = [
      'Edificio', 'Sala', 'Nombre en la sala', 'Tipo', 'Marca', 'Modelo',
      'Nº de serie', 'Estado', 'Instalado el', 'Garantía hasta', 'Validado', 'Observaciones',
    ]
    const filas = visibles.map((f) => [
      f.edificioCodigo,
      f.salaCodigo,
      f.ident.etiqueta,
      f.ident.tipo,
      f.ident.marca,
      f.ident.modelo,
      f.ident.serie,
      ASSET_STATUS_LABELS[f.asset.status],
      f.asset.installed_at ? f.asset.installed_at.slice(0, 10) : '',
      f.asset.warranty_until ?? '',
      f.asset.confirmed ? 'sí' : 'no',
      f.asset.notes ?? '',
    ])

    /*
     * Punto y coma, no coma, y con BOM.
     *
     * Es lo que hace que el fichero se abra bien de un doble clic en el Excel en
     * español, que es donde va a acabar. Con comas, Excel mete la fila entera en
     * la columna A; sin BOM, se come las tildes.
     */
    const escapar = (v: string): string =>
      /[";\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
    const csv = [cabecera, ...filas].map((f) => f.map(escapar).join(';')).join('\r\n')

    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `inventario-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const sinModelo = filas.filter((f) => !f.asset.asset_model_id).length

  return (
    <div className="p-4 pb-24">
      <div className="section-head">
        <h2 className="eyebrow">Equipos instalados</h2>
      </div>

      {/* El titular. Con 1.094 equipos, «cuántos siguen sin modelo» es la única
          cifra que dice si este trabajo avanza. */}
      <p className="text-sm text-muted">
        {filas.length} equipos en el espejo de este dispositivo
        {sinModelo > 0 && (
          <>
            {' · '}
            <button
              type="button"
              onClick={() => {
                setPega(pega === SIN_MODELO ? '' : SIN_MODELO)
                setSeleccion(new Set())
              }}
              className="font-medium text-warn underline-offset-4 hover:underline"
            >
              {sinModelo} sin modelo
            </button>
          </>
        )}
        .
      </p>

      {/* --- Filtros ------------------------------------------------------ */}
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <label className="text-xs text-muted lg:col-span-2">
          Buscar
          <input
            type="search"
            value={texto}
            placeholder="Sala, tipo, marca, modelo, nº de serie…"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setTexto(e.target.value)}
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
          />
        </label>

        <label className="text-xs text-muted">
          Edificio
          <select
            value={edificio}
            onChange={(e) => setEdificio(e.target.value)}
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
          >
            <option value="">Todos</option>
            {(datos?.edificios ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} — {b.name}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs text-muted">
          Tipo
          <select
            value={tipoId}
            onChange={(e) => setTipoId(e.target.value)}
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
          >
            <option value="">Todos</option>
            {(datos?.tipos ?? [])
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name, 'es'))
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </label>

        <label className="text-xs text-muted">
          Estado
          {/*
            «Retirado» no está, y no es un olvido: `pullMaster` baja los equipos
            con `neq('status','retirado')`, así que un retirado no llega nunca al
            espejo de este dispositivo. Ofrecerlo era invitar a una consulta que
            esta pantalla no puede contestar — se elegía y salía «Ningún equipo
            cumple estos filtros», siempre, en un campus con cientos de retirados,
            sin nada que distinguiera «no hay» de «aquí no se ven».
          */}
          <select
            value={estado}
            onChange={(e) => setEstado(e.target.value as AssetStatus | '')}
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
          >
            <option value="">Todos</option>
            {(Object.keys(ASSET_STATUS_LABELS) as AssetStatus[])
              .filter((s) => s !== 'retirado')
              .map((s) => (
                <option key={s} value={s}>
                  {ASSET_STATUS_LABELS[s]}
                </option>
              ))}
          </select>
        </label>
      </div>

      <p className="mt-1 text-xs text-muted">
        Esta lista son los equipos vivos. Los retirados no se guardan en el dispositivo: se leen en
        el histórico de su sala.
      </p>

      {/* Los filtros que de verdad se usan para trabajar: «qué me falta». Van en
          chapas y no en otro desplegable porque son la lista de tareas. */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {(
          [
            [SIN_MODELO, 'Sin modelo'],
            [SIN_SERIE, 'Sin nº de serie'],
            [SIN_FECHA, 'Sin fecha de instalación'],
            [SIN_VALIDAR, 'Sin validar'],
            [EN_GARANTIA, 'En garantía'],
            [GARANTIA_PRONTO, `Garantía acaba en ${DIAS_DE_AVISO} días`],
            [SIN_SOPORTE, 'Modelo sin soporte'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={pega === id}
            onClick={() => {
              setPega(pega === id ? '' : id)
              setSeleccion(new Set())
            }}
            className={`key min-h-11 px-3 text-xs ${
              pega === id ? 'key-accent' : 'key-quiet text-muted'
            }`}
          >
            {label}
          </button>
        ))}

        <span className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted">
            Ordenar
            <select
              value={orden}
              onChange={(e) => setOrden(e.target.value as Orden)}
              className="h-11 rounded-ctl border border-line bg-surface px-2 text-xs text-ink"
            >
              <option value="sala">Por sala</option>
              <option value="tipo">Por tipo</option>
              <option value="modelo">Por modelo</option>
              <option value="instalado">Por antigüedad</option>
              <option value="estado">Por estado</option>
            </select>
          </label>
          <button
            type="button"
            onClick={exportar}
            disabled={visibles.length === 0}
            className="key key-quiet min-h-11 px-3 text-xs"
            title="Descarga lo que se ve ahora mismo, con los filtros puestos"
          >
            Exportar CSV
          </button>
        </span>
      </div>

      {/* --- Selección y acciones en bloque -------------------------------- */}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-y border-line py-2">
        <label className="flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={todasVisibles}
            onChange={() =>
              setSeleccion(todasVisibles ? new Set() : new Set(visibles.map((f) => f.asset.id)))
            }
            className="h-5 w-5 rounded border-line accent-[rgb(var(--accent))]"
          />
          {visibles.length} de {filas.length}
        </label>

        {elegidas.length > 0 && (
          <>
            <span className="text-xs font-semibold text-accent">
              {elegidas.length} seleccionado(s)
            </span>

            {tipoComun ? (
              <AsignarEnBloque
                typeId={tipoComun}
                deshabilitado={ocupado}
                onAsignar={(m) => void asignarEnBloque(m)}
              />
            ) : (
              <span className="text-xs text-muted">
                Para poner el modelo, filtra por un solo tipo: un modelo de proyector no vale para
                una pantalla.
              </span>
            )}

            <button
              type="button"
              disabled={ocupado}
              onClick={() =>
                void pedir({
                  titulo: `¿Marcar ${elegidas.length} equipo(s) como averiados?`,
                  consecuencias: [
                    'Salen marcados en la revisión de su sala.',
                    'Siguen contando en el inventario: averiado no es retirado.',
                  ],
                  confirmar: 'Marcar averiados',
                  tono: 'warn',
                }).then((si) => {
                  if (si) void cambiarEstadoEnBloque('averiado')
                })
              }
              className="key key-quiet min-h-11 px-3 text-xs"
            >
              Marcar averiados
            </button>

            {/* No retira: PIDE la retirada, con su destino, igual que el aula.
                El destino es la mitad de la decisión —solo «al almacén» suma la
                unidad a las existencias— y sin preguntarlo no hay forma de
                expresarlo. */}
            <PedirRetiradaEnBloque
              cuantos={elegidas.length}
              salas={new Set(elegidas.map((f) => f.salaCodigo)).size}
              deshabilitado={ocupado}
              onPedir={(destino, motivo) => void pedirRetiradaEnBloque(destino, motivo)}
              pedirConfirmacion={pedir}
            />

            {puedeValidar && (
              <button
                type="button"
                disabled={ocupado || !navigator.onLine}
                onClick={() => void validarEnBloque()}
                className="key key-accent min-h-11 px-3 text-xs"
                title={navigator.onLine ? undefined : 'Validar necesita conexión'}
              >
                Validar
              </button>
            )}
          </>
        )}
      </div>

      {nota && (
        <p aria-live="polite" className="mt-2 text-sm text-ok">
          {nota}
        </p>
      )}

      {/* --- La lista ------------------------------------------------------ */}
      {datos === undefined && <p className="mt-4 text-sm text-muted">Cargando…</p>}
      {datos && visibles.length === 0 && (
        <p className="mt-4 text-sm text-muted">
          Ningún equipo cumple estos filtros.{' '}
          <button
            type="button"
            onClick={() => {
              setTexto('')
              setEdificio('')
              setTipoId('')
              setEstado('')
              setPega('')
            }}
            className="font-medium text-accent underline-offset-4 hover:underline"
          >
            Quitarlos todos
          </button>
        </p>
      )}

      {/*
        Tabla en el ordenador, fichas en el móvil.

        No es la misma tabla encogida: nueve columnas en un iPhone son nueve
        columnas ilegibles. Son dos maquetaciones de los mismos datos, y por eso
        la fila vive en un componente que decide cómo pintarse.
      */}
      <ul className="mt-1 divide-y divide-line-soft">
        {/* Cabecera, solo donde hay sitio para ella. */}
        {visibles.length > 0 && (
          <li className="hidden items-center gap-3 py-2 lg:flex">
            <span className="w-5 shrink-0" />
            <span className="eyebrow w-28 shrink-0">Sala</span>
            <span className="eyebrow min-w-0 flex-1">Equipo</span>
            <span className="eyebrow w-56 shrink-0">Marca y modelo</span>
            <span className="eyebrow w-36 shrink-0">Nº de serie</span>
            <span className="eyebrow w-28 shrink-0">Instalado</span>
            <span className="w-28 shrink-0 lg:w-32" />
          </li>
        )}

        {visibles.slice(0, 400).map((f) => (
          <FilaEquipo
            key={f.asset.id}
            fila={f}
            seleccionada={seleccion.has(f.asset.id)}
            abierta={editando === f.asset.id}
            userId={userId}
            onSeleccionar={() => alternar(f.asset.id)}
            onAbrir={() => setEditando(editando === f.asset.id ? null : f.asset.id)}
          />
        ))}
      </ul>

      {visibles.length > 400 && (
        <p className="mt-3 text-xs text-muted">
          Se enseñan los primeros 400 de {visibles.length}. Afina los filtros — la exportación sí
          los lleva todos.
        </p>
      )}

      {dialogo}
    </div>
  )
}

/** El selector de modelo para la selección entera, plegado hasta que se usa. */
function AsignarEnBloque({
  typeId,
  deshabilitado,
  onAsignar,
}: {
  typeId: string
  deshabilitado: boolean
  onAsignar: (m: ModeloElegido | null) => void
}): React.ReactElement {
  const [abierto, setAbierto] = useState(false)

  if (!abierto) {
    return (
      <button
        type="button"
        disabled={deshabilitado}
        onClick={() => setAbierto(true)}
        className="key key-accent min-h-11 px-3 text-xs"
      >
        Poner marca y modelo
      </button>
    )
  }

  return (
    <div className="w-full max-w-md">
      <SelectorDeModelo
        typeId={typeId}
        value={null}
        onChange={(m) => {
          onAsignar(m)
          setAbierto(false)
        }}
      />
    </div>
  )
}

/**
 * Pedir la retirada de varios equipos a la vez, con su destino.
 *
 * Mismo panel que en el aula y por el mismo motivo: «se ha roto» y «me lo llevo
 * al almacén» son dos cosas distintas, y solo la segunda suma unidades a las
 * existencias. En bloque importa más todavía, porque cuarenta aparatos mal
 * clasificados son cuarenta descuadres.
 *
 * El motivo se pide una vez y vale para todos: en bloque siempre es el mismo
 * —«retirada del aula 2.4», «renovación del parque»— y pedirlo cuarenta veces
 * garantizaría que se quedara vacío.
 */
function PedirRetiradaEnBloque({
  cuantos,
  salas,
  deshabilitado,
  onPedir,
  pedirConfirmacion,
}: {
  cuantos: number
  salas: number
  deshabilitado: boolean
  onPedir: (destino: RemovalDestino, motivo: string) => void
  pedirConfirmacion: (p: PeticionConfirmar) => Promise<boolean>
}): React.ReactElement {
  const [abierto, setAbierto] = useState(false)
  /* El almacén por defecto, igual que en el aula: la retirada que más se pierde
     es la del aparato que está bien y vuelve a la estantería sin que nadie lo
     ingrese. */
  const [destino, setDestino] = useState<RemovalDestino>('almacen')
  const [motivo, setMotivo] = useState('')

  if (!abierto) {
    return (
      <button
        type="button"
        disabled={deshabilitado}
        onClick={() => setAbierto(true)}
        className="key key-quiet min-h-11 px-3 text-xs text-crit"
      >
        Pedir retirada
      </button>
    )
  }

  return (
    <div className="w-full max-w-md rounded-ctl border border-line bg-sunken p-3">
      <p className="text-xs font-medium">
        ¿A dónde van los {cuantos} equipos?
      </p>

      <div role="radiogroup" aria-label="Destino de los equipos" className="mt-2 grid gap-2">
        {(['baja', 'almacen'] as RemovalDestino[]).map((d) => (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={destino === d}
            onClick={() => setDestino(d)}
            className={`key min-h-11 px-3 py-2 text-left text-xs ${
              destino === d ? 'key-accent' : 'key-quiet text-muted'
            }`}
          >
            <span className="block font-semibold">{REMOVAL_DESTINO_LABELS[d]}</span>
            <span className="mt-0.5 block font-normal opacity-80">{REMOVAL_DESTINO_HINTS[d]}</span>
          </button>
        ))}
      </div>

      <label className="mt-2 block text-xs text-muted">
        Por qué
        <input
          type="text"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="Renovación del parque, se cierra el aula…"
          enterKeyHint="done"
          className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
        />
      </label>

      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() =>
            void pedirConfirmacion({
              titulo: `¿Pedir la retirada de ${cuantos} equipo(s)?`,
              detalle: `${REMOVAL_DESTINO_LABELS[destino]} · ${salas} sala(s) afectada(s).`,
              consecuencias: [
                'Se crea una solicitud por equipo. Ninguno sale del inventario todavía.',
                'Siguen contando en las revisiones de sus salas hasta que un coordinador las autorice.',
                destino === 'almacen'
                  ? 'Al autorizarlas, cada unidad entra en el almacén del artículo de su tipo.'
                  : 'Al autorizarlas, se dan por perdidas: no vuelven al almacén.',
                'El equipo y su historial se conservan: no se borra nada.',
              ],
              confirmar: 'Pedir la retirada',
              tono: destino === 'baja' ? 'crit' : 'warn',
              /* Se teclea por encima de cinco. No porque no se pueda deshacer
                 —una solicitud se rechaza en la bandeja— sino porque cuarenta
                 solicitudes son cuarenta decisiones que alguien tiene que tomar
                 una a una: el coste cae sobre otra persona. */
              escribir: cuantos > 5 ? (destino === 'baja' ? 'BAJA' : 'RETIRAR') : undefined,
            }).then((si) => {
              if (!si) return
              onPedir(destino, motivo)
              setAbierto(false)
              setMotivo('')
            })
          }
          className="key key-accent min-h-11 flex-1 px-2 text-xs"
        >
          Pedir la retirada
        </button>
        <button
          type="button"
          onClick={() => setAbierto(false)}
          className="key key-quiet min-h-11 px-3 text-xs text-muted"
        >
          Cancelar
        </button>
      </div>
    </div>
  )
}

function FilaEquipo({
  fila,
  seleccionada,
  abierta,
  userId,
  onSeleccionar,
  onAbrir,
}: {
  fila: Fila
  seleccionada: boolean
  abierta: boolean
  userId: string | null
  onSeleccionar: () => void
  onAbrir: () => void
}): React.ReactElement {
  const { asset, ident } = fila

  return (
    <li className={seleccionada ? 'bg-accent-tint/40' : ''}>
      <div className="flex items-center gap-3 py-2">
        <input
          type="checkbox"
          checked={seleccionada}
          onChange={onSeleccionar}
          aria-label={`Seleccionar ${ident.etiqueta}`}
          className="h-5 w-5 shrink-0 rounded border-line accent-[rgb(var(--accent))]"
        />

        <span className="w-28 shrink-0 truncate font-mono text-xs text-accent">
          {fila.edificioCodigo && `${fila.edificioCodigo} · `}
          {fila.salaCodigo || '—'}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{ident.etiqueta}</span>
          <span className="block truncate text-xs text-muted">
            {ident.tipo}
            {/* En el móvil, marca, modelo y serie caen aquí: no hay columnas
                donde ponerlos y son justo lo que se viene a mirar. */}
            <span className="lg:hidden">
              {ident.ficha ? ` · ${ident.ficha}` : ' · sin modelo ni serie'}
            </span>
          </span>
        </span>

        <span className="hidden w-56 shrink-0 truncate text-sm lg:block">
          {ident.modeloLargo === 'Sin modelo' ? (
            <span className="text-muted">Sin modelo</span>
          ) : (
            ident.modeloLargo
          )}
          {ident.modeloSinValidar && (
            <span className="ml-1.5 rounded-tag bg-warn-tint px-1 py-0.5 text-[0.625rem] font-medium text-warn">
              sin validar
            </span>
          )}
        </span>

        <span className="hidden w-36 shrink-0 truncate font-mono text-xs lg:block">
          {ident.serie || <span className="text-muted">—</span>}
        </span>

        <span className="hidden w-28 shrink-0 truncate text-xs text-muted lg:block">
          {asset.installed_at ? fechaCorta(asset.installed_at) : 'no consta'}
          {/* Y la garantía debajo, solo si queda. Filtrar por «en garantía» sin
              que la columna diga hasta cuándo obliga a abrir cada fila para saber
              cuál de los doce corre más prisa. Vencida no se pinta: sería ruido
              en el 90% de las filas y no cambia ninguna decisión. */}
          {asset.warranty_until && asset.warranty_until >= diaEnMadrid() && (
            <span className="block text-[0.625rem] text-ok">
              garantía → {fechaCorta(asset.warranty_until)}
            </span>
          )}
        </span>

        {/* `w-28` y no `w-20`: con la chapa de estado dentro, ochenta píxeles
            no daban para «Averiado» más el botón, y la chapa se pintaba encima de
            la columna de la izquierda —la fecha en el ordenador, el nombre del
            equipo en el móvil, que ya iba justo—. Solo se ve al filtrar por un
            estado que no sea «instalado», que es justo cuando se está mirando. */}
        <span className="flex w-28 shrink-0 items-center justify-end gap-1 lg:w-32">
          {asset.status !== 'instalado' && (
            <span
              className={`shrink-0 whitespace-nowrap rounded-tag px-1.5 py-0.5 text-[0.625rem] font-medium ${
                asset.status === 'averiado' ? 'bg-crit-tint text-crit' : 'bg-sunken text-muted'
              }`}
            >
              {ASSET_STATUS_LABELS[asset.status]}
            </span>
          )}
          <button
            type="button"
            onClick={onAbrir}
            aria-expanded={abierta}
            className="key key-quiet min-h-11 px-2.5 text-xs text-muted"
          >
            {abierta ? 'Cerrar' : 'Editar'}
          </button>
        </span>
      </div>

      <div className="collapse-y" data-open={abierta} inert={!abierta}>
        <div>{abierta && <EditorEquipo fila={fila} userId={userId} />}</div>
      </div>
    </li>
  )
}

/**
 * Editar un equipo desde el ordenador.
 *
 * Es el mismo conjunto de campos que el aula, en dos columnas en vez de una: lo
 * que se corrige sentado es lo mismo que se corrige de pie, y dos formularios
 * distintos para los mismos datos acabarían aceptando cosas distintas.
 */
function EditorEquipo({ fila, userId }: { fila: Fila; userId: string | null }): React.ReactElement {
  const { asset, tipo } = fila
  const [serial, setSerial] = useState(asset.serial ?? '')
  const [label, setLabel] = useState(asset.label ?? '')
  const [notes, setNotes] = useState(asset.notes ?? '')

  const guardar = (patch: Partial<Asset>): void => void guardarAsset(asset, patch)

  return (
    <div className="mb-2 ml-8 grid gap-3 rounded-ctl border border-line bg-sunken p-3 lg:grid-cols-2">
      <div className="grid gap-3">
        <label className="text-xs text-muted">
          Nombre en la sala
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => label.trim() !== (asset.label ?? '') && guardar({ label: label.trim() || null })}
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
          />
        </label>

        <div className="text-xs text-muted">
          Marca y modelo
          <div className="mt-1">
            <SelectorDeModelo
              typeId={asset.asset_type_id}
              value={asset.asset_model_id}
              onChange={(m) => void asignarModelo(asset, m, userId)}
              autoFocus={false}
            />
          </div>
          {!asset.asset_model_id && asset.model?.trim() && (
            <p className="mt-1 text-xs text-muted">Antes ponía «{asset.model.trim()}».</p>
          )}
        </div>

        <label className="text-xs text-muted">
          Nº de serie
          <input
            type="text"
            value={serial}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setSerial(e.target.value)}
            onBlur={() => serial.trim() !== (asset.serial ?? '') && guardar({ serial: serial.trim() || null })}
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 font-mono text-sm text-ink"
          />
        </label>
      </div>

      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-muted">
            Instalado el
            <input
              type="date"
              value={asset.installed_at ? asset.installed_at.slice(0, 10) : ''}
              onChange={(e) =>
                guardar({
                  installed_at: e.target.value
                    ? new Date(`${e.target.value}T12:00:00`).toISOString()
                    : null,
                })
              }
              className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
            />
          </label>
          <label className="text-xs text-muted">
            Garantía hasta
            <input
              type="date"
              value={asset.warranty_until ?? ''}
              onChange={(e) => guardar({ warranty_until: e.target.value || null })}
              className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
            />
          </label>
        </div>

        {/* `heredados`: lo que dice el modelo para los campos «ambos». El valor
            de fábrica se escribe una vez en el catálogo y aquí se ve, salvo que
            esta unidad concreta diga otra cosa. */}
        <CamposPropios
          campos={(tipo?.spec_fields ?? []).filter((c) => c.en !== 'modelo')}
          valores={asset.specs ?? {}}
          heredados={fila.modelo?.specs ?? undefined}
          onChange={(specs) => guardar({ specs })}
        />

        <label className="text-xs text-muted">
          Observaciones
          <textarea
            value={notes}
            rows={2}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes.trim() !== (asset.notes ?? '') && guardar({ notes: notes.trim() || null })}
            className="mt-1 w-full rounded-ctl border border-line bg-surface px-2 py-1.5 text-sm text-ink"
          />
        </label>

        {fila.modelo && (
          <p className="text-xs text-muted">
            Modelo del catálogo: {modelLabel(fila.modelo)}
            {fila.modelo.eol_on && ` · sin soporte desde ${fechaCorta(fila.modelo.eol_on)}`}
          </p>
        )}
      </div>
    </div>
  )
}
