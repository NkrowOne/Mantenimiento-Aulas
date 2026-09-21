/**
 * Lo que el almacén va a apuntar si la pasada se aplica, dicho antes de aplicarla.
 *
 * El plan habla de celdas: «G14 → 2 Cable HDMI fibra 10 m», «P7 → 32». Lo que
 * de verdad pasa en el almacén con esas celdas lo decide la base al aplicar
 * —`sync_material_del_parte` y `sync_celda_de_articulo`— y hasta aquí no se
 * veía hasta después, en la hoja «Movimientos de Almacén» del libro que sale.
 * Sincronizar a ciegas el almacén es como se acaba con 40 cables comprados dos
 * veces, así que se calcula aquí lo mismo que va a calcular la base, con los
 * mismos datos, y se enseña.
 *
 * Tres orígenes, y la misma cuenta que hace la base en cada uno:
 *
 *  - **«Total Comprado» de la bolsa.** La diferencia entre la hoja y las
 *    compras del año que la aplicación conoce es una compra que nadie apuntó.
 *    Si la hoja dice menos, no se deshace nada: eso va a la bandeja.
 *  - **«Material Usado» de un parte.** La lista se rehace con lo que dice la
 *    hoja, y del almacén sale solo la diferencia con lo que ese parte ya tiene
 *    descontado: más unidades es un consumo, menos es una devolución, y un
 *    artículo que ya no está en la lista vuelve entero. Un artículo que el
 *    catálogo no reconoce se guarda como texto y **no mueve nada**, que es lo
 *    que hay que ver antes de aplicar, porque descuadra el almacén igual que no
 *    apuntarlo y encima parece correcto.
 *  - **Las altas.** Un artículo nuevo entra con lo comprado como compra; un
 *    parte nuevo, con su material como consumo.
 *
 * Nada de esto escribe: devuelve la lista, y `pasada.ts` la enseña.
 */

import type { Plan } from './sincronizar'
import { leerMaterial, sinDescontar } from './valores'
import type { ArticuloVolcado, IncidenciaVolcada } from './volcado'

export interface MovimientoPrevisto {
  hoja: string
  fila: number
  /** El parte o el artículo del que sale. */
  destino: string
  /**
   * Qué va a apuntar el almacén. `sin_articulo`, `sin_descontar`, `historico` y
   * `no_entra` no apuntan nada, y por eso se enseñan: son las formas de que la
   * hoja diga una cosa y el almacén se quede con otra. `sin_descontar` es la
   * buena de ellas —el 0 delante lo puso alguien a propósito— y sale para que
   * se vea que se ha entendido; `historico` es el material de un parte de antes
   * de que la aplicación llevara el almacén (`Hoja.arranque`): queda apuntado
   * en el parte y no sale de ningún sitio, porque ya salió de un almacén que
   * la aplicación no llevaba. `ajuste` es el cuadre con «Stock Disponible»
   * cuando se ha elegido que mande el Excel.
   */
  tipo: 'compra' | 'consumo' | 'devolucion' | 'ajuste' | 'sin_articulo' | 'sin_descontar' | 'historico' | 'no_entra'
  articulo: string
  cantidad: number
  nota: string
}

export interface EntradaDeMovimientos {
  planes: Plan[]
  incidencias: IncidenciaVolcada[]
  articulos: ArticuloVolcado[]
  /** Un nombre escrito como sea → el id del artículo, con los alias. */
  resolver: (nombre: string) => string | null
  /**
   * Desde cuándo lleva la aplicación el almacén (`Hoja.arranque`, un día ISO).
   * El material de un parte anterior no mueve nada: es la misma regla que
   * aplica `sync_material_del_parte` con la fecha del parte.
   */
  arranque?: string
}

export function movimientosPrevistos(e: EntradaDeMovimientos): MovimientoPrevisto[] {
  const out: MovimientoPrevisto[] = []
  const porId = new Map(e.articulos.map((a) => [a.id, a]))
  const porNumero = new Map(e.incidencias.map((i) => [norm(i.numero), i]))
  const nombreDe = (id: string, escrito: string): string => porId.get(id)?.nombre ?? escrito

  for (const p of e.planes) {
    for (const h of p.haciaLaBase) {
      if (h.campo === 'articulo.comprado') {
        const id = e.resolver(h.destino) ?? e.articulos.find((a) => norm(a.nombre) === norm(h.destino))?.id
        const art = id ? porId.get(id) : undefined
        const dice = numero(h.valor)
        if (dice === null) continue
        const tiene = art?.comprado ?? 0
        const diferencia = dice - tiene
        if (diferencia > 0) {
          out.push({
            hoja: p.hoja,
            fila: h.fila,
            destino: h.destino,
            tipo: 'compra',
            articulo: art?.nombre ?? h.destino,
            cantidad: diferencia,
            nota: `la hoja dice ${dice} comprados y la aplicación tenía ${tiene}: la diferencia entra como compra`,
          })
        } else if (diferencia < 0) {
          out.push({
            hoja: p.hoja,
            fila: h.fila,
            destino: h.destino,
            tipo: 'no_entra',
            articulo: art?.nombre ?? h.destino,
            cantidad: -diferencia,
            nota: `la hoja dice ${dice} comprados y la aplicación tiene ${tiene}: una compra no se deshace desde una celda, va a la bandeja`,
          })
        }
        continue
      }

      if (h.campo === 'articulo.disponible') {
        const id = e.resolver(h.destino) ?? e.articulos.find((a) => norm(a.nombre) === norm(h.destino))?.id
        const art = id ? porId.get(id) : undefined
        const dice = numero(h.valor)
        if (dice === null || !art || art.saldo === undefined) continue
        const diferencia = dice - art.saldo
        if (diferencia === 0) continue
        out.push({
          hoja: p.hoja,
          fila: h.fila,
          destino: h.destino,
          tipo: 'ajuste',
          articulo: art.nombre,
          cantidad: Math.abs(diferencia),
          nota:
            diferencia > 0
              ? `la hoja dice ${dice} disponibles y el almacén tiene ${art.saldo}: manda el Excel, entran ${diferencia} como ajuste`
              : `la hoja dice ${dice} disponibles y el almacén tiene ${art.saldo}: manda el Excel, salen ${-diferencia} como ajuste`,
        })
        continue
      }

      if (h.campo === 'incidencia.material') {
        const inc = porNumero.get(norm(h.destino))
        out.push(
          ...deltasDeMaterial(
            p.hoja,
            h.fila,
            h.destino,
            String(h.valor ?? ''),
            inc?.materialApuntado ?? [],
            e.resolver,
            nombreDe,
            // La misma fecha que mira la base: la de resolución y, si no, la de
            // apertura.
            esAnterior(inc?.resuelta ?? inc?.abierta ?? null, e.arranque),
          ),
        )
      }
    }

    for (const a of p.altas) {
      if (a.tipo === 'articulo') {
        if (a.comprado !== null && a.comprado > 0) {
          out.push({
            hoja: p.hoja,
            fila: a.fila,
            destino: a.nombre,
            tipo: 'compra',
            articulo: a.nombre,
            cantidad: a.comprado,
            nota: 'al dar de alta el artículo, con lo comprado que dice la bolsa',
          })
        }
        continue
      }
      if (a.tipo === 'incidencia' && a.material) {
        out.push(
          ...deltasDeMaterial(
            p.hoja,
            a.fila,
            a.numero ?? `fila ${a.fila}`,
            a.material,
            [],
            e.resolver,
            nombreDe,
            esAnterior(a.resuelta ?? a.abierta, e.arranque),
          ),
        )
      }
    }
  }

  return out
}

/** Un parte de antes del arranque del recuento. Sin fecha, o sin arranque, no lo es. */
function esAnterior(fecha: string | null, arranque?: string): boolean {
  return arranque !== undefined && fecha !== null && fecha < arranque
}

/**
 * La diferencia entre lo que la hoja dice y lo que el parte ya tiene descontado,
 * artículo a artículo. Es la misma cuenta que hace `sync_material_del_parte`.
 * `anterior` es un parte de antes del arranque: se lee igual, y no mueve nada.
 */
function deltasDeMaterial(
  hoja: string,
  fila: number,
  destino: string,
  texto: string,
  apuntado: Array<{ articuloId: string; cantidad: number }>,
  resolver: (nombre: string) => string | null,
  nombreDe: (id: string, escrito: string) => string,
  anterior = false,
): MovimientoPrevisto[] {
  const out: MovimientoPrevisto[] = []
  const tiene = new Map<string, number>()
  for (const m of apuntado) tiene.set(m.articuloId, (tiene.get(m.articuloId) ?? 0) + m.cantidad)

  // Lo que la hoja pide, sumado por artículo: «1 cable, 1 cable» son dos.
  const pide = new Map<string, { cantidad: number; escrito: string }>()
  for (const m of leerMaterial(texto)) {
    const id = resolver(m.articulo)
    // Un 0 delante es «apuntado sin descontar»: se guarda el texto en el parte
    // y el almacén no se mueve. Se enseña para que se vea que se ha entendido.
    if (sinDescontar(m)) {
      out.push({
        hoja,
        fila,
        destino,
        tipo: 'sin_descontar',
        articulo: m.articulo,
        cantidad: 0,
        nota: 'lleva un 0 delante: se apunta en el parte y no sale del almacén (reciclado, garantía o stock antiguo)',
      })
      continue
    }
    // La base cuenta al menos una unidad por renglón, y aquí igual.
    const cantidad = Math.max(1, m.cantidad)
    if (id === null) {
      out.push({
        hoja,
        fila,
        destino,
        tipo: 'sin_articulo',
        articulo: m.articulo,
        cantidad,
        nota: 'no está en el catálogo del almacén: se guarda el texto en el parte y no se descuenta nada',
      })
      continue
    }
    const ya = pide.get(id)
    pide.set(id, { cantidad: (ya?.cantidad ?? 0) + cantidad, escrito: ya?.escrito ?? m.articulo })
  }

  if (anterior) {
    // El parte es de antes de que la aplicación llevara el almacén: lo que la
    // hoja dice se guarda en el parte y de aquí no sale ni vuelve nada, ni
    // siquiera lo que el parte tuviera descontado de otra época.
    for (const [id, { cantidad, escrito }] of pide) {
      out.push({
        hoja,
        fila,
        destino,
        tipo: 'historico',
        articulo: nombreDe(id, escrito),
        cantidad,
        nota: 'el parte es anterior al arranque del recuento: queda apuntado en el parte y no se descuenta del almacén',
      })
    }
    return out
  }

  for (const [id, { cantidad, escrito }] of pide) {
    const ya = tiene.get(id) ?? 0
    const falta = cantidad - ya
    if (falta > 0) {
      out.push({
        hoja,
        fila,
        destino,
        tipo: 'consumo',
        articulo: nombreDe(id, escrito),
        cantidad: falta,
        nota: ya > 0 ? `el parte ya tenía ${ya} descontados: salen ${falta} más` : 'sale del almacén, a nombre del parte',
      })
    } else if (falta < 0) {
      out.push({
        hoja,
        fila,
        destino,
        tipo: 'devolucion',
        articulo: nombreDe(id, escrito),
        cantidad: -falta,
        nota: `la hoja baja la cantidad a ${cantidad} y el parte tenía ${ya} descontados: vuelven ${-falta} al almacén`,
      })
    }
  }

  // Y lo que el parte tenía descontado y la hoja ya no nombra: vuelve entero.
  for (const [id, ya] of tiene) {
    if (ya <= 0 || pide.has(id)) continue
    out.push({
      hoja,
      fila,
      destino,
      tipo: 'devolucion',
      articulo: nombreDe(id, id),
      cantidad: ya,
      nota: 'la hoja ya no lo cuenta en este parte: vuelve al almacén',
    })
  }

  return out
}

function numero(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const n = Number(v.replace(',', '.'))
    return Number.isFinite(n) && v.trim() !== '' ? n : null
  }
  return null
}

function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}
