/**
 * Tocar el maestro desde la lista de trabajo: renombrar, añadir y dar de baja.
 *
 * Todo lo de aquí va por RPC **en línea** y nada entra en la cola de salida, y
 * esa asimetría con el resto de la aplicación es la decisión de fondo:
 *
 *  - Lo que el técnico produce —revisiones, incidencias, fotos— nace en el aula
 *    y no se puede repetir, así que se guarda sin red y sube cuando la haya.
 *  - El maestro es la lista sobre la que trabajan 23 dispositivos a la vez. Una
 *    sala renombrada en dos iPads sin cobertura son dos verdades sin forma de
 *    reconciliar; y peor: la poda de `pullMaster()` no respeta la cola de
 *    salida, así que un renombrado encolado se sobrescribiría con el `bulkPut`
 *    de la descarga siguiente en ≤2 minutos, en silencio. Ese es el peor modo
 *    de fallo posible — el que nadie ve.
 *
 * Y renombrar no es urgente estando de pie delante de la puerta. Revisar sí, y
 * revisar sigue funcionando sin red.
 *
 * El orden de `aplicarOperacion` —RPC, espejo, descarga, invalidación— no es
 * casual y está explicado ahí abajo, línea a línea.
 */

import type { QueryClient } from '@tanstack/react-query'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { pullMaster } from '@/sync/pull'
import { mismaPlanta, plantaQueAbsorbe } from '@/domain/nomenclatura'
import { EMPTY_CAPABILITIES, type Room, type RoomKind, type Zone } from '@/domain/types'

/**
 * Lo que se lee debajo de las acciones cuando no hay cobertura.
 *
 * Se enseñan deshabilitadas y con el motivo escrito, no escondidas: un botón
 * que desaparece convierte «no está» en un misterio, y el motivo explica la
 * asimetría en vez de dejarla como capricho. Vive aquí, en una constante, para
 * que el panel de «Datos» pueda decir exactamente lo mismo.
 */
export const AVISO_SIN_RED =
  'Renombrar, añadir y dar de baja necesitan conexión: el maestro lo valida el servidor y lo ' +
  'comparten todos los iPads. Vuelve cuando tengas cobertura — revisar sigue funcionando sin red.'

export type OperacionDeMaestro =
  | { kind: 'renombrar-edificio'; id: string; code: string; name: string }
  | { kind: 'baja-edificio'; id: string; code: string }
  | { kind: 'restaurar-edificio'; id: string; code: string }
  | { kind: 'renombrar-sala'; id: string; code: string; name: string; zona: string | null }
  | { kind: 'baja-sala'; id: string; code: string }
  | { kind: 'renombrar-planta'; id: string; name: string }
  | {
      kind: 'nueva-sala'
      building: string
      zone: string
      code: string
      name: string
      tipo: RoomKind
    }

// -----------------------------------------------------------------------------
// Lo puro: los mensajes y la traducción de los fallos
// -----------------------------------------------------------------------------

/**
 * La frase que se enseña, compuesta con lo que haya decidido el servidor.
 *
 * Las tres funciones que pueden hacer dos cosas distintas lo dicen en su
 * respuesta —`archivado`/`borrado`, `renombrada`/`movida`,
 * `renombrada`/`fusionada`— porque el cliente no puede saberlo: si un edificio
 * tiene histórico, o si esa planta ya existía escrita de otra forma, solo lo ve
 * quien tiene la base de datos delante. Repetir aquí esa decisión sería
 * adivinarla, y adivinar mal produce el mensaje más caro que hay: uno que
 * asegura que se ha archivado algo que se borró.
 */
export function mensajeDeOperacion(op: OperacionDeMaestro, respuesta: string | null): string {
  switch (op.kind) {
    case 'renombrar-edificio':
      return (
        `Edificio ${op.code} renombrado. El código anterior queda de alias en cada una de sus ` +
        'salas, así que las incidencias antiguas se siguen resolviendo.'
      )

    case 'baja-edificio':
      return respuesta === 'archivado'
        ? `Edificio ${op.code} archivado: sale de la lista de trabajo y de los iPads, con sus ` +
            'salas y su histórico intactos. Se restaura desde «Datos» cuando haga falta.'
        : `Edificio ${op.code} borrado. Estaba vacío, así que no había nada que conservar y su ` +
            'código vuelve a quedar libre.'

    case 'restaurar-edificio':
      return `Edificio ${op.code} restaurado: vuelve a la lista de trabajo con todo lo suyo.`

    case 'renombrar-sala':
      return respuesta === 'movida'
        ? `Sala ${op.code} renombrada y movida de planta. La matrícula de la placa no cambia.`
        : `Sala ${op.code} renombrada. La matrícula de la placa no cambia y el código anterior ` +
            'queda de alias.'

    case 'baja-sala':
      return respuesta === 'archivada'
        ? `Sala ${op.code} archivada: tenía histórico, así que se conserva entero y sale de la ` +
            'lista de trabajo.'
        : `Sala ${op.code} borrada.`

    case 'renombrar-planta':
      return respuesta === 'fusionada'
        ? `Plantas fusionadas: sus aulas están ahora en «${op.name}».`
        : `Planta renombrada a «${op.name}».`

    case 'nueva-sala':
      return `Sala ${op.code} creada, con su matrícula y su equipamiento por defecto.`
  }
}

/** La forma con la que PostgREST devuelve un fallo. No es un `Error`. */
interface FalloDePostgrest {
  message?: unknown
  code?: unknown
}

/**
 * Cómo se reconoce que lo que ha fallado es la red y no el servidor.
 *
 * Por el texto y no por el tipo, y eso hay que explicarlo porque lo natural
 * sería `fallo instanceof TypeError`: cuando `fetch` muere a mitad, el navegador
 * lanza un `TypeError` de verdad —«Failed to fetch» en Chrome, «Load failed» en
 * el Safari del iPad, «NetworkError…» en Firefox—, pero ese `TypeError` no llega
 * hasta aquí. `postgrest-js` lo captura y lo devuelve APLANADO en el mismo objeto
 * literal que usa para todo lo demás: `{ message: 'TypeError: Failed to fetch',
 * details, hint, code: '' }`. Un objeto literal nunca es instancia de nada, así
 * que la comprobación por tipo no se cumplía jamás y el admin del sótano recibía
 * en rojo, en inglés y con el nombre de la clase delante, el volcado del
 * navegador en vez de la frase que explica qué hacer.
 *
 * El `code` vacío es la otra mitad de la firma: un fallo del servidor SIEMPRE
 * trae `SQLSTATE` (`P0001`, `23505`…) o un código de PostgREST (`PGRST202`), así
 * que un mensaje de red con un código dentro sería un mensaje del servidor que
 * casualmente habla de fetch — y ese hay que enseñarlo tal cual.
 */
const FALLO_DE_RED = /failed to fetch|networkerror|load failed|network request failed/i

/**
 * El fallo del servidor, en castellano llano.
 *
 * La regla principal: **cuando el mensaje lo escribimos nosotros, se respeta
 * tal cual**. Un `raise exception` de una de estas funciones llega con el
 * código `P0001` y con una frase pensada para esta pantalla —«El código H es de
 * un edificio que está en la papelera. Restáuralo desde Datos en vez de crearlo
 * otra vez»—, y cualquier reescritura por nuestra parte solo puede empeorarla.
 *
 * Lo que sí hay que traducir es lo que escribe Postgres, que habla de índices y
 * de relaciones: `23505` delante de alguien que acaba de teclear un código es
 * «duplicate key value violates unique constraint "rooms_zone_id_code_key"», y
 * eso no es una frase, es un volcado.
 */
export function explicarFallo(fallo: unknown): string {
  if (fallo === null || typeof fallo !== 'object') return 'No se ha podido aplicar.'

  const { message, code } = fallo as FalloDePostgrest
  const texto = typeof message === 'string' && message.trim() !== '' ? message.trim() : null
  const codigo = typeof code === 'string' ? code : null

  // Nuestros propios `raise exception`: ya vienen escritos para esta pantalla.
  if (codigo === 'P0001' && texto) return texto

  if (codigo === '23505') {
    return 'Ese código ya lo tiene otra ficha. Los códigos son únicos, así que elige otro o corrige el que ya existe.'
  }
  if (codigo === '23503') {
    return 'Hay histórico colgando de esto, así que no se puede borrar. Dalo de baja: se archiva y se conserva entero.'
  }
  if (codigo === '42501') {
    return 'Solo un administrador puede tocar la nomenclatura. Vuelve a entrar con una cuenta que lo sea.'
  }
  if (codigo === 'PGRST202') {
    return (
      'El servidor todavía no conoce esta operación: le falta aplicar la última migración. ' +
      'Avisa a quien despliega — desde el iPad no hay nada que hacer.'
    )
  }
  // La red cayéndose a mitad de la llamada. `navigator.onLine` ya no ayuda a
  // estas alturas: iOS lo da por bueno delante de un portal cautivo y, en
  // cualquier caso, la comprobación de `aplicarOperacion` es anterior al viaje.
  if ((codigo === '' || codigo === null) && texto !== null && FALLO_DE_RED.test(texto)) {
    return AVISO_SIN_RED
  }

  return texto ?? 'No se ha podido aplicar.'
}

// -----------------------------------------------------------------------------
// Lo que toca la red y el espejo
// -----------------------------------------------------------------------------

async function llamar(nombre: string, args: Record<string, unknown>): Promise<string | null> {
  const { data, error } = await supabase.rpc(nombre, args)
  // Se convierte en `Error` aquí y no en la interfaz: PostgREST devuelve un
  // objeto plano, y `err instanceof Error ? err.message : …` —el molde que usa
  // todo el repo para pintar fallos— se quedaría con el «No se ha podido
  // aplicar» genérico justo cuando el servidor había explicado el motivo.
  if (error) throw new Error(explicarFallo(error))
  return typeof data === 'string' ? data : null
}

function rpcDe(op: OperacionDeMaestro): Promise<string | null> {
  switch (op.kind) {
    case 'renombrar-edificio':
      return llamar('rename_building', { p_id: op.id, p_code: op.code, p_name: op.name })
    case 'baja-edificio':
      return llamar('delete_building', { p_id: op.id })
    case 'restaurar-edificio':
      return llamar('restore_building', { p_id: op.id })
    case 'renombrar-sala':
      return llamar('rename_room', {
        p_id: op.id,
        p_code: op.code,
        p_name: op.name,
        // Nulo es «no mover», y no «llévala a SIN ZONA»: eso último es el
        // valor por defecto de un alta, no el de un renombrado.
        p_zone: op.zona,
      })
    case 'baja-sala':
      return llamar('delete_room', { p_id: op.id })
    case 'renombrar-planta':
      return llamar('rename_zone', { p_id: op.id, p_name: op.name })
    case 'nueva-sala':
      return llamar('create_room', {
        p_building: op.building,
        p_zone: op.zone,
        p_code: op.code,
        p_name: op.name,
        p_kind: op.tipo,
      })
  }
}

/** La planta de ESE edificio que se llama así, con la regla del servidor. */
async function zonaPorNombre(edificio: string, nombre: string): Promise<Zone | undefined> {
  const zonas = await db.zones.where('building_id').equals(edificio).toArray()
  return zonas.find((z) => mismaPlanta(z.name, nombre))
}

/**
 * Aplicar en el espejo local lo que el servidor ya ha confirmado.
 *
 * No es una apuesta optimista —el RPC ya ha contestado que sí—, es evitar que
 * la pantalla se quede un rato enseñando lo viejo. Y en un caso concreto no es
 * ni cosmético: `podar()` se planta ante una respuesta vacía o incompleta
 * (`pull.ts:207`), así que archivar el ÚLTIMO edificio deja `buildings` a cero
 * filas y la poda no lo borraría nunca del iPad. Sin la limpieza de aquí abajo,
 * la fila de un edificio archivado se quedaría en la lista para siempre.
 *
 * Lo que no se resuelve en local no se inventa: si la planta de destino todavía
 * no está en el espejo —la acaba de crear el servidor— se deja como está y lo
 * arregla el `pullMaster()` de la línea siguiente.
 */
async function espejo(op: OperacionDeMaestro, respuesta: string | null): Promise<void> {
  switch (op.kind) {
    case 'renombrar-edificio':
      await db.buildings.update(op.id, { code: op.code, name: op.name })
      return

    case 'baja-edificio': {
      /*
       * De abajo arriba y siempre, tanto si el servidor archivó como si borró:
       * para este dispositivo las dos cosas significan lo mismo —ese edificio
       * ya no es trabajo—, y la diferencia solo importa en la papelera de
       * «Datos», que lee del servidor.
       */
      const zonas = await db.zones.where('building_id').equals(op.id).toArray()
      const ids = zonas.map((z) => z.id)
      if (ids.length > 0) {
        await db.rooms.where('zone_id').anyOf(ids).delete()
        await db.zones.bulkDelete(ids)
      }
      await db.buildings.delete(op.id)
      return
    }

    case 'restaurar-edificio':
      // Nada que escribir: lo que vuelve es el edificio entero con sus zonas y
      // sus salas, y eso lo trae la descarga sin que haya que reconstruirlo a
      // mano desde una lista que este dispositivo ya no tiene.
      return

    case 'renombrar-sala': {
      const cambios: { code: string; name: string; zone_id?: string } = {
        code: op.code,
        name: op.name.trim() === '' ? op.code : op.name,
      }
      if (op.zona !== null && op.zona.trim() !== '') {
        const sala = await db.rooms.get(op.id)
        const origen = sala ? await db.zones.get(sala.zone_id) : undefined
        const destino = origen ? await zonaPorNombre(origen.building_id, op.zona) : undefined
        if (destino) cambios.zone_id = destino.id
      }
      await db.rooms.update(op.id, cambios)
      return
    }

    case 'baja-sala':
      await db.rooms.delete(op.id)
      return

    case 'renombrar-planta': {
      const zona = await db.zones.get(op.id)
      if (!zona) return
      if (respuesta === 'fusionada') {
        /*
         * El servidor no devuelve el id de la planta que absorbe —solo dice que
         * ha fusionado— y no hace falta que lo devuelva: la planta de destino es
         * la que el cliente ya tenía delante cuando avisó de la fusión, la del
         * mismo edificio que se llama igual. Se resuelve con la misma regla que
         * usó el servidor, `norm_text`.
         */
        const zonas = await db.zones.where('building_id').equals(zona.building_id).toArray()
        const destino = plantaQueAbsorbe(op.name, zonas, op.id)
        if (destino) {
          await db.rooms.where('zone_id').equals(op.id).modify({ zone_id: destino.id })
          await db.zones.delete(op.id)
        }
        return
      }
      await db.zones.update(op.id, { name: op.name })
      return
    }

    case 'nueva-sala': {
      // `create_room` devuelve el uuid de la sala. Sin él no hay fila que
      // escribir, y tampoco pasa nada: la descarga la trae con su matrícula y su
      // equipamiento por defecto, que es justo lo que aquí no se puede fabricar.
      if (!respuesta) return
      const zona = await zonaPorNombre(op.building, op.zone.trim() === '' ? 'SIN ZONA' : op.zone)
      if (!zona) return
      const sala: Room = {
        id: respuesta,
        zone_id: zona.id,
        code: op.code,
        name: op.name.trim() === '' ? op.code : op.name,
        kind: op.tipo,
        capabilities: EMPTY_CAPABILITIES,
        projector_hours: null,
        lamp_pct: null,
        last_inspection_at: null,
        last_inventory_at: null,
        active: true,
        // La matrícula la pone un disparador del servidor y baja con el pull:
        // inventarla aquí sería imprimir una placa que no corresponde a nada.
        short_ref: null,
      }
      await db.rooms.put(sala)
      return
    }
  }
}

/**
 * Ejecuta la operación y deja el espejo coherente.
 *
 * El orden importa y es exactamente este:
 *
 *  1. **El RPC.** Si falla, se acabó: no se toca nada local. La verdad es lo
 *     que diga el servidor, y media aplicación de un cambio rechazado es peor
 *     que ninguna.
 *  2. **El espejo local**, con lo que el servidor acaba de confirmar.
 *  3. **`pullMaster()`**, y siempre DESPUÉS del RPC. Lanzada antes, su respuesta
 *     todavía traería los valores viejos y el `bulkPut` volvería a escribir
 *     encima justo lo que se acaba de cambiar.
 *  4. **Invalidar `['maestro']` y `['buildings']`**, que es lo que refresca el
 *     panel de «Datos» — el único sitio que lee del servidor con react-query.
 *     Las dos listas de trabajo no lo necesitan: leen Dexie con `useLiveQuery`
 *     y ya se han repintado en el paso 2.
 *
 * Devuelve la frase que se enseña, ya compuesta con lo que el servidor decidió.
 */
export async function aplicarOperacion(op: OperacionDeMaestro, qc: QueryClient): Promise<string> {
  // La interfaz ya deshabilita las acciones sin cobertura; esto cubre la
  // ventana entre abrir la hoja y pulsar, que en un pasillo dura lo que dura.
  if (!navigator.onLine) throw new Error(AVISO_SIN_RED)

  const respuesta = await rpcDe(op)
  await espejo(op, respuesta)
  await pullMaster()
  void qc.invalidateQueries({ queryKey: ['maestro'] })
  void qc.invalidateQueries({ queryKey: ['buildings'] })

  return mensajeDeOperacion(op, respuesta)
}
