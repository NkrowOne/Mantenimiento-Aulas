/**
 * El triángulo de «aquí hay averías sin resolver».
 *
 * Es la misma señal en la lista de salas y en la de edificios, y va en rojo
 * (`crit`) a propósito: el naranja de esas listas ya significa «toca revisar»,
 * que es un aviso de calendario; una incidencia abierta es un hecho — algo
 * está roto y alguien tiene que arreglarlo. Mezclar los dos colores devaluaría
 * ambos.
 *
 * El número solo aparece a partir de dos. Con una, el triángulo ya lo dice
 * todo y la fila queda más limpia; con varias, la cifra es la diferencia entre
 * «pasa un momento» y «llévate la caja de herramientas».
 */
export function InsigniaAveria({
  n,
  detalle,
}: {
  n: number
  /** Lo que lee el lector de pantalla y enseña el ratón: «3 averías abiertas». */
  detalle: string
}): React.ReactElement | null {
  if (n <= 0) return null

  return (
    <span
      role="img"
      aria-label={detalle}
      title={detalle}
      className="inline-flex shrink-0 items-center gap-1 text-crit"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 3.5 21.5 20h-19L12 3.5Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path d="M12 10v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="17" r="1.15" fill="currentColor" />
      </svg>
      {n > 1 && <span className="text-xs font-semibold tabular">{n}</span>}
    </span>
  )
}

/** El texto del detalle, con su plural, para no repetirlo en cada lista. */
export function detalleDeAverias(n: number): string {
  return n === 1 ? '1 incidencia abierta' : `${n} incidencias abiertas`
}
