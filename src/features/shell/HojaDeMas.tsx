/**
 * La hoja de «Más»: las secciones que no caben en la barra, y la cuenta.
 *
 * Antes era una lista de teclas seguidas —Panel, Equipos, Actividad, Informes,
 * Datos, Instalar, Cerrar sesión— todas con el mismo peso. Dos problemas: había
 * que leerlas todas para encontrar una, y «Cerrar sesión» era una tecla idéntica
 * a «Datos», una debajo de la otra.
 *
 * Ahora va en tres bloques que se distinguen sin leer:
 *
 *  1. Las secciones, agrupadas como en el menú lateral, cada una con su dibujo.
 *     La que está abierta va marcada.
 *  2. Este aparato: el tema y, si se puede, instalar.
 *  3. Cerrar sesión, sola, abajo y en el color de lo que no se deshace a la
 *     ligera.
 *
 * En una pantalla ancha las secciones ya están a la vista en el menú lateral,
 * así que la misma hoja se abre desde la cuenta y enseña solo los bloques 2 y 3
 * (`soloCuenta`).
 */

import { HojaDeAcciones } from '@/components/HojaDeAcciones'
import { Icono, type NombreDeIcono } from '@/components/Icono'
import { PendientesEnLaBarra } from '@/features/admin/PendientesEnLaBarra'
import type { Role } from '@/domain/types'
import { ponerTema, useTema, type Tema } from '@/lib/tema'
import { iniciales } from './Navegacion'
import {
  EN_MAS,
  GRUPOS,
  QUE_HAY_EN,
  etiquetaDe,
  iconoDe,
  seccionesDe,
  type Tab,
} from './secciones'

interface Props {
  tab: Tab
  role: Role
  nombre: string
  email: string
  /** Abierta desde la cuenta del menú lateral: sin las secciones. */
  soloCuenta: boolean
  instalable: boolean
  onTab: (tab: Tab) => void
  onInstalar: () => void
  onSalir: () => void
  onCerrar: () => void
}

const TEMAS: Array<{ id: Tema; etiqueta: string; icono: NombreDeIcono }> = [
  { id: 'sistema', etiqueta: 'Automático', icono: 'aparato' },
  { id: 'claro', etiqueta: 'Claro', icono: 'sol' },
  { id: 'oscuro', etiqueta: 'Oscuro', icono: 'luna' },
]

export function HojaDeMas({
  tab,
  role,
  nombre,
  email,
  soloCuenta,
  instalable,
  onTab,
  onInstalar,
  onSalir,
  onCerrar,
}: Props): React.ReactElement {
  const tema = useTema()

  return (
    <HojaDeAcciones
      titulo={soloCuenta ? 'Tu cuenta' : 'Más'}
      acciones={[]}
      etiquetaDeCierre="Cerrar"
      onCerrar={onCerrar}
    >
      {/* Quién ha entrado y con qué rol. El rol decide qué secciones existen,
          así que esconderlo convierte «no tengo el botón» en un misterio. */}
      <div className="mt-2 flex items-center gap-3 rounded-card bg-ground p-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-fill text-sm font-semibold text-accent-ink">
          {iniciales(nombre)}
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate font-medium">{nombre || 'Sesión abierta'}</span>
          <span className="block truncate text-sm text-muted">{email}</span>
        </span>
        <span className="chip chip-accent capitalize">{role}</span>
      </div>

      {!soloCuenta &&
        GRUPOS.map((g) => {
          // Solo las que NO están en la barra: las otras ya tienen su pestaña
          // a un dedo de distancia, justo debajo de esta hoja.
          const secciones = seccionesDe(g.id, role).filter((t) => EN_MAS.includes(t))
          if (secciones.length === 0) return null
          return (
            <section key={g.id} className="mt-4">
              <h2 className="eyebrow px-1 pb-1.5">{g.titulo}</h2>
              <ul className="overflow-hidden rounded-card border border-line-soft">
                {secciones.map((t) => {
                  const abierta = t === tab
                  return (
                    <li key={t} className="border-b border-line-soft last:border-b-0">
                      <button
                        type="button"
                        onClick={() => onTab(t)}
                        aria-current={abierta ? 'page' : undefined}
                        className={`fila flex min-h-touch w-full items-center gap-3 px-3 py-2.5 text-left ${
                          abierta ? 'bg-accent-tint' : ''
                        }`}
                      >
                        <span
                          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] ${
                            abierta ? 'bg-accent-fill text-accent-ink' : 'bg-accent-tint text-accent'
                          }`}
                        >
                          <Icono nombre={iconoDe(t)} lado={20} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 font-medium">
                            {etiquetaDe(t)}
                            {t === 'datos' && <PendientesEnLaBarra className="" />}
                          </span>
                          <span className="mt-0.5 block text-xs leading-snug text-muted">
                            {abierta ? 'Es la pantalla abierta.' : QUE_HAY_EN[t]}
                          </span>
                        </span>
                        <Icono nombre="derecha" lado={16} className="text-muted" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}

      <section className="mt-4">
        <h2 className="eyebrow px-1 pb-1.5">Este aparato</h2>
        <div className="overflow-hidden rounded-card border border-line-soft">
          {/* En dos renglones: el nombre y para qué sirve arriba, el selector
              debajo y a todo el ancho. En una sola fila, en un teléfono, las
              tres opciones dejaban a la explicación una columna de cuatro
              palabras por línea. */}
          <div className="px-3 py-3">
            <p className="font-medium">Tema</p>
            <p className="text-xs leading-snug text-muted">
              El oscuro va bien en un aula con el proyector encendido.
            </p>
            <div role="group" aria-label="Tema" className="segmento mt-2.5 flex w-full">
              {TEMAS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={tema === t.id}
                  onClick={() => ponerTema(t.id)}
                  className="flex flex-1 items-center justify-center gap-1.5"
                >
                  <Icono nombre={t.icono} lado={16} />
                  {t.etiqueta}
                </button>
              ))}
            </div>
          </div>

          {/* Instalar solo sale donde se puede instalar con un toque: en Chrome,
              sin instalar ya. En el iPhone no hay aviso que mostrar —Apple no lo
              ofrece— y la guía cuenta el camino de Safari. */}
          {instalable && (
            <button
              type="button"
              onClick={onInstalar}
              className="fila flex min-h-touch w-full items-center gap-3 border-t border-line-soft px-3 py-2.5 text-left"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] bg-accent-tint text-accent">
                <Icono nombre="instalar" lado={20} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">Instalar en este aparato</span>
                <span className="mt-0.5 block text-xs leading-snug text-muted">
                  Un icono en la pantalla de inicio y sin la barra del navegador. Es la misma
                  aplicación, con lo mismo dentro.
                </span>
              </span>
            </button>
          )}
        </div>
      </section>

      <button
        type="button"
        onClick={onSalir}
        className="fila mt-4 flex min-h-touch w-full items-center gap-3 rounded-card border border-line-soft px-3 py-2.5 text-left text-crit"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] bg-crit-tint">
          <Icono nombre="salir" lado={20} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">Cerrar sesión</span>
          <span className="mt-0.5 block text-xs leading-snug text-muted">
            Pide confirmación. Después hay que volver a teclear el PIN.
          </span>
        </span>
      </button>
    </HojaDeAcciones>
  )
}
