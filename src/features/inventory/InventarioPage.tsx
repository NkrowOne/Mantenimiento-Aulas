import { lazy, Suspense, useState } from 'react'
import type { Role } from '@/domain/types'
import { StockPage } from './StockPage'

/*
 * El catálogo y la gestión de equipos se cargan al entrar en ellos.
 *
 * La pestaña la abre a diario quien va a mirar el almacén, y esas dos pantallas
 * son las que menos se usan y más pesan —tablas, filtros y la exportación—.
 * Descargarlas en el arranque las pagaría el iPad con la peor cobertura del día,
 * que es justo al llegar al edificio.
 */
const EquiposPage = lazy(() =>
  import('./EquiposPage').then((m) => ({ default: m.EquiposPage })),
)
const CatalogoModelos = lazy(() =>
  import('./CatalogoModelos').then((m) => ({ default: m.CatalogoModelos })),
)

type Seccion = 'equipos' | 'almacen' | 'catalogo'

/**
 * Inventario: lo que está instalado, lo que hay en el almacén y el catálogo.
 *
 * Son tres vistas de la misma cosa y por eso viven juntas. Antes «Almacén» era
 * una pestaña y el inventario instalado no tenía ninguna: se corregía equipo a
 * equipo desde dentro de la revisión, que sirve para el aparato que tienes
 * delante y no para los 1.094 que hay que poner al día.
 *
 * Va como control segmentado y no como cuatro pestañas más abajo por una razón
 * práctica: la barra ya lleva siete para un administrador, y en un iPad la
 * octava las deja a todas sin sitio.
 */
export function InventarioPage({
  role,
  userId,
}: {
  role: Role
  userId: string | null
}): React.ReactElement {
  const [seccion, setSeccion] = useState<Seccion>('equipos')

  const SECCIONES: Array<{ id: Seccion; label: string; visible: boolean }> = [
    { id: 'equipos', label: 'Equipos', visible: true },
    { id: 'almacen', label: 'Almacén', visible: true },
    // El catálogo lo consulta cualquiera, pero es una pantalla de decisiones de
    // coordinación: enseñarla a quien no puede tocar nada es enseñar cinco
    // botones desactivados.
    { id: 'catalogo', label: 'Catálogo', visible: role !== 'tecnico' },
  ]

  return (
    <div>
      {/*
        No es `sticky`, y es a propósito.

        La cabecera de la aplicación ya lo es, con `top-0` y `z-10`. Un segundo
        `sticky top-0` aquí se pegaría en la misma línea y quedaría DEBAJO de
        ella: el selector desaparecería al desplazar en vez de acompañar. Y
        acertar el desplazamiento exigiría cablear la altura de la cabecera, que
        cambia con el área segura del iPhone.
      */}
      <div className="border-b border-line bg-ground px-4 pb-2 pt-3">
        <div className="flex gap-1 rounded-ctl border border-line bg-surface p-1">
          {SECCIONES.filter((s) => s.visible).map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSeccion(s.id)}
              aria-pressed={seccion === s.id}
              className={`min-h-11 flex-1 rounded-ctl px-2 text-xs font-semibold ${
                seccion === s.id ? 'key key-accent' : 'text-muted'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <Suspense fallback={<p className="p-6 text-muted">Cargando…</p>}>
        {seccion === 'equipos' && <EquiposPage role={role} userId={userId} />}
        {seccion === 'almacen' && <StockPage role={role} />}
        {seccion === 'catalogo' && role !== 'tecnico' && <CatalogoModelos role={role} />}
      </Suspense>
    </div>
  )
}
