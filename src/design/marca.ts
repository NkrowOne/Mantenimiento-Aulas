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
  'M268.4 53.2L348.6 158.9A3.8 3.8 0 0 1 343.3 164.1L237.7 83.9A21.9 21.9 0 1 1 268.4 53.2ZM232.5 89.1L312.7 194.7A3.8 3.8 0 0 1 307.4 200L201.8 119.8A21.9 21.9 0 1 1 232.5 89.1ZM196.6 125L276.8 230.6A3.8 3.8 0 0 1 271.6 235.9L165.9 155.7A21.9 21.9 0 1 1 196.6 125ZM458.8 268.4L353.1 348.6A3.8 3.8 0 0 1 347.9 343.3L428.1 237.7A21.9 21.9 0 1 1 458.8 268.4ZM422.9 232.5L317.3 312.7A3.8 3.8 0 0 1 312 307.4L392.2 201.8A21.9 21.9 0 1 1 422.9 232.5ZM387 196.6L281.4 276.8A3.8 3.8 0 0 1 276.1 271.6L356.3 165.9A21.9 21.9 0 1 1 387 196.6ZM243.6 458.8L163.4 353.1A3.8 3.8 0 0 1 168.7 347.9L274.3 428.1A21.9 21.9 0 1 1 243.6 458.8ZM279.5 422.9L199.3 317.3A3.8 3.8 0 0 1 204.6 312L310.2 392.2A21.9 21.9 0 1 1 279.5 422.9ZM315.4 387L235.2 281.4A3.8 3.8 0 0 1 240.4 276.1L346.1 356.3A21.9 21.9 0 1 1 315.4 387ZM53.2 243.6L158.9 163.4A3.8 3.8 0 0 1 164.1 168.7L83.9 274.3A21.9 21.9 0 1 1 53.2 243.6ZM89.1 279.5L194.7 199.3A3.8 3.8 0 0 1 200 204.6L119.8 310.2A21.9 21.9 0 1 1 89.1 279.5ZM125 315.4L230.6 235.2A3.8 3.8 0 0 1 235.9 240.4L155.7 346.1A21.9 21.9 0 1 1 125 315.4Z'
