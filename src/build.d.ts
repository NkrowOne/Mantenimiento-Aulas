/**
 * Qué versión del bundle es esta.
 *
 * Lo inyecta `define` en `vite.config.ts`: el commit si se compiló con
 * `VITE_COMMIT`, y si no la fecha y hora de compilación.
 *
 * Existe porque `salud.json` contesta «qué hay en el servidor» y esa no es la
 * pregunta cuando algo falla en un aula. La pregunta es qué está ejecutando ESE
 * dispositivo, que puede ser otra cosa durante un rato: la versión nueva se
 * instala sola pero espera al siguiente momento seguro (ver `src/sw.ts`), y un
 * dispositivo con el código de antes de esa política sigue esperando un toque.
 * Así que un iPad puede estar enseñando un fallo corregido hace horas mientras
 * el servidor ya sirve el arreglo.
 */
declare const __BUILD__: string
