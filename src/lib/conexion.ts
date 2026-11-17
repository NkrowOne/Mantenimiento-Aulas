import { useEffect, useState } from 'react'
import { onSyncState } from '@/sync/outbox'

/**
 * ¿Está este dispositivo sin conexión, ahora?
 *
 * Dos fuentes, porque ninguna basta sola. `navigator.onLine` dice si hay ALGUNA
 * red —la wifi de un sótano que no llega a ningún sitio cuenta como «hay»— y el
 * motor de sincronización dice si el último intento de hablar con el servidor
 * se quedó sin red de verdad. Cualquiera de las dos que diga que no, es que no.
 *
 * Es un gancho y no una lectura suelta para que lo que lo usa cambie solo: un
 * aviso de «guardado en este dispositivo» tiene que dejar de decirlo en cuanto
 * vuelve la conexión, sin que nadie recargue.
 */
export function useSinConexion(): boolean {
  const [sinRed, setSinRed] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine)
  const [motorSinRed, setMotorSinRed] = useState(false)

  useEffect(() => {
    const mirar = (): void => setSinRed(!navigator.onLine)
    window.addEventListener('online', mirar)
    window.addEventListener('offline', mirar)
    const soltar = onSyncState((estado) => setMotorSinRed(estado === 'sin-conexion'))
    return () => {
      window.removeEventListener('online', mirar)
      window.removeEventListener('offline', mirar)
      soltar()
    }
  }, [])

  return sinRed || motorSinRed
}
