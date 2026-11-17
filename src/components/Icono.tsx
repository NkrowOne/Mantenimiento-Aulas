/**
 * Los iconos de la aplicación.
 *
 * Hasta el rediseño no había ninguno: la navegación eran cinco palabras en fila,
 * y de pie en un aula, con el iPad en una mano, una palabra hay que LEERLA y un
 * dibujo se reconoce. La barra de abajo con icono y etiqueta es hoy lo que
 * cualquiera espera de una aplicación de móvil, y la etiqueta se queda —un
 * icono solo obliga a aprenderse el dibujo—.
 *
 * Van dibujados aquí, en línea, y no desde una librería:
 *
 *  - Son treinta y pocos. Una librería de iconos trae mil quinientos, y aunque
 *    el empaquetador quite los que no se usan, es una dependencia más que
 *    auditar y actualizar por unos trazos.
 *  - En línea heredan `currentColor`, así que un icono cambia de color con su
 *    texto —la pestaña encendida, el botón deshabilitado— sin una regla aparte.
 *  - No hay petición de red ni fuente de iconos que pueda no haber llegado:
 *    salen pintados en el mismo fotograma que el texto, también sin cobertura.
 *
 * Todos comparten rejilla (24×24), grosor (1.75) y remates redondos. Es lo que
 * hace que se lean como una familia aunque cada uno sea un dibujo distinto.
 */

const TRAZOS = {
  // Navegación principal.
  inicio: (
    <>
      <path d="M4 11.5 12 4.5l8 7" />
      <path d="M6 10v8.5a1 1 0 0 0 1 1h3.25v-5.5h3.5v5.5H17a1 1 0 0 0 1-1V10" />
    </>
  ),
  revisar: (
    <>
      <rect x="5" y="4.5" width="14" height="16" rx="2.5" />
      <path d="M9 4.5v-.25A1.25 1.25 0 0 1 10.25 3h3.5A1.25 1.25 0 0 1 15 4.25v.25" />
      <path d="m9 13 2.25 2.25L15.5 11" />
    </>
  ),
  incidencias: (
    <>
      <path d="M12 4 21 19.5H3L12 4Z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.25v.01" />
    </>
  ),
  almacen: (
    <>
      <path d="M3.5 8 12 3.5 20.5 8v8L12 20.5 3.5 16V8Z" />
      <path d="M3.5 8 12 12.5 20.5 8" />
      <path d="M12 12.5v8" />
    </>
  ),
  historial: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  mas: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.75" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.75" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.75" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.75" />
    </>
  ),
  panel: (
    <>
      <path d="M4 20h16" />
      <path d="M7 16.5v-5" />
      <path d="M12 16.5v-10" />
      <path d="M17 16.5V9.5" />
    </>
  ),
  equipos: (
    <>
      <rect x="3.5" y="4.5" width="17" height="11.5" rx="2" />
      <path d="M9 20h6" />
      <path d="M12 16v4" />
    </>
  ),
  actividad: <path d="M3 12.5h4l2.5-7 5 13 2.5-6H21" />,
  informes: (
    <>
      <path d="M13.5 3.5H8A2.5 2.5 0 0 0 5.5 6v12A2.5 2.5 0 0 0 8 20.5h8a2.5 2.5 0 0 0 2.5-2.5V8.5l-5-5Z" />
      <path d="M13.5 3.5v5h5" />
      <path d="M9 13h6" />
      <path d="M9 16.5h4" />
    </>
  ),
  datos: (
    <>
      <ellipse cx="12" cy="6.5" rx="7.5" ry="3" />
      <path d="M4.5 6.5v5.5c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V6.5" />
      <path d="M4.5 12v5.5c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V12" />
    </>
  ),

  // Acciones.
  qr: (
    <>
      <path d="M4 8V6a2 2 0 0 1 2-2h2" />
      <path d="M16 4h2a2 2 0 0 1 2 2v2" />
      <path d="M20 16v2a2 2 0 0 1-2 2h-2" />
      <path d="M8 20H6a2 2 0 0 1-2-2v-2" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </>
  ),
  buscar: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  anadir: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  atras: (
    <>
      <path d="M19 12H5" />
      <path d="m11 6-6 6 6 6" />
    </>
  ),
  derecha: <path d="m9 5.5 6.5 6.5L9 18.5" />,
  abajo: <path d="m5.5 9 6.5 6.5L18.5 9" />,
  cerrar: (
    <>
      <path d="M6 6 18 18" />
      <path d="M18 6 6 18" />
    </>
  ),
  hecho: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  puntos: (
    <>
      <path d="M12 5.5v.01" />
      <path d="M12 12v.01" />
      <path d="M12 18.5v.01" />
    </>
  ),
  imprimir: (
    <>
      <path d="M7 8.5V4h10v4.5" />
      <rect x="3.5" y="8.5" width="17" height="8" rx="2" />
      <path d="M7 14h10v6H7v-6Z" />
    </>
  ),
  etiqueta: (
    <>
      <path d="M3.5 5.5a2 2 0 0 1 2-2h5.2a2 2 0 0 1 1.4.6l7.8 7.8a2 2 0 0 1 0 2.8l-5.2 5.2a2 2 0 0 1-2.8 0L4.1 12.1a2 2 0 0 1-.6-1.4V5.5Z" />
      <path d="M8 8v.01" />
    </>
  ),
  lista: (
    <>
      <path d="M9 6.5h11" />
      <path d="M9 12h11" />
      <path d="M9 17.5h11" />
      <path d="M4.5 6.5v.01" />
      <path d="M4.5 12v.01" />
      <path d="M4.5 17.5v.01" />
    </>
  ),
  camara: (
    <>
      <path d="M4 8.5a2 2 0 0 1 2-2h1.6l1.2-1.8a1 1 0 0 1 .8-.45h4.8a1 1 0 0 1 .8.45l1.2 1.8H18a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8.5Z" />
      <circle cx="12" cy="12.75" r="3.25" />
    </>
  ),
  edificio: (
    <>
      <path d="M5 20.5V5.5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v15" />
      <path d="M3 20.5h18" />
      <path d="M9.5 8h1" />
      <path d="M13.5 8h1" />
      <path d="M9.5 12h1" />
      <path d="M13.5 12h1" />
      <path d="M10.5 20.5V17h3v3.5" />
    </>
  ),

  // Cuenta y aparato.
  instalar: (
    <>
      <path d="M12 4v11" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M5 19.5h14" />
    </>
  ),
  salir: (
    <>
      <path d="M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14" />
      <path d="M10 8l-4 4 4 4" />
      <path d="M6 12h9" />
    </>
  ),
  sol: (
    <>
      <circle cx="12" cy="12" r="3.75" />
      <path d="M12 3v2" />
      <path d="M12 19v2" />
      <path d="M3 12h2" />
      <path d="M19 12h2" />
      <path d="m5.6 5.6 1.4 1.4" />
      <path d="m17 17 1.4 1.4" />
      <path d="m5.6 18.4 1.4-1.4" />
      <path d="m17 7 1.4-1.4" />
    </>
  ),
  luna: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />,
  persona: (
    <>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.8 20c.4-3.7 3.4-6 7.2-6s6.8 2.3 7.2 6" />
    </>
  ),
  aparato: (
    <>
      <rect x="6.5" y="3" width="11" height="18" rx="2.5" />
      <path d="M11 17.5h2" />
    </>
  ),
} as const

export type NombreDeIcono = keyof typeof TRAZOS

interface Props {
  nombre: NombreDeIcono
  /** Lado en píxeles. 22 es el de la navegación; 18–20, junto a un texto. */
  lado?: number
  className?: string
}

/**
 * Decorativo siempre: va con `aria-hidden` porque todos los sitios donde se
 * pinta llevan además su texto o su `aria-label`. Un icono que fuera lo único
 * que dice qué hace un botón sería un fallo del botón, no algo que arreglar
 * aquí.
 */
export function Icono({ nombre, lado = 22, className }: Props): React.ReactElement {
  return (
    <svg
      width={lado}
      height={lado}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 ${className ?? ''}`}
    >
      {TRAZOS[nombre]}
    </svg>
  )
}
