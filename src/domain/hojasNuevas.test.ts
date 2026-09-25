import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  hojaDeInventario,
  hojaDeLeeme,
  hojaDeMovimientos,
  hojaDeRevisiones,
  hojaDeUnidades,
  hojaDelParte,
} from './hojasNuevas'
import type { EquipoParaHoja, HojaNueva, MovimientoParaHoja, RevisionParaHoja } from './hojasNuevas'
import { PCS_2026 } from './mapa'
import { escribirLibro } from './libro'
import { leerEstilos } from './estilos'
import { abrirLibro, leerHoja } from './xlsx'
import type { Libro } from './xlsx'
import { excelAFecha } from './valores'

const LIBRO = process.env.LIBRO_XLSX
const bytes = LIBRO ? readFileSync(LIBRO) : null

// TODO-COORDINADOR: puente de tipos mientras `libro.ts` no exporte el `HojaNueva`
// y el `Acabado` del contrato. Cuando lo haga, quitar el puente y llamar a
// `escribirLibro` directamente con las mismas cuatro cosas.
const escribir = escribirLibro as unknown as (
  libro: Libro,
  ediciones: never[],
  hojasNuevas: HojaNueva[],
  acabado?: { rehacer?: HojaNueva[] },
) => Promise<Uint8Array>

function revision(over: Partial<RevisionParaHoja> = {}): RevisionParaHoja {
  return {
    shortRef: 'SALA-000001',
    edificio: 'EDIFICIO P',
    zona: 'PLANTA BAJA',
    sala: '0.1P',
    cuando: '2025-06-23T09:35:00.000Z',
    quien: 'Ana Pérez',
    estado: 'completa',
    resultado: 'ok',
    horasProyector: 921,
    lampara: 0.73,
    comprobaciones: 'altavoces: ok · cámara: ok',
    incidenciasAbiertas: 0,
    notas: null,
    ...over,
  }
}

function movimiento(over: Partial<MovimientoParaHoja> = {}): MovimientoParaHoja {
  return {
    cuando: '2026-01-02',
    articulo: 'Cable HDMI fibra 10 m',
    cantidad: -1,
    tipo: 'consumo',
    incidencia: 'I260102_0002',
    claseDeParte: 'incidencia',
    sala: '0.1 BC',
    quien: 'Ana Pérez',
    nota: null,
    ...over,
  }
}

function equipo(over: Partial<EquipoParaHoja> = {}): EquipoParaHoja {
  return {
    shortRef: 'SALA-000001',
    edificio: 'EDIFICIO P',
    zona: 'PLANTA BAJA',
    sala: '0.1P',
    tipo: 'Proyector',
    nombreEnLaApp: null,
    modelo: 'NP-M403 HG',
    serial: '0340985RL',
    estado: 'instalado',
    desde: '2024-01-15',
    etiqueta: null,
    ...over,
  }
}

/** La columna de una hoja por el texto de su cabecera, para no contar letras. */
function col(h: HojaNueva, cabecera: string): number {
  const i = h.filas[0]!.indexOf(cabecera)
  if (i < 0) throw new Error(`La hoja «${h.nombre}» no tiene la columna «${cabecera}»`)
  return i
}

describe('la hoja de revisiones', () => {
  it('lleva la matrícula, que es lo que la hace cruzable', () => {
    const h = hojaDeRevisiones([revision()])
    expect(h.filas[0]![0]).toBe('Ref')
    expect(h.filas[1]![0]).toBe('SALA-000001')
  })

  it('las cabeceras son las del contrato', () => {
    const h = hojaDeRevisiones([])
    expect(h.filas[0]).toEqual([
      'Ref',
      'Edificio',
      'Planta/Módulo',
      'Aula',
      'Fecha',
      'Hora',
      'Quién revisó',
      'Estado',
      'Resultado',
      'Horas proyector',
      '% Lámparas',
      'Comprobaciones',
      'Incidencias abiertas',
      'Observaciones',
    ])
    expect(h.caracter).toBe('app')
  })

  it('la fecha y la hora van en columnas separadas', () => {
    const h = hojaDeRevisiones([revision()])
    // Con las dos juntas, filtrar «las del martes» deja de funcionar.
    expect(excelAFecha(h.filas[1]![col(h, 'Fecha')] as number)).toBe('2025-06-23')
    expect(h.filas[1]![col(h, 'Hora')]).toMatch(/^\d{2}:\d{2}$/)
    // El estado y el resultado salen como palabras, no como claves de programa.
    expect(h.filas[1]![col(h, 'Estado')]).toBe('Completa')
    expect(h.filas[1]![col(h, 'Resultado')]).toBe('Sin incidencias')
  })

  it('una revisión sin hora no se inventa una', () => {
    const h = hojaDeRevisiones([revision({ cuando: '2025-06-23' })])
    expect(h.filas[1]![col(h, 'Hora')]).toBeNull()
  })

  it('salen de la más antigua a la más reciente', () => {
    // Como las hojas que la gente lleva a mano: lo último, al final.
    const h = hojaDeRevisiones([
      revision({ cuando: '2026-01-01T10:00:00.000Z', sala: 'nueva' }),
      revision({ cuando: '2024-01-01T10:00:00.000Z', sala: 'vieja' }),
      revision({ cuando: '2025-01-01T10:00:00.000Z', sala: 'media' }),
    ])
    expect(h.filas.slice(1).map((f) => f[col(h, 'Aula')])).toEqual(['vieja', 'media', 'nueva'])
  })

  it('cada columna declara su formato: fecha, porcentaje, enteros y texto ajustado', () => {
    const h = hojaDeRevisiones([revision()])
    expect(h.formatos![col(h, 'Fecha')]).toBe('fecha')
    expect(h.formatos![col(h, '% Lámparas')]).toBe('porcentaje')
    expect(h.formatos![col(h, 'Horas proyector')]).toBe('entero')
    expect(h.formatos![col(h, 'Incidencias abiertas')]).toBe('entero')
    expect(h.formatos![col(h, 'Comprobaciones')]).toBe('textoAjustado')
    expect(h.formatos![col(h, 'Observaciones')]).toBe('textoAjustado')
  })

  it('se tiñe por fila según cómo salió: rojo con incidencias, verde sin ellas, gris sin terminar', () => {
    const h = hojaDeRevisiones([
      revision({ cuando: '2025-01-01', resultado: 'con_incidencias' }),
      revision({ cuando: '2025-01-02', resultado: 'ok' }),
      revision({ cuando: '2025-01-03', estado: 'borrador', resultado: null }),
      revision({ cuando: '2025-01-04', resultado: null }),
    ])
    expect(h.tintes).toEqual(['critico', 'ok', 'apagado', undefined])
    // Un tinte por fila de datos, ni uno más.
    expect(h.tintes).toHaveLength(h.filas.length - 1)
  })
})

describe('la hoja de movimientos', () => {
  it('las cabeceras son las del contrato', () => {
    const h = hojaDeMovimientos([])
    expect(h.filas[0]).toEqual([
      'Fecha',
      'Artículo',
      'Movimiento',
      'Entrada',
      'Salida',
      'Saldo',
      'Incidencia',
      'Solicitud',
      'Aula',
      'Quién',
      'Nota',
    ])
    expect(h.formatos![col(h, 'Fecha')]).toBe('fecha')
    expect(h.formatos![col(h, 'Saldo')]).toBe('entero')
  })

  it('parte la cantidad en entrada y salida', () => {
    const h = hojaDeMovimientos([movimiento({ cantidad: -2 }), movimiento({ cantidad: 5, tipo: 'compra' })])
    const compra = h.filas.find((f) => f[2] === 'Compra')!
    const consumo = h.filas.find((f) => f[2] === 'Consumo')!
    expect(compra[col(h, 'Entrada')]).toBe(5)
    expect(compra[col(h, 'Salida')]).toBeNull()
    expect(consumo[col(h, 'Entrada')]).toBeNull()
    expect(consumo[col(h, 'Salida')]).toBe(2)
  })

  it('lleva el saldo detrás, que es la pregunta que se hace la gente', () => {
    const h = hojaDeMovimientos([
      movimiento({ cuando: '2026-01-01', cantidad: 10, tipo: 'compra' }),
      movimiento({ cuando: '2026-02-01', cantidad: -3 }),
      movimiento({ cuando: '2026-03-01', cantidad: -2 }),
    ])
    expect(h.filas.slice(1).map((f) => f[col(h, 'Saldo')])).toEqual([10, 7, 5])
  })

  it('el saldo se lleva por artículo, no por la hoja entera', () => {
    const h = hojaDeMovimientos([
      movimiento({ articulo: 'A', cantidad: 10, tipo: 'compra' }),
      movimiento({ articulo: 'B', cantidad: 4, tipo: 'compra' }),
    ])
    expect(h.filas.slice(1).map((f) => f[col(h, 'Saldo')])).toEqual([10, 4])
  })

  it('salen de la más antigua a la más reciente, y el saldo de cada artículo sigue bien entrelazado', () => {
    const h = hojaDeMovimientos([
      movimiento({ cuando: '2026-01-04', articulo: 'B', cantidad: -1 }),
      movimiento({ cuando: '2026-01-01', articulo: 'A', cantidad: 10, tipo: 'compra' }),
      movimiento({ cuando: '2026-01-03', articulo: 'A', cantidad: -3 }),
      movimiento({ cuando: '2026-01-02', articulo: 'B', cantidad: 4, tipo: 'compra' }),
    ])
    const filas = h.filas.slice(1)
    expect(filas.map((f) => excelAFecha(f[col(h, 'Fecha')] as number))).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
    ])
    expect(filas.map((f) => `${f[col(h, 'Artículo')]}=${f[col(h, 'Saldo')]}`)).toEqual(['A=10', 'B=4', 'A=7', 'B=3'])
  })

  it('a igual fecha va por artículo, y a igual artículo en el orden en que llegaron', () => {
    const h = hojaDeMovimientos([
      movimiento({ cuando: '2026-01-01', articulo: 'Ratón', cantidad: -1, nota: 'primero' }),
      movimiento({ cuando: '2026-01-01', articulo: 'Altavoces', cantidad: -1 }),
      movimiento({ cuando: '2026-01-01', articulo: 'Ratón', cantidad: -1, nota: 'segundo' }),
    ])
    const filas = h.filas.slice(1)
    expect(filas.map((f) => f[col(h, 'Artículo')])).toEqual(['Altavoces', 'Ratón', 'Ratón'])
    expect(filas.slice(1).map((f) => f[col(h, 'Nota')])).toEqual(['primero', 'segundo'])
    expect(filas.slice(1).map((f) => f[col(h, 'Saldo')])).toEqual([-1, -2])
  })

  it('la incidencia y la solicitud van en columnas separadas', () => {
    const h = hojaDeMovimientos([
      movimiento({ cuando: '2026-01-01', incidencia: 'I260101_0001', claseDeParte: 'incidencia' }),
      movimiento({ cuando: '2026-01-02', incidencia: 'S260102_0001', claseDeParte: 'solicitud' }),
      movimiento({ cuando: '2026-01-03', incidencia: null, claseDeParte: null }),
    ])
    const filas = h.filas.slice(1)
    expect(filas.map((f) => f[col(h, 'Incidencia')])).toEqual(['I260101_0001', null, null])
    expect(filas.map((f) => f[col(h, 'Solicitud')])).toEqual([null, 'S260102_0001', null])
  })

  it('los movimientos se llaman como los llama la gente', () => {
    const h = hojaDeMovimientos([movimiento({ tipo: 'devolucion' })])
    expect(h.filas[1]![col(h, 'Movimiento')]).toBe('Devolución')
  })

  it('un tipo que no conoce se enseña tal cual, no en blanco', () => {
    const h = hojaDeMovimientos([movimiento({ tipo: 'inventado' })])
    expect(h.filas[1]![col(h, 'Movimiento')]).toBe('inventado')
  })

  it('se tiñe por fila: la compra en verde, la devolución y el ajuste en ámbar, el consumo sin nada', () => {
    const h = hojaDeMovimientos([
      movimiento({ cuando: '2026-01-01', tipo: 'compra', cantidad: 3 }),
      movimiento({ cuando: '2026-01-02', tipo: 'consumo' }),
      movimiento({ cuando: '2026-01-03', tipo: 'devolucion', cantidad: 1 }),
      movimiento({ cuando: '2026-01-04', tipo: 'ajuste', cantidad: 1 }),
    ])
    expect(h.tintes).toEqual(['ok', undefined, 'aviso', 'aviso'])
  })
})

describe('la hoja de inventario', () => {
  it('las cabeceras son las del contrato', () => {
    const h = hojaDeInventario([])
    expect(h.filas[0]).toEqual([
      'Ref',
      'Edificio',
      'Planta/Módulo',
      'Aula',
      'Tipo de equipo',
      'Nombre en la app',
      'Modelo',
      'N.º de serie',
      'Estado',
      'Desde',
      'Etiqueta',
    ])
    expect(h.formatos![col(h, 'Desde')]).toBe('fecha')
  })

  it('saca las dos filas de un aula con dos proyectores', () => {
    const h = hojaDeInventario([
      equipo({ serial: 'UNO' }),
      equipo({ serial: 'DOS', desde: '2025-01-01' }),
    ])
    expect(h.filas).toHaveLength(3)
    expect(h.filas.slice(1).map((f) => f[col(h, 'N.º de serie')]).sort()).toEqual(['DOS', 'UNO'])
  })

  it('ordena por edificio, planta, aula (numérica) y tipo', () => {
    const h = hojaDeInventario([
      equipo({ edificio: 'B', zona: 'PLANTA 1', sala: '1.10' }),
      equipo({ edificio: 'A', zona: 'PLANTA 1', sala: '1.2', tipo: 'TV' }),
      equipo({ edificio: 'A', zona: 'PLANTA 1', sala: '1.2', tipo: 'Proyector' }),
      equipo({ edificio: 'A', zona: 'PLANTA 1', sala: '1.10' }),
      equipo({ edificio: 'A', zona: 'PLANTA BAJA', sala: '0.5' }),
    ])
    expect(h.filas.slice(1).map((f) => `${f[1]} ${f[2]} ${f[3]} ${f[4]}`)).toEqual([
      'A PLANTA 1 1.2 Proyector',
      'A PLANTA 1 1.2 TV',
      'A PLANTA 1 1.10 Proyector',
      'A PLANTA BAJA 0.5 Proyector',
      'B PLANTA 1 1.10 Proyector',
    ])
  })

  it('«Nombre en la app» solo se rellena cuando la aplicación lo llama de otra forma', () => {
    const h = hojaDeInventario([
      equipo({ serial: 'TINY', tipo: 'Ordenador', nombreEnLaApp: 'Ordenador Tiny' }),
      equipo({ serial: 'IGUAL', tipo: 'Proyector', nombreEnLaApp: null }),
      // Si llega repetido, tampoco se enseña: la columna es para la diferencia.
      equipo({ serial: 'REPETIDO', tipo: 'TV', nombreEnLaApp: 'TV' }),
    ])
    const porSerie = new Map(h.filas.slice(1).map((f) => [f[col(h, 'N.º de serie')], f[col(h, 'Nombre en la app')]]))
    expect(porSerie.get('TINY')).toBe('Ordenador Tiny')
    expect(porSerie.get('IGUAL')).toBeNull()
    expect(porSerie.get('REPETIDO')).toBeNull()
  })

  it('lo que no está instalado sale apagado', () => {
    const h = hojaDeInventario([
      equipo({ sala: '0.1', estado: 'instalado' }),
      equipo({ sala: '0.2', estado: 'retirado' }),
    ])
    expect(h.tintes).toEqual([undefined, 'apagado'])
  })
})

describe('la hoja de PCs estrenada desde la aplicación', () => {
  it('es de la gente: editable, con la columna «Situación» al final', () => {
    const h = hojaDeUnidades(PCS_2026, [])
    expect(h.caracter).toBe('editable')
    expect(h.filas[0]!.at(-1)).toBe('Situación')
  })
})

describe('el parte de la pasada', () => {
  it('cuando todo cuadra lo dice, no sale en blanco', () => {
    const h = hojaDelParte([], '30/08/2026 10:15')
    expect(h.filas[1]![2]).toBe('Todo cuadra')
    expect(h.autofiltro).toBe(false)
  })

  it('lista lo que quedó pendiente con su celda', () => {
    const h = hojaDelParte(
      [{ hoja: 'Estado', celda: 'F87', que: 'Cuarentena', detalle: '«No tiene» no es un número' }],
      '30/08/2026 10:15',
    )
    expect(h.filas).toHaveLength(3)
    expect(h.filas[2]).toEqual(['Estado', 'F87', 'Cuarentena', '«No tiene» no es un número'])
  })

  it('es una hoja discreta, y se tiñe según lo que haya que mirar primero', () => {
    const linea = (que: string) => ({ hoja: 'Estado', celda: 'A1', que, detalle: '' })
    const h = hojaDelParte(
      [
        linea('Choque'),
        linea('Pendiente de decidir'),
        linea('No se puede leer'),
        linea('Sin cruzar'),
        linea('Aviso'),
      ],
      '30/08/2026 10:15',
    )
    expect(h.caracter).toBe('discreta')
    expect(h.tintes).toEqual(['apagado', 'critico', 'critico', 'aviso', 'aviso', undefined])
    expect(h.tintes).toHaveLength(h.filas.length - 1)
  })
})

describe('el Léeme', () => {
  const h = hojaDeLeeme({ cuando: '25/09/2026 10:15', anyo: 2026 })

  it('es una hoja discreta de dos columnas, sin tabla ni filtro, con el título en la primera fila', () => {
    expect(h.caracter).toBe('discreta')
    expect(h.tabla).toBe(false)
    expect(h.autofiltro).toBe(false)
    expect(h.inmovilizar).toBe(false)
    expect(h.anchos).toEqual([34, 110])
    expect(h.estilos!.A1).toBe('titulo')
    expect(h.filas[0]![0]).toMatch(/cómo usar este libro/)
    for (const f of h.filas) expect(f).toHaveLength(2)
  })

  it('cada entrada lleva etiqueta y texto, con su estilo y su alto', () => {
    for (const [i, f] of h.filas.entries()) {
      if (i === 0 || f[1] === null) continue
      const fila = i + 1
      expect(h.estilos![`A${fila}`], `A${fila}`).toBe('etiqueta')
      expect(h.estilos![`B${fila}`], `B${fila}`).toBe('textoSinBorde')
      expect(h.altos![fila], `alto de ${fila}`).toBeGreaterThanOrEqual(15)
      // Un texto largo necesita más de una línea.
      if (String(f[1]).length > 110) expect(h.altos![fila]).toBeGreaterThan(15)
    }
  })

  it('cuenta lo que hay que saber de cada hoja y de lo nuevo', () => {
    const texto = h.filas.map((f) => f.join(' ')).join('\n')
    for (const esperado of [
      'Estado Aulas y Salas de reunion',
      'Material Instalado 2026',
      'Bolsa 2026',
      'PCs STOCK 2026',
      'Material Instalado 2025 y Bolsa 2025',
      'Revisiones',
      'Movimientos de Almacén',
      'Inventario por Sala',
      'Sincronización',
      'Orden de pestañas',
      'Colores de cabecera',
      'Hacer el libro de hoy',
      '«Incidencia»',
      '«Solicitud»',
      'de la más antigua a la más reciente',
      'tablas de Excel',
      '1 de agosto de 2026',
    ]) {
      expect(texto, esperado).toContain(esperado)
    }
    expect(h.filas.at(-1)![1]).toBe('Generado por la aplicación el 25/09/2026 10:15; se rehace en cada sincronización.')
  })

  it('habla del año que se le pide, no de uno fijo', () => {
    const otro = hojaDeLeeme({ cuando: 'hoy', anyo: 2027 })
    const texto = otro.filas.map((f) => f.join(' ')).join('\n')
    expect(texto).toContain('Material Instalado 2027')
    expect(texto).toContain('Material Instalado 2026 y Bolsa 2026')
  })
})

describe.skipIf(!bytes)('dentro del libro real', () => {
  it('las hojas de la app se rehacen (o se añaden) y se vuelven a leer', async () => {
    const libro = await abrirLibro(new Uint8Array(bytes!))
    const hojas = [
      hojaDeRevisiones([revision()]),
      hojaDeMovimientos([movimiento()]),
      hojaDeInventario([equipo()]),
      hojaDelParte([], '30/08/2026 10:15'),
      hojaDeLeeme({ cuando: '30/08/2026 10:15', anyo: 2026 }),
    ]
    // El libro real ya trae estas hojas de una pasada anterior: se rehacen. En
    // un libro que no las tuviera, se añadirían. Las dos cosas las hace `rehacer`.
    const salida = await escribir(libro, [], [], { rehacer: hojas })

    const otra = await abrirLibro(salida)
    const nombres = otra.hojas.map((h) => h.nombre)
    // Las hojas que ya había siguen en su orden (las rehechas no se mueven de
    // sitio y las que faltaban se añaden detrás)…
    expect(nombres.slice(0, libro.hojas.length)).toEqual(libro.hojas.map((h) => h.nombre))
    // …y las de la app están, una sola vez cada una.
    for (const h of hojas) expect(nombres.filter((n) => n === h.nombre), h.nombre).toHaveLength(1)

    const rev = await leerHoja(otra, 'Revisiones')
    expect(rev[0]!.celdas.A).toBe('Ref')
    expect(rev[1]!.celdas.A).toBe('SALA-000001')
    expect(excelAFecha(rev[1]!.celdas.E as number)).toBe('2025-06-23')
    expect(rev).toHaveLength(2)

    const mov = await leerHoja(otra, 'Movimientos de Almacén')
    expect(mov[0]!.celdas.G).toBe('Incidencia')
    expect(mov[0]!.celdas.H).toBe('Solicitud')
    expect(mov[1]!.celdas.G).toBe('I260102_0002')
  })

  it('las fechas se escriben con un estilo que pinta fecha', async () => {
    const libro = await abrirLibro(new Uint8Array(bytes!))
    const salida = await escribir(libro, [], [], { rehacer: [hojaDeRevisiones([revision()])] })
    const otra = await abrirLibro(salida)

    // Si el estilo de la celda de fecha no pinta fecha, se vería `45831`.
    const { descomprimir } = await import('../lib/zip')
    const nueva = otra.entradas.find(
      (e) => e.nombre === otra.hojas.find((h) => h.nombre === 'Revisiones')!.ruta,
    )!
    const xmlNueva = new TextDecoder().decode(await descomprimir(nueva))
    const estilosXml = new TextDecoder().decode(
      await descomprimir(otra.entradas.find((e) => e.nombre === 'xl/styles.xml')!),
    )
    const s = /<c\b[^>]*\br="E2"[^>]*\bs="(\d+)"/.exec(xmlNueva)?.[1]
    expect(s).toBeTruthy()
    expect(leerEstilos(estilosXml).formatoDe(Number(s))).toBe('fecha')
  })
})
