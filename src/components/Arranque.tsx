import { MarcaDeLaApp } from '@/features/shell/Navegacion'

/**
 * La pantalla de arranque: la marca, quieta, en el centro.
 *
 * Es la MISMA que `index.html` deja pintada dentro de `#root` antes de que
 * llegue una sola línea de JavaScript —mismo dibujo, mismo tamaño, mismo
 * sitio—, así que cuando React toma el relevo no cambia ni un píxel: no hay
 * pantalla en blanco, ni salto, ni un «Cargando…» que no da tiempo a leer. Si
 * se cambia una, hay que cambiar la otra.
 *
 * Sin texto y sin barra de progreso a propósito: dura lo que tarda Dexie en
 * decir si hay una sesión guardada, que son milisegundos. Una barra que no
 * llega a moverse es peor que ninguna.
 */
export function Arranque(): React.ReactElement {
  return (
    <div role="status" aria-label="Cargando" className="flex min-h-dvh items-center justify-center">
      <MarcaDeLaApp lado={72} />
    </div>
  )
}
