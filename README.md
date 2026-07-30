# Mantenimiento de Aulas

PWA offline-first para la revisión de aulas, el inventario instalado y el stock
de almacén. Sustituye al Excel de 5 hojas con el que se gestionan hoy **276
salas en 17 edificios**.

## Por qué

El Excel actual tiene tres problemas que no se arreglan con más disciplina:

- **No hay trazabilidad.** Ninguna columna dice quién revisó o modificó nada.
- **Las claves no cruzan.** El estado usa `EDIFICIO H / 1ª PLANTA / 1.7` y las
  incidencias `1.7 H`, así que nadie puede relacionarlas automáticamente.
- **El stock se descuadra.** El consumo se teclea a mano y no se descuenta del
  material usado, de ahí los saldos negativos.

Y desaprovecha lo que ya sabe: hay horas de proyector y `% Lámparas` por aula
—con salas al 2% y al 7%— sin que eso avise a nadie antes de que se funda.

## La decisión que lo sostiene todo

**Modelo append-only.** Lo que se escribe desde el móvil son eventos inmutables,
nunca ediciones:

- Una revisión es un registro nuevo, no una actualización de la sala.
- El stock guarda **movimientos**; la cantidad actual es `SUM(qty)`, no un campo.
- El inventario guarda altas, bajas y sustituciones.

Consecuencia directa: **la sincronización offline no tiene conflictos que
resolver**, y la auditoría de "quién hizo qué" sale del propio historial.

## Despliegue

Un solo host, un `docker compose`, un nombre DNS. Caddy termina el TLS, sirve la
PWA y hace de proxy a Supabase **en el mismo origen**, así que no hay CORS que
configurar.

```bash
cp .env.example .env
npm run gen:keys                 # secretos y claves; pégalos en .env
npm run import:excel -- <xlsx>   # genera supabase/seed.sql
npm run deploy -- --con-seed
npm run admin:user -- crear tu@correo.es "Tu nombre" --primer-admin
```

`deploy.sh` valida la configuración **antes** de levantar nada: un despliegue
que arranca a medias y falla en el tercer servicio cuesta mucho más de
diagnosticar que uno que se niega a empezar diciendo qué falta.

### Sobre una plataforma (skyway, Railway, Fly…)

Cuando los servicios los levanta la plataforma y aquí solo llega una cadena de
conexión, `deploy.sh` no sirve: cada paso suyo pasa por `docker compose exec`.

```bash
export JWT_SECRET=<el que ya usa tu Supabase>
export DATABASE_URL=postgresql://postgres:CLAVE@HOST:5432/postgres
npm run variables            # deduce, verifica y te dice qué pegar dónde
npm run init:plataforma -- --con-seed
```

`npm run variables` es lo primero porque casi nada hay que buscarlo: `ANON_KEY`
y `SERVICE_ROLE_KEY` **son JWT firmados con el `JWT_SECRET`**, así que se
calculan; el token del worker se lee de `app_config` si ya está acordado, y si
no se genera. Lo único que no toca es el `JWT_SECRET`: tu Supabase ya tiene uno
y cambiarlo invalidaría de golpe las claves de GoTrue, PostgREST y Storage.

Lo que sí hace con lo que ya tengas es **verificarlo**: comprueba que cada clave
esté firmada con ese secreto, con el `role` correcto y sin caducar. Copiarlas de
un tutorial —el error clásico en self-hosted— deja de pasar desapercibido.

Comprueba **antes de tocar nada** que GoTrue y Storage ya hayan arrancado
—crean `auth.users` y `storage.buckets` con sus propias migraciones—, aplica lo
que falte llevando registro en `schema_migrations`, alinea el token del worker y
verifica al final que el hook del rol es ejecutable. Repetirlo no duplica nada.

#### El hook del rol hay que activarlo en el servicio de auth

Es la variable que más caro sale olvidar, así que va aparte. En el servicio de
GoTrue de la plataforma:

```
GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=true
GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI=pg-functions://postgres/public/custom_access_token_hook
```

Están escritas en `docker-compose.yml`, pero sobre una plataforma ese fichero no
se usa: hay que copiarlas al servicio a mano. Sin ellas el token sale **sin el
claim `app_role`**, y ese fallo no se parece a un fallo — PostgREST no distingue
«no tienes permiso» de «no hay nada», así que responde `200 []` a todas las
lecturas. La aplicación arranca perfecta, acepta el PIN, no da un solo error y no
enseña ni una fila: idéntico a una base vacía.

Desde la migración `20260729000100_rol_sin_hook.sql` esto ya no deja la
aplicación muerta —si el claim no viene, `auth_role()` mira el perfil—, pero
activar el hook sigue siendo lo correcto: es el camino rápido y el que evita una
consulta extra por sentencia. Para saber en cuál de los dos estás, la propia
aplicación lo dice: el botón **«Ver diagnóstico del servidor»**, que sale junto
al aviso de que no hay datos, enseña si el claim llega y qué rol tiene tu perfil.

El `Dockerfile` de la raíz construye la PWA y la sirve con `Caddyfile.skyway`,
que además hace de proxy de `/rest`, `/auth` y `/storage` hacia Kong: **la API
va por el mismo origen que la PWA**, que es lo que permite que `kong.yml` no
lleve plugin de CORS. Necesita `SUPABASE_UPSTREAM` en tiempo de ejecución y
`VITE_SUPABASE_ANON_KEY` como argumento de construcción.

Esa imagen lleva además la orden de altas de usuario (`alta`, ver *Usuarios*),
que es lo único que necesita `SUPABASE_SERVICE_ROLE_KEY` en el servicio.

Conviene pasarle también `VITE_COMMIT`, que no cambia nada de la aplicación pero
publica en `/salud.json` **qué código está en el aire**. Sin eso, responder
«¿está desplegado ya el arreglo?» obliga a descargarse el bundle y buscar
cadenas dentro, porque `version` no la sube nadie y todos los despliegues
anuncian el mismo `0.1.0`:

```bash
docker build --build-arg VITE_SUPABASE_ANON_KEY=<anon> \
             --build-arg VITE_COMMIT="$(git rev-parse --short HEAD)" .

curl -s https://tu-dominio/salud.json | jq '.commit, .ejecucion'
```

Y **se pone la base al día ella sola**: al arrancar aplica las migraciones que
falten (`migrar`, el mismo SQL de `supabase/migrations` y el mismo registro en
`public.schema_migrations` que lleva `init-plataforma.sh`, así que da igual cuál
de los dos aplicara cada una). Solo pide `DATABASE_URL`, y del Postgres **del
despliegue**: si ahí no encuentra `auth.users` y `storage.buckets` se planta sin
tocar nada, que es como se caza una cadena que apunta a otra base. Sin
`DATABASE_URL` no migra y lo dice en el registro. En ningún caso impide que la
aplicación se sirva —es una PWA que funciona sin conexión, y dejar el iPad en
blanco porque la base tarda en levantar no arregla nada—, y para lanzarlo a mano
`migrar` está en el `PATH`, como `alta`.

### Saber si le falta alguna variable

Un despliegue de esto puede quedar **verde y roto**: sin `SUPABASE_UPSTREAM` la
PWA carga entera y solo la API devuelve 503; sin `VITE_SUPABASE_ANON_KEY` la
aplicación abre sin configuración. En los dos casos el servicio está «activo».

Así que lo dice él mismo, en dos sitios:

```bash
curl -s https://<dominio>/salud.json     # desde cualquier parte
salud --texto                            # en la terminal del servicio
```

```json
{ "estado": "desconfigurado", "revisado": "arranque",
  "construccion": { "clave_anonima": true, "url_api": "origen", "bloqueo_min": 0 },
  "ejecucion": { "upstream": "ausente", "puerto": 8080, "clave_de_servicio": false },
  "faltan": ["SUPABASE_UPSTREAM"],
  "avisos": ["SUPABASE_SERVICE_ROLE_KEY ausente: la PWA funciona, pero alta no podrá crear usuarios"] }
```

El mismo informe, en texto, sale por el registro del contenedor en cada
arranque —que es lo único que enseña el panel de una plataforma—. Nunca
contiene el **valor** de nada: solo si está puesto, y de `SUPABASE_UPSTREAM`,
la forma. `/salud.json` es público.

`estado` no sale del código de salida a propósito: falta de configuración
devuelve 200 igual. Tumbar el servicio por eso lo dejaría caído en vez de
meramente desconfigurado, y en una plataforma que sondea esta ruta durante el
despliegue, además abortaría el despliegue y restauraría una versión anterior
igual de desconfigurada. Lo único que marca enfermo es que Caddy no sirva.

Dos cosas que el informe **no** puede saber, y hay que decirlo: si la clave
anónima es la *correcta* (una firmada con otro `JWT_SECRET` da 401 en toda la
API con el informe en verde) y si Kong responde de verdad detrás del upstream.
Lo primero lo comprueba `npm run variables`, desde fuera.

### El certificado, que es lo que decide si hay modo offline

Sin HTTPS válido no hay service worker, y sin service worker no hay modo
offline. El certificado se emite por **reto DNS-01 contra Cloudflare**, que no
necesita que el servidor sea alcanzable desde Internet: Let's Encrypt solo
comprueba un TXT en `_acme-challenge` y nunca conecta aquí.

**El registro A debe existir solo en el resolver interno o el DNS de la VPN.**
Publicarlo en el DNS público apuntando a una IP privada filtra topología de red
y, sobre todo, muchos routers y resolvers descartan respuestas públicas que
contienen direcciones RFC1918 —protección anti DNS-rebinding— dejando iPhones
que sencillamente no resuelven el nombre.

### Usuarios

No hay registro abierto ni SMTP. Un administrador da de alta a cada técnico y le
entrega un código de un solo uso que caduca en 24 horas:

```bash
npm run admin:user -- crear  ana@x.es "Ana Ruiz" tecnico
npm run admin:user -- crear  ana@x.es              # ya existe: código nuevo
npm run admin:user -- codigo ana@x.es              # lo mismo, dicho aparte
npm run admin:user -- rol    ana@x.es supervisor
npm run admin:user -- borrar ana@x.es
npm run admin:user -- listar
```

El alta entera cabe en una orden y **el orden de los argumentos da igual**: el
email se reconoce por la `@` y el rol porque solo puede ser `tecnico`,
`supervisor` o `admin`. Sin rol entra como técnico. Lo que no encaje en ninguno
de los tres huecos no se ignora: el comando se para y lo dice, porque un rol
mal escrito o un nombre sin comillas daría de alta a alguien mal y en silencio.

**`crear` se puede repetir**: si el email ya existe no falla, le da un código
nuevo y anula el anterior. Es lo que hace falta cuando se dictó mal o se
entregó a quien no era, y evita el rodeo de borrar al usuario para volver a
crearlo. El nombre y el rol solo cambian si se escriben, así que un `crear` a
secas no degrada a nadie.

`borrar` es para quien nunca llegó a usar la aplicación. Al que tenga historial
no lo deja borrar la base de datos, y a propósito: sus revisiones e incidencias
guardan quién las hizo. Para esos la baja es desactivar.

Sobre una plataforma no hay repositorio a mano, así que la imagen del servicio
lleva las mismas órdenes dentro, como `alta`:

```bash
alta crear ana@x.es "Ana Ruiz" tecnico
alta borrar ana@x.es
```

Se ejecuta desde la terminal del servicio, en el panel de la plataforma. Pide
`SUPABASE_SERVICE_ROLE_KEY` entre las variables del servicio —la URL de la API
la saca de `SUPABASE_UPSTREAM`, la que ya usa el Caddyfile—, y **esa clave no
llega al navegador**: en el bundle solo entran las variables `VITE_*`, y esta no
lo es. El worker de informes, si lo tienes desplegado, responde a las mismas
órdenes con `npm run admin -- …`.

El código **es** la contraseña temporal. Al usarlo, la app la rota
inmediatamente a una aleatoria fuerte, y esa contraseña se guarda **envuelta en
una bóveda que solo abre el PIN** (ver más abajo). El código deja de valer en ese
instante y la llave del dispositivo pasa a ser el refresh token cifrado con el
PIN.

### Hasta tres dispositivos por persona, sin pedir otro código

Quien ya usa la aplicación en el iPad y quiere abrirla en el móvil no está
pidiendo acceso —ya lo tiene—, está cambiando de aparato. Cobrarle una llamada y
un código de 24 horas por eso hace que el segundo dispositivo no se use.

En el aparato nuevo, la pantalla de entrada trae dos pestañas:

| | Qué se teclea | Cuándo |
|---|---|---|
| **Con código** | email + código + elegir PIN | la primera vez de esa persona |
| **Con mi PIN** | email + el PIN que ya usa | el segundo y el tercer aparato |

**Cómo puede funcionar si el PIN no se envía a ningún sitio.** No se envía, y
sigue sin enviarse. Lo que hay en el servidor es un sobre:

```
PBKDF2(PIN, salt, 310.000)  ->  clave maestra
  HKDF(maestra, "verificador")  ->  esto viaja: sirve para decir «sé el PIN»
  HKDF(maestra, "envoltorio")   ->  esto NO sale del aparato: abre el sobre
```

El servidor guarda el salt, el **hash** del verificador y la contraseña de la
cuenta **cifrada**. Nunca el PIN y nunca la contraseña. El dispositivo nuevo
deriva las dos mitades del PIN que le teclean, enseña el verificador, y si cuadra
recibe el sobre y lo abre en local. Las dos mitades salen de la misma clave
maestra por HKDF con etiquetas distintas, así que son independientes: tener el
verificador no acerca ni un paso a la clave del envoltorio.

**Por qué un PIN de cuatro dígitos no se convierte en la llave de todo.** Diez
mil combinaciones se prueban en minutos… si el sobre se entrega a quien lo pida.
No se entrega: hay que pasar el verificador, y eso se comprueba en el servidor
con contador. Cinco fallos bloquean cinco minutos, diez bloquean quince, quince
bloquean una hora. La fuerza bruta deja de ser un problema de cómputo y pasa a
ser uno de tiempo de pared. Aun así, la aplicación **recomienda seis dígitos** en
el momento de elegirlo.

Lo que sí cambia y conviene saber: quien se lleve un volcado entero de la base
puede romper un PIN corto sin conexión. En un volcado entero ya se lleva
`auth.users` y puede hacer lo que quiera, así que no abre una puerta nueva — pero
es la razón de los seis dígitos.

**Tres, y se ven.** El tope está en `app_config.max_dispositivos` y se cambia sin
desplegar. Cada persona ve los suyos en **Mi cuenta** —la chapa del rol, arriba a
la izquierda—, con su nombre, desde cuándo y cuándo se conectó por última vez, y
puede revocar el que sobre. Un dispositivo revocado borra su sesión guardada la
próxima vez que abra con línea.

Desde la terminal, para la llamada de «he perdido el iPad»:

```bash
npm run admin:user -- dispositivos ana@x.es     # cuáles, y cuántos huecos quedan
npm run admin:user -- revocar <id-del-aparato>  # retira uno
npm run admin:user -- revocar ana@x.es --todos  # retira todos los suyos
```

Revocar no expulsa al instante: el refresh token del aparato sigue siendo válido
para GoTrue hasta que caduque. Lo que corta el acceso de raíz es **emitir un
código nuevo** (`admin:user -- codigo ana@x.es`), porque eso rota la contraseña
de la cuenta. Y hace una cosa más que conviene tener presente: **pausa la
vinculación por PIN** hasta que alguien use ese código, porque la contraseña que
la bóveda envuelve deja de valer. Los dispositivos que ya están dentro no se
enteran y siguen funcionando.

**Cambiar el PIN** se hace en Mi cuenta. Cambia la bóveda —o sea, el PIN con el
que se dan de alta dispositivos nuevos— y el sobre local de ese aparato. Los
otros que ya estén dentro siguen desbloqueándose con el suyo hasta que se vuelvan
a vincular; la pantalla lo dice antes de guardar.

### Copias de seguridad

```bash
npm run backup                       # en cron, de madrugada
npm run backup -- --probar <fichero> # restaurar en una base desechable
```

Copia Postgres **y** el volumen de Storage: las fotos no están en la base de
datos, y un volcado solo de Postgres dejaría las incidencias sin sus pruebas.
`--probar` existe porque una copia que nunca se ha restaurado no es una copia.

## Desarrollo

```bash
npm install
cp .env.example .env
npm run dev
```

### Importar el Excel

Es la **fuente de datos inicial**, no una función de la app:

```bash
npm run import:excel -- ruta/al/Material_Aulas.xlsx
psql "$DATABASE_URL" -f supabase/seed.sql
```

Genera identificadores deterministas: reimportar el mismo fichero produce
exactamente las mismas filas.

### Verificar el backend

```bash
npm run db:verify -- ruta/al/Material_Aulas.xlsx
npm run db:verify -- --gestionado    # sobre un Postgres desnudo, sin imagen de Supabase
```

Levanta un Postgres desechable, emula lo mínimo de Supabase, aplica las
migraciones, carga los datos reales y ejecuta las pruebas de RLS.

```bash
npm test          # 124 pruebas de lógica de dominio
npm run typecheck
npm run build
```

### Generar un informe

```bash
cd reports-worker && npm install
DATABASE_URL=postgresql://... npm run render -- semanal informe.pdf
```

Acepta `.html` como salida para iterar la plantilla sin WeasyPrint. En
producción lo levanta `docker compose up reports-worker` y lo despierta
`pg_cron`.

## Qué está construido

| Área | Estado |
|---|---|
| Esquema append-only, vistas y alertas | ✅ verificado contra Postgres 16 |
| RLS, roles y auditoría | ✅ 40 bloques en verde, incluida exposición pública |
| Importador del Excel | ✅ 276 salas, 283 incidencias, 669 equipos |
| Núcleo offline (Dexie + cola de salida) | ✅ |
| Login con PIN que cifra la sesión | ✅ lógica probada |
| Flujo de revisión de salas | ✅ |
| Fotos con compresión | ✅ |
| Panel con alertas y gráficos | ✅ paleta validada en claro y oscuro |
| Incidencias, almacén y depuración de datos | ✅ |
| Panel de administración: validar equipos, agrupar el catálogo, equipamiento por defecto y alta/baja de salas y edificios | ✅ |
| Hasta tres dispositivos por persona, con alta por PIN sin código | ✅ 10 bloques de RLS propios |
| Catálogo de marcas y modelos, con fecha de instalación | ✅ deducido del Excel: 55 modelos, 308 equipos ligados |
| Gestión del inventario desde el ordenador: filtros, edición en bloque y exportación | ✅ |
| Worker de informes PDF | ✅ PDF real generado y revisado |
| Buckets de Storage y sus políticas | ✅ 3 pruebas de RLS propias |
| Despliegue: Compose, Caddy, claves, copias | ✅ |
| Alta de usuarios y códigos | ✅ |
| Despliegue sobre Postgres gestionado | ✅ verificado en Postgres desnudo |
| Integración con ServiceNow | 🔌 puerto listo, falta la implementación |

## El inventario: qué es cada aparato

Hasta ahora el inventario sabía **qué clase** de aparato hay en cada aula
—Proyector, Pantalla, Ordenador— y para el modelo tenía una casilla de texto
libre. Con eso, el aula 2.4 y la 3.1 tienen las dos «un ordenador», y la pregunta
que se hace todos los días no se puede contestar: ¿cuántos ASPEN 223 quedan?, ¿es
el Lenovo U3302 el que da guerra con la docking?

Y el texto libre se degrada solo. Estas son cinco filas reales del Excel, y son
el mismo proyector:

```
ME403U   ·   ME-403U   ·   ME403U *
EB-992F  ·  EB-992F EEB  ·  EB-992 F EEB
```

Ahora hay tres niveles, y ninguno sobra:

```
tipo (Ordenador)  +  modelo (Lenovo · U3302)  +  nº de serie
─────────────────    ────────────────────────    ─────────────
qué clase de cosa    exactamente cuál            cuál de ellas
```

El tipo ordena la revisión, el modelo agrupa para comprar y para diagnosticar, y
el número de serie identifica el aparato concreto, que se lleva su historia
consigo cuando lo cambian de aula. Los tres salen juntos en la revisión, en el
inventario de la sala, en la ficha del aula, en el histórico y en la bandeja del
coordinador — «Ordenador Lenovo U3302 · S/N 2440634LG».

El catálogo de modelos tiene **las mismas defensas** que el de tipos, porque es el
mismo problema: id derivado del nombre (uuid v5), para que dos técnicos sin
cobertura que registren el mismo «Epson EB-992F» generen literalmente la misma
fila; índice único sobre el nombre normalizado; alias; y fusión con lápida para
los duplicados de vocabulario que el índice no ve. El id se calcula igual en el
cliente y en SQL —`uuid_v5()` es gemela de `uuid.v5()`— y hay una prueba que lo
comprueba, porque si dejan de coincidir el catálogo se duplica sin decir nada.

**La fecha de instalación no se pide: se pone sola.** La escribe el dispositivo
con su reloj —igual que todo lo demás del proyecto, que es lo que hace que
funcione sin cobertura— y se puede corregir, porque durante un levantamiento la
respuesta correcta casi nunca es hoy: el aparato lleva años ahí. Al mover un
equipo de aula se renueva. Los 1.094 equipos que entraron con la importación se
quedan **sin fecha** a propósito: todos comparten la del despliegue, y ponerla
sería inventarse un dato con pinta de cierto.

### Personalizable sin desplegar

Cada tipo de equipo declara qué campos quiere guardar, y la interfaz los pinta
sola:

```json
[{"clave":"lumenes","etiqueta":"Lúmenes","tipo":"numero","unidad":"lm","en":"modelo"},
 {"clave":"ram","etiqueta":"RAM","tipo":"numero","unidad":"GB","en":"ambos"}]
```

`en` decide dónde vive el dato: `modelo` si vale para todas sus unidades —la
resolución de un EB-992F es la misma en las cuarenta aulas—, `equipo` si es de la
unidad concreta, `ambos` si el modelo pone el valor de fábrica y una unidad puede
contradecirlo. Cuatro tipos de campo: texto, número, fecha y sí/no. Lo que no
encaje cabe en las observaciones — un constructor de formularios completo es un
proyecto aparte y se paga en una pantalla que nadie entiende.

### La pestaña Inventario

«Almacén» pasa a ser **Inventario**, con tres vistas de la misma cosa:

- **Equipos** — el inventario entero, para trabajarlo sentado. Filtros por
  edificio, tipo y estado; chapas para «sin modelo», «sin nº de serie», «sin
  fecha» y «sin validar», que son la lista de tareas real; selección múltiple con
  asignación de modelo en bloque, y exportación a CSV de lo que se esté viendo.
  Sale del espejo local, así que funciona sin cobertura; en el móvil la misma
  lista se pinta como fichas en vez de como tabla.
- **Almacén** — el de siempre, sin un cambio.
- **Catálogo** — validar, corregir, fusionar y retirar modelos. Abre con los
  grupos que casi seguro son el mismo modelo, que con los datos reales es la mitad
  del trabajo.

Las decisiones que no se deshacen —fusionar, retirar del inventario, revocar un
dispositivo— piden confirmación con el **alcance delante**: cuántos equipos se
mueven, de cuántas salas. Y las de más alcance piden teclear una palabra: un
botón más no frena a un pulgar rápido; teclear, sí.

## Guías

- **[Guía del técnico](docs/guia-tecnico.md)** — una página, para quien revisa aulas.
- **[Guía de administración](docs/guia-administracion.md)** — editar datos, confirmar
  los nombres dudosos de la importación, usuarios, stock e informes.
- **[Despliegue con Postgres gestionado](docs/despliegue-postgres-gestionado.md)**

## Antes de producción

Lo verificado y lo que no, sin adornos.

**Comprobado de forma automática** (`npm run verify:all` y `npm run db:verify`):

- 157 pruebas de lógica de dominio, cifrado del PIN y bóveda de vinculación.
- 50 bloques de pruebas de RLS contra Postgres real, en los dos escenarios de despliegue,
  incluidas las de exposición pública, el freno a la fuerza bruta del PIN y el tope
  de dispositivos.
- La aplicación **arranca en un navegador real**, pinta y no da errores de
  consola (`npm run smoke`).
- Un PDF real generado y revisado página a página.

**Sin comprobar todavía — hay que hacerlo antes de dárselo a nadie:**

| Qué | Por qué importa |
|---|---|
| **La pila de Supabase nunca se ha levantado** | El `docker-compose.yml` está escrito pero jamás se ha ejecutado. Es lo primero que hay que probar |
| **El flujo completo contra un servidor real** | Alta con código, PIN, revisión, foto y sincronización. Cada pieza está probada por separado; juntas, no |
| **Ningún iPad ha abierto la aplicación** | Todo lo específico de iOS —límite de canvas, HEIC, `persist()`— sale de documentación, no de un dispositivo |
| **El worker de informes como servicio HTTP** | Solo se ha probado el render por línea de comandos, no el endpoint que llama `pg_cron` |
| **`admin-user.ts` contra un GoTrue real** | La lógica es directa, pero nunca ha hablado con el servicio |
| **Cero pruebas de interfaz** | Las 124 pruebas cubren dominio y criptografía. No hay ninguna de componentes |
| **Sin linter configurado** | Se retiró el script `lint` porque no existía configuración y fallaba siempre |

Nada de esto es un fallo conocido: es trabajo de verificación pendiente. La
diferencia importa, y conviene no confundirla con "está listo".

## Decisiones que conviene conocer

**El PIN no es la contraseña del servidor.** Cuatro dígitos son 10.000
combinaciones. Lo que hace es derivar una clave (PBKDF2, 310.000 iteraciones)
que descifra la sesión guardada en el dispositivo. Se valida en local, así que
**funciona en modo avión**, y un iPad perdido no da acceso.

**Nada pendiente vive solo en el móvil.** IndexedDB es un búfer para los minutos
sin cobertura. Los borradores se respaldan en el servidor en cuanto hay red, con
3 segundos de espera. Por eso la app **no necesita instalarse** en la pantalla de
inicio: aunque iOS limpiara el almacenamiento, el trabajo ya está a salvo.

**Sincronización solo en primer plano.** iOS no soporta Background Sync ni
Periodic Background Sync, así que la app no depende de ellos en ningún punto.

**Nada se corrige en silencio.** La importación registró 18 arreglos en
`import_fixes` con su valor original (fechas de 2005, `29-01-026`, resoluciones
anteriores a la apertura, duplicados). Lo que no se pudo interpretar con
confianza —208 filas— está en `import_quarantine` en vez de inventado.

**El histórico entra sin autor.** `by_user = NULL` y `source = 'import'`: el
Excel no dice quién hizo cada cosa, y atribuirlo falsearía justo la trazabilidad
que la app existe para dar.

## Pendiente de decisión

- **¿Qué es el edificio `BC`?** Aparece en 38 incidencias y en la Bolsa
  (`Monitor 86" (edificio BC)`) pero no en la hoja de estado. Está importado como
  edificio provisional marcado `needs_review`, junto a `CEFF`, `TM`, `S`, `G` y
  `CC`. La pantalla de administración permitirá fusionarlo o confirmarlo.
- **El dominio real.** El `.env.example` trae `aulas.tudominio.es` como
  marcador. Cámbialo por el vuestro en `DOMAIN` y `VITE_SUPABASE_URL`;
  `deploy.sh` comprueba que ambos coincidan, porque cambiar uno y olvidar el
  otro deja la app hablando con el host anterior.

## Informes

La cadena es **Postgres → ECharts SSR a SVG → HTML → WeasyPrint → Storage**, sin
Chromium en ningún punto. Como los gráficos salen ya vectorizados, la plantilla
no necesita ejecutar JavaScript, y eso permite usar WeasyPrint: unos 300 MB de
imagen en lugar de 1,5 GB y ningún proceso de navegador que vigilar. Si algún
día una plantilla necesitara JavaScript de verdad, el reemplazo es Gotenberg 8,
no un contenedor de Playwright a mano.

Los gráficos usan una paleta **validada**, no elegida a ojo: pasa las seis
comprobaciones de contraste, croma y separación bajo daltonismo en ambos temas.
Los colores de estado (ok / aviso / crítico) están reservados y nunca se
reutilizan como serie.

## Estructura

```
src/domain/       tipos y normalización compartidos con el importador
src/db/           espejo en IndexedDB y cola de salida
src/sync/         descarga del maestro y motor de subida
src/auth/         PIN, cifrado de sesión, bóveda de vinculación y dispositivos
src/features/     pantallas por área funcional
supabase/         migraciones, harness de pruebas y seed generado
src/integrations/ puerto de tickets externos (ServiceNow en el futuro)
scripts/          importador del Excel y verificación de base de datos
reports-worker/   informes PDF y alta de usuarios, con su Dockerfile
Caddyfile         TLS por DNS-01, PWA y proxy de API en un solo origen
docker-compose.yml  Supabase self-hosted, Caddy y worker
```
