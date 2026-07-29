import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

interface ReportRow {
  id: string
  kind: 'diario' | 'semanal' | 'personalizado'
  period_start: string
  period_end: string
  storage_path: string
  generated_at: string
}

const KIND_LABEL: Record<ReportRow['kind'], string> = {
  diario: 'Diario',
  semanal: 'Semanal',
  personalizado: 'Personalizado',
}

/**
 * Archivo de informes.
 *
 * Un informe emitido **no se regenera nunca**: se versiona. Si los datos
 * cambian después, el PDF del lunes tiene que seguir diciendo lo que decía el
 * lunes, o deja de servir como registro.
 */
export function ReportsPage(): React.ReactElement {
  const qc = useQueryClient()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const { data: reports } = useQuery({
    queryKey: ['reports'],
    queryFn: async (): Promise<ReportRow[]> => {
      const { data } = await supabase
        .from('reports')
        .select('*')
        .order('generated_at', { ascending: false })
        .limit(60)
      return (data ?? []) as ReportRow[]
    },
  })

  const generate = useMutation({
    mutationFn: async (input: { kind: string; from?: string; to?: string }) => {
      // Las fechas se envían de verdad. Antes se recogían aquí arriba y se
      // perdían: el informe «a medida» salía siempre con los datos de ayer.
      const { error } = await supabase.rpc('request_report', {
        kind: input.kind,
        p_start: input.from ?? null,
        p_end: input.to ?? null,
      })
      if (error) throw error
    },
    onSuccess: () => {
      // El worker tarda unos segundos; se refresca al rato en vez de mentir
      // diciendo que ya está.
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['reports'] }), 4000)
    },
  })

  async function download(path: string): Promise<void> {
    const { data } = await supabase.storage.from('reports').createSignedUrl(path, 60)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener')
  }

  return (
    <div className="mx-auto max-w-3xl p-4">
      <h1 className="text-xl font-semibold">Informes</h1>
      <p className="mt-1 text-sm text-muted">Diario a las 07:00 · semanal los lunes</p>

      <section className="card mt-4 p-4">
        <h2 className="font-semibold">Informe a medida</h2>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Desde</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="h-11 rounded-ctl border border-line bg-surface px-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Hasta</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-11 rounded-ctl border border-line bg-surface px-2"
            />
          </label>
          <button
            type="button"
            disabled={!from || !to || generate.isPending}
            onClick={() => generate.mutate({ kind: 'personalizado', from, to })}
            className="key key-accent h-11 px-4 text-sm"
          >
            {generate.isPending ? 'Generando…' : 'Generar'}
          </button>
        </div>

        {generate.isError && (
          <p className="mt-3 text-sm text-crit">
            No se pudo generar.
          </p>
        )}
        {generate.isSuccess && (
          <p className="mt-3 text-sm text-muted">En marcha. Aparecerá abajo.</p>
        )}
      </section>

      <ul className="mt-6 divide-y divide-line">
        {(reports ?? []).map((r) => (
          <li key={r.id} className="flex items-center gap-3 py-3 text-sm">
            <span className="w-24 shrink-0 font-medium">{KIND_LABEL[r.kind]}</span>
            <span className="flex-1 font-mono text-xs tabular text-muted">
              {r.period_start} → {r.period_end}
            </span>
            <button
              type="button"
              onClick={() => void download(r.storage_path)}
              className="key key-quiet px-3 py-1.5 text-xs"
            >
              Descargar
            </button>
          </li>
        ))}
      </ul>

      {reports?.length === 0 && (
        <p className="mt-6 text-sm text-muted">
          Aún no hay informes.
        </p>
      )}
    </div>
  )
}
