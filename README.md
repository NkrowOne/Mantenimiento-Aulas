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

## Puesta en marcha

```bash
npm install
cp .env.example .env          # apunta a tu Supabase self-hosted
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
- **El certificado HTTPS.** Con red interna + VPN, sin HTTPS válido no hay
  service worker y sin service worker no hay modo offline. Hace falta un
  hostname real (no una IP: Let's Encrypt no emite certificados de IP por
  DNS-01) con DNS split-horizon, o bien Tailscale.

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
```
