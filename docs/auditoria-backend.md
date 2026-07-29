# Auditoría del backend, del registro de datos y del worker

Auditoría del lado servidor: esquema y garantías de registro, el camino
cliente→servidor, y el worker de informes con lo que lo dispara solo.

**Método:** nada de lo que sigue se afirma por lectura del código. Cada hallazgo
de seguridad se **ejecutó contra un Postgres real** con el rol correspondiente, y
el comportamiento del worker se comprobó levantándolo y haciéndole peticiones.
Los números que aparecen son los que devolvió la base.

Todo lo de aquí está **corregido** en `20260729000100_endurecer_backend.sql` y en
`reports-worker/`, con pruebas que fallan si vuelve a ocurrir (`npm run db:verify`
pruebas 12 y 20–26, y `npm run worker:test`).

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

- **Zona horaria.** No hay `TZ` en ningún contenedor, así que Postgres va en UTC:
  el cron «diario a las 07:00» dispara a las 09:00 hora peninsular en verano, y
  los límites del periodo se calculan en UTC. Para trabajo de día no cambia
  ningún número, pero una revisión hecha a la 01:00 cae en el informe del día
  anterior. Arreglarlo bien es fijar `TZ=Europe/Madrid` en la base y volver a
  comprobar los periodos; no es un cambio para hacer a ciegas.
- **`app_config` guarda el token del worker en claro** y su valor sembrado es
  `cambiame-en-produccion`. `deploy.sh` lo sustituye; si alguien despliega a mano
  y se lo salta, ahora al menos el worker no arranca con un token corto.
- **`stock_movements` no tiene cola de salida**: el almacén escribe directo contra
  el servidor. Es una decisión consciente —un saldo no admite conflictos— pero
  significa que sin cobertura no se puede registrar consumo. La pantalla ya lo
  dice desde la auditoría anterior.
