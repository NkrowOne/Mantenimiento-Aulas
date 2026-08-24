/**
 * Ficha de sala.
 *
 * La pantalla del prototipo que nunca llegó a construirse, y la que sostiene las
 * piezas que faltaban.
 *
 * **Una — registrar sin que nada haya fallado.** Toda la aplicación asumía que un
 * registro nace de una revisión que sale mal. Pero la petición de instalar una
 * cámara no es una revisión que falla: es alguien que pasa por delante y ve algo.
 * Por eso el botón está aquí y está siempre disponible, no colgando de un bloque
 * en FALLA. Y por eso **basta la sala para guardar**: nada obliga a teclear de
 * pie en un pasillo. Lo aplazado aparece sin completar en Incidencias, que es
 * la contrapartida honesta de permitir aplazar — y no una pestaña propia: un
 * destino permanente en la barra para algo que casi siempre está vacío enseña a
 * no pulsarlo.
 *
 * **Dos — leer las revisiones anteriores, enteras.** Lo que se apuntaba en cada
 * visita —el resultado de cada aparato, las medidas, la observación de debajo de
 * las fotos, las fotos mismas— se guardaba y no se pintaba en ningún sitio:
 * exactamente el mismo destino que la columna de texto libre del Excel de la que
 * se venía huyendo. Ahora se lee aquí, que es donde alguien pregunta «qué se ha
 * dicho de esta aula». Y no en la pestaña de Incidencias: eso es la lista de lo
 * que hay que arreglar, y una nota de seguimiento no es trabajo pendiente.
 *
 * La observación vive dentro de su revisión y no en una sección aparte, y ese
 * cambio es deliberado: se escribió el mismo día que se comprobaron nueve cosas,
 * y leerla al lado de lo que se comprobó dice bastante más que leerla suelta. Una
 * sola puerta, además, en vez de dos listas que hablan de lo mismo.
 *
 * **Tres — cerrar lo que se acaba de arreglar, aquí mismo.** Resolver una
 * avería vivía en la pestaña de Incidencias: una lista de 283 filas, o sea un
 * escritorio. Quien la arregla está en el aula, con el aparato delante y a
 * menudo sin cobertura. Las averías vivas de la sala se listan aquí, se elige
 * cuál de ellas se ha resuelto —el proyector, la pantalla 2— y se cierra
 * **contando qué se hizo**, con una foto si hay algo que enseñar.
 *
 * La explicación es obligatoria, y no es una exigencia nueva: el Excel del que
 * se viene la tenía, y 276 de las 281 incidencias cerradas del histórico traen
 * su frase escrita. Lo que faltaba era pedirla aquí. Es lo que convierte el
 * cierre en algo que se puede leer en abril, cuando ese mismo proyector vuelva a
 * fallar y haya que decidir si es la misma avería o es otra — y es lo que sale
 * en el registro del periodo del informe, que ya pinta la resolución de cada
 * cierre.
 *
 * **Cuatro — corregir una revisión sin fabricar otra.** Una revisión cerrada es
 * inmutable, y con razón. Pero hasta ahora eso significaba que un error solo se
 * podía arreglar revisando otra vez: veinte revisiones nuevas que no son visitas
 * nuevas, cada una moviendo la fecha de «última revisión» y contando en el
 * informe. Desde la lista de revisiones se corrige la que salió mal, y la
 * corrección la reemplaza en todo lo que se cuenta sin borrarla.
 *
 * Lo que sí es trabajo pendiente entra por su camino. Un equipo que falla se
 * marca en la revisión, en su propia fila, y eso abre una incidencia. El
 * formulario de aquí es para lo que no cabe en una revisión —una avería que se ve
 * de paso, un trabajo que se pide— y por eso ya no ofrece «observación»: tenerla
 * aquí era una segunda puerta para lo mismo, y las dos puertas se llenaban a
 * medias.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { v7 as uuidv7 } from 'uuid'
import { db, enqueue } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { flush } from '@/sync/outbox'
import { DoorPlate } from '@/components/DoorPlate'
import { RevisionesAnteriores } from '@/features/inspection/RevisionesAnteriores'
import { ResolverIncidencia } from '@/features/incidents/ResolverIncidencia'
import { useCierresEnCola } from '@/features/incidents/cierresEnCola'
import { equipoDeIncidencia, sePuedeResolver } from '@/domain/resolucion'
import type { Correccion } from '@/features/inspection/useInspection'
import { displayRoomCode } from '@/domain/normalize'
import { fechaCorta } from '@/domain/fechas'
import { cuantos } from '@/lib/plural'
import {
  INCIDENT_KIND_LABELS,
  STALE_INCIDENT_DAYS,
  type Incident,
  type IncidentKind,
  type Room,
} from '@/domain/types'

interface TimelineRow {
  at: string
  kind: 'incidencia' | 'solicitud' | 'observacion' | 'revision_ok' | 'revision_ko'
    | 'material' | 'equipo' | 'inventario'
  /** El matiz del evento. En una revisión, `corregida` si lo que se ve es una corrección. */
  subkind: string
  title: string
  /** La letra pequeña del evento: la nota de la revisión, la descripción, la resolución. */
  detail: string | null
  ref: string | null
  who: string | null
  state: string
  /** Unidades, en las filas de material. Negativo sale del almacén. */
  qty: number | null
}

interface Fiabilidad {
  score: number
  incidencias: number
  observaciones: number
  solicitudes: number
  revisiones: number
  hay_datos: boolean
}

interface Reincidencia {
  item: string
  veces: number
  desde: string
  hasta: string
}

/**
 * Lo que se puede registrar a mano desde la ficha.
 *
 * Sin `observacion`, y es el cambio de fondo de esta pantalla. Una observación se
 * escribe en la revisión, debajo de las fotos, con el aula delante; ofrecerla
 * también aquí era una segunda puerta al mismo dato, y con dos puertas ninguna de
 * las dos se llena entera. Este formulario queda para lo que de verdad hay que
 * atender: una avería vista de paso y un trabajo que se pide.
 *
 * El tipo `IncidentKind` sigue teniendo los tres: hay observaciones importadas
 * del Excel y borradores de antes de este cambio, y quitarlo del vocabulario
 * dejaría esas filas sin nombre.
 */
const TIPOS_REGISTRABLES: IncidentKind[] = ['incidencia', 'solicitud']

/** Cómo se marca cada cosa en la línea de tiempo. Nunca solo el color. */
const MARCA: Record<TimelineRow['kind'], { punto: string; texto: string }> = {
  incidencia: { punto: 'bg-crit', texto: 'Incidencia' },
  solicitud: { punto: 'bg-accent', texto: 'Solicitud' },
  observacion: { punto: 'bg-warn', texto: 'Observación' },
  revision_ok: { punto: 'bg-ok', texto: 'Revisión' },
  revision_ko: { punto: 'bg-crit', texto: 'Revisión' },
  /*
   * Las tres que trae la línea de tiempo desde que se fundió con la del
   * almacén. Sin ellas aquí, `MARCA[h.kind]` era `undefined` y la ficha
   * reventaba al abrir cualquier sala donde se hubiera gastado un cable.
   */
  material: { punto: 'bg-mark', texto: 'Material' },
  equipo: { punto: 'bg-warn', texto: 'Equipo' },
  inventario: { punto: 'bg-ok', texto: 'Inventario' },
}

interface Props {
  room: Room
  buildingName: string
  zoneName: string
  userId: string | null
  onBack: () => void
  onRevisar: () => void
  /**
   * Abrir el formulario para corregir una revisión anterior.
   *
   * Es el mismo destino que `onRevisar` —la pantalla de revisión— y va por otro
   * camino a propósito: lleva consigo lo que dijo aquella visita, y de eso
   * depende que corregir no sea rellenarlo todo otra vez.
   */
  onCorregir: (correccion: Correccion) => void
  /** Ir a la hoja de placas del edificio, lista para imprimir. */
  onImprimir: () => void
  /**
   * Ir a la hoja de inventario de ESTA sala, lista para guardar como PDF.
   *
   * Opcional, y sin manejador no se pinta el botón: es una acción de oficina que
   * la ficha no necesita para hacer su trabajo —llegar al aula y ver qué hay—, y
   * un botón montado siempre que a veces no lleva a ninguna parte enseña a
   * desconfiar de todos los botones de la pantalla.
   */
  onInventario?: () => void
}

export function RoomSheet({
  room,
  buildingName,
  zoneName,
  userId,
  onBack,
  onRevisar,
  onCorregir,
  onImprimir,
  onInventario,
}: Props): React.ReactElement {
  const qc = useQueryClient()
  const [abierto, setAbierto] = useState(false)
  const [kind, setKind] = useState<IncidentKind>('incidencia')
  const [texto, setTexto] = useState('')
  const [codigo, setCodigo] = useState('')
  const [guardado, setGuardado] = useState<string | null>(null)
  /* Qué avería tiene abierto el formulario de cierre. Solo una: se cierra lo que
     se acaba de arreglar, no se despacha una lista. */
  const [resolviendo, setResolviendo] = useState<string | null>(null)
  /* El acuse del cierre, y por qué no comparte el de registrar: la avería
     desaparece de la lista en el acto, y sin una frase que lo diga el gesto se
     lee como si la ficha hubiera perdido la fila. */
  const [resuelto, setResuelto] = useState<string | null>(null)

  // El inventario sale del espejo local: la ficha tiene que abrirse en un
  // sótano sin cobertura igual que la revisión.
  const equipos = useLiveQuery(async () => {
    const assets = await db.assets.where('room_id').equals(room.id).toArray()
    const tipos = new Map((await db.assetTypes.toArray()).map((t) => [t.id, t]))
    return assets
      .map((a) => ({ ...a, tipo: tipos.get(a.asset_type_id)?.name ?? 'Sin tipo' }))
      .sort((x, y) => x.tipo.localeCompare(y.tipo, 'es'))
  }, [room.id])

  /*
   * Las averías vivas de esta sala, del espejo local.
   *
   * Del espejo y no del servidor por lo mismo que el inventario: la ficha tiene
   * que abrirse en un sótano. El espejo solo guarda las que no están resueltas,
   * y aun así se filtra por estado — un borrador no se cierra y una observación
   * no se «resuelve», y esa regla vive en `domain` para que esta pantalla y la
   * pestaña de Incidencias no puedan discrepar.
   *
   * En orden de antigüedad: la que lleva más tiempo abierta va primero, que es
   * la que más se parece a lo que hay que atender.
   */
  const deLaSala = useLiveQuery(
    async () => await db.incidents.where('room_id').equals(room.id).toArray(),
    [room.id],
    [] as Incident[],
  )

  /*
   * Y las que ya se han cerrado aquí y esperan cobertura, que no vuelven a
   * ofrecerse. De que el espejo no las reabra se encarga la descarga
   * (`sync/pull.ts`); esto es la misma verdad dicha donde se pinta, para que ni
   * la ventana entre una descarga en vuelo y su escritura ofrezca cerrar dos
   * veces lo mismo. No desaparecen: se cuentan debajo de la lista.
   */
  const cerradasEnCola = useCierresEnCola()

  const abiertas = deLaSala
    .filter((i) => sePuedeResolver(i) && !cerradasEnCola.has(i.id))
    .sort((a, b) => a.opened_at.localeCompare(b.opened_at))
  const esperandoSubir = deLaSala.filter((i) => cerradasEnCola.has(i.id)).length

  /** Cómo se llama un equipo de esta sala. Es lo que nombra la avería. */
  const nombreDeEquipo = (assetId: string): string | null => {
    const equipo = (equipos ?? []).find((e) => e.id === assetId)
    if (!equipo) return null
    return equipo.label || equipo.tipo
  }

  const { data: fiabilidad } = useQuery({
    queryKey: ['room-reliability', room.id],
    queryFn: async (): Promise<Fiabilidad | null> => {
      const { data, error } = await supabase
        .from('room_reliability')
        .select('*')
        .eq('room_id', room.id)
        .maybeSingle()
      if (error) throw error
      return (data as Fiabilidad | null) ?? null
    },
  })

  const { data: reincidencias } = useQuery({
    queryKey: ['room-repeats', room.id],
    queryFn: async (): Promise<Reincidencia[]> => {
      const { data, error } = await supabase
        .from('room_repeat_offenders')
        .select('*')
        .eq('room_id', room.id)
        .order('veces', { ascending: false })
      if (error) throw error
      return (data ?? []) as Reincidencia[]
    },
  })

  const { data: historial, isError: historialFalla } = useQuery({
    queryKey: ['room-timeline', room.id],
    queryFn: async (): Promise<TimelineRow[]> => {
      const { data, error } = await supabase
        .from('room_timeline')
        .select('*')
        .eq('room_id', room.id)
        .order('at', { ascending: false })
        .limit(30)
      if (error) throw error
      return (data ?? []) as TimelineRow[]
    },
  })

  /*
   * Guardar el registro, **por la cola**.
   *
   * Nace como `borrador` cuando no hay título, y como `abierta` cuando sí lo
   * hay: la restricción de la base dice exactamente eso, y repetirla aquí evita
   * que el servidor rechace algo que la pantalla dejó escribir.
   *
   * El id se genera en el cliente (UUID v7), que es lo que permite que la fila
   * nazca con su identidad definitiva sin haber hablado con nadie.
   *
   * Y eso último era todo lo que estaba aprovechado: esto hacía un `insert`
   * directo contra Supabase, el único camino de escritura de la aplicación que no
   * pasaba por la cola. En un sótano el `fetch` lanza, la mutación falla y lo
   * escrito no queda en NINGUNA parte —ni en el espejo, ni en la cola, ni en el
   * contador de pendientes—: solo un párrafo rojo con «Load failed» y el texto
   * todavía en el cuadro, que se pierde al cambiar de sala. En la pantalla donde
   * la aplicación promete justo lo contrario, y para apuntar precisamente lo que
   * se ve de paso por un pasillo sin cobertura.
   *
   * Ahora se escribe en el espejo y se encola. Sube en cuanto haya red, cuenta en
   * la lámpara de la cabecera mientras espera, y el reenvío ya es idempotente
   * —'incident' está en `IGNORE_DUPLICATES`—. Aquí no hay clave ajena a una
   * revisión que ordenar: `opened_from_inspection_id` va nulo.
   */
  const registrar = useMutation({
    mutationFn: async () => {
      const titulo = texto.trim()
      const fila: Incident = {
        id: uuidv7(),
        room_id: room.id,
        asset_id: null,
        opened_from_inspection_id: null,
        check_key: null,
        external_ref: codigo.trim() || null,
        title: titulo || null,
        description: null,
        severity: 'media',
        state: titulo ? 'abierta' : 'borrador',
        kind,
        opened_at: new Date().toISOString(),
        opened_by: userId,
        resolved_at: null,
        resolved_by: null,
        resolution: null,
        source: 'app',
      }

      await db.incidents.put(fila)
      await enqueue('incident', fila.id, fila)
      void flush()

      return titulo.length > 0
    },
    onSuccess: (completo) => {
      setGuardado(
        completo
          ? `${INCIDENT_KIND_LABELS[kind]} registrada. Sube en cuanto haya cobertura.`
          : `Guardado sin describir. Aparecerá en Incidencias para que lo completes.`,
      )
      setTexto('')
      setCodigo('')
      setAbierto(false)
      void qc.invalidateQueries({ queryKey: ['room-timeline', room.id] })
      void qc.invalidateQueries({ queryKey: ['borradores'] })
    },
  })

  return (
    <div className="pb-4">
      <div className="mx-auto max-w-2xl px-4 pb-10">
        {/*
          Una sola placa, la que lleva el QR.

          Había dos, una encima de la otra: la cabecera de la revisión —edificio,
          planta, nombre grande y código— y debajo, a doscientos píxeles, la placa
          de puerta con EXACTAMENTE lo mismo más el QR y la matrícula. Quien abría
          la ficha leía el nombre del aula dos veces antes de llegar a nada que no
          supiera ya, y en una pantalla de móvil eso es media pantalla gastada en
          repetirse.

          Se queda la del QR porque es la que dice más con el mismo sitio: lleva
          dentro todo lo que llevaba la otra —ubicación, nombre, código— y además
          el código escaneable y la matrícula, que es lo que se dicta por
          teléfono. El QR codifica el identificador interno, no el nombre, así que
          renombrar la sala no invalida las etiquetas ya atornilladas.
        */}
        <button
          type="button"
          onClick={onBack}
          className="-ml-2 mb-2 mt-2 inline-flex min-h-11 items-center px-2 font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-accent"
        >
          ← Volver
        </button>

        {room.short_ref ? (
          <DoorPlate
            building={buildingName}
            zone={zoneName}
            title={room.name || displayRoomCode(room.code)}
            ref={room.short_ref}
            id={room.id}
            code={displayRoomCode(room.code)}
          />
        ) : (
          /*
            Sin matrícula no hay placa que enseñar —ni QR que generar—, pero la
            sala sigue teniendo que identificarse: quitar la cabecera sin esto
            dejaba la ficha de un aula recién creada, o de una que este
            dispositivo aún no ha descargado entera, sin decir de qué aula habla.
          */
          <div className="card p-4">
            <p className="font-mono text-[0.625rem] font-bold uppercase tracking-[0.17em] text-muted">
              {buildingName} · {zoneName}
            </p>
            <h1 className="mt-1 truncate text-[1.6rem] font-bold leading-[1.2] tracking-tight">
              {room.name || displayRoomCode(room.code)}
            </h1>
            <p className="mt-1 font-mono text-[0.625rem] text-muted">
              {displayRoomCode(room.code)} · sin matrícula todavía
            </p>
          </div>
        )}

        {/*
          Las dos hojas que se imprimen desde aquí, en una fila discreta y fuera
          del bloque de la placa.

          Estaban dentro, y con `room.short_ref` nulo —una sala que todavía no ha
          recibido matrícula, o que este dispositivo aún no ha descargado— la
          sección entera no se pinta: el único acceso a las placas del edificio
          desaparecía justo en la sala que hace falta etiquetar, y meter ahí el
          inventario habría atado una hoja que no tiene nada que ver con las
          placas a que ESTA sala tenga una.

          En `key-quiet` y con la letra pequeña a propósito: son papeleo de
          oficina, y la ficha se abre para revisar. Compitiendo con «Revisar
          esta sala» —que está debajo, en acento y a ancho completo— convertirían
          la pantalla de trabajo en un menú de descargas.
        */}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onImprimir}
            className="key key-quiet min-h-11 px-3 text-sm"
          >
            Imprimir las placas del edificio
          </button>
          {onInventario && (
            <button
              type="button"
              onClick={onInventario}
              className="key key-quiet min-h-11 px-3 text-sm"
            >
              Inventario en PDF
            </button>
          )}
        </div>

        {/*
          El índice, y de qué está hecho.
          Un número solo invita a discutirlo; un número con su recuento al lado
          se puede comprobar. Y con la base recién arrancada dice honestamente
          que no sabe lo suficiente, en vez de sacar un 100 de la nada — que se
          leería como «va perfecta» cuando significa «no sé nada de ella».
        */}
        {fiabilidad && (
          <div className="card mt-4 flex items-center gap-4 p-4">
            <span
              className={`font-mono text-3xl font-bold tabular ${
                !fiabilidad.hay_datos
                  ? 'text-muted'
                  : fiabilidad.score >= 75
                    ? 'text-ok'
                    : fiabilidad.score >= 45
                      ? 'text-warn'
                      : 'text-crit'
              }`}
            >
              {fiabilidad.hay_datos ? fiabilidad.score : '—'}
            </span>
            <div className="min-w-0 text-sm">
              <p className="font-medium">Índice de fiabilidad</p>
              <p className="text-muted">
                {fiabilidad.hay_datos
                  ? `${fiabilidad.incidencias} incidencias · ${fiabilidad.observaciones} observaciones · ${fiabilidad.revisiones} revisiones en el último año`
                  : 'Datos insuficientes todavía: hacen falta unas cuantas revisiones más para que este número signifique algo.'}
              </p>
              {fiabilidad.hay_datos && fiabilidad.solicitudes > 0 && (
                <p className="mt-1 text-xs text-muted">
                  {fiabilidad.solicitudes} solicitudes, que no penalizan: pedir trabajo no es un
                  fallo de la sala.
                </p>
              )}
            </div>
          </div>
        )}

        {(reincidencias ?? []).map((r) => (
          <div key={r.item} className="card mt-3 border-warn/30 bg-warn-tint p-4 text-sm">
            <p className="font-medium text-warn">Reincidencia detectada: {r.item}</p>
            <p className="mt-1">
              {r.veces} sustituciones en esta sala desde {fechaCorta(r.desde)}. Poner la pieza otra
              vez no resuelve la causa: conviene revisar canalización, rosetas o longitud del
              tirado.
            </p>
            <p className="mt-1 text-xs text-muted">
              Basado en {r.veces} incidencias con consumo de ese artículo, la última el{' '}
              {fechaCorta(r.hasta)}.
            </p>
          </div>
        ))}

        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onRevisar} className="key key-accent min-h-11 flex-1 px-3 text-sm">
            Revisar esta sala
          </button>
          <button
            type="button"
            onClick={() => setAbierto((v) => !v)}
            className="key key-quiet min-h-11 flex-1 px-3 text-sm"
          >
            {/* Dice qué abre, no «registrar algo». Los dos tipos que quedan
                caben en el propio botón, y con ellos delante nadie usa este
                formulario para apuntar una nota de seguimiento. */}
            {abierto ? 'Cancelar' : 'Incidencia o solicitud'}
          </button>
        </div>

        {guardado && !abierto && (
          <p aria-live="polite" className="mt-3 text-sm text-ok">
            {guardado}
          </p>
        )}

        {abierto && (
          <form
            className="card mt-3 p-4"
            onSubmit={(e) => {
              e.preventDefault()
              registrar.mutate()
            }}
          >
            <h2 className="eyebrow">
              Registrar en {room.name || displayRoomCode(room.code)}
            </h2>

            {/* Los dos tipos, a la vista y sin desplegable: son dos y se elige
                uno de pie. Un `select` aquí serían dos toques y una lista. */}
            <div className="mt-2 flex gap-2">
              {TIPOS_REGISTRABLES.map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={kind === k}
                  onClick={() => setKind(k)}
                  className={`key min-h-11 flex-1 px-2 text-xs ${
                    kind === k ? 'key-accent' : 'key-quiet'
                  }`}
                >
                  {INCIDENT_KIND_LABELS[k]}
                </button>
              ))}
            </div>

            <textarea
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              rows={3}
              placeholder="¿Qué ocurre? Opcional — se puede rellenar luego."
              className="mt-3 w-full rounded-ctl border border-line bg-surface p-3 text-sm"
            />

            {/* Los dos tipos que quedan pueden llevar ticket externo, así que el
                campo ya no se esconde para ninguno. */}
            <label className="mt-3 block text-sm">
              <span className="text-muted">Código de ticket externo</span>
              <input
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
                placeholder="I260728_0001"
                className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-3 font-mono text-sm"
              />
            </label>

            <p className="mt-3 text-xs leading-relaxed text-muted">
              Basta la sala para guardar. Lo demás se completa después, desde Incidencias.
            </p>
            {/* La frontera, dicha donde se cruza. Sin esto, este cuadro de texto
                acaba llevándose las notas de seguimiento y la lista de trabajo se
                llena de cosas que nadie tiene que arreglar. */}
            <p className="mt-2 text-xs leading-relaxed text-muted">
              Un equipo que no funciona se marca en la revisión, en su fila: eso abre la incidencia
              y la deja asociada al aparato. Y las observaciones van en la revisión, debajo de las
              fotos — se leen más abajo, en esta misma ficha.
            </p>

            {registrar.isError && (
              <p className="mt-2 text-sm text-crit">
                {registrar.error instanceof Error ? registrar.error.message : 'No se ha podido guardar.'}
              </p>
            )}

            <button
              type="submit"
              disabled={registrar.isPending}
              className="key key-accent mt-3 min-h-11 w-full px-3 text-sm"
            >
              {registrar.isPending
                ? 'Guardando…'
                : texto.trim()
                  ? `Guardar ${INCIDENT_KIND_LABELS[kind].toLowerCase()}`
                  : 'Guardar borrador'}
            </button>
          </form>
        )}

        {/*
          Lo que está roto en esta sala, y el sitio donde se da por arreglado.

          Va antes del inventario y de todo lo demás porque es lo único de esta
          pantalla que le pide algo a quien la abre. Y las averías se listan
          aunque no haya ninguna abierta —con una línea que lo dice— porque «no
          hay nada roto» es una respuesta, y una sección que desaparece obliga a
          preguntarse si es que la ficha no lo sabe.
        */}
        <section aria-labelledby="sec-averias" className="mt-8">
          <div className="section-head">
            <h2 id="sec-averias" className="eyebrow">Averías abiertas</h2>
            {abiertas.length > 0 && (
              <span className="font-mono text-xs text-crit">{abiertas.length}</span>
            )}
          </div>

          {resuelto && (
            <p aria-live="polite" className="mb-2 text-sm text-ok">
              {resuelto}
            </p>
          )}

          <ul className="divide-y divide-line">
            {abiertas.map((i) => {
              const equipo = equipoDeIncidencia(i, nombreDeEquipo)
              const dias = Math.floor(
                (Date.now() - new Date(i.opened_at).getTime()) / 86_400_000,
              )

              return (
                <li key={i.id} className="py-3">
                  <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                    <div className="min-w-0 flex-1 basis-48 text-sm">
                      <p className="font-medium">
                        {/* El aparato delante y en acento: es la respuesta a
                            «¿cuál de las tres?» sin leer la frase entera. */}
                        {equipo && <span className="text-accent">{equipo} · </span>}
                        {i.title ?? '(sin describir)'}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">
                        {i.kind !== 'incidencia' && <>{INCIDENT_KIND_LABELS[i.kind]} · </>}
                        {i.external_ref && <span className="font-mono">{i.external_ref} · </span>}
                        abierta hace{' '}
                        {/* El mismo umbral que usa la pestaña de Incidencias y
                            el panel: una avería estancada se ve igual en las
                            tres pantallas o no significa nada. */}
                        <span
                          className={dias > STALE_INCIDENT_DAYS ? 'font-semibold text-crit' : ''}
                        >
                          {cuantos(dias, 'día', 'días')}
                        </span>
                      </p>
                      {i.description && (
                        <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted">
                          {i.description}
                        </p>
                      )}
                    </div>

                    <button
                      type="button"
                      aria-expanded={resolviendo === i.id}
                      onClick={() => setResolviendo((a) => (a === i.id ? null : i.id))}
                      className="key key-accent ml-auto min-h-11 shrink-0 px-3 text-xs"
                    >
                      {resolviendo === i.id ? 'Cancelar' : 'Resolver'}
                    </button>
                  </div>

                  {resolviendo === i.id && (
                    <ResolverIncidencia
                      incidencia={i}
                      equipo={equipo}
                      roomId={room.id}
                      onCerrada={() => {
                        setResolviendo(null)
                        setResuelto(
                          'Resuelta. Sube en cuanto haya cobertura y queda en el historial de la sala.',
                        )
                        // El historial y el índice los calcula el servidor, así
                        // que no se piden aquí: hasta que el cierre suba
                        // contestarían lo de antes. Los vuelve a pedir
                        // `useCierresEnCola` cuando sube de verdad.
                      }}
                      onCancelar={() => setResolviendo(null)}
                    />
                  )}
                </li>
              )
            })}

            {abiertas.length === 0 && (
              <li className="py-2 text-sm text-muted">
                Nada abierto en esta sala ahora mismo.
              </li>
            )}
          </ul>

          {/* Lo cerrado que todavía no ha subido se dice, no se esconde: es la
              diferencia entre «ya está» y «ya está aquí». */}
          {esperandoSubir > 0 && (
            <p className="mt-2 text-xs text-muted">
              {cuantos(esperandoSubir, 'avería resuelta', 'averías resueltas')} esperando cobertura
              para subir.
            </p>
          )}
        </section>

        <section aria-labelledby="sec-inv" className="mt-8">
          <div className="section-head">
            <h2 id="sec-inv" className="eyebrow">Inventario instalado</h2>
          </div>
          <ul className="divide-y divide-line">
            {(equipos ?? []).map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="flex-1">
                  {a.label || a.tipo}
                  <span className="block font-mono text-xs text-muted">
                    {[a.model, a.serial].filter(Boolean).join(' · ') || 'Sin modelo ni serie'}
                  </span>
                </span>
                {a.status !== 'instalado' && (
                  <span className="rounded-tag bg-warn-tint px-2 py-0.5 text-xs text-warn">
                    {a.status}
                  </span>
                )}
              </li>
            ))}
            {equipos?.length === 0 && (
              <li className="py-2 text-sm text-muted">Sin equipos registrados en esta sala.</li>
            )}
          </ul>
        </section>

        {/*
          Las revisiones anteriores: lo que se comprobó, lo que se apuntó, las
          fotos — y el botón de corregir.

          Van antes del histórico porque son la respuesta a la pregunta con la que
          se entra («¿qué se ha dicho de esta aula?») y el histórico es el resto:
          material, equipos y registros, en orden de reloj. Las dos listas hablan
          de cosas distintas, y por eso conviven sin repetirse.
        */}
        <RevisionesAnteriores roomId={room.id} onCorregir={onCorregir} />

        <section aria-labelledby="sec-hist" className="mt-8">
          <div className="section-head">
            <h2 id="sec-hist" className="eyebrow">Historial</h2>
          </div>
          {historialFalla && (
            <p className="mt-2 text-sm text-muted">
              El historial necesita conexión; lo demás de esta ficha funciona sin ella.
            </p>
          )}
          <ul className="mt-2 space-y-3">
            {(historial ?? []).map((h, i) => (
              <li key={`${h.at}-${i}`} className="flex gap-3">
                <span
                  aria-hidden
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-[1px] ${MARCA[h.kind].punto}`}
                />
                <div className="min-w-0 flex-1 text-sm">
                  <p>
                    <span className="text-muted">{MARCA[h.kind].texto} — </span>
                    {h.title}
                    {h.qty !== null && h.qty !== 0 && (
                      <span className="ml-2 font-mono text-xs font-semibold tabular text-ink-2">
                        {h.qty > 0 ? `+${h.qty}` : `−${Math.abs(h.qty)}`}
                      </span>
                    )}
                    {h.state === 'borrador' && (
                      <span className="ml-2 rounded-tag bg-warn-tint px-1.5 py-0.5 text-xs text-warn">
                        sin completar
                      </span>
                    )}
                    {/* Lo que se ve es la versión corregida de aquella visita, no
                        una visita más. Sin decirlo, quien compara esta lista con
                        la de revisiones de arriba no entiende por qué la fecha es
                        vieja y el texto ha cambiado. */}
                    {h.subkind === 'corregida' && (
                      <span className="ml-2 rounded-tag bg-accent-tint px-1.5 py-0.5 text-xs text-accent">
                        corregida
                      </span>
                    )}
                  </p>
                  {/* El detalle se pinta. La vista lo traía —la nota de la
                      revisión, la descripción de la incidencia, la resolución— y
                      esta lista lo tiraba: un evento decía «Revisión con
                      incidencias» y no lo que se vio. `line-clamp-3` porque aquí
                      es contexto; la observación entera se lee arriba. */}
                  {h.detail && (
                    <p className="mt-0.5 line-clamp-3 text-xs leading-relaxed text-muted">
                      {h.detail}
                    </p>
                  )}
                  <p className="mt-0.5 font-mono text-xs text-muted">
                    {[fechaCorta(h.at), h.who, h.ref].filter(Boolean).join(' · ')}
                  </p>
                </div>
              </li>
            ))}
            {historial?.length === 0 && (
              <li className="text-sm text-muted">Todavía no hay nada registrado en esta sala.</li>
            )}
          </ul>
        </section>
      </div>
    </div>
  )
}
