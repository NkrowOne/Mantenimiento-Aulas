# Sincronizar los inventarios con los dos Excel de SharePoint

Cómo hacer que el inventario de revisiones de aulas y el stock de almacén se
mantengan al día solos a partir de los dos libros que viven en SharePoint, sin
que nadie vuelva a copiar celdas a mano y sin que la sincronización se coma los
datos que hoy solo sabe la aplicación.

Este documento es la propuesta previa a escribir código: qué hay hoy, qué dicen
los dos libros de verdad —medido, no supuesto—, qué decisión hay que tomar antes
de nada, y las cuatro maneras de traer el fichero automáticamente con una
recomendación entre ellas.

---

## 0. La recomendación, en cinco líneas

1. **Microsoft Graph con una aplicación registrada en Entra ID y permiso
   `Sites.Selected`**, sondeando cada 30 minutos desde el servidor. Es la única
   opción que funciona con este despliegue, que no tiene entrada desde Internet.
2. **Nunca celda a celda en los dos sentidos.** Cada dato tiene un dueño: la
   tabla del apartado 3. Lo que manda el Excel entra; lo que manda la aplicación
   se publica de vuelta; lo que choca va a cuarentena, no se sobreescribe.
3. El disparo, con **`pg_cron` + `pg_net` contra un endpoint del worker**, que es
   exactamente la tubería que ya mueve los informes. No hay que inventar nada.
4. Antes hace falta **una migración pequeña** (m², capacidad, código oficial de
   espacio y las tablas de sincronización) y **una decisión de IT** (el registro
   de aplicación y el permiso sobre el sitio).
5. A medio plazo, lo correcto es que las hojas dejen de ser hojas y pasen a ser
   **Listas de SharePoint**. Todo lo de abajo sigue valiendo igual, y mejor.

---

## 1. Lo que hay hoy es un importador, no un sincronizador

`scripts/import-excel.ts` lee el libro de material y **escribe un fichero
`seed.sql`**. Ese SQL se aplica una vez, sobre una base vacía, y todas sus
sentencias terminan en `on conflict (id) do nothing` con identificadores UUID
deterministas.

La consecuencia exacta, y conviene decirla sin rodeos porque es el motivo de que
este documento exista: **volver a pasar el importador con el libro actualizado no
cambia absolutamente nada en una base que ya tiene datos**. Una revisión nueva de
junio, un número de serie corregido, veinte lámparas compradas: todo eso choca
con una fila que ya existe y se descarta en silencio. No es un fallo del
importador —se diseñó para cargar la base la primera vez y hace bien su trabajo—,
es que sincronizar es otro problema.

Y hay un segundo hueco: el importador **solo lee el libro de material**. El libro
`AULAS_REVISION_UFV.xlsx` no lo lee nadie. Los códigos oficiales de espacio, los
metros cuadrados, la capacidad y 190 números de serie de ordenador que están ahí
dentro no han entrado nunca en la aplicación.

---

## 2. Lo que dicen los dos libros

Medido sobre los ficheros que hay encima de la mesa, no sobre lo que deberían
tener.

### `Material_Aulas__Salas_de_reuniones.xlsx` — 5 hojas

| Hoja | Filas útiles | Qué aporta | Lo que trae sucio |
|---|---|---|---|
| Estado Aulas y Salas de reunion | 276 salas | Equipamiento, S/N de proyector, cámara, TV, monitor y ordenador, horas y % de lámpara, fecha de revisión | 18 grafías de edificio para ~14 edificios reales (`EDIFICO E`, ` EDIFICIO CRAI` con espacio delante); 170 S/N de proyector pero **158 únicos**; 3 fechas ilegibles (`285-11-25`, `19/0672025`, y un `3356` que es un número de horas en la columna de al lado) |
| Material Instalado 2026 | ~97 partes | Incidencias del año con material consumido | Referencias de aula en formato libre (`0.1 BC`, `Aula 6 CD`) |
| Material Instalado 2025 | 283 partes ya importados | Histórico | Fechas resueltas anteriores a la de apertura |
| Bolsa 2026 | 43 artículos | Instalado, stock disponible y comprado del año | El stock es un número tecleado, no una suma |
| Bolsa 2025 | 39 artículos | Cierre del año anterior | Ídem |

Los **12 números de serie repetidos** de la hoja de estado no son un detalle
menor: la base tiene `create unique index assets_serial_idx on assets(serial)`.
Cinco son series reales duplicadas en dos aulas —o el mismo proyector se movió y
nadie borró la fila de origen, o alguien copió la línea de arriba—, y el resto
son `********`, `no` y celdas vacías. Cualquier sincronización que intente
escribirlos tal cual **falla con violación de índice único**. Tienen que ir a
cuarentena y que lo resuelva una persona.

### `AULAS_REVISION_UFV.xlsx` — 2 hojas

| Hoja | Filas | Qué aporta |
|---|---|---|
| Aulas Identificadas | 194 aulas en 10 edificios | Código oficial de espacio (`11A002`), m², capacidad, estado de la revisión (`Completa`, `Parcial (4/5)`…), modelo y horas de proyector, modelo y **S/N de ordenador en las 194** |
| Aulas No Identificadas | 35 aulas | Espacios que quedaron fuera, con el motivo (`Aula no incluida en revisión`, `Sin número de aula en nombre`, `Edificio sin revisión`) |

Dos hallazgos que condicionan el diseño:

- **La columna «Revisada por» está vacía en las 194 filas.** El libro sabe *qué*
  se revisó y no *quién* lo revisó. La aplicación sabe las dos cosas. Esto por sí
  solo decide la dirección del flujo para todo lo que sea revisión.
- **Los dos libros no se pueden cruzar por número de serie.** De los 57 S/N de
  ordenador del libro de material y los 190 del libro de revisión, solo
  **coinciden 38**. Y de los modelos de proyector, 9 de 43. El cruce tiene que
  hacerse **por sala**, con la tabla `room_aliases` que ya existe justo para eso,
  y los números de serie discrepantes son material de cuarentena, no de
  sobreescritura automática.

---

## 3. La decisión de fondo: quién manda en cada dato

Es la parte que hay que acordar antes de escribir una línea, porque cambiarla
después significa tirar el trabajo.

La tentación es «que los dos lados estén siempre iguales». No se puede, y no por
falta de esfuerzo: un `.xlsx` no tiene identidad de fila —insertar una fila
arriba desplaza las 400 de abajo—, no tiene marca de tiempo por celda y no
registra quién escribió qué. Un sincronizador bidireccional sobre eso no resuelve
conflictos: elige uno de los dos valores y borra el otro sin que nadie se entere.
La primera vez que un técnico cierre una revisión desde el aula y media hora
después el Excel la pise, la aplicación deja de ser creíble y se vuelve al papel.

Así que cada dato tiene un dueño y una dirección:

| Dato | Manda | Dirección | Por qué |
|---|---|---|---|
| Revisión: fecha, autor, checks, resultado | **La aplicación** | App → SharePoint | El Excel no sabe quién revisó: «Revisada por» está vacía en las 194 filas. La app lo sabe siempre, con hora de dispositivo y hora de servidor |
| «Estado Revisión» (`Completa`, `Parcial (4/5)`) | **La aplicación** | App → SharePoint | Es un resultado calculado. La app ya lo calcula mejor: sabe qué check concreto falló y desde cuándo |
| Incidencias y material consumido | **La aplicación** | App → SharePoint | Ya se registran en el aula, con foto y autor |
| Código oficial de espacio, m², capacidad | **SharePoint** | SharePoint → App | Vienen de Espacios/Patrimonio. La app no los edita nunca; solo los muestra y los imprime |
| Alta de un aula nueva | **SharePoint** | SharePoint → App | Un aula nueva aparece en el inventario de espacios antes que en la app |
| N.º de serie y modelo de equipo | **El Excel, hoy; la app, a medida que se corrija desde el aula** | SharePoint → App, con freno | Entra si el equipo no tiene serie. Si la tiene y difiere, **no se pisa**: se abre una discrepancia. La corrección desde el aula es la única hecha con el rótulo delante |
| Horas de proyector y % de lámpara | **La aplicación** si hay revisión posterior; si no, el Excel | Mixta, gana la fecha más reciente | Son medidas fechadas: la más nueva es la buena, venga de donde venga |
| Compras de almacén (Bolsa: «Comprado») | **SharePoint** | SharePoint → App | Hoy se compra fuera de la app. Entra como movimiento `compra`, no como saldo |
| Consumo de almacén | **La aplicación** | App → SharePoint | Ya se descuenta al resolver la incidencia |
| Stock disponible | **Nadie: se calcula** | — | En la base es `sum(qty)` sobre `stock_movements`, por diseño. Un stock tecleado es justo el descuadre que la app existe para eliminar. Si el Excel dice 23 y la suma dice 21, entra un movimiento de `ajuste` con nota, y así queda por escrito quién descuadró y cuándo |

La regla que resume la tabla: **el Excel puede dar de alta y puede completar
huecos; no puede corregir lo que la aplicación ya afirma con autor y fecha.**

---

## 4. Cómo traer el fichero automáticamente

### Opción A — Microsoft Graph desde el servidor (recomendada)

Una aplicación registrada en Entra ID con credenciales de cliente, y el worker
preguntando cada media hora si el fichero cambió.

```
GET /sites/{host}:/sites/{sitio}                     → siteId
GET /sites/{siteId}/drives                           → driveId
GET /drives/{driveId}/root:/{ruta}/{fichero}.xlsx    → id, eTag, lastModifiedDateTime
GET /drives/{driveId}/items/{itemId}/content         → el .xlsx, solo si el eTag cambió
```

Por qué esta y no otra: **este despliegue no tiene entrada desde Internet**. El
dominio de la aplicación resuelve solo en el DNS interno o en el de la VPN, y eso
es deliberado. Las suscripciones de Graph —los avisos en tiempo real— necesitan
una URL pública que Microsoft pueda llamar, así que quedan descartadas de
entrada. El sondeo va al revés: es el servidor el que sale a `graph.microsoft.com`
por HTTPS, que es tráfico de salida normal y no abre nada.

El sondeo es barato porque la primera llamada solo pide metadatos: si el `eTag`
es el mismo que la última vez, se acabó la sincronización, y son dos kilobytes.
El fichero solo se descarga cuando alguien lo ha tocado de verdad.

Permisos: **`Sites.Selected`**, no `Sites.Read.All`. La diferencia es que con
`Sites.Selected` un administrador concede acceso **a ese sitio y a ninguno más**,
y es la única forma de que esta integración no sea una llave maestra del
SharePoint entero. El secreto de cliente caduca —24 meses como máximo—, así que
la fecha de caducidad va anotada donde se anotan los certificados, o el día que
expire la sincronización se para en silencio.

Para escribir de vuelta existe además la API de libro (`/workbook/worksheets/{h}/range`),
que permite actualizar celdas concretas sin descargar ni volver a subir el
fichero. Para **leer** no conviene: la hoja «Material Instalado 2025» declara un
millón de filas usadas y pedir su rango completo por API es una descarga absurda.
Leer, descargando y parseando; escribir, por la API de libro.

### Opción B — Power Automate empuja hacia nosotros

Un flujo en SharePoint que, al modificarse el fichero, llame por HTTP a un
endpoint de la aplicación.

Es más inmediato y no necesita registro de aplicación, pero **exige publicar un
endpoint accesible desde la nube de Microsoft**, es decir, deshacer justo la
decisión de que el sistema no esté expuesto. Solo tiene sentido si IT no autoriza
el registro de aplicación de la opción A y se acepta abrir una ruta concreta,
autenticada con token, a través del reverse proxy.

### Opción C — Que las hojas dejen de ser hojas (el destino correcto)

Convertir «Estado Aulas» y «Bolsa» en **Listas de SharePoint**. Una lista tiene
identidad de fila estable, control de versiones por elemento, quién modificó qué,
validación de columna y un `delta` de verdad: «dame lo que cambió desde este
token», sin descargar nada ni comparar 276 filas.

Todo lo de este documento sigue valiendo —las mismas direcciones, la misma
cuarentena, el mismo worker—, solo cambia la lectura, y a mejor. Si la migración
a listas es viable en meses, merece la pena; mientras tanto, la opción A funciona
sobre lo que hay hoy y no obliga a esperar.

### Opción D — Una carpeta sincronizada en el servidor

`rclone` o el cliente de OneDrive dejando el `.xlsx` en disco, y el worker
leyendo el fichero local.

Es lo más rápido de montar y lo menos trazable: no hay `eTag`, no se sabe quién
subió la versión, y una sincronización a medias deja un fichero corrupto que el
parser lee como si fuera bueno. Sirve como apaño de dos semanas para probar el
resto de la tubería sin depender de IT; no como solución.

---

## 5. Cómo se aplica sin romper lo que ya funciona

El sincronizador no escribe nunca directamente sobre `rooms`, `assets` o
`stock_movements`. Tres pasos, y el de en medio es el que salva:

**1. Aterrizaje.** El fichero descargado se guarda entero, tal cual, con su hash
y su `eTag`, y cada fila de cada hoja va a una tabla de paso con su número de
fila y un hash de contenido. Nada se interpreta todavía. Esto es lo que permite
responder a «¿de dónde salió este dato?» seis meses después, y lo que hace que
una pasada fallida se pueda repetir sin consecuencias.

**2. Diferencia.** Se compara lo aterrizado con lo que hay en la base y se
clasifica cada fila en cuatro cubos:

- **Igual** — no se hace nada. Será la inmensa mayoría en cada pasada.
- **Alta** — un aula, un equipo o un artículo que no existe. Se crea.
- **Relleno** — la base tiene el hueco vacío y el Excel lo llena (un S/N que
  faltaba, los m², el código oficial). Se escribe, y queda anotado en
  `import_fixes` con el valor original, que es la tabla que ya se usa para esto.
- **Choque** — los dos lados afirman cosas distintas: dos series diferentes para
  el mismo proyector, un serie que ya está asignada a otra aula, una fecha
  imposible. **Va a `import_quarantine` y no se toca la base.** La pantalla de
  administración ya tiene permisos para leer y resolver esa tabla.

**3. Aplicación.** Solo las altas y los rellenos, en una transacción, con
`source = 'sharepoint'` para que en el historial se distinga de lo que escribió
una persona en el aula, y con `by_user = NULL`, que es lo mismo que ya hace el
importador: el Excel no dice quién hizo cada cosa y atribuírselo a alguien
falsearía la trazabilidad.

Cuatro reglas que no se negocian:

- **Nada se borra jamás.** Que un aula desaparezca del Excel significa que
  alguien la borró de una hoja, no que el aula haya dejado de existir. Se marca
  `active = false` y se avisa; nunca `delete`.
- **El stock entra como movimiento, nunca como saldo.** Un `ajuste` con nota
  explicando de qué celda salió.
- **Idempotencia por hash.** La misma pasada dos veces no produce dos altas.
- **Cada pasada deja parte.** Cuántas filas, cuántas altas, cuántos choques y
  cuánto tardó. Una sincronización que no deja parte es una sincronización en la
  que nadie confía a los tres meses.

Con los datos de hoy, la primera pasada va a dejar del orden de **doce choques de
número de serie** y **tres fechas ilegibles** en cuarentena. Eso es la señal de
que funciona, no de que falle: son los datos que llevan meses siendo falsos en la
hoja y que nadie ha mirado porque una hoja no protesta.

---

## 6. Cuándo se dispara

La tubería ya existe y mueve los informes: `pg_cron` despierta a `pg_net`, que
llama por HTTP al worker en la red interna con `WORKER_TOKEN`. Un endpoint más y
una línea de `cron.schedule`:

```sql
select cron.schedule(
  'sync-sharepoint', '*/30 * * * *',
  $$select public.solicitar_sync('sharepoint')$$
);
```

Cada media hora es holgado para dos ficheros que se editan a mano unas cuantas
veces al día, y como la comprobación del `eTag` cuesta dos kilobytes, casi todas
las pasadas terminan sin descargar nada.

Además, dos cosas en el panel de administración: un botón **«sincronizar ahora»**
—porque el día que alguien corrige el Excel y quiere verlo, media hora es una
eternidad— y la **bandeja de choques**, que es donde se resuelve la cuarentena y
sin la cual todo lo anterior es un cajón que se llena y no se vacía.

---

## 7. Publicar de vuelta hacia SharePoint

La mitad que hace que la gente que vive en el Excel no tenga que dejar de vivir
en él: el worker escribe en el libro las columnas cuyo dueño es la aplicación
—fecha de revisión, estado, quién revisó, horas, consumo del mes— con la API de
libro de Graph, contra las celdas concretas, sin tocar el resto de la hoja.

Dos precauciones: escribir **solo columnas propias**, marcadas como tales en la
cabecera, para que nadie pierda una fórmula suya; y hacerlo **después** de la
lectura en la misma pasada, nunca a la vez, o el fichero cambia mientras se está
leyendo y el `eTag` de la pasada siguiente miente.

---

## 8. Lo que hay que pedir a IT antes de empezar

1. **Registro de aplicación en Entra ID** para «Mantenimiento de Aulas», con
   secreto de cliente y su fecha de caducidad anotada.
2. **Permiso `Sites.Selected`** concedido por un administrador **sobre el sitio
   concreto** donde viven los dos libros, con `write` si se quiere la publicación
   de vuelta del apartado 7.
3. **La dirección exacta del sitio y la ruta de los dos ficheros**, tal como
   están, con sus espacios y sus tildes.
4. **Confirmación de que `graph.microsoft.com` es alcanzable por HTTPS de salida**
   desde el servidor, directamente o a través del proxy corporativo.
5. **Un dueño humano para la cuarentena.** Quién decide, cuando el Excel dice una
   serie y la aplicación dice otra, cuál de las dos es. Sin esa persona, la
   bandeja de choques se llena y la sincronización acaba desactivada.

---

## 9. Lo que falta en la base

Una migración pequeña, porque tres datos del libro de revisión no tienen dónde
caer:

```sql
alter table rooms add column space_code text;   -- '11A002', el código oficial de espacio
alter table rooms add column area_m2   numeric(6,2);
alter table rooms add column seats     int;
```

`space_code` va aparte de `code` y de `short_ref` a propósito, y no es
duplicación: `code` es la etiqueta de la puerta (`1.4`), que se repite entre
edificios y se puede cambiar; `short_ref` (`SALA-000087`) es la matrícula que
pone la aplicación y que no cambia nunca; `space_code` es lo que dice Patrimonio.
Son tres identidades distintas con tres dueños distintos, y meterlas en la misma
columna es garantizar que una pise a otra.

Y las tablas de la sincronización: el registro de ficheros vistos con su `eTag` y
su hash, las filas aterrizadas, y el parte de cada pasada.

---

## 10. Fases

| Fase | Qué se entrega | Se puede probar sin IT |
|---|---|---|
| 1 | Lector del libro de revisión + cruce con salas por alias, en seco: dice qué entraría, qué chocaría y qué no sabe cruzar. No escribe nada | ✅ con los ficheros de hoy |
| 2 | Migración del apartado 9 + tablas de paso + aplicación de altas y rellenos + cuarentena | ✅ |
| 3 | Cliente de Graph, sondeo por `eTag`, descarga | ❌ necesita el registro de aplicación |
| 4 | Endpoint del worker + `cron.schedule` + botón «sincronizar ahora» | ✅ |
| 5 | Bandeja de choques en administración | ✅ |
| 6 | Publicación de vuelta hacia el libro | ❌ necesita permiso de escritura |

La fase 1 es la que conviene hacer ya, y no por orden: es la que dice, **con los
ficheros reales y antes de gastar nada en integración**, cuántas de las 194 aulas
del libro de revisión cruzan con las 276 de la base y cuántas no. Si cruzaran
mal, todo lo demás sobra hasta arreglar los alias.

---

## 11. Lo que puede salir mal

- **Que nadie vacíe la cuarentena.** Es el fallo más probable con diferencia. La
  sincronización seguirá funcionando y los choques seguirán sin resolverse, y en
  seis meses habrá quinientos. Por eso el apartado 8 pide un nombre.
- **Que alguien reordene las columnas del Excel.** El parser tiene que buscar las
  columnas **por su cabecera**, nunca por su posición, y parar con un error claro
  si falta una: la alternativa es escribir horas de proyector en el campo de
  capacidad y no enterarse.
- **Que el secreto de cliente caduque.** Se para todo, sin ruido. La caducidad va
  anotada y el parte de cada pasada tiene que gritar cuando falla la
  autenticación.
- **Que el fichero se edite mientras se descarga.** Se comprueba que el `eTag` de
  después de descargar sea el mismo que el de antes; si no, se descarta la pasada
  y se reintenta en la siguiente. Media hora de retraso no le hace daño a nadie;
  medio fichero, sí.
- **Que las dos fuentes empiecen a discrepar sistemáticamente** en horas de
  proyector o en series. Eso no es un problema de la sincronización: es que hay
  dos inventarios vivos. La sincronización lo hará visible, que es exactamente lo
  que hace falta para poder cerrar uno de los dos.
