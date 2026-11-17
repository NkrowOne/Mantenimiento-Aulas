import { MarcaDeLaApp } from '@/features/shell/Navegacion'

/**
 * La pantalla de arranque: la marca, en el centro, quieta si es un momento.
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
 *
 * Lo único que se mueve es la propia marca, y solo si el arranque se alarga:
 * pasados 0,6 s empieza a latir (`.marca-espera`, definida en `index.html`
 * junto a la del primer fotograma). En un arranque normal no llega a hacerlo.
 */
export function Arranque(): React.ReactElement {
  return (
    <div role="status" aria-label="Cargando" className="flex min-h-dvh items-center justify-center">
      <span className="marca-espera inline-flex">
        <MarcaDeLaApp lado={72} />
      </span>
    </div>
  )
}
