import type { SpecField, SpecValues } from '@/domain/types'

/**
 * Los campos que el tipo de equipo declara y el código no conoce.
 *
 * Es la parte personalizable del inventario, y está aquí en un solo sitio
 * porque se pinta en tres: la ficha del modelo, la corrección del equipo en el
 * aula y la gestión desde el ordenador.
 *
 * Cuatro tipos de campo y ni uno más — texto, número, fecha y sí/no—. No es una
 * limitación técnica: un constructor de formularios completo, con validaciones,
 * secciones y campos obligatorios, es un proyecto aparte que se paga en una
 * pantalla de configuración que nadie entiende. Con estos cuatro se guarda la
 * resolución de un proyector, los lúmenes, la RAM de un ordenador y si lleva
 * lector de tarjetas, que es lo que un inventario de aulas necesita. Lo que no
 * encaje cabe en las observaciones.
 *
 * Escribe el objeto entero en cada cambio y no un campo suelto: el valor vive en
 * una columna `jsonb`, así que la unidad de escritura es el objeto. Guardar por
 * campo obligaría a leer-modificar-escribir y a resolver la carrera entre dos
 * campos tocados seguidos.
 */
export function CamposPropios({
  campos,
  valores,
  onChange,
  titulo,
}: {
  campos: SpecField[]
  valores: SpecValues
  onChange: (valores: SpecValues) => void
  titulo?: string
}): React.ReactElement | null {
  if (campos.length === 0) return null

  const set = (clave: string, valor: string | number | boolean | null): void => {
    const siguiente = { ...valores }
    if (valor === null || valor === '') delete siguiente[clave]
    else siguiente[clave] = valor
    onChange(siguiente)
  }

  return (
    <div className="grid gap-2">
      {titulo && <p className="eyebrow">{titulo}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        {campos.map((campo) => {
          const valor = valores[campo.clave]

          if (campo.tipo === 'si_no') {
            return (
              <label key={campo.clave} className="flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={valor === true}
                  onChange={(e) => set(campo.clave, e.target.checked ? true : null)}
                  className="h-5 w-5 rounded border-line accent-[rgb(var(--accent))]"
                />
                {campo.etiqueta}
              </label>
            )
          }

          return (
            <label key={campo.clave} className="text-xs text-muted">
              {campo.etiqueta}
              {campo.unidad ? ` (${campo.unidad})` : ''}
              <input
                type={campo.tipo === 'numero' ? 'number' : campo.tipo === 'fecha' ? 'date' : 'text'}
                inputMode={campo.tipo === 'numero' ? 'decimal' : undefined}
                value={valor === undefined || valor === null ? '' : String(valor)}
                autoCapitalize={campo.tipo === 'texto' ? 'off' : undefined}
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => {
                  const bruto = e.target.value
                  if (campo.tipo !== 'numero') {
                    set(campo.clave, bruto)
                    return
                  }
                  // Un número a medio escribir —«12,» o «-»— no es un número, y
                  // convertirlo a NaN borraría lo tecleado bajo el dedo. Se
                  // guarda el texto hasta que sea un número de verdad.
                  const n = Number(bruto.replace(',', '.'))
                  set(campo.clave, bruto === '' ? null : Number.isFinite(n) ? n : bruto)
                }}
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink"
              />
            </label>
          )
        })}
      </div>
    </div>
  )
}

/** Los campos con valor, en una línea: «Resolución 1920×1080 · RAM 16 GB». */
export function resumirCampos(campos: SpecField[], valores: SpecValues): string {
  return campos
    .map((c) => {
      const v = valores[c.clave]
      if (v === undefined || v === null || v === '') return null
      if (c.tipo === 'si_no') return v === true ? c.etiqueta : null
      return `${c.etiqueta} ${v}${c.unidad ? ` ${c.unidad}` : ''}`
    })
    .filter(Boolean)
    .join(' · ')
}
