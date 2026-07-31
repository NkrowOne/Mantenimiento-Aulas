/**
 * Descarga completa de una tabla, por páginas.
 *
 * PostgREST puede llevar un tope de filas por respuesta (`db-max-rows`; el
 * Supabase gestionado lo trae a 1.000 de fábrica) y lo aplica **en silencio**:
 * la petición devuelve `200 OK` con las primeras N filas y nada dice que falten
 * más. Con ~276 salas y sus equipos, `assets` cruza ese tope en cuanto se
 * aplica el equipamiento por defecto — y a partir de ahí cada descarga traía
 * una ventana distinta del inventario y el espejo local «perdía» equipos que
 * estaban perfectamente guardados en el servidor.
 *
 * Y no era solo no verlos: la poda del espejo lee «no viene en la respuesta»
 * como «ya no existe», así que el tope convertía equipos e incidencias vivos en
 * borrados locales. El síntoma exacto que se ve desde el aula: equipos por
 * defecto que estaban sincronizados y desaparecen, incidencias antiguas que no
 * salen, y un técnico re-apuntando un «Monitor Atril» que sí existe — que el
 * servidor, para no perder el aparato, guarda como «Monitor Atril 2».
 *
 * De ahí las dos reglas de este módulo:
 *
 *  1. Se pide página a página hasta recibir una corta: entonces —y solo
 *     entonces— el conjunto está entero.
 *  2. Si una página falla a mitad, lo ya recibido se devuelve igual —media
 *     descarga sirve para escribir— pero marcado `completa: false`, y sobre un
 *     conjunto incompleto **no se poda nada**.
 *
 * Cada consulta paginada necesita un `order` estable: sin él, PostgREST no
 * garantiza el orden entre peticiones y dos páginas pueden solaparse o dejar un
 * hueco. Eso es responsabilidad de quien construye la consulta, y por eso el
 * parámetro se llama `porPagina`: se construye UNA consulta nueva por página,
 * porque el builder de Supabase solo se puede consumir una vez.
 */

/** Lo que contesta una página: el trozo, o el motivo por el que no llegó. */
export interface Pagina<T> {
  data: T[] | null
  error: { message: string; code?: string } | null
}

export interface Descarga<T> {
  data: T[] | null
  error: { message: string; code?: string } | null
  /**
   * El conjunto es el de verdad, entero. Solo con esto en `true` se puede
   * deducir algo de una ausencia — que es exactamente lo que hace la poda.
   */
  completa: boolean
}

/**
 * 1.000 filas por página: el tope de fábrica del Supabase gestionado. Pedir
 * justo ese tamaño hace que el caso «sin tope» siga costando una sola petición
 * por tabla, y el caso «con tope» funcione igual de bien.
 */
export const TAM_PAGINA = 1000

/**
 * Techo de páginas. No es un límite de negocio: es el freno de mano para un
 * servidor roto que devolviera siempre la misma página llena, que sin esto
 * sería un bucle infinito con el iPad descargando eternamente.
 */
const MAX_PAGINAS = 100

export async function descargaEntera<T>(
  porPagina: (desde: number, hasta: number) => PromiseLike<Pagina<T>>,
  tam = TAM_PAGINA,
): Promise<Descarga<T>> {
  const filas: T[] = []

  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const desde = pagina * tam
    let res: Pagina<T>
    try {
      res = await porPagina(desde, desde + tam - 1)
    } catch (err) {
      // El cliente de Supabase **lanza** cuando no hay respuesta —la cobertura
      // se va a mitad, un cuerpo que no es JSON—. Se trata igual que un error
      // devuelto: lo recibido vale, la ausencia no dice nada.
      res = { data: null, error: { message: err instanceof Error ? err.message : String(err) } }
    }

    if (res.error) {
      return { data: filas.length > 0 ? filas : null, error: res.error, completa: false }
    }

    const trozo = res.data ?? []
    filas.push(...trozo)

    // Una página corta es la única señal fiable de final: una llena puede ser
    // el final exacto o el tope callándose lo que falta, así que se pide otra.
    if (trozo.length < tam) {
      return { data: filas, error: null, completa: true }
    }
  }

  return {
    data: filas,
    error: { message: `Más de ${MAX_PAGINAS * tam} filas: descarga cortada por seguridad.` },
    completa: false,
  }
}
