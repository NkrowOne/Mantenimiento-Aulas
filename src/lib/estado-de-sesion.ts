/**
 * Un `useState` que no se olvida al cambiar de pantalla.
 *
 * Cada pestaña se desmonta al salir de ella (ver `App.tsx`), y con ella se iba
 * todo lo que se hubiera elegido dentro: se buscaba «hdmi» en Almacén, se
 * pasaba un momento a Incidencias a mirar una cosa, se volvía, y el buscador
 * estaba vacío y el filtro en «Todo». Lo mismo con «Incluir resueltas», con la
 * pestaña de Equipos y con los cinco filtros de Historial, que cuesta ocho
 * toques volver a montar. Lo único que se recordaba en toda la aplicación era
 * la sección de Datos.
 *
 * Esto guarda el valor en `sessionStorage` cada vez que cambia y lo recupera al
 * montar. `sessionStorage` y no `localStorage` a propósito: dura lo que dura la
 * aplicación abierta —una jornada—, y al día siguiente se empieza limpio. Un
 * filtro olvidado de hace una semana es una lista medio vacía que nadie
 * entiende.
 *
 * Lo que se lee de ahí viene de fuera del tipo: lo pudo escribir otra versión
 * de la aplicación. Por eso se comprueba antes de usarlo —con la forma del
 * valor inicial, o con `valido` cuando eso no basta, como en una lista cerrada
 * de opciones— y lo que no cuadra se descarta en silencio.
 */

import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'

const PREFIJO = 'aulas.estado.'

/** ¿Tiene `valor` la misma forma que `modelo`? Un nivel: es lo que se guarda aquí. */
function mismaForma(valor: unknown, modelo: unknown): boolean {
  if (modelo === null || typeof modelo !== 'object') return typeof valor === typeof modelo
  if (valor === null || typeof valor !== 'object' || Array.isArray(valor) !== Array.isArray(modelo)) {
    return false
  }
  const a = valor as Record<string, unknown>
  const b = modelo as Record<string, unknown>
  return Object.keys(b).every(
    (k) => k in a && (b[k] === null || a[k] === null || typeof a[k] === typeof b[k]),
  )
}

function leer<T>(clave: string, inicial: T, valido?: (v: unknown) => boolean): T {
  try {
    const crudo = sessionStorage.getItem(PREFIJO + clave)
    if (crudo === null) return inicial
    const valor: unknown = JSON.parse(crudo)
    return (valido ? valido(valor) : mismaForma(valor, inicial)) ? (valor as T) : inicial
  } catch {
    // Sin almacenamiento, o con algo que no es JSON: se empieza de cero.
    return inicial
  }
}

export function useEstadoDeSesion<T>(
  clave: string,
  inicial: T,
  /** Para cuando la forma no basta: `(v) => OPCIONES.includes(v)`. */
  valido?: (valor: unknown) => boolean,
): [T, Dispatch<SetStateAction<T>>] {
  const [valor, setValor] = useState<T>(() => leer(clave, inicial, valido))

  const poner = useCallback<Dispatch<SetStateAction<T>>>(
    (siguiente) => {
      setValor((anterior) => {
        const nuevo =
          typeof siguiente === 'function' ? (siguiente as (a: T) => T)(anterior) : siguiente
        try {
          sessionStorage.setItem(PREFIJO + clave, JSON.stringify(nuevo))
        } catch {
          /* Lleno o negado: el valor vale para esta pantalla, como antes. */
        }
        return nuevo
      })
    },
    [clave],
  )

  return [valor, poner]
}

/**
 * Deja escrito un valor para que la pantalla que lo use lo encuentre al
 * montarse. Es como un atajo le dice a otra pantalla con qué filtro abrir: la
 * ficha de un aula escribe aquí su edificio y su sala y cambia a Historial, que
 * al montar los lee como si alguien los hubiera elegido a mano.
 */
export function ponerEstadoDeSesion(clave: string, valor: unknown): void {
  try {
    sessionStorage.setItem(PREFIJO + clave, JSON.stringify(valor))
  } catch {
    /* Sin almacenamiento, la otra pantalla abre sin filtro: como antes. */
  }
}

/**
 * Olvida todo lo recordado. Se llama al cerrar sesión: en un iPad compartido,
 * quien entra después no tiene por qué encontrarse la búsqueda de quien salió.
 */
export function olvidarEstadoDeSesion(): void {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const clave = sessionStorage.key(i)
      if (clave?.startsWith(PREFIJO)) sessionStorage.removeItem(clave)
    }
  } catch {
    /* Nada que olvidar. */
  }
}
