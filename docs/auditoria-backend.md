# Auditoría del backend, del registro de datos y del worker

Auditoría del lado servidor: esquema y garantías de registro, el camino
cliente→servidor, y el worker de informes con lo que lo dispara solo.

**Método:** nada de lo que sigue se afirma por lectura del código. Cada hallazgo
de seguridad se **ejecutó contra un Postgres real** con el rol correspondiente, y
el comportamiento del worker se comprobó levantándolo y haciéndole peticiones.
Los números que aparecen son los que devolvió la base.

Todo lo de aquí está **corregido**, con pruebas que fallan si vuelve a ocurrir:
`npm run db:verify` (28 pruebas, 41 afirmaciones), `npm run worker:test` y
`npm run worker:periodos`.

**Los arreglos están plegados en las migraciones originales, no en migraciones
correctivas encima.** Se pudo hacer porque el sistema aún no estaba desplegado, y
era la última oportunidad: en cuanto haya una base en producción, el historial de
migraciones se congela. La ventaja es que quien lea `views.sql` ve la decisión de
seguridad **ahí**, junto a la vista, y no tres ficheros más adelante; y que el
esquema es correcto desde el primer `apply` en vez de tener una ventana —por
corta que sea— en la que las vistas filtran.

Este documento conserva el *por qué*, que es lo que no cabe en un comentario de
SQL.

---

## Lo grave: dos fugas de datos a Internet

### 1. Las vistas se saltaban la RLS por completo

Una vista de Postgres se ejecuta con los privilegios de **su propietario**, no
con los de quien la consulta. El propietario es `postgres`, que tiene
`BYPASSRLS`. Resultado: toda la RLS de las tablas quedaba anulada al leer por
una vista, y PostgREST publica las vistas igual que las tablas.

Medido con rol `anon`, sin ningún token — lo que puede hacer cualquiera desde
Internet contra `https://aulas.tudominio.es/rest/v1/room_overview`:

| Vista | Filas visibles para un anónimo |
|---|---|
| `room_overview` | **276** — todas las salas con su equipamiento |
| `stock_levels` | **111** — el almacén entero |
| `alerts_overdue_rooms` | **275** |
| `alerts_lamp_low` | **11** |
| `alerts_stale_incidents` | **2** — con el título de la incidencia |
| `incidents_by_building` | **9** |

**Por qué no lo cazó nadie.** La prueba de RLS nº 12 se llama «Un anónimo de
Internet no ve NADA» y pasaba en verde. Solo consultaba `rooms`, `incidents`,
`profiles` e `inspections`: las tablas base. Nunca las vistas. Es el caso de
manual de una prueba que da confianza en vez de darla merecida.

**Arreglo.** `security_invoker = on` en las diez vistas, que hace que se evalúen
con los permisos y la RLS de quien pregunta. Y la prueba 12 ahora consulta
también las vistas. Requiere Postgres 15; el compose despliega 15.8.

**Riesgo del arreglo, cubierto:** poner `security_invoker` podía dejar sin datos
a la propia aplicación, que lee de `room_overview` y `stock_levels`. La prueba 25
comprueba lo contrario de la 12 — que un técnico las sigue viendo.

### 2. Cualquiera podía disparar el worker de informes

`bootstrap_roles.sql:96` hace `alter default privileges … grant execute on
functions to anon, authenticated`, así que **toda función nace ejecutable por
anónimos**. Para las del catálogo eso da igual: comprueban el rol dentro y lanzan
excepción. Estas dos no comprobaban nada:

- **`request_report()`** — `security definer`. Con rol `anon` entró en el cuerpo
  y solo se detuvo porque el entorno de prueba no tiene `pg_net`. En producción
  sí lo tiene: un `POST /rest/v1/rpc/request_report` sin autenticar generaba un
  PDF. En bucle, tumba el worker y llena el bucket.
- **`link_tickets_by_ref()`** — `security definer` y hace un `UPDATE`. Con rol
  `anon` **se ejecutó entera**.

`merge_building` sí comprobaba `is_admin()`. El patrón estaba, no se aplicó.

**Arreglo.** Comprobación de rol dentro **y** `revoke execute … from public,
anon`. Las dos cosas, porque el `alter default privileges` volverá a conceder
execute a la próxima función que alguien escriba, y entonces solo quedará la
comprobación de dentro. Pruebas 20 y 21.

---

## Registro de datos

### 3. El informe «a medida» ignoraba las fechas que pedías

`ReportsPage` recogía «Desde» y «Hasta», los pasaba a la mutación… y ahí morían:
`request_report(kind)` no tenía parámetros de fecha. El worker recibía solo el
tipo y `periodFor('personalizado')` caía en la rama diaria.

**Un supervisor pedía marzo y recibía un PDF con los datos de ayer, etiquetado
«personalizado».** Un documento equivocado que parece legítimo es peor que un
error: se archiva y se cita.

**Arreglo.** La función acepta `p_start`/`p_end`, valida orden y tope de un año,
y los envía. `periodFor` lanza excepción para `personalizado` en vez de devolver
ayer en silencio. Prueba 26.

### 4. El catálogo de equipos no dejaba rastro de quién lo tocó

El bucle que instala la auditoría lista siete tablas (`auth_rls.sql:303`).
`asset_types` nació después, en la migración de inventario, y se quedó fuera.

Justo ahí es donde el coordinador confirma, renombra y **fusiona** — y fusionar
repunta los equipos de un tipo a otro. Era el único sitio del sistema donde una
decisión con consecuencias sobre el inventario no quedaba registrada con autor,
que es literalmente lo que se pidió al principio del proyecto.

**Arreglo.** Trigger de auditoría en `asset_types`. Prueba 22.

### 5. `reports` no tenía ninguna restricción única

El worker inserta con `on conflict do nothing` y el comentario dice «un informe
ya emitido no se regenera». No había con qué chocar: la única restricción era la
clave primaria, un uuid nuevo en cada inserción. Cada ejecución añadía una fila
más apuntando al mismo PDF.

**Arreglo.** Índice único por `(kind, period_start, period_end, content_hash)`,
que es la identidad real del documento. Prueba 23.

### 6. Un consumo de almacén podía ser positivo

`material_consumption_ranking` calcula `sum(-qty) where kind = 'consumo'`. La
única restricción era `qty <> 0`. Un consumo con cantidad positiva habría
producido consumos negativos en el informe sin que nadie entendiera por qué.

**Arreglo.** `check` de signo por tipo de movimiento. Prueba 24.

---

## El worker de informes

### 7. Un WeasyPrint colgado dejaba el worker muerto para siempre

`htmlToPdf` no tenía **ningún tope de tiempo**. Si el proceso se queda quieto, la
promesa nunca se resuelve, la petición HTTP queda abierta y se pierde una de las
dos conexiones del pool. `restart: unless-stopped` no rescata de esto: el proceso
no se cae, se queda parado.

**Arreglo.** Tope de 30 s con `SIGKILL`, y **healthcheck** en el compose — porque
sin algo que pregunte si responde, la política de reinicio no tiene de qué
enterarse.

### 8. Un informe mal formado tumbaba el proceso entero

El HTML de un informe no cabe en el búfer de la tubería, así que la escritura a
`stdin` es parcial y asíncrona. Si WeasyPrint muere antes de leerlo todo, el
`write` emite `EPIPE` **en `proc.stdin`**, que es su propio emisor de eventos: el
`proc.on('error')` que había NO lo cubre, y un `'error'` sin manejador derriba
Node.

**Arreglo.** Manejador propio en `proc.stdin`.

### 9. La autenticación fallaba **abierta**

```js
if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) { … }
```

Con `WORKER_TOKEN` vacío el `if` no entra nunca y el endpoint queda abierto a
cualquiera que alcance el contenedor. El compose exige que la variable *exista*,
que no es lo mismo que exigir que *valga* algo. Una autenticación que se abre en
vez de cerrarse es peor que no tenerla, porque nadie se entera.

**Arreglo.** No arranca sin un token de 16 caracteres o más, y la comparación va
en tiempo constante (`timingSafeEqual`) — es un secreto de larga vida en una red
con varios contenedores.

### 10. Sin límite de cuerpo, sin validación, y filtrando la traza

`for await (const chunk of req)` acumulaba en memoria lo que le mandaran. `kind`
y las fechas iban sin validar a un `::date` en SQL. Y el `catch` devolvía
`String(err)`, o sea nombres de tabla y rutas de fichero a quien acertara el
token.

**Arreglo.** Tope de 8 KiB → 413, validación de `kind` y de formato de fecha →
400, y mensaje genérico en el 500. Todo comprobado en `npm run worker:test`, que
levanta el worker y le hace siete peticiones — el endpoint HTTP **nunca se había
ejercitado**, solo la CLI.

---

## Rendimiento

### 11. Claves foráneas sin índice

22 en total. Se han indexado las cinco que respaldan consultas reales:
`assets.asset_type_id` (que recorre `merge_asset_type` y el recuento de la
bandeja del coordinador, sobre 1.094 equipos), `stock_items.asset_type_id`,
`asset_events.asset_id`, `incident_materials.incident_id` y
`asset_types.merged_into`. Las demás son tablas pequeñas y un índice de más
también cuesta.

---

## Anotado, sin arreglar

- ~~**Zona horaria.**~~ **Hecho** — ver «La hora es la de Madrid» más abajo.
- **`app_config` guarda el token del worker en claro** y su valor sembrado es
  `cambiame-en-produccion`. `deploy.sh` lo sustituye; si alguien despliega a mano
  y se lo salta, ahora al menos el worker no arranca con un token corto.
- **`stock_movements` no tiene cola de salida**: el almacén escribe directo contra
  el servidor. Es una decisión consciente —un saldo no admite conflictos— pero
  significa que sin cobertura no se puede registrar consumo. La pantalla ya lo
  dice desde la auditoría anterior.


---

## La hora es la de Madrid

Estaba anotado como pendiente y se ha hecho. Los instantes se siguen guardando
en UTC, que es lo correcto: `timestamptz` almacena UTC siempre. Lo que cambia es
**cómo se interpretan** al agrupar y al comparar con fechas.

### Lo que estaba mal

Ningún contenedor fijaba `TZ`, así que Postgres corría en UTC y `pg_cron`
también. Tres consecuencias, de más a menos visible:

1. **El informe diario cubría el día equivocado en dos franjas del día.** El
   worker calculaba «ayer» con `toISOString()`, que da la fecha UTC. En verano,
   a partir de las 22:00 de Madrid ya es el día siguiente en UTC.
2. **Las comparaciones de rango usaban la zona de la sesión.** `occurred_at >=
   '2026-07-28'` convierte la cadena a instante con la zona de quien pregunta:
   una revisión de las 00:30 caía en el informe del día anterior.
3. **Los truncados a mes, igual.** Una incidencia abierta a las 00:30 del 1 de
   marzo se contaba en febrero, en `incidents_by_month` y en
   `stock_monthly_consumption`.

Y el cron «diario a las 07:00» disparaba a las 09:00 peninsulares en verano y a
las 08:00 en invierno — cambiando solo dos veces al año, sin que nadie tocara
nada.

### Cómo se ha arreglado

**La zona va escrita en la consulta, no heredada de la sesión.** Es la decisión
que ordena todo lo demás: si dependiera del huso del cliente, la misma vista
daría números distintos desde la aplicación, desde `psql` y desde cualquier
herramienta que se conecte mañana. Un informe tiene que dar lo mismo lo pregunte
quien lo pregunte.

Dos funciones concentran la zona en un sitio:

- `public.dia_local(timestamptz) → date` — en qué día de Madrid ocurrió algo.
- `public.inicio_del_dia(date) → timestamptz` — la medianoche de Madrid de ese
  día. Son `stable`, no `immutable`, porque las definiciones de zona horaria
  cambian; como `stable`, el planificador las evalúa una vez por consulta y los
  rangos siguen usando el índice de `occurred_at`.

En el worker, `periodFor` formatea con `Intl` en `Europe/Madrid` y resta días
sobre el instante, de modo que no depende de la hora local del proceso. El pie
del PDF también: antes decía la hora UTC sin avisar, así que un informe emitido
a las 09:00 ponía «07:00».

En el cliente, `src/domain/fechas.ts` hace lo mismo para el «revisadas este mes»
del panel. Ese número aparece **también** en el PDF, calculado en el servidor: si
cada uno usara su zona dirían cifras distintas del mismo mes y nadie sabría cuál
creer.

`cron.timezone` se fija en el arranque del contenedor de la base, que es donde
va —es un parámetro de arranque, no de sesión—; la migración lo intenta también
con `alter system` por si el despliegue es sobre un Postgres gestionado, y avisa
en vez de romper si no puede.

### Lo que NO se ha tocado, y por qué

`alerts_stale_incidents` y `alerts_overdue_rooms` calculan `now() - opened_at`.
Eso es un **intervalo**: la distancia entre dos instantes, que no depende de
ninguna zona. Tocarlos habría sido ruido, y ruido en una migración es lo que
hace que la siguiente persona no se fíe de ninguna línea.

Igual en el cliente: `daysSince()` mide tiempo transcurrido, y
`new Date().toISOString()` al registrar una revisión guarda un instante. Los dos
eran correctos.

### Verificación

Pruebas 27 y 28 de `npm run db:verify`, y `npm run worker:periodos`. Las que de
verdad importan no son las del caso normal:

- El **domingo del cambio de hora de marzo dura 23 horas**. Si el rango de un día
  fuera «+24 horas» en vez de «hasta la medianoche siguiente», ese día se
  solaparía con el siguiente. La prueba lo comprueba explícitamente.
- La **semana que contiene el cambio de hora** sigue teniendo siete fechas.
- Una incidencia de **las 00:30 del 1 de marzo** cuenta en marzo.
- A las **00:30 de Madrid**, el diario ya cubre el día que acaba de terminar y no
  el anterior.

## 7. Segunda pasada (31 de julio): la subida que se acumulaba y los recuentos con observaciones

Mismo método que el resto del documento: cada hallazgo se reprodujo ejecutando
—la cola con su arnés de pruebas sobre IndexedDB y un Supabase simulado, el
worker levantado contra un Postgres desechable con las 30 migraciones y el seed
cargados— y cada arreglo dejó una prueba que falla si vuelve.

### La cola de salida acumulaba trabajo CON red

Cinco averías distintas con el mismo síntoma («hay cobertura y los pendientes no
bajan hasta que alguien pulsa Sincronizar»), y las cinco corregidas:

1. **Recuperar la red no forzaba la subida.** Los fallos en un sótano acumulan
   backoff (techo: 5 minutos); al volver la cobertura, el evento `online`
   lanzaba una pasada que *respetaba esas esperas*: no intentaba nada. Ahora
   `online` fuerza, igual que el botón — la señal de que las esperas ya no
   hablan del mundo real es exactamente esa.
2. **Un 401 marcaba el trabajo como rechazado para siempre.** El token caduca
   con el iPad dormido; cada envío de esa ventana volvía con 401 y, como
   cualquier 4xx, se declaraba permanente. Un 401 habla de la sesión, no del
   contenido: ahora reintenta, y `flush()` ya renueva la sesión al arrancar.
3. **Las fotos se auto-rechazaban al noveno intento, fuera cual fuera el
   fallo.** Ocho intentos se gastan en nada con una wifi que va y viene. Ahora
   solo rechaza un fallo permanente (con el código leído también de dentro del
   error de Storage, que no lo trae en la respuesta); lo temporal reintenta
   con su backoff, para siempre.
4. **Capturar una foto no disparaba la subida.** Era el único sitio que
   encolaba sin avisar a la cola: la foto esperaba al siguiente disparador,
   hasta un minuto sentada. Ahora encolar una foto es como encolar todo lo
   demás.
5. **Una pasada dejaba trabajo listo para la siguiente.** El cierre de una
   revisión espera a que suban sus comprobaciones — y quedaba «para la pasada
   siguiente», o sea otro minuto. Ahora la pasada se encadena mientras quede
   algo con el turno cumplido (con techo de cinco vueltas), así que una
   revisión cerrada con cobertura llega ENTERA en una sola llamada.

Verificación: `src/sync/outbox.test.ts` (22 pruebas, 4 nuevas y 3 endurecidas).

### Los recuentos del informe y de la insignia contaban observaciones

`alerts_stale_incidents` ya excluía las observaciones —notas de seguimiento
importadas del Excel, «abiertas» desde 2025 por definición porque no las cierra
nadie— pero el mismo error seguía vivo en tres sitios que se consultan aparte:

- `data.ts` del worker: «incidencias abiertas» y «estancadas» (la cifra y la
  tabla) del informe firmado, y «pendientes» por edificio.
- `room_overview.open_incidents`: la insignia naranja de la lista de salas, que
  no cuadraba con la pestaña de Incidencias que se abre al pulsarla
  (migración `20260731000200`; las solicitudes siguen contando, que son
  trabajo pedido).

Verificación: prueba 62 de `npm run db:verify` (una observación abierta no
enciende la insignia; una solicitud sí), y un informe semanal real generado de
punta a punta contra el clúster desechable —consultas nuevas incluidas— hasta
el PDF (`render-cli`, 46 KB, WeasyPrint 61).

### Lo que se revisó y estaba bien

El endpoint del worker (token en tiempo constante, cuerpo con tope y socket
drenado, errores sin traza: `npm run worker:test` en verde), el arranque de
migraciones del contenedor (cerrojo de asesor, registro compartido con
`init-plataforma.sh`, aviso a PostgREST), la detección del pooler en
transacción, los periodos en hora de Madrid (`worker:periodos`), el cliente de
Gemini (tiempo tope, borrador fuera, cifras inventadas invalidan el texto:
`informe:ia`), WeasyPrint con tiempo tope y EPIPE recogido, el escape de la
plantilla, y las rutas de Caddy y Kong.
