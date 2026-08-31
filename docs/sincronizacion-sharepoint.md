# Sincronizar los inventarios con los dos Excel de SharePoint

Cómo hacer que el inventario de revisiones de aulas y el stock de almacén y los
dos libros que viven en SharePoint digan siempre lo mismo, **en los dos
sentidos**: lo que se hace en la aplicación aparece en el Excel, y lo que alguien
corrige en el Excel entra en la base de datos. Sin copiar celdas a mano y sin que
el libro pierda por el camino su formato, sus fórmulas ni su estructura.

Este documento es la propuesta previa a escribir código.

---

## 0. La recomendación, en siete líneas

1. **La aplicación manda por defecto**, pero el Excel puede corregir: una edición
   posterior en la hoja entra en la base. Bidireccional de verdad.
2. Para que eso sea posible sin destrozos hacen falta dos cosas que no existen
   hoy: **identidad de fila estable** en el libro (apartado 3) y una **fusión a
   tres bandas** contra la última versión sincronizada (apartado 4). Sin ellas,
   «bidireccional» significa que el último en escribir borra al otro sin avisar.
3. **Se escribe celda a celda con la API de libro de Graph, nunca subiendo el
   fichero regenerado.** Es la única forma de conservar fórmulas, formatos
   condicionales, validaciones y tablas (apartado 6).
4. **Empezar sin permisos**: una pantalla donde se sube el `.xlsx` y se descarga
   ya parcheado, y el viaje a SharePoint lo hace una persona. No necesita ni
   registro de aplicación ni permiso de nadie, y el fichero vuelve intacto — está
   probado sobre este libro (apartado 5, opción 0). Automatizar el transporte
   después es cambiar una pieza, no rehacer el trabajo.
5. Si se automatiza: **Graph con `Sites.Selected`**, sondeando por `cTag` cada 30
   minutos desde el servidor. Este despliegue no tiene entrada desde Internet, así
   que los avisos en tiempo real quedan descartados. **Ojo:** la documentación de
   Microsoft dice que la API de libro de Excel **no admite permisos de
   aplicación**; hay que probarlo con un token app-only en un sitio desechable
   antes de pedir nada. Está en
   [`sincronizacion-sharepoint-permisos.md`](sincronizacion-sharepoint-permisos.md),
   con la petición literal para IT.
6. El disparo de la vía automática, con **`pg_cron` + `pg_net` contra un endpoint
   del worker**: la misma tubería que ya mueve los informes.
7. En los dos casos hace falta **una migración pequeña** (m², capacidad, código oficial de espacio
   y las tablas de sincronización) y **una decisión de IT** (registro de
   aplicación y permiso de lectura **y escritura** sobre ese sitio).

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
| Bolsa 2026 | 43 artículos | Instalado, stock disponible y comprado del año | `Total Instalado` y `Stock Disponible` son fórmulas (`=P−N`), `Total Comprado` es un número tecleado — y la columna de fórmula ya está rota: `N5` lleva un `3` escrito a mano encima de la fórmula |
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
  se revisó y no *quién* lo revisó. La aplicación sabe las dos cosas — por eso el
  autor viaja siempre de la app hacia el Excel y nunca al revés.
- **Los dos libros no se pueden cruzar por número de serie.** De los 57 S/N de
  ordenador del libro de material y los 190 del libro de revisión, solo
  **coinciden 38**. Y de los modelos de proyector, 9 de 43. El cruce tiene que
  hacerse **por sala**, con la tabla `room_aliases` que ya existe justo para eso,
  y los números de serie discrepantes son material de cuarentena, no de
  sobreescritura automática.

### El cruce contra el maestro, medido

Fase 1, ya hecha: `npm run cruce:excel -- <material.xlsx> [<revision.xlsx>] [--seed]`
lee los dos libros, los cruza contra el maestro y **no escribe nada**. Contra el
maestro de una instalación recién cargada, hoy:

| Hoja | Cruzan | Cómo |
|---|---|---|
| Estado Aulas y Salas de reunion | **276 de 276 (100%)** | edificio + código |
| Material Instalado 2025 | 124 de 186 (67%) | 118 por alias, 6 por código único |
| Material Instalado 2026 | 52 de 97 (54%) | 48 por alias, 4 por código único |
| Aulas Identificadas (revisión) | 129 de 194 (66%) | edificio + nombre |
| Aulas No Identificadas (revisión) | 7 de 35 (20%) | edificio + nombre |

**El 100% de la hoja de estado es el dato que decide**: es la hoja que gobierna
el inventario, y cruza entera. Lo demás no falla por el cruce, falla porque el
maestro no tiene esos edificios:

| Código que aparece | Filas | Qué es |
|---|---|---|
| `S`, `BC`, `G`, `TM`, `CC`, `CEFF` | 94 | **existen en el maestro, vacíos**: el importador los creó como «Edificio X (sin identificar)» al verlos en los partes, y la hoja de estado —la única que define salas— no lista ninguna dentro |
| `CSCA`, `K`, «Artes y Diseño 1 y 2» | 12 | no constan de ninguna forma |

Aquí hubo **dos errores míos que conviene dejar escritos**, porque los dos daban
un diagnóstico que sonaba razonable y era falso.

**El primero: dije que faltaban esos edificios, y no faltan.** El catálogo del
cruce se construía recorriendo las salas, así que un edificio sin ninguna sala
era invisible y el informe decía «el código `S` no está en el maestro». Están los
23, seis de ellos vacíos. El maestro se carga ahora desde `buildings`, con salas
o sin ellas, y esos seis se tratan como lo que son: un hueco abierto por el
importador al no saber dónde meter la referencia, no el sitio donde está el aula.
Por eso una fila suya se sigue buscando por todo el maestro, igual que la de un
edificio desaparecido.

**El segundo: intenté deducir la equivalencia de las aulas cuando la aplicación
ya la tiene apuntada.** Los renombrados se hicieron en la aplicación y la
aplicación los audita:

- `rename_building` hace `update buildings set code` **sobre la misma fila**, así
  que `audit_log` deja el código viejo y el nuevo con el mismo `row_id`.
- `merge_building` mueve las zonas con `update zones set building_id` —y `zones`
  también se audita— antes de borrar el origen. Ese salto es la equivalencia, y
  el `DELETE` da el código con el que murió.

`equivalenciasDesdeAuditoria()` camina esas cadenas —un edificio renombrado dos
veces y fusionado después tiene tres códigos históricos y todos apuntan al mismo
sitio— y devuelve la traducción exacta. Comprobado contra una base real:
renombrando `O` a `ONX` y fusionando `CSQ` en `H`, el cruce las reconstruye solas
y las 22 aulas del edificio renombrado cruzan marcadas como `nomenclatura-vieja`,
que no es lo mismo que haber cruzado por el maestro de hoy.

La deducción por aulas se queda **solo para lo que la auditoría no puede saber**:
códigos que ya eran viejos antes de cargar la base. Y ahí sigue en pie la cautela
que costó descubrir: **contar coincidencias premia al edificio más grande**. Los
códigos de aula de este campus son genéricos —`1.1`, `2.3`, `-1.2`— y el edificio
con cien salas contiene casi cualquier lista. Con ese criterio, `S` encajaba «30
de 30» con el edificio P y «26 de 30» con el M, y tres códigos parecían resueltos:
eso mide el tamaño de P, no la identidad de `S`. Lo que discrimina son las aulas
que existen en **un solo** edificio, y contadas así casi ninguno tiene ninguna.

Lo que quede sin decidir se declara a mano en `OLD_BUILDING_CODES`
(`src/domain/normalize.ts`), una línea por código; `npm run cruce:excel` imprime
el bloque listo para pegar. Nace vacío a propósito: rellenarlo a ojo cuelga
partes del edificio que no era, y no se descubre hasta que alguien busca un
histórico y no está. El resto de las que
no cruzan son referencias sin código de sala —`Lab Docente 5`, `Modulo 5
buhardilla`, `Aula 1, 2, 7 MSI`— y aulas del libro de revisión que el maestro no
tiene todavía.

Y 47 filas quedan **ambiguas**: el edificio no existe y el código —`1.1`, `0.2`—
se repite en hasta ocho edificios. El cruce no elige por su cuenta; eso es
cuarentena.

---

## 3. Lo primero para que sea bidireccional: que cada fila tenga nombre

Un `.xlsx` no tiene identidad de fila. Insertar una fila arriba desplaza las 400
de abajo, y para el sincronizador la fila 87 de hoy no es la fila 87 de ayer. Con
ese punto de partida, «bidireccional» significa comparar dos hojas por posición
y escribir encima: la primera vez que alguien ordena por edificio, se cruzan
doscientos números de serie sin que salte ningún error.

La solución es barata y se hace una sola vez: **una columna de referencia en cada
hoja, con la matrícula que la aplicación ya asigna**.

| Hoja | Clave de fila | De dónde sale |
|---|---|---|
| Estado Aulas y Salas de reunion | `Ref` → `SALA-000087` | `rooms.short_ref`, que ya existe y no cambia nunca |
| Aulas Identificadas / No Identificadas | `Ref` → `SALA-000087` | ídem, cruzando la primera vez por alias de sala |
| Bolsa 2026 / 2025 | `Articulo / Material` | ya es único; se normaliza con `canonAlmacen()` |
| Material Instalado 2026 / 2025 | `N.º Incidencia` | ya es único (`I260102_0002`) |

La columna `Ref` la rellena la primera pasada de sincronización, y va **al
final**, no la primera. Aquí el diseño estaba equivocado y lo corrigió el código:
insertar una columna a la izquierda desplaza todas las demás y obliga a
reescribir cada referencia de la hoja —las fórmulas, el rango del autofiltro
(`A1:X416`), los cuatro formatos condicionales, la validación—, que es
exactamente la clase de operación que rompe el libro en silencio. Al final no
desplaza nada, y para lo que sirve la columna da lo mismo dónde esté. A partir de ahí da igual cómo se ordene, se
filtre o se inserte: cada fila se reconoce por su matrícula, no por dónde esté.

**Y cierra el círculo en el otro sentido**: si alguien añade un aula nueva al
final de la hoja, esa fila llega sin `Ref`. Eso es exactamente lo que la
sincronización necesita para saber que es un alta hecha desde el Excel: la crea
en la base y en la misma pasada **le escribe su matrícula recién asignada**. Sin
esa columna, un aula nueva en el Excel es indistinguible de un aula renombrada,
y se duplica.

---

## 4. La fusión: cómo se decide sin pisar a nadie

Con identidad de fila, el resto es un problema conocido y con solución conocida:
**fusión a tres bandas**, la misma idea que usa git para juntar dos ramas.

Después de cada pasada correcta, el sincronizador guarda **el valor exacto de
cada celda sincronizada** (`sync_celdas.valor_base`). Esa instantánea es el
antepasado común. En la pasada siguiente hay tres valores para cada celda —el de
la base, el del Excel y el antepasado— y con eso la decisión ya no es una
apuesta:

| Base de datos | Excel | Decisión |
|---|---|---|
| = antepasado | = antepasado | Nada. Es la inmensa mayoría de las celdas |
| **cambió** | = antepasado | Manda la app → se escribe en el Excel |
| = antepasado | **cambió** | **Manda el Excel** → se escribe en la base |
| **cambió** | **cambió**, y a cosas distintas | **Conflicto**: no se toca ninguno de los dos, va a cuarentena y se avisa en las dos partes |
| **cambió** | **cambió**, a lo mismo | Nada que hacer, ya coinciden |

Ahí está la respuesta a «a veces es más cómodo editarlo en el Excel»: **si nadie
lo tocó en la app, lo que escribes en la hoja gana y entra en la base**. No hace
falta pedir permiso ni avisar a nadie. Y si los dos lados cambiaron la misma
celda en la misma ventana de media hora —lo raro—, nadie pierde su trabajo: se
paran los dos y una persona decide.

Sin el antepasado no hay forma de distinguir «esto lo cambió el Excel» de «esto
lo cambió la app», y la única política posible sería «gana el último», que es
otra manera de decir «se pierden ediciones y nadie sabe cuáles». Por eso la
instantánea no es un detalle de implementación: es lo que hace que la
bidireccionalidad sea segura.

### Lo que se puede editar en cada sitio

| Dato | Editable en el Excel | Editable en la app | Nota |
|---|---|---|---|
| N.º de serie, marca, modelo de cada equipo | ✅ | ✅ | Fusión a tres bandas. Choque con una serie ya asignada a otra aula → cuarentena, por el índice único |
| Horas de proyector, % de lámpara | ✅ | ✅ | Son medidas fechadas: si las dos cambian, gana la más reciente por fecha, no por quién escribió último |
| m², capacidad, código oficial de espacio | ✅ | ⛔ solo lectura | Vienen de Espacios. La app los muestra e imprime; no los edita |
| Nombre de la sala, edificio, planta | ✅ | ✅ | Renombrar no rompe nada: la fila se identifica por `Ref` |
| Alta de un aula nueva | ✅ (fila sin `Ref`) | ✅ | La sincronización le devuelve la matrícula |
| Compras de almacén | ✅ | ✅ | Entra como movimiento `compra`, con fecha |
| Fecha de revisión | ✅ | ✅ | Escribirla en el Excel **crea una revisión sin autor**, con `source = 'sharepoint'`, igual que hizo el importador con el histórico. Nunca pisa una revisión hecha en la app con fecha posterior |
| Quién revisó, checks, fotos, resolución | ⛔ columna de la app | ✅ | Una celda no puede contener una revisión con sus checks y su autor. Va de la app al Excel; si alguien escribe ahí, la pasada siguiente lo devuelve a su valor y lo dice en la hoja `Sincronización` |
| Incidencias y material consumido | ⛔ columna de la app | ✅ | Ídem: se registran en el aula, con foto y autor |
| Stock disponible | ⛔ celda de fórmula (`=Comprado − Instalado`) | ⛔ es una suma | En la base es `sum(qty)` sobre `stock_movements` y en el Excel lo calcula la propia hoja. Si los dos números discrepan, entra un movimiento de `ajuste` con nota diciendo de qué celda salió |

Las tres filas con ⛔ no son una restricción que se elija: son cosas que una
celda de texto no puede representar.

Y aquí hay una corrección que sale de comprobar la documentación: **la protección
de hoja no sirve como control**. Serían justo las celdas que el worker escribe,
`accessDenied` cubre «cambios en celdas bloqueadas», y una aplicación sin usuario
**no puede desproteger** (`worksheetProtection: protect`/`unprotect` son
`Application: Not supported`). Así que esas columnas se marcan con fondo gris y
una nota en la cabecera, y el control real es otro: **la aplicación las reescribe
en la pasada siguiente y lo deja dicho en la hoja `Sincronización`**. Candado,
solo si la prueba del paso 0 demuestra que la escritura app-only pasa por encima
de la protección.

---

## 5. Cómo se trae y se lleva el fichero

### Opción 0 — a mano, sin permisos: subirlo a la app y bajarlo parcheado

La que menos depende de nadie, y por eso va la primera.

Una pantalla en administración: **arrastras el `.xlsx`**, la aplicación lo lee, cruza,
y te enseña **qué entraría, qué se rellenaría y qué choca** antes de tocar nada. Lo
confirmas, se aplica a la base, y la aplicación te devuelve **ese mismo fichero con
las celdas que manda la app ya escritas** —fecha de revisión, estado, consumo, las
matrículas `Ref` recién asignadas—. Lo subes tú a SharePoint.

Lo que esto elimina, entero: registro de aplicación en Entra ID, consentimiento de
administrador, `Sites.Selected`, certificado y su caducidad, throttling, unidades de
recurso… y **el riesgo número uno del proyecto**, porque la API de libro de Graph no
hace falta si no se usa.

**Y el fichero no se rompe.** Un `.xlsx` es un zip de XML: se reescribe únicamente el
`<v>` de las celdas que cambian dentro de `xl/worksheets/sheetN.xml`, y las demás
entradas del zip se copian **byte a byte**. Probado sobre este libro, cambiando dos
celdas de la hoja de estado: se modificó **una sola entrada del zip**, no se perdió
ninguna, y siguen intactos los 4 formatos condicionales, el autofiltro `A1:X416`, la
fila de cabecera inmovilizada, las fórmulas de Bolsa —incluida la `N5` tecleada a
mano—, los 4 comentarios de celda, la **etiqueta de confidencialidad**
(`docMetadata/LabelInfo.xml`) y los **seis ficheros de metadatos de SharePoint**
(`customXml/`).

Esos dos últimos importan más de lo que parece: regenerar el libro con una librería
se lleva por delante la etiqueta de Purview y los metadatos de columna de SharePoint,
y el fichero vuelve a su sitio degradado sin que nadie lo note. Con el parche
quirúrgico vuelve idéntico salvo en las celdas que cambiaron.

Dos detalles del parcheo:

- **Para texto, `t="inlineStr"`** con `<is><t>…</t></is>`, que evita tener que tocar
  `xl/sharedStrings.xml` y recontar cadenas.
- **`<calcPr fullCalcOnLoad="1"/>`** en `xl/workbook.xml` cuando se cambia una celda
  de la que cuelga una fórmula: si no, el total cacheado sigue diciendo lo de antes
  hasta que alguien fuerce el recálculo. Hoy el libro trae
  `<calcPr calcId="191028" calcCompleted="0"/>`, sin esa marca.

Lo que se paga: alguien tiene que acordarse de hacerlo, y entre que descargas y subes
puede editarlo otro en SharePoint. Lo segundo **no rompe nada**: se guarda el hash del
fichero que emitió la aplicación, y si el que subes no coincide, es que alguien lo
tocó por medio — que es exactamente el caso que la fusión a tres bandas del apartado 4
sabe resolver. Se avisa y se fusiona igual.

Y no es un desvío del camino automático: **el lector, la fusión y el parcheador son
los mismos módulos**. Entre esta opción y la A solo cambia el transporte —quién mueve
el fichero—. Si mañana IT autoriza Graph, se sustituye esa pieza y todo lo demás sigue
donde estaba.

### Opción A — Microsoft Graph desde el servidor

Una aplicación registrada en Entra ID con credenciales de cliente, y el worker
preguntando cada media hora si el fichero cambió.

```
GET   /sites/{host}:/sites/{sitio}                    → siteId
GET   /sites/{siteId}/drives                          → driveId
GET   /drives/{driveId}/root:/{ruta}/{fichero}.xlsx   → id, eTag, lastModifiedDateTime
GET   /drives/{driveId}/items/{itemId}/content        → el .xlsx, solo si el eTag cambió
POST  /drives/{driveId}/items/{itemId}/workbook/createSession  → sesión persistente
PATCH /workbook/worksheets/{hoja}/range(address='M5:M9')       → escribir, celda a celda
```

Por qué esta y no otra: **este despliegue no tiene entrada desde Internet**. El
dominio de la aplicación resuelve solo en el DNS interno o en el de la VPN, y eso
es deliberado. Las suscripciones de Graph —los avisos en tiempo real— necesitan
una URL pública que Microsoft pueda llamar, así que quedan descartadas de
entrada. Y hay dos razones más que las descartarían igual aunque la hubiera:
**no se puede suscribir un fichero suelto** —solo carpetas— y su latencia máxima
documentada para un elemento es de **seis horas**, o sea más lenta en el peor
caso que sondear cada media hora. El sondeo va al revés: es el servidor el que sale a `graph.microsoft.com`
por HTTPS, que es tráfico de salida normal y no abre nada.

El sondeo es barato porque la primera llamada solo pide metadatos: si el `cTag`
—el del contenido, no el `eTag`, que cambia también al renombrar o al tocar una
columna de biblioteca— es el mismo que la última vez, se acabó la sincronización,
y son dos kilobytes. El fichero solo se descarga cuando alguien lo ha tocado de
verdad.

Permisos: **`Sites.Selected` de Microsoft Graph con rol `write` sobre un sitio
dedicado**, y certificado en vez de secreto de cliente. Por sí solo ese permiso
**no da acceso a nada**: hace falta además que un administrador conceda ese sitio
concreto, y sin los dos pasos la aplicación no entra en ninguna parte. Eso, la
petición literal para IT, la lista de lo que **no** se pide, y el aviso de que la
API de libro no documenta permisos de aplicación, están en
[`sincronizacion-sharepoint-permisos.md`](sincronizacion-sharepoint-permisos.md).

**Leer descargando, escribir por la API de libro.** La hoja «Material Instalado
2025» declara un millón de filas usadas: pedir su rango completo por API es una
descarga absurda, así que para leer se baja el fichero y se parsea. Para escribir
es al revés, y el motivo es todo el apartado 6.

### Opción B — Power Automate empuja hacia nosotros

Un flujo en SharePoint que, al modificarse el fichero, llame por HTTP a un
endpoint de la aplicación. Más inmediato y sin registro de aplicación, pero
**exige publicar un endpoint accesible desde la nube de Microsoft**, es decir,
deshacer la decisión de que el sistema no esté expuesto. Solo tiene sentido si IT
no autoriza el registro de aplicación.

### Opción C — Que las hojas dejen de ser hojas (el destino correcto)

Convertir «Estado Aulas» y «Bolsa» en **Listas de SharePoint**. Una lista tiene
identidad de fila nativa —el apartado 3 deja de hacer falta—, control de
versiones por elemento, quién modificó qué, validación de columna y un `delta` de
verdad. Todo lo de este documento sigue valiendo, y mejor. Si la migración es
viable en meses, merece la pena; mientras tanto, la opción A funciona sobre lo
que hay hoy.

### Opción D — Una carpeta sincronizada en el servidor

`rclone` o el cliente de OneDrive dejando el `.xlsx` en disco. Lo más rápido de
montar y lo menos trazable: no hay `eTag`, no se sabe quién subió la versión, y
una sincronización a medias deja un fichero corrupto que el parser lee como si
fuera bueno. Sirve de apaño para probar la tubería; no como solución.

---

## 6. Escribir en el Excel sin romperlo

Esta es la parte que hay que vigilar, y son reglas concretas, no buenas
intenciones. La primera es la que salva todas las demás:

> **Nunca se regenera el fichero.** Ni con `openpyxl`, ni con `exceljs`, ni
> subiendo un `.xlsx` nuevo por `PUT /content`. Se escriben **las celdas
> concretas** por la API de libro, y el resto del fichero no se toca.

Regenerar un libro con una librería y volver a subirlo pierde, en silencio y de
una vez: fórmulas que la librería no entiende, formato condicional, validación de
datos, listas desplegables, gráficos, tablas dinámicas, anchos de columna,
paneles inmovilizados, filtros, comentarios y la propia protección de hoja. El
libro «funciona» y nadie se entera hasta que alguien busca su desplegable. En
estos dos libros concretos, lo que hay hoy que se perdería: las fórmulas de
`Total Instalado` y `Stock Disponible`, cuatro formatos condicionales, el
autofiltro `A1:X416` y la fila de cabecera inmovilizada de la hoja de estado.

Las demás reglas:

1. **Nunca se escribe encima de una fórmula.** Antes de tocar un rango se lee su
   propiedad `formulas`: si el valor empieza por `=`, esa celda es calculada y no
   se escribe — va a cuarentena con el motivo. Y la comprobación es **por celda,
   no por columna**, porque la columna de fórmula no es de fiar: en Bolsa 2026,
   `Total Instalado` y `Stock Disponible` son fórmulas en casi todas las filas,
   pero `N5` lleva un `3` tecleado encima. Una regla por columna se saltaría esa
   celda o la pisaría, según cómo se escribiera; una por celda acierta en las dos
   y en cualquier fórmula que alguien añada mañana sin avisar.
2. **Las hojas se convierten en tablas de Excel** (`ListObject`) con nombre —hoy
   ninguna lo es—. Entonces una fila nueva se añade con
   `POST /workbook/tables/{t}/rows/add` y **Excel propaga solo el formato y las
   fórmulas de la columna**. Escribir a mano en la primera fila vacía produce una
   fila sin formato, sin fórmulas y fuera de los rangos con nombre — que es como
   se degrada un libro sin que nadie lo note.
3. **Las columnas se buscan por su cabecera, jamás por su posición.** Si falta una
   cabecera esperada, la pasada se aborta entera sin escribir nada. La
   alternativa es escribir horas de proyector en la columna de capacidad y no
   enterarse en seis meses.
4. **Comprobación de estructura antes de cada escritura**: que estén las hojas
   esperadas, que estén las cabeceras esperadas, que la tabla con nombre siga
   existiendo, y que las columnas que eran de fórmula sigan siéndolo. Si algo no
   cuadra, se para y se avisa. Nunca se «arregla» el libro por iniciativa propia.
5. **Se escribe por rangos contiguos dentro de una sesión persistente**
   (`createSession` con `persistChanges: true`), no celda a celda: una pasada que
   actualiza 40 valores hace un puñado de llamadas, no 40.
6. **La escritura va al final de la pasada, nunca a la vez que la lectura**, y
   solo si el `cTag` de después de leer es el mismo que el de antes. Si alguien
   tenía el libro abierto y guardó a media lectura, se descarta la pasada y se
   reintenta a la siguiente: media hora de retraso no le hace daño a nadie, medio
   fichero sí. Y **tras escribir hay que releer y guardar el `cTag` resultante**,
   o el worker se resincroniza consigo mismo en bucle.
7. **`null` es «no toques esta celda»; `""` es «bórrala».** Al escribir un rango,
   `null` en la matriz le dice a la API que ignore esa celda —es la única defensa
   documentada para no pisar fórmulas ni formato— y la cadena vacía borra el
   valor, la fórmula y el formato de número. Un `?? ''` mal puesto en Node vacía
   celdas de producción.
8. **Una celda contra un rango mayor se replica** por todo el rango, como un
   CTRL+Enter. Un error construyendo el payload rellena cientos de celdas con el
   mismo dato.
9. **Una petición cada vez, por libro**: Microsoft pide enviar la siguiente solo
   tras recibir respuesta correcta a la anterior. Y `$batch` admite 20
   subpeticiones como máximo. Las reglas completas —sesiones, throttling,
   `formulas` frente a `valueTypes`— están en el apartado 9 del documento de
   permisos.
10. **Los tipos se respetan.** Las fechas se escriben como número de serie de Excel
   con su formato de fecha, no como texto: una fecha escrita como cadena rompe
   cualquier fórmula que la compare y ordena mal. Los porcentajes van como
   fracción (`0.73`), que es como están ya en la columna `% Lámparas`.
11. **La primera escritura anota la versión previa del fichero** (`/versions`) en
   el parte de la pasada. SharePoint versiona solo; saber a qué versión volver es
   lo que convierte un susto en un «restaurar».

Y una hoja nueva, `Sincronización`, que escribe el worker: fecha de cada pasada,
qué filas entraron, cuáles se rechazaron y **por qué**. Es donde mira la persona
que acaba de editar el Excel y quiere saber si su cambio entró. Sin eso, un
cambio rechazado es un cambio que desaparece.

---

## 7. Cómo se aplica en la base

El sincronizador no escribe nunca directamente sobre `rooms`, `assets` o
`stock_movements`. Tres pasos, y el de en medio es el que salva:

**1. Aterrizaje.** El fichero descargado se guarda entero, tal cual, con su hash
y su `eTag`, y cada fila de cada hoja va a una tabla de paso con su `Ref` y un
hash de contenido. Nada se interpreta todavía. Esto es lo que permite responder a
«¿de dónde salió este dato?» seis meses después, y lo que hace que una pasada
fallida se pueda repetir sin consecuencias.

**2. Fusión.** La del apartado 4, celda a celda contra la instantánea anterior.
De ahí salen cuatro montones:

- **Sin cambios** — la inmensa mayoría.
- **Hacia la base** — lo que cambió solo en el Excel. Se aplica, y queda anotado
  en `import_fixes` con el valor anterior.
- **Hacia el Excel** — lo que cambió solo en la app. Se escribe con las reglas del
  apartado 6.
- **Conflicto** — los dos lados cambiaron. **Va a `import_quarantine`, no se toca
  ninguno de los dos lados**, y sale en la hoja `Sincronización` y en la bandeja
  de administración, que ya tiene permisos para leer y resolver esa tabla.

**3. Aplicación**, en una transacción, con `source = 'sharepoint'` para que en el
historial se distinga de lo que escribió una persona en el aula, y con
`by_user = NULL`: el Excel no dice quién hizo cada cosa y atribuírselo a alguien
falsearía la trazabilidad. Al terminar, la instantánea se guarda de nuevo con los
valores ya iguales en los dos lados.

Cuatro reglas que no se negocian:

- **Nada se borra jamás.** Que un aula desaparezca del Excel significa que alguien
  la borró de una hoja, no que el aula haya dejado de existir. Se marca
  `active = false` y se avisa; nunca `delete`. Lo mismo al revés: la
  sincronización no borra filas del libro.
- **El stock entra como movimiento, nunca como saldo.**
- **Idempotencia por hash.** La misma pasada dos veces no produce dos altas.
- **Cada pasada deja parte**: cuántas filas, en qué dirección, cuántos choques y
  cuánto tardó. Una sincronización que no deja parte es una en la que nadie
  confía a los tres meses.

Con los datos de hoy, la primera pasada va a dejar del orden de **doce choques de
número de serie** y **tres fechas ilegibles** en cuarentena. Eso es la señal de
que funciona, no de que falle: son los datos que llevan meses siendo falsos en la
hoja y que nadie ha mirado porque una hoja no protesta.

---

## 8. Cuándo se dispara

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

## 9. Lo que hay que pedir a IT antes de empezar

El detalle está en **[`sincronizacion-sharepoint-permisos.md`](sincronizacion-sharepoint-permisos.md)**:
el correo redactado, el identificador exacto del permiso, quién puede concederlo,
cómo se revoca y la lista de lo que **no** se pide. En resumen:

1. **Un sitio de pruebas y un registro de aplicación desechables** para la prueba
   del paso 0 — la que dice si la API de libro acepta un token sin usuario.
   Primero eso, después todo lo demás.
2. **Un registro de aplicación** dedicado, sin URI de redirección, con
   **certificado** (no secreto de cliente).
3. **Un solo permiso**: `Sites.Selected` de Microsoft Graph
   (`883ea226-0bf2-4a8f-9f9d-92c9162a727d`), con consentimiento de administrador.
   Por sí solo no da acceso a nada.
4. **La concesión del rol `write` sobre un sitio dedicado y nuevo** donde vivan
   solo los dos libros — ni `owner`, ni `manage`, ni `fullcontrol`.
5. **La dirección exacta del sitio y la ruta de los dos ficheros**, tal como
   están, con sus espacios y sus tildes.
6. **Confirmación de que `graph.microsoft.com` es alcanzable por HTTPS de salida**
   desde el servidor, directamente o a través del proxy corporativo.
7. **Que el versionado del sitio esté activado** (suele estarlo), para poder
   volver atrás si una pasada escribe algo que no tocaba.
8. **Un dueño humano para la cuarentena.** Quién decide, cuando el Excel dice una
   serie y la aplicación dice otra, cuál de las dos es. Sin esa persona, la
   bandeja de choques se llena y la sincronización acaba desactivada.

---

## 10. Lo que falta en la base

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
pone la aplicación, la que no cambia nunca y la que va a la columna `Ref` del
Excel; `space_code` es lo que dice Patrimonio. Son tres identidades distintas con
tres dueños distintos, y meterlas en la misma columna es garantizar que una pise
a otra.

Y las tablas de la sincronización, que son cuatro:

| Tabla | Qué guarda | Por qué |
|---|---|---|
| `sync_ficheros` | Cada `.xlsx` visto, con su `cTag` y su `sha256` | La idempotencia va por hash y no por nombre ni fecha: los dos libros se llaman siempre igual, y la fecha cambia cuando alguien abre el libro y lo cierra sin tocarlo |
| `sync_filas` | Cada fila de cada hoja tal cual venía, con su `Ref` | Contesta «¿de dónde salió este dato?» seis meses después, y permite repetir una pasada fallida sin consecuencias |
| **`sync_celdas`** | **La instantánea: el valor exacto de cada celda tras la última pasada correcta** | **El antepasado común del apartado 4. Es la única de las cuatro que no se puede reconstruir si se pierde, y sin ella «bidireccional» solo puede significar «gana el último»** |
| `sync_partes` | El parte de cada pasada, abierto antes de empezar | Una pasada que se murió a la mitad tiene que verse como una fila sin cerrar, no desaparecer |

Los choques no estrenan tabla: van a `import_quarantine`, que ya existe y ya
tiene pantalla de resolución, con `source` empezando por `sharepoint` para
distinguirlos de los que dejó la importación inicial. `sync_choques` es solo la
vista con ese filtro y el orden con que se mira.

**Hecho** en `20260826000100_sincronizacion_con_sharepoint.sql`, con las tres
columnas nuevas, sus límites (un aula de 0 m² o de 4.000 asientos es un dedo que
resbaló, y se rechaza en la puerta) y su RLS: todo esto es material de
administración, y el parte lo lee además el supervisor, porque «¿cuándo se
sincronizó por última vez y cuántos choques dejó?» es una pregunta de quien firma
el informe del viernes.

---

## 11. Fases

| Fase | Qué se entrega | Se puede probar sin IT |
|---|---|---|
| **0** | **Prueba de concepto: ¿acepta la API de libro un token app-only?** Cinco llamadas contra un sitio desechable. Decide si se puede automatizar el transporte — **no** bloquea las fases 1 a 3, que valen igual con la vía manual | ❌ necesita un registro y un sitio de pruebas |
| 1 | **Hecho.** Lector de los dos libros + cruce contra el maestro, en seco: `npm run cruce:excel`. Resuelve por matrícula, alias, edificio+código y auditoría de edificios desaparecidos; cuenta y explica cada fila que no cruza. No escribe nada | ✅ con los ficheros de hoy |
| 2 | **Hecho.** Migración del apartado 10 + las cuatro tablas de sincronización + la instantánea + la fusión a tres bandas (`src/domain/fusion.ts`, 30 pruebas) + los choques a `import_quarantine`. Sigue sin escribir nada: devuelve decisiones | ✅ |
| 3 | **Hecho** (la columna `Ref`; las hojas como tablas de Excel, no: no hace falta para identificar filas). La columna va **al final**, no la primera — insertarla a la izquierda obliga a reescribir cada fórmula, el rango del autofiltro y los cuatro formatos condicionales | ✅ |
| **3b** | **Hecho.** La pantalla (`Sincronizar el Excel de SharePoint`, en administración) hace el viaje entero **en los dos sentidos**: subir → previsualizar hoja por hoja → aplicar a la base → descargar el libro sincronizado. La instantánea se guarda de verdad (`sync_celdas`, por matrícula y no por número de fila) y la vuelta entra en una transacción con `sync_aplicar` | ✅ |
| **3c** | **Hecho.** Las cinco hojas, no solo la de estado: partes con su material, bolsa con el consumo repartido mes a mes y las fórmulas pisadas devueltas a su sitio. Filas nuevas insertadas en el bloque de su edificio, filas de salas archivadas fuera, y el corte de año creando `Material Instalado <año>` y `Bolsa <año>` con el saldo de apertura | ✅ |
| **3d** | **Hecho.** Cuatro hojas nuevas para lo que no cabe en una celda: `Revisiones` (una fila por revisión con hora, autor y comprobaciones), `Movimientos de Almacén` (con el saldo detrás), `Inventario por Sala` (que sí puede enseñar un aula con dos proyectores) y `Sincronización` (los choques y la cuarentena, dentro del propio libro) | ✅ |
| 4 | Cliente de Graph: sondeo por `cTag`, descarga, y escritura por la API de libro con las reglas del apartado 6 | ❌ necesita el registro de aplicación |
| 5 | Endpoint del worker + `cron.schedule` + botón «sincronizar ahora» | ✅ |
| 6 | **Hecho a medias**: la hoja `Sincronización` se escribe en el libro y la pantalla lista los choques y la cuarentena de la pasada. Falta la bandeja que los guarda entre pasadas y deja marcarlos resueltos: hoy quedan en `import_quarantine` sin pantalla propia | ✅ |

La fase 1 es la que conviene hacer ya, y no por orden: es la que dice, **con los
ficheros reales y antes de gastar nada en integración**, cuántas de las 194 aulas
del libro de revisión cruzan con las 276 de la base y cuántas no. Si cruzaran
mal, todo lo demás sobra hasta arreglar los alias. Y la fase 3 conviene ensayarla
sobre una copia del libro antes de tocar el que usa la gente.

La fase 0 es barata —cinco llamadas— y va delante de cualquier petición formal a
IT. Pero ya no tumba el plan: si sale que no, se queda la fase 3b y la
sincronización funciona igual, con una persona moviendo el fichero.

---

## 11 bis. Lo que decide cada columna, hoy

El mapa vive en `src/domain/mapa.ts` y es la única declaración: ni el cruce, ni
la fusión, ni el volcado mencionan una letra de columna. Cada entrada lleva la
cabecera que espera encontrar, y **si no cuadra la pasada no empieza** — una
columna insertada mueve todas las de su derecha, y los dos lados de `M` son
texto corto en mayúsculas, así que a ojo no se distingue de nada.

Tres decisiones de dueño que salen de este libro y no de la teoría:

- **`Fecha Revisión Anterior` es de la app.** No es un dato: es la penúltima
  fecha de un historial, y escrita a mano deja de ser verdad en cuanto haya una
  revisión más.
- **`% Lámparas` es del Excel, a la fuerza.** La aplicación no lo mide en
  ninguna pantalla —de un proyector solo se apuntan las horas—, así que si se
  tratara como medida la app «ganaría» con el valor congelado de la importación
  y borraría lo que alguien acabara de apuntar en la hoja. Vuelve a ser de las
  dos partes el día que el formulario de revisión pida el porcentaje.
- **`Microfono Jabra` son tres columnas en una.** 32 filas dicen `SÍ` o `NO`, 37
  llevan el número de serie del aparato y 4 un modelo escrito a mano. Se parten
  por la forma del valor: escribir una encima de la otra pierde 37 series o 32
  respuestas, y no hay manera de elegir cuál de las dos pérdidas es la buena.

Y una regla que atraviesa todo: **lo que no se puede leer no se interpreta**. Un
`********` en la columna de horas es un vacío escrito a mano; un `19/0672025` en
la de fecha no es una fecha y no se adivina. Va a cuarentena con su celda y su
motivo, y no entra en la base ni se pisa en la hoja. Un cero inventado en la
columna de lámparas manda a alguien a un aula que está perfectamente.

---

## 12. Lo que puede salir mal

- **Que la API de libro no acepte un token sin usuario.** La documentación de
  Microsoft dice que esas llamadas no admiten permisos de aplicación. Lo resuelve
  la fase 0. Deja de ser mortal desde que existe la vía manual del apartado 5: si
  sale que no, se pierde la automatización del transporte, no la sincronización.
- **Que alguien regenere el fichero con un script.** Es el único fallo
  irreversible de esta lista: se pierden fórmulas y formatos y nadie sabe cuáles.
  Por eso la regla del apartado 6 va la primera y en negrita.
- **Que nadie vacíe la cuarentena.** El fallo más probable con diferencia. La
  sincronización seguirá funcionando y los choques seguirán sin resolverse, y en
  seis meses habrá quinientos. Por eso el apartado 9 pide un nombre.
- **Que se borre la columna `Ref`.** Sin ella la fusión no puede identificar
  filas. Va bloqueada, y si la comprobación de estructura no la encuentra, la
  pasada se aborta en vez de adivinar.
- **Que el secreto de cliente caduque.** Se para todo, sin ruido. La caducidad va
  anotada y el parte de cada pasada tiene que gritar cuando falla la
  autenticación.
- **Que dos personas editen la misma celda dentro de la misma media hora.** La
  fusión lo detecta y para las dos; es molesto y es lo correcto. Bajar el
  intervalo de sondeo reduce la ventana, pero no la elimina.
- **Que las dos fuentes empiecen a discrepar sistemáticamente** en horas de
  proyector o en series. Eso no es un problema de la sincronización: es que hay
  dos inventarios vivos. La sincronización lo hará visible, que es exactamente lo
  que hace falta para poder cerrar uno de los dos.
