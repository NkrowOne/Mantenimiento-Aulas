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
inmediatamente a una aleatoria fuerte que no se guarda en ningún sitio, así que
el código deja de valer y la única llave del dispositivo pasa a ser el refresh
token cifrado con el PIN.

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
npm test          # 148 pruebas de lógica de dominio y de la pantalla de informes
npm run typecheck
npm run build
```

### Generar un informe

```bash
cd reports-worker && npm install
DATABASE_URL=postgresql://... npm run render -- semanal informe.pdf

# Un periodo concreto, y solo algunas secciones
DATABASE_URL=... npm run render -- personalizado marzo.pdf 2026-03-01 2026-03-31
DATABASE_URL=... npm run render -- semanal x.html --secciones=resumen,analisis --sin-ia
```

Acepta `.html` como salida para iterar la plantilla sin WeasyPrint. En
producción lo levanta `docker compose up reports-worker`, lo despierta `pg_cron`
los viernes y se pide a mano desde la pantalla de Informes.

El cliente de la IA se prueba sin gastar clave, contra un servidor que habla
como la API de Gemini:

```bash
npm run informe:ia
```

## Qué está construido

| Área | Estado |
|---|---|
| Esquema append-only, vistas y alertas | ✅ verificado contra Postgres 16 |
| RLS, roles y auditoría | ✅ 46 bloques en verde, incluida exposición pública |
| Importador del Excel | ✅ 276 salas, 283 incidencias, 669 equipos |
| Núcleo offline (Dexie + cola de salida) | ✅ |
| Login con PIN que cifra la sesión | ✅ lógica probada |
| Flujo de revisión de salas | ✅ un equipo en «Falla» abre incidencia y sigue abierta hasta que se resuelve |
| Fotos con compresión | ✅ |
| Panel con alertas y gráficos | ✅ paleta validada en claro y oscuro |
| Incidencias, almacén y depuración de datos | ✅ la pestaña es la lista de trabajo; las observaciones se leen en la ficha del aula |
| Panel de administración: validar equipos, agrupar el catálogo, equipamiento por defecto y alta/baja de salas y edificios | ✅ |
| Worker de informes PDF | ✅ PDF real generado y revisado |
| Análisis con IA (Gemini, con razonamiento) | ✅ probado contra un servidor de mentira; degrada a análisis calculado |
| Buckets de Storage y sus políticas | ✅ 3 pruebas de RLS propias |
| Despliegue: Compose, Caddy, claves, copias | ✅ |
| Alta de usuarios y códigos | ✅ |
| Despliegue sobre Postgres gestionado | ✅ verificado en Postgres desnudo |
| Integración con ServiceNow | 🔌 puerto listo, falta la implementación |

## Guías

- **[Guía del técnico](docs/guia-tecnico.md)** — una página, para quien revisa aulas.
- **[Guía de administración](docs/guia-administracion.md)** — editar datos, confirmar
  los nombres dudosos de la importación, usuarios, stock e informes.
- **[Despliegue con Postgres gestionado](docs/despliegue-postgres-gestionado.md)**

## Antes de producción

Lo verificado y lo que no, sin adornos.

**Comprobado de forma automática** (`npm run verify:all` y `npm run db:verify`):

- 124 pruebas de lógica de dominio y cifrado del PIN.
- 40 bloques de pruebas de RLS contra Postgres real, en los dos escenarios de despliegue,
  incluidas las de exposición pública.
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

**El automático sale los viernes a las 07:00** con la semana de trabajo entera,
de lunes a viernes. Cualquier otro se pide a mano desde la pantalla de Informes,
eligiendo periodo, secciones, para quién está escrito y si el análisis lo
redacta la IA. Un informe emitido no se regenera nunca: se versiona.

Lleva las dos cosas que hacen falta para responder «¿cómo vamos?» y «¿qué se ha
hecho?»: el **estado** —indicadores con su variación, cobertura por edificio,
lámparas al límite, incidencias sin cerrar— y el **registro del periodo**, que
son la lista de todas las revisiones completadas (sala, hora, quién y cómo
salió) y el diario cronológico de lo que ocurrió cada día: altas, cierres,
material consumido, inventarios y cambios de equipo.

### El análisis lo escribe una IA; las cifras, no

La regla que hace que este documento se pueda firmar:

> **Las cifras se calculan con SQL. La IA solo escribe la prosa.**

Ni un número del informe sale del modelo. Los indicadores, las variaciones, los
umbrales y los avisos los calcula `analisis.ts` con operaciones que se pueden
seguir a mano. Al modelo se le entrega ese expediente ya cerrado y se le pide lo
que un modelo hace bien y una plantilla hace mal: decidir qué es lo importante de
esta semana y contarlo en español legible, sin repetir el mismo párrafo cincuenta
viernes seguidos. Si aparecen en su texto cifras de tres dígitos que no están en
el expediente, se descarta la redacción entera y se emite con la calculada.

Se usa **Gemini 3.6 Flash con razonamiento alto** (`thinkingLevel`, no el
`thinkingBudget` de la serie 2.5), con salida en JSON validada por esquema.

**El PDF no menciona en ninguna parte que haya pasado por un modelo**, y es una
decisión de quien firma el informe: el documento sale del servicio de
mantenimiento y habla del estado del campus, no de las herramientas con las que
se preparó — igual que no se imprime qué versión de Postgres contó las
incidencias. El rastro no se pierde: queda en `reports.params` con cada informe
y la pantalla de Informes lo enseña junto a cada entrada del archivo.

Eso traslada toda la responsabilidad al texto: sin etiqueta, lo único que puede
delatarlo es cómo está escrito. Por eso hay tres filtros y no uno:

1. **En el encargo.** Se prohíben con ejemplos los emojis, las negritas, las
   viñetas, los titulares con dos puntos y las fórmulas de relleno.
2. **Al recibir.** Se limpian los asteriscos, los emojis y los guiones de viñeta
   que se cuelan igual.
3. **Antes de imprimir.** Si aparecen dos fórmulas de relleno —«es importante
   destacar», «de cara a», «como modelo»— se descarta la redacción entera y sale
   la calculada. Un párrafo sobrio no levanta ninguna sospecha; uno que empieza
   por «es importante destacar» las levanta todas.

**Sin clave configurada el informe sale igual**, con el análisis calculado. No es
un modo degradado con un hueco: es un informe completo con otra voz. La clave se
pone en `GEMINI_API_KEY` o, si no hay acceso al servidor, desde la propia
pantalla de Informes con perfil de administrador — el entorno manda sobre la
base de datos si están las dos, y ni la pantalla ni la función `ia_estado()`
devuelven nunca su valor.

### La cadena

La cadena es **Postgres → análisis → ECharts SSR a SVG → HTML → WeasyPrint →
Storage**, sin Chromium en ningún punto. Como los gráficos salen ya vectorizados, la plantilla
no necesita ejecutar JavaScript, y eso permite usar WeasyPrint: unos 300 MB de
imagen en lugar de 1,5 GB y ningún proceso de navegador que vigilar. Si algún
día una plantilla necesitara JavaScript de verdad, el reemplazo es Gotenberg 8,
no un contenedor de Playwright a mano.

Los gráficos usan una paleta **validada**, no elegida a ojo: pasa las seis
comprobaciones de contraste, croma y separación bajo daltonismo en ambos temas —y
también sobre papel blanco, que es la superficie de este documento y no la de la
aplicación. Los colores de estado (ok / aviso / crítico) están reservados y nunca
se reutilizan como serie.

Dos cosas se hacen al revés que en pantalla, y a propósito: **el valor va escrito
sobre cada marca** —en un papel no hay ratón que enseñe el dato al pasar por
encima— y **se dibuja al tamaño real de impresión**, porque estirar un SVG
agranda también la tipografía de los ejes y deja de casar con el texto de al
lado.

La maquetación es de documento, no de panel: serif para lo que se lee seguido y
sans para lo que se consulta a saltos, una columna de lectura estrecha, los
indicadores en vertical al lado del texto y ni un emoji. Se revisa mirando el PDF
de verdad, que es donde se ven las cosas que no se razonan —una capitular que
tapa la segunda letra, dos rótulos de tabla que se leen como uno—.

## Estructura

```
src/domain/       tipos y normalización compartidos con el importador
src/db/           espejo en IndexedDB y cola de salida
src/sync/         descarga del maestro y motor de subida
src/auth/         PIN, cifrado de sesión y alta de dispositivo
src/features/     pantallas por área funcional
supabase/         migraciones, harness de pruebas y seed generado
src/integrations/ puerto de tickets externos (ServiceNow en el futuro)
scripts/          importador del Excel y verificación de base de datos
reports-worker/   informes PDF y alta de usuarios, con su Dockerfile
Caddyfile         TLS por DNS-01, PWA y proxy de API en un solo origen
docker-compose.yml  Supabase self-hosted, Caddy y worker
```
