/**
 * Qué versión del bundle es esta.
 *
 * Lo inyecta `define` en `vite.config.ts`: el commit si se compiló con
 * `VITE_COMMIT`, y si no la fecha y hora de compilación.
 *
 * Existe porque `salud.json` contesta «qué hay en el servidor» y esa no es la
 * pregunta cuando algo falla en un aula. La pregunta es qué está ejecutando ESE
 * dispositivo, que con `registerType: 'prompt'` puede ser otra cosa durante
 * días: el service worker nuevo se queda esperando a que alguien pulse
 * «Actualizar», así que un iPad puede estar enseñando un fallo corregido hace
 * horas mientras el servidor ya sirve el arreglo.
 */
declare const __BUILD__: string
