import { useMemo, useState } from 'react'
import type { Catalogo, SalaConocida } from '@/domain/cruce'
import type { Duda, Respuesta, Respuestas } from '@/domain/dudas'

/**
 * Las preguntas de la pasada, con lo que hace falta para contestarlas.
 *
 * Es la pieza que faltaba entre «la fila no cruza» y «la fila cruza»: hasta
 * aquí una fila que la pasada no entendía se contaba y se dejaba, y la única
 * salida era arreglar el libro o el maestro y volver a subirlo. Ahora se
 * pregunta y se contesta aquí, y la pasada se vuelve a calcular con la
 * respuesta. Cada respuesta es de esta pasada: se tira al empezar de nuevo.
 *
 * Dos clases de pregunta, con dos formas de contestar:
 *
 *  - **¿De qué sala es?** Se elige edificio y sala del maestro. Un parte puede
 *    además entrar «sin sala» —118 del histórico son así—, y cualquier fila se
 *    puede dejar como está.
 *  - **¿Entra?** Un equipo que la sala no tenía, un artículo que el almacén no
 *    conoce, un ordenador de repuesto nuevo. Sí o no.
 */
export function Dudas({
  dudas,
  respuestas,
  catalogo,
  onContestar,
}: {
  dudas: Duda[]
  respuestas: Respuestas
  catalogo: Catalogo
  onContestar: (id: string, respuesta: Respuesta | null) => void
}): React.ReactElement {
  const sinContestar = dudas.filter((d) => !(d.id in respuestas)).length
  const porHoja = new Map<string, Duda[]>()
  for (const d of dudas) {
    const l = porHoja.get(d.hoja) ?? []
    l.push(d)
    porHoja.set(d.hoja, l)
  }

  return (
    <div className={`card mt-4 p-4 ${sinContestar > 0 ? 'border-warn' : ''}`}>
      <h2 className="text-sm font-semibold">
        {sinContestar > 0
          ? `La pasada tiene ${sinContestar} ${sinContestar === 1 ? 'duda' : 'dudas'} antes de aplicar`
          : 'Todas las dudas están contestadas'}
      </h2>
      <p className="mt-1 text-sm text-muted">
        Filas del libro que la aplicación no sabe de qué sala son, y cosas nuevas que entrarían en el
        inventario. Contesta y la pasada se recalcula; lo que se deje como está no se toca.
      </p>
      <div className="mt-3 space-y-4">
        {[...porHoja.entries()].map(([hoja, lista]) => (
          <div key={hoja}>
            <p className="eyebrow">{hoja}</p>
            <ul className="mt-2 space-y-3">
              {lista.map((d) => (
                <li key={d.id} className="rounded-ctl border border-hair p-3">
                  {d.tipo === 'sala' ? (
                    <DudaDeSala
                      duda={d}
                      respuesta={respuestas[d.id]}
                      catalogo={catalogo}
                      onContestar={(r) => onContestar(d.id, r)}
                    />
                  ) : (
                    <DudaDeAlta
                      duda={d}
                      respuesta={respuestas[d.id]}
                      onContestar={(r) => onContestar(d.id, r)}
                    />
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------

function DudaDeSala({
  duda,
  respuesta,
  catalogo,
  onContestar,
}: {
  duda: Extract<Duda, { tipo: 'sala' }>
  respuesta: Respuesta | undefined
  catalogo: Catalogo
  onContestar: (r: Respuesta | null) => void
}): React.ReactElement {
  const salasPorId = useMemo(() => new Map(catalogo.salas.map((s) => [s.id, s])), [catalogo])
  const edificios = useMemo(
    () =>
      [...new Map(catalogo.salas.filter((s) => s.active).map((s) => [s.edificioCodigo, s.edificioNombre])).entries()]
        .map(([codigo, nombre]) => ({ codigo, nombre }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
    [catalogo],
  )
  const primera = duda.candidatas[0]
  const [edificio, setEdificio] = useState<string>(
    primera ? (salasPorId.get(primera.id)?.edificioCodigo ?? '') : '',
  )
  const salas = useMemo(
    () =>
      catalogo.salas
        .filter((s) => s.active && s.edificioCodigo === edificio)
        .sort(
          (a, b) =>
            a.zona.localeCompare(b.zona, 'es', { numeric: true }) ||
            a.code.localeCompare(b.code, 'es', { numeric: true }),
        ),
    [catalogo, edificio],
  )

  const contestada = respuesta ? describirRespuesta(respuesta, salasPorId) : null

  return (
    <div>
      <p className="text-sm">
        <span className="font-semibold">Fila {duda.fila}</span> · {duda.texto}
      </p>
      <p className="mt-1 text-xs text-muted">
        {duda.que === 'parte' ? 'Parte nuevo del libro. ' : ''}
        {duda.motivo}
      </p>

      {contestada ? (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ok-ink">
          {contestada}
          <button type="button" className="key key-quiet h-9 px-3 text-xs" onClick={() => onContestar(null)}>
            Cambiar
          </button>
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {duda.candidatas.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {duda.candidatas.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="key key-quiet h-9 px-3 text-sm"
                  onClick={() => onContestar({ tipo: 'sala', salaId: c.id })}
                >
                  {c.code} · {c.edificio}
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="h-10 min-w-40 rounded-ctl border border-line bg-surface px-2 text-sm"
              value={edificio}
              onChange={(e) => setEdificio(e.target.value)}
              aria-label="Edificio"
            >
              <option value="">Edificio…</option>
              {edificios.map((b) => (
                <option key={b.codigo} value={b.codigo}>
                  {b.nombre}
                </option>
              ))}
            </select>
            <select
              className="h-10 min-w-40 rounded-ctl border border-line bg-surface px-2 text-sm"
              disabled={edificio === ''}
              value=""
              onChange={(e) => {
                if (e.target.value) onContestar({ tipo: 'sala', salaId: e.target.value })
              }}
              aria-label="Sala"
            >
              <option value="">{edificio === '' ? 'Elige edificio' : 'Sala…'}</option>
              {salas.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code}
                  {s.name && s.name !== s.code ? ` — ${s.name}` : ''} · {s.zona}
                </option>
              ))}
            </select>
            {duda.que === 'parte' && (
              <button
                type="button"
                className="key key-quiet h-10 px-3 text-sm"
                onClick={() => onContestar({ tipo: 'sin_sala' })}
              >
                No es de ninguna sala
              </button>
            )}
            <button
              type="button"
              className="key key-quiet h-10 px-3 text-sm"
              onClick={() => onContestar({ tipo: 'ignorar' })}
            >
              Dejar como está
            </button>
          </div>
          {duda.que === 'estado' && (
            <p className="text-xs text-muted">
              Si la sala no existe todavía, créala en el maestro de salas y vuelve a subir el libro.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function describirRespuesta(r: Respuesta, salas: Map<string, SalaConocida>): string {
  switch (r.tipo) {
    case 'sala': {
      const s = salas.get(r.salaId)
      return s ? `Es «${s.code}» de ${s.edificioNombre}.` : 'Es una sala del maestro.'
    }
    case 'sin_sala':
      return 'Entra sin sala.'
    case 'ignorar':
      return 'Se deja como está.'
    case 'alta':
      return r.aceptar ? 'Entra.' : 'No entra.'
  }
}

// -----------------------------------------------------------------------------

const QUE: Record<Extract<Duda, { tipo: 'alta' }>['que'], string> = {
  equipo: 'Equipo nuevo en la sala',
  articulo: 'Artículo nuevo en el almacén',
  unidad: 'Ordenador de repuesto nuevo',
}

function DudaDeAlta({
  duda,
  respuesta,
  onContestar,
}: {
  duda: Extract<Duda, { tipo: 'alta' }>
  respuesta: Respuesta | undefined
  onContestar: (r: Respuesta | null) => void
}): React.ReactElement {
  return (
    <div>
      <p className="text-sm">
        <span className="font-semibold">Fila {duda.fila}</span> · {QUE[duda.que]}: {duda.texto}
      </p>
      <p className="mt-1 text-xs text-muted">{duda.detalle}</p>
      {respuesta ? (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ok-ink">
          {respuesta.tipo === 'alta' && respuesta.aceptar ? 'Entra.' : 'No entra: se queda como está.'}
          <button type="button" className="key key-quiet h-9 px-3 text-xs" onClick={() => onContestar(null)}>
            Cambiar
          </button>
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            className="key key-accent h-10 px-3 text-sm"
            onClick={() => onContestar({ tipo: 'alta', aceptar: true })}
          >
            Sí, que entre
          </button>
          <button
            type="button"
            className="key key-quiet h-10 px-3 text-sm"
            onClick={() => onContestar({ tipo: 'alta', aceptar: false })}
          >
            No, dejarlo como está
          </button>
        </div>
      )}
    </div>
  )
}
