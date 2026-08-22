import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { NIVELES_RAZONAMIENTO } from './secciones'
import { fechaCorta } from '@/domain/fechas'
import { claveDelDispositivo, guardarClaveDelDispositivo } from './informe/clave'

export interface Estado {
  clave_guardada: boolean
  modelo: string
  thinking: string
  ultimo_analisis: string | null
  ultimo_con_ia: boolean
  ultimo_informe: string | null
}

/**
 * `null` cuando la consulta falla, y no `undefined`: son dos cosas distintas.
 * `undefined` es «todavía no se sabe» y `null` es «se ha preguntado y no hay
 * respuesta», que es cuando el configurador tiene que comportarse como si no
 * hubiera IA.
 */
export function useEstadoIA(): { data: Estado | null | undefined } {
  return useQuery({
    queryKey: ['ia-estado'],
    queryFn: async (): Promise<Estado | null> => {
      const { data, error } = await supabase.rpc('ia_estado')
      // Un error aquí no puede tumbar la pantalla de informes: sin estado, el
      // configurador se comporta como si no hubiera IA, que es lo prudente.
      if (error) return null
      return data as Estado
    },
    staleTime: 60_000,
  })
}

/**
 * El estado de la IA, y la forma de activarla.
 *
 * Esto es TODA la configuración que necesita el módulo de informes: una clave de
 * Gemini. No hay variable de entorno, ni contenedor que reconstruir, ni token
 * que sincronizar con nadie — el informe lo arma esta misma aplicación y llama a
 * Google directamente. Se saca en https://aistudio.google.com/apikey.
 *
 * Dos sitios donde puede vivir, y hacen falta los dos:
 *
 *  · **En el despliegue** (`app_config`). Es lo normal: se pega una vez y la
 *    usan los administradores desde cualquier dispositivo. Requiere que esté
 *    aplicada la migración que crea `ia_clave()`.
 *  · **En este dispositivo**. Para quien prefiera no dejar ninguna clave en la
 *    base, o para el rato en que la migración todavía no ha llegado. No sale de
 *    este navegador y no la ve nadie más.
 *
 * La clave guardada en el despliegue no se enseña nunca, ni recortada:
 * `ia_estado` devuelve un booleano y el nombre del modelo, y el campo de texto
 * está siempre vacío. Media clave en una pantalla sigue siendo media clave en el
 * historial de un navegador compartido.
 */
export function EstadoIA(): React.ReactElement {
  const qc = useQueryClient()
  const { data: estado } = useEstadoIA()
  const [abierto, setAbierto] = useState(false)
  const [clave, setClave] = useState('')
  const [modelo, setModelo] = useState('')
  const [thinking, setThinking] = useState('')
  /* Se lee al montar y se refresca al guardar: `localStorage` no avisa de sus
     propios cambios en la misma pestaña, así que un estado es la única forma de
     que la tarjeta cuente lo que hay de verdad. */
  const [enDispositivo, setEnDispositivo] = useState(() => Boolean(claveDelDispositivo()))

  const guardar = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('ia_configurar', {
        p_clave: clave.trim() ? clave.trim() : null,
        p_modelo: modelo.trim() ? modelo.trim() : null,
        p_thinking: thinking ? thinking : null,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setClave('')
      setAbierto(false)
      void qc.invalidateQueries({ queryKey: ['ia-estado'] })
    },
  })

  /**
   * Quitar la clave es su propia operación, no un «guardar» con el campo vacío.
   *
   * La distinción está en la función de la base: `null` significa «no toques la
   * clave» —para poder cambiar solo el modelo— y cadena vacía significa
   * «bórrala». Mezclarlas haría que dejar el campo en blanco apagase la IA sin
   * que nadie lo hubiera pedido.
   */
  const quitar = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('ia_configurar', { p_clave: '' })
      if (error) throw error
    },
    onSuccess: () => {
      setClave('')
      setAbierto(false)
      void qc.invalidateQueries({ queryKey: ['ia-estado'] })
    },
  })

  const guardarAquí = (): void => {
    guardarClaveDelDispositivo(clave)
    setEnDispositivo(Boolean(clave.trim()))
    setClave('')
    setAbierto(false)
  }

  const activa = estado?.clave_guardada || enDispositivo
  const funcionando = estado?.ultimo_con_ia

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold">Análisis con IA</h2>
          <p className="mt-1 text-sm text-muted">
            {activa ? (
              <>
                El análisis lo redacta <span className="font-mono">{estado?.modelo}</span> razonando
                antes de escribir. Las cifras no salen del modelo: se calculan con los datos y él
                solo escribe el texto.
              </>
            ) : (
              <>
                Sin clave configurada. El informe se emite igual, con el análisis calculado a partir
                de los datos — es un texto completo, no un hueco.
              </>
            )}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-tag px-2 py-1 text-xs font-semibold ${
            funcionando
              ? 'bg-ok-tint text-ok'
              : activa
                ? 'bg-warn-tint text-warn'
                : 'bg-na-tint text-muted'
          }`}
        >
          {funcionando ? 'Redactando con IA' : activa ? 'Clave guardada' : 'Análisis calculado'}
        </span>
      </div>

      {/*
        Dónde se dice esto y dónde no.

        El documento sale limpio: es del servicio de mantenimiento y no lleva
        ninguna etiqueta sobre cómo se preparó. Esta pantalla es el otro lado de
        esa decisión — aquí sí se dice, con todo el detalle, porque es donde se
        administra la herramienta y donde hay que poder auditarla.
      */}
      <p className="mt-3 text-xs text-muted">
        {estado?.ultimo_analisis && (
          <>
            El último informe
            {estado.ultimo_informe ? ` (${fechaCorta(estado.ultimo_informe)})` : ''} salió con{' '}
            {estado.ultimo_analisis}.{' '}
          </>
        )}
        {enDispositivo && !estado?.clave_guardada && (
          <>La clave que se está usando es la de este dispositivo. </>
        )}
        El informe no menciona nada de esto: va limpio. La procedencia de cada uno se ve aquí y en
        el archivo de abajo.
      </p>

      {!abierto && (
        <button
          type="button"
          onClick={() => {
            setModelo(estado?.modelo ?? '')
            setThinking(estado?.thinking ?? 'high')
            setAbierto(true)
          }}
          className="key key-quiet mt-3 min-h-11 px-3 text-sm"
        >
          {activa ? 'Cambiar la clave o el modelo' : 'Poner la clave de Gemini'}
        </button>
      )}

      {abierto && (
        <div className="mt-4 border-t border-line pt-4">
          <label className="block text-sm">
            <span className="text-muted">Clave de API de Gemini</span>
            <input
              type="password"
              value={clave}
              onChange={(e) => setClave(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={activa ? 'Hay una guardada; escribe para sustituirla' : 'AIza…'}
              className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 font-mono text-sm"
            />
          </label>
          <p className="mt-2 text-xs text-muted">
            Se saca en <span className="font-mono">aistudio.google.com/apikey</span>. Es de pago por
            uso: un informe semanal cuesta céntimos, pero es una clave con factura, así que trátala
            como un secreto.
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="text-muted">Modelo</span>
                <input
                  type="text"
                  value={modelo}
                  onChange={(e) => setModelo(e.target.value)}
                  spellCheck={false}
                  className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 font-mono text-sm"
                />
              </label>
              <label className="block text-sm">
                <span className="text-muted">Razonamiento</span>
                <select
                  value={thinking}
                  onChange={(e) => setThinking(e.target.value)}
                  className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm"
                >
                  {NIVELES_RAZONAMIENTO.map((n) => (
                    <option key={n.clave} value={n.clave}>
                      {n.etiqueta} — {n.detalle}
                    </option>
                  ))}
                </select>
              </label>
          </div>

          {guardar.isError && (
            <p role="alert" className="mt-3 text-sm text-crit">
              {guardar.error instanceof Error ? guardar.error.message : 'No se ha podido guardar.'}
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={guardar.isPending}
              onClick={() => guardar.mutate()}
              className="key key-accent min-h-11 px-4 text-sm"
            >
              {guardar.isPending ? 'Guardando…' : 'Guardar para todo el equipo'}
            </button>
            <button
              type="button"
              disabled={!clave.trim()}
              onClick={guardarAquí}
              className="key key-quiet min-h-11 px-4 text-sm"
              title="No sale de este navegador"
            >
              Guardar solo aquí
            </button>
            <button
              type="button"
              onClick={() => {
                setClave('')
                setAbierto(false)
              }}
              className="key key-quiet min-h-11 px-4 text-sm"
            >
              Cancelar
            </button>
            {estado?.clave_guardada && (
              <button
                type="button"
                disabled={quitar.isPending}
                onClick={() => quitar.mutate()}
                className="key key-quiet ml-auto min-h-11 px-3 text-sm text-crit"
              >
                {quitar.isPending ? 'Quitando…' : 'Quitar la del equipo'}
              </button>
            )}
            {enDispositivo && (
              <button
                type="button"
                onClick={() => {
                  guardarClaveDelDispositivo('')
                  setEnDispositivo(false)
                }}
                className="key key-quiet min-h-11 px-3 text-sm text-crit"
              >
                Quitar la de este dispositivo
              </button>
            )}
          </div>

          <p className="mt-3 text-xs text-muted">
            «Guardar para todo el equipo» la deja en la configuración del despliegue y la usa
            cualquier administrador desde cualquier dispositivo. «Guardar solo aquí» no sale de
            este navegador.
          </p>
        </div>
      )}
    </section>
  )
}
