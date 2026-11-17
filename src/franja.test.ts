import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * La franja de la barra de estado, vigilada.
 *
 * iOS 26 pone un desenfoque encima de la cabecera de las aplicaciones
 * instaladas, y solo lo quita si en el borde de arriba encuentra un elemento
 * fijo, opaco y de todo el ancho — siempre el mismo (ver `.franja-de-estado`
 * en `index.css`, que es donde se cuenta entero). Eso no se puede probar aquí:
 * hace falta un iPhone. Lo que sí se puede es impedir que alguien deshaga sin
 * querer las condiciones que costó encontrar, porque ninguna se nota en un
 * navegador de escritorio: la franja mide cero y todo parece estar bien.
 *
 * Así que esto lee los ficheros tal cual y comprueba esas condiciones una a
 * una. Si una de estas pruebas falla, el arreglo de iOS está roto aunque la
 * pantalla se vea perfecta en el ordenador.
 */

const RAIZ = path.resolve(__dirname, '..')
const html = readFileSync(path.join(RAIZ, 'index.html'), 'utf8')
const css = readFileSync(path.join(RAIZ, 'src/index.css'), 'utf8')

/** Las declaraciones de la primera regla que tenga exactamente ese selector. */
function regla(fuente: string, selector: string): string {
  const escapado = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const encontrada = new RegExp(`(?:^|[\\s}])${escapado}\\s*\\{([^}]*)\\}`).exec(fuente)
  if (!encontrada) throw new Error(`No hay regla para ${selector}`)
  return encontrada[1] ?? ''
}

/** Todos los `.tsx` y `.ts` de `src`, menos las pruebas. */
function fuentes(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const ruta = path.join(dir, e.name)
    if (e.isDirectory()) return fuentes(ruta)
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [ruta] : []
  })
}

describe('la franja de la barra de estado', () => {
  it('es lo primero que hay dentro del body, fuera de React', () => {
    const cuerpo = html.slice(html.indexOf('<body>') + '<body>'.length)
    const sinComentarios = cuerpo.replace(/<!--[\s\S]*?-->/g, '').trimStart()
    expect(sinComentarios.startsWith('<div class="franja-de-estado"')).toBe(true)
    // Y antes de #root: React no la monta ni la desmonta nunca.
    expect(sinComentarios.indexOf('franja-de-estado')).toBeLessThan(sinComentarios.indexOf('id="root"'))
  })

  it.each([
    ['index.html', html],
    ['index.css', css],
  ])('en %s es fija, pegada arriba, de todo el ancho y por encima de todo', (_nombre, fuente) => {
    const r = regla(fuente, '.franja-de-estado')
    expect(r).toMatch(/position:\s*fixed/)
    expect(r).toMatch(/top:\s*0/)
    expect(r).toMatch(/left:\s*0/)
    expect(r).toMatch(/right:\s*0/)
    // El z-index más alto que existe: nada puede ponerse encima y pasar a ser
    // lo que iOS encuentra en el borde.
    expect(r).toMatch(/z-index:\s*2147483647/)
    expect(r).toMatch(/height:\s*var\(--borde-de-arriba\)/)
    // Opaca y que se pueda tocar: sin transparencia y sin `pointer-events`.
    expect(r).toMatch(/background:/)
    expect(r).not.toMatch(/pointer-events|opacity|backdrop-filter/)
  })

  it.each([
    ['index.html', html],
    ['index.css', css],
  ])('en %s tiene un suelo de más de 10 px en la aplicación instalada en iOS', (_nombre, fuente) => {
    const suelo = /@supports\s*\(-webkit-touch-callout:\s*none\)\s*\{\s*@media\s*\(display-mode:\s*standalone\)\s*\{\s*:root\s*\{\s*--borde-de-arriba:\s*max\(env\(safe-area-inset-top,\s*0px\),\s*(\d+)px\)/.exec(
      fuente,
    )
    expect(suelo).not.toBeNull()
    // WebKit descarta lo que mida 10 px o menos (`thinBorderWidth`).
    expect(Number(suelo?.[1])).toBeGreaterThan(10)
    // Y fuera de ahí, el área segura a secas: ni Android ni el navegador
    // ganan una tira de 12 px encima de la cabecera.
    expect(fuente).toMatch(/:root\s*\{\s*--borde-de-arriba:\s*env\(safe-area-inset-top,\s*0px\);?\s*\}/)
  })

  it('el body deja el mismo hueco que mide la franja', () => {
    expect(css).toMatch(/padding-top:\s*var\(--borde-de-arriba\)/)
  })

  it('nadie más mide el borde de arriba por su cuenta', () => {
    // Lo que llega hasta arriba deja el hueco con `--borde-de-arriba`. Con
    // `safe-area-inset-top` a secas quedaría debajo de la franja cuando el
    // suelo de 12 px es lo que manda.
    const culpables = fuentes(path.join(RAIZ, 'src')).filter((f) =>
      readFileSync(f, 'utf8').includes('env(safe-area-inset-top'),
    )
    expect(culpables.map((f) => path.relative(RAIZ, f))).toEqual([])
  })

  it('toda pantalla negra a pantalla completa tiñe la franja de negro', () => {
    // La franja va encima de todo: sobre un visor negro, en el tema claro,
    // sería una tira gris. `.pantalla-negra` la vuelve negra — el mismo
    // elemento con otro color, que es lo único que iOS tolera.
    expect(regla(css, 'html:has(.pantalla-negra) .franja-de-estado')).toMatch(/background:\s*#000/)
    expect(regla(html, 'html:has(.pantalla-negra) .franja-de-estado')).toMatch(/background:\s*#000/)
    const sinMarca: string[] = []
    for (const f of fuentes(path.join(RAIZ, 'src'))) {
      for (const clase of readFileSync(f, 'utf8').matchAll(/className="([^"]*)"/g)) {
        const c = clase[1] ?? ''
        if (/\bfixed\b/.test(c) && /\binset-0\b/.test(c) && /\bbg-black\b/.test(c) && !/\bpantalla-negra\b/.test(c)) {
          sinMarca.push(`${path.relative(RAIZ, f)}: ${c}`)
        }
      }
    }
    expect(sinMarca).toEqual([])
  })
})
