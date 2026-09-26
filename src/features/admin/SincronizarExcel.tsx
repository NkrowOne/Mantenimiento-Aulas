import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLiveQuery } from 'dexie-react-hooks'
import { useRef, useState } from 'react'
import { ofrecerFichero } from '@/lib/ficheros'
import { aplicarOperacion } from '@/features/rooms/maestro'
import {
  analizar,
  aplicar,
  dudasPendientes,
  escribir,
  lineasDelParte,
  replanificar,
  sha256De,
  ultimaSalida,
} from './pasada'
import type { Aplicado, UltimaSalida } from './pasada'
import type { Analisis } from './pasada'
import { cambiosDesde, colaAntesDelLibro, dejarComoEsta, fraseDeCambios, nombreDelLibro } from './libroDeHoy'
import type { CambiosDesde } from './libroDeHoy'
import { Dudas } from './Dudas'
import type { AltaDeSalaDesdeDuda } from './Dudas'
import type { Respuesta, Respuestas } from '@/domain/dudas'
import { columnaDeCampo, hojaPorNombre } from '@/domain/mapa'
import type { MovimientoPrevisto } from '@/domain/movimientos'
import type { Alta, Plan, Referencia } from '@/domain/sincronizar'
import { diaEnMadrid, fechaCorta, horaCorta } from '@/domain/fechas'
import { guardarLibroSincronizado, leerLibroSincronizado } from '@/db/dexie'
import type { LibroGuardado } from '@/db/dexie'
import { Seccion } from './Seccion'

/**
 * Sincronizar el Excel de SharePoint, en los dos sentidos.
 *
 * Se sube el `.xlsx`, se ve **qué pasaría antes de que pase**, se aplica lo que
 * el Excel corrige y se descarga el libro con todo lo que la aplicación sabe. El
 * viaje de vuelta a SharePoint lo hace una persona, que es lo que permite que
 * esto funcione sin pedirle permiso a nadie.
 *
 * Lo que esta pantalla promete y conviene que se lea aquí:
 *
 * **Se elige quién manda antes de subir el libro.** La fusión sabe decidir
 * casi todo sola —si solo cambió un lado, gana ese lado—, pero hay dos casos en
 * los que no puede: la primera pasada de un libro, que no tiene con qué
 * comparar, y una celda que cambió en los dos sitios. Ahí decide lo que se
 * eligió arriba: el Excel, la aplicación, o una persona más tarde. Se puede
 * cambiar con el libro ya leído y la pasada se recalcula al momento.
 *
 * **Lo que va a pasar se enseña en cuatro montones, y siempre los mismos**: lo
 * que se escribe en el Excel, lo que entra en la aplicación, lo que hay que
 * decidir y lo que se deja como está. Primero en total, luego hoja por hoja y
 * celda a celda, con de qué aula o parte es cada celda, qué dice hoy, qué va a
 * decir y por qué. Antes se veía qué entraba en la base y cuánto se escribía
 * en el libro; no qué. Y el almacén tiene su propio bloque: qué compras, qué
 * consumos y qué devoluciones va a apuntar la pasada, y qué material **no** se
 * va a descontar porque el catálogo no lo reconoce.
 *
 * **El fichero no sale de este ordenador.** Se abre, se cruza y se parchea en el
 * navegador. Lo único que viaja al servidor es el plan —qué celdas ganó el
 * Excel— y las filas leídas, que es lo que permite contestar «¿de dónde salió
 * este dato?» seis meses después.
 *
 * **Se aplica a la base antes de descargar el libro, y no al revés.** Si el
 * libro se escribiera primero y la base fallara, el fichero diría cosas que la
 * base no sabe y la pasada siguiente las volvería a meter — o las daría por
 * choque contra la aplicación.
 *
 * **El libro vuelve intacto en todo lo que no cambia.** No se regenera: se
 * reescriben las celdas que toca y el resto se copia con sus bytes. Sobreviven
 * las fórmulas, los formatos condicionales, el autofiltro, la fila inmovilizada,
 * los comentarios, la etiqueta de confidencialidad y los metadatos de SharePoint.
 *
 * **Lo que no se puede decidir no se toca, y se dice dos veces**: aquí y en la
 * hoja `Sincronización` del propio libro. Quien abre el Excel no abre la
 * aplicación, y una bandeja que nadie mira es una bandeja que en seis meses
 * tiene quinientos choques.
 *
 * **El libro se baja con su propio botón.** Antes se descargaba solo al acabar
 * la pasada, y en el iPad eso no bajaba nada: la hoja de compartir —que es la
 * que lleva a Archivos y a SharePoint— solo se abre mientras dura la pulsación,
 * y la pasada tarda segundos. Así que el libro generado se queda aquí, en
 * memoria, y se entrega al pulsar, tantas veces como haga falta. El mismo botón
 * sirve para ver cómo quedaría el libro sin tocar la base.
 *
 * **Lo que la pasada no sabe, lo pregunta antes de aplicar.** Una fila de la
 * hoja de estado con datos y sin código de aula, un parte nuevo cuya aula cruza
 * con ocho salas, un número de serie que crearía un equipo que la sala no tenía,
 * un ordenador de repuesto que la hoja de PCs lista y la aplicación no conoce:
 * salen como dudas, se contestan aquí y la pasada se recalcula con la respuesta.
 * Con dudas sin contestar no se sincroniza; ver el libro sí se puede.
 *
 * **«Hacer el libro de hoy» es un solo botón.** La copia guardada de la última
 * sincronización se leía tal cual, y quien la bajaba el viernes se llevaba el
 * martes. Ponerla al día eran cuatro pasos y el segundo preguntaba lo mismo que
 * la vez anterior. Ahora la tarjeta dice cuánto ha cambiado la aplicación desde
 * entonces y un botón lee la copia contra la base de ahora, deja como está lo
 * que preguntaría —del lado del Excel no hay nada nuevo que decidir: es la
 * copia que salió de aquí—, aplica y escribe. Bajarlo sigue siendo otro botón,
 * porque en el iPad la hoja de compartir solo se abre desde la pulsación.
 */
/** La última salida que el servidor conoce. Se refresca al sincronizar. */
const CLAVE_ULTIMA_SALIDA = ['excel', 'ultima-salida'] as const

/** Una lectura que se canceló mientras corría: su resultado no es de nadie. */
class LecturaCancelada extends Error {
  constructor() {
    super('Lectura cancelada')
    this.name = 'LecturaCancelada'
  }
}

export function SincronizarExcel(): React.ReactElement {
  const entrada = useRef<HTMLInputElement>(null)
  const qc = useQueryClient()
  /**
   * El último libro leído, tal cual se subió. Hace falta para volver a leerlo
   * sin pedirlo otra vez: al dar de alta una sala desde una duda, la fila que
   * no cruzaba pasa a cruzar, y eso solo se sabe leyendo el libro contra la
   * base de nuevo —el análisis guarda el maestro de cuando se leyó—.
   */
  const ultimoFichero = useRef<File | null>(null)
  const [referencia, setReferencia] = useState<Referencia | null>(null)
  /** El corte: desde este día manda la aplicación en lo que ella cambió. `null` es sin corte. */
  const [corte, setCorte] = useState<string | null>(null)
  // Apagado al entrar, siempre: no se hereda de la pasada anterior.
  const [crearAulas, setCrearAulas] = useState(false)
  const [crearEquipos, setCrearEquipos] = useState(false)
  const [analisis, setAnalisis] = useState<Analisis | null>(null)
  const [fallo, setFallo] = useState<string | null>(null)
  const [aplicado, setAplicado] = useState<string | null>(null)
  const [libro, setLibro] = useState<LibroGenerado | null>(null)
  const [entregado, setEntregado] = useState<'compartido' | 'descargado' | null>(null)
  const [entregando, setEntregando] = useState(false)
  /** Si el libro no se pudo dejar guardado para luego, hay que decirlo aquí. */
  const [sinGuardar, setSinGuardar] = useState<string | null>(null)

  /*
   * Qué lectura es la que vale. Cada lectura lleva su número; «Cancelar» sube
   * el contador, y una lectura que termine después de eso ya no es de nadie:
   * ni pinta su análisis ni enseña su error. Sin esto, cancelar era imposible
   * —el selector de fichero se queda deshabilitado mientras se lee— y una
   * lectura que se quedaba colgada por la red dejaba la pantalla inservible
   * hasta salir y volver a entrar.
   */
  const lectura = useRef(0)
  const leer = useMutation({
    mutationFn: async ({ fichero, respuestas = {} }: { fichero: File; respuestas?: Respuestas }) => {
      ultimoFichero.current = fichero
      const mia = ++lectura.current
      // Lo de este aparato, arriba antes de leer la base: el libro se hace con
      // lo que el servidor sabe, y una revisión que siga en la cola no saldría.
      const cola = await colaAntesDelLibro()
      if (mia !== lectura.current) throw new LecturaCancelada()
      if (cola.sinSubir > 0) throw new Error(mensajeDeCola(cola.sinSubir))
      const a = await analizar(fichero, new Date(), respuestas, referencia, corte)
      if (mia !== lectura.current) throw new LecturaCancelada()
      return a
    },
    onSuccess: (a) => {
      setAnalisis(a)
      setFallo(null)
      setAplicado(null)
      setLibro(null)
      setEntregado(null)
    },
    onError: (e: Error) => {
      if (e instanceof LecturaCancelada) return
      setAnalisis(null)
      setFallo(e.message)
    },
  })

  const cancelarLectura = (): void => {
    lectura.current++
    leer.reset()
    if (entrada.current) entrada.current.value = ''
  }

  /**
   * Aplicar un análisis a la base y escribir el libro.
   *
   * Es lo que hace «Sincronizar» y lo que hace «Hacer el libro de hoy» cuando
   * no queda nada que decidir: un solo camino para los dos, porque la mitad de
   * este fichero existe para que la base se escriba ANTES que el libro, y dos
   * copias de ese orden son dos sitios donde un día se invierte.
   */
  const sincronizarAnalisis = async (a: Analisis): Promise<Aplicado> => {
    const r = await aplicar(a)
    // Con los números que la base puso a los partes nuevos: van a su fila.
    const bytes = await escribir(a, ahora(), r.parteId, r.altas)
    // Con el día en el nombre: dos libros sincronizados la misma semana no se
    // distinguen por el nombre, y el que se sube a SharePoint es uno de ellos.
    const nombre = nombreDelLibro(a.nombre, `sincronizado ${diaEnMadrid()}`)
    setLibro({ nombre, bytes, sincronizado: true, hecho: new Date().toISOString() })
    setEntregado(null)

    /*
     * Y guardado en el aparato, que es lo que permite bajarlo más tarde.
     *
     * Sincronizar y subir a SharePoint no ocurren en el mismo minuto: se
     * sincroniza donde hay base y se sube donde hay VPN. Hasta aquí el libro
     * vivía solo en la pantalla, así que cambiar de sección, recargar o
     * bloquear el móvil lo perdía — y recuperarlo obligaba a volver a subir
     * el fichero de entrada y sincronizar otra vez sobre una base que ya
     * tenía los cambios dentro.
     *
     * Si esto falla, la pasada ya está hecha y el libro está en pantalla: se
     * pierde poder bajarlo luego, no el trabajo.
     */
    try {
      const t = sumar(a.planes)
      await guardarLibroSincronizado({
        nombre,
        bytes,
        cuando: new Date().toISOString(),
        sha256: await sha256De(bytes),
        resumen: `${t.alExcel.celdas} celdas al libro · ${t.aLaApp.celdas} a la aplicación · ${t.alExcel.filasNuevas} filas nuevas`,
      })
      setSinGuardar(null)
    } catch (err) {
      // Y se dice en pantalla, no solo en la consola. Si esto falla —un
      // iPhone con el almacenamiento apretado— el libro solo existe mientras
      // esta pantalla siga abierta, y quien se vaya a comer sin bajarlo lo
      // pierde: la pasada ya está aplicada y no se puede regenerar.
      setSinGuardar(
        'No se ha podido guardar el libro en este aparato para luego. Bájalo ahora: si sales de aquí, habrá que volver a sincronizar.',
      )
      console.warn('No se ha podido guardar el libro para bajarlo luego:', err)
    }
    // La última salida del servidor acaba de cambiar: es esta. Sin esto, la
    // caché de un minuto conserva el sha anterior y la tarjeta avisa de que
    // «hay otro más nuevo» señalando a una fecha ANTERIOR a la del libro que
    // ofrece — un aviso que se contradice solo y que empuja a no subir el bueno.
    void qc.invalidateQueries({ queryKey: CLAVE_ULTIMA_SALIDA })
    return r
  }

  const sincronizar = useMutation({
    mutationFn: async () => {
      if (!analisis) return
      return sincronizarAnalisis(analisis)
    },
    onSuccess: (r) => {
      if (!r) return
      setAplicado(loQueEntro(r))
      setFallo(null)
    },
    onError: (e: Error) => setFallo(e.message),
  })

  /**
   * El libro de hoy, de un botón: la copia guardada, leída contra la base de
   * ahora, aplicada y escrita. Ver la cabecera del fichero.
   *
   * **Siempre manda la aplicación**, se haya elegido lo que se haya elegido
   * arriba. La copia guardada es la que salió de aquí: del lado del Excel no
   * trae nada que alguien haya corregido después, así que darle la razón sería
   * darle la razón a la aplicación de hace tres días contra la de hoy. Quien
   * quiera que mande el Excel tiene que subir el libro de SharePoint de nuevo,
   * por el selector de abajo, y la tarjeta lo dice.
   *
   * Lo que la pasada pregunte se deja como está —`dejarComoEsta`— y se dice
   * cuántas cosas fueron. Se para en tres casos, y en los tres el análisis se
   * queda en pantalla, como cuando se sube un libro a mano: una hoja sin la
   * forma esperada; el servidor conoce una salida POSTERIOR a esta copia
   * —alguien sincronizó después desde otro aparato, y aplicar la copia vieja
   * metería en la base como «corrección del Excel» lo que aquel libro ya
   * escribió, sin un solo error—; y el servidor no sabe decir cuál fue la
   * última salida, que para esto es lo mismo.
   */
  const hacerHoy = useMutation({
    mutationFn: async (g: LibroGuardado) => {
      const fichero = ficheroDe(g)
      ultimoFichero.current = fichero
      const mia = ++lectura.current
      // Y que arriba se vea lo que la pasada lleva: manda la aplicación, sin corte.
      setReferencia('app')
      setCorte(null)
      // Lo de este aparato, arriba antes de leer la base: ver `colaAntesDelLibro`.
      const cola = await colaAntesDelLibro()
      if (mia !== lectura.current) throw new LecturaCancelada()
      if (cola.sinSubir > 0) return { hecho: false as const, dejadas: 0, porQue: 'cola' as const, sinSubir: cola.sinSubir }
      let a = await analizar(fichero, new Date(), {}, 'app', null)
      if (mia !== lectura.current) throw new LecturaCancelada()
      const dejadas = dudasPendientes(a).length
      if (dejadas > 0) a = replanificar(a, dejarComoEsta(a.dudas, a.respuestas))
      setAnalisis(a)
      setFallo(null)
      setAplicado(null)
      setLibro(null)
      setEntregado(null)
      if (a.bloqueada) return { hecho: false as const, dejadas, porQue: 'forma' as const }
      if (a.libroDesconocido) return { hecho: false as const, dejadas, porQue: 'posterior' as const }
      if (a.ultimaSalidaEstado === 'no se sabe') return { hecho: false as const, dejadas, porQue: 'no se sabe' as const }
      const r = await sincronizarAnalisis(a)
      return { hecho: true as const, dejadas, r }
    },
    onSuccess: (x) => {
      if (!x.hecho) {
        setFallo(
          x.porQue === 'cola'
            ? mensajeDeCola(x.sinSubir)
            : x.porQue === 'forma'
            ? 'No se ha hecho el libro de hoy: una hoja del libro guardado no tiene la forma que la aplicación espera. Está explicado abajo.'
            : x.porQue === 'posterior'
              ? 'No se ha hecho el libro de hoy: después de esta copia ha habido otra sincronización, probablemente desde otro aparato. Aplicarla devolvería la base a la foto de antes. Pide el libro a quien la hizo, o sube el de SharePoint por el selector de abajo. Lo que haría está abajo, sin aplicar.'
              : 'No se ha hecho el libro de hoy: el servidor no ha podido decir cuál fue la última sincronización, y sin saberlo no se aplica una copia guardada. Vuelve a intentarlo con cobertura, o sube el libro de SharePoint por el selector de abajo.',
        )
        return
      }
      setAplicado(
        [
          loQueEntro(x.r),
          x.dejadas > 0
            ? `${x.dejadas} ${x.dejadas === 1 ? 'pregunta se ha dejado' : 'preguntas se han dejado'} como estaba${x.dejadas === 1 ? '' : 'n'} —equipos que la sala no tiene, partes sin aula—: para decidirlas, sube el libro por el camino de siempre.`
            : '',
        ]
          .filter(Boolean)
          .join(' '),
      )
      setFallo(null)
    },
    onError: (e: Error) => {
      if (e instanceof LecturaCancelada) return
      setFallo(e.message)
    },
  })

  /** Todo lo que vuelve a planificar deja obsoleto el libro que hubiera. */
  const volverAPlanificar = (siguiente: Analisis): void => {
    setAnalisis(siguiente)
    setLibro(null)
    setEntregado(null)
    setAplicado(null)
  }

  /** Contestar una duda es volver a planificar: no toca ni la base ni el libro. */
  const contestar = (id: string, respuesta: Respuesta | null): void => {
    if (!analisis) return
    const respuestas = { ...analisis.respuestas }
    if (respuesta === null) delete respuestas[id]
    else respuestas[id] = respuesta
    volverAPlanificar(replanificar(analisis, respuestas))
  }

  /**
   * Dar de alta una sala que la hoja de estado describe y la aplicación no
   * tiene, y volver a leer el libro con las respuestas que ya había.
   *
   * Pasa por la misma operación del maestro que el botón «+ Sala», así que la
   * sala nace con matrícula y equipamiento por defecto y el espejo local se
   * pone al día igual. Lo que cambia es lo de después: el libro se relee contra
   * la base, porque el análisis guardado no conoce la sala recién creada, y con
   * ella delante la fila cruza sola y recibe su matrícula en la pasada.
   */
  const crearSala = async (alta: AltaDeSalaDesdeDuda): Promise<void> => {
    if (!analisis) return
    await aplicarOperacion(
      { kind: 'nueva-sala', building: alta.edificioId, zone: alta.zona, code: alta.code, name: alta.code, tipo: 'aula' },
      qc,
      // Aquí sí se espera al maestro: lo siguiente es releer el libro CONTRA LA
      // BASE, y sin la sala recién creada delante la fila volvería a no cruzar
      // y a preguntar la misma duda.
      { esperarAlMaestro: true },
    )
    const respuestas = { ...analisis.respuestas }
    // La duda deja de existir en cuanto la fila cruza; si por lo que sea sigue,
    // no se arrastra una respuesta vieja que ya no significa nada.
    delete respuestas[alta.dudaId]
    if (ultimoFichero.current) await leer.mutateAsync({ fichero: ultimoFichero.current, respuestas })
  }

  /** Cambiar quién manda también: con el libro ya leído, la pasada se recalcula al momento. */
  const elegirReferencia = (r: Referencia | null): void => {
    setReferencia(r)
    if (analisis) volverAPlanificar(replanificar(analisis, analisis.respuestas, r, corte))
  }

  /** Y el corte igual: con el libro leído, la pasada se recalcula al momento. */
  const elegirCorte = (c: string | null): void => {
    setCorte(c)
    if (analisis) volverAPlanificar(replanificar(analisis, analisis.respuestas, referencia, c))
  }

  /**
   * Y crear o no las aulas nuevas, que también es volver a planificar.
   *
   * Lo importante es que se vea ANTES de aplicar: al encenderlo, la lista de
   * altas se llena con las aulas que se van a crear, una por una, con su
   * edificio y su planta. Dar de alta una sala es lo único de esta pantalla
   * que no se deshace solo, así que nadie debería encenderlo a ciegas.
   */
  const elegirCrearAulas = (v: boolean): void => {
    setCrearAulas(v)
    if (analisis) {
      volverAPlanificar(replanificar(analisis, analisis.respuestas, referencia, corte, v))
    }
  }

  /** Y los equipos, igual: se recalcula al momento y la lista se ve antes. */
  const elegirCrearEquipos = (v: boolean): void => {
    setCrearEquipos(v)
    if (analisis) {
      volverAPlanificar(
        replanificar(analisis, analisis.respuestas, referencia, corte, crearAulas, v),
      )
    }
  }

  /**
   * El mismo libro que saldría de la pasada, sin la pasada: no entra nada en la
   * base y no se apunta como salida. Es para mirarlo, y el nombre lo dice.
   */
  const previsualizar = useMutation({
    mutationFn: async () => {
      if (!analisis) return
      const bytes = await escribir(analisis, ahora())
      setLibro({
        nombre: nombreDelLibro(analisis.nombre, 'vista previa'),
        bytes,
        sincronizado: false,
        hecho: new Date().toISOString(),
      })
      setEntregado(null)
      setFallo(null)
    },
    onError: (e: Error) => setFallo(e.message),
  })

  /**
   * Sin `useMutation` a propósito: la hoja de compartir hay que pedirla dentro
   * de la pulsación, y `mutate` mete un turno de por medio antes de llamar.
   */
  const entregar = (nombre: string, bytes: Uint8Array): void => {
    if (entregando) return
    setEntregando(true)
    void ofrecerFichero(nombre, blobDe(bytes))
      .then((via) => setEntregado(via))
      .catch((e: Error) => setFallo(e.message))
      .finally(() => setEntregando(false))
  }

  /*
   * El libro de la última sincronización, esté o no esta pantalla recién
   * abierta. Es lo que contesta «sincronicé esta mañana y ahora quiero subirlo».
   */
  const guardado = useLiveQuery(() => leerLibroSincronizado(), [], undefined)

  /*
   * Y cuánto ha cambiado la aplicación desde que se hizo, contado en el espejo
   * de este aparato: es lo que dice si la copia sigue valiendo o se ha quedado
   * vieja, antes de que nadie la baje.
   */
  const cambios = useLiveQuery(
    () => (guardado ? cambiosDesde(guardado.cuando) : undefined),
    [guardado?.cuando],
    undefined,
  )

  /*
   * Y cuál fue la última salida SEGÚN EL SERVIDOR. Si no es la que este
   * aparato guardó, es que alguien ha sincronizado después: subir el de aquí
   * devolvería a SharePoint una foto vieja, y eso no se puede dejar pasar en
   * silencio.
   */
  const salida = useQuery({
    queryKey: CLAVE_ULTIMA_SALIDA,
    queryFn: ultimaSalida,
    staleTime: 60_000,
  })

  const limpiar = (): void => {
    setAnalisis(null)
    setFallo(null)
    setAplicado(null)
    setLibro(null)
    setEntregado(null)
    if (entrada.current) entrada.current.value = ''
  }

  const ocupado =
    leer.isPending || sincronizar.isPending || previsualizar.isPending || hacerHoy.isPending

  const total = analisis ? sumar(analisis.planes) : null
  const pendientes = analisis ? dudasPendientes(analisis).length : 0

  return (
    <Seccion
      id="sec-excel"
      titulo="Sincronizar el Excel de SharePoint"
      texto="Sube el libro y baja el mismo fichero con todo lo que la aplicación sabe: revisiones, horas, salidas de material, entradas y movimientos del almacén. Lo que hayas corregido en la hoja entra en la base. El fichero no sale de este ordenador."
      pendientes={pendientes}
      acciones={
        analisis ? (
          <button type="button" className="key key-quiet min-h-11 px-3 text-sm" onClick={limpiar}>
            Empezar de nuevo
          </button>
        ) : undefined
      }
    >
      {/* Antes que nada: el libro de la última sincronización, que es a lo que
          más gente entra aquí. Se esconde mientras hay uno recién hecho en
          pantalla, para no ofrecer dos descargas que se parecen. */}
      {/*
        Se esconde solo cuando hay un libro NUEVO Y SINCRONIZADO en pantalla,
        que es el único caso en que esta copia ha dejado de ser la buena. Con una
        vista previa delante sigue estando: la vista previa no se sube a
        SharePoint, y dejar la copia de verdad oculta detrás de algo que no se
        puede subir es justo cuando más falta hace tenerla a mano.
      */}
      {guardado && !libro?.sincronizado && (
        <ElUltimoLibro
          guardado={guardado}
          cambios={cambios}
          ultimaDelServidor={
            salida.isError
              ? { estado: 'no se sabe', porQue: 'no contesta' }
              : (salida.data ?? null)
          }
          entregado={entregado}
          entregando={entregando}
          onEntregar={() => entregar(guardado.nombre, new Uint8Array(guardado.bytes))}
          onHacerHoy={() => hacerHoy.mutate(guardado)}
          haciendoHoy={hacerHoy.isPending}
          disabled={ocupado}
          mandaElExcel={referencia === 'excel'}
        />
      )}

      <QuienManda
        referencia={referencia}
        corte={corte}
        ultimaSalida={analisis?.ultimaSalida ?? null}
        disabled={ocupado}
        onElegir={elegirReferencia}
        onCorte={elegirCorte}
      />

      <AulasNuevas
        encendido={crearAulas}
        cuantas={analisis?.planes.flatMap((p) => p.altas).filter((a) => a.tipo === 'sala').length ?? 0}
        hayLibro={analisis !== null}
        disabled={ocupado}
        onCambiar={elegirCrearAulas}
      />

      <EquiposNuevos
        encendido={crearEquipos}
        cuantos={
          analisis?.dudas.filter((d) => d.tipo === 'alta' && d.que === 'equipo').length ?? 0
        }
        hayLibro={analisis !== null}
        disabled={ocupado}
        onCambiar={elegirCrearEquipos}
      />

      <div className="card mt-4 p-4">
        <p className="eyebrow">2 · El libro</p>
        <label htmlFor="excel-libro" className="sr-only">
          Libro de Excel de SharePoint
        </label>
        <input
          id="excel-libro"
          ref={entrada}
          type="file"
          // El tipo MIME además de la extensión: el selector de Android filtra
          // por lo que el proveedor del fichero declara, y con la extensión
          // sola un libro venido de Drive o de SharePoint salía en gris.
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={ocupado}
          onChange={(e) => {
            const f = e.target.files?.[0]
            // Vaciar el selector nada más coger el fichero: si no, volver a
            // elegir EL MISMO libro —corregido y guardado con el mismo nombre—
            // no dispara `onChange` y parece que no hace nada.
            e.target.value = ''
            if (f) leer.mutate({ fichero: f })
          }}
          className="mt-2 block w-full text-base file:mr-3 file:h-10 file:rounded-ctl file:border-0 file:bg-accent-fill file:px-4 file:font-semibold file:text-accent-ink"
        />
        {leer.isPending ? (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <p role="status" className="text-xs text-muted">
              Leyendo el libro y el estado de la aplicación… Con poca cobertura puede tardar un
              minuto.
            </p>
            <button type="button" onClick={cancelarLectura} className="key key-quiet min-h-10 px-3 text-sm">
              Cancelar
            </button>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted">
            Se miran las seis hojas del libro: estado, partes, bolsa y PCs de repuesto del año, y
            las dos de 2025. Nada se escribe hasta que pulses «Sincronizar».
          </p>
        )}
      </div>

      {fallo && <p className="mt-3 rounded-ctl bg-crit-fill p-3 text-sm text-crit-ink">{fallo}</p>}

      {analisis?.bloqueada && <Bloqueada planes={analisis.planes} />}

      {analisis && !analisis.bloqueada && analisis.libroDesconocido && (
        <div className="card mt-4 border-warn p-4">
          <h2 className="text-sm font-semibold text-warn">
            Este no es el libro que salió de la última sincronización
          </h2>
          <p className="mt-2 text-sm text-muted">
            {analisis.ultimaSalida
              ? `La última se hizo el ${new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(analisis.ultimaSalida))} y produjo un fichero distinto de éste.`
              : 'La aplicación esperaba otro fichero.'}{' '}
            Si es una copia de antes, lo que la hoja diga se tomará por una
            corrección y entrará en la base: se revertiría lo que se haya hecho en
            la aplicación desde entonces, y no daría ningún error. Mira lo que
            entraría antes de aplicar.
          </p>
        </div>
      )}

      {analisis && !analisis.bloqueada && total && (
        <>
          <Resumen analisis={analisis} total={total} />
          <Almacen movimientos={analisis.movimientos} />
          {analisis.dudas.length > 0 && (
            <Dudas
              dudas={analisis.dudas}
              respuestas={analisis.respuestas}
              catalogo={analisis.catalogo}
              onContestar={contestar}
              onCrearSala={crearSala}
            />
          )}

          <h2 className="eyebrow mt-6">4 · Hoja por hoja</h2>
          <div className="mt-2 space-y-3">
            {analisis.planes.map((p) => (
              <PorHoja key={p.hoja} plan={p} />
            ))}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="key key-accent h-11 px-4"
              disabled={ocupado || pendientes > 0}
              title={pendientes > 0 ? 'Contesta las dudas antes de sincronizar' : undefined}
              onClick={() => sincronizar.mutate()}
            >
              {sincronizar.isPending
                ? 'Sincronizando…'
                : pendientes > 0
                  ? `Sincronizar (${pendientes} ${pendientes === 1 ? 'duda' : 'dudas'} sin contestar)`
                  : 'Sincronizar'}
            </button>
            <button
              type="button"
              className="key key-quiet h-11 px-4"
              disabled={ocupado}
              onClick={() => previsualizar.mutate()}
            >
              {previsualizar.isPending ? 'Preparando el libro…' : 'Ver cómo quedaría el libro'}
            </button>
          </div>

          {aplicado && <p className="mt-3 text-sm text-ok">{aplicado}</p>}

          {sinGuardar && (
            <p className="mt-3 rounded-ctl bg-warn-tint p-3 text-sm text-warn">{sinGuardar}</p>
          )}

          {libro && (
            <Entrega
              libro={libro}
              entregado={entregado}
              entregando={entregando}
              onEntregar={() => entregar(libro.nombre, libro.bytes)}
            />
          )}
        </>
      )}
    </Seccion>
  )
}

// -----------------------------------------------------------------------------
// 1 · Quién manda
// -----------------------------------------------------------------------------

const OPCIONES: Array<{ id: Referencia | null; titulo: string; texto: string }> = [
  {
    id: null,
    titulo: 'Que decida una persona',
    texto: 'Sale como choque, no se toca ninguno de los dos lados y se ve aquí y en la hoja «Sincronización».',
  },
  {
    id: 'excel',
    titulo: 'Manda el Excel',
    texto: 'Lo que dice la hoja entra en la aplicación.',
  },
  {
    id: 'app',
    titulo: 'Manda la aplicación',
    texto: 'Lo que dice la aplicación se escribe en la hoja.',
  },
]

/**
 * Y el de los equipos: los números de serie que el libro trae y la sala no.
 *
 * Nace de setenta y cinco monitores. La pantalla del PC no estaba en la
 * aplicación, así que ninguna sala tenía «monitor» y la pasada preguntaba por
 * cada una: setenta y cinco veces la misma pregunta, pasada tras pasada, que
 * es exactamente como no se crea ninguno.
 *
 * Lo que abarata el riesgo, y por eso este está separado del de las aulas: el
 * número de serie es único por aparato y la base lo tiene con un índice único.
 * Un equipo creado de más no se duplica ni se confunde con otro; un aula
 * creada de más se lleva la mitad del histórico de la buena.
 */
function EquiposNuevos({
  encendido,
  cuantos,
  hayLibro,
  disabled,
  onCambiar,
}: {
  encendido: boolean
  cuantos: number
  hayLibro: boolean
  disabled: boolean
  onCambiar: (v: boolean) => void
}): React.ReactElement {
  return (
    <div className="card mt-4 p-4">
      <p className="eyebrow">Equipos que el libro trae y la sala no</p>
      <label className="mt-2 flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5 size-5 shrink-0"
          checked={encendido}
          disabled={disabled}
          onChange={(ev) => onCambiar(ev.target.checked)}
        />
        <span className="text-sm">
          <span className="font-semibold">Crear los equipos con número de serie</span>
          <span className="mt-0.5 block text-muted">
            En todas las aulas y de una vez, en vez de preguntar aula por aula. El número de serie
            es único por aparato, así que uno creado de más no se confunde con otro.
          </span>
        </span>
      </label>
      {!encendido && hayLibro && cuantos > 0 && (
        <p className="mt-2 text-sm text-muted">
          Ahora mismo hay {cuantos} {cuantos === 1 ? 'pregunta' : 'preguntas'} de equipo esperando
          abajo. Enciende esto y entran todas.
        </p>
      )}
      {encendido && hayLibro && (
        <p className="mt-2 text-sm text-muted">
          Van a entrar solos. Lo que entra está abajo, celda a celda, con su aula y su número de
          serie: míralo antes de aplicar.
        </p>
      )}
    </div>
  )
}

/**
 * El interruptor de dar de alta las aulas que el libro trae y el maestro no.
 *
 * Existe porque las 43 aulas de Sócrates y de Antonio Gaudí eran 43 dudas
 * idénticas, pasada tras pasada, y contestarlas una a una no las iba a crear
 * nunca. Y está apagado de salida porque crear una sala es lo único de esta
 * pantalla que **no se deshace solo**: desde que existe, las incidencias
 * empiezan a colgar de ella, y si era la equivocada el histórico se reparte
 * entre dos aulas y ninguna lo tiene entero.
 *
 * El número de al lado es lo que lo hace seguro: al encenderlo se recalcula la
 * pasada y la lista de altas dice, una por una, qué aula, en qué edificio y en
 * qué planta. Se mira antes de aplicar.
 */
function AulasNuevas({
  encendido,
  cuantas,
  hayLibro,
  disabled,
  onCambiar,
}: {
  encendido: boolean
  cuantas: number
  hayLibro: boolean
  disabled: boolean
  onCambiar: (v: boolean) => void
}): React.ReactElement {
  return (
    <div className="card mt-4 p-4">
      <p className="eyebrow">Aulas que el libro trae y el maestro no</p>
      <label className="mt-2 flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5 size-5 shrink-0"
          checked={encendido}
          disabled={disabled}
          onChange={(ev) => onCambiar(ev.target.checked)}
        />
        <span className="text-sm">
          <span className="font-semibold">Crear las aulas que estén bien escritas</span>
          <span className="mt-0.5 block text-muted">
            Solo las que llevan un código de los de siempre —«2.6», «-1.3», «0.1P»— en un edificio
            que el maestro ya conoce. Un nombre suelto como «Aula Demo» se sigue preguntando: ahí
            una errata no se ve, y la sala inventada se lleva la mitad del histórico de la buena.
          </span>
        </span>
      </label>
      {encendido && hayLibro && (
        <p className="mt-2 text-sm text-muted">
          {cuantas === 0
            ? 'Este libro no trae ninguna aula nueva que se pueda crear sin preguntar.'
            : `Se van a crear ${cuantas} aula${cuantas === 1 ? '' : 's'}. Están abajo, en las altas, con su edificio y su planta: míralas antes de aplicar.`}
        </p>
      )}
    </div>
  )
}

/**
 * La elección va ANTES del libro, y con número: es la primera decisión de la
 * pasada y la que más cambia lo que sale. Con el libro ya leído se puede
 * cambiar igual, y la pasada se recalcula.
 */
function QuienManda({
  referencia,
  corte,
  ultimaSalida,
  disabled,
  onElegir,
  onCorte,
}: {
  referencia: Referencia | null
  corte: string | null
  /** Cuándo salió el último libro de la aplicación, si se sabe: el corte natural. */
  ultimaSalida: string | null
  disabled: boolean
  onElegir: (r: Referencia | null) => void
  onCorte: (c: string | null) => void
}): React.ReactElement {
  return (
    <div className="card mt-4 p-4">
      <p className="eyebrow">1 · Quién manda</p>
      <h2 className="mt-1 text-sm font-semibold">
        Si una celda es distinta en los dos lados y no se puede saber quién la cambió
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        Pasa la primera vez que se sincroniza un libro —no hay con qué comparar— y cuando la
        misma celda cambió en el Excel y en la aplicación. Si solo cambió un lado, gana ese lado,
        se elija lo que se elija. Y las columnas con dueño fijo —los m², la fecha de revisión
        anterior, las fórmulas— no cambian de dueño.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-3" role="group" aria-label="Quién manda">
        {OPCIONES.map((o) => {
          const activa = referencia === o.id
          return (
            <button
              key={o.id ?? 'preguntar'}
              type="button"
              aria-pressed={activa}
              disabled={disabled}
              onClick={() => onElegir(o.id)}
              className={`key min-h-11 px-3 py-2 text-left text-sm ${activa ? 'key-accent' : 'key-quiet'}`}
            >
              <span className="block font-semibold">{o.titulo}</span>
              <span className={`mt-0.5 block text-xs leading-snug ${activa ? '' : 'text-muted'}`}>{o.texto}</span>
            </button>
          )
        })}
      </div>

      {referencia !== 'app' && (
        <div className="mt-4">
          <label htmlFor="excel-corte" className="block text-sm font-semibold">
            Desde este día manda la aplicación en lo que ella cambió
          </label>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Para cuando el libro es el inventario de partida y lo trabajado en la aplicación desde
            un día —revisiones, partes cerrados, equipos instalados— tiene que quedarse aunque
            choque con la hoja. Lo que la aplicación cambió ese día o después gana; el resto sigue
            lo elegido arriba. Sin fecha, no hay corte.
            {ultimaSalida ? ` La última sincronización fue el ${fechaCorta(ultimaSalida)}.` : ''}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              id="excel-corte"
              type="date"
              className="h-11 min-w-40 rounded-ctl border border-line bg-surface px-2 text-base"
              value={corte ?? ''}
              disabled={disabled}
              onChange={(ev) => onCorte(ev.target.value || null)}
            />
            {corte && (
              <button
                type="button"
                className="key key-quiet min-h-10 px-3 text-sm"
                disabled={disabled}
                onClick={() => onCorte(null)}
              >
                Sin corte
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Cómo se dice la elección, en una frase corta, donde haga falta recordarla. */
function nombreDeLaReferencia(r: Referencia | null, corte: string | null = null): string {
  const base =
    r === 'excel'
      ? 'manda el Excel'
      : r === 'app'
        ? 'manda la aplicación'
        : 'decide una persona: los choques se quedan sin tocar'
  return corte && r !== 'app' ? `${base} · desde el ${fechaCorta(corte)} manda la aplicación en lo que cambió` : base
}

// -----------------------------------------------------------------------------
// 3 · Qué va a pasar, en total
// -----------------------------------------------------------------------------

/** Los cuatro montones, sumados. Son los mismos cuatro que enseña cada hoja. */
interface Totales {
  alExcel: { celdas: number; filasNuevas: number; filasQueSalen: number }
  aLaApp: { celdas: number; filasNuevas: number }
  decidir: { dudas: number; choques: number; sinLeer: number }
  igual: { sinCruzar: number; avisos: number }
}

function sumar(planes: Plan[]): Totales {
  const t: Totales = {
    alExcel: { celdas: 0, filasNuevas: 0, filasQueSalen: 0 },
    aLaApp: { celdas: 0, filasNuevas: 0 },
    decidir: { dudas: 0, choques: 0, sinLeer: 0 },
    igual: { sinCruzar: 0, avisos: 0 },
  }
  for (const p of planes) {
    t.alExcel.celdas += p.haciaElExcel.length
    t.alExcel.filasNuevas += p.filasQueEntran.length
    t.alExcel.filasQueSalen += p.filasQueSalen.length
    t.aLaApp.celdas += p.haciaLaBase.length
    t.aLaApp.filasNuevas += p.altas.length
    t.decidir.dudas += p.dudas.length
    t.decidir.choques += p.conflictos.length
    t.decidir.sinLeer += p.cuarentena.length
    t.igual.sinCruzar += p.sinCruzar.length
    t.igual.avisos += p.avisos.length
  }
  return t
}

function Resumen({ analisis, total }: { analisis: Analisis; total: Totales }): React.ReactElement {
  const porDecidir = total.decidir.dudas + total.decidir.choques + total.decidir.sinLeer
  return (
    <div className="card mt-4 p-4">
      <p className="eyebrow">3 · Qué va a pasar</p>
      <p className="mt-1 text-sm">
        <span className="font-semibold">{analisis.nombre}</span>
        <span className="text-muted"> · {nombreDeLaReferencia(analisis.referencia, analisis.corte)}</span>
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Monton tono="excel" titulo="Al Excel">
          <Cifra n={total.alExcel.celdas} que="celdas que se escriben" />
          <Cifra n={total.alExcel.filasNuevas} que="filas nuevas" />
          <Cifra n={total.alExcel.filasQueSalen} que="filas que salen" />
        </Monton>
        <Monton tono="app" titulo="A la aplicación">
          <Cifra n={total.aLaApp.celdas} que="celdas que entran" />
          <Cifra n={total.aLaApp.filasNuevas} que="filas nuevas" />
        </Monton>
        <Monton tono="decidir" titulo="Hay que decidir">
          <Cifra n={total.decidir.dudas} que="dudas" />
          <Cifra n={total.decidir.choques} que="choques" />
          <Cifra n={total.decidir.sinLeer} que="no se pueden leer" />
        </Monton>
        <Monton tono="igual" titulo="Se deja como está">
          <Cifra n={total.igual.sinCruzar} que="filas sin cruzar" />
          <Cifra n={total.igual.avisos} que="avisos" />
        </Monton>
      </div>

      {analisis.hojasNuevas.length > 0 && (
        <p className="mt-3 text-sm">
          Se crean {analisis.hojasNuevas.map((h) => `«${h.nombre}»`).join(' y ')}: ha cambiado el
          año.
        </p>
      )}
      <p className="mt-3 text-sm text-muted">
        Se rehacen además las hojas <strong>Revisiones</strong>,{' '}
        <strong>Movimientos de Almacén</strong>, <strong>Inventario por Sala</strong>,{' '}
        <strong>Sincronización</strong> y <strong>Léeme</strong>, enteras, con lo que la aplicación
        sabe hoy; las tres primeras salen como tablas de Excel, y las dos últimas van al final con
        la pestaña en gris.
        {analisis.hojasNuevas.some((h) => h.nombre.startsWith('PCs STOCK')) &&
          ' El libro no traía la hoja de PCs de repuesto: se estrena con lo que la aplicación sabe.'}
      </p>
      {analisis.datos.sinUnidades && (
        <p className="mt-2 text-sm text-warn">
          El servidor no tiene todavía la tabla de PCs de repuesto (falta aplicar la migración de
          septiembre): la hoja «PCs STOCK» se deja como está y el resto se sincroniza igual.
        </p>
      )}
      {porDecidir === 0 ? (
        <p className="mt-2 text-sm text-ok">Nada queda pendiente de decidir.</p>
      ) : (
        <p className="mt-2 text-sm text-warn">
          {porDecidir} cosas por decidir. Las dudas se contestan aquí abajo; los choques y lo que no
          se puede leer no se tocan en ninguno de los dos lados, y salen listados en la hoja
          «Sincronización» del libro.
        </p>
      )}
    </div>
  )
}

/** Los cuatro tonos, y siempre con la palabra delante: el color solo acompaña. */
const TONO: Record<'excel' | 'app' | 'decidir' | 'igual', string> = {
  excel: 'border-accent text-accent',
  app: 'border-ok text-ok',
  decidir: 'border-warn text-warn',
  igual: 'border-line text-muted',
}

function Monton({
  tono,
  titulo,
  children,
}: {
  tono: keyof typeof TONO
  titulo: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className={`border-l-2 pl-3 ${TONO[tono].split(' ')[0]}`}>
      <p className={`eyebrow ${TONO[tono].split(' ')[1]}`}>{titulo}</p>
      <div className="mt-1 space-y-1">{children}</div>
    </div>
  )
}

function Cifra({ n, que }: { n: number; que: string }): React.ReactElement {
  return (
    <p className={`text-sm ${n === 0 ? 'text-muted' : ''}`}>
      <span className="font-mono text-base font-semibold tabular-nums">{n}</span> {que}
    </p>
  )
}

// -----------------------------------------------------------------------------
// El almacén: lo que se va a apuntar
// -----------------------------------------------------------------------------

const TIPO_DE_MOVIMIENTO: Record<MovimientoPrevisto['tipo'], { titulo: string; tono: keyof typeof TONO; texto: string }> = {
  compra: {
    titulo: 'Compras',
    tono: 'app',
    texto: 'Entran en el almacén. La diferencia entre lo que dice «Total Comprado» y lo que la aplicación ya tenía apuntado ese año.',
  },
  consumo: {
    titulo: 'Salidas',
    tono: 'app',
    texto: 'Salen del almacén a nombre del parte, con su aula y con la fecha del parte. Solo la diferencia con lo que ese parte ya tenía descontado.',
  },
  devolucion: {
    titulo: 'Devoluciones',
    tono: 'app',
    texto: 'Vuelven al almacén: la hoja baja la cantidad, o ya no cuenta ese artículo en el parte.',
  },
  ajuste: {
    titulo: 'Ajustes al «Stock Disponible»',
    tono: 'excel',
    texto: 'Manda el Excel: lo que quede en el almacén después de compras y salidas se pone a lo que dice la hoja, con un movimiento de ajuste que deja rastro.',
  },
  sin_descontar: {
    titulo: 'Apuntado sin descontar',
    tono: 'igual',
    texto: 'Lleva un 0 delante en «Material Usado»: material reciclado, de garantía o de stock antiguo. Se guarda en el parte y no sale del almacén.',
  },
  historico: {
    titulo: 'Anteriores al recuento',
    tono: 'igual',
    texto: 'Partes de antes de que la aplicación llevara el almacén (1 de agosto de 2026). El material queda apuntado en el parte y no descuenta nada: esos meses de la bolsa son del libro.',
  },
  sin_articulo: {
    titulo: 'No se descuenta: artículo desconocido',
    tono: 'decidir',
    texto: 'El catálogo del almacén no reconoce el nombre. Se guarda el texto en el parte y no sale nada del almacén. Añade el alias en el catálogo y vuelve a subir el libro.',
  },
  no_entra: {
    titulo: 'No entra',
    tono: 'decidir',
    texto: 'La hoja dice menos compras que la aplicación. Una compra no se deshace desde una celda: va a la bandeja para que alguien mire cuál sobra.',
  },
}

function Almacen({ movimientos }: { movimientos: MovimientoPrevisto[] }): React.ReactElement {
  const grupos = (Object.keys(TIPO_DE_MOVIMIENTO) as Array<MovimientoPrevisto['tipo']>)
    .map((tipo) => ({ tipo, lista: movimientos.filter((m) => m.tipo === tipo) }))
    .filter((g) => g.lista.length > 0)
  const unidades = (lista: MovimientoPrevisto[]): number => lista.reduce((n, m) => n + m.cantidad, 0)

  return (
    <div className="card mt-4 p-4">
      <p className="eyebrow">Almacén</p>
      {grupos.length === 0 ? (
        <p className="mt-1 text-sm text-muted">El almacén no se toca en esta pasada.</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted">
            Lo que el almacén va a apuntar al sincronizar, calculado como lo calcula la base: solo
            las diferencias.
          </p>
          <div className="mt-3 space-y-4">
            {grupos.map(({ tipo, lista }) => {
              const t = TIPO_DE_MOVIMIENTO[tipo]
              return (
                <Grupo
                  key={tipo}
                  tono={t.tono}
                  titulo={`${t.titulo} (${lista.length}${lista.length !== unidades(lista) ? ` · ${unidades(lista)} unidades` : ''})`}
                  explicacion={t.texto}
                >
                  <Tabla
                    cabeceras={['Artículo', 'Unidades', 'De qué', 'Hoja · fila', 'Nota']}
                    filas={lista.map((m) => [m.articulo, String(m.cantidad), m.destino, `${m.hoja} · ${m.fila}`, m.nota])}
                  />
                </Grupo>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// 4 · Hoja por hoja
// -----------------------------------------------------------------------------

function PorHoja({ plan }: { plan: Plan }): React.ReactElement {
  const alExcel = plan.haciaElExcel.length + plan.filasQueEntran.length + plan.filasQueSalen.length
  const aLaApp = plan.haciaLaBase.length + plan.altas.length
  const decidir = plan.conflictos.length + plan.cuarentena.length + plan.dudas.length
  const igual = plan.sinCruzar.length
  const nada = alExcel + aLaApp + decidir + igual === 0 && plan.avisos.length === 0
  const hoja = hojaPorNombre(plan.hoja)
  const cabeceraDe = (campo: string): string => (hoja ? columnaDeCampo(hoja, campo)?.cabecera.trim() : undefined) ?? campo

  return (
    <details className="card p-4" open={alExcel + aLaApp + decidir > 0}>
      <summary className="cursor-pointer text-sm font-semibold">
        {plan.hoja}
        <span className="ml-2 font-normal text-muted">
          {nada
            ? 'sin cambios'
            : [
                alExcel > 0 && `${alExcel} al Excel`,
                aLaApp > 0 && `${aLaApp} a la aplicación`,
                decidir > 0 && `${decidir} por decidir`,
                igual > 0 && `${igual} se quedan como están`,
              ]
                .filter(Boolean)
                .join(' · ')}
        </span>
      </summary>

      <div className="mt-3 space-y-5">
        {alExcel > 0 && (
          <Grupo
            tono="excel"
            titulo={`Al Excel (${alExcel})`}
            explicacion="Lo que la aplicación escribe en esta hoja. Nada de esto toca la base."
          >
            {plan.haciaElExcel.length > 0 && (
              <Subgrupo titulo={`Celdas (${plan.haciaElExcel.length})`}>
                <Tabla
                  cabeceras={['Celda', 'De qué', 'Columna', 'Dice hoy', 'Pasará a decir', 'Por qué']}
                  filas={plan.haciaElExcel.map((h) => [
                    `${h.letra}${h.fila}`,
                    h.destino,
                    h.cabecera,
                    texto(h.antes),
                    texto(h.valor),
                    h.motivo,
                  ])}
                />
              </Subgrupo>
            )}
            {plan.filasQueEntran.length > 0 && (
              <Subgrupo titulo={`Filas nuevas (${plan.filasQueEntran.length})`}>
                <Tabla
                  cabeceras={['Qué', 'Cuál', 'Dónde']}
                  filas={plan.filasQueEntran.map((f) => [f.que, f.destino, f.donde])}
                />
              </Subgrupo>
            )}
            {plan.filasQueSalen.length > 0 && (
              <Subgrupo titulo={`Filas que salen (${plan.filasQueSalen.length})`}>
                <Tabla
                  cabeceras={['Fila', 'Cuál', 'Por qué']}
                  filas={plan.filasQueSalen.map((f) => [String(f.fila), f.destino, f.motivo])}
                />
              </Subgrupo>
            )}
          </Grupo>
        )}

        {aLaApp > 0 && (
          <Grupo
            tono="app"
            titulo={`A la aplicación (${aLaApp})`}
            explicacion="Lo que se corrigió en la hoja y entra en la base. Queda anotado, celda a celda, como corrección hecha desde el Excel."
          >
            {plan.haciaLaBase.length > 0 && (
              <Subgrupo titulo={`Celdas (${plan.haciaLaBase.length})`}>
                <Tabla
                  cabeceras={['Celda', 'De qué', 'Columna', 'Valor', 'Por qué']}
                  filas={plan.haciaLaBase.map((h) => [
                    `${h.letra}${h.fila}`,
                    h.destino,
                    cabeceraDe(h.campo),
                    texto(h.valor),
                    h.motivo,
                  ])}
                />
              </Subgrupo>
            )}
            {plan.altas.length > 0 && (
              <Subgrupo titulo={`Filas del libro que entran como nuevas (${plan.altas.length})`}>
                <p className="mb-2 text-xs text-muted">
                  Estaban en el libro y la aplicación no las tenía. A un parte le pone número la base,
                  y el número vuelve a su fila.
                </p>
                <Tabla
                  cabeceras={['Fila', 'Qué', 'Detalle']}
                  filas={plan.altas.map((a) => [String(a.fila), queEs(a), describirAlta(a)])}
                />
              </Subgrupo>
            )}
          </Grupo>
        )}

        {decidir > 0 && (
          <Grupo
            tono="decidir"
            titulo={`Hay que decidir (${decidir})`}
            explicacion="No se toca ninguno de los dos lados hasta que alguien decida."
          >
            {plan.dudas.length > 0 && (
              <p className="text-sm">
                {plan.dudas.length} {plan.dudas.length === 1 ? 'duda' : 'dudas'} de esta hoja: se
                contestan arriba, en el bloque de dudas.
              </p>
            )}
            {plan.conflictos.length > 0 && (
              <Subgrupo titulo={`Choques (${plan.conflictos.length})`}>
                <p className="mb-2 text-xs text-muted">
                  Los dos lados cambiaron desde la última sincronización, y a cosas distintas. Elige
                  arriba quién manda o resuélvelos a mano en uno de los dos sitios.
                </p>
                <Tabla
                  cabeceras={['Celda', 'De qué', 'Columna', 'Dice la aplicación', 'Dice la hoja']}
                  filas={plan.conflictos.map((c) => [
                    `${c.letra}${c.fila}`,
                    c.destino,
                    cabeceraDe(c.campo),
                    texto(c.base),
                    texto(c.excel),
                  ])}
                />
              </Subgrupo>
            )}
            {plan.cuarentena.length > 0 && (
              <Subgrupo titulo={`No se pueden leer (${plan.cuarentena.length})`}>
                <p className="mb-2 text-xs text-muted">
                  Ni entran en la base ni se pisan en la hoja. Un cero inventado en la columna de
                  lámparas mandaría a alguien a un aula que está perfectamente.
                </p>
                <Tabla
                  cabeceras={['Celda', 'De qué', 'Columna', 'Dice', 'Por qué']}
                  filas={plan.cuarentena.map((q) => [
                    `${q.letra}${q.fila}`,
                    q.destino,
                    cabeceraDe(q.campo),
                    texto(q.crudo),
                    q.motivo,
                  ])}
                />
              </Subgrupo>
            )}
          </Grupo>
        )}

        {(igual > 0 || plan.avisos.length > 0) && (
          <Grupo
            tono="igual"
            titulo={`Se deja como está${igual > 0 ? ` (${igual})` : ''}`}
            explicacion="Filas que no se han podido emparejar con nada de la aplicación, y lo que la pasada decide por su cuenta. Nada de esto cambia."
          >
            {plan.sinCruzar.length > 0 && (
              <Subgrupo titulo={`Filas sin cruzar (${plan.sinCruzar.length})`}>
                <Tabla
                  cabeceras={['Fila', 'Por qué']}
                  filas={plan.sinCruzar.map((s) => [String(s.fila), s.motivo])}
                />
              </Subgrupo>
            )}
            {plan.avisos.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-xs font-semibold text-muted">
                  Avisos ({plan.avisos.length}): lo que la pasada hace o cuenta por su cuenta
                </summary>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                  {plan.avisos.map((a, i) => (
                    <li key={`${i}-${a.slice(0, 40)}`}>{a}</li>
                  ))}
                </ul>
              </details>
            )}
          </Grupo>
        )}
      </div>
    </details>
  )
}

/** Un montón dentro de una hoja: el filete de color a la izquierda es el mismo que arriba. */
function Grupo({
  tono,
  titulo,
  explicacion,
  children,
}: {
  tono: keyof typeof TONO
  titulo: string
  explicacion: string
  children: React.ReactNode
}): React.ReactElement {
  const [borde, color] = TONO[tono].split(' ')
  return (
    <div className={`border-l-2 pl-3 ${borde}`}>
      <h3 className={`text-sm font-semibold ${color}`}>{titulo}</h3>
      {explicacion && <p className="mt-0.5 text-xs text-muted">{explicacion}</p>}
      <div className="mt-2 space-y-3">{children}</div>
    </div>
  )
}

function Subgrupo({ titulo, children }: { titulo: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div>
      <h4 className="text-xs font-semibold">{titulo}</h4>
      <div className="mt-1">{children}</div>
    </div>
  )
}

// -----------------------------------------------------------------------------

/** El libro que ha salido de la pasada, esperando a que alguien lo baje. */
interface LibroGenerado {
  nombre: string
  bytes: Uint8Array
  /** Si entró en la base antes de escribirse. Si no, es una vista previa. */
  sincronizado: boolean
  /** Cuándo se escribió, en ISO: la tarjeta lo dice con la hora. */
  hecho: string
}

/**
 * El libro de la última sincronización, siempre a mano.
 *
 * Sincronizar y subir a SharePoint no pasan a la vez: se sincroniza donde hay
 * base y se sube donde hay VPN, a veces horas después y desde otra pantalla.
 * Antes el fichero vivía solo en el estado de este componente, así que cambiar
 * de sección lo perdía y recuperarlo obligaba a subir otra vez el libro de
 * entrada y sincronizar sobre una base que ya tenía los cambios aplicados —una
 * pasada en balde que además vuelve a preguntar las mismas dudas—.
 *
 * Con la fecha delante y el aviso de si el servidor conoce una salida más
 * nueva: bajar un libro viejo y subirlo a SharePoint devuelve el inventario a
 * una foto anterior, y eso no se nota hasta la sincronización siguiente.
 *
 * **No se puede quitar de aquí.** Había un «Ya lo he subido» que lo borraba, y
 * hacía justo lo contrario de lo que esta tarjeta existe para hacer: la única
 * copia entera de los datos fuera de la base se iba de un toque, y quien lo
 * pulsaba antes de comprobar que SharePoint la había aceptado se quedaba sin
 * las dos. Es una copia, no un recado: se queda hasta que la sustituye la
 * sincronización siguiente, que es cuando deja de ser la buena.
 *
 * En su sitio hay «Hacer el libro de hoy», que es lo que de verdad hacía falta
 * cuando uno vuelve a esta pantalla: volver a leer **este mismo libro** contra
 * la aplicación de ahora, aplicar y escribirlo, sin ir a buscar el fichero ni
 * subirlo otra vez ni contestar lo que ya se contestó. La tarjeta dice antes
 * cuánto ha cambiado la aplicación desde la copia, para que nadie baje a
 * ciegas un libro de hace tres días.
 */
/**
 * ¿El libro guardado aquí sigue siendo el que hay que subir?
 *
 * Tres respuestas, y la tercera es la que importa: «no lo sé». Antes eran dos,
 * y el silencio de un servidor que no sabe contestar se leía como «todo bien»,
 * que es exactamente lo que devuelve SharePoint a una foto de hace semanas.
 *
 * Y la fecha se compara además del sha: si `sync_apuntar_salida` falló —solo se
 * queja por la consola—, el servidor se queda con la salida anterior y el sha
 * no coincide, pero la suya es MÁS VIEJA. Avisar entonces sería empujar a no
 * subir el libro bueno.
 */
function comoEstaElLibro(
  guardado: LibroGuardado,
  servidor: UltimaSalida | null,
): { que: 'el ultimo' | 'hay otro mas nuevo' | 'no se sabe'; cuando?: string } {
  if (servidor === null) return { que: 'no se sabe' }
  if (servidor.estado === 'no se sabe') return { que: 'no se sabe' }
  // El servidor no conoce ninguna salida: o nunca se sincronizó desde aquí, o
  // no llegó a apuntarse. El libro de este aparato es lo único que hay.
  if (servidor.estado === 'ninguna') return { que: 'el ultimo' }
  if (servidor.sha256 === guardado.sha256) return { que: 'el ultimo' }
  return servidor.cuando > guardado.cuando
    ? { que: 'hay otro mas nuevo', cuando: servidor.cuando }
    : { que: 'el ultimo' }
}

function ElUltimoLibro({
  guardado,
  cambios,
  ultimaDelServidor,
  entregado,
  entregando,
  onEntregar,
  onHacerHoy,
  haciendoHoy,
  disabled,
  mandaElExcel,
}: {
  guardado: LibroGuardado
  /** Cuánto ha cambiado la aplicación desde la copia. `undefined` mientras se cuenta. */
  cambios: CambiosDesde | undefined
  ultimaDelServidor: UltimaSalida | null
  entregado: 'compartido' | 'descargado' | null
  entregando: boolean
  onEntregar: () => void
  onHacerHoy: () => void
  haciendoHoy: boolean
  disabled: boolean
  /**
   * Arriba se ha elegido «Manda el Excel». Con eso, la copia guardada no sirve
   * para hacer el libro de hoy: es la que salió de la aplicación y no trae
   * nada del Excel que pueda mandar. Hay que subir el libro de SharePoint.
   */
  mandaElExcel: boolean
}): React.ReactElement {
  const estado = comoEstaElLibro(guardado, ultimaDelServidor)
  const frase = cambios ? fraseDeCambios(cambios) : null
  // Mientras no se sepa, la copia se ofrece como si valiera: contar tarda
  // milisegundos y no merece un botón que cambie de nombre al cargar.
  const viejo = frase?.viejo ?? false

  return (
    <div className="card mt-4 p-4">
      <p className="eyebrow">El libro para SharePoint</p>
      <h2 className="mt-1 text-sm font-semibold">
        {/* Con la hora: quien sincroniza por la mañana y después de comer no
            puede distinguir dos libros del mismo día por la fecha sola. */}
        Sincronizado el {fechaCorta(guardado.cuando)} a las {horaCorta(guardado.cuando)}
      </h2>
      <p className="mt-1 text-sm text-muted">
        {estado.que === 'hay otro mas nuevo'
          ? 'Guardado en este aparato, pero no es el último.'
          : 'Guardado en este aparato. Súbelo a SharePoint sustituyendo el original.'}{' '}
        Se queda aquí siempre: es la copia de los datos a mano, y solo la sustituye la
        sincronización siguiente.
      </p>
      <p className="mt-1 text-xs text-muted">{guardado.resumen}</p>

      {frase && (
        <p className={`mt-2 rounded-ctl p-2 text-sm ${frase.viejo ? 'bg-warn-tint text-warn' : 'text-ok'}`}>
          {frase.texto}
          {frase.viejo &&
            !mandaElExcel &&
            ' «Hacer el libro de hoy» lo lee contra la aplicación de ahora, lo aplica y lo escribe: luego se baja.'}
        </p>
      )}

      {mandaElExcel && (
        <p className="mt-2 rounded-ctl bg-warn-tint p-2 text-sm text-warn">
          Has elegido «Manda el Excel». Esta copia salió de la aplicación y no trae nada del Excel que
          pueda mandar: sube el libro de SharePoint de nuevo, abajo en «2 · El libro». El libro de hoy
          desde esta copia se hace siempre con «Manda la aplicación».
        </p>
      )}

      {estado.que === 'hay otro mas nuevo' && (
        <p className="mt-2 rounded-ctl bg-warn-tint p-2 text-sm text-warn">
          Después de éste ha habido otra sincronización
          {estado.cuando ? ` (${fechaCorta(estado.cuando)} a las ${horaCorta(estado.cuando)})` : ''}
          , probablemente desde otro aparato. Subir éste devolvería SharePoint a la foto de antes:
          pide el suyo a quien la hizo, o vuelve a sincronizar tú.
        </p>
      )}

      {estado.que === 'no se sabe' && (
        <p className="mt-2 rounded-ctl bg-warn-tint p-2 text-sm text-warn">
          No se ha podido comprobar con el servidor si éste sigue siendo el último libro. Si alguien
          ha sincronizado después que tú, subir éste devolvería SharePoint a la foto de antes.
        </p>
      )}

      {/* El botón grande es el que toca: si la copia se ha quedado vieja, hacer
          el libro de hoy; si no, bajarla. El otro sigue estando, en pequeño. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`key ${viejo ? 'key-quiet min-h-11 px-3 text-sm' : 'key-accent h-11 px-4'}`}
          disabled={entregando || haciendoHoy}
          onClick={onEntregar}
        >
          {entregando
            ? 'Entregando…'
            : viejo
              ? `Descargar la copia del ${fechaCorta(guardado.cuando)}`
              : 'Descargar el libro'}
        </button>
        {!mandaElExcel && (
          <button
            type="button"
            className={`key ${viejo ? 'key-accent h-11 px-4' : 'key-quiet min-h-11 px-3 text-sm'}`}
            disabled={disabled}
            onClick={onHacerHoy}
            title="Lee esta misma copia contra la aplicación de ahora —manda la aplicación—, aplica y escribe el libro"
          >
            {haciendoHoy
              ? 'Haciendo el libro de hoy…'
              : viejo
                ? 'Hacer el libro de hoy'
                : 'Hacerlo de nuevo con lo de hoy'}
          </button>
        )}
      </div>
      {!mandaElExcel && !haciendoHoy && (
        <p className="mt-1 text-xs text-muted">
          El libro de hoy se hace con «Manda la aplicación», se haya elegido lo que se haya elegido
          arriba: esta copia salió de la aplicación y no tiene nada del Excel que pueda mandar.
        </p>
      )}
      {haciendoHoy && (
        <p role="status" className="mt-2 text-xs text-muted">
          Se lee la copia contra la aplicación de ahora, se aplica y se escribe el libro. Con poca
          cobertura puede tardar un minuto. Cuando esté, aparece abajo con su botón de descarga.
        </p>
      )}
      <p className="mt-2 text-xs text-muted">{guardado.nombre}</p>
      {entregado && (
        <p className="mt-2 text-sm text-ok">
          {entregado === 'compartido' ? 'Compartido.' : 'Descargado.'} Súbelo a SharePoint
          sustituyendo el original.
        </p>
      )}
    </div>
  )
}

/**
 * El botón de bajar el libro. Es un botón y no una descarga automática porque
 * en iOS la hoja de compartir solo se abre desde la pulsación, y es la única
 * forma de que el fichero llegue a Archivos o a SharePoint desde el iPad.
 */
function Entrega({
  libro,
  entregado,
  entregando,
  onEntregar,
}: {
  libro: LibroGenerado
  entregado: 'compartido' | 'descargado' | null
  entregando: boolean
  onEntregar: () => void
}): React.ReactElement {
  const que = libro.sincronizado ? 'el libro' : 'la vista previa'
  return (
    <div className="card mt-4 p-4">
      <h2 className="text-sm font-semibold">
        {libro.sincronizado ? 'El libro está listo' : 'La vista previa está lista'}
      </h2>
      <p className="mt-1 text-sm text-muted">
        {libro.sincronizado
          ? `Hecho hoy a las ${horaCorta(libro.hecho)} con todo lo que la aplicación sabe. Súbelo a SharePoint sustituyendo el original.`
          : 'Es cómo quedaría el libro. No ha tocado la base, y no es el que hay que subir a SharePoint: para eso, sincroniza.'}
      </p>
      <button
        type="button"
        className="key key-accent mt-3 h-11 px-4"
        disabled={entregando}
        onClick={onEntregar}
      >
        {entregando ? 'Entregando…' : `Descargar ${que}`}
      </button>
      <p className="mt-2 text-xs text-muted">{libro.nombre}</p>
      {entregado && (
        <p className="mt-2 text-sm text-ok">
          {entregado === 'compartido'
            ? `Compartid${libro.sincronizado ? 'o' : 'a'}.`
            : `Descargad${libro.sincronizado ? 'o' : 'a'}.`}{' '}
          {libro.sincronizado
            ? 'Súbelo a SharePoint sustituyendo el original.'
            : 'Si te convence, pulsa «Sincronizar» y baja el libro de verdad.'}
        </p>
      )}
    </div>
  )
}

function Bloqueada({ planes }: { planes: Plan[] }): React.ReactElement {
  const fuera = planes.flatMap((p) => p.desajustes.map((d) => ({ hoja: p.hoja, ...d })))
  return (
    <div className="card mt-4 border-crit p-4">
      <h2 className="text-sm font-semibold text-crit">
        Una hoja no tiene la forma que la aplicación espera
      </h2>
      <p className="mt-2 text-sm text-muted">
        La pasada no empieza. Una columna insertada mueve todas las de su derecha, y escribir sin
        comprobarlo pondría cientos de números de serie en la columna de al lado sin que saltara
        nada. Corrige la cabecera en el libro o avisa de que la hoja ha cambiado.
      </p>
      <Tabla
        cabeceras={['Hoja', 'Columna', 'Debería decir', 'Dice']}
        filas={fuera.map((f) => [f.hoja, f.letra, f.esperada, f.encontrada || '(vacía)'])}
      />
    </div>
  )
}

/**
 * Una tabla que empieza corta y se abre entera si se pide.
 *
 * Se enseñan las primeras filas y se dice cuántas quedan: una tabla de 276 filas
 * dentro de una pantalla de administración no la lee nadie de una vez, y hacerla
 * scroll infinito esconde el resumen, que es lo que de verdad hay que mirar. Pero
 * «y 251 más» sin forma de verlas era esconder justo lo que se venía a
 * comprobar: el botón las abre todas.
 */
function Tabla({
  cabeceras,
  filas,
  tope = 25,
}: {
  cabeceras: string[]
  filas: string[][]
  tope?: number
}): React.ReactElement {
  const [todas, setTodas] = useState(false)
  const visibles = todas ? filas : filas.slice(0, tope)
  return (
    <div className="scroll-x">
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            {cabeceras.map((c) => (
              <th key={c} className="eyebrow pb-1 pr-4">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visibles.map((f, i) => (
            <tr key={`${f[0]}-${i}`} className="border-t border-hair">
              {f.map((v, j) => (
                <td key={j} className="py-1 pr-4 align-top">
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {filas.length > tope && (
        <button
          type="button"
          className="key key-quiet mt-2 h-9 px-3 text-xs"
          onClick={() => setTodas((v) => !v)}
        >
          {todas ? `Ver solo las ${tope} primeras` : `Ver las ${filas.length} (quedan ${filas.length - tope} más)`}
        </button>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------

function queEs(a: Alta): string {
  if (a.tipo === 'incidencia') return 'Parte'
  if (a.tipo === 'articulo') return 'Artículo del almacén'
  if (a.tipo === 'sala') return 'Aula nueva'
  return 'Ordenador de repuesto'
}

function describirAlta(a: Alta): string {
  if (a.tipo === 'incidencia') {
    return `${a.aula || 'sin aula'} · ${a.abierta ?? 'sin fecha'} · ${a.problema}${a.numero ? ` · ${a.numero}` : ''}`
  }
  if (a.tipo === 'articulo') return `${a.nombre}${a.comprado !== null ? ` · ${a.comprado} comprados` : ''}`
  if (a.tipo === 'sala') {
    // La planta deducida se dice: una leída es un dato y una deducida es una
    // apuesta, y quien revisa la lista tiene derecho a saber cuáles son cuáles.
    const planta = a.plantaDeducida ? `${a.zona} (deducida del código)` : a.zona
    return `${a.code} · ${a.edificio} · ${planta}`
  }
  return `${[a.articulo, a.marca, a.modelo].filter(Boolean).join(' ')} · ${a.serial}`
}

function texto(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(vacío)'
  if (typeof v === 'boolean') return v ? 'SÍ' : 'NO'
  return String(v)
}

function ahora(): string {
  return new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(),
  )
}

/**
 * Lo que la pasada metió en la base, dicho en una frase.
 *
 * Las aulas aparte: crear una sala es lo único de aquí que no se deshace, y
 * decirlo como «filas nuevas» lo esconde entre los partes y los artículos, que
 * sí se corrigen en la pasada siguiente.
 */
function loQueEntro(r: Aplicado): string {
  const partes = r.altas.filter((x) => x.tipo === 'incidencia').length
  const aulas = r.altas.filter((x) => x.tipo === 'sala').length
  const nuevas = r.altas.length - aulas
  return [
    r.rechazadas === 0
      ? `${r.aplicadas} celdas del Excel han entrado en la base.`
      : `${r.aplicadas} celdas han entrado y ${r.rechazadas} han ido a la bandeja de choques.`,
    nuevas > 0
      ? `${nuevas} filas nuevas del libro han entrado en la aplicación${partes > 0 ? `; los ${partes === 1 ? 'parte lleva' : `${partes} partes llevan`} ya su número en el libro` : ''}.`
      : '',
    aulas > 0
      ? `Y se ${aulas === 1 ? 'ha creado 1 aula nueva' : `han creado ${aulas} aulas nuevas`}: sus filas cruzarán solas en la pasada siguiente.`
      : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/** Por qué no se lee la base con cosas de este aparato todavía en la cola. */
function mensajeDeCola(n: number): string {
  return `Este aparato tiene ${n} ${n === 1 ? 'cambio' : 'cambios'} sin subir al servidor y no se han podido subir ahora. El libro se hace con lo que el servidor sabe, así que saldría sin ${n === 1 ? 'él' : 'ellos'}: espera a tener cobertura, comprueba la barra de sincronización de arriba y vuelve a intentarlo.`
}

/** La copia guardada, como el fichero que se habría elegido con el selector. */
function ficheroDe(g: LibroGuardado): File {
  return new File([blobDe(new Uint8Array(g.bytes))], g.nombre, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

function blobDe(bytes: Uint8Array): Blob {
  // `Uint8Array` sobre un `ArrayBuffer` normal: el tipo de Blob no acepta los
  // respaldados por `SharedArrayBuffer`.
  return new Blob([bytes as unknown as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

export { lineasDelParte }
