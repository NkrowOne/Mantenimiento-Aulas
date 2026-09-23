/**
 * El código de alta es una llave. Estas pruebas cuidan las dos cosas que lo
 * hacen utilizable sin dejar de serlo: que no se pueda confundir al dictarlo, y
 * que el cupo se cuente como lo cuenta el canje.
 *
 * La segunda es la que ha costado disgustos. `/alta/canjear` rechaza por cupo
 * ANTES de mirar el código, así que contarlo distinto aquí produce un código
 * con su caducidad y su pinta de bueno que no hay forma de usar — y nadie sabe
 * por qué.
 */
import { describe, expect, it } from 'vitest'

import { cuantosAparatos, generateCode, hashCode, type Dispositivo } from './codigos'

const aparato = (user_agent: string | null, id = user_agent ?? 'x'): Dispositivo => ({
  id,
  label: null,
  user_agent,
  enrolled_at: null,
  last_seen_at: null,
})

describe('el código que se dicta en voz alta', () => {
  it('no lleva ningún carácter que se confunda al oírlo o al copiarlo', () => {
    // O/0, I/1/l y S/5 fuera: cada uno de ellos es una llamada al administrador.
    for (let i = 0; i < 200; i++) {
      expect(generateCode()).toMatch(/^[ABCDEFGHJKMNPQRTUVWXYZ2346789]{4}(-[ABCDEFGHJKMNPQRTUVWXYZ2346789]{4}){2}$/)
    }
  })

  it('no se repite', () => {
    // 29^12 ≈ 58 bits. Doscientos seguidos iguales sería un generador roto.
    const vistos = new Set(Array.from({ length: 200 }, () => generateCode()))
    expect(vistos.size).toBe(200)
  })

  it('y lo que se guarda es su huella, no él', () => {
    const c = generateCode()
    const h = hashCode(c)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).not.toContain(c)
    expect(hashCode(c)).toBe(h)
  })
})

describe('contar aparatos, que no es contar filas', () => {
  it('varios navegadores del mismo iPhone son UN aparato', () => {
    /*
     * En iOS, Safari, la PWA instalada y los demás navegadores comparten
     * user-agent. Contarlos por separado gastaría el cupo entero —tres— en un
     * solo teléfono, y el técnico se quedaría sin poder dar de alta el iPad.
     */
    const mismo = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'
    expect(cuantosAparatos([aparato(mismo, 'a'), aparato(mismo, 'b'), aparato(mismo, 'c')])).toBe(1)
  })

  it('y dos aparatos distintos son dos', () => {
    expect(cuantosAparatos([aparato('iPhone'), aparato('iPad')])).toBe(2)
  })

  it('los que no dicen quiénes son cuentan como uno solo', () => {
    // Nulo es «no lo sé», y todos los «no lo sé» son el mismo cubo para el
    // canje: aquí se cuenta igual que allí o el número no sirve de nada.
    expect(cuantosAparatos([aparato(null, 'a'), aparato(null, 'b')])).toBe(1)
  })

  it('sin dispositivos, cero', () => {
    expect(cuantosAparatos([])).toBe(0)
  })
})
