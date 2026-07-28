import { describe, expect, it } from 'vitest'
import { openSession, sealSession, validatePin } from './pin'

// Estas pruebas defienden la promesa central del diseño: un iPad perdido no da
// acceso, y el desbloqueo funciona sin cobertura.

describe('validatePin', () => {
  it('acepta un PIN razonable de 4 a 8 dígitos', () => {
    expect(validatePin('4829').ok).toBe(true)
    expect(validatePin('81047263').ok).toBe(true)
  })

  it('rechaza los PIN que un atacante probaría primero', () => {
    expect(validatePin('0000').ok).toBe(false)
    expect(validatePin('1234').ok).toBe(false)
    expect(validatePin('4321').ok).toBe(false)
  })

  it('exige la longitud acordada', () => {
    expect(validatePin('123').ok).toBe(false)
    expect(validatePin('123456789').ok).toBe(false)
  })

  it('no admite letras', () => {
    expect(validatePin('12a4').ok).toBe(false)
  })
})

describe('sellado de sesión', () => {
  const hint = { email: 'tecnico@test.local', fullName: 'Técnico' }
  const session = { access_token: 'at-secreto', refresh_token: 'rt-secreto' }

  it('devuelve la sesión con el PIN correcto', async () => {
    const sealed = await sealSession('4829', session, hint)
    expect(await openSession('4829', sealed)).toEqual(session)
  })

  it('devuelve null con el PIN equivocado, sin producir basura', async () => {
    const sealed = await sealSession('4829', session, hint)
    expect(await openSession('4830', sealed)).toBeNull()
  })

  it('no deja el token legible en lo que se guarda en el dispositivo', async () => {
    const sealed = await sealSession('4829', session, hint)
    expect(JSON.stringify(sealed)).not.toContain('rt-secreto')
    expect(JSON.stringify(sealed)).not.toContain('at-secreto')
  })

  it('usa sal distinta cada vez, así que dos sellados no se parecen', async () => {
    const a = await sealSession('4829', session, hint)
    const b = await sealSession('4829', session, hint)
    expect(a.salt).not.toBe(b.salt)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it('conserva la pista para saludar antes de pedir el PIN', async () => {
    const sealed = await sealSession('4829', session, hint)
    expect(sealed.hint.fullName).toBe('Técnico')
  })
})
