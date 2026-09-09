import { describe, expect, it } from 'vitest'
import {
  aSiNo,
  escribir,
  escribirMaterial,
  escribirMicrofono,
  esVacio,
  excelAFecha,
  fechaAExcel,
  fechaDeTexto,
  leer,
  leerMaterial,
  leerMicrofono,
  limpiar,
} from './valores'

describe('las fechas', () => {
  it('van y vuelven', () => {
    for (const iso of ['2024-06-03', '2025-06-23', '2026-01-02', '2025-12-31']) {
      expect(excelAFecha(fechaAExcel(iso)!)).toBe(iso)
    }
  })

  it('cuentan desde el 30 de diciembre de 1899, como Excel', () => {
    // El 1 de enero de 1900 es el día 1 para Excel, no el 2: se cree que 1900
    // fue bisiesto y ya no lo puede arreglar.
    expect(fechaAExcel('2025-06-23')).toBe(45831)
    expect(excelAFecha(45831)).toBe('2025-06-23')
  })

  it('un número que no puede ser una fecha se dice', () => {
    // El `3356` de la fila 167 es un número de horas de la columna de al lado.
    expect(excelAFecha(3356)).toBeNull()
    expect(leer(3356, 'fecha')).toMatchObject({ ok: false })
  })

  it('las tres fechas rotas del libro no se adivinan', () => {
    for (const rota of ['285-11-25', '19/0672025', '26/11//24']) {
      expect(fechaDeTexto(rota), rota).toBeNull()
      expect(leer(rota, 'fecha'), rota).toMatchObject({ ok: false })
    }
  })

  it('una fecha escrita a mano y sin duda sí se lee', () => {
    expect(fechaDeTexto('23/06/2025')).toBe('2025-06-23')
    expect(fechaDeTexto('3-4-25')).toBe('2025-04-03')
    expect(fechaDeTexto('2025-06-23')).toBe('2025-06-23')
  })

  it('un día que no existe no es una fecha', () => {
    expect(fechaDeTexto('31/02/2025')).toBeNull()
    expect(fechaDeTexto('45/06/2025')).toBeNull()
  })
})

describe('el vacío', () => {
  it('el espacio duro es vacío aunque no lo parezca', () => {
    expect(esVacio(' ')).toBe(true)
    expect(esVacio('   ')).toBe(true)
    expect(esVacio(null)).toBe(true)
    expect(esVacio(0)).toBe(false)
  })

  it('limpiar quita el espacio duro y colapsa el resto', () => {
    expect(limpiar('  Aula  6  ')).toBe('Aula 6')
    expect(limpiar('M70Q GEN3\t')).toBe('M70Q GEN3')
  })

  it('los asteriscos son un vacío escrito a mano, no un dato', () => {
    expect(leer('********', 'numero')).toEqual({ ok: true, valor: null })
    expect(leer('*******', 'porcentaje')).toEqual({ ok: true, valor: null })
    expect(leer('********', 'texto')).toEqual({ ok: true, valor: null })
  })
})

describe('los números', () => {
  it('un texto donde toca un número no se convierte en cero', () => {
    // Un cero es un dato: una lámpara al 0 % manda a alguien a un aula que está
    // perfectamente.
    expect(leer('No tiene', 'numero')).toMatchObject({ ok: false })
    expect(leer('', 'numero')).toEqual({ ok: true, valor: null })
  })

  it('lee el formato español y el inglés', () => {
    expect(leer('1.234,56', 'numero')).toEqual({ ok: true, valor: 1234.56 })
    expect(leer('1234.56', 'numero')).toEqual({ ok: true, valor: 1234.56 })
    expect(leer('921', 'numero')).toEqual({ ok: true, valor: 921 })
  })

  it('el porcentaje es la fracción, y un 86 suelto se pregunta', () => {
    expect(leer(0.86, 'porcentaje')).toEqual({ ok: true, valor: 0.86 })
    expect(leer(1, 'porcentaje')).toEqual({ ok: true, valor: 1 })
    expect(leer(86, 'porcentaje')).toMatchObject({ ok: false })
  })
})

describe('el sí y el no', () => {
  it('las doce grafías del libro dicen lo mismo', () => {
    for (const si of ['SÍ', 'SI', 'si', 'Si', 'sí', ' SI ']) expect(aSiNo(si), si).toBe(true)
    for (const no of ['NO', 'No', 'no', ' no ']) expect(aSiNo(no), no).toBe(false)
  })

  it('lo que no es ni una cosa ni otra se dice', () => {
    expect(aSiNo('Sennheiser')).toBeNull()
    expect(leer('Actualizada *', 'si_no')).toMatchObject({ ok: false })
  })

  it('se escribe en la grafía más repetida, y sin corregir la de nadie', () => {
    expect(escribir(true, 'si_no')).toBe('SI')
    expect(escribir(false, 'si_no')).toBe('NO')
    expect(escribir(null, 'si_no')).toBeNull()
  })
})

describe('la columna del micrófono, que son tres', () => {
  it('un sí es una capacidad', () => {
    expect(leerMicrofono('SÍ')).toEqual({ hay: true, serial: null, modelo: null })
    expect(leerMicrofono('NO')).toEqual({ hay: false, serial: null, modelo: null })
  })

  it('un número es el número de serie del aparato', () => {
    expect(leerMicrofono(294150186)).toEqual({ hay: true, serial: '294150186', modelo: null })
    expect(leerMicrofono('294150186')).toEqual({ hay: true, serial: '294150186', modelo: null })
  })

  it('un nombre sin dígitos es un modelo escrito a mano', () => {
    expect(leerMicrofono('Sennheiser')).toEqual({ hay: true, serial: null, modelo: 'Sennheiser' })
    expect(leerMicrofono('Sony Microfono')).toEqual({
      hay: true,
      serial: null,
      modelo: 'Sony Microfono',
    })
  })

  it('el espacio duro de las dos filas que lo llevan es vacío', () => {
    expect(leerMicrofono(' ')).toEqual({ hay: null, serial: null, modelo: null })
  })

  it('al escribir, la serie manda: si hay serie, hay micrófono', () => {
    expect(escribirMicrofono({ hay: true, serial: '294150186', modelo: null })).toBe('294150186')
    expect(escribirMicrofono({ hay: true, serial: null, modelo: 'Sennheiser' })).toBe('Sennheiser')
    expect(escribirMicrofono({ hay: true, serial: null, modelo: null })).toBe('SI')
    expect(escribirMicrofono({ hay: null, serial: null, modelo: null })).toBeNull()
  })
})

describe('el material consumido', () => {
  it('parte la cantidad del artículo', () => {
    expect(leerMaterial('2 Cable Hdmi 10mts Fibra')).toEqual([
      { cantidad: 2, articulo: 'Cable Hdmi 10mts Fibra', crudo: '2 Cable Hdmi 10mts Fibra' },
    ])
  })

  it('también cuando el número va pegado, que pasa 30 veces', () => {
    expect(leerMaterial('1Pantalla 240X240')).toEqual([
      { cantidad: 1, articulo: 'Pantalla 240X240', crudo: '1Pantalla 240X240' },
    ])
  })

  it('sin número es una unidad', () => {
    expect(leerMaterial('raton')).toEqual([{ cantidad: 1, articulo: 'raton', crudo: 'raton' }])
  })

  it('un renglón con dos artículos se parte en dos', () => {
    expect(leerMaterial('1 raton, 1 teclado')).toEqual([
      { cantidad: 1, articulo: 'raton', crudo: '1 raton' },
      { cantidad: 1, articulo: 'teclado', crudo: '1 teclado' },
    ])
  })

  it('no se come la medida de un artículo que empieza por número', () => {
    // `240X240` es el tamaño de la pantalla, no dos pantallas y pico.
    const m = leerMaterial('1 Proyector EB-992F             S/N X8BR4800886')
    expect(m).toHaveLength(1)
    expect(m[0]!.cantidad).toBe(1)
    expect(m[0]!.articulo).toBe('Proyector EB-992F S/N X8BR4800886')
  })

  it('un renglón vacío no es un consumo de nada', () => {
    expect(leerMaterial('')).toEqual([])
    expect(leerMaterial(' ')).toEqual([])
  })

  it('se vuelve a escribir como lo escribe la gente', () => {
    expect(
      escribirMaterial([
        { cantidad: 2, articulo: 'Cable HDMI fibra 10 m', crudo: '' },
        { cantidad: 1, articulo: 'Ratón', crudo: '' },
      ]),
    ).toBe('2 Cable HDMI fibra 10 m, 1 Ratón')
  })
})

describe('escribir hacia la celda', () => {
  it('la fecha va como número de serie, que es lo que la columna sabe pintar', () => {
    expect(escribir('2025-06-23', 'fecha')).toBe(45831)
  })

  it('el porcentaje va como fracción: la columna lleva formato 0%', () => {
    expect(escribir(0.86, 'porcentaje')).toBe(0.86)
  })

  it('null no toca la celda', () => {
    expect(escribir(null, 'texto')).toBeNull()
    expect(escribir(null, 'fecha')).toBeNull()
  })
})
