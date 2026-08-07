/**
 * La hoja de inventario: la pantalla que existe para convertirse en papel.
 *
 * Lo que se pide es un documento —una sala o un edificio entero, con marca,
 * modelo, número de serie y las fechas de alta, último cambio y baja— que se
 * lleva al aula, se contrasta contra lo que hay, se firma y se archiva. Por eso
 * todo lo que es interfaz vive dentro de `.solo-pantalla` y desaparece al
 * imprimir, exactamente igual que en la hoja de placas
 * (`src/features/rooms/PlateSheet.tsx`), que documenta por qué el PDF sale de
 * `window.print()` y no de una librería: funciona sin cobertura, no añade
 * ninguna dependencia y en iPad y escritorio «Imprimir → Guardar como PDF» ya
 * da un PDF de verdad.
 *
 * Los datos salen de la vista `inventory_sheet`, que ya resuelve en el servidor
 * lo que el cliente no puede resolver: el tipo siguiendo las fusiones, la fecha
 * de la baja y —sobre todo— la sala de un equipo que se aprobó devolver al
 * almacén, que al aprobarse pierde el `room_id` y solo conserva la sala dentro
 * de su `asset_events`. Un `join` ingenuo perdería en silencio justo los
 * equipos por los que alguien imprime la hoja de bajas.
 *
 * Y cuando esa consulta no se puede hacer —sin cobertura, con el servidor
 * caído, o con la descarga cortada a la mitad— la hoja se construye con el
 * espejo local y **lo dice en el papel, no solo en la pantalla**. El aviso de
 * pantalla se va con el resto de la interfaz al imprimir, así que si el aviso
 * viviera solo ahí, el documento que acaba en un archivador sería una hoja a la
 * que le faltan todas las bajas sin nada que lo advirtiera. Una hoja incompleta
 * que no se presenta como incompleta es peor que no imprimir nada: se firma un
 * inventario que dice que un equipo sigue en la sala.
 */

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { db } from '@/db/dexie'
import { supabase } from '@/lib/supabase'
import { descargaEntera } from '@/sync/paginada'
import { horaCorta } from '@/domain/fechas'
import { cuantos } from '@/lib/plural'
import { displayRoomCode } from '@/domain/normalize'
import { ASSET_STATUS_LABELS } from '@/domain/types'
import type { Building, Room } from '@/domain/types'
import {
  agruparPorSala,
  esBaja,
  fechaDeLaHoja,
  filasDelEspejo,
  filtrar,
  nombreDeLaFila,
  resumen,
  ultimoMovimiento,
  type AlcanceDeHoja,
  type FilaDeInventario,
} from './hoja'

/**
 * El hueco: lo que se imprime donde no hay dato.
 *
 * Una celda vacía en el papel no se distingue de una celda que nadie ha
 * rellenado; el guion sí, y además marca el sitio donde alguien va a escribir a
 * boli el número de serie que falta.
 */
const HUECO = '—'

/**
 * De qué se imprime la hoja.
 *
 * Llega con los objetos ya resueltos —y no con identificadores— porque la
 * cabecera del papel tiene que poder escribirse aunque no llegue ni una fila:
 * un edificio sin equipos registrados sigue mereciendo una hoja que diga de qué
 * edificio está hablando y quién debería rellenarla a mano.
 */
export type Alcance =
  | { tipo: 'sala'; room: Room; building: Building; zoneName: string }
  | { tipo: 'edificio'; building: Building }

/**
 * Lo que el papel tiene que confesar cuando se ha hecho sin servidor.
 *
 * Es literal a propósito: el espejo local no guarda equipos retirados —la
 * descarga pide `.neq('status','retirado')`—, ni `asset_events`, ni el
 * `updated_at` del servidor. O sea que faltan exactamente las bajas, que son la
 * mitad por la que se imprime la hoja histórica.
 */
const AVISO_ESPEJO =
  'Hoja hecha con la copia local de este dispositivo: salen los equipos instalados que tiene guardados. ' +
  'Faltan los equipos dados de baja y las fechas de último cambio, que solo están en el servidor.'

function comoAlcanceDeHoja(alcance: Alcance): AlcanceDeHoja {
  return alcance.tipo === 'sala'
    ? { tipo: 'sala', roomId: alcance.room.id }
    : { tipo: 'edificio', buildingId: alcance.building.id }
}

/** Lo que sale de un intento: las filas, o el motivo por el que no hay filas. */
type Intento = { filas: FilaDeInventario[] } | { motivo: string }

/**
 * La hoja tal y como la ve el servidor.
 *
 * Va por páginas con `descargaEntera` y no con una consulta suelta porque
 * PostgREST corta a 1.000 filas **sin avisar**: devuelve `200 OK` con las
 * primeras y nada dice que falten más. Un edificio grande pasa de eso, así que
 * una consulta directa produciría una hoja a la que le faltan salas enteras y
 * que no tendría forma de saberlo. Y por lo mismo, una descarga que vuelve
 * `completa: false` no se enseña como si fuera la buena.
 *
 * El `order` estable es obligatorio en cualquier consulta paginada: sin él
 * PostgREST no garantiza el orden entre peticiones y dos páginas pueden
 * solaparse o dejar un hueco.
 */
async function desdeElServidor(ambito: AlcanceDeHoja): Promise<Intento> {
  if (!navigator.onLine) return { motivo: 'Este dispositivo está sin conexión.' }

  const res = await descargaEntera<FilaDeInventario>((desde, hasta) => {
    // La consulta se construye entera dentro de la página: el constructor de
    // supabase solo se puede consumir una vez, y los filtros tienen que ir
    // antes de `order`/`range` porque después ya no existen en el tipo.
    const q = supabase.from('inventory_sheet').select('*')
    const filtrada =
      ambito.tipo === 'sala' ? q.eq('room_id', ambito.roomId) : q.eq('building_id', ambito.buildingId)
    return filtrada.order('asset_id').range(desde, hasta)
  })

  if (res.error) return { motivo: `El servidor no ha contestado: ${res.error.message}` }
  if (!res.completa || !res.data) return { motivo: 'La descarga del servidor se ha cortado a medias.' }
  return { filas: res.data }
}

/**
 * La hoja tal y como la ve este dispositivo.
 *
 * Se leen las tablas del espejo y las cruza `filasDelEspejo`, que es quien sabe
 * qué se puede afirmar sin servidor y qué se queda en blanco. Aquí solo se
 * estrecha lo que hay que leer: en una sala se entra por el índice `room_id`, y
 * en un edificio se resuelven antes sus salas para no arrastrar los equipos de
 * los otros veintidós.
 */
async function desdeElEspejo(ambito: AlcanceDeHoja): Promise<FilaDeInventario[]> {
  const [types, zones, buildings, retiradas] = await Promise.all([
    db.assetTypes.toArray(),
    db.zones.toArray(),
    db.buildings.toArray(),
    db.assetRemovals.toArray(),
  ])

  if (ambito.tipo === 'sala') {
    const sala = await db.rooms.get(ambito.roomId)
    const assets = await db.assets.where('room_id').equals(ambito.roomId).toArray()
    return filasDelEspejo(
      {
        assets,
        types: new Map(types.map((t) => [t.id, t])),
        rooms: sala ? [sala] : [],
        zones,
        buildings,
        retiradas,
      },
      ambito,
    )
  }

  const zonasDelEdificio = new Set(
    zones.filter((z) => z.building_id === ambito.buildingId).map((z) => z.id),
  )
  const rooms = await db.rooms.filter((r) => zonasDelEdificio.has(r.zone_id)).toArray()
  const salas = new Set(rooms.map((r) => r.id))
  const assets = await db.assets.filter((a) => a.room_id !== null && salas.has(a.room_id)).toArray()

  return filasDelEspejo(
    { assets, types: new Map(types.map((t) => [t.id, t])), rooms, zones, buildings, retiradas },
    ambito,
  )
}

export function HojaDeInventario({
  alcance,
  onBack,
}: {
  alcance: Alcance
  onBack: () => void
}): React.ReactElement {
  /*
   * Una sola opción, y apagada.
   *
   * Quien abre esto quiere el inventario de lo que HAY: la hoja se lleva al
   * aula para contrastarla contra los aparatos que se ven, y cada línea de un
   * proyector dado de baja hace dos años es una vuelta por el aula buscando
   * algo que no está. Por eso las bajas salen fuera por defecto — y en papel,
   * donde no hay filtros que rehacer sobre la marcha, el defecto es lo único
   * que de verdad decide.
   *
   * Y la casilla existe igualmente porque el otro documento —el histórico de lo
   * que salió de la sala, con su fecha y su destino— es esta misma hoja con las
   * bajas dentro, y es el que se pide cuando hay que justificar dónde acabó un
   * equipo. Sin la casilla, ese papel no se puede sacar de ningún sitio.
   *
   * Lo que no se pone aquí es un panel de filtros: quien abre esta pantalla
   * quiere el inventario, no configurarlo.
   */
  const [incluirBajas, setIncluirBajas] = useState(false)

  const ambito = useMemo(() => comoAlcanceDeHoja(alcance), [alcance])

  /*
   * La fecha de emisión se congela al montar.
   *
   * Con `new Date()` en el render, imprimir dos veces la misma hoja podía
   * fecharla en dos días distintos si la pantalla se quedó abierta de una
   * jornada para otra — y la fecha de emisión es justo lo que hace que dos
   * copias del mismo papel se puedan comparar.
   */
  const [emitidaEl] = useState(() => new Date().toISOString())

  const clave = ambito.tipo === 'sala' ? ambito.roomId : ambito.buildingId

  /*
   * `always` en las dos consultas, y es lo que hace que esta pantalla exista sin
   * cobertura.
   *
   * El modo de fábrica de react-query es `online`: sin conexión la consulta
   * queda en `paused` y **la función no llega a ejecutarse nunca**. No falla, no
   * reintenta y no avisa — se queda en `isPending` para siempre. O sea que toda
   * la caída al espejo local, que es la mitad de por qué se construyó esta hoja,
   * no se habría ejecutado jamás justo en el único escenario para el que está
   * escrita: el sótano sin cobertura donde hay que imprimir el inventario.
   *
   * Las demás pantallas con `useQuery` son de supervisión y leen el servidor:
   * ahí el defecto está bien y por eso no se toca en `main.tsx`. Esta es la
   * primera que tiene una respuesta que dar sin red.
   */

  /*
   * El espejo va PRIMERO y por su cuenta, no como plan B dentro del intento con
   * el servidor.
   *
   * Encadenados —servidor, y si falla, espejo— la hoja no aparece hasta que el
   * servidor termina de fallar, y fallar tarda. Medido con el servidor caído y
   * la conexión rechazada al instante: ocho segundos de «Cargando el
   * inventario…» antes de enseñar unos datos que estaban en el dispositivo desde
   * el principio. Y ocho segundos es el caso BUENO: el rechazo es inmediato. Un
   * iPad enganchado a un wifi que no encamina —el sótano de verdad, no el
   * `navigator.onLine === false` de laboratorio— no recibe un rechazo: se queda
   * esperando hasta que venza el tiempo del sistema, y ahí la espera se cuenta
   * en decenas de segundos.
   *
   * Leer el espejo es una consulta a IndexedDB: contesta en milisegundos y no
   * depende de nadie. Así que se enseña eso ya, y el servidor MEJORA la hoja
   * cuando llega. Es literalmente la regla que atraviesa el proyecto y que está
   * escrita en la cabecera de `sync/pull.ts`: la interfaz lee siempre de local y
   * no espera nunca a la red.
   */
  const espejo = useQuery({
    queryKey: ['hoja-inventario', 'espejo', ambito.tipo, clave],
    networkMode: 'always',
    // No hay nada que reintentar: si Dexie no contesta, no va a contestar por
    // insistir, y cada reintento es tiempo de pantalla en blanco.
    retry: false,
    queryFn: () => desdeElEspejo(ambito),
  })

  const servidor = useQuery({
    queryKey: ['hoja-inventario', 'servidor', ambito.tipo, clave],
    networkMode: 'always',
    queryFn: async (): Promise<Intento> => desdeElServidor(ambito),
  })

  /** Lo que ha contestado el servidor, si ha contestado con filas. */
  const delServidor = servidor.data && 'filas' in servidor.data ? servidor.data.filas : null
  /** Por qué no se está usando el servidor. Nulo mientras aún se le espera. */
  const motivo =
    servidor.data && 'motivo' in servidor.data
      ? servidor.data.motivo
      : servidor.isError
        ? 'El servidor no ha contestado.'
        : null

  const todas = useMemo(() => delServidor ?? espejo.data ?? [], [delServidor, espejo.data])
  const filas = useMemo(() => filtrar(todas, { incluirBajas }), [todas, incluirBajas])
  const grupos = useMemo(() => agruparPorSala(filas), [filas])
  const cuenta = useMemo(() => resumen(filas), [filas])

  /*
   * Lo que se está enseñando sale del espejo, venga de donde venga la espera.
   *
   * Es lo que decide el aviso IMPRESO, y por eso no puede mirar solo al fallo:
   * quien pulsa «Descargar PDF» mientras el servidor todavía está de camino se
   * lleva un papel hecho con el espejo, y ese papel tiene que decirlo igual que
   * el que se saca sin cobertura. El papel no sabe que la pantalla iba a
   * mejorar dos segundos después.
   */
  const esEspejo = delServidor === null

  /** Se está enseñando el espejo, pero el servidor aún puede mejorarlo. */
  const esperandoAlServidor = esEspejo && motivo === null

  /*
   * `isFetching` y no `isPending`: con la hoja ya en pantalla hay dato en caché,
   * así que `refetch()` NO devuelve la consulta a `pending` y ni la línea de
   * «Cargando el inventario…» ni ningún otro estado se movían. Los dos botones
   * de reintentar no miraban nada: no se deshabilitaban, no cambiaban de texto y
   * se podían pulsar en cadena mientras el intento anterior seguía en marcha.
   */
  const reintentando = servidor.isFetching

  /** Reintentar es volver a preguntar al servidor: el espejo no ha fallado. */
  const reintentar = (): void => void servidor.refetch()

  /*
   * Solo hay «cargando» mientras no hay NADA que enseñar, que en la práctica es
   * un parpadeo: el espejo es una lectura local. Antes esta línea duraba lo que
   * durase el servidor en rendirse.
   */
  const cargando = espejo.isPending && delServidor === null
  /* Y solo es un error cuando han fallado los dos: sin espejo y sin servidor no
     hay hoja que imprimir. */
  const sinNada = espejo.isError && delServidor === null

  const edificio = alcance.building
  const titulo =
    alcance.tipo === 'sala'
      ? // Igual que en el encabezado de cada sala del papel: el nombre solo si
        // no es el propio código repetido, que es lo que trae la mayoría.
        `${edificio.code} ${displayRoomCode(alcance.room.code)}${
          alcance.room.name && alcance.room.name !== alcance.room.code
            ? ` · ${alcance.room.name}`
            : ''
        }`
      : // El nombre ya lleva el código dentro en todo el maestro («EDIFICIO H»),
        // así que anteponerlo daba «Inventario de H — EDIFICIO H». El código
        // suelto sí vale como dato, y está en la ficha de la cabecera del papel.
        edificio.name

  /* En una hoja de sala, la fecha del último levantamiento manda la del
     servidor, que es la fresca; la del espejo sirve mientras esa no llegue. */
  const levantadoEl =
    alcance.tipo === 'sala'
      ? (grupos[0]?.room_last_inventory_at ?? alcance.room.last_inventory_at)
      : null

  return (
    <div className="mx-auto max-w-5xl p-4">
      <div className="solo-pantalla">
        <button
          type="button"
          onClick={onBack}
          className="-ml-2 mb-1 inline-flex min-h-11 items-center px-2 font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-accent"
        >
          ← Volver
        </button>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Inventario de {titulo}</h1>
            {/* El recuento sale cuando hay algo que contar. Mientras carga lo
                dice la línea de estado de abajo: dos frases a la vez para el
                mismo momento se leen como dos cosas distintas pasando. */}
            {!cargando && (
              <p className="mt-1 text-sm text-muted">
                {cuantos(cuenta.total, 'equipo', 'equipos')}
                {alcance.tipo === 'edificio' && ` en ${cuantos(grupos.length, 'sala', 'salas')}`}
                {cuenta.sinSerie > 0 && `, ${cuenta.sinSerie} sin número de serie`}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => window.print()}
            disabled={filas.length === 0}
            className="key key-accent min-h-11 px-4 text-sm"
          >
            Descargar PDF
          </button>
        </div>

        {/*
          Sin esta línea, «Descargar PDF» abre un diálogo de impresión que el
          usuario no ha pedido: se queda mirando una vista previa y una
          impresora, decide que se ha equivocado de botón y cierra. El PDF sale
          de ahí, pero solo si alguien dice dónde está.
        */}
        <p className="mt-3 text-xs text-muted">
          Se abre el diálogo de imprimir del navegador, que es de donde sale el PDF: en el iPad,
          toca «Imprimir» y después «Compartir → Guardar en Archivos»; en el ordenador, elige
          «Guardar como PDF» en el destino, en lugar de una impresora.
        </p>

        <label className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={incluirBajas}
            onChange={(e) => setIncluirBajas(e.target.checked)}
            className="h-5 w-5"
          />
          Incluir equipos dados de baja
        </label>

        {cargando && <p className="mt-3 text-sm text-muted">Cargando el inventario…</p>}

        {sinNada && (
          <div className="card mt-3 p-4">
            <p className="text-sm text-crit">No se ha podido leer el inventario.</p>
            <p className="mt-1 text-sm text-muted">
              Ni el servidor ni la copia de este dispositivo han contestado. Sin una de las dos no
              hay hoja que imprimir.
            </p>
            <button
              type="button"
              onClick={reintentar}
              disabled={reintentando}
              className="key key-quiet mt-3 min-h-11 px-3 text-sm"
            >
              {reintentando ? 'Reintentando…' : 'Reintentar'}
            </button>
          </div>
        )}

        {/*
          Mientras el servidor está de camino la hoja YA se ve, hecha con el
          espejo. Se dice en voz baja y sin alarma: no ha fallado nada todavía y
          lo más probable es que en un segundo esta línea desaparezca sola. Pero
          se dice, porque el botón de imprimir está vivo y quien lo pulse ahora
          se lleva el papel del espejo.
        */}
        {esperandoAlServidor && !cargando && (
          <p className="mt-3 text-sm text-muted">
            Mostrando la copia de este dispositivo mientras se comprueba con el servidor. Si el
            servidor contesta, la hoja se completa sola con las bajas y las fechas de cambio.
          </p>
        )}

        {esEspejo && motivo !== null && (
          <div className="card mt-3 p-4">
            <p className="text-sm text-warn">{motivo}</p>
            <p className="mt-1 text-sm text-muted">
              {AVISO_ESPEJO} Sincroniza y vuelve a abrir esta hoja antes de firmarla; el papel sale
              con el mismo aviso impreso.
            </p>
            {/*
              La hora del último intento, que es lo único que distingue dos
              reintentos seguidos.

              En el sótano sin cobertura el reintento vuelve a resolver por el
              espejo, `esEspejo` sigue puesto y el motivo es la MISMA cadena
              literal: la tarjeta quedaba idéntica carácter por carácter. Quien
              está de pie con el iPad pulsaba, no veía pasar nada, y volvía a
              pulsar sin saber si el botón estaba muerto o si el servidor seguía
              sin contestar. Con la hora sellada, dos intentos ya no se ven
              igual.
            */}
            <p className="mt-1 text-xs text-muted">
              Último intento a las {horaCorta(servidor.dataUpdatedAt)}.
            </p>
            <button
              type="button"
              onClick={reintentar}
              disabled={reintentando}
              className="key key-quiet mt-3 min-h-11 px-3 text-sm"
            >
              {reintentando ? 'Reintentando…' : 'Reintentar con el servidor'}
            </button>
          </div>
        )}

        {/*
          «Esta sala no tiene ningún equipo registrado» y «no se ha podido leer»
          son dos frases distintas y no se pueden confundir: la primera se
          arregla dando de alta los equipos desde el aula y la segunda no se
          arregla desde aquí. Con el espejo y cero filas no se sabe cuál de las
          dos es —el dispositivo pudo no haber descargado nunca esta sala— y esa
          duda es lo que hay que decir, en vez de elegir una al azar.
        */}
        {/* Y mientras se espera al servidor no se afirma ninguna de las dos: que
            el espejo esté vacío todavía no significa nada, porque la respuesta
            que lo aclara puede estar llegando. */}
        {!cargando && !sinNada && !esperandoAlServidor && todas.length === 0 && (
          <div className="mt-3 text-sm text-muted">
            {esEspejo ? (
              <p>
                No hay ningún equipo de {alcance.tipo === 'sala' ? 'esta sala' : 'este edificio'} en
                la copia de este dispositivo, y el servidor no ha contestado: no se puede saber si
                está vacío o si esta parte del inventario no ha llegado nunca aquí. Conéctate y
                vuelve a intentarlo.
              </p>
            ) : (
              <p>
                {alcance.tipo === 'sala'
                  ? 'Esta sala no tiene ningún equipo registrado.'
                  : 'Este edificio no tiene ningún equipo registrado.'}
              </p>
            )}
          </div>
        )}

        {!cargando && todas.length > 0 && filas.length === 0 && (
          <p className="mt-3 text-sm text-muted">
            Todos los equipos registrados están dados de baja. Marca «Incluir equipos dados de baja»
            para verlos.
          </p>
        )}

        <hr className="mt-4 border-line" />
      </div>

      {filas.length > 0 && (
        <div className="hoja-inventario mt-6">
          {/*
            La cabecera es lo que hace que un papel suelto encontrado dentro de
            seis meses siga significando algo: de qué edificio y de qué sala
            habla, con qué matrícula, cuándo se emitió, cuándo se levantó por
            última vez el inventario y cuántos equipos decía que había.
          */}
          <header>
            <h2 className="text-lg font-semibold">Inventario de {titulo}</h2>

            <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
              <div>
                <dt className="text-muted">Edificio</dt>
                <dd>
                  {edificio.code} — {edificio.name}
                </dd>
              </div>
              {alcance.tipo === 'sala' && (
                <>
                  <div>
                    <dt className="text-muted">Sala</dt>
                    <dd>
                      {displayRoomCode(alcance.room.code)}
                      {alcance.room.name ? ` — ${alcance.room.name}` : ''}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Planta</dt>
                    <dd>{alcance.zoneName || '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Matrícula</dt>
                    <dd className="font-mono">{alcance.room.short_ref ?? '—'}</dd>
                  </div>
                </>
              )}
              {alcance.tipo === 'edificio' && (
                <div>
                  <dt className="text-muted">Salas</dt>
                  <dd>{grupos.length}</dd>
                </div>
              )}
              <div>
                <dt className="text-muted">Emitida</dt>
                <dd>{fechaDeLaHoja(emitidaEl) ?? HUECO}</dd>
              </div>
              {alcance.tipo === 'sala' && (
                <div>
                  <dt className="text-muted">Último inventario</dt>
                  <dd>{(levantadoEl && fechaDeLaHoja(levantadoEl)) || 'Nunca'}</dd>
                </div>
              )}
              <div>
                <dt className="text-muted">Equipos</dt>
                <dd>{cuenta.total}</dd>
              </div>
            </dl>

            <p className="mt-2 text-xs">
              {cuantos(cuenta.instalados, 'instalado', 'instalados')} ·{' '}
              {cuantos(cuenta.averiados, 'averiado', 'averiados')} · {cuenta.retirados} de baja ·{' '}
              {cuenta.sinSerie} sin número de serie · {cuenta.sinValidar} sin validar
            </p>

            {cuenta.porTipo.length > 0 && (
              <p className="mt-1 text-xs text-muted">
                {cuenta.porTipo.map((t) => `${t.n} × ${t.tipo}`).join(' · ')}
              </p>
            )}

            {/*
              El aviso va DENTRO de la hoja, no solo en la pantalla: la pantalla
              se va al imprimir y lo que queda archivado es esta hoja. Con
              borde y palabras, sin fondo teñido: los navegadores quitan los
              fondos al imprimir para ahorrar tinta y el aviso se quedaría
              invisible justo en el papel, que es donde hace falta.
            */}
            {esEspejo && (
              <p className="mt-3 rounded-ctl border border-line p-2 text-xs">
                <strong>Atención: hoja incompleta.</strong> {AVISO_ESPEJO}
              </p>
            )}
          </header>

          {grupos.map((grupo) => (
            <section key={grupo.room_id} className="mt-6">
              {/*
                El carril horizontal, que es de pantalla y no de papel.

                Ocho columnas —tres de ellas fechas y una un número de serie— no
                caben en un teléfono: medido en 390px, la tabla pide 530 y, sin
                un contenedor que se desborde por su cuenta, lo que se desbordaba
                era el DOCUMENTO. Entonces no es que «Último cambio» y «Baja»
                quedaran fuera de la pantalla: es que al moverse se llevaban por
                delante el título, la casilla y el botón de imprimir. Es el mismo
                `.scroll-x` que ya envuelven las tablas del almacén y del panel;
                esta era la única que no lo llevaba.
              */}
              <div className="scroll-x">
                <table className="w-full text-left text-sm">
                  {/*
                    En una hoja de sala, la cabecera de arriba ya dice de qué
                    sala se trata: repetirlo encima de la única tabla es ruido.
                    Pero el `caption` tiene que existir igual, porque es lo que
                    da nombre a la tabla para quien la lee con un lector de
                    pantalla.
                  */}
                  <caption
                    className={
                      alcance.tipo === 'sala' ? 'sr-only' : 'mb-1 text-left text-sm font-semibold'
                    }
                  >
                    {grupo.zone_name} · {displayRoomCode(grupo.room_code)}
                    {/* El nombre solo si dice algo que el código no diga ya.
                        La mayoría de las aulas se llaman como su código —el
                        servidor rellena `name` con `code` cuando no hay otro—,
                        así que sin esta comprobación cada encabezado del papel
                        salía «1ª PLANTA · 1.8 — 1.8». Es la misma regla que ya
                        aplica la hoja de nomenclatura al sembrar sus campos. */}
                    {grupo.room_name && grupo.room_name !== grupo.room_code
                      ? ` — ${grupo.room_name}`
                      : ''}
                    <span className="ml-2 font-normal text-muted">
                      {grupo.room_short_ref ?? 'sin matrícula'} · inventario{' '}
                      {grupo.room_last_inventory_at
                        ? `levantado el ${fechaDeLaHoja(grupo.room_last_inventory_at) ?? HUECO}`
                        : 'sin levantar'}
                    </span>
                  </caption>

                  <thead>
                    <tr className="border-b border-line">
                      <th scope="col" className="py-1 pr-2 font-medium">
                        Equipo
                      </th>
                      <th scope="col" className="py-1 pr-2 font-medium">
                        Marca
                      </th>
                      <th scope="col" className="py-1 pr-2 font-medium">
                        Modelo
                      </th>
                      <th scope="col" className="py-1 pr-2 font-medium">
                        Nº de serie
                      </th>
                      <th scope="col" className="py-1 pr-2 font-medium">
                        Estado
                      </th>
                      <th scope="col" className="py-1 pr-2 font-medium">
                        Alta
                      </th>
                      <th scope="col" className="py-1 pr-2 font-medium">
                        Último cambio
                      </th>
                      <th scope="col" className="py-1 font-medium">
                        Baja
                      </th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-line-soft">
                    {grupo.filas.map((fila) => (
                      <FilaDeLaHoja key={fila.asset_id} fila={fila} />
                    ))}
                  </tbody>
                </table>
              </div>

              {/*
                El recuento de la sala, FUERA de la tabla.

                Estaba en un `<tfoot>`, y un pie de tabla es por definición un
                pie corriente: `display: table-footer-group` se repite al final
                de cada página que ocupe la tabla. Una sala de ocho equipos que
                empieza al final de una página imprimía una fila y debajo
                «7 equipos en esta sala», y las seis restantes en la página
                siguiente con el mismo pie otra vez. Quien se lleva ese papel al
                aula lee un bloque cerrado que anuncia siete equipos sobre una
                lista de uno — los dos números del mismo papel que no cuadran. En
                un párrafo detrás de la tabla el navegador no tiene ningún motivo
                para repetirlo, y el número vuelve a decir lo que dice.
              */}
              <p className="mt-1 text-xs text-muted">
                {cuantos(grupo.filas.length, 'equipo', 'equipos')} en esta sala
              </p>
            </section>
          ))}

          {/*
            El pie dice de dónde salen las filas, no solo qué casilla estaba
            marcada. Con la hoja del espejo, «bajas incluidas» era falso de raíz
            —la copia del dispositivo no guarda ni un equipo retirado, así que no
            hay nada que incluir— y contradecía palabra por palabra el aviso de
            arriba: «Faltan los equipos dados de baja» en la cabecera y «bajas
            incluidas» al pie de la misma página, que es la frase que se lee al
            final, junto al total y a la fecha de emisión. La casilla decide un
            filtro sobre lo que hay; donde no hay bajas no hay filtro que valga.
          */}
          <p className="mt-6 border-t border-line pt-2 text-xs">
            Total: {cuantos(cuenta.total, 'equipo', 'equipos')}
            {alcance.tipo === 'edificio' ? ` en ${cuantos(grupos.length, 'sala', 'salas')}` : ''}
            {esEspejo
              ? ', sin las bajas: no están en la copia de este dispositivo'
              : incluirBajas
                ? ', bajas incluidas'
                : ', sin las bajas'}{' '}
            · Emitida el {fechaDeLaHoja(emitidaEl) ?? HUECO}
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * Una línea de la tabla.
 *
 * Todo lo que falta se imprime como «—» y no como una celda en blanco: un hueco
 * sin marcar se lee como «aquí no hace falta nada», y lo que hace falta es lo
 * contrario — que se vea el sitio donde alguien va a escribir a boli el número
 * de serie que nadie apuntó.
 */
function FilaDeLaHoja({ fila }: { fila: FilaDeInventario }): React.ReactElement {
  const salida = esBaja(fila)
  const mov = ultimoMovimiento(fila)

  /* El nombre del equipo y si el tipo baja debajo. La decisión vive en `hoja.ts`
     —es una de las cosas que dice el papel, y allí se puede comprobar con
     pruebas— y aquí solo queda pintarla. */
  const { titulo, tipoAparte } = nombreDeLaFila(fila)

  // Sin cambio ni baja, lo último que le pasó al equipo es su propia alta, y
  // esa fecha ya está en su columna. Repetirla aquí llenaría la hoja de fechas
  // duplicadas que no dicen nada; el hueco dice exactamente lo que hay: desde
  // que se apuntó, no consta que nadie lo tocara.
  const sinMovimientos = fila.cambio_at === null && !salida

  return (
    /* `align-top` va celda a celda y no en la fila: `vertical-align` solo se
       aplica a las celdas, y puesto en el `<tr>` lo cumple quien quiere. Y hace
       falta porque media tabla lleva una segunda línea —el tipo bajo la
       etiqueta, el motivo bajo la fecha—: centradas, las columnas cortas quedan
       flotando a media altura y la fila deja de leerse como una línea. */
    <tr>
      <td className="py-1 pr-2 align-top">
        <span className="font-medium">{titulo}</span>
        {tipoAparte && <span className="block text-xs text-muted">{fila.type_name ?? HUECO}</span>}
      </td>
      <td className="py-1 pr-2 align-top">{fila.brand?.trim() || HUECO}</td>
      <td className="py-1 pr-2 align-top">{fila.model?.trim() || HUECO}</td>
      <td className="py-1 pr-2 align-top font-mono">{fila.serial?.trim() || HUECO}</td>

      {/*
        El estado, con símbolo y palabra. NUNCA solo con color: la hoja se
        imprime en blanco y negro en la impresora del departamento, y ahí el
        naranja de «sin validar» y el rojo de «averiado» son el mismo gris que
        todo lo demás. El color se queda para la pantalla, que es donde suma.
      */}
      <td className="py-1 pr-2 align-top">
        {salida ? (
          <span className="font-medium">× {ASSET_STATUS_LABELS.retirado}</span>
        ) : fila.status === 'averiado' ? (
          <span className="font-medium text-crit">! {ASSET_STATUS_LABELS.averiado}</span>
        ) : (
          <span>{ASSET_STATUS_LABELS.instalado}</span>
        )}

        {!fila.confirmed && (
          <span className="mt-0.5 block w-fit rounded-tag border border-line px-1 text-xs text-warn">
            ? Sin validar
          </span>
        )}
        {/* Una retirada pedida no es una baja: el equipo sigue en la sala y la
            solicitud puede rechazarse. Por eso se marca aparte y sin alarma. */}
        {fila.retirada_pedida && (
          <span className="mt-0.5 block w-fit rounded-tag border border-line px-1 text-xs text-muted">
            Retirada pedida
          </span>
        )}
      </td>

      <td className="py-1 pr-2 align-top">{fechaDeLaHoja(fila.alta_at) ?? HUECO}</td>

      <td className="py-1 pr-2 align-top">
        {sinMovimientos ? (
          HUECO
        ) : (
          <>
            {mov.fecha ?? HUECO}
            <span className="block text-xs text-muted">{mov.que}</span>
          </>
        )}
      </td>

      <td className="py-1 align-top">
        {fechaDeLaHoja(fila.baja_at) ?? HUECO}
        {fila.baja_motivo && <span className="block text-xs text-muted">{fila.baja_motivo}</span>}
      </td>
    </tr>
  )
}
