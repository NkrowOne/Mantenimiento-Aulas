import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { pullMaster } from '@/sync/pull'
import { useConfirmar } from '@/components/Confirmar'
import { fechaCorta } from '@/domain/fechas'
import { REMOVAL_DESTINO_LABELS, type RemovalDestino } from '@/domain/types'

/**
 * Las retiradas que esperan un sí o un no.
 *
 * El otro lado de «sacar de la sala». El técnico firma la solicitud en el aula
 * —donde se ve que un aparato sobra— y aquí alguien decide, que es lo que
 * convierte quitar inventario en una decisión y no en un toque sin vuelta atrás.
 *
 * Aprobar hace cuatro cosas de golpe, y por eso la hace el servidor en una sola
 * función: retira el equipo, deja el evento en el histórico de la sala, ingresa
 * la unidad en el almacén si vuelve allí, y cierra la solicitud. A medias
 * quedaría un aparato retirado que nadie ingresó — que es exactamente lo que
 * pasaba antes de que esto existiera, cada vez.
 *
 * El artículo de almacén al que iría la unidad se enseña **antes** de aprobar.
 * Es la única forma de que «devolver al almacén» signifique algo comprobable:
 * si ese tipo de equipo no tiene artículo con el que contarlo, más vale saberlo
 * ahora que descubrir el descuadre en el inventario de fin de curso.
 *
 * Y **qué aparato es**, con su marca, su modelo y su número de serie. Es lo que
 * separa esta pantalla de una lista de nombres: la respuesta a «¿esto se da de
 * baja o se arregla?» depende de si es el Lenovo de 2019 o el que se compró en
 * marzo, y quien decide no lo tiene delante.
 */

interface Fila {
  id: string
  asset_id: string
  destino: RemovalDestino
  reason: string | null
  requested_at: string
  requested_by_name: string | null
  asset_label: string | null
  serial: string | null
  /** «Ordenador Lenovo U3302», resuelto por el servidor siguiendo las fusiones. */
  identidad: string | null
  brand: string | null
  model_name: string | null
  /** El texto libre de antes del catálogo, para los equipos que nadie ha pasado. */
  model: string | null
  model_confirmed: boolean | null
  installed_at: string | null
  asset_confirmed: boolean
  type_name: string | null
  room_code: string | null
  room_name: string | null
  building_code: string | null
  stock_item_id: string | null
  stock_item_name: string | null
}

const RESULTADO: Record<string, string> = {
  rechazada: 'Rechazada. El equipo se queda donde está.',
  baja: 'Dado de baja. Fuera del inventario de la sala.',
  almacen: 'Retirado y devuelto al almacén: una unidad más en existencias.',
  almacen_sin_articulo:
    'Retirado, pero ese tipo de equipo no tiene artículo en el almacén: no se ha ingresado ninguna unidad. Enlázalo en Almacén y ajusta las existencias a mano.',
}

export function RetiradasPendientes(): React.ReactElement {
  const qc = useQueryClient()
  const [nota, setNota] = useState<string | null>(null)
  const { pedir, dialogo } = useConfirmar()

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['asset-removals', 'cola'],
    queryFn: async (): Promise<Fila[]> => {
      const { data: filas, error: err } = await supabase
        .from('asset_removal_queue')
        .select('*')
        // Las más viejas arriba: son las que llevan más tiempo bloqueando a
        // alguien que ya no puede tocar ese equipo.
        .order('requested_at', { ascending: true })
      if (err) throw err
      return (filas ?? []) as Fila[]
    },
  })

  const decidir = useMutation({
    mutationFn: async (input: { id: string; aprobar: boolean }): Promise<string> => {
      const { data: resultado, error: err } = await supabase.rpc('decide_asset_removal', {
        p_id: input.id,
        p_aprobar: input.aprobar,
        p_note: null,
      })
      if (err) throw err
      return (resultado as string) ?? ''
    },
    onSuccess: (resultado) => {
      setNota(RESULTADO[resultado] ?? 'Hecho.')
      void qc.invalidateQueries({ queryKey: ['asset-removals'] })
      // El almacén cambia con esto, y la sala también.
      void qc.invalidateQueries({ queryKey: ['stock'] })
      void pullMaster()
    },
  })

  const filas = data ?? []

  return (
    <section aria-labelledby="sec-retiradas" className="mt-8">
      <div className="section-head">
        <h2 id="sec-retiradas" className="eyebrow">
          Retiradas por autorizar
        </h2>
      </div>
      <p className="text-sm text-muted">
        Equipos que alguien quiere sacar de una sala. Hasta que se autoricen siguen ahí y siguen
        contando en las revisiones.
      </p>

      {isPending && <p className="mt-3 text-sm text-muted">Cargando…</p>}

      {isError && (
        <div className="card mt-3 p-4">
          <p className="text-sm text-crit">
            No se han podido leer: {error instanceof Error ? error.message : ''}
          </p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="key key-quiet mt-3 min-h-11 px-3 text-sm"
          >
            Reintentar
          </button>
        </div>
      )}

      {data && filas.length === 0 && (
        <p className="mt-3 text-sm text-muted">Ninguna pendiente.</p>
      )}

      <ul className="mt-3 space-y-3">
        {filas.map((f) => {
          /* Marca y modelo del catálogo; si nadie lo ha pasado todavía, el texto
             libre de antes. Es el mismo orden de preferencia que usan la bandeja
             de equipos y el aula: la respuesta se lee igual en las tres. */
          const modelo =
            [f.brand, f.model_name].filter(Boolean).join(' ') || f.model?.trim() || ''
          const identidad = f.identidad?.trim() || f.type_name || 'Equipo'
          const ficha = [modelo || 'sin modelo', f.serial ? `S/N ${f.serial}` : null]
            .filter(Boolean)
            .join(' · ')
          const alAlmacen = f.destino === 'almacen'

          return (
            <li key={f.id} className="card p-4">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-medium">{f.asset_label ?? f.type_name ?? 'Equipo'}</span>
                <span className="rounded-tag bg-raised px-2 py-0.5 text-[0.6875rem] font-medium text-muted">
                  {REMOVAL_DESTINO_LABELS[f.destino]}
                </span>
                {!f.asset_confirmed && (
                  <span className="rounded-tag bg-warn-tint px-1.5 py-0.5 text-[0.6875rem] font-medium text-warn">
                    Sin validar
                  </span>
                )}
                {f.model_confirmed === false && (
                  <span className="rounded-tag bg-warn-tint px-1.5 py-0.5 text-[0.6875rem] font-medium text-warn">
                    Modelo sin validar
                  </span>
                )}
              </div>

              {/* Qué aparato es, en su propia línea y antes de la sala. Antes
                  ponía el tipo y el texto libre del modelo, que en la mitad del
                  parque estaba vacío: la fila decía «Ordenador · 2.4» y quien
                  decidía no sabía cuál de los dos ordenadores del aula era. */}
              <p className="mt-1 text-sm">
                {identidad}
                <span className="text-muted"> · {ficha}</span>
              </p>

              <p className="mt-1 text-xs text-muted">
                {[
                  f.building_code && f.room_code ? `${f.building_code} · ${f.room_code}` : null,
                  f.room_name && f.room_name !== f.room_code ? f.room_name : null,
                  /* Desde cuándo está puesto: es la otra mitad de «¿se da de baja
                     o se arregla?». Un proyector de hace ocho meses no se tira. */
                  f.installed_at ? `puesto el ${fechaCorta(f.installed_at)}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>

              <p className="mt-1 text-xs text-muted">
                {[
                  f.requested_by_name,
                  new Date(f.requested_at).toLocaleDateString('es-ES'),
                  f.reason ? `«${f.reason}»` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>

              {/*
                A dónde va la unidad, dicho antes de decidir.
                «Devolver al almacén» sin artículo donde contarla es una retirada
                correcta y un ingreso que no ocurre: sale bien y descuadra igual.
              */}
              {alAlmacen && (
                <p className={`mt-2 text-xs ${f.stock_item_id ? 'text-muted' : 'text-warn'}`}>
                  {f.stock_item_id
                    ? `Sumará una unidad a «${f.stock_item_name}» en el almacén.`
                    : 'Este tipo de equipo no tiene artículo en el almacén: se retirará, pero no se ingresará ninguna unidad.'}
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                {/*
                  Autorizar es la decisión de verdad de esta pantalla, y el
                  diálogo enseña el aparato entero: el `confirm()` del navegador
                  que había aquí decía «¿Dar de baja "Ordenador 2"?», que es
                  exactamente lo que no permite decidir. La baja además pide
                  teclear BAJA — no se deshace, y un botón más no frena a nadie.
                */}
                <button
                  type="button"
                  disabled={decidir.isPending}
                  onClick={() =>
                    void pedir({
                      titulo: alAlmacen
                        ? `¿Retirar «${f.asset_label ?? identidad}» y devolverlo al almacén?`
                        : `¿Dar de baja «${f.asset_label ?? identidad}»?`,
                      detalle: `${identidad} · ${ficha}`,
                      consecuencias: alAlmacen
                        ? [
                            `Sale del inventario de ${f.room_code ?? 'la sala'} y deja de contar en sus revisiones.`,
                            f.stock_item_id
                              ? `Suma una unidad a «${f.stock_item_name}» en el almacén.`
                              : 'Ese tipo de equipo no tiene artículo en el almacén: no se ingresará ninguna unidad.',
                            'El equipo y su historial se conservan: no se borra nada.',
                          ]
                        : [
                            `Sale del inventario de ${f.room_code ?? 'la sala'} y no vuelve.`,
                            'No se ingresa en el almacén: se da por perdido.',
                            'El equipo y su historial se conservan: no se borra nada.',
                          ],
                      confirmar: alAlmacen ? 'Retirar y devolver' : 'Dar de baja',
                      tono: alAlmacen ? 'warn' : 'crit',
                      escribir: alAlmacen ? undefined : 'BAJA',
                    }).then((si) => {
                      if (si) decidir.mutate({ id: f.id, aprobar: true })
                    })
                  }
                  className="key key-accent min-h-11 px-3 text-sm"
                >
                  Autorizar
                </button>
                <button
                  type="button"
                  disabled={decidir.isPending}
                  onClick={() => decidir.mutate({ id: f.id, aprobar: false })}
                  className="key key-quiet min-h-11 px-3 text-sm text-muted"
                >
                  No retirarlo
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      {decidir.isError && (
        <p className="mt-3 text-sm text-crit">
          {decidir.error instanceof Error ? decidir.error.message : 'No se ha podido aplicar.'}
        </p>
      )}
      {nota && !decidir.isPending && !decidir.isError && (
        <p aria-live="polite" className="mt-3 text-sm text-ok">
          {nota}
        </p>
      )}

      {dialogo}
    </section>
  )
}
