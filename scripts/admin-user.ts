/**
 * Alta y gestión de usuarios, desde el repositorio.
 *
 *   npm run admin:user -- crear  ana@x.es "Ana Ruiz" tecnico
 *   npm run admin:user -- crear  jefe@x.es "Jefe" --primer-admin
 *   npm run admin:user -- codigo ana@x.es                  # nuevo código de alta
 *   npm run admin:user -- rol    ana@x.es supervisor
 *   npm run admin:user -- listar
 *   npm run admin:user -- borrar ana@x.es
 *
 * Y las dos de «he perdido el iPad», que el tope de tres dispositivos hace
 * necesarias — se quedaron fuera de esta lista cuando se añadieron:
 *
 *   npm run admin:user -- dispositivos ana@x.es    # cuáles, y cuántos huecos quedan
 *   npm run admin:user -- revocar <id-del-aparato> # retira uno
 *   npm run admin:user -- revocar ana@x.es --todos # retira todos los suyos
 *
 * El orden de los argumentos da igual y las formas con `--email`/`--nombre`/`--rol`
 * también valen: el email se reconoce por la `@` y el rol porque solo puede ser
 * una de tres palabras.
 *
 * La orden vive en `reports-worker/src/admin-user.ts` porque el worker es el
 * único contenedor de un despliegue sobre plataforma que puede ejecutarla, y
 * su imagen solo se lleva `reports-worker/`. Aquí se importa en vez de
 * copiarse: dos copias del alfabeto de los códigos, de su hash y de su
 * caducidad se separan en cuanto una de las dos cambie, y el síntoma sería un
 * código que la aplicación no reconoce.
 *
 * La importación es por su efecto: el módulo lee `process.argv`, que es el
 * mismo en ambos casos.
 */

import '../reports-worker/src/admin-user.js'
