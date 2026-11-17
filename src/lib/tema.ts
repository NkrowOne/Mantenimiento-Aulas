/**
 * Claro, oscuro, o lo que diga el aparato.
 *
 * Los dos temas existían desde el principio —`tokens.css` los declara enteros—
 * pero solo se podía llegar al oscuro cambiando el ajuste del sistema, que
 * cambia el de TODAS las aplicaciones. Y el caso real es justo el contrario: el
 * iPad está en claro todo el día y el técnico entra en un aula a oscuras con el
 * proyector encendido, donde una pantalla blanca deslumbra a quien la sujeta y
 * a media clase. Ahora se elige aquí, desde «Más», y se queda elegido.
 *
 * Se guarda en `localStorage` y no en Dexie a propósito: el tema hay que
 * saberlo ANTES de pintar nada, y `localStorage` es lo único que se puede leer
 * de forma síncrona. `index.html` lleva las tres líneas que lo aplican antes de
 * que cargue la aplicación; con Dexie habría un fogonazo en claro en cada
 * arranque, que es precisamente lo que alguien que eligió oscuro no quiere ver.
 * Es una preferencia del aparato y no un dato de trabajo: perderla no pierde
 * nada.
 */

import { useSyncExternalStore } from 'react'

export type Tema = 'sistema' | 'claro' | 'oscuro'

/** La misma clave que lee el guion de `index.html`. Si cambia una, cambian las dos. */
const CLAVE = 'aulas-tema'

/** El color de la barra del sistema en cada tema: el de los `meta` de `index.html`. */
const BARRA = { claro: '#046A78', oscuro: '#0A0C0E' } as const

const oyentes = new Set<() => void>()

function leer(): Tema {
  try {
    const v = localStorage.getItem(CLAVE)
    return v === 'claro' || v === 'oscuro' ? v : 'sistema'
  } catch {
    // Safari en modo privado puede negar `localStorage`: se sigue al sistema.
    return 'sistema'
  }
}

function aplicar(tema: Tema): void {
  const raiz = document.documentElement
  if (tema === 'sistema') delete raiz.dataset['theme']
  else raiz.dataset['theme'] = tema === 'oscuro' ? 'dark' : 'light'

  /*
   * La barra del sistema —la de la hora y la batería en Android, y el marco de
   * la ventana en la aplicación instalada— sigue a los `meta theme-color`. Hay
   * dos, uno por esquema del SISTEMA; cuando el tema lo elige la persona hay
   * que escribir el mismo color en los dos, o un iPad en claro con la
   * aplicación en oscuro se queda con la barra petróleo encima de una pantalla
   * grafito.
   */
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const delSistema = meta.media.includes('dark') ? BARRA.oscuro : BARRA.claro
    const color = tema === 'sistema' ? delSistema : BARRA[tema]
    // Solo si cambia. Al arrancar casi nunca cambia nada, y reescribir el mismo
    // valor es tocar los `meta` de la barra del sistema sin necesidad: iOS 26
    // vuelve a decidir qué pinta arriba cada vez que se mueven.
    if (meta.content !== color) meta.content = color
  }
}

export function ponerTema(tema: Tema): void {
  try {
    if (tema === 'sistema') localStorage.removeItem(CLAVE)
    else localStorage.setItem(CLAVE, tema)
  } catch {
    /* Sin almacenamiento el tema vale para esta sesión, que ya es algo. */
  }
  aplicar(tema)
  for (const avisar of oyentes) avisar()
}

/** Al arrancar: deja los `meta` de acuerdo con lo que `index.html` ya aplicó. */
export function iniciarTema(): void {
  aplicar(leer())
}

function suscribir(avisar: () => void): () => void {
  oyentes.add(avisar)
  return () => oyentes.delete(avisar)
}

export function useTema(): Tema {
  return useSyncExternalStore(suscribir, leer, () => 'sistema' as const)
}
