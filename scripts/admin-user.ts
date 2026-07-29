/**
 * Alta y gestión de usuarios, desde el repositorio.
 *
 *   npm run admin:user -- crear  --email ana@x.es --nombre "Ana Ruiz" --rol tecnico
 *   npm run admin:user -- crear  --email jefe@x.es --nombre "Jefe" --primer-admin
 *   npm run admin:user -- codigo --email ana@x.es          # nuevo código de alta
 *   npm run admin:user -- rol    --email ana@x.es --rol supervisor
 *   npm run admin:user -- listar
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
