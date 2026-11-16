/**
 * Las secciones de la aplicación: cuáles hay, quién las abre y dónde se pintan.
 *
 * Vivían dentro de `App.tsx`. Salen a su fichero porque ahora las leen tres
 * sitios —la barra de abajo, el menú lateral de las pantallas grandes y la hoja
 * de «Más»— y una lista copiada en tres sitios acaba diciendo tres cosas.
 */

import type { NombreDeIcono } from '@/components/Icono'
import type { Role } from '@/domain/types'

export type Tab =
  | 'revisar'
  | 'panel'
  | 'incidencias'
  | 'almacen'
  | 'equipos'
  | 'historial'
  | 'actividad'
  | 'informes'
  | 'datos'

export type Grupo = 'trabajo' | 'consulta' | 'administracion'

/**
 * Cada sección, con su icono y con el grupo al que pertenece.
 *
 * El grupo es lo que ordena «Más» y el menú lateral de las pantallas grandes.
 * Antes «Más» era una lista de cinco cosas seguidas, y había que leerlas todas
 * para saber cuál era de consulta y cuál de administración. Con tres grupos
 * —lo que se hace de pie, lo que se consulta, lo que se administra— la pregunta
 * «¿dónde estaba eso?» se contesta mirando un título y no cinco.
 */
export const TABS: Array<{
  id: Tab
  label: string
  minRole: Role
  icono: NombreDeIcono
  grupo: Grupo
}> = [
  { id: 'revisar', label: 'Revisar', minRole: 'tecnico', icono: 'revisar', grupo: 'trabajo' },
  { id: 'panel', label: 'Panel', minRole: 'tecnico', icono: 'panel', grupo: 'consulta' },
  {
    id: 'incidencias',
    label: 'Incidencias',
    minRole: 'tecnico',
    icono: 'incidencias',
    grupo: 'trabajo',
  },
  { id: 'almacen', label: 'Almacén', minRole: 'tecnico', icono: 'almacen', grupo: 'trabajo' },
  /* La abre cualquiera —buscar un número de serie es trabajo de pasillo— y
     cambiar la ficha es de supervisor: lo decide la base, no esta lista. */
  { id: 'equipos', label: 'Equipos', minRole: 'tecnico', icono: 'equipos', grupo: 'consulta' },
  {
    id: 'historial',
    label: 'Historial',
    minRole: 'tecnico',
    icono: 'historial',
    grupo: 'trabajo',
  },
  /* Quién cambió qué y cuándo. Vivía solo dentro de Datos, así que la
     trazabilidad era cosa del administrador; la necesita quien trabaja en las
     aulas. Lo que el técnico no debe leer —los cambios de usuarios— lo
     filtra la base, no esta lista. */
  {
    id: 'actividad',
    label: 'Actividad',
    minRole: 'tecnico',
    icono: 'actividad',
    grupo: 'consulta',
  },
  /* Informes es de administrador, no de supervisor. Un informe es un documento
     que se firma y se archiva, y lleva dentro el reparto del trabajo con
     nombres; además, emitirlo con IA hace pasar la clave del despliegue por el
     navegador de quien lo pide. Las tres cosas apuntan al mismo sitio. */
  {
    id: 'informes',
    label: 'Informes',
    minRole: 'admin',
    icono: 'informes',
    grupo: 'administracion',
  },
  { id: 'datos', label: 'Datos', minRole: 'admin', icono: 'datos', grupo: 'administracion' },
]

export const RANK: Record<Role, number> = { tecnico: 0, supervisor: 1, admin: 2 }

/**
 * ¿Puede este rol abrir esta pestaña?
 *
 * Existe porque el filtro de `TABS` alimentaba ÚNICAMENTE la barra de abajo, y
 * una barra sin botón no es una puerta cerrada: a «Datos» se llegaba desde la
 * tarjeta ámbar del Panel —que es de técnico— y la aplicación montaba el panel
 * de administración entero para quien no puede tocar nada de lo que hay dentro.
 * El técnico veía el alta de edificios, el `⋯` de cada edificio con «Dar de baja»
 * y la papelera con sus nombres y sus recuentos —que `archived_buildings` le
 * sirve de verdad, porque es `security_invoker` sobre unas tablas que su rol sí
 * lee— y solo descubría el problema al pulsar, leyendo un `confirm()` que promete
 * que el edificio desaparecerá de todos los iPads y recibiendo después «Solo un
 * administrador puede tocar la nomenclatura». No hay escalada de privilegios
 * —los RPC fallan cerrados con 42501— pero enseñar acciones que no existen para
 * quien las mira es enseñarle a desconfiar de todos los botones.
 *
 * La misma función decide las tres cosas: qué pestañas se pintan, qué pestaña se
 * puede abrir y qué se monta debajo. Tres reglas separadas volverían a
 * discrepar.
 */
export function puedeVer(tab: Tab, role: Role): boolean {
  const t = TABS.find((x) => x.id === tab)
  return t !== undefined && RANK[role] >= RANK[t.minRole]
}

export function etiquetaDe(tab: Tab): string {
  return TABS.find((x) => x.id === tab)?.label ?? tab
}

export function iconoDe(tab: Tab): NombreDeIcono {
  return TABS.find((x) => x.id === tab)?.icono ?? 'mas'
}

/** Los grupos, en el orden en que se pintan, con el título que llevan. */
export const GRUPOS: Array<{ id: Grupo; titulo: string }> = [
  { id: 'trabajo', titulo: 'En las aulas' },
  { id: 'consulta', titulo: 'Consultar' },
  { id: 'administracion', titulo: 'Administrar' },
]

/** Las secciones de un grupo que este rol puede abrir, en el orden de `TABS`. */
export function seccionesDe(grupo: Grupo, role: Role): Tab[] {
  return TABS.filter((t) => t.grupo === grupo && puedeVer(t.id, role)).map((t) => t.id)
}

/*
 * La barra de abajo: cuatro pestañas y «Más», para los tres roles.
 *
 * Con las siete pestañas la barra medía 468 px en un móvil de 390: «Informes»
 * salía cortada, «Datos» ni salía y nada decía que se pudiera deslizar. Y las
 * cinco del técnico cabían en 390 px JUSTOS, a una letra de desbordar. Las
 * cuatro de aquí son las del trabajo de pie —la ronda, las averías, el
 * material y lo hecho—; el panel y las pantallas de administración van detrás
 * de «Más», con instalar la aplicación y cerrar sesión, que hasta ahora ocupaba
 * la cabecera de todas las pantallas para alguien que no cierra sesión casi
 * nunca. Así la barra tiene la misma forma en todos los aparatos y nunca se
 * desborda.
 */
export const EN_LA_BARRA: Tab[] = ['revisar', 'incidencias', 'almacen', 'historial']
export const EN_MAS: Tab[] = ['panel', 'equipos', 'actividad', 'informes', 'datos']
/** La segunda línea de cada entrada de «Más»: qué hay detrás, en una frase. */
export const QUE_HAY_EN: Partial<Record<Tab, string>> = {
  panel: 'Cómo va la ronda: retrasos, averías abiertas y lo que va a dar guerra.',
  equipos: 'Todo el inventario: ficha de cada equipo, vida útil, entradas y salidas, y Excel.',
  actividad: 'Quién cambió qué y cuándo: salas, equipos, incidencias y catálogo.',
  informes: 'Se arman con los datos del periodo que elijas y quedan archivados.',
  datos: 'Por decidir, maestro, Excel, importación, actividad y usuarios.',
}
