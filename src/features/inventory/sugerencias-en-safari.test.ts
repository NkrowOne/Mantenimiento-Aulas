import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Las sugerencias de marca, modelo y nombre se pueden tocar en un iPhone.
 *
 * Llevaban `preventDefault` en `pointerdown` para no perder el foco del campo.
 * En Chrome funciona; en Safari ese `preventDefault` anula el toque entero: no
 * llega el `click`, y tocar una sugerencia no hacía nada. Se comprobó con
 * WebKit de verdad, y el fallo solo se ve en el motor de los iPhone y los iPad,
 * que es justo donde se usa esto — así que se vigila en el fuente, porque
 * ninguna prueba de Node lo puede reproducir.
 */
const fuente = readFileSync(path.resolve(__dirname, 'RoomInventory.tsx'), 'utf8')
const campo = fuente.slice(fuente.indexOf('function CampoSugerido('))

describe('las sugerencias del formulario del equipo, en Safari', () => {
  it('no cancelan el pointerdown: en Safari eso se come el click', () => {
    expect(campo).not.toMatch(/onPointerDown=\{\(e\) => e\.preventDefault\(\)\}/)
  })

  it('evitan el blur desde mousedown, que no anula el toque', () => {
    expect(campo).toContain('onMouseDown={(e) => e.preventDefault()}')
  })

  it('y el blur de tocar una sugerencia no pliega la lista bajo el dedo', () => {
    expect(campo).toContain('if (eligiendo.current) return')
    expect(campo).toContain('eligiendo.current = true')
  })
})
