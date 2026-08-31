import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { pullMaster } from '@/sync/pull'
import {
  avisoDeCodigoDeEdificio,
  chocaCodigo,
  sanearCodigoDeEdificio,
  validarEdificio,
} from '@/domain/nomenclatura'
import { explicarFallo } from '@/features/rooms/maestro'
import { HojaDeMaestro, type EdificioDeMaestro } from '@/features/rooms/HojaDeMaestro'
import {
  FilaDeEdificio,
  type EdificioDelMaestro,
  type HojaDelMaestro,
  type SalaDelMaestro,
} from './FilaDeEdificio'
import { PapeleraDelMaestro, useEdificiosArchivados } from './PapeleraDelMaestro'

/**
 * Altas, bajas y nomenclatura de salas y edificios.
 *
 * Hasta hace poco esto se hacía escribiendo SQL contra el servidor, que es tanto
 * como decir que no se hacía: un aula nueva tardaba lo que tardara en coincidir
 * quien la necesita con quien tiene la contraseña de la base de datos. Mientras
 * tanto, esa aula no existe para la aplicación — no se revisa, no sale en el
 * buscador y sus incidencias no tienen dónde colgar.
 *
 * Vive **solo** aquí y en la lista de «Revisar», y en las dos detrás del rol de
 * administrador. Que además esté en la lista de trabajo no es una concesión: un
 * nombre mal escrito se descubre delante de la puerta, con el iPad en la mano, y
 * obligar a apuntarlo en un papel para corregirlo por la tarde en otra pantalla
 * es exactamente cómo un maestro se queda desactualizado para siempre. Lo que sí
 * es exclusivo de aquí son dos cosas: el **alta de edificios** —que se decide
 * mirando la lista entera, no delante de una puerta— y la **papelera**, porque
 * lo archivado ya no aparece en ninguna lista que se pueda mantener pulsada.
 *
 * Y la hoja de acciones es **la misma**, `HojaDeMaestro`, importada de la vista
 * de trabajo. Aquí solo cambia de dónde salen las listas con las que avisa de un
 * choque: del servidor con react-query, y no del espejo de Dexie, porque quien
 * está en «Datos» está decidiendo qué hay y el espejo puede llevar dos minutos
 * de retraso justo sobre lo que uno acaba de crear.
 *
 * Dar de baja no siempre es borrar, y la diferencia la decide el servidor —que
 * es el único que ve el histórico— y la **dice** en su respuesta:
 *
 *  - Una sala sin histórico se borra de verdad; con revisiones, incidencias o
 *    inventarios se **archiva**: sale de la lista de trabajo y del dispositivo, y
 *    lo que se hizo allí se queda entero. Borrarla sería tirar el histórico de un
 *    año para limpiar una lista.
 *  - Un edificio vacío se borra y libera su código; uno con salas se archiva
 *    igual, y **sus salas no se tocan**: siguen `active = true` debajo de un
 *    edificio archivado. Restaurar tiene que devolver exactamente lo que había, y
 *    voltear 39 salas y volver a voltearlas borraría la distinción entre «esta
 *    aula está de baja» y «el edificio entero está de baja». Por eso las salas de
 *    un edificio archivado salen en la papelera marcadas: para que nadie intente
 *    reactivar una a una lo que vuelve solo al restaurar el edificio.
 */

export function MaestroSalas(): React.ReactElement {
  const qc = useQueryClient()
  const [abierto, setAbierto] = useState<string | null>(null)
  const [nota, setNota] = useState<string | null>(null)
  const [hoja, setHoja] = useState<HojaDelMaestro | null>(null)

  const [codigoEd, setCodigoEd] = useState('')
  const [nombreEd, setNombreEd] = useState('')

  /* Solo los vivos: los archivados tienen su sitio, y mezclarlos aquí sería
     ofrecer «añadir sala» sobre un edificio que el servidor va a rechazar. */
  const { data: edificios } = useQuery({
    queryKey: ['maestro', 'buildings'],
    queryFn: async (): Promise<EdificioDelMaestro[]> => {
      const { data, error } = await supabase
        .from('buildings')
        .select('id, code, name, needs_review')
        .eq('active', true)
        .order('sort_order')
      if (error) throw error
      return (data ?? []) as EdificioDelMaestro[]
    },
  })

  /* Las salas vivas, del servidor y no del espejo: aquí se está decidiendo qué
     hay, y el espejo puede llevar dos minutos de retraso justo sobre lo que uno
     acaba de crear. */
  const { data: salas } = useQuery({
    queryKey: ['maestro', 'rooms'],
    queryFn: async (): Promise<SalaDelMaestro[]> => {
      const { data, error } = await supabase
        .from('room_overview')
        .select('room_id, room_code, room_name, short_ref, zone_id, zone_name, zone_order, building_id')
        .order('zone_order')
        .order('room_code')
      if (error) throw error
      return (data ?? []) as SalaDelMaestro[]
    },
  })

  /* Los códigos que ya están cogidos, papelera incluida. El `unique (code)` de
     `buildings` es global y no filtra por `active`: el código de un edificio
     archivado sigue ocupado —va impreso en las placas y en el histórico de
     incidencias— y decirlo aquí, con el nombre delante, evita teclear un código
     que el servidor va a rechazar con un mensaje que ya no se puede corregir sin
     volver a empezar.

     La consulta es la misma que pinta la papelera de abajo, compartida en un
     hook: misma clave y mismo `select`, así que react-query la resuelve con un
     único viaje y una única entrada de caché. */
  const archivados = useEdificiosArchivados()

  const vecinos: EdificioDeMaestro[] = [
    ...(edificios ?? []).map((b) => ({ id: b.id, code: b.code, name: b.name })),
    ...archivados.map((b) => ({
      id: b.building_id,
      code: b.building_code,
      name: `${b.building_name} (en la papelera)`,
    })),
  ]

  const alta = useMutation({
    mutationFn: async (input: { code: string; name: string }): Promise<string> => {
      // `create_building` no está en `maestro.ts` —desde el aula no se dan de
      // alta edificios, se dan de alta salas— así que la coherencia del espejo
      // se hace aquí a mano: las mismas dos líneas que `aplicarOperacion`.
      const { error } = await supabase.rpc('create_building', {
        p_code: input.code,
        p_name: input.name,
      })
      if (error) throw new Error(explicarFallo(error))
      await pullMaster()
      void qc.invalidateQueries({ queryKey: ['maestro'] })
      void qc.invalidateQueries({ queryKey: ['buildings'] })
      return `Edificio ${input.code} creado.`
    },
    onSuccess: (mensaje) => {
      setCodigoEd('')
      setNombreEd('')
      setNota(mensaje)
    },
  })

  /*
   * Por aquí entran las confirmaciones de los otros dos sitios que escriben —la
   * hoja de acciones y la papelera—, y de paso se limpia el fallo del alta.
   *
   * Sin ese `reset()`, un código de edificio rechazado hace media hora seguiría
   * tapando lo que se acaba de renombrar: `isError` de react-query no caduca
   * sola, se queda puesta hasta la siguiente llamada a esa misma mutación, y el
   * bloque de abajo esconde la nota mientras haya error. El resultado era una
   * pantalla que contestaba a lo de antes en vez de a lo de ahora.
   */
  const anotar = (mensaje: string): void => {
    alta.reset()
    setNota(mensaje)
  }

  const codigoNuevo = sanearCodigoDeEdificio(codigoEd)
  const choque = chocaCodigo(codigoNuevo, vecinos)
  const problemaEd =
    codigoEd.trim() === '' && nombreEd.trim() === ''
      ? null
      : (validarEdificio(codigoEd, nombreEd) ??
        (choque.con ? `Ese código ya es de «${choque.etiqueta}».` : null))
  const avisoEd = problemaEd ? null : avisoDeCodigoDeEdificio(codigoNuevo)

  const salasDe = (buildingId: string): SalaDelMaestro[] =>
    (salas ?? []).filter((s) => s.building_id === buildingId)

  return (
    <section aria-labelledby="sec-maestro" className="mt-8">
      <div className="section-head">
        <h2 id="sec-maestro" className="eyebrow">
          Salas y edificios
        </h2>
      </div>
      <p className="text-sm text-muted">
        El maestro se toca desde aquí y desde la lista de «Revisar», manteniendo pulsada la fila. Una
        sala nueva nace con matrícula, QR y el equipamiento por defecto de su edificio.
      </p>

      <ul className="mt-3 space-y-2">
        {(edificios ?? []).map((b) => (
          <FilaDeEdificio
            key={b.id}
            edificio={b}
            salas={salasDe(b.id)}
            desplegado={abierto === b.id}
            onAlternar={() => setAbierto(abierto === b.id ? null : b.id)}
            onAcciones={setHoja}
          />
        ))}
      </ul>

      <div className="card mt-4 p-4">
        <p className="text-sm font-medium">Añadir un edificio</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-[6rem_1fr_auto]">
          <label className="text-xs text-muted">
            Código
            <input
              type="text"
              value={codigoEd}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setCodigoEd(e.target.value)}
              placeholder="H"
              className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 font-mono text-base text-ink"
            />
          </label>
          <label className="text-xs text-muted">
            Nombre
            <input
              type="text"
              value={nombreEd}
              onChange={(e) => setNombreEd(e.target.value)}
              placeholder="Edificio H"
              className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-base text-ink"
            />
          </label>
          <button
            type="button"
            disabled={
              !codigoEd.trim() || !nombreEd.trim() || problemaEd !== null || alta.isPending
            }
            onClick={() => alta.mutate({ code: codigoNuevo, name: nombreEd.trim() })}
            className="key key-accent mt-1 min-h-11 self-end px-3 text-sm"
          >
            Añadir
          </button>
        </div>
        {problemaEd && <p className="mt-2 text-sm text-crit">{problemaEd}</p>}
        {avisoEd && <p className="mt-2 text-sm text-warn">{avisoEd}</p>}
        <p className="mt-2 text-xs text-muted">
          El código es el sufijo con el que las incidencias nombran sus salas —«1.7 H»—, así que
          conviene que sea el que ya se usa por escrito.
        </p>
      </div>

      <PapeleraDelMaestro onHecho={anotar} />

      {alta.isError && (
        <p className="mt-3 text-sm text-crit">
          {alta.error instanceof Error ? alta.error.message : 'No se ha podido aplicar.'}
        </p>
      )}
      {/* La región viva se monta SIEMPRE y solo le cambia el texto. Montada a la
          vez que su contenido —que es como estaba: el `<p>` no existía hasta que
          había nota— VoiceOver se salta el anuncio con frecuencia, y entonces
          quien no ve la pantalla no se entera de nada. Vacía no ocupa: se va con
          `sr-only` hasta que hay algo que decir. */}
      <p
        aria-live="polite"
        className={
          nota && !alta.isPending && !alta.isError ? 'mt-3 text-sm text-ok' : 'sr-only'
        }
      >
        {nota && !alta.isPending && !alta.isError ? nota : ''}
      </p>

      {/* La hoja se monta con `key` para que cambiar de fila la reinicie: sin
          eso, el formulario se abriría relleno con el código de la sala anterior
          —React reutiliza el estado del componente— y guardar eso es renombrar
          un aula con el nombre de otra.

          `vecinos` lleva también los archivados: el `unique (code)` de
          `buildings` es global y no filtra por `active`, así que el código de un
          edificio de la papelera sigue ocupado y decirlo aquí, con el nombre
          delante, evita teclear uno que el servidor va a rechazar. */}
      {hoja && (
        <HojaDeMaestro
          key={
            hoja.objeto.tipo === 'edificio'
              ? hoja.objeto.edificio.id
              : hoja.objeto.tipo === 'sala'
                ? hoja.objeto.sala.id
                : hoja.objeto.zona.id
          }
          objeto={hoja.objeto}
          zonas={hoja.zonas}
          salasDelEdificio={hoja.salas}
          edificios={vecinos}
          onCerrar={() => setHoja(null)}
          onHecho={(mensaje) => {
            anotar(mensaje)
            setHoja(null)
          }}
        />
      )}
    </section>
  )
}
