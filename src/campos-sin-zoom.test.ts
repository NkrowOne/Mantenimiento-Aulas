import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Ningún campo de esta aplicación por debajo de dieciséis píxeles.
 *
 * No es una preferencia tipográfica: es lo único que impide que la barra de
 * pestañas se quede flotando en mitad de la pantalla.
 *
 * Safari de iOS AMPLÍA la página al enfocar un `input`, un `textarea` o un
 * `select` cuya letra mide menos de 16px. No es el pellizco del usuario —contra
 * eso hay tres defensas puestas: `user-scalable=no` y `maximum-scale=1` en el
 * `meta`, el `touch-action` de `index.css` y los `preventDefault` de `gesture*`
 * en `main.tsx`—; lo hace el navegador por su cuenta y ninguna de las tres lo
 * toca.
 *
 * Y ampliada, la aplicación se rompe por un sitio que no parece tener nada que
 * ver. En WebKit un elemento `fixed` no se pega al viewport visual sino al de
 * MAQUETACIÓN, que a escala 1 son el mismo y a partir de ahí no: basta con
 * bajar del todo y volver a subir un poco para que el borde inferior del de
 * maquetación quede varado en mitad de la pantalla, y ahí es donde se pinta el
 * `bottom: 0` de la barra. Sale una fila de pestañas flotando en medio con
 * contenido por encima y por debajo, y la cabecera pegada a un borde que ya no
 * se ve. El zoom aguanta hasta que alguien lo deshace a mano, así que el
 * síntoma sobrevive al cambio de pantalla y parece cualquier cosa menos lo que
 * es.
 *
 * `index.css` sube todos los campos con `font-size: max(16px, 1em)`, pero esa
 * regla vive en `@layer base` y una utilidad de Tailwind le gana siempre: un
 * `text-sm` en el `className` de un `select` la anula sin decir nada. Así se
 * rompió la primera vez, con cuarenta campos; y así volvió a romperse con dos
 * desplegables nuevos en la pantalla de dudas.
 *
 * De ahí esta prueba y no una nota en una guía. El fallo no se ve al escribir
 * el campo —en un ordenador no pasa nada— ni al revisar el código, y para
 * cuando se ve son dos capturas y media hora buscando en el sitio equivocado.
 */

const CAMPOS = /<(input|textarea|select)\b((?:[^<>]|\{[^{}]*\})*?)\/?>/gs
const CLASE = /className=(?:"([^"]*)"|\{`([^`]*)`\})/
/** `text-xs` y `text-sm` son 12 y 14 píxeles: los dos disparan el zoom. */
const LETRA_PEQUENA = /\btext-(xs|sm)\b/

function fuentes(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const ruta = join(dir, e.name)
    if (e.isDirectory()) out.push(...fuentes(ruta))
    else if (e.name.endsWith('.tsx')) out.push(ruta)
  }
  return out
}

describe('ningún campo dispara el zoom de iOS', () => {
  it('input, textarea y select van a 16px o más', () => {
    const culpables: string[] = []

    for (const ruta of fuentes('src')) {
      const codigo = readFileSync(ruta, 'utf8')
      for (const m of codigo.matchAll(CAMPOS)) {
        const clase = CLASE.exec(m[2] ?? '')
        const texto = clase?.[1] ?? clase?.[2] ?? ''
        const pequena = LETRA_PEQUENA.exec(texto)
        if (!pequena) continue
        const linea = codigo.slice(0, m.index).split('\n').length
        culpables.push(`${ruta}:${linea} <${m[1]}> lleva ${pequena[0]}`)
      }
    }

    // El mensaje dice qué hacer, porque quien se lo encuentre no tiene por qué
    // saber que un `text-sm` en un desplegable mueve la barra de pestañas.
    expect(
      culpables,
      `Estos campos amplían la página al tocarlos en el iPhone, y con la página ampliada la barra de pestañas se queda flotando en mitad de la pantalla. Súbelos a text-base:\n  ${culpables.join('\n  ')}`,
    ).toEqual([])
  })

  /*
   * Y la red de abajo sigue puesta. Es la que cubre los campos sin `className`
   * y los que llegan de una librería, que esta prueba no puede ver.
   */
  it('index.css conserva el suelo de 16px para los campos sin clase', () => {
    const css = readFileSync('src/index.css', 'utf8')
    expect(css).toMatch(/input,\s*\n\s*textarea,\s*\n\s*select\s*\{\s*\n\s*font-size:\s*max\(16px, 1em\);/)
  })
})
