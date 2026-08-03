import { describe, expect, it } from 'vitest'
import { crearLlaves, openSession, sealSession, validatePin } from './pin'

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
    const llaves = await crearLlaves('4829')
    const sealed = await sealSession(llaves, session, hint)
    expect(await openSession('4829', sealed)).toEqual(session)
  })

  it('devuelve null con el PIN equivocado, sin producir basura', async () => {
    const llaves = await crearLlaves('4829')
    const sealed = await sealSession(llaves, session, hint)
    expect(await openSession('4830', sealed)).toBeNull()
  })

  it('no deja el token legible en lo que se guarda en el dispositivo', async () => {
    const llaves = await crearLlaves('4829')
    const sealed = await sealSession(llaves, session, hint)
    expect(JSON.stringify(sealed)).not.toContain('rt-secreto')
    expect(JSON.stringify(sealed)).not.toContain('at-secreto')
  })

  it('resella con la llave pública, sin el PIN — y el PIN sigue abriendo', async () => {
    // Es la propiedad por la que existen las llaves: la renovación del token
    // ocurre cuando el PIN ya no está en memoria, y aun así el sobre tiene que
    // poder ponerse al día. Un sobre que no se resella guarda un refresh token
    // que el servidor ya revocó, y ese sobre es un dispositivo muerto.
    const llaves = await crearLlaves('4829')
    const primera = await sealSession(llaves, session, hint)
    const renovada = { access_token: 'at-2', refresh_token: 'rt-2' }
    const segunda = await sealSession(primera.llaves!, renovada, primera.hint)
    expect(await openSession('4829', segunda)).toEqual(renovada)
  })

  it('cada sellado es distinto aunque el contenido sea el mismo', async () => {
    const llaves = await crearLlaves('4829')
    const a = await sealSession(llaves, session, hint)
    const b = await sealSession(llaves, session, hint)
    expect(a.eph).not.toBe(b.eph)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it('sigue abriendo los sobres antiguos, cifrados directos con el PIN', async () => {
    // Un dispositivo dado de alta antes de este cambio guarda el formato viejo,
    // y tiene que poder desbloquear para migrar. Se reconstruye aquí el sellado
    // v1 tal cual lo hacía el código anterior.
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const material = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('4829'),
      'PBKDF2',
      false,
      ['deriveKey'],
    )
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 310_000, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    )
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(JSON.stringify(session)),
    )
    const aBase64 = (buf: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(buf)))
    const viejo = {
      salt: aBase64(salt.buffer),
      iv: aBase64(iv.buffer),
      ciphertext: aBase64(ciphertext),
      hint,
    }

    expect(await openSession('4829', viejo)).toEqual(session)
    expect(await openSession('4830', viejo)).toBeNull()
  })

  it('conserva la pista para saludar antes de pedir el PIN', async () => {
    const llaves = await crearLlaves('4829')
    const sealed = await sealSession(llaves, session, hint)
    expect(sealed.hint.fullName).toBe('Técnico')
  })
})
