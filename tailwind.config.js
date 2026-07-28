/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ground: token('ground'),
        surface: token('surface'),
        sunken: token('sunken'),
        line: token('line'),
        'line-soft': token('line-soft'),

        ink: token('ink'),
        'ink-2': token('ink-2'),
        muted: token('muted'),

        accent: token('accent'),
        mark: token('mark'),
        'accent-tint': token('accent-tint'),
        'accent-ink': token('accent-ink'),

        // Los estados traen su tinte: teñir una fila entera con un color sólido
        // suave sale mejor que con opacidad, que sobre fondo oscuro se ensucia.
        ok: token('ok'),
        'ok-tint': token('ok-tint'),
        warn: token('warn'),
        'warn-tint': token('warn-tint'),
        crit: token('crit'),
        'crit-tint': token('crit-tint'),
        na: token('na'),
        'na-tint': token('na-tint'),
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
