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
npm run admin:user -- crear --email tu@correo.es --nombre "Tu nombre" --primer-admin
```

`deploy.sh` valida la configuración **antes** de levantar nada: un despliegue
que arranca a medias y falla en el tercer servicio cuesta mucho más de
diagnosticar que uno que se niega a empezar diciendo qué falta.

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
npm run admin:user -- crear  --email ana@x.es --nombre "Ana" --rol tecnico
npm run admin:user -- codigo --email ana@x.es      # si se pierde
npm run admin:user -- rol    --email ana@x.es --rol supervisor
npm run admin:user -- listar
```

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
```

Levanta un Postgres desechable, emula lo mínimo de Supabase, aplica las
migraciones, carga los datos reales y ejecuta las pruebas de RLS.

```bash
npm test          # 36 pruebas de lógica de dominio
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
| RLS, roles y auditoría | ✅ 8 pruebas en verde |
| Importador del Excel | ✅ 276 salas, 283 incidencias, 669 equipos |
| Núcleo offline (Dexie + cola de salida) | ✅ |
| Login con PIN que cifra la sesión | ✅ lógica probada |
| Flujo de revisión de salas | ✅ |
| Fotos con compresión | ✅ |
| Panel con alertas y gráficos | ✅ paleta validada en claro y oscuro |
| Incidencias, almacén y depuración de datos | ✅ |
| Worker de informes PDF | ✅ PDF real generado y revisado |
| Buckets de Storage y sus políticas | ✅ 3 pruebas de RLS propias |
| Despliegue: Compose, Caddy, claves, copias | ✅ |
| Alta de usuarios y códigos | ✅ |
| Integración con ServiceNow | 🔌 puerto listo, falta la implementación |

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
src/auth/         PIN, cifrado de sesión y alta de dispositivo
src/features/     pantallas por área funcional
supabase/         migraciones, harness de pruebas y seed generado
src/integrations/ puerto de tickets externos (ServiceNow en el futuro)
scripts/          importador del Excel y verificación de base de datos
reports-worker/   generador de informes PDF, con su Dockerfile
Caddyfile         TLS por DNS-01, PWA y proxy de API en un solo origen
docker-compose.yml  Supabase self-hosted, Caddy y worker
```
