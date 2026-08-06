/**
 * La hoja de acciones del maestro: un edificio, una sala o una planta.
 *
 * Es **la única** que hay, y eso es lo importante de este fichero. Se abre desde
 * dos sitios —manteniendo pulsada una fila de «Revisar» o pulsando el `⋯` de una
 * fila del panel de «Datos»— y en los dos es este mismo componente, con los
 * mismos verbos, las mismas validaciones y las mismas frases. Hubo un momento en
 * que fueron dos hojas gemelas, una por pantalla, y duraron lo que tardó alguien
 * en leer «se restaura desde la papelera» en una y «se restaura desde Datos» en
 * la otra hablando del mismo botón: dos textos que se contradicen sobre una baja
 * enseñan a no fiarse de ninguno de los dos.
 *
 * Que además esté en la lista de trabajo es la razón que motivó todo esto: **el
 * nombre se corrige donde se ve mal**. Quien está delante del aula y lee un
 * código que no coincide con la puerta es quien puede arreglarlo, y obligarle a
 * recordarlo hasta llegar al panel es garantizar que no se arregla nunca. Lo
 * único que se queda en el panel es la papelera, porque lo archivado ya no
 * aparece en ninguna lista que se pueda mantener pulsada.
 *
 * Vive junto a `maestro.ts` —que es de donde sale todo lo que hace— y no en
 * `components/`: lo genérico, la capa modal, ya está extraído en
 * `HojaDeAcciones`; esto de aquí no es reutilizable, es el maestro.
 *
 * Lo que recibe son formas mínimas y no `Building`/`Room` de Dexie, y eso es lo
 * que permite que la abran las dos pantallas: la lista de trabajo le pasa las
 * filas del espejo local y el panel las del servidor, que son otras columnas.
 * La hoja solo necesita un código, un nombre y de qué planta cuelga.
 *
 * Tres cosas que decide esta hoja y conviene no deshacer sin leer el porqué:
 *
 *  - **Renombrar y añadir van por formulario; lo irreversible va por `confirm()`.**
 *    No es incoherencia: escribir necesita campos, y una baja necesita que se
 *    lea una frase completa antes de que ocurra. El `confirm()` es además la
 *    convención del repo para lo irreversible, y aquí cuenta en cada caso qué se
 *    lleva por delante y cómo se recupera. Las dos bajas lo tenían desde el
 *    principio; la fusión de plantas, que es la ÚNICA operación de esta hoja sin
 *    vuelta atrás, se hacía con un solo toque — y lo cuenta el bloque de la
 *    planta, ahí abajo.
 *  - **El aviso de fusión llega antes de pedirla.** `rename_zone` fusiona
 *    plantas cuando el nombre nuevo ya existe en el edificio, y eso mueve aulas.
 *    Enterarse en el mensaje de éxito sería enterarse tarde; el espejo local ya
 *    tiene las plantas del edificio, así que se puede avisar mientras se teclea.
 *  - **Sin cobertura la hoja se abre igual**, con las acciones deshabilitadas y
 *    el motivo escrito debajo. Esconderlas convertiría «no está el botón» en un
 *    misterio, y el motivo explica la asimetría en vez de dejarla como capricho.
 *  - **La confirmación de lo hecho solo existe donde dice algo que no se sabía.**
 *    Y son las dos bajas: ahí el servidor decide entre «archivado» y «borrado»
 *    —lo recuperable y lo que ya no está— contando salas y histórico que el iPad
 *    no tiene, así que ni el `confirm()` previo puede adelantarlo. Esa frase se
 *    queda dentro de la hoja hasta que se pulse «Entendido», porque pintada
 *    arriba de la lista —una cabecera que no es `sticky` en un documento que
 *    scrollea entero— quien acababa de actuar sobre el edificio veinte de
 *    veintitrés la tenía a ochocientos píxeles fuera de la pantalla.
 *
 *    Renombrar una sala, crear una y renombrar una planta o un edificio NO la
 *    tienen: la hoja se cierra sola al guardar. Ahí la frase no contaba nada que
 *    no estuviera ya en la pantalla de detrás —`aplicarOperacion` actualiza el
 *    espejo y refresca ANTES de volver, así que la sala renombrada se ve
 *    renombrada en la lista— y cobrar un toque por leer lo que ya se está viendo
 *    es una traba en mitad del flujo, no una confirmación. Quien corrige la
 *    nomenclatura de un edificio hace esto veinte veces seguidas.
 *
 * Nota de forma: aquí no se declara ni un componente interno. Un componente
 * definido dentro del cuerpo de otro es un tipo nuevo en cada render, así que
 * React desmonta y vuelve a montar su subárbol —y con él, el `<input>` que se
 * está rellenando, que pierde el foco a cada tecla. Los trozos repetidos son
 * funciones que devuelven JSX, que se insertan en el mismo sitio del árbol y no
 * cambian de identidad.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { HojaDeAcciones, type AccionDeHoja } from '@/components/HojaDeAcciones'
import { displayRoomCode } from '@/domain/normalize'
import {
  avisoDeCodigoDeEdificio,
  chocaCodigo,
  mismaPlanta,
  plantaQueAbsorbe,
  sanearCodigo,
  sanearCodigoDeEdificio,
  validarEdificio,
  validarPlanta,
  validarSala,
} from '@/domain/nomenclatura'
import { AVISO_SIN_RED, aplicarOperacion, type OperacionDeMaestro } from './maestro'
import type { RoomKind, Zone } from '@/domain/types'

/** Lo mínimo de un edificio para poder nombrarlo y renombrarlo. `Building` encaja. */
export interface EdificioDeMaestro {
  id: string
  code: string
  name: string
}

/** Lo mínimo de una sala. `Room` encaja, y también la fila de `room_overview` mapeada. */
export interface SalaDeMaestro {
  id: string
  code: string
  name: string
  zone_id: string
}

export type ObjetoDeMaestro =
  | { tipo: 'edificio'; edificio: EdificioDeMaestro; salas: number }
  | { tipo: 'sala'; sala: SalaDeMaestro; edificio: EdificioDeMaestro; zona: Zone | undefined }
  | { tipo: 'planta'; zona: Zone; edificio: EdificioDeMaestro; salas: number }

interface Props {
  objeto: ObjetoDeMaestro
  /** Las plantas del edificio: sirven para avisar de una fusión antes de pedirla. */
  zonas: Zone[]
  /** Las salas del edificio: el choque de código se detecta aquí, sin ir al servidor. */
  salasDelEdificio: SalaDeMaestro[]
  /** Los demás edificios: el choque de código de edificio, también en local. */
  edificios?: EdificioDeMaestro[]
  /** Abrir directamente en el formulario de alta (el botón «+ Sala» de la cabecera). */
  pasoInicial?: 'menu' | 'nueva-sala'
  onCerrar: () => void
  /** Tras un RPC con éxito, con la frase ya compuesta. El padre la pinta y cierra. */
  onHecho: (mensaje: string) => void
}

type Paso = 'menu' | 'renombrar' | 'nueva-sala'

/**
 * El valor del desplegable que significa «una planta que todavía no existe».
 *
 * Lleva un espacio delante para que no pueda coincidir nunca con el uuid de una
 * zona: los identificadores de este esquema no llevan blancos.
 */
const PLANTA_NUEVA = ' nueva'

/**
 * Las operaciones que se paran a decir lo que han hecho, y las únicas.
 *
 * El criterio no es la gravedad: es si el servidor ha podido decidir algo que
 * quien pulsó no podía saber. `delete_building` y `delete_room` cuentan salas
 * archivadas e histórico que el dispositivo no tiene, así que eligen entre
 * archivar y borrar después de que el `confirm()` haya prometido una de las dos
 * — y perder esa frase es quedarse creyendo lo contrario de lo que pasó.
 *
 * Todo lo demás se cierra solo. Un renombrado no tiene sorpresa que contar: el
 * resultado está en la lista de detrás en cuanto la hoja se quita de en medio,
 * y una confirmación de lo evidente es un toque cobrado a quien está corrigiendo
 * la nomenclatura de un edificio entero, aula por aula.
 *
 * Que se cierre no pierde el mensaje donde sí se lee: `onHecho` lo recibe igual,
 * y el panel de «Datos» —que sí tiene sitio fijo para enseñarlo— lo sigue
 * pintando. En el aula, donde no hay sitio, simplemente ya no estorba.
 */
const CONFIRMACION_OBLIGADA: ReadonlyArray<OperacionDeMaestro['kind']> = [
  'baja-edificio',
  'baja-sala',
]

const TIPOS: Array<{ value: RoomKind; label: string }> = [
  { value: 'aula', label: 'Aula' },
  { value: 'sala_reunion', label: 'Sala de reunión' },
  { value: 'laboratorio', label: 'Laboratorio' },
  { value: 'otro', label: 'Otro' },
]

/* Los moldes de campo son los del panel de «Datos», literalmente: el mismo alto
   de objetivo táctil y la misma monoespaciada para lo que es una matrícula. Dos
   formularios que hacen lo mismo con dos aspectos distintos se leen como dos
   funciones distintas. */
const CAMPO = 'mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-sm text-ink'
const CAMPO_CODIGO = `${CAMPO} font-mono`

export function HojaDeMaestro({
  objeto,
  zonas,
  salasDelEdificio,
  edificios,
  pasoInicial,
  onCerrar,
  onHecho,
}: Props): React.ReactElement {
  const qc = useQueryClient()

  /*
   * Una planta se abre directamente en su formulario, sin pasar por el menú.
   *
   * Es el único de los tres que tiene un solo verbo —no se da de baja una planta:
   * se vacía moviendo sus aulas, y entonces el servidor la borra sola—, así que
   * su menú sería una lista de un elemento, que es un toque de más entre alguien
   * y lo que ya había pedido. En el panel se nota todavía más: allí el botón se
   * llama «Renombrar», y abrirle un menú a quien acaba de pulsar «Renombrar» es
   * contestarle con la pregunta que ya había respondido.
   *
   * `sinMenu` es lo que decide si se pinta el «← Acciones» de arriba: sin menú
   * detrás, ese botón llevaría a una pantalla que nadie ha visto. Lo mismo vale
   * para el «+ Sala» de la cabecera de «Revisar», que también entra directo.
   */
  const sinMenu = pasoInicial === 'nueva-sala' || objeto.tipo === 'planta'
  const [paso, setPaso] = useState<Paso>(pasoInicial ?? 'menu')

  /*
   * Los campos se siembran con el valor CRUDO de la base de datos, nunca con
   * `displayRoomCode`. Esa función pinta `−2.1` con el signo menos tipográfico
   * porque el guion se lee como una errata; si ese texto entra en un campo
   * editable, el U+2212 acaba en la columna `code` y a partir de ahí la sala
   * deja de cruzar con su propio histórico de incidencias. Lo que se enseña y lo
   * que se guarda no son el mismo texto, y aquí manda lo que se guarda.
   */
  const [codigo, setCodigo] = useState(() => {
    if (pasoInicial === 'nueva-sala') return ''
    if (objeto.tipo === 'edificio') return objeto.edificio.code
    return objeto.tipo === 'sala' ? objeto.sala.code : ''
  })
  /* El nombre de una sala que se llama como su código no se enseña: el servidor
     lo rellena solo, y verlo repetido invita a «corregirlo» tocando dos campos
     para decir lo mismo. */
  const [nombre, setNombre] = useState(() => {
    if (pasoInicial === 'nueva-sala') return ''
    if (objeto.tipo === 'edificio') return objeto.edificio.name
    if (objeto.tipo === 'planta') return objeto.zona.name
    return objeto.sala.name === objeto.sala.code ? '' : objeto.sala.name
  })
  const [tipo, setTipo] = useState<RoomKind>('aula')
  const [plantaNueva, setPlantaNueva] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [fallo, setFallo] = useState<string | null>(null)
  /*
   * ¿Hay algo tecleado que se perdería al cerrar?
   *
   * Lo marcan los propios campos al cambiar, y no se deduce comparando con el
   * valor sembrado: «lo he escrito yo» y «coincide con lo que había» no son lo
   * mismo —teclear un código, arrepentirse y volver a dejarlo igual sigue siendo
   * haber estado escribiendo—, y el único uso de esto es decidir si el velo de la
   * hoja puede cerrarla de un roce. Ante la duda, que no la cierre.
   */
  const [tocado, setTocado] = useState(false)
  /** La frase del servidor cuando ya está hecho. Se lee aquí, no en la lista. */
  const [hecho, setHecho] = useState<string | null>(null)
  const botonEntendido = useRef<HTMLButtonElement>(null)
  const idDeLaFrase = useId()

  const zonasOrdenadas = useMemo(
    () =>
      [...zonas].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'es')),
    [zonas],
  )

  const [plantaId, setPlantaId] = useState<string>(() =>
    objeto.tipo === 'sala' ? objeto.sala.zone_id : (zonasOrdenadas[0]?.id ?? PLANTA_NUEVA),
  )

  /*
   * La cobertura se vigila mientras la hoja está abierta.
   *
   * Entre abrirla y pulsar pasa el tiempo que pasa en el sótano de un edificio,
   * y no hay nada peor que un botón que sigue prometiendo lo que ya no puede
   * hacer. `aplicarOperacion` vuelve a comprobarlo antes de llamar a nadie: esto
   * es el aviso, no la defensa.
   */
  const [enLinea, setEnLinea] = useState(() => navigator.onLine)
  useEffect(() => {
    const alCambiar = (): void => setEnLinea(navigator.onLine)
    window.addEventListener('online', alCambiar)
    window.addEventListener('offline', alCambiar)
    return () => {
      window.removeEventListener('online', alCambiar)
      window.removeEventListener('offline', alCambiar)
    }
  }, [])

  const bloqueado = !enLinea || enviando
  const edificio = objeto.edificio

  /*
   * Al terminar, el foco se va al «Entendido» de la confirmación.
   *
   * No es un adorno de accesibilidad: el botón que se acaba de pulsar
   * —«Guardar», «Dar de baja»— desaparece del árbol en ese mismo render, así que
   * el foco caería al `<body>` y quien navega con VoiceOver se quedaría sin saber
   * qué ha pasado y sin nada bajo el dedo. Llevarlo al único botón que queda
   * anuncia la frase y deja el objetivo donde ya está la mano.
   */
  useEffect(() => {
    if (hecho !== null) botonEntendido.current?.focus()
  }, [hecho])

  const ejecutar = (op: OperacionDeMaestro): void => {
    setFallo(null)
    setEnviando(true)
    void aplicarOperacion(op, qc)
      .then((mensaje) => {
        if (CONFIRMACION_OBLIGADA.includes(op.kind)) setHecho(mensaje)
        // Se cierra sin escalón. El foco no se cae al `<body>`: `HojaDeAcciones`
        // lo devuelve a la fila que abrió la hoja al desmontarse, que es donde
        // estaba la mano y donde acaba de cambiar lo que se ha guardado.
        else onHecho(mensaje)
      })
      .catch((e: unknown) => {
        /*
         * El texto del servidor, tal cual. `maestro.ts` ya lo ha convertido en
         * `Error` con una frase escrita para esta pantalla —«El código H es de
         * un edificio que está en la papelera»—, y cualquier reescritura aquí
         * solo puede empeorarla. La hoja se queda abierta: el campo sigue lleno
         * y se corrige sin tener que volver a buscar la fila.
         */
        setFallo(e instanceof Error ? e.message : 'No se ha podido aplicar.')
        setEnviando(false)
      })
  }

  // --- La planta de destino, compartida por «renombrar sala» y «añadir sala» ---

  /*
   * Escribir una planta que ya existe no crea una planta nueva: el servidor la
   * resuelve por `norm_text`, así que «1a planta» y «1ª PLANTA» son la misma. Se
   * resuelve también aquí para poder mirar los códigos ocupados de la planta a
   * la que la sala va a acabar yendo, y no los de la que se ve en el desplegable.
   */
  const zonaDestino: Zone | null = useMemo(
    () =>
      plantaId === PLANTA_NUEVA
        ? plantaQueAbsorbe(plantaNueva, zonasOrdenadas, '')
        : (zonasOrdenadas.find((z) => z.id === plantaId) ?? null),
    [plantaId, plantaNueva, zonasOrdenadas],
  )

  const salasDelDestino = useMemo(
    () => (zonaDestino ? salasDelEdificio.filter((s) => s.zone_id === zonaDestino.id) : []),
    [zonaDestino, salasDelEdificio],
  )

  const nombreDeLaPlanta = (): string =>
    plantaId === PLANTA_NUEVA ? plantaNueva.trim() : (zonaDestino?.name ?? '')

  function desplegableDePlanta(): React.ReactElement {
    return (
      <>
        <label className="block text-xs text-muted">
          Planta o zona
          <select
            value={plantaId}
            onChange={(e) => {
              setTocado(true)
              setPlantaId(e.target.value)
            }}
            className={CAMPO}
          >
            {zonasOrdenadas.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
            <option value={PLANTA_NUEVA}>Otra planta…</option>
          </select>
        </label>
        {plantaId === PLANTA_NUEVA && (
          <label className="block text-xs text-muted">
            Nombre de la planta
            <input
              type="text"
              value={plantaNueva}
              onChange={(e) => {
                setTocado(true)
                setPlantaNueva(e.target.value)
              }}
              placeholder="1ª PLANTA"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className={CAMPO}
            />
            {/* Si lo tecleado es una planta que ya existe, se dice: si no,
                parece que se está creando una segunda con el mismo nombre. */}
            {zonaDestino && (
              <span className="mt-1 block font-normal text-muted">
                «{zonaDestino.name}» ya existe aquí: la sala irá a esa, no se crea otra.
              </span>
            )}
            {/* Dejarlo vacío no es un error, pero tampoco es nada: el servidor la
                mete en «SIN ZONA», que es donde acaban las salas que nadie
                colocó. Decirlo aquí evita tener que ir a buscarlas luego. */}
            {plantaNueva.trim() === '' && (
              <span className="mt-1 block font-normal text-muted">
                En blanco, la sala entra en «SIN ZONA».
              </span>
            )}
          </label>
        )}
      </>
    )
  }

  const bloqueDeFallo = fallo ? <p className="mt-3 text-sm text-crit">{fallo}</p> : null
  const bloqueSinRed = enLinea ? null : <p className="mt-3 text-xs text-muted">{AVISO_SIN_RED}</p>

  /* Sin menú detrás no hay nada a lo que volver: se entró directo, tanto desde
     «+ Sala» de la cabecera como al pulsar sobre una planta. */
  const volver = sinMenu ? null : (
    <button
      type="button"
      onClick={() => {
        setFallo(null)
        setPaso('menu')
      }}
      className="-ml-2 min-h-11 px-2 text-sm text-accent"
    >
      ← Acciones
    </button>
  )

  // ---------------------------------------------------------------------------
  // Una baja aplicada: qué de las dos cosas hizo el servidor
  // ---------------------------------------------------------------------------

  /*
   * Va la primera de todas las ramas, y sin salida por el velo.
   *
   * Solo llega aquí lo que está en `CONFIRMACION_OBLIGADA`, y es donde esta
   * pantalla se gana el toque que cuesta: dice cuál de las dos cosas hizo el
   * servidor. `delete_building` cuenta TODAS las salas —archivadas incluidas— y
   * el iPad solo tiene las vivas, así que un edificio cuyas aulas se archivaron
   * a mano da `salas === 0` en el `confirm()` previo, que promete «se borra de
   * verdad y su código queda libre», y el servidor contesta «archivado». Perder
   * esa frase es quedarse creyendo lo contrario de lo que ha pasado.
   *
   * Lo que se cierra solo —renombrar, crear— no pasa por aquí: allí no hay dos
   * respuestas posibles que distinguir, y el escalón era trabajo sin nada dentro.
   *
   * Por eso se lee aquí, en la capa fija, encima de la lista y a la altura del
   * pulgar, y no se va hasta que se pulsa «Entendido». Pintada arriba de una
   * lista de veintitrés edificios que scrollea entera, quien acababa de actuar
   * sobre el edificio veinte la tenía fuera de la pantalla por ochocientos
   * píxeles: lo único que percibía era que la fila se evaporaba y que, un viaje
   * de red después, todo saltaba ochenta y cinco píxeles bajo el dedo.
   */
  if (hecho !== null) {
    return (
      <HojaDeAcciones
        titulo="Hecho"
        acciones={[]}
        cierrePorFondo={false}
        etiquetaDeCierre={null}
        onCerrar={() => onHecho(hecho)}
      >
        <p id={idDeLaFrase} role="status" className="mt-2 text-sm text-ok">
          {hecho}
        </p>
        {/* La frase va en `aria-describedby` del botón y no solo en la región
            viva: el foco llega aquí desde un botón que acaba de desaparecer, y
            una región montada a la vez que su contenido es justo la que VoiceOver
            se salta. Así se lee «Entendido» y, detrás, lo que ha pasado. */}
        <button
          ref={botonEntendido}
          type="button"
          aria-describedby={idDeLaFrase}
          onClick={() => onHecho(hecho)}
          className="key key-accent mt-3 min-h-touch w-full px-4 text-sm"
        >
          Entendido
        </button>
      </HojaDeAcciones>
    )
  }

  // ---------------------------------------------------------------------------
  // Formulario: añadir una sala
  // ---------------------------------------------------------------------------

  if (paso === 'nueva-sala') {
    const sinEmpezar = codigo.trim() === '' && nombre.trim() === ''
    const choque = chocaCodigo(codigo, salasDelDestino)
    const motivo =
      validarSala(codigo, nombre) ??
      (plantaId === PLANTA_NUEVA && plantaNueva.trim() !== ''
        ? validarPlanta(plantaNueva)
        : null) ??
      (choque.con
        ? `Ya hay una sala ${displayRoomCode(sanearCodigo(codigo).trim())} en «${
            zonaDestino?.name ?? ''
          }»: ${choque.etiqueta}.`
        : null)

    return (
      <HojaDeAcciones
        titulo="Añadir una sala"
        cierrePorFondo={!tocado}
        subtitulo={`${edificio.code} · ${edificio.name}`}
        acciones={[]}
        onCerrar={onCerrar}
      >
        {volver}
        <div className="mt-2 grid gap-2">
          {desplegableDePlanta()}
          <label className="block text-xs text-muted">
            Código de la sala
            <input
              type="text"
              value={codigo}
              onChange={(e) => {
                setTocado(true)
                setCodigo(sanearCodigo(e.target.value))
              }}
              placeholder="1.7"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className={CAMPO_CODIGO}
            />
          </label>
          <label className="block text-xs text-muted">
            Nombre (opcional)
            <input
              type="text"
              value={nombre}
              onChange={(e) => {
                setTocado(true)
                setNombre(e.target.value)
              }}
              placeholder="Se queda con el código"
              className={CAMPO}
            />
          </label>
          <label className="block text-xs text-muted">
            Tipo
            <select
              value={tipo}
              onChange={(e) => {
                setTocado(true)
                setTipo(e.target.value as RoomKind)
              }}
              className={CAMPO}
            >
              {TIPOS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* El formulario recién abierto está vacío, y un formulario vacío no es
            un formulario mal rellenado: teñir de rojo «la sala necesita un
            código» antes de que a nadie le haya dado tiempo a teclearlo es
            regañar por adelantado. El botón ya está deshabilitado, que es toda
            la información que hace falta hasta que se empieza. */}
        {motivo && !sinEmpezar && <p className="mt-3 text-sm text-crit">{motivo}</p>}
        {/* La matrícula y el equipamiento por defecto los pone el servidor:
            decirlo evita que alguien vaya después a «Datos» a añadirlos a mano,
            que es como se acaba con dos proyectores en la misma aula. */}
        <p className="mt-2 text-xs text-muted">
          Nace con su matrícula, su QR y el equipamiento por defecto del edificio.
        </p>
        {bloqueDeFallo}
        {bloqueSinRed}

        <button
          type="button"
          disabled={bloqueado || motivo !== null}
          onClick={() =>
            ejecutar({
              kind: 'nueva-sala',
              building: edificio.id,
              zone: nombreDeLaPlanta(),
              code: sanearCodigo(codigo).trim(),
              name: nombre.trim(),
              tipo,
            })
          }
          className="key key-accent mt-3 min-h-touch w-full px-4 text-sm"
        >
          {enviando ? 'Añadiendo…' : 'Añadir la sala'}
        </button>
      </HojaDeAcciones>
    )
  }

  // ---------------------------------------------------------------------------
  // Formulario: renombrar el edificio
  // ---------------------------------------------------------------------------

  if (paso === 'renombrar' && objeto.tipo === 'edificio') {
    const choque = chocaCodigo(codigo, edificios ?? [], edificio.id)
    const motivo =
      validarEdificio(codigo, nombre) ??
      (choque.con
        ? `Ya existe un edificio con el código ${sanearCodigoDeEdificio(codigo)}: ${choque.etiqueta}.`
        : null)
    const aviso = avisoDeCodigoDeEdificio(codigo)

    return (
      <HojaDeAcciones
        titulo="Renombrar el edificio"
        cierrePorFondo={!tocado}
        subtitulo={`${edificio.code} · ${edificio.name}`}
        acciones={[]}
        onCerrar={onCerrar}
      >
        {volver}
        <div className="mt-2 grid gap-2">
          <label className="block text-xs text-muted">
            Código
            <input
              type="text"
              value={codigo}
              onChange={(e) => {
                setTocado(true)
                setCodigo(e.target.value)
              }}
              placeholder="H"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className={CAMPO_CODIGO}
            />
          </label>
          <label className="block text-xs text-muted">
            Nombre
            <input
              type="text"
              value={nombre}
              onChange={(e) => {
                setTocado(true)
                setNombre(e.target.value)
              }}
              placeholder="Edificio H"
              className={CAMPO}
            />
          </label>
        </div>

        {motivo && <p className="mt-3 text-sm text-crit">{motivo}</p>}
        {/* Aviso, no bloqueo: la regla del sufijo la tiene el importador de
            incidencias, no el servidor, y una regla que solo existe aquí es una
            regla que cualquiera se salta desde el panel sin enterarse. */}
        {!motivo && aviso && <p className="mt-3 text-xs text-warn">{aviso}</p>}
        {/* Cambiar el código no rompe el histórico, y hay que decirlo: si no,
            nadie se atreve a tocar un código que lleva años escrito en partes. */}
        <p className="mt-2 text-xs text-muted">
          El código anterior queda de alias en cada sala, así que las incidencias antiguas se
          siguen resolviendo. Las placas de puerta no cambian: llevan la matrícula, no el código.
        </p>
        {bloqueDeFallo}
        {bloqueSinRed}

        <button
          type="button"
          disabled={bloqueado || motivo !== null}
          onClick={() =>
            ejecutar({
              kind: 'renombrar-edificio',
              id: edificio.id,
              code: sanearCodigoDeEdificio(codigo),
              name: nombre.trim(),
            })
          }
          className="key key-accent mt-3 min-h-touch w-full px-4 text-sm"
        >
          {enviando ? 'Guardando…' : 'Guardar'}
        </button>
      </HojaDeAcciones>
    )
  }

  // ---------------------------------------------------------------------------
  // Formulario: renombrar o mover una sala
  // ---------------------------------------------------------------------------

  if (paso === 'renombrar' && objeto.tipo === 'sala') {
    const { sala, zona } = objeto
    const mueve = zonaDestino
      ? zonaDestino.id !== sala.zone_id
      : plantaId === PLANTA_NUEVA && plantaNueva.trim() !== ''
    const choque = chocaCodigo(codigo, salasDelDestino, sala.id)
    const motivo =
      validarSala(codigo, nombre) ??
      (plantaId === PLANTA_NUEVA ? validarPlanta(plantaNueva) : null) ??
      (choque.con
        ? `Ya hay una sala ${displayRoomCode(sanearCodigo(codigo).trim())} en «${
            zonaDestino?.name ?? ''
          }»: ${choque.etiqueta}.`
        : null)

    return (
      <HojaDeAcciones
        titulo="Renombrar la sala"
        cierrePorFondo={!tocado}
        subtitulo={`${displayRoomCode(sala.code)} · ${zona?.name ?? ''} · ${edificio.code}`}
        acciones={[]}
        onCerrar={onCerrar}
      >
        {volver}
        <div className="mt-2 grid gap-2">
          <label className="block text-xs text-muted">
            Código
            <input
              type="text"
              value={codigo}
              onChange={(e) => {
                setTocado(true)
                setCodigo(sanearCodigo(e.target.value))
              }}
              placeholder="1.7"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className={CAMPO_CODIGO}
            />
          </label>
          <label className="block text-xs text-muted">
            Nombre (opcional)
            <input
              type="text"
              value={nombre}
              onChange={(e) => {
                setTocado(true)
                setNombre(e.target.value)
              }}
              placeholder="Se queda con el código"
              className={CAMPO}
            />
          </label>
          {/*
            Cambiar la planta aquí mueve ESTA aula. Renombrar la planta entera es
            otra acción, con otro verbo, en la cabecera de planta de la lista:
            llamarlas igual haría que alguien renombrara una planta de treinta
            aulas creyendo que movía una sola.
          */}
          {desplegableDePlanta()}
        </div>

        {motivo && <p className="mt-3 text-sm text-crit">{motivo}</p>}
        {!motivo && mueve && (
          <p className="mt-3 text-xs text-muted">
            Se moverá a «{nombreDeLaPlanta()}». Si «{zona?.name ?? ''}» se queda sin aulas,
            desaparece de la lista.
          </p>
        )}
        <p className="mt-2 text-xs text-muted">
          La matrícula de la placa no cambia, y el código anterior queda de alias para el histórico.
        </p>
        {bloqueDeFallo}
        {bloqueSinRed}

        <button
          type="button"
          disabled={bloqueado || motivo !== null}
          onClick={() =>
            ejecutar({
              kind: 'renombrar-sala',
              id: sala.id,
              code: sanearCodigo(codigo).trim(),
              name: nombre.trim(),
              // Nulo es «no la muevas». Mandar la planta actual funcionaría
              // igual, pero haría que el servidor contestara «movida» a un
              // renombrado que no ha movido nada, y el mensaje lo diría.
              zona: mueve ? nombreDeLaPlanta() : null,
            })
          }
          className="key key-accent mt-3 min-h-touch w-full px-4 text-sm"
        >
          {enviando ? 'Guardando…' : mueve ? 'Guardar y mover' : 'Guardar'}
        </button>
      </HojaDeAcciones>
    )
  }

  // ---------------------------------------------------------------------------
  // Formulario: renombrar la planta
  // ---------------------------------------------------------------------------

  /* Sin mirar `paso`: para una planta este formulario es la hoja entera, y
     escribirlo así en vez de con un `paso === 'renombrar'` que siempre se cumple
     es lo que deja que TypeScript descarte «planta» en todo lo que viene debajo
     —el menú— en vez de obligar a sostener a mano un caso imposible. */
  if (objeto.tipo === 'planta') {
    const { zona, salas } = objeto
    const invalido = validarPlanta(nombre)
    const absorbe = plantaQueAbsorbe(nombre, zonasOrdenadas, zona.id)

    /*
     * ¿Puede esto acabar en una fusión? La pregunta honesta es esa, y no «¿ve
     * el espejo una planta que se llame así?».
     *
     * `rename_zone` solo se salta la fusión en un caso: que el nombre nuevo
     * normalice igual que el actual, o sea una corrección de grafía —«1a planta»
     * → «1ª PLANTA»—, donde la planta de destino sería ella misma. En todo lo
     * demás, quien decide es el servidor con SU lista de zonas, y este
     * dispositivo puede llevar hasta dos minutos de retraso: `REFRESCO_MIN_MS`
     * es de dos minutos y no hay realtime, así que una planta creada hace un
     * momento desde otro iPad no está aquí. Con `absorbe` a null se pintaba el
     * párrafo tranquilizador —«cambia el nombre para las 30 aulas»— y el botón
     * seguía diciendo «Guardar», mientras el servidor fusionaba igual. El aviso
     * no solo se quedaba corto: en ese caso mentía.
     */
    const puedeFusionar = invalido === null && !mismaPlanta(zona.name, nombre)

    /*
     * Y por eso pasa por `confirm()`, como las dos bajas.
     *
     * Es la única operación de toda la hoja sin vuelta atrás: mueve las treinta
     * aulas y borra la planta de origen, y deshacerlo serían treinta operaciones
     * manuales sabiendo cuáles de las treinta y cuatro resultantes venían de
     * dónde — dato que no queda registrado en ninguna parte. Hasta aquí se
     * llegaba manteniendo pulsada la cabecera de planta, que entra DIRECTA al
     * formulario, y disparando con un toque apoyado únicamente en un párrafo de
     * aviso. De pie, con guantes y a contraluz, un párrafo no es una guarda.
     */
    const confirmarFusion = (): boolean => {
      if (!puedeFusionar) return true
      return confirm(
        absorbe
          ? `¿Fusionar «${zona.name}» con «${absorbe.name}»? Sus ${salas} aulas pasarán allí y ` +
            `«${zona.name}» desaparecerá. No se puede deshacer: para separarlas otra vez habría ` +
            'que mover las aulas una a una.'
          : `¿Renombrar «${zona.name}» a «${nombre.trim()}»? Si otro iPad ya ha creado una planta ` +
            `con ese nombre en ${edificio.code} —este dispositivo tarda hasta dos minutos en ` +
            `enterarse— el servidor fusionará las dos: las ${salas} aulas pasarían allí, ` +
            `«${zona.name}» desaparecería, y eso no se puede deshacer.`,
      )
    }

    return (
      <HojaDeAcciones
        titulo="Renombrar la planta"
        cierrePorFondo={!tocado}
        subtitulo={`${zona.name} · ${edificio.code}`}
        acciones={[]}
        onCerrar={onCerrar}
      >
        {volver}
        <label className="mt-2 block text-xs text-muted">
          Nombre de la planta
          <input
            type="text"
            value={nombre}
            onChange={(e) => {
              setTocado(true)
              setNombre(e.target.value)
            }}
            placeholder="1ª PLANTA"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            className={CAMPO}
          />
        </label>

        {invalido && <p className="mt-3 text-sm text-crit">{invalido}</p>}
        {/*
          El aviso de fusión, ANTES de pedirla y con el número de aulas delante.
          El servidor fusiona en vez de rechazar —rechazar obligaría a mover el
          aula una a una y no existe ninguna herramienta para eso—, pero es una
          consecuencia demasiado grande para descubrirla en el mensaje de éxito.
          El botón cambia de verbo y de tono; el que corta el paso es el
          `confirm()` de arriba, porque un párrafo no detiene a nadie.
        */}
        {!invalido && absorbe && (
          <p className="mt-3 text-sm text-warn">
            «{absorbe.name}» ya existe en este edificio: las {salas} aulas de «{zona.name}» pasarán
            allí y esta planta desaparecerá. No se puede deshacer.
          </p>
        )}
        {/* El aviso del punto ciego. No es prosa defensiva: es el único texto
            que hay cuando la planta de destino existe en el servidor y no en
            este iPad, que es justo el caso en el que nadie espera una fusión. */}
        {!absorbe && puedeFusionar && (
          <p className="mt-3 text-sm text-warn">
            Cambia el nombre para las {salas} aulas de esta planta; los códigos de las salas no se
            tocan. Y si en {edificio.code} ya hay otra planta que se llame así —la puede haber
            creado otro iPad hace un minuto—, las dos se fusionarán en una.
          </p>
        )}
        {!invalido && !puedeFusionar && (
          <p className="mt-3 text-xs text-muted">
            Cambia el nombre para las {salas} aulas de esta planta. Los códigos de las salas no se
            tocan.
          </p>
        )}
        {bloqueDeFallo}
        {bloqueSinRed}

        <button
          type="button"
          disabled={bloqueado || invalido !== null}
          onClick={() => {
            if (!confirmarFusion()) return
            ejecutar({ kind: 'renombrar-planta', id: zona.id, name: nombre.trim() })
          }}
          /* En tono crítico cuando se sabe que fusiona: es el mismo tono que
             `HojaDeAcciones` reserva para lo destructivo, y el primario decía
             «esto es lo normal» encima del único botón de la hoja que se lleva
             una planta por delante. */
          className={`key mt-3 min-h-touch w-full px-4 text-sm ${absorbe ? 'key-crit' : 'key-accent'}`}
        >
          {enviando ? 'Guardando…' : absorbe ? 'Fusionar las plantas' : 'Guardar'}
        </button>
      </HojaDeAcciones>
    )
  }

  // ---------------------------------------------------------------------------
  // El menú
  // ---------------------------------------------------------------------------

  const motivoSinRed = enLinea ? undefined : AVISO_SIN_RED
  const acciones: AccionDeHoja[] = []

  if (objeto.tipo === 'edificio') {
    const { salas } = objeto
    acciones.push(
      {
        id: 'renombrar',
        etiqueta: 'Renombrar el edificio',
        descripcion: 'Código y nombre. El código anterior queda de alias.',
        deshabilitada: bloqueado,
        motivo: motivoSinRed,
        alElegir: () => setPaso('renombrar'),
      },
      {
        id: 'nueva-sala',
        etiqueta: 'Añadir una sala',
        descripcion: 'Con su matrícula y el equipamiento por defecto.',
        deshabilitada: bloqueado,
        motivo: motivoSinRed,
        alElegir: () => {
          // Los campos vienen sembrados con el edificio; para un alta hay que
          // vaciarlos, o la sala nueva nacería llamándose «H».
          setCodigo('')
          setNombre('')
          setPaso('nueva-sala')
        },
      },
      {
        id: 'baja',
        etiqueta: 'Dar de baja el edificio',
        descripcion:
          salas > 0
            ? `Desaparece de los iPads con sus ${salas} salas; se restaura desde «Datos».`
            : 'No tiene salas: se borra de verdad y su código queda libre.',
        tono: 'critico',
        deshabilitada: bloqueado,
        motivo: motivoSinRed,
        alElegir: () => {
          /*
           * El aviso cuenta lo que va a pasar en cada uno de los dos casos, y
           * son distintos de verdad: con salas dentro el servidor archiva y todo
           * se recupera; vacío lo borra y libera el código. Quien lo lee tiene
           * que poder distinguirlos sin haber leído la migración.
           */
          const aviso =
            salas === 0
              ? `¿Borrar el edificio ${edificio.code}? No tiene salas, así que se borra de verdad y su código queda libre.`
              : `¿Dar de baja ${edificio.code} y sus ${salas} salas? Desaparece de la lista de trabajo y de todos los iPads. ` +
                'Las salas, sus revisiones y su histórico se conservan enteros, y el edificio se restaura desde «Datos» cuando haga falta.'
          if (confirm(aviso)) {
            ejecutar({ kind: 'baja-edificio', id: edificio.id, code: edificio.code })
          }
        },
      },
    )
  }

  if (objeto.tipo === 'sala') {
    const { sala } = objeto
    acciones.push(
      {
        id: 'renombrar',
        etiqueta: 'Renombrar la sala',
        descripcion: 'Código, nombre y planta.',
        deshabilitada: bloqueado,
        motivo: motivoSinRed,
        alElegir: () => setPaso('renombrar'),
      },
      {
        id: 'baja',
        etiqueta: 'Dar de baja la sala',
        descripcion: 'Con histórico se archiva y se conserva entero.',
        tono: 'critico',
        deshabilitada: bloqueado,
        motivo: motivoSinRed,
        alElegir: () => {
          if (
            confirm(
              `¿Dar de baja ${sala.code}? Sale de la lista de trabajo y de los iPads. Si tiene ` +
                'histórico se archiva en vez de borrarse, y se reactiva desde «Datos».',
            )
          ) {
            ejecutar({ kind: 'baja-sala', id: sala.id, code: sala.code })
          }
        },
      },
    )
  }

  /* Una planta no llega hasta aquí: entra directamente en su formulario, que es
     su único verbo. Si algún día se le añade un segundo —dar de baja no lo será:
     una planta desaparece sola al quedarse sin aulas— habrá que devolverle el
     menú y quitar el atajo de `sinMenu`. */
  const titulo =
    objeto.tipo === 'edificio'
      ? edificio.name
      : objeto.sala.name !== objeto.sala.code
        ? objeto.sala.name
        : displayRoomCode(objeto.sala.code)

  const subtitulo =
    objeto.tipo === 'edificio'
      ? `${edificio.code} · ${objeto.salas} salas`
      : `${displayRoomCode(objeto.sala.code)} · ${objeto.zona?.name ?? ''} · ${edificio.code}`

  return (
    <HojaDeAcciones
      titulo={titulo}
      subtitulo={subtitulo}
      acciones={acciones}
      /* También en el menú: se llega aquí desde «← Acciones» con lo tecleado
         todavía en los campos, y volver atrás no es descartarlo. */
      cierrePorFondo={!tocado}
      onCerrar={onCerrar}
    >
      {bloqueDeFallo}
    </HojaDeAcciones>
  )
}
