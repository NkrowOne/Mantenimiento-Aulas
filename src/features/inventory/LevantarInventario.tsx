import { useState } from 'react'

/**
 * «Esto es todo lo que hay.»
 *
 * Cierra el hueco que quedaba: 41 aulas con cero equipos registrados y ninguna
 * forma de saber si es que no tienen nada o es que nadie ha ido nunca a mirar.
 *
 * Y está diseñado alrededor de una regla: **no atosigar**. Un aviso que sale en
 * 41 salas y no se puede quitar se convierte en ruido en dos días —todo el
 * mundo aprende a saltárselo, y con él se salta el que sí importaba—. Así que:
 *
 *  - Vive **dentro** del panel de equipos, que nace plegado. No interrumpe, no
 *    bloquea la revisión y no sale en rojo: no hay nada roto, hay algo por
 *    hacer.
 *  - Se resuelve **una vez y para siempre**. Confirmada la sala, deja de
 *    preguntar y pasa a ser una línea de dos palabras con la fecha.
 *  - Confirmar es **una decisión, no un formulario**: un botón. La nota es
 *    opcional y está escondida detrás de un enlace, para el día que haga falta
 *    explicar algo raro.
 *
 * Lo que enseña cambia según lo que hay en la sala, porque las dos situaciones
 * piden cosas distintas: con equipos, confirmar es cerrar; sin ninguno, es
 * afirmar que de verdad no hay nada, que es una afirmación más fuerte y merece
 * decirse con todas las letras.
 */
export function LevantarInventario({
  levantadoEl,
  equipos,
  onConfirmar,
}: {
  /** Cuándo se confirmó por última vez. `null` = nunca. */
  levantadoEl: string | null
  /** Cuántos equipos vivos tiene la sala ahora mismo. */
  equipos: number
  onConfirmar: (nota: string | null) => void
}): React.ReactElement {
  const [nota, setNota] = useState('')
  const [escribiendo, setEscribiendo] = useState(false)
  const [hecho, setHecho] = useState(false)

  if (levantadoEl && !hecho) {
    const fecha = new Date(levantadoEl)
    return (
      <p className="mt-3 border-t border-line-soft pt-3 text-xs text-muted">
        Inventario confirmado el{' '}
        {Number.isNaN(fecha.getTime())
          ? '—'
          : fecha.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })}
        .{' '}
        <button
          type="button"
          onClick={() => onConfirmar(null)}
          className="text-accent underline-offset-4 hover:underline"
        >
          Volver a confirmar
        </button>
      </p>
    )
  }

  if (hecho) {
    return (
      <p className="mt-3 border-t border-line-soft pt-3 text-xs text-ok">
        Inventario confirmado. Gracias: esta sala deja de estar pendiente.
      </p>
    )
  }

  return (
    <div className="mt-3 rounded-ctl border border-line bg-sunken p-3">
      <p className="text-sm font-medium">
        {equipos === 0
          ? 'Esta sala no tiene ningún equipo registrado.'
          : 'Nadie ha confirmado nunca el inventario de esta sala.'}
      </p>
      <p className="mt-1 text-xs text-muted">
        {equipos === 0
          ? 'Puede que no tenga ninguno, o puede que nadie haya venido a mirar. Añade arriba lo que veas; si de verdad no hay nada, dilo y deja de aparecer como pendiente.'
          : 'Añade arriba lo que falte y confirma cuando la lista cuadre con lo que tienes delante.'}
      </p>

      {escribiendo && (
        <label className="mt-2 block text-xs text-muted">
          Nota
          <input
            type="text"
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            placeholder="Lo que convenga dejar dicho"
            enterKeyHint="done"
            className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
          />
        </label>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => {
            onConfirmar(nota.trim() || null)
            setHecho(true)
          }}
          className="key key-accent min-h-touch flex-1 px-3 text-sm"
        >
          {equipos === 0 ? 'No tiene equipos' : `Esto es todo (${equipos})`}
        </button>

        {!escribiendo && (
          <button
            type="button"
            onClick={() => setEscribiendo(true)}
            className="shrink-0 text-xs text-muted underline-offset-4 hover:underline"
          >
            Añadir nota
          </button>
        )}
      </div>
    </div>
  )
}
