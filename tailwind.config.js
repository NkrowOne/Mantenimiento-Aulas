/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ground: token('ground'),
        surface: token('surface'),
        raised: token('raised'),
        sunken: token('sunken'),
        line: token('line'),
        'line-soft': token('line-soft'),

        ink: token('ink'),
        'ink-2': token('ink-2'),
        muted: token('muted'),

        // Cada estado va en tres piezas, y usarlas mal se nota enseguida:
        //   `accent`       la marca — texto, raíles, iconos. SOBRE el fondo.
        //   `accent-fill`  el cuerpo de una tecla.
        //   `accent-ink`   el texto DENTRO de esa tecla.
        //   `accent-tint`  el fondo de una fila entera teñida.
        // El tinte existe porque teñir con opacidad sobre fondo oscuro ensucia.
        accent: token('accent'),
        'accent-fill': token('accent-fill'),
        'accent-ink': token('accent-ink'),
        'accent-tint': token('accent-tint'),
        mark: token('mark'),

        ok: token('ok'),
        'ok-fill': token('ok-fill'),
        'ok-ink': token('ok-ink'),
        'ok-tint': token('ok-tint'),

        warn: token('warn'),
        'warn-fill': token('warn-fill'),
        'warn-ink': token('warn-ink'),
        'warn-tint': token('warn-tint'),

        crit: token('crit'),
        'crit-fill': token('crit-fill'),
        'crit-ink': token('crit-ink'),
        'crit-tint': token('crit-tint'),

        na: token('na'),
        'na-tint': token('na-tint'),
      },
      transitionTimingFunction: {
        out: 'var(--ease-out)',
        'in-out': 'var(--ease-in-out)',
        drawer: 'var(--ease-drawer)',
      },
      fontFamily: {
        sans: ['"Instrument Sans Variable"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        ctl: 'var(--r-ctl)',
        card: 'var(--r-card)',
        tag: 'var(--r-tag)',
      },
      boxShadow: {
        lift: 'var(--lift)',
      },
      spacing: {
        // Objetivo táctil: se toca con el pulgar, de pie, en un aula.
        touch: '3.5rem',
      },
    },
  },
  plugins: [],
}
