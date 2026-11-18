import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * El `<main>` del marco, vigilado.
 *
 * Lo que desplaza en la aplicación es el `<main>` de `components/Marco.tsx`, y
 * el documento de detrás no debe medir ni un píxel más que la pantalla. Lo
 * rompe cualquier cosa `position: absolute` de dentro que no encuentre un
 * antepasado posicionado: cuelga del documento, no se recorta en el `<main>` y
 * lo estira por detrás. El caso de libro es `sr-only`, que hay por toda la
 * aplicación. Con el documento estirado, iOS o un `focus()` lo desplazan y la
 * barra de pestañas se queda a media pantalla.
 *
 * En un navegador de escritorio no se nota —nadie desplaza un documento con
 * `overflow: hidden`—, así que esto lee el fichero y comprueba que el `<main>`
 * sigue siendo el bloque contenedor de lo suyo.
 */

const marco = readFileSync(path.resolve(__dirname, 'components/Marco.tsx'), 'utf8')

describe('el <main> del marco', () => {
  it('es `relative`: lo `absolute` de dentro se recorta y se desplaza con él', () => {
    const main = /<main[^>]*className="([^"]*)"/.exec(marco)
    expect(main).not.toBeNull()
    const clases = (main?.[1] ?? '').split(/\s+/)
    expect(clases).toContain('marco-contenido')
    expect(clases).toContain('overflow-y-auto')
    expect(clases).toContain('relative')
  })
})
