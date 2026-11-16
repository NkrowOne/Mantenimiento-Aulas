/**
 * El logotipo, para pintarlo dentro de la aplicación.
 *
 * Es el mismo dibujo de `public/favicon.svg` —ahí se cuenta cómo está hecho—,
 * aquí como dos constantes para que `MarcaDeLaApp` lo pinte en línea: en la
 * cabecera, en el menú lateral, en la pantalla del PIN y en el arranque. En
 * línea y no como `<img>` porque una imagen es una petición más, y la marca
 * está en el primer fotograma de la primera pantalla.
 *
 * Si se cambia el logotipo hay que cambiarlo en tres sitios: aquí, en
 * `public/favicon.svg` (y regenerar los PNG) y en `index.html`.
 */

/** El azul del fondo del logotipo. */
export const MARCA_FONDO = '#0D3C68'

/** Las doce gotas, en un lienzo de 512 × 512. */
export const MARCA_TRAZO =
  'M269.5 35.6L356.6 150.4A4.1 4.1 0 0 1 350.9 156.1L236.1 69A23.8 23.8 0 1 1 269.5 35.6ZM230.5 74.6L317.6 189.4A4.1 4.1 0 0 1 311.9 195.1L197.1 108A23.8 23.8 0 1 1 230.5 74.6ZM191.5 113.6L278.6 228.4A4.1 4.1 0 0 1 272.9 234.1L158.1 147A23.8 23.8 0 1 1 191.5 113.6ZM476.4 269.5L361.6 356.6A4.1 4.1 0 0 1 355.9 350.9L443 236.1A23.8 23.8 0 1 1 476.4 269.5ZM437.4 230.5L322.6 317.6A4.1 4.1 0 0 1 316.9 311.9L404 197.1A23.8 23.8 0 1 1 437.4 230.5ZM398.4 191.5L283.6 278.6A4.1 4.1 0 0 1 277.9 272.9L365 158.1A23.8 23.8 0 1 1 398.4 191.5ZM242.5 476.4L155.4 361.6A4.1 4.1 0 0 1 161.1 355.9L275.9 443A23.8 23.8 0 1 1 242.5 476.4ZM281.5 437.4L194.4 322.6A4.1 4.1 0 0 1 200.1 316.9L314.9 404A23.8 23.8 0 1 1 281.5 437.4ZM320.5 398.4L233.4 283.6A4.1 4.1 0 0 1 239.1 277.9L353.9 365A23.8 23.8 0 1 1 320.5 398.4ZM35.6 242.5L150.4 155.4A4.1 4.1 0 0 1 156.1 161.1L69 275.9A23.8 23.8 0 1 1 35.6 242.5ZM74.6 281.5L189.4 194.4A4.1 4.1 0 0 1 195.1 200.1L108 314.9A23.8 23.8 0 1 1 74.6 281.5ZM113.6 320.5L228.4 233.4A4.1 4.1 0 0 1 234.1 239.1L147 353.9A23.8 23.8 0 1 1 113.6 320.5Z'
