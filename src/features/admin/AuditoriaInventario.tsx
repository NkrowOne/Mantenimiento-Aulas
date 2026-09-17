import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { pullMaster } from '@/sync/pull'
import { displayRoomCode } from '@/domain/normalize'
import { Cargando, EstadoVacio, FalloDeCarga, Nota, Seccion, mensajeDe } from './Seccion'
import { useRefrescarPendientes } from './pendientes'

/**
 * La auditoría del inventario: los números de verdad y los duplicados por decidir.
 *
 * Nace de un caso concreto: «tecleo Monitor Atril y se guarda Monitor Atril 2,
 * y en la lista no hay ningún Monitor Atril». Detrás había dos filas para un
 * aparato —un espejo desactualizado re-apuntó lo que ya existía y el servidor,
 * para no perder el trabajo, recolocó la etiqueta— y ninguna pantalla donde
 * verlo ni forma de arreglarlo sin escribir SQL.
 *
 * Dos mitades:
 *
 *  - **El resumen**, contado por el servidor. Cuando un dispositivo enseña 900
 *    equipos y aquí pone 1.100, la conversación cambia de «se han perdido
 *    datos» a «ese iPad no ha terminado de descargar» — que es la diferencia
 *    entre un susto y un diagnóstico.
 *  - **La bandeja de duplicados.** El servidor solo PROPONE pares —misma sala,
 *    mismo tipo, misma etiqueta base, y motivo de sospecha—; decide una
 *    persona, con lo que cuelga de cada lado delante. Fusionar no borra nada:
 *    el duplicado se retira, su serie y su modelo viajan al que se queda, sus
 *    incidencias se repuntan y sus revisiones se siguen leyendo enteras.
 */

interface ParDuplicado {
  room_id: string
  room_code: string
  room_name: string
  building_code: string
  tipo: string
  base: string
  bueno_id: string
  bueno_label: string | null
  bueno_serial: string | null
  bueno_model: string | null
  bueno_registros: number
  dup_id: string
  dup_label: string | null
  dup_serial: string | null
  dup_model: string | null
  dup_registros: number
  dup_creado: string | null
  dup_creado_por: string | null
  choque_registrado: boolean
}

interface Resumen {
  equipos?: Record<string, number>
  tipos?: Record<string, number>
  incidencias?: Record<string, number>
  revisiones?: Record<string, number>
  salas?: Record<string, number>
  choques_sin_resolver?: number
  duplicados_sospechosos?: number
}

/** Un lado del par, contado con las palabras con las que se decide. */
function Lado({
  titulo,
  label,
  serial,
  model,
  registros,
}: {
  titulo: string
  label: string | null
  serial: string | null
  model: string | null
  registros: number
}): React.ReactElement {
  const detalle = [model, serial].filter(Boolean).join(' · ')
  return (
    <div className="min-w-0 flex-1 rounded-ctl border border-line bg-surface p-2">
      <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted">{titulo}</p>
      <p className="truncate text-sm font-medium">{label ?? '(sin etiqueta)'}</p>
      <p className="truncate font-mono text-xs text-muted">{detalle || 'Sin modelo ni serie'}</p>
      <p className="mt-1 text-xs text-muted">
        {registros === 0
          ? 'Sin revisiones ni incidencias'
          : `${registros} registro${registros === 1 ? '' : 's'} (revisiones, incidencias, eventos)`}
      </p>
    </div>
  )
}

export function AuditoriaInventario(): React.ReactElement {
  const qc = useQueryClient()
  const refrescar = useRefrescarPendientes()
  const [nota, setNota] = useState<string | null>(null)

  const { data: resumen } = useQuery({
    queryKey: ['auditoria-inventario'],
    queryFn: async (): Promise<Resumen> => {
      const { data, error } = await supabase.rpc('auditoria_inventario')
      if (error) throw error
      return (data ?? {}) as Resumen
    },
  })

  const { data: pares, isPending, isError, error, refetch } = useQuery({
    queryKey: ['auditoria-duplicados'],
    queryFn: async (): Promise<ParDuplicado[]> => {
      const { data, error } = await supabase.rpc('auditoria_duplicados')
      if (error) throw error
      return (data ?? []) as ParDuplicado[]
    },
  })

  const alTerminar = (mensaje: string): void => {
    setNota(mensaje)
    void qc.invalidateQueries({ queryKey: ['auditoria-duplicados'] })
    void qc.invalidateQueries({ queryKey: ['auditoria-inventario'] })
    refrescar()
    // El espejo del propio dispositivo también tiene que enterarse: el
    // duplicado retirado desaparece de la sala en la siguiente descarga.
    void pullMaster()
  }

  const fusionar = useMutation({
    mutationFn: async (input: { duplicado: string; bueno: string }): Promise<string> => {
      const { data, error } = await supabase.rpc('fusionar_equipo_duplicado', {
        p_duplicado: input.duplicado,
        p_bueno: input.bueno,
      })
      if (error) throw error
      return (data as string) ?? ''
    },
    onSuccess: (etiqueta) =>
      alTerminar(
        `Fusionados. Se queda «${etiqueta}» con la serie, el modelo y las incidencias del otro; el duplicado queda retirado y su histórico se sigue leyendo.`,
      ),
  })

  const descartar = useMutation({
    mutationFn: async (input: { duplicado: string; bueno: string }) => {
      const { error } = await supabase.rpc('descartar_duplicado', {
        p_duplicado: input.duplicado,
        p_bueno: input.bueno,
      })
      if (error) throw error
    },
    onSuccess: () => alTerminar('Anotado: no es un duplicado. El par no volverá a proponerse.'),
  })

  const ocupado = fusionar.isPending || descartar.isPending

  /* Las cifras del servidor, en el orden en que se comparan con un dispositivo:
     primero los equipos, luego lo demás. `—` cuando el servidor no las ha dado. */
  const cifras: Array<[string, number | undefined]> = [
    ['Equipos instalados', resumen?.equipos?.['instalados']],
    ['Averiados', resumen?.equipos?.['averiados']],
    ['Retirados', resumen?.equipos?.['retirados']],
    ['Sin sala', resumen?.equipos?.['sin_sala']],
    ['Sin validar', resumen?.equipos?.['sin_validar']],
    ['Tipos vivos', resumen?.tipos?.['vivos']],
    ['Incidencias abiertas', resumen?.incidencias?.['abiertas']],
    ['En curso', resumen?.incidencias?.['en_curso']],
    ['Resueltas', resumen?.incidencias?.['resueltas']],
    ['Revisiones cerradas', resumen?.revisiones?.['cerradas']],
    ['Salas activas', resumen?.salas?.['activas']],
    ['Choques sin resolver', resumen?.choques_sin_resolver],
  ]

  return (
    <Seccion
      id="sec-auditoria"
      titulo="Duplicados y cifras del inventario"
      texto="Dos filas que parecen el mismo aparato: misma sala, mismo tipo y mismo nombre base. Nacen cuando un dispositivo con el espejo atrasado vuelve a apuntar un equipo que ya existía. Fusionar no borra nada: el duplicado queda retirado, su serie y su modelo viajan al que se queda, y sus revisiones e incidencias se conservan."
      pendientes={pares?.length ?? 0}
    >
      {isPending && <Cargando texto="Buscando pares sospechosos…" />}
      {isError && <FalloDeCarga que="los duplicados" error={error} onReintentar={() => void refetch()} />}
      {pares && pares.length === 0 && <EstadoVacio titulo="Ningún duplicado por decidir" />}

      <ul className="space-y-3">
          {(pares ?? []).map((p) => (
            <li key={`${p.dup_id}-${p.bueno_id}`} className="card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="min-w-0 text-sm font-medium">
                  <span className="font-mono font-semibold">
                    {p.building_code} {displayRoomCode(p.room_code)}
                  </span>
                  <span className="text-muted"> · {p.tipo}</span>
                </p>
                {p.choque_registrado && (
                  <span className="shrink-0 rounded-tag bg-warn-tint px-1.5 py-0.5 text-[0.6875rem] font-medium text-warn">
                    choque registrado por el servidor
                  </span>
                )}
              </div>

              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <Lado
                  titulo="Más antiguo"
                  label={p.bueno_label}
                  serial={p.bueno_serial}
                  model={p.bueno_model}
                  registros={p.bueno_registros}
                />
                <Lado
                  titulo={`Más nuevo${p.dup_creado_por ? ` · lo apuntó ${p.dup_creado_por}` : ''}`}
                  label={p.dup_label}
                  serial={p.dup_serial}
                  model={p.dup_model}
                  registros={p.dup_registros}
                />
              </div>

              {/* Tres salidas y las tres explícitas. La fusión dice quién se
                  queda; equivocarse tampoco pierde nada, pero decidir mirando
                  los registros es lo que evita retirar el lado con historia. */}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={ocupado}
                  onClick={() => fusionar.mutate({ duplicado: p.dup_id, bueno: p.bueno_id })}
                  className="key key-accent min-h-11 flex-1 px-3 text-xs"
                >
                  Es el mismo: quedarse con «{p.bueno_label ?? p.base}»
                </button>
                <button
                  type="button"
                  disabled={ocupado}
                  onClick={() => fusionar.mutate({ duplicado: p.bueno_id, bueno: p.dup_id })}
                  className="key key-quiet min-h-11 flex-1 px-3 text-xs"
                >
                  Quedarse con «{p.dup_label ?? p.base}»
                </button>
                <button
                  type="button"
                  disabled={ocupado}
                  onClick={() => descartar.mutate({ duplicado: p.dup_id, bueno: p.bueno_id })}
                  className="key key-quiet min-h-11 px-3 text-xs text-muted"
                >
                  Son dos aparatos
                </button>
              </div>
            </li>
          ))}
        </ul>

      <Nota
        texto={fusionar.isError || descartar.isError ? mensajeDe(fusionar.error ?? descartar.error) : nota}
        tono={fusionar.isError || descartar.isError ? 'crit' : 'ok'}
      />

      {/* Los números del servidor, que son los de verdad. Contra ellos se
          compara lo que enseñe cualquier dispositivo. Plegados: se consultan
          cuando un iPad enseña menos de lo que debería, no cada vez. */}
      <details className="card mt-4 p-4" open={!isPending && (pares?.length ?? 0) === 0}>
        <summary className="cursor-pointer text-sm font-medium">
          Lo que hay en la base, contado por el servidor
        </summary>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-3">
          {cifras.map(([que, n]) => (
            <div key={que} className="flex justify-between gap-2 border-b border-line-soft pb-1">
              <dt className="text-muted">{que}</dt>
              <dd className="font-mono tabular">{n ?? '—'}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted">
          Si un dispositivo enseña menos que esto, no ha terminado de descargar: se arregla
          sincronizando, no re-apuntando equipos.
        </p>
      </details>
    </Seccion>
  )
}
