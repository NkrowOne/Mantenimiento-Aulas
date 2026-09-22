import { describe, it, expect } from 'vitest'
import { salaQueSePuedeCrear, canonicalPlanta } from './altaDeSala'

describe('el aula que el libro puede crear sola', () => {
  it('crea la del código del campus con la planta que dice el libro', () => {
    const r = salaQueSePuedeCrear('2.6', 'PLANTA 2', 'S')
    expect(r).toEqual({ code: '2.6', zona: '2ª PLANTA', plantaDeducida: false })
  })

  it('acepta el sufijo del edificio, y lo quita del código', () => {
    // `0.1P` es la 0.1 del edificio P: el sufijo es el edificio, no el nombre.
    expect(salaQueSePuedeCrear('0.1P', 'PLANTA BAJA', 'P')).toEqual({
      code: '0.1',
      zona: 'PLANTA BAJA',
      plantaDeducida: false,
    })
    expect(salaQueSePuedeCrear('2.6 S', 'PLANTA 2', 'S')).toEqual({
      code: '2.6',
      zona: '2ª PLANTA',
      plantaDeducida: false,
    })
  })

  it('pero un sufijo que contradice al edificio de la fila no se crea', () => {
    // El código dice H y la columna dice S: una de las dos miente, y crear
    // cualquiera de las dos es crear la sala equivocada la mitad de las veces.
    expect(salaQueSePuedeCrear('2.6 H', 'PLANTA 2', 'S')).toBeNull()
  })

  it('deduce la planta del código cuando el libro no la trae', () => {
    expect(salaQueSePuedeCrear('2.6', '', 'S')).toEqual({
      code: '2.6',
      zona: '2ª PLANTA',
      plantaDeducida: true,
    })
    expect(salaQueSePuedeCrear('0.7', '', 'S')).toEqual({
      code: '0.7',
      zona: 'PLANTA BAJA',
      plantaDeducida: true,
    })
    expect(salaQueSePuedeCrear('-1.3', '', 'S')).toEqual({
      code: '-1.3',
      zona: 'PLANTA -1',
      plantaDeducida: true,
    })
  })

  it('la planta del libro manda sobre la del código', () => {
    /*
     * Es la regla que salva al CRAI y al Edificio Central: allí `1.1-` vive en
     * la `PLANTA -1` y `2.6` en el `MÓDULO 2`. Deducir la planta del número
     * repartiría esas aulas por plantas que no existen.
     */
    const r = salaQueSePuedeCrear('2.6', 'MÓDULO 2', 'C')
    expect(r).toEqual({ code: '2.6', zona: 'MÓDULO 2', plantaDeducida: false })
  })

  it('un nombre descriptivo nunca se crea solo', () => {
    // Ahí una errata es invisible: nadie puede mirar «Sala Vip» y decir si
    // falta o si es la que ya existe escrita de otra forma.
    for (const nombre of [
      'Aula Demo',
      'Sala Vip',
      'Laboratorio 9',
      'Punto suspensivos 1',
      'SALA ONDA CORTA',
      'Agora 1',
      '5.4 (Lab 3D)',
      'Lab 5 -1.4',
    ]) {
      expect(salaQueSePuedeCrear(nombre, 'PLANTA 1', 'S'), nombre).toBeNull()
    }
  })

  it('y un número largo tampoco: un serial mal pegado no es un aula', () => {
    expect(salaQueSePuedeCrear('1.2345', 'PLANTA 1', 'S')).toBeNull()
    expect(salaQueSePuedeCrear('123.4', 'PLANTA 1', 'S')).toBeNull()
    expect(salaQueSePuedeCrear('', 'PLANTA 1', 'S')).toBeNull()
  })

  it('sin planta en el libro y con un número que no es una planta, se pregunta', () => {
    // `MÓDULO 5` existe, pero `5ª PLANTA` no la tiene ningún edificio: deducir
    // aquí inventaría una planta entera.
    expect(salaQueSePuedeCrear('12.1', '', 'C')).toBeNull()
  })
})

describe('el nombre de planta del maestro', () => {
  it('traduce lo que escribe el libro', () => {
    expect(canonicalPlanta('PLANTA 1')).toBe('1ª PLANTA')
    expect(canonicalPlanta('PLANTA 2')).toBe('2ª PLANTA')
    expect(canonicalPlanta('Planta 2')).toBe('2ª PLANTA')
    expect(canonicalPlanta('PLANTA 0')).toBe('PLANTA BAJA')
    expect(canonicalPlanta('PLANTA BAJA')).toBe('PLANTA BAJA')
    expect(canonicalPlanta('PLANTA -1')).toBe('PLANTA -1')
    expect(canonicalPlanta('2º PLANTA')).toBe('2ª PLANTA')
  })

  it('y deja en paz lo que es un nombre propio', () => {
    // Traducirlos sería inventarse una planta que nadie ha pedido.
    expect(canonicalPlanta('MÓDULO 3')).toBe('MÓDULO 3')
    expect(canonicalPlanta('AULAS MSI')).toBe('AULAS MSI')
    expect(canonicalPlanta('LABORATORIO H')).toBe('LABORATORIO H')
    expect(canonicalPlanta('POLIVALENTES')).toBe('POLIVALENTES')
    expect(canonicalPlanta('')).toBe('SIN ZONA')
  })

  it('lo que ya está en la forma del maestro no cambia', () => {
    for (const z of ['1ª PLANTA', '2ª PLANTA', 'PLANTA BAJA', 'PLANTA -1', 'PLANTA -2']) {
      expect(canonicalPlanta(z), z).toBe(z)
    }
  })
})
