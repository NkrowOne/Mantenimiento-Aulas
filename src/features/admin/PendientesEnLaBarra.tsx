import { useQuery } from '@tanstack/react-query'
import { CLAVE_PENDIENTES, contarPendientes, totalPendientes } from './pendientes'

/**
 * El número que va pegado a «Datos» en la barra de abajo.
 *
 * Es lo que hace que una retirada por autorizar se vea desde «Revisar», sin
 * entrar a mirar: antes, lo pendiente en Datos solo lo descubría quien abría
 * Datos, que es justo quien ya iba a verlo.
 *
 * Solo se monta para quien ve la pestaña —la barra ya filtra por rol—, así
 * que las siete cuentas no se piden a nadie que no pueda leerlas. Misma clave
 * de caché que la cabecera de Datos: cada decisión que se toma allí lo
 * actualiza aquí, y cada cinco minutos se vuelve a contar por si decidió otro.
 */
export function PendientesEnLaBarra(): React.ReactElement | null {
  const { data } = useQuery({
    queryKey: CLAVE_PENDIENTES,
    queryFn: contarPendientes,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  })
  const n = data ? totalPendientes(data) : 0
  if (n === 0) return null

  return (
    <span
      aria-label={`${n} ${n === 1 ? 'cosa por decidir' : 'cosas por decidir'}`}
      className="ml-1.5 inline-flex min-w-5 items-center justify-center rounded-tag bg-warn-tint px-1.5 py-px font-mono text-[0.625rem] font-semibold text-warn tabular"
    >
      {n > 99 ? '99+' : n}
    </span>
  )
}
