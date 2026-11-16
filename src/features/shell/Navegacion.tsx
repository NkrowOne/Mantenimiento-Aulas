/**
 * La navegación, en sus dos formas.
 *
 * Es la misma lista de secciones (`secciones.ts`) pintada de dos maneras según
 * el ancho de la pantalla, y solo se ve una a la vez:
 *
 *  - `BarraDePestanas`, abajo, en un teléfono o un iPad en vertical. Cuatro
 *    pestañas y «Más». Es donde está el pulgar de quien sujeta el aparato.
 *  - `MenuLateral`, a la izquierda, a partir de 1024 px: un iPad apaisado o un
 *    ordenador. Ahí sobra ancho y falta alto, así que la navegación se va al
 *    lado y enseña TODAS las secciones a la vez, agrupadas. «Más» deja de hacer
 *    falta para navegar: lo que escondía está a la vista.
 *
 * El corte está en `lg` y no en `md` a propósito. Un iPad en vertical mide 768
 * a 834 px: con un menú de 15rem al lado, a la lista de salas le quedarían
 * poco más de 500, que es menos que en algunos teléfonos grandes apaisados. En
 * vertical el iPad se sujeta con las dos manos por abajo, y ahí la barra
 * inferior es lo cómodo.
 */

import { Icono } from '@/components/Icono'
import { MARCA_FONDO, MARCA_TRAZO } from '@/design/marca'
import { PendientesEnLaBarra } from '@/features/admin/PendientesEnLaBarra'
import type { Role } from '@/domain/types'
import {
  EN_LA_BARRA,
  EN_MAS,
  GRUPOS,
  etiquetaDe,
  iconoDe,
  puedeVer,
  seccionesDe,
  type Tab,
} from './secciones'

interface PropsComunes {
  tab: Tab
  role: Role
  onTab: (tab: Tab) => void
}

/**
 * La pestaña de la barra de abajo: el dibujo encima y la palabra debajo.
 *
 * La encendida lleva una cápsula teñida detrás del dibujo. Es la convención de
 * hoy —la de Material 3— y resuelve lo que la raya superior de antes no
 * resolvía: de un vistazo, con el iPad a medio brazo, una raya de dos píxeles
 * no se ve; una mancha de color de 56 px sí. La palabra además cambia de peso,
 * para quien no distingue el color.
 */
function Pestana({
  activa,
  etiqueta,
  onClick,
  insignia,
  children,
  ...aria
}: {
  activa: boolean
  etiqueta: string
  onClick: () => void
  /**
   * Un contador sobre el dibujo. Va DESPUÉS de la etiqueta en el documento,
   * aunque se pinte arriba: así el nombre que oye quien usa VoiceOver es «Más,
   * 28 cosas por decidir» y no «28 cosas por decidir, Más».
   */
  insignia?: React.ReactNode
  children: React.ReactNode
} & React.AriaAttributes): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={activa ? 'page' : undefined}
      {...aria}
      className="group relative flex h-[3.75rem] w-full min-w-0 flex-col items-center justify-center gap-1 px-0.5"
    >
      <span
        className={`flex h-7 w-14 items-center justify-center rounded-full transition-colors duration-150 ease-out group-active:bg-raised ${
          activa ? 'bg-accent-tint text-accent' : 'text-muted'
        }`}
      >
        {children}
      </span>
      <span
        className={`max-w-full truncate text-[0.6875rem] leading-none ${
          activa ? 'font-semibold text-accent' : 'font-medium text-muted'
        }`}
      >
        {etiqueta}
      </span>
      {insignia}
    </button>
  )
}

/**
 * La barra de abajo: cuatro pestañas y «Más», para los tres roles.
 *
 * Con las siete pestañas la barra medía 468 px en un móvil de 390: «Informes»
 * salía cortada, «Datos» ni salía y nada decía que se pudiera deslizar. Las
 * cuatro de aquí son las del trabajo de pie —la ronda, las averías, el material
 * y lo hecho—; el panel y las pantallas de administración van detrás de «Más»,
 * con el tema, instalar la aplicación y cerrar sesión. Así la barra tiene la
 * misma forma en todos los aparatos y nunca se desborda: cinco columnas
 * iguales de 78 px en un móvil de 390, y la etiqueta más larga —«Incidencias»,
 * a 11 px— mide unos 60.
 */
export function BarraDePestanas({
  tab,
  role,
  onTab,
  masAbierto,
  onMas,
}: PropsComunes & { masAbierto: boolean; onMas: () => void }): React.ReactElement {
  const enLaBarra = EN_LA_BARRA.filter((t) => puedeVer(t, role))
  const abiertaEnMas = EN_MAS.some((t) => t === tab)

  return (
    <nav
      aria-label="Secciones"
      /* `solo-pantalla`: es el otro elemento fijo que se cuela en las dos hojas
         que se imprimen, y Chrome lo repite al pie de cada página. En un papel
         es una fila de palabras que no se pueden pulsar cruzada por encima del
         inventario.
         `lg:hidden`: a partir de ahí la navegación es el menú lateral. */
      className="solo-pantalla flex-none border-t border-line-soft bg-surface lg:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <ul className="mx-auto flex max-w-xl">
        {enLaBarra.map((t) => (
          <li key={t} className="min-w-0 flex-1">
            <Pestana activa={tab === t} etiqueta={etiquetaDe(t)} onClick={() => onTab(t)}>
              <Icono nombre={iconoDe(t)} />
            </Pestana>
          </li>
        ))}
        <li className="min-w-0 flex-1">
          {/* Encendida como las demás cuando la pantalla abierta es una de las
              suyas; cuál, lo dice el título de la cabecera. */}
          <Pestana
            activa={abiertaEnMas}
            etiqueta="Más"
            onClick={onMas}
            aria-haspopup="dialog"
            aria-expanded={masAbierto}
            /* El contador de Datos, sobre la pestaña por la que se llega a
               Datos. Solo a quien puede abrirla: las siete cuentas no se le
               piden a un técnico. */
            insignia={
              puedeVer('datos', role) && (
                <PendientesEnLaBarra className="absolute left-1/2 top-1.5 ml-2" />
              )
            }
          >
            <Icono nombre="mas" />
          </Pestana>
        </li>
      </ul>
    </nav>
  )
}

/** Las dos primeras iniciales de un nombre: «Ana Ruiz» → «AR». */
export function iniciales(nombre: string): string {
  const partes = nombre.trim().split(/\s+/).filter(Boolean)
  const letras = (partes[0]?.[0] ?? '') + (partes.length > 1 ? (partes.at(-1)?.[0] ?? '') : '')
  return letras.toUpperCase() || '·'
}

/**
 * El menú lateral de las pantallas anchas.
 *
 * Todas las secciones a la vista, en sus tres grupos, y abajo la cuenta. No se
 * pliega: 15rem de 1024 dejan 784 para el contenido, que es más de lo que tiene
 * un iPad en vertical entero.
 */
export function MenuLateral({
  tab,
  role,
  onTab,
  nombre,
  onCuenta,
}: PropsComunes & {
  /** El nombre de quien tiene la sesión, para la cuenta de abajo. */
  nombre: string
  /** Abre la hoja de la cuenta: tema, instalar y cerrar sesión. */
  onCuenta: () => void
}): React.ReactElement {
  return (
    <nav
      aria-label="Secciones"
      className="solo-pantalla hidden w-60 flex-none flex-col border-r border-line-soft bg-surface lg:flex"
    >
      {/* La marca: el logotipo, el mismo que hay en la pantalla de inicio del
          iPad. */}
      <div className="flex items-center gap-3 px-5 pb-4 pt-5">
        <MarcaDeLaApp />
        <div className="min-w-0 leading-tight">
          <p className="truncate font-semibold tracking-tight">Aulas</p>
          <p className="truncate text-xs text-muted">Mantenimiento</p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {GRUPOS.map((g) => {
          const secciones = seccionesDe(g.id, role)
          if (secciones.length === 0) return null
          return (
            <div key={g.id} className="mt-4 first:mt-1">
              <p className="eyebrow px-3 pb-1.5">{g.titulo}</p>
              <ul className="space-y-0.5">
                {secciones.map((t) => {
                  const activa = tab === t
                  return (
                    <li key={t}>
                      <button
                        type="button"
                        onClick={() => onTab(t)}
                        aria-current={activa ? 'page' : undefined}
                        className={`flex min-h-11 w-full items-center gap-3 rounded-ctl px-3 text-left text-[0.9375rem] transition-colors duration-100 ${
                          activa
                            ? 'bg-accent-tint font-semibold text-accent'
                            : 'font-medium text-ink-2 hover:bg-ground active:bg-raised'
                        }`}
                      >
                        <Icono nombre={iconoDe(t)} lado={20} />
                        <span className="min-w-0 flex-1 truncate">{etiquetaDe(t)}</span>
                        {t === 'datos' && <PendientesEnLaBarra className="" />}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </div>

      {/* La cuenta, abajo. El rol va a la vista por lo mismo que iba en la
          cabecera: es lo que decide qué secciones hay, y quien es administrador
          y se ve como técnico lo detecta aquí de un vistazo. */}
      <div className="border-t border-line-soft p-3">
        <button
          type="button"
          onClick={onCuenta}
          aria-haspopup="dialog"
          className="flex min-h-touch w-full items-center gap-3 rounded-ctl px-2 text-left transition-colors duration-100 hover:bg-ground active:bg-raised"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-fill text-xs font-semibold text-accent-ink">
            {iniciales(nombre)}
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-sm font-medium">{nombre || 'Tu cuenta'}</span>
            <span className="block truncate text-xs capitalize text-muted">{role}</span>
          </span>
          <Icono nombre="puntos" lado={18} className="text-muted" />
        </button>
      </div>
    </nav>
  )
}

/**
 * La marca: el logotipo de la casa, el mismo del icono de la aplicación.
 *
 * Va dibujada y no como `<img src="/favicon.svg">` porque una imagen es una
 * petición más, y esta se pinta en la cabecera de la primera pantalla. El trazo
 * vive en `design/marca.ts`.
 *
 * Es un fondo liso con un trazo encima: sin degradados ni `id`, que era lo que
 * obligaba a la marca anterior a pedir un identificador distinto por copia —se
 * pinta dos veces a la vez, en la cabecera y en el menú lateral, y una de las
 * dos está siempre oculta—.
 */
export function MarcaDeLaApp({ lado = 36 }: { lado?: number }): React.ReactElement {
  return (
    <svg
      width={lado}
      height={lado}
      viewBox="0 0 512 512"
      aria-hidden="true"
      className="shrink-0 rounded-[24%]"
    >
      <rect width="512" height="512" fill={MARCA_FONDO} />
      <path fill="#fff" d={MARCA_TRAZO} />
    </svg>
  )
}
