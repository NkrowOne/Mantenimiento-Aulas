/**
 * El informe, generado en el servidor con el código de la aplicación.
 *
 * QUÉ RESUELVE. El informe se arma en el navegador, y eso tiene un límite que
 * se nota en un iPhone: en cuanto la aplicación pasa a segundo plano —se
 * bloquea la pantalla, se abre el correo para ver a quién hay que mandárselo—
 * el sistema la congela, las peticiones a medias se cortan y el informe se
 * queda sin hacer. Con la IA redactando, eso es hasta un minuto con la
 * pantalla encendida y sin tocar nada.
 *
 * Ahora la pantalla solo lo PIDE. El servidor de informes —el que ya convertía
 * el documento a PDF— lo genera entero, lo deja en el archivo y apunta por
 * dónde va en `report_jobs`. Se puede cerrar la aplicación: al volver, está.
 *
 * POR QUÉ CON ESTE CÓDIGO Y NO CON OTRO. El servidor ya tuvo su propia copia
 * de los datos, del análisis y de la plantilla, y a los dos meses eran dos
 * informes distintos: el de la pantalla y el del viernes. Aquí no hay copia.
 * `generarInforme` es la misma función que llama el botón, con sus mismas
 * consultas y sus mismos permisos —va con la sesión de quien lo pidió, no con
 * la clave de servicio, así que lee exactamente lo que esa persona leería—.
 *
 * LO ÚNICO PROPIO DE AQUÍ es repartir la sesión. El código del informe usa un
 * cliente de Supabase que es uno para toda la aplicación; en el servidor puede
 * haber dos informes de dos personas a la vez. `AsyncLocalStorage` lleva el
 * cliente de cada informe por todo su recorrido asíncrono, y lo que el código
 * del informe ve en `@/lib/supabase` es un reparto: cada consulta sale con la
 * sesión del informe desde el que se hizo.
 *
 * Este fichero NO llega al navegador: nada de `src/` lo importa salvo el
 * servidor (`reports-worker/src/informe-generar.ts`).
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase, usarCliente } from '@/lib/supabase'
import type { Eleccion } from '@/features/reports/peticion'
import {
  type Avisar,
  type DondeCorre,
  type InformeGenerado,
  generarInforme,
} from '@/features/reports/informe/generar'

type Cliente = typeof supabase

/** El cliente del informe que se está haciendo en este hilo de ejecución. */
const deEsteInforme = new AsyncLocalStorage<Cliente>()

/**
 * El reparto. Cada acceso se resuelve contra el cliente del informe en curso.
 *
 * Fuera de un informe no hay cliente, y eso se dice: devolver uno cualquiera
 * —el de otra persona, o uno sin sesión— sería leer con los permisos de quien
 * no es, que es el único fallo de este fichero que no se puede permitir.
 */
const reparto = new Proxy({} as Cliente, {
  get(_objetivo, propiedad) {
    const cliente = deEsteInforme.getStore()
    if (!cliente) {
      throw new Error(
        'El informe ha intentado leer datos fuera de su trabajo: no hay sesión con la que hacerlo.',
      )
    }
    const valor: unknown = Reflect.get(cliente, propiedad, cliente)
    return typeof valor === 'function'
      ? (valor as (...a: unknown[]) => unknown).bind(cliente)
      : valor
  },
})

usarCliente(reparto)

/** Quién pide el informe: para firmar la portada y la fila del archivo. */
export interface QuienPide {
  id: string
  /** Su sesión, tal como llegó. No se guarda en ningún sitio. */
  token: string
}

/**
 * Un cliente que dice de quién es.
 *
 * El informe pregunta `auth.getSession()` para saber a nombre de quién va. El
 * cliente del servidor no tiene sesión propia —lleva el token en la cabecera y
 * nada más—, así que contestaría «nadie» y el informe saldría sin «lo pidió» y
 * sin autor en el archivo. Se le pone delante la respuesta que corresponde.
 */
function conSuSesion(cliente: SupabaseClient, quien: QuienPide): Cliente {
  const auth = {
    getSession: () =>
      Promise.resolve({
        data: { session: { access_token: quien.token, user: { id: quien.id } } },
        error: null,
      }),
  }
  return Object.create(cliente, { auth: { value: auth, enumerable: true } }) as Cliente
}

/**
 * Genera el informe con la sesión de quien lo pidió y lo deja en el archivo.
 *
 * Devuelve lo mismo que en el navegador. Sin Excel: no se archiva, se rehace
 * de los movimientos cuando alguien lo pide.
 */
export function generarEnElServidor(
  cliente: SupabaseClient,
  quien: QuienPide,
  eleccion: Eleccion,
  avisar: Avisar = () => undefined,
  en: Omit<DondeCorre, 'sinExcel'> = {},
): Promise<InformeGenerado> {
  return deEsteInforme.run(conSuSesion(cliente, quien), () =>
    generarInforme(eleccion, avisar, { ...en, sinExcel: true }),
  )
}

export type { Avisar, InformeGenerado, Paso } from '@/features/reports/informe/generar'
export type { Eleccion } from '@/features/reports/peticion'
export { DIAS_MAXIMOS, construirPeticion } from '@/features/reports/peticion'
export { TOPE_ENFOQUE } from '@/features/reports/informe/opciones'
export { FOTO_LADO_LARGO } from '@/features/reports/informe/datos'
export { diasDelRango } from '@/features/reports/periodos'
