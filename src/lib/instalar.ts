/**
 * «Instalar en este móvil»: el aviso de instalación de Chrome, guardado para
 * cuando se pida.
 *
 * En Android, Chrome ofrece instalar una aplicación web —icono en la pantalla
 * de inicio, sin barra de direcciones— solo por su propio menú, y nadie mira
 * ese menú. El navegador avisa con `beforeinstallprompt` de que se puede; aquí
 * se guarda ese aviso y se enseña una acción en «Más» mientras siga valiendo.
 * En iOS no existe el evento y la acción no aparece: allí es «Compartir →
 * Añadir a pantalla de inicio», y lo cuenta la guía.
 */

import { useSyncExternalStore } from 'react'

interface EventoDeInstalacion extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let pendiente: EventoDeInstalacion | null = null
const oyentes = new Set<() => void>()

function avisar(): void {
  for (const oyente of oyentes) oyente()
}

/** Una vez, al arrancar: el aviso llega poco después de cargar, y solo una vez. */
export function vigilarLaInstalacion(ventana: Window = window): void {
  ventana.addEventListener('beforeinstallprompt', (e) => {
    // Sin esto Chrome saca su propia barra, en un momento que no elige nadie.
    e.preventDefault()
    pendiente = e as EventoDeInstalacion
    avisar()
  })
  ventana.addEventListener('appinstalled', () => {
    pendiente = null
    avisar()
  })
}

export function sePuedeInstalar(): boolean {
  return pendiente !== null
}

/** Pide instalar. Tiene que llamarse desde un toque: el navegador lo exige. */
export async function pedirInstalar(): Promise<'aceptada' | 'rechazada' | 'no-disponible'> {
  const evento = pendiente
  if (!evento) return 'no-disponible'
  // El aviso solo sirve una vez: si dice que no, Chrome tarda en volver a darlo.
  pendiente = null
  avisar()
  try {
    await evento.prompt()
    const { outcome } = await evento.userChoice
    return outcome === 'accepted' ? 'aceptada' : 'rechazada'
  } catch {
    return 'no-disponible'
  }
}

function suscribir(oyente: () => void): () => void {
  oyentes.add(oyente)
  return () => oyentes.delete(oyente)
}

/** ¿Se puede ofrecer instalar ahora mismo? Cambia solo, sin recargar. */
export function useSePuedeInstalar(): boolean {
  return useSyncExternalStore(suscribir, sePuedeInstalar, () => false)
}
