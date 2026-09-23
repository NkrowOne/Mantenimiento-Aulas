/**
 * El ticket de EasyVista de una incidencia, y el sitio donde se pone después.
 *
 * El código no llega siempre con la avería: se abre desde el aula, y el ticket
 * lo crea otra persona en un escritorio horas más tarde — o la avería ya está
 * cerrada cuando alguien tiene el código delante. Esto es la tercera puerta,
 * la de «a posteriori»: se ve el código si lo hay, y con un toque se pone o se
 * cambia, esté la incidencia abierta o resuelta.
 *
 * Va por RPC y **necesita red**, a propósito. `incidents` no acepta el UPDATE
 * de un técnico y no se quiere abrirle la tabla; la función del servidor toca
 * esa columna y ninguna otra. Y no pasa por la cola de salida porque esto se
 * teclea mirando EasyVista, que es una pantalla con cobertura: las otras dos
 * puertas —abrir y cerrar— sí viajan por la cola, y son las que se usan en el
 * aula. Sin conexión, el botón lo dice y no finge.
 */

import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { normalizarCodigoEasyVista, problemaDeCodigoEasyVista } from '@/domain/easyvista'

export function CodigoEasyVista({
  incidentId,
  codigo,
  className = 'mt-2',
}: {
  incidentId: string
  /** El que tiene ahora, o nulo. */
  codigo: string | null
  /**
   * El aire de arriba, que lo pone quien lo coloca.
   *
   * En la ficha de la sala va suelto debajo del texto y necesita su margen; en
   * la lista de incidencias va dentro de la barra de acciones, alineado con
   * «Material» y «Resolver», y ahí un margen propio lo dejaría ocho píxeles más
   * abajo que sus compañeros.
   */
  className?: string
}): React.ReactElement {
  const qc = useQueryClient()
  const ayudaId = useId()
  const [editando, setEditando] = useState(false)
  const [texto, setTexto] = useState('')
  const [tocado, setTocado] = useState(false)

  const problema = problemaDeCodigoEasyVista(texto)

  const guardar = useMutation({
    mutationFn: async (): Promise<string | null> => {
      const { data, error } = await supabase.rpc('incidencia_poner_codigo_easyvista', {
        p_incidencia: incidentId,
        p_codigo: texto,
      })
      if (error) throw error
      const guardado = (data as string | null) ?? normalizarCodigoEasyVista(texto)

      // El espejo, si esta incidencia está en él: la ficha del aula lee de ahí
      // y tiene que decir lo mismo que la lista en el acto.
      if (await db.incidents.get(incidentId)) {
        await db.incidents.update(incidentId, { easyvista_ref: guardado })
      }
      return guardado
    },
    onSuccess: () => {
      setEditando(false)
      void qc.invalidateQueries({ queryKey: ['incidents'] })
      void qc.invalidateQueries({ queryKey: ['borradores'] })
    },
  })

  if (!editando) {
    return (
      <button
        type="button"
        onClick={() => {
          setTexto(codigo ?? '')
          setTocado(false)
          guardar.reset()
          setEditando(true)
        }}
        aria-label={codigo ? `Cambiar el código de EasyVista, ahora ${codigo}` : undefined}
        className={`key key-quiet min-h-11 px-3 text-xs ${className}`}
      >
        {/*
          Sin repetir el número.

          La línea de datos de la fila ya lo lleva, al lado del número del
          libro y con la palabra delante, que es donde tiene sentido leerlo:
          son dos números con la misma pinta y ahí se distinguen. Repetirlo en
          el botón no añadía nada y le daba a la tecla el ancho de media
          pantalla, que es lo que descuadraba la barra de acciones.
        */}
        {codigo ? 'EasyVista · cambiar' : 'Poner el código de EasyVista'}
      </button>
    )
  }

  return (
    <form
      className={`w-full rounded-ctl border border-line bg-raised p-3 ${className}`}
      onSubmit={(e) => {
        e.preventDefault()
        setTocado(true)
        if (problema === null) guardar.mutate()
      }}
    >
      <label className="block text-sm">
        <span className="text-muted">Código de EasyVista</span>
        <input
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          autoFocus
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={tocado && problema !== null}
          aria-describedby={ayudaId}
          placeholder="I260916_0042"
          className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 font-mono text-base uppercase"
        />
      </label>
      {tocado && problema !== null ? (
        <p id={ayudaId} role="alert" className="mt-1 text-sm text-crit">
          {problema}
        </p>
      ) : (
        <p id={ayudaId} className="mt-1 text-xs leading-relaxed text-muted">
          Tal y como lo da EasyVista. Vacío lo quita. Necesita conexión.
        </p>
      )}

      {guardar.isError && (
        <p role="alert" className="mt-2 text-sm text-crit">
          {/insufficient|permission|denied|42501/i.test(
            guardar.error instanceof Error ? guardar.error.message : '',
          )
            ? 'El servidor no lo ha aceptado: hace falta ser del personal.'
            : 'No se ha podido guardar: hace falta conexión. Inténtalo otra vez.'}
        </p>
      )}

      <div className="mt-2 flex gap-2">
        <button
          type="submit"
          disabled={guardar.isPending}
          className="key key-accent min-h-11 px-3 text-sm"
        >
          {guardar.isPending ? 'Guardando…' : 'Guardar código'}
        </button>
        <button
          type="button"
          onClick={() => setEditando(false)}
          className="key key-quiet min-h-11 px-3 text-sm"
        >
          Cancelar
        </button>
      </div>
    </form>
  )
}
