/**
 * Quién es quién, en el dispositivo.
 *
 * Las incidencias bajan al espejo y se leen del servidor con `opened_by` y
 * `resolved_by`, que son uuids. Sin una forma de traducirlos, la lista decía qué
 * pasa y dónde, pero no quién lo apuntó ni quién lo cerró — y esa es la
 * pregunta que se hace en cuanto algo no cuadra: «¿esto quién lo vio?».
 *
 * El directorio sale de `nombres_del_personal()`, que da el nombre de cada
 * perfil al personal sin abrirle el correo ni el rol (migración del 15 de
 * octubre). Pesa unas decenas de filas y se baja con el maestro.
 */

import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'

/** Dónde vive el directorio en `meta`: `{ [id]: nombre }`. */
export const PERSONAS = 'personas'

type Directorio = Record<string, string>

/**
 * Junta lo que había con lo que llega, sin perder a nadie.
 *
 * Nunca se borra un nombre: quien se dio de baja sigue siendo quien firmó lo que
 * firmó, y su revisión de hace un año no puede volver a quedarse sin autor. Y
 * una respuesta corta —el servidor sin la migración solo le enseña a un técnico
 * su propio perfil— no puede vaciar el directorio que ya se tenía.
 */
export function juntarDirectorio(
  anterior: Directorio,
  filas: ReadonlyArray<{ id: string; full_name: string | null }>,
): Directorio {
  const junto: Directorio = { ...anterior }
  for (const f of filas) {
    const nombre = f.full_name?.trim()
    if (f.id && nombre) junto[f.id] = nombre
  }
  return junto
}

/**
 * Baja el directorio y lo guarda. No lanza: sin él la aplicación funciona
 * igual, solo que las filas salen sin firma.
 */
export async function pullPersonas(): Promise<void> {
  try {
    const rpc = await supabase.rpc('nombres_del_personal')
    let filas = rpc.error ? null : (rpc.data as Array<{ id: string; full_name: string | null }> | null)
    // Un servidor sin la migración no tiene la función. `profiles` le da al
    // supervisor la plantilla entera y al técnico al menos su nombre.
    if (!filas) {
      const res = await supabase.from('profiles').select('id, full_name')
      if (res.error) return
      filas = res.data as Array<{ id: string; full_name: string | null }>
    }
    if (filas.length === 0) return

    const anterior = ((await db.meta.get(PERSONAS))?.value as Directorio | undefined) ?? {}
    await db.meta.put({ key: PERSONAS, value: juntarDirectorio(anterior, filas) })
  } catch {
    // Sin red o sin respuesta: se queda el que había.
  }
}

const VACIO: Directorio = {}

/** El directorio entero, `{ [id]: nombre }`, para quien necesita la lista. */
export function useDirectorio(): Readonly<Directorio> {
  return useLiveQuery(
    async () => ((await db.meta.get(PERSONAS))?.value as Directorio | undefined) ?? VACIO,
    [],
    VACIO,
  )
}

/**
 * El nombre de quien firmó, leído del directorio local.
 *
 * Devuelve una función y no el mapa para que quien pinta no tenga que saber
 * cómo se guarda: pasa el uuid, recibe un nombre o `null`.
 */
export function usePersonas(): (id: string | null | undefined) => string | null {
  const dir = useDirectorio()
  return (id) => (id ? (dir[id] ?? null) : null)
}
