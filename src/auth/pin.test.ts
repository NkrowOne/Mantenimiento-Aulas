import { describe, expect, it } from 'vitest'
import {
  deriveVaultKeys,
  newVaultSalt,
  openSession,
  sealSession,
  unwrapSecret,
  validatePin,
  wrapSecret,
} from './pin'

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

/**
 * La bóveda: el mismo PIN, en otro dispositivo.
 *
 * Las iteraciones se bajan a mil en las pruebas. Las de verdad son 310.000 y
 * cada derivación tarda del orden de un tercio de segundo: con doce pruebas
 * serían diez segundos de espera por cada `npm test`, y una prueba lenta acaba
 * siendo una prueba que no se ejecuta. Lo que se comprueba aquí es la forma del
 * mecanismo, no su coste.
 */
describe('bóveda del PIN', () => {
  const params = { salt: newVaultSalt(), iteraciones: 1000 }

  it('el mismo PIN y el mismo salt dan siempre el mismo verificador', async () => {
    // Es lo que permite que el servidor guarde su hash y lo compare desde otro
    // dispositivo. Sin determinismo no hay vinculación posible.
    const a = await deriveVaultKeys('482913', params)
    const b = await deriveVaultKeys('482913', params)
    expect(a.verificador).toBe(b.verificador)
  })

  it('un PIN distinto da un verificador distinto', async () => {
    const a = await deriveVaultKeys('482913', params)
    const b = await deriveVaultKeys('482914', params)
    expect(a.verificador).not.toBe(b.verificador)
  })

  it('el mismo PIN con otro salt no comparte nada', async () => {
    // Es lo que hace que cambiar el PIN —que estrena salt— invalide de verdad el
    // verificador anterior, y no solo lo reetiquete.
    const a = await deriveVaultKeys('482913', params)
    const b = await deriveVaultKeys('482913', { salt: newVaultSalt(), iteraciones: 1000 })
    expect(a.verificador).not.toBe(b.verificador)
  })

  it('el sobre se abre con el mismo PIN', async () => {
    const claves = await deriveVaultKeys('482913', params)
    const sobre = await wrapSecret(claves.envoltorio, 'contraseña-larga-de-la-cuenta')

    const otroDispositivo = await deriveVaultKeys('482913', params)
    expect(await unwrapSecret(otroDispositivo.envoltorio, sobre)).toBe(
      'contraseña-larga-de-la-cuenta',
    )
  })

  it('con el PIN equivocado el sobre no se abre: devuelve null, no basura', async () => {
    // AES-GCM está autenticado, así que descifrar con otra clave falla en vez de
    // producir bytes plausibles. Es lo que permite tratarlo como «no era».
    const claves = await deriveVaultKeys('482913', params)
    const sobre = await wrapSecret(claves.envoltorio, 'contraseña')

    const malo = await deriveVaultKeys('999999', params)
    expect(await unwrapSecret(malo.envoltorio, sobre)).toBeNull()
  })

  it('el verificador que viaja no sirve para abrir el sobre', async () => {
    /*
     * La propiedad que sostiene el diseño entero.
     *
     * El verificador va al servidor y su hash se guarda ahí. Si de él se pudiera
     * derivar la clave del envoltorio, quien leyera la tabla —o interceptara una
     * vinculación— tendría la contraseña de la cuenta. Salen los dos de la misma
     * clave maestra pero por HKDF con etiquetas distintas, así que son
     * independientes: aquí se comprueba lo mínimo comprobable, que no son el
     * mismo material.
     */
    const claves = await deriveVaultKeys('482913', params)
    const sobre = await wrapSecret(claves.envoltorio, 'contraseña')

    const desdeElVerificador = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(atob(claves.verificador), (c) => c.charCodeAt(0)),
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    )
    expect(await unwrapSecret(desdeElVerificador, sobre)).toBeNull()
  })

  it('cada sobre estrena vector de inicialización', async () => {
    const claves = await deriveVaultKeys('482913', params)
    const a = await wrapSecret(claves.envoltorio, 'contraseña')
    const b = await wrapSecret(claves.envoltorio, 'contraseña')
    expect(a.iv).not.toBe(b.iv)
    expect(a.secreto).not.toBe(b.secreto)
  })

  it('no deja la contraseña legible en lo que se guarda en el servidor', async () => {
    const claves = await deriveVaultKeys('482913', params)
    const sobre = await wrapSecret(claves.envoltorio, 'contraseña-en-claro')
    expect(JSON.stringify(sobre)).not.toContain('contraseña-en-claro')
  })
})
