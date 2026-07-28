# Plan — PWA de Mantenimiento de Aulas y Salas

## Contexto

Hoy el mantenimiento AV del campus se gestiona con un único Excel de 5 hojas. Del análisis del fichero que has enviado (`Material_Aulas__Salas_de_reuniones.xlsx`) salen los problemas concretos que esta app tiene que resolver:

| Hoja | Contenido | Problema detectado |
|---|---|---|
| `Estado Aulas y Salas de reunion` | 295 salas, 23 edificios, equipamiento + fechas de revisión | Columnas SÍ/NO con **8 variantes** (`si`, `SI`, `Si`, `SÍ`, `NO`, `no`, `No`, vacío). Typos consolidados: `Actaulizada`, `EDIFICO E`. La columna `Microfono Jabra` mezcla booleanos, marcas (`Sennheiser`) y nºs de serie (`294150186`) |
| `Material Instalado 2026` | 96 incidencias | Fechas rotas guardadas como texto: `29-01-026`, `27-03-296`, `1902-26`. Material usado en texto libre: `1 lampar`, `2 cables Hdmi 10mts Fibra` |
| `Material Instalado 2025` | 186 incidencias | Tiene una columna `Observación` que 2026 no tiene → las hojas ya divergieron |
| `Bolsa 2026` | 43 artículos de almacén | **`Total Instalado` = 0 en todos los artículos**, con 96 incidencias que sí consumieron material. El stock no se descuenta |
| `Bolsa 2025` | 39 artículos | `Pantalla proyección 2,40x2,40` tiene **stock −2**. Nombres distintos a los de 2026 (`Cable HDMI Fibra 7,5 metros` vs `Cable HDMI 7,5 mts`) |

Las hojas de registro de mantenimiento (`Material Instalado 2025/2026`) además referencian salas que ni siquiera existen en la hoja de inventario, con nomenclaturas propias e incompatibles. **No se importan ni se usan como fuente**: son precisamente el motivo de arrancar limpio. La referencia es la hoja de inventario y nada más. Y sobre todo, hoy no hay trazabilidad: es imposible saber quién revisó qué ni cuándo cambió un dato.

El objetivo es una PWA instalable que funcione sin cobertura en sótanos y pasillos (`PLANTA -2`, `LAB CRIMINOLOGÍA`), guarde sola, sincronice al recuperar red, y deje registro de quién hizo cada cosa.

## Decisiones ya cerradas contigo

| Decisión | Elección |
|---|---|
| Backend | Next.js + Postgres, arquitectura ligera (no los 12 servicios de Supabase) |
| Despliegue | **Skyway (vuestro Docker) en producción**; Railway como entorno de pruebas desde GitHub |
| Dispositivos | Android + iPhone/iPad + Windows |
| Login | Email + contraseña, y **PIN de 4 dígitos** para reabrir en campo |
| Roles | `operador` (todos hacen de todo) + `lector` (solo lectura) |
| Datos iniciales | **Base limpia.** Del Excel se toma solo el *esquema* de la hoja de inventario, más 2-3 salas recientes de ejemplo. Las hojas de registro de mantenimiento **no se importan**: ni sus salas, ni sus edificios, ni su histórico |
| Catálogo de almacén | Se siembran los **nombres** de artículo como catálogo editable, **con existencias a cero**. Empezar limpio significa sin saldos históricos, no volver a teclear 43 artículos. Si prefieres el catálogo también vacío, se quita |
| Fotos | **WebP** a calidad 0,8, máx. 1600 px, comprimidas en el dispositivo antes de encolar |
| Incidencias | Código de ticket externo (`I260102_0002`) **introducido a mano**, sin numeración propia |
| Alta manual | **Desde la ficha de la sala**, sin necesidad de revisión ni de que nada haya fallado. Tres tipos: incidencia · solicitud · observación |
| Borradores | Basta **la sala** para guardar; todo lo demás se rellena después. Se completan desde una **bandeja de borradores** propia |
| Checklist | **6 bloques fijos + botón "Todo correcto"**. Revisión por excepción |
| Inventario en revisión | Sección **plegada** al final: añadir equipo y corregir el existente sin salir de la revisión |
| Autocompletado | Escribes y **se autoselecciona** lo que ya existe. Si de verdad es nuevo, el tipo se crea **«pendiente de validar»** |
| Duplicados | Numeración automática (`Monitor 2`) con **etiqueta editable** (`Monitor atril`) |
| Correcciones | Corregir modelo/serie · marcar averiado · marcar retirado o ausente · **mover a otra sala** |
| Informes | Archivo histórico descargable en la app + constructor de informes bajo demanda. **Sin email** |
| IA (Gemini) | OCR de nºs de serie · normalización de material a línea de stock · resumen narrativo semanal |
| Identidad | **UUID v7 generado en cliente** para todo. Nombres de salas y edificios **editables**, sin romper histórico |
| Aviso de revisión | Salas sin revisar **más de 1 mes** (umbral configurable) |
| Inteligencia | Índice de fiabilidad por sala, detección de reincidencia, predicción de lámpara y stock, rutas y anomalías |
| Integridad | Confirmación por operación, hashes, reconciliación, panel de estado del dato y copias verificadas |

**Fuera de alcance** (no lo marcaste, lo dejo anotado por si lo quieres luego): envío automático por email (necesitaría SMTP), exportación al formato Excel actual, y OCR de horas/% de lámpara.

---

## Arquitectura

```
┌─ PWA (navegador, instalable) ──────────────────┐
│  React 19 · Dexie/IndexedDB · Service Worker   │
│  Autoguardado local → cola de salida (outbox)  │
└───────────────┬────────────────────────────────┘
                │ HTTPS · push/pull idempotente
┌───────────────▼────────────────────────────────┐
│  Next.js 15 (App Router) — un solo contenedor  │
│  Auth · API sync · informes PDF · Gemini       │
└──────┬──────────────────────────┬──────────────┘
       │                          │
  ┌────▼─────┐            ┌───────▼────────┐
  │ Postgres │            │  Almacenamiento │
  │    16    │            │  S3 o volumen   │
  └──────────┘            └─────────────────┘
```

**Stack:** Next.js 15 · TypeScript · Tailwind v4 + shadcn/ui (Radix, accesible) · Drizzle ORM · Auth.js v5 + argon2 · Dexie 4 · Serwist (service worker) · `@react-pdf/renderer` (PDF sin Chromium — mantiene la imagen Docker pequeña y evita el mayor foco de fallos en contenedores) · Recharts · Zod · `@google/genai`.

### Despliegue

- **`Dockerfile`** multi-etapa con `output: 'standalone'` de Next.js. Sirve tanto para Skyway como para Railway.
- **`docker-compose.yml`** para Skyway: `app` + `postgres` + `minio` + volúmenes nombrados y healthchecks.
- **`railway.json`** para el entorno de pruebas, con auto-deploy desde GitHub.
- **GitHub Actions**: lint → typecheck → tests → build de imagen → push a GHCR. Skyway hace pull de la etiqueta.
- **Migraciones** con Drizzle, ejecutadas en el arranque del contenedor (`drizzle-kit migrate` antes de `next start`), idempotentes.
- **Almacenamiento de fotos**: interfaz `StorageDriver` con dos implementaciones — `s3` (MinIO/Garage/Ceph, vía `@aws-sdk/client-s3`) y `fs` (volumen montado). Se elige con `STORAGE_DRIVER`. Así conectas Skyway sin tocar código de aplicación.

---

## Modelo de datos

Tablas principales (`src/db/schema/`):

- **`buildings`** — code, name, orden. Se dan de alta desde la app, editables. La hoja de inventario sirve solo como referencia de nomenclatura.
- **`zones`** — planta/módulo/área por edificio. Tabla propia, no texto suelto: es justo lo que hoy produce `1ª PLANTA` vs `1ª  PLANTA` en el Excel.
- **`rooms`** — building_id, zone_id, code, nombre, tipo (aula/sala_reunion/laboratorio/despacho), estado. Único por (building, code) y con `code_normalized` para que `1.4 O` y `1.4O` no se dupliquen.
- **`equipment_types`** — catálogo derivado de las columnas del Excel: proyector, tv, monitor, monitor_aux, ordenador, camara, altavoces, microfono, botonera, screenbeam, barco, panacast, pantalla_proyeccion. Añade `bloque` (a cuál de los seis pertenece), `aliases text[]` —lo que alimenta el autocompletado: escribir `jab` encuentra *Micrófono Jabra*— y `estado` (validado / **pendiente_validacion**) con autor y fecha.
- **`equipment`** — *el aparato físico*: UUID, type_id, modelo, nº serie. **Su identidad no depende de la sala.**
- **`room_equipment`** — *la asignación*: equipment_id, room_id, `etiqueta` (editable), `indice` (el `2` de `Monitor 2`), `desde`, `hasta`, `estado` (instalado / averiado / retirado / ausente), y la `revision_id` que lo dio de alta o lo modificó.

**Por qué se separa el aparato de su asignación.** Con una sola tabla, mover un proyector de aula sería sobrescribir un campo y perder de dónde vino. Separándolo, **mover es cerrar una asignación y abrir otra**, y el aparato conserva su historial completo de ubicaciones. Además hace trivial una de las anomalías que el plan ya promete detectar —*el mismo número de serie apareciendo en dos salas*— que con el modelo anterior habría sido una consulta incómoda. Sustituye a las 12 columnas de serie de la hoja `Estado Aulas`.
- **`stock_items`** — *almacén*: nombre, categoría, unidad, **umbral mínimo**, `aliases text[]` (alimenta el matcher de IA con las variantes reales del Excel).
- **`stock_movements`** — **kardex append-only**: item, cantidad ±, motivo (compra/consumo/ajuste), incident_id, revision_id, usuario, fecha. El stock disponible es una **vista `SUM()`, nunca un contador guardado**. Esto es lo que hoy está roto (`Total Instalado = 0` con 96 consumos) y es imposible que vuelva a descuadrar.
- **`revisions`** — room_id, usuario, estado (borrador/completada), inicio/fin, `client_uuid` (idempotencia), device_id, resultado global, observaciones.
- **`revision_checks`** — un registro por bloque: `bloque` (pantallas/microfono/red/sonido/proyector/botonera), `resultado` (ok/ko/na), `detalle jsonb`, nota. En `proyector` el detalle guarda horas y % de lámpara → serie histórica por sala.
- **`revision_photos`** — clave de almacenamiento, miniatura, dimensiones, bytes, subida (bool).
- **`incidents`** — room_id, `codigo_externo` (tecleado, **anulable**), `tipo` (incidencia/solicitud/**observación**), `origen` (revisión/manual), apertura/resolución, problema, resolución, `estado` (**borrador**/abierta/en_curso/resuelta/cerrada), prioridad, asignado, y `revision_id` opcional para enlazar con la revisión que la detectó.
  - **Solo `room_id` es obligatorio.** Todo lo demás puede quedar vacío mientras el estado sea `borrador`: es lo que permite registrar en el pasillo y completar luego, cuando llegue el código de ticket.
  - Para salir de `borrador` sí se exige descripción; el `codigo_externo` sigue siendo opcional, porque una **observación** no genera ticket externo.
  - El tipo **observación** es la pieza que hoy os falta: en el Excel actual, notas como `soporte altavoz izq flojo` o `Pizarra abombada` viven en una columna de texto libre y no se les sigue la pista. Aquí son registros con estado, responsable y fecha, y se pueden **promover a incidencia** si el asunto crece, conservando su historia.
- **`users`** — email, `password_hash` (argon2id), `pin_hash`, nombre, rol, activo.
- **`audit_log`** — tabla, registro, acción, usuario, fecha, `diff jsonb`, origen (app/sync/import).

**La auditoría se implementa con triggers de Postgres, no en código de aplicación.** Es la única forma de que también capture las escrituras que llegan por sincronización y las correcciones manuales en base de datos. Cubre el requisito de "quién ha actualizado o modificado" sin que se pueda escapar nada.

---

## Identidad estable y nombres editables

Regla que atraviesa todo el sistema: **el nombre es una etiqueta, nunca la identidad.**

- **Toda entidad lleva UUID v7 como clave primaria**, generado **en el cliente**. Esto no es un detalle: si el ID lo asignara el servidor, una revisión creada sin cobertura tendría un ID provisional que habría que remapear al sincronizar, y todas sus fotos e incidencias asociadas apuntarían a un ID que deja de existir. Es el fallo clásico de las apps offline. Con UUID v7 el registro nace con su identidad definitiva, sin red. (v7 y no v4 porque es ordenable por tiempo, lo que mantiene los índices de Postgres eficientes.)
- **Renombrar un edificio o una sala es una edición normal**, disponible para el rol `operador` desde la ficha. Cambiar `EDIFICIO P` a otro nombre, o `1.4` a `1.4 bis`, no rompe absolutamente nada: ni el histórico de revisiones, ni las incidencias, ni el consumo de material, ni los informes ya emitidos.
- **El cambio de nombre queda auditado** con valor anterior y nuevo, autor y fecha. La ficha de cada sala muestra su historial de nombres, así que un informe antiguo que hable de `1.4` sigue siendo rastreable.
- **Los informes archivados congelan el nombre del momento de su generación.** Un PDF de enero no puede cambiar en junio porque alguien renombrara una sala: eso invalidaría un documento ya emitido.
- **Referencia legible aparte del UUID**: cada sala tiene además un código corto estable (`SALA-000142`) para hablar por teléfono o imprimir. Es inmutable aunque el nombre cambie.
- **Etiquetas QR en la puerta.** El QR codifica el UUID, así que sobrevive a cualquier renombrado. El técnico escanea al entrar y la revisión se abre directamente en esa sala, sin seleccionar edificio ni planta. Es el camino más corto posible entre llegar a la puerta y empezar a trabajar. La app genera las hojas de etiquetas imprimibles.
- Fusionar dos salas duplicadas o dar de baja una es una operación explícita con reasignación de histórico, nunca un borrado.

---

## Sincronización offline

El punto crítico: **iOS no soporta Background Sync** y limita la cuota de caché (~50 MB). Como usáis iPad e iPhone, la sincronización **no puede depender de él**. Diseño:

1. **Autoguardado local primero.** Cada cambio de campo escribe en IndexedDB con *debounce* de 300 ms. No hay botón de "guardar" para el borrador; si se cierra la app a mitad de una revisión, al volver está todo.
2. **Cola de salida (outbox).** Cada operación lleva `client_uuid`. El servidor hace *upsert* por esa clave → reenviar la misma operación 5 veces no duplica nada.
3. **Disparadores de sincronización** (todos, no solo uno): evento `online`, `visibilitychange` a visible, foco de ventana, temporizador de 60 s con red, y botón manual. Background Sync se registra **solo como mejora** donde exista (Android/Chrome).
4. **Descarga incremental.** `GET /api/sync/pull?since=<seq>` contra un `change_log` con secuencia monótona. Devuelve cambios + cursor nuevo.
5. **Conflictos.** Las revisiones tienen un único dueño → última escritura gana. Los movimientos de stock son *append-only* → no pueden entrar en conflicto por diseño. Las incidencias sí son editables por varios: última escritura gana **por campo**, y si la versión del servidor cambió respecto a la base del cliente, se muestra un aviso de conflicto con ambas versiones antes de sobrescribir.
6. **El catálogo viaja al dispositivo.** Tipos, alias y modelos conocidos se descargan a IndexedDB, porque el autocompletado tiene que funcionar en un sótano sin cobertura. Son decenas de tipos y unos cientos de modelos: cabe de sobra.
7. **La numeración automática es una etiqueta, no una identidad.** `Monitor 2` se calcula con lo que el dispositivo sabe en ese momento. Si dos técnicos añaden un monitor a la misma sala sin cobertura, ambos crearán un `Monitor 2` y al sincronizar habrá dos. **No es un fallo de datos**: cada aparato tiene su UUID y su número de serie, que es lo que los distingue de verdad; el servidor renumera al detectar el choque y avisa por si conviene reetiquetar a mano. Merece la pena decirlo porque es el precio de permitir alta sin red, y es un precio barato.
8. **Fotos en WebP.** Se comprimen **en el cliente antes de encolar**: máx. 1600 px, **WebP a calidad 0,8**, vía `createImageBitmap` + `canvas.toBlob('image/webp')`. Frente a JPEG equivalente pesan un 25-35 % menos, lo que es determinante con la cuota de iOS y con conexiones malas en sótanos. Salida típica ~150-200 KB por foto. Se mantiene una reserva automática a JPEG si el navegador no sabe **codificar** WebP (Safari solo lo hace desde iOS 16.4; decodificar lo hace desde iOS 14). Se guardan como Blob en IndexedDB y se suben en una cola aparte de los JSON, con reintentos y barra de progreso. Se pide `navigator.storage.persist()` y se avisa si la cuota disponible baja del umbral.

---

## Persistencia y garantía de que el dato llega bien

No basta con enviar: hay que **demostrar** que llegó íntegro. Un `HTTP 200` solo dice que el servidor recibió la petición, no que la haya guardado.

1. **Confirmación por operación, no por petición.** El servidor responde con el estado individual de cada operación del lote, emitido **después** de confirmar la transacción en Postgres. Una operación sale de la cola local únicamente con esa confirmación. Si el envío se corta a mitad, lo no confirmado se reintenta.
2. **Huella de integridad.** El cliente calcula un hash SHA-256 del contenido de la revisión. El servidor lo recalcula sobre lo que ha guardado y lo devuelve. Si no coincide, la operación se marca como fallida y se reenvía — protege contra truncamientos y corrupciones silenciosas en tránsito.
3. **Reconciliación periódica.** En cada sincronización el cliente pregunta `POST /api/sync/verify` con la lista de IDs y hashes que cree tener enviados. El servidor responde qué falta o difiere. Detecta el caso peligroso: el cliente cree que envió, el servidor no lo tiene.
4. **Panel de estado del dato**, visible y honesto: *pendientes · enviadas · confirmadas · con error*, cada una con su detalle, el mensaje de error real y un botón de reintento manual. Nada de estados ambiguos tipo "sincronizando…" indefinido.
5. **Retención local tras confirmar.** Lo sincronizado **no se borra del dispositivo inmediatamente**: se conserva 30 días. Durante ese tiempo el móvil actúa como copia de seguridad si algo fallara en servidor.
6. **Fotos verificadas.** Tras subir se comprueba tamaño y hash contra el original. Una foto no se marca como subida hasta que el servidor confirma que la almacenó completa.
7. **Copias de seguridad en servidor.** `pg_dump` diario automático con retención de 30 días, más las fotos. **La restauración se prueba y se documenta** — una copia que nunca se ha restaurado no es una copia. Incluye un comando de verificación de integridad que contrasta contadores entre tablas relacionadas.
8. **Salvaguarda de exportación.** Cualquier vista o informe se puede volcar a CSV/Excel en cualquier momento, para que los datos nunca queden atrapados dentro de la aplicación.

---

## Diseño de interfaz

Principio rector: **el técnico está de pie, en un pasillo, con una mano ocupada y quizá sin cobertura.** Todo se subordina a eso.

- **Revisión en 3 toques.** Edificio (recuerda el último) → Sala (ordenadas por *más tiempo sin revisar* primero) → **"Todo correcto"**. Una revisión sin incidencias se cierra en unos 5 segundos. Solo despliegas y detallas el bloque que falla.
- **Un único lenguaje de control.** Los 6 bloques usan exactamente el mismo control de tres estados: **OK / FALLA / N/A**. Objetivos de 48 px mínimo, zona pulgar en la mitad inferior. Nada depende de `hover`.
- **Nunca solo color.** Verde/ámbar/rojo/gris siempre acompañados de icono y texto — hay daltonismo en cualquier equipo y las pantallas se ven mal con proyector encendido.
- **Estado de conexión siempre visible y explícito.** Una barra fina permanente: `3 revisiones pendientes de enviar`. Nunca ocultar que hay datos sin sincronizar.
- **Modo oscuro real**, no un filtro: se trabaja en aulas a oscuras.
- **Botón "Abrir incidencia" dentro del bloque que falla** — el reactivo. Precarga sala, bloque, fecha y usuario; solo queda pegar el código de ticket y describir.
- **Alta manual desde la ficha de la sala** — el proactivo, que no depende de que nada falle. Sirve para lo que hoy acaba en la columna de observaciones y se pierde: una pizarra abombada, un soporte flojo, una lámpara al 12 % que aún funciona, o una solicitud de material. La revisión no se ensucia con un botón más: su cabecera de sala lleva a la ficha de un toque, así que también se puede registrar a mitad de revisión.
- **Guardar con solo la sala.** Un toque deja el borrador creado y sincronizable; el resto se rellena cuando haya tiempo o llegue el código de ticket. Nada obliga a teclear en el pasillo.
- **Bandeja de borradores** — pantalla propia con las incidencias sin completar, ordenadas por antigüedad, pensada para despacharlas en lote desde el escritorio. Es la contrapartida honesta de permitir guardar con un solo campo: si se puede aplazar, tiene que haber un sitio evidente donde se acumula lo aplazado.
  - Descartaste el contador en el cuadro de mando, el aviso al cerrar la revisión y el bloqueo. Lo dejo así, pero conviene saber el riesgo: **los borradores solo se ven si alguien entra en la bandeja**. Si dentro de unos meses se acumulan sin completar, añadir el contador al cuadro de mando es un cambio de una tarde. La pestaña llevará el número de pendientes para que al menos se vea desde la navegación.
- **Sección "Inventario" al final de la revisión, plegada por defecto.** Muestra solo `7 equipos · añadir o corregir`. Esto es innegociable: la promesa de cerrar una sala en cinco segundos con "Todo correcto" no puede pagarla una lista de equipos desplegada que hay que sortear cada vez. Se abre únicamente cuando el técnico ve algo que no cuadra.
  - **Añadir escribiendo, con autoselección.** Tecleas `mon` y aparece *Monitor*; `jab` encuentra *Micrófono Jabra* por sus alias. Si eliges uno existente, se reutiliza el tipo del catálogo. Solo si de verdad no existe se crea **pendiente de validar**, y un admin lo confirma o lo fusiona después. Es lo que impide repetir la historia de las ocho variantes de SÍ/NO.
    - Esos tipos pendientes se revisan en la **bandeja** que ya existe para los borradores, en su propia pestaña. Mismo principio: si el sistema permite aplazar una decisión, tiene que haber un sitio evidente donde se acumula lo aplazado. Un tipo sin validar funciona con normalidad mientras tanto; solo queda marcado.
  - **El segundo monitor se llama `Monitor 2` sin teclear nada**, y la etiqueta se puede reescribir a `Monitor atril` cuando importe distinguirlos.
  - **Basta el tipo para darlo de alta.** Modelo y número de serie son opcionales y se completan luego — misma regla que los borradores de incidencia, para no obligar a teclear de pie. El OCR de etiquetas ya previsto vive justo aquí.
  - **Corregir lo que ya está**: modelo o número de serie, marcar **averiado** (instalado pero no funciona), marcar **retirado o ausente** (el inventario dice que hay proyector y ya no está), y **mover a otra sala**. Sin la baja, el inventario solo crece y nunca se depura.
  - Marcar un equipo como averiado **ofrece** poner su bloque en FALLA y abrir incidencia; no lo hace solo. Sugerir está bien, decidir por el técnico no.
- **Cuadro de mando**: KPIs (salas revisadas este mes, incidencias abiertas, salas con problemas, artículos bajo mínimo) + gráficos de incidencias por edificio, evolución mensual y distribución del % de lámpara. Se construye con la skill `dataviz` para que la paleta sea consistente y accesible en claro y oscuro.
- **Alertas**, ordenadas por urgencia real, no por fecha de creación:
  - **Salas sin revisar más de 1 mes** (umbral configurable global y por sala; 30 días por defecto). Aviso honesto: con vuestra cadencia actual —2-3 revisiones al año— el primer día se marcarán casi todas. Por eso la lista se ordena por *días de retraso* y el primer ciclo se puede escalonar por edificios, en vez de mostrar 295 alertas rojas a la vez.
  - Incidencias abiertas más de N días.
  - Stock por debajo del mínimo.
  - Lámparas por debajo del 15 % (en el Excel actual hay salas al 2 %, 5 %, 7 % y 9 %).
  - Salas marcadas como problemáticas por el motor de recomendaciones.

Antes de escribir la aplicación entregaré un **prototipo HTML interactivo navegable** (usando las skills `artifact-design` y `dataviz`) con las cuatro pantallas clave — revisión, sala, cuadro de mando e informe — para que valides la experiencia antes de que exista código de producción.

---

## Informes

- **Generación automática diaria y semanal** mediante un job programado dentro del contenedor (`node-cron`), no del programador del proveedor. Motivo: los cron de plataforma pueden dejar de dispararse en silencio; el job es **idempotente y con recuperación**, así que al arrancar detecta y genera los informes que falten.
- **Archivo histórico** en la app: tabla `reports` con el PDF renderizado en almacenamiento, filtrable por fecha y tipo, descargable.
- **Constructor bajo demanda**: edificios, rango de fechas, tipo de incidencia, estado y material → PDF al momento.
- PDF con `@react-pdf/renderer`, gráficos incrustados como SVG generado en servidor. Portada, cabecera con logo, numeración de páginas y pie con fecha de generación y autor.

## Inteligencia: salas problemáticas y recomendaciones automáticas

Todo lo que sigue se calcula **con SQL, de forma determinista y auditable**. Cualquier cifra se puede pinchar y ver de qué registros sale. La IA solo interviene, si acaso, para redactar el texto encima de números ya cerrados.

**Aviso honesto sobre los plazos:** como arrancamos con la base limpia, estas funciones se construyen desde el principio pero **no dan resultados útiles hasta acumular unos 2-3 meses de revisiones e incidencias reales**. Hasta entonces muestran su estado de forma explícita —*"datos insuficientes, faltan N revisiones"*— en lugar de inventar conclusiones sobre dos registros. Los ejemplos que cito abajo salen de vuestros Excel actuales y sirven para ilustrar qué detectará el sistema, no son datos que vayan a estar cargados el primer día.

**Índice de fiabilidad por sala.** Puntuación 0-100 a partir de: número de incidencias por periodo, gravedad, reincidencia del mismo tipo de fallo, tiempo medio de resolución y consumo de material. Se pondera por antigüedad, para que un mal semestre de hace dos años no marque una sala para siempre. Ranking de peores salas y peores edificios en el cuadro de mando.

**Los tres tipos no pesan igual, y esto importa.** Una **incidencia** penaliza la fiabilidad; una **observación** pesa mucho menos —es una nota de seguimiento, no una avería— y una **solicitud** (`Solicita instalar cámara y micrófono`) **no penaliza en absoluto**: es trabajo pedido, no un fallo de la sala. Si contaran igual, las salas más vigiladas saldrían como las peores solo por estar bien atendidas, y el ranking premiaría no registrar nada. Los borradores no puntúan hasta completarse.

**Detección de reincidencia — el hallazgo más rentable de vuestros datos.** El problema `No duplica la imagen del Pc del usuario en el monitor principal del aula` aparece decenas de veces en 2025 y 2026, y la resolución es casi siempre *sustituir el cable HDMI*. Cuando una misma sala repite el mismo tipo de fallo, sustituir la pieza otra vez no es la respuesta. La app lo detecta y lo dice:

> **1.7 H** — 4 sustituciones de HDMI en 6 meses. Sustituir de nuevo no resuelve la causa: revisar canalización, conectores de rosetas o longitud del tirado.

**Predicción de agotamiento de lámpara.** Con el histórico de horas y % que ya recogéis, se estiman las semanas restantes por proyector y se avisa **antes** de que la clase se quede sin imagen. Vuestro Excel tiene salas al 2 % y al 5 %: hoy eso se detecta cuando falla; con esto, tres semanas antes.

**Predicción de rotura de stock.** Sobre el kardex se proyecta el consumo y se avisa: *"al ritmo actual te quedas sin Cable HDMI Fibra 15 m en ~5 semanas"*. Vuestros datos de 2025 muestran 42 unidades consumidas de ese cable en un año, con 32 en stock ahora — es exactamente el caso.

**Agrupación de trabajo y ruta sugerida.** Las salas pendientes se agrupan por edificio y planta en una ruta eficiente, en vez de una lista plana que obliga a ir y volver. Y se detectan lotes: *"5 salas de EDIFICIO H con lámpara <20 % → una sola visita, un solo desplazamiento"*.

**Anomalías.** Saltos anómalos de horas de proyector entre revisiones (equipo que se queda encendido), salas con inventario incoherente respecto a otras equivalentes, y equipos con número de serie duplicado en dos salas.

Todo esto alimenta un bloque de **Recomendaciones** en el cuadro de mando y en el informe semanal, cada una con su justificación y el enlace a los registros que la sustentan. Ninguna recomendación aparece sin poder explicar por qué.

## IA (Gemini) — las tres funciones que elegiste

Todas se ejecutan **en servidor**, nunca con la clave en el cliente, y **siempre con confirmación humana** antes de escribir en base de datos.

1. **OCR de números de serie.** El técnico enfoca la etiqueta y la app rellena el campo. Es donde más errores hay hoy (`5310306901742`, `XDU95X00398`). Se valida contra el patrón conocido del fabricante antes de proponerlo.
2. **Normalización de material a línea de stock.** Convierte `2 cables Hdmi 10mts Fibra` o `1 lampar` en artículo del catálogo + cantidad, usando los `aliases` como contexto. Resuelve el descuadre entre incidencias y `Bolsa`. Si la confianza es baja, pide elegir en lugar de adivinar.
3. **Resumen narrativo semanal.** Un párrafo de contexto sobre el PDF. **Los números los calcula SQL; la IA solo redacta el texto sobre cifras ya cerradas** — no se le pide que cuente ni que sume nada.

Si falta `GEMINI_API_KEY`, las tres funciones se ocultan y la app funciona igual.

---

## Fases de entrega

| Fase | Contenido |
|---|---|
| **0** | Prototipo HTML interactivo de las 4 pantallas clave para validar UX |
| **1** | Esqueleto: repo, Dockerfile, docker-compose, Actions, Drizzle, migraciones, healthcheck |
| **2** | Auth (email+contraseña, PIN, roles `operador`/`lector`) + triggers de auditoría |
| **3** | Maestro editable: edificios, zonas, salas. **Aparato y asignación separados**, catálogo de tipos con alias y cola de validación. UUID v7, renombrado auditado, QR de puerta. Semilla con 2-3 salas de ejemplo |
| **4** | **Revisiones offline**: los 6 bloques, "Todo correcto", fotos, autoguardado, outbox, sync, y la **sección Inventario plegada** — alta con autocompletado, numeración automática, y las cuatro correcciones (modelo/serie, averiado, retirado, mover) |
| **5** | **Garantía de entrega**: confirmación por operación, hashes, reconciliación, panel de estado del dato, copias de seguridad |
| **6** | Incidencias: los tres tipos, alta reactiva desde el bloque que falla, **alta manual desde la ficha de sala**, borradores con solo la sala, **bandeja de borradores** y alertas (30 días) |
| **7** | Almacén: catálogo, kardex, mínimos, consumo enlazado a incidencias |
| **8** | Cuadro de mando + informes automáticos + constructor + archivo |
| **9** | **Inteligencia**: fiabilidad por sala, reincidencia, predicción de lámpara y stock, rutas, anomalías |
| **10** | Gemini: OCR de series, normalización de material, resumen semanal |
| **11** | Endurecimiento: tests E2E offline, presupuesto de rendimiento, docs |

## Documentación (`docs/`)

`ARQUITECTURA.md` · `MODELO-DATOS.md` (con diagrama) · `SINCRONIZACION.md` (protocolo, matriz de conflictos y garantía de entrega) · `IDENTIDAD-Y-NOMBRES.md` (por qué UUID v7 en cliente y cómo funciona el renombrado) · `INTELIGENCIA.md` (fórmulas de fiabilidad y predicción, con su SQL) · `COPIAS-Y-RESTAURACION.md` (procedimiento probado) · `DESPLIEGUE-SKYWAY.md` · `DESPLIEGUE-RAILWAY.md` · `MANUAL-TECNICO.md` (guía de campo, con capturas) · `MANUAL-ADMIN.md` · `IA-GEMINI.md` (prompts y límites) · `DECISIONES.md` (registro de decisiones de arquitectura).

## Verificación

- **Offline de verdad**: Playwright con `context.setOffline(true)` — completar una revisión con 3 fotos sin red, cerrar la pestaña, reabrir, restaurar red y comprobar que llega íntegra al servidor.
- **Idempotencia**: enviar la misma operación 5 veces y verificar que solo existe un registro.
- **Entrega verificada**: cortar la conexión a mitad del envío y comprobar que lo no confirmado se reintenta y que el hash del servidor coincide con el del cliente. Simular una respuesta 200 que no persiste y verificar que la reconciliación lo detecta.
- **Renombrado sin daño**: renombrar edificio y sala con revisiones, incidencias, fotos e informes ya emitidos; nada debe romperse y el PDF archivado debe conservar el nombre antiguo.
- **Auditoría**: modificar una incidencia por API y por SQL directo; el trigger debe registrar ambas, incluidos los cambios de nombre.
- **Stock**: propiedad invariante — `SUM(movimientos)` siempre igual al stock mostrado, con movimientos concurrentes.
- **Borrador mínimo**: crear una incidencia sin red aportando **solo la sala**, cerrar la app, reabrir, recuperar cobertura y comprobar que llega íntegra, aparece en la bandeja de borradores y se puede completar meses después sin perder autor ni fecha original.
- **Los tipos no se confunden**: una solicitud y una observación no deben empeorar el índice de fiabilidad de la sala; una incidencia sí. Un borrador no puntúa hasta completarse.
- **Autocompletado sin red**: en modo avión, escribir `jab` debe encontrar *Micrófono Jabra* por sus alias y reutilizar el tipo existente, no crear uno nuevo. Solo un término realmente desconocido debe generar un tipo `pendiente_validacion`.
- **La revisión rápida no se ralentiza**: con la sección Inventario presente, cerrar una sala con "Todo correcto" debe seguir siendo el mismo número de toques que antes. Se mide.
- **Mover conserva la historia**: trasladar un proyector de una sala a otra debe cerrar la asignación de origen, abrir la de destino y dejar el aparato con su historial completo de ubicaciones, sin perder revisiones ni incidencias anteriores.
- **Choque de numeración offline**: dos dispositivos sin red añaden un monitor a la misma sala; al sincronizar deben existir los dos aparatos, distinguibles por UUID y número de serie, con el aviso de reetiquetado. Ninguno se pierde ni se fusiona solo.
- **Recomendaciones**: sobre un conjunto de datos sintético con un patrón de reincidencia conocido, el motor debe señalar exactamente esa sala y no otras; toda cifra mostrada debe cuadrar con su consulta SQL.
- **Restauración**: restaurar una copia de seguridad en limpio y verificar contadores por tabla frente al origen.
- **Dispositivos reales**: recorrido completo en Safari/iOS (el caso restrictivo), Chrome/Android y Edge/Windows.
- **Accesibilidad**: axe sin violaciones críticas, contraste AA en claro y oscuro, navegación completa por teclado.
- **Arranque en limpio**: `docker compose up` sobre volumen vacío debe dejar la app usable con el usuario administrador inicial.
