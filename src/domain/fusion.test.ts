import { describe, expect, it } from 'vitest'
import {
  canonizar,
  canonizarFila,
  decidirFila,
  fusionarCelda,
  iguales,
  resumir,
} from './fusion'
import type { Celda, Decision } from './fusion'

function celda(p: Partial<Celda>): Celda {
  return { base: null, excel: null, dueno: 'ambos', ...p }
}

describe('la tabla de decisión del apartado 4', () => {
  it('nadie la tocó: no se hace nada', () => {
    const r = fusionarCelda(celda({ base: 'EPSON', excel: 'EPSON', antepasado: 'EPSON' }))
    expect(r.tipo).toBe('sin_cambios')
  })

  it('solo cambió en la app: se escribe el Excel', () => {
    const r = fusionarCelda(celda({ base: 'EPSON X2', excel: 'EPSON', antepasado: 'EPSON' }))
    expect(r).toMatchObject({ tipo: 'hacia_el_excel', valor: 'EPSON X2' })
  })

  it('solo cambió en el Excel: entra en la base, que es lo que se pidió', () => {
    const r = fusionarCelda(celda({ base: 'EPSON', excel: 'EPSON X2', antepasado: 'EPSON' }))
    expect(r).toMatchObject({ tipo: 'hacia_la_base', valor: 'EPSON X2' })
  })

  it('cambiaron los dos a cosas distintas: cuarentena, y no se toca ninguno', () => {
    const r = fusionarCelda(celda({ base: 'EPSON X2', excel: 'BENQ', antepasado: 'EPSON' }))
    expect(r.tipo).toBe('conflicto')
    if (r.tipo === 'conflicto') {
      expect(r.base).toBe('EPSON X2')
      expect(r.excel).toBe('BENQ')
    }
  })

  it('cambiaron los dos a lo mismo: no hay nada que escribir', () => {
    const r = fusionarCelda(celda({ base: 'BENQ', excel: 'BENQ', antepasado: 'EPSON' }))
    expect(r.tipo).toBe('ya_coinciden')
  })
})

describe('un hueco no es un desacuerdo', () => {
  it('la base no tenía el número de serie: entra el del Excel', () => {
    const r = fusionarCelda(celda({ base: null, excel: 'X4KM9900123', antepasado: null }))
    expect(r).toMatchObject({ tipo: 'hacia_la_base', valor: 'X4KM9900123' })
  })

  it('la app nunca escribe un vacío encima de una celda con dato', () => {
    // Escribir `''` borra la celda con su formato y su fórmula. Que la base no
    // tenga el dato no es motivo para perderlo en la hoja.
    const r = fusionarCelda(celda({ base: '', excel: 'X4KM9900123', antepasado: 'X4KM9900123' }))
    expect(r).toMatchObject({ tipo: 'hacia_la_base' })
  })

  it('la celda estaba vacía y la app sí sabe: se rellena', () => {
    const r = fusionarCelda(celda({ base: 'BENQ', excel: '   ', antepasado: '' }))
    expect(r).toMatchObject({ tipo: 'hacia_el_excel', valor: 'BENQ' })
  })
})

describe('cada columna tiene dueño, y se decide antes de mirar los valores', () => {
  it('los m² vienen de Espacios: manda el Excel aunque la base diga otra cosa', () => {
    const r = fusionarCelda(
      celda({ base: 50, excel: 62.5, antepasado: 50, dueno: 'solo_excel' }),
    )
    expect(r).toMatchObject({ tipo: 'hacia_la_base', valor: 62.5 })
  })

  it('quién revisó es de la app: lo que alguien teclee ahí se devuelve a su sitio', () => {
    const r = fusionarCelda(
      celda({ base: 'Ana', excel: 'lo hice yo', antepasado: 'Ana', dueno: 'solo_app' }),
    )
    expect(r).toMatchObject({ tipo: 'hacia_el_excel', valor: 'Ana' })
  })

  it('el stock disponible es una fórmula: no se escribe, se marca el descuadre', () => {
    const r = fusionarCelda(celda({ base: 7, excel: 9, antepasado: 7, dueno: 'formula' }))
    expect(r).toMatchObject({ tipo: 'descuadre', base: 7, excel: 9 })
  })

  it('una fórmula que cuadra no genera trabajo', () => {
    const r = fusionarCelda(celda({ base: 7, excel: 7, dueno: 'formula' }))
    expect(r.tipo).toBe('sin_cambios')
  })
})

describe('las medidas fechadas las gana la lectura más reciente', () => {
  it('la del aula de hoy gana a la tecleada la semana pasada', () => {
    const r = fusionarCelda(
      celda({
        base: 4200,
        excel: 3900,
        antepasado: 3800,
        dueno: 'medida',
        medidaBase: '2026-08-20T09:00:00Z',
        medidaExcel: '2026-08-13T09:00:00Z',
      }),
    )
    expect(r).toMatchObject({ tipo: 'hacia_el_excel', valor: 4200, motivo: 'medición más reciente' })
  })

  it('y al revés, sin que el orden de las pasadas decida', () => {
    const r = fusionarCelda(
      celda({
        base: 3900,
        excel: 4200,
        antepasado: 3800,
        dueno: 'medida',
        medidaBase: '2026-08-13T09:00:00Z',
        medidaExcel: '2026-08-20T09:00:00Z',
      }),
    )
    expect(r).toMatchObject({ tipo: 'hacia_la_base', valor: 4200 })
  })

  it('sin fechas que comparar, una medida es una celda más: conflicto', () => {
    const r = fusionarCelda(
      celda({ base: 4200, excel: 3900, antepasado: 3800, dueno: 'medida' }),
    )
    expect(r.tipo).toBe('conflicto')
  })
})

describe('la primera pasada no puede parar la sincronización', () => {
  it('sin instantánea previa manda la app, y lo dice', () => {
    const r = fusionarCelda(celda({ base: 'EPSON X2', excel: 'BENQ' }))
    expect(r).toMatchObject({ tipo: 'hacia_el_excel', valor: 'EPSON X2' })
    if (r.tipo === 'hacia_el_excel') expect(r.motivo).toContain('primera pasada')
  })

  it('pero lo que es del Excel sigue siendo del Excel', () => {
    const r = fusionarCelda(celda({ base: 50, excel: 62.5, dueno: 'solo_excel' }))
    expect(r).toMatchObject({ tipo: 'hacia_la_base', valor: 62.5 })
  })

  it('un antepasado `null` no es lo mismo que no tener antepasado', () => {
    // `null` significa «la última vez estaba vacía», y eso sí permite decidir:
    // solo cambió el Excel.
    const r = fusionarCelda(celda({ base: null, excel: 'BENQ', antepasado: null }))
    expect(r).toMatchObject({ tipo: 'hacia_la_base', valor: 'BENQ' })
  })
})

describe('la forma de teclear no decide', () => {
  it('`12,50` de la hoja y `12.5` de la base son la misma medición', () => {
    expect(iguales('12,50', 12.5)).toBe(true)
  })

  it('vacío es vacío se escriba como se escriba', () => {
    expect(iguales(null, '   ')).toBe(true)
    expect(iguales('', null)).toBe(true)
  })

  it('un espacio de más no es un cambio', () => {
    expect(iguales(' EPSON  EB-2250U ', 'Epson EB-2250U')).toBe(true)
  })

  it('pero `0012` y `12` son dos números de serie distintos', () => {
    expect(iguales('0012', 12)).toBe(false)
    expect(canonizar('0012')).toBe('0012')
  })
})

describe('la fila, antes que la celda', () => {
  it('una fila sin `Ref` es un alta hecha desde el Excel', () => {
    expect(decidirFila({ ref: null }).tipo).toBe('alta_desde_el_excel')
    expect(decidirFila({ ref: '  ' }).tipo).toBe('alta_desde_el_excel')
  })

  it('una fila que desaparece del libro se archiva, nunca se borra', () => {
    const r = decidirFila({ ref: 'SALA-000087', presenteEnElExcel: false })
    expect(r.tipo).toBe('desaparecida_del_excel')
    if (r.tipo === 'desaparecida_del_excel') expect(r.motivo).toContain('no se borra')
  })

  it('una matrícula que la base no conoce va a cuarentena, no se inventa una sala', () => {
    const r = decidirFila({ ref: 'SALA-999999', presenteEnLaBase: false })
    expect(r.tipo).toBe('ref_desconocida')
    if (r.tipo === 'ref_desconocida') expect(r.motivo).toContain('SALA-999999')
  })

  it('lo normal es fusionar', () => {
    expect(decidirFila({ ref: 'SALA-000087' }).tipo).toBe('fusionar')
  })
})

describe('la idempotencia por hash', () => {
  it('el orden de las columnas no cambia la huella', () => {
    const a = canonizarFila({ Ref: 'SALA-000087', Serie: 'X1', m2: 62.5 })
    const b = canonizarFila({ m2: '62,50', Ref: 'SALA-000087', Serie: 'X1' })
    expect(a).toBe(b)
  })

  it('un dato distinto sí cambia la huella', () => {
    const a = canonizarFila({ Ref: 'SALA-000087', Serie: 'X1' })
    const b = canonizarFila({ Ref: 'SALA-000087', Serie: 'X2' })
    expect(a).not.toBe(b)
  })

  it('una columna vacía y una columna ausente no se confunden con otro valor', () => {
    expect(canonizarFila({ Serie: null })).toBe(canonizarFila({ Serie: '   ' }))
  })
})

describe('el parte de la pasada', () => {
  it('cuenta cada montón por separado', () => {
    const decisiones: Decision[] = [
      { tipo: 'sin_cambios' },
      { tipo: 'sin_cambios' },
      { tipo: 'ya_coinciden' },
      { tipo: 'hacia_la_base', valor: 'X', motivo: '' },
      { tipo: 'hacia_el_excel', valor: 'Y', motivo: '' },
      { tipo: 'conflicto', motivo: '', base: 'A', excel: 'B', antepasado: 'C' },
      { tipo: 'descuadre', base: 7, excel: 9 },
    ]
    expect(resumir(decisiones)).toEqual({
      total: 7,
      sinCambios: 2,
      yaCoinciden: 1,
      haciaLaBase: 1,
      haciaElExcel: 1,
      conflictos: 1,
      descuadres: 1,
    })
  })
})
