# Auditoría de flujo, navegación, listados y ergonomía

Auditoría de seis dimensiones sobre el código real, con **cada hallazgo verificado
adversarialmente** contra el fichero citado antes de entrar en esta lista. El verificador
tenía instrucciones de refutar, no de confirmar, y de descartar ante la duda.

**63 hallazgos confirmados · 3 refutados y descartados.**

Lo que no está aquí es tan importante como lo que sí: los tres descartados parecían
problemas y no lo eran al leer el contexto completo. Están al final, con el motivo.

| Dimensión | Confirmados |
|---|---|
| Flujo y navegación | 9 |
| Búsquedas, listados y orden | 8 |
| Ergonomía táctil | 11 |
| Fluidez y rendimiento percibido | 12 |
| Coherencia de diseño | 12 |
| Accesibilidad y formularios | 11 |

| Gravedad | Nº |
|---|---|
| Alta | 26 |
| Media | 30 |
| Baja | 7 |

---

## Flujo y navegación

### `NAV-1` · «Guardar y siguiente sala» no lleva a ninguna sala: hace exactamente lo mismo que «Guardar»

**Alta** · esfuerzo M · `src/App.tsx:216`

InspectionPage declara `onDone: (nextRoom: boolean) => void` (InspectionPage.tsx:18) y el botón grande de acento llama a `void complete().then(() => onDone(true))` (InspectionPage.tsx:264), mientras que el botón secundario llama a `onDone(false)` (InspectionPage.tsx:256). App.tsx ignora el parámetro: los dos vuelven a la lista de salas. El botón que ocupa dos tercios de la barra de acción promete encadenar salas y no encadena nada. El técnico termina un aula, lee «siguiente sala», y aterriza en la lista teniendo que buscar a mano por dónde iba — que es justo el gesto que el botón dice que le ahorra. Multiplicado por 276 salas es la fricción más cara de la aplicación, y además es una promesa incumplida: el tipo de la prop demuestra que el diseño previó la navegación y App.tsx se la comió.

**Arreglo.** Calcular la siguiente sala en App.tsx con el mismo criterio que RoomListPage (más antigua primero, dentro del edificio) y saltar directamente a ella: subir la consulta ordenada de salas a App (o exponerla desde un `useRoomsOrdered(building.id)` compartido por RoomListPage y App), y en `onDone` hacer `onDone={(next) => { const siguiente = next ? salasOrdenadas.find(r => r.id !== view.room.id && !yaRevisadaEnEstaRonda(r)) : null; setView(siguiente ? { name: 'revision', building: view.building, room: siguiente } : { name: 'salas', building: view.building }) }}`. Si no queda ninguna, volver a la lista y decirlo. Y si se decide no implementarlo, quitar el segundo botón: dos botones idénticos con etiquetas distintas es peor que uno.

> **Matiz del verificador.** El diagnóstico es correcto; el arreglo propuesto invoca `yaRevisadaEnEstaRonda(r)`, una función que no existe en el repositorio. Si se aplica antes el arreglo de NAV-2 (escribir `last_inspection_at` en local al completar), no hace falta inventar esa función: basta reutilizar el mismo orden de RoomListPage.tsx:35-41 y coger la primera sala distinta de la actual, porque la recién terminada ya habrá caído al final de la lista.

### `NAV-2` · La sala que acabas de revisar sigue apareciendo «Sin revisar» y en lo alto de la lista

**Alta** · esfuerzo S · `src/features/inspection/useInspection.ts:315`

`complete()` guarda la inspección y sus checks, pero nunca toca `db.rooms`. El único sitio donde se escribe `last_inspection_at` es el pull del servidor (src/sync/pull.ts:48). RoomListPage ordena y etiqueta las filas exclusivamente con ese campo (RoomListPage.tsx:40 y :62), y el distintivo «A medias» desaparece al pasar el borrador a `completa`. Resultado: al volver de la revisión, la sala recién terminada sigue con el raíl naranja, sigue diciendo «Sin revisar» o «Hace 412 d», y sigue siendo la primera de la lista — indistinguible de la que no has tocado. Sin cobertura (que es el caso normal en un aula) esto dura toda la mañana. La lista deja de funcionar como ruta de trabajo justo en el momento en que más se necesita, y el riesgo real es volver a entrar en un aula ya hecha.

**Arreglo.** En `complete()`, junto al `db.inspections.put`, escribir también la sala en local: `await db.rooms.update(inspection.room_id, { last_inspection_at: inspection.occurred_at })`. Es optimista y el siguiente `pullMaster()` lo confirma con el valor del servidor. Con eso la fila baja sola en la lista y cambia a verde sin esperar a tener red.

> **Matiz del verificador.** El problema es incluso peor de lo descrito: `pullMaster()` solo se llama en un sitio, App.tsx:84, dentro del `useEffect([unlocked])`. No hay pull periódico ni al volver de la revisión. Así que la fila obsoleta no se arregla «cuando haya cobertura», sino solo tras bloquear y desbloquear la sesión o recargar la aplicación. El arreglo propuesto (`db.rooms.update(inspection.room_id, { last_inspection_at: inspection.occurred_at })`) es válido y `rooms` está indexado por `id` (dexie.ts:97).

### `NAV-3` · El aviso de versión nueva tapa los botones de guardar, y su «Actualizar» cae exactamente donde estaba «Guardar y siguiente sala»

**Alta** · esfuerzo S · `src/components/UpdatePrompt.tsx:37`

La barra de acción de la revisión es `fixed inset-x-0 bottom-0` sin z-index (InspectionPage.tsx:240); el aviso lleva `z-30` y se pinta encima, en la misma esquina inferior. Los dos botones de guardar quedan cubiertos: no se puede cerrar la revisión hasta pulsar «Ahora no». Y peor: el botón de acento del aviso («Actualizar», UpdatePrompt.tsx:52) queda pegado al borde derecho, que es donde vive el botón de acento de la revisión (`key key-accent h-touch flex-[2]`, InspectionPage.tsx:265). El pulgar va por costumbre al acento de la derecha y en vez de guardar recarga la aplicación en mitad del aula. El comentario de App.tsx:230-234 ya identificó esta colisión para la barra de pestañas y la resolvió ocultándola; el aviso se quedó fuera de esa corrección.

**Arreglo.** No mostrar el aviso mientras hay una revisión abierta. En App.tsx, `inspecting` ya existe (línea 144): pasarlo como prop y devolver `null` (`if (!needRefresh || suspendido) return null`), o mover `<UpdatePrompt />` dentro del bloque `{!inspecting && (...)}`. El aviso reaparece al volver a la lista, que es cuando recargar no cuesta nada. Como cinturón adicional, dar a la barra de acción de InspectionPage un `z-20` explícito para que nada futuro vuelva a taparla.

### `NAV-4` · No hay forma de buscar una sala: llegar a un aula concreta es desplegar 23 edificios y bajar por una lista de hasta 39 salas

**Alta** · esfuerzo M · `src/features/rooms/RoomListPage.tsx:57`

Ni la lista de edificios (App.tsx:172-199, un `<ul>` pelado) ni la de salas tienen campo de búsqueda; no hay atajo, ni enlace, ni escaneo de código. El único camino es edificio → sala: dos toques más el desplazamiento. Con los datos reales del seed son 23 edificios y hasta 39 salas en un solo edificio (repartidas en 6 zonas), así que «dos toques» significa en la práctica dos toques y dos búsquedas visuales de pie, sujetando el iPad con una mano. Y cuando llega un aviso concreto («falla el proyector del -2.1 del H»), el técnico tiene que recordar en qué edificio está esa sala antes de poder abrirla. La aplicación sí sabe buscar en otras pantallas — StockPage.tsx:67 tiene `placeholder="Buscar artículo"` —, solo que no donde más se usa.

**Arreglo.** Añadir un único campo de búsqueda en la pantalla de edificios que filtre sobre `db.rooms` de todos los edificios a la vez (por `code` normalizado con `norm()` y por `name`), mostrando «CÓDIGO · Edificio · Planta» y llevando de un toque a `{ name: 'revision', building, room }`. Reutiliza la infraestructura que ya existe (Dexie tiene `rooms: 'id, zone_id, code, ...'` en dexie.ts:97). Un toque desde el arranque en vez de dos más dos rastreos visuales.

### `NAV-5` · Las plantas se mezclan en la lista de salas: el técnico recorre un edificio en zigzag

**Media** · esfuerzo M · `src/features/rooms/RoomListPage.tsx:40`

La lista se ordena solo por antigüedad de revisión, así que dos salas consecutivas pueden estar en la planta -2 y en la 2ª planta. El nombre de la zona aparece en cada fila (RoomListPage.tsx:88) pero no agrupa ni filtra nada. En los datos reales hay edificios de 39 salas repartidas en 6 zonas ('PLANTA BAJA', '1ª PLANTA', '2ª PLANTA', 'PLANTA -1', 'PLANTA -2', 'LABORATORIO H') y otro de 35 salas en 6 módulos. Seguir el orden que propone la lista obliga a subir y bajar escaleras entre aula y aula; ignorarlo obliga a rastrear la lista entera cada vez para encontrar las salas de la planta en la que estás. Además, `zones` trae `sort_order` desde el servidor (supabase/seed.sql) y la aplicación no lo usa para nada.

**Arreglo.** Agrupar por zona respetando `zone.sort_order`, con una cabecera pegajosa por planta, y mantener dentro de cada grupo el orden «la más antigua primero» que ya funciona. Alternativa más barata: una fila de chips de zona bajo la cabecera (`Todas · Planta baja · 1ª · 2ª · -1`) que filtre `rooms` por `zone_id`; dos líneas de estado y el orden actual intacto.

### `NAV-6` · La app no usa historial: el gesto de retroceso la cierra, y al volver a abrirla has perdido el sitio

**Media** · esfuerzo M · `src/App.tsx:52`

Toda la navegación es estado en memoria. Un grep por `pushState`, `popstate`, `history.`, `location.hash` o `useNavigate` en `src/` e `index.html` no devuelve una sola coincidencia. Consecuencias concretas para quien va de pie: (1) el manifiesto declara `display: 'standalone'` (vite.config.ts:19), así que el gesto de retroceso de Android no vuelve de la revisión a la lista — cierra la aplicación; en iOS el deslizamiento desde el borde simplemente no hace nada, y el técnico concluye que la pantalla se ha colgado. (2) Como `tab` y `view` no se persisten en ningún sitio, cualquier recarga —pulsar «Actualizar», que iOS descarte la pestaña por memoria, reiniciar el iPad— devuelve a la lista de edificios: el borrador de la revisión se recupera bien desde Dexie (useInspection.ts:164-180), pero hay que volver a navegar edificio → sala para llegar a él. El propio comentario de UpdatePrompt.tsx lo reconoce: «perdería el sitio donde iba».

**Arreglo.** Dos arreglos pequeños e independientes. (a) Persistir la ubicación: guardar `{ tab, buildingId, roomId }` en `db.meta` (o `localStorage`) cada vez que cambian, y rehidratar `view` al desbloquear leyendo el edificio y la sala por id. (b) Dar sentido al gesto atrás: `history.pushState({ view: 'salas' }, '')` al entrar en salas y en revisión, y un `useEffect` con `window.addEventListener('popstate', ...)` que retroceda un nivel de `view` en vez de dejar que el sistema cierre la aplicación.

### `NAV-7` · Salir y volver a entrar en una revisión olvida las fotos ya hechas y vuelve a exigirlas

**Media** · esfuerzo S · `src/features/inspection/InspectionPage.tsx:38`

El contador de fotos es estado local del componente y solo sube al capturar (línea 62). Las fotos, en cambio, están persistidas en Dexie con índice `[entityType+entityId]` (dexie.ts:108). Al salir de la revisión —cosa que hay que hacer para cualquier otra cosa, porque la barra de pestañas desaparece durante la revisión (App.tsx:144 y :235)— InspectionPage se desmonta. Al reentrar, el borrador y todos los checks se recuperan correctamente, pero `photoCount` vuelve a 0: el botón dice otra vez «Añadir foto» en lugar de «2 fotos · añadir otra» (línea 219) y reaparece el aviso «Añade una foto de la incidencia» (líneas 54 y 223). El técnico, que ya la hizo, vuelve a fotografiar el mismo proyector para callar el aviso. La revisión parece haber perdido trabajo aunque no lo haya perdido, que en una aplicación offline es exactamente la desconfianza que no puedes permitirte.

**Arreglo.** Sustituir el `useState` por una consulta viva sobre el índice que ya existe: `const photoCount = useLiveQuery(async () => draft ? db.photos.where('[entityType+entityId]').equals(['inspection', draft.inspection.id]).count() : 0, [draft?.inspection.id]) ?? 0`, y eliminar `setPhotoCount` de `onPickPhoto` (el índice se actualiza solo al hacer `db.photos.put`).

> **Matiz del verificador.** El arreglo propuesto está incompleto y reintroduce el mismo susto en cuanto haya cobertura: `pushPhoto` borra la foto de la cola al subirla con éxito, `await db.photos.delete(photo.id)` en src/sync/outbox.ts:166. Contar `db.photos` daría 2, 1, 0 según se van subiendo, y el aviso «Añade una foto de la incidencia» reaparecería con las fotos ya hechas y a salvo en el servidor. La tabla `attachments` de Dexie (dexie.ts:105, índice `[entity_type+entity_id]`) tampoco sirve tal cual: `pullMaster()` no la descarga nunca, está siempre vacía en local. El arreglo correcto es escribir también una fila local en `db.attachments` al capturar (en photos.ts, junto al `db.photos.put`) y contar `photos + attachments`, o —más barato— llevar el contador en el propio borrador de la inspección, que ya se persiste.

### `NAV-8` · La pestaña Incidencias no dice de qué sala es cada incidencia, aunque tiene el dato delante

**Media** · esfuerzo M · `src/features/incidents/IncidentsPage.tsx:15`

`room_id` está declarado en `IncidentRow` y llega en el `select('*')` (línea 37), pero no se pinta en ninguna parte del JSX: cada fila muestra título, referencia externa y días abiertos, nada más. El técnico está de pie en un aula y no puede saber si alguna de las incidencias abiertas es de esa aula, ni ir de una incidencia al aula donde tiene que resolverla — es un callejón sin salida en la navegación. El panel sí lo resuelve para su tabla equivalente (DashboardPage.tsx:159, `{i.building_code ?? '—'} {i.room_code ?? ''}`), así que el patrón ya existe y esta pantalla se quedó fuera.

**Arreglo.** Resolver la sala en local, que ya está en Dexie: `const rooms = useLiveQuery(() => db.rooms.toArray(), [])` (y `db.zones`/`db.buildings` para el edificio) y pintar `EDIFICIO · CÓDIGO` bajo el título con `displayRoomCode(room.code)`. Si además la fila es pulsable y lleva a la revisión de esa sala, se cierra el círculo incidencia → aula sin volver a Revisar y navegar a mano.

> **Matiz del verificador.** El número de línea del contraste está mal: el patrón `{i.building_code ?? '—'} {i.room_code ?? ''}` está en src/features/dashboard/DashboardPage.tsx:163, no en la 159. El resto del hallazgo es correcto. Añado un matiz que refuerza el arreglo: esta pantalla lee directamente de Supabase con react-query (línea 37), no de Dexie, así que sin cobertura no muestra nada; resolver la sala desde `db.rooms` como propone el arreglo es además el único trozo de esta pantalla que funcionaría offline.

### `NAV-9` · Las pestañas, que son la navegación principal, miden unos 40 px de alto — por debajo del propio estándar táctil del proyecto

**Baja** · esfuerzo S · `src/App.tsx:247`

`py-3` (24 px) más `text-xs` (interlineado 16 px) da un objetivo de ~40 px de alto, y encima está pegado al borde inferior donde vive la zona de gestos del sistema. El proyecto define su propia medida táctil, `touch: '3.5rem'` (tailwind.config.js:69 = 56 px), y la usa para los botones de la revisión (`h-touch`); la barra de pestañas no la usa. Con una sola mano, el pulgar que barre el borde inferior del iPad falla o dispara el gesto del sistema en vez de cambiar de pestaña. Es la navegación que más veces se toca al día.

**Arreglo.** Cambiar el botón a `flex h-touch w-full items-center justify-center` (o `py-4`) manteniendo `text-xs`. El `paddingBottom: env(safe-area-inset-bottom)` del `<nav>` (App.tsx:238) ya está bien puesto y separa la barra del gesto del sistema; solo falta que la zona pulsable llegue a los 56 px que el propio sistema de diseño fija.


---

## Búsquedas, listados y orden

### `LIST-1` · La lista de salas no tiene buscador: encontrar un aula concreta es leer fila a fila

**Alta** · esfuerzo M · `src/features/rooms/RoomListPage.tsx:57`

La cabecera (líneas 52-58) no tiene ningún campo de búsqueda, y la lista tampoco. El edificio H tiene 39 salas y el CRAI 38 (contadas en supabase/seed.sql), y como el orden es por fecha de última revisión (línea 40) los códigos salen desordenados: no se puede escanear la columna buscando «H-1.12». Al técnico le llaman por radio «ve al aula X» y tiene que recorrer 39 filas con el pulgar. La única búsqueda de todo el producto vive en el almacén (StockPage.tsx:63-69), sobre 116 artículos — es decir, hay buscador donde hay 116 cosas y no lo hay donde hay 276.

**Arreglo.** Añadir en la cabecera el mismo `<input type="search">` que ya usa StockPage.tsx:63-69, con estado `filtro`, y filtrar `rooms` por `norm()` (ya existe en @/domain/normalize) sobre `room.code`, `room.name` y el nombre de la zona antes del `.map()` de la línea 61. Diez líneas, ningún cambio de arquitectura.

> **Matiz del verificador.** Dos matices de redacción. (a) «La única búsqueda de todo el producto vive en el almacén» no es exacto: RoomInventory.tsx:73-82 tiene otro campo que busca en el catálogo de tipos (`searchCatalog`, línea 36). Lo exacto: el único buscador sobre una lista de entidades —y el único `type="search"` del proyecto— es el del almacén (StockPage.tsx:63-69), sobre 116 artículos. (b) Los códigos de sala no llevan prefijo de edificio: en el H son '1.12', '0.1 (Aula Refinitv)', 'Sala Reuniones 6', 'LAB CRIMINOLOGÍA' (seed.sql), así que el ejemplo «H-1.12» debe ser «1.12», y el filtro tiene que cubrir también los códigos no numéricos, no solo los de planta.punto.

### `LIST-2` · El orden por antigüedad rompe la planta: la «ruta de trabajo» hace subir y bajar escaleras

**Alta** · esfuerzo M · `src/features/rooms/RoomListPage.tsx:40`

El comentario de las líneas 17-23 dice que este orden «convierte la lista en una ruta de trabajo». No lo es: es una ruta temporal, no física. El edificio H tiene 39 salas repartidas en 6 zonas (PLANTA BAJA 13, 1ª PLANTA 15, 2ª PLANTA 4, PLANTA -1 3, LABORATORIO H 1, PLANTA -2 3), y ordenar por `last_inspection_at` las baraja: la fila 1 puede ser de la planta -2, la 2 de la 1ª y la 3 de la baja. El componente ya pinta la zona en cada fila (línea 88) precisamente porque el usuario la necesita para orientarse, lo que confirma que el recorrido es por plantas. Además no hay ningún control para cambiar el criterio: el orden es fijo y no negociable.

**Arreglo.** El `useLiveQuery` de la línea 25 ya carga las zonas, y `Zone` tiene `sort_order` (src/domain/types.ts:116). Guardar también un `Map<zone_id, sort_order>` y añadir un selector de dos posiciones en la cabecera — «Por antigüedad» / «Por planta» — donde la segunda ordene por `sort_order` de zona y luego por `code.localeCompare(b.code, 'es', { numeric: true })`. El texto de la línea 57 pasa a reflejar el criterio activo.

> **Matiz del verificador.** Precisión sobre el arreglo: el `useLiveQuery` de las líneas 25-28 construye hoy un `Map<id, name>` (`new Map(zones.map((z) => [z.id, z.name]))`); hay que ampliarlo a nombre + sort_order, no basta con reutilizarlo. Y el desempate con `{ numeric: true }` es imprescindible, no opcional: en el mismo edificio conviven '0.2' y '0.10', que un localeCompare normal ordena al revés.

### `LIST-3` · 283 incidencias sin buscador, y la sala ni siquiera se muestra

**Alta** · esfuerzo M · `src/features/incidents/IncidentsPage.tsx:93`

La pantalla descarga `room_id` (declarado en la línea 15 del propio fichero) y no lo pinta en ningún sitio: el subtítulo solo enseña la referencia externa y los días abiertos. El técnico está de pie en un aula y no puede responder a «¿qué hay reportado aquí?», ni buscando ni mirando. Tampoco hay campo de búsqueda por título ni por `external_ref`, así que localizar el parte `I260203_0051` entre 283 filas es scroll a ciegas. El único control de la pantalla es la casilla «Incluir resueltas» (líneas 65-72).

**Arreglo.** Dos cosas pequeñas: (1) resolver el código de sala desde Dexie (`db.rooms` ya está en local, pull.ts:51) y pintarlo en ese mismo `<p>` delante de «abierta hace»; (2) añadir un `<input type="search">` junto a la casilla que filtre en cliente por título, `external_ref` y código de sala, con el mismo patrón de StockPage.tsx:53-55.

> **Matiz del verificador.** Cuantificar mejor el alcance: de las 283 incidencias del seed, 165 traen room_id y 118 lo tienen a NULL (importadas sin sala identificable), así que el código de sala saldrá en ~58% de las filas y hace falta un fallback para el resto. Y ojo al contexto: 281 de las 283 están 'resuelta' y solo 2 siguen abiertas, así que con la pantalla en su estado por defecto la lista tiene 2 filas — tanto el buscador como la columna de sala pesan sobre todo con «Incluir resueltas» marcada, que es cuando la lista salta a 200 filas.

### `LIST-4` · `.limit(200)` sobre 283 incidencias: 83 desaparecen y nada lo dice

**Alta** · esfuerzo S · `src/features/incidents/IncidentsPage.tsx:37`

El histórico tiene 283 incidencias (contadas en supabase/seed.sql). Al marcar «Incluir resueltas» la consulta devuelve como mucho 200 y las 83 más antiguas se quedan fuera sin ningún aviso en pantalla: la lista simplemente se acaba. Son justo las viejas, que es lo que un supervisor va a buscar cuando revisa lo que se quedó colgado. Además el orden `opened_at desc` es el único posible: no hay forma de ver las más antiguas primero, que es la pregunta contraria y igual de legítima. El criterio tampoco aparece escrito en ninguna parte — la cabecera (líneas 63-73) solo dice «Incidencias».

**Arreglo.** Escribir el criterio bajo el título («las más recientes primero», como ya hace RoomListPage.tsx:57) y ponerlo pulsable para invertir el `ascending`. Y cuando `incidents.length === 200`, un pie de lista tipo «Se muestran las 200 más recientes» en vez de cortar en silencio.

### `LIST-6` · La cuarentena de importación se pide sin `.order()`: orden no determinista

**Media** · esfuerzo S · `src/features/admin/CleanupPage.tsx:60`

`import_quarantine` es una tabla real, no una vista con `order by` (supabase/migrations/20260728000100_schema.sql:299-309, con `id bigserial primary key`). Una consulta a una tabla sin `ORDER BY` en Postgres no garantiza ningún orden, y además el `UPDATE` que hace `dismiss` (líneas 94-101) puede mover la fila dentro del heap. Efecto práctico: el coordinador marca una fila como «Revisada» y las demás pueden reordenarse debajo del dedo, y con el `.limit(100)` puede entrar y salir de la lista un conjunto distinto en cada recarga. Es el peor caso de los tres: no es un orden malo, es no tener orden. Las otras dos consultas del fichero sí lo tienen (`.order('code')`, líneas 40 y 52).

**Arreglo.** Añadir `.order('at', { ascending: true })` a la cadena (la columna `at timestamptz not null default now()` ya existe en el esquema): las más antiguas primero, que es el criterio de una bandeja de pendientes. Una línea.

### `LIST-8` · La tabla de lámparas no tiene cabecera ni dice por qué está en ese orden

**Media** · esfuerzo S · `src/features/dashboard/DashboardPage.tsx:117`

Es un `<table>` sin `<thead>`: tres columnas anónimas con «H 1.12», «4200 h» y una barra con un porcentaje. Hay que deducir qué es cada una. Y el criterio de orden tampoco está: la vista ordena por `lamp_pct asc` (supabase/migrations/20260728000200_views.sql:96, las peores primero), pero la pantalla no lo dice — de hecho la línea 113, justo bajo el título, es un hueco vacío donde la sección gemela de al lado sí pone su subtítulo («Más de 7 días abiertas», línea 150). Comparando las dos secciones se ve que a esta le falta la frase.

**Arreglo.** Rellenar la línea 113 con `<p className="mb-3 text-xs text-muted">Las más gastadas primero</p>`, copiando el patrón exacto de la línea 150, y añadir un `<thead>` con «Sala · Horas · Lámpara restante». Todo markup, sin tocar datos.

> **Matiz del verificador.** Añadir dos precisiones. (1) El mismo hueco vacío aparece en DashboardPage.tsx:51, dentro del StatTile de lámparas, donde las teselas hermanas sí llevan `detail` (líneas 34 y 40): al mosaico de lámparas también le falta su línea de detalle, y son el mismo síntoma. (2) La tercera columna es vida restante de la lámpara (`lamp_pct`), no consumida, así que la cabecera correcta es «Sala · Horas de proyector · Lámpara restante».

### `LIST-10` · El inventario de la sala no tiene orden, y contradice al de la revisión en la misma pantalla

**Media** · esfuerzo S · `src/features/inventory/RoomInventory.tsx:35`

Ni un `.sort()`: la lista sale en el orden en que Dexie devuelva el índice `room_id` (dexie.ts:101), es decir, orden de alta. Y justo encima, en la misma pantalla, las filas de la revisión sí van ordenadas por recorrido físico del aula — `TYPE_ORDER` en useInspection.ts:45-54, aplicado en las líneas 101-108 con el comentario «El técnico entra por la puerta y mira primero lo que se ve desde el fondo del aula». Así que el mismo equipamiento aparece dos veces en la misma pantalla en dos órdenes distintos: arriba proyector-pantalla-altavoces, abajo lo que se dio de alta primero. Al corregir un aparato hay que volver a buscarlo con otro criterio.

**Arreglo.** Reutilizar el mismo criterio: exportar la función de rango de useInspection.ts (o simplemente `TYPE_ORDER`) y aplicar en la línea 35 el mismo `.sort()` con desempate `a.label.localeCompare(b.label, 'es', { numeric: true })`. Así las dos listas de la pantalla se leen igual.

> **Matiz del verificador.** Precisión sobre el arreglo: el `.sort()` de useInspection opera sobre `CheckRow` y rankea con `norm(resolveType(types, row.asset?.asset_type_id ?? '')?.name ?? '')` (línea 103), no sobre el asset directo. Para reutilizarlo en RoomInventory hay que exportar TYPE_ORDER y rankear por el tipo resuelto con `resolveType(typesById, a.asset_type_id)` — `typesById` ya llega por props (RoomInventory.tsx:24) y ya se usa en la línea 118, así que no hace falta cargar nada nuevo.

### `LIST-11` · El almacén solo ordena alfabéticamente, incluso al filtrar por «bajo mínimo»

**Media** · esfuerzo M · `src/features/inventory/StockPage.tsx:32`

116 artículos ordenados por nombre y sin alternativa. La pregunta real del almacén no es alfabética: es «¿qué hay que reponer y en qué orden?». Al marcar «Solo bajo mínimo» (líneas 70-73) el subconjunto sigue saliendo por nombre, no por lo lejos que está del umbral, así que lo que está a cero y lo que le falta una unidad se mezclan. Las cabeceras de la tabla (líneas 80-83: «Artículo», «Existencias», «Mínimo») no son pulsables y ninguna indica cuál manda. Además `total_consumed` se descarga (declarado en la línea 12) y no se usa para nada, con lo que tampoco se puede ver qué se gasta más.

**Arreglo.** Hacer pulsables los `<th>` de «Artículo» y «Existencias» con un estado `orden` en cliente (los datos ya vienen enteros, no hace falta tocar Supabase), marcando la columna activa con una flecha ▲/▼. Por defecto, cuando `onlyLow` está activo, ordenar por `on_hand - min_threshold` ascendente: lo más urgente arriba.

> **Matiz del verificador.** La parte de «Solo bajo mínimo» hay que reescribirla: no es que el subconjunto salga mal ordenado, es que hoy está vacío. `below_threshold` exige `si.min_threshold > 0` (20260728000200_views.sql:31), el seed inserta los artículos solo con (id, name) sobre `min_threshold int not null default 0` (schema.sql:128), y no hay ningún punto de la app que fije un mínimo (grep min_threshold: solo StockPage.tsx:10 y 110, y types.ts:231). Con los datos servidos, marcar la casilla de las líneas 70-73 deja la tabla en «Ningún artículo coincide». Lo que sí se sostiene, y es lo que hay que arreglar: 116 artículos con un único orden alfabético, cabeceras no pulsables, y `total_consumed` —que la vista sí calcula (views.sql:26)— descargado y nunca mostrado. Ordenar por consumo es la alternativa que hoy tiene datos reales detrás; ordenar por distancia al umbral no los tiene.


---

## Ergonomía táctil

### `ERG-1` · «Retirar de la sala» borra un equipo para siempre, sin confirmar, en un botón de 32px pegado al de al lado

**Alta** · esfuerzo S · `src/features/inventory/RoomInventory.tsx:264`

El botón mide 32px de alto (text-xs = 16px de interlínea + py-2 = 8+8) y comparte una fila `flex gap-2` con «Averiado» (línea 255). Un toque desviado con el pulgar, de pie, cae en el equivocado. Y las consecuencias son asimétricas: «Averiado» es un interruptor reversible (useRoomInventory.ts:119 lo alterna), pero «Retirar» es un viaje sin vuelta desde la app. Retirado el equipo desaparece de `live` (RoomInventory.tsx:35), desaparece de las filas de la revisión (useInspection.ts:79) y ni siquiera se vuelve a descargar del servidor (pull.ts:26 hace `.neq('status', 'retirado')`). No hay ninguna vista en toda la aplicación que liste retirados: el técnico no tiene forma de deshacerlo. Mientras tanto, cerrar sesión —que solo cuesta teclear el PIN otra vez— sí se confirma (App.tsx:159).

**Arreglo.** Dos cosas, ninguna grande. (1) Confirmar, igual que ya se hace en App.tsx:159: `if (confirm(`¿Retirar «${asset.label ?? 'este equipo'}» de la sala? No podrás volver a verlo desde aquí.`)) onStatus('retirado')`. (2) Separarlo visual y físicamente de «Averiado»: sacarlo de la fila `flex gap-2` y ponerlo debajo, a ancho completo, con `h-11` y estilo destructivo (`text-crit`), no como gemelo gris de un interruptor reversible.

> **Matiz del verificador.** El hallazgo se queda corto en un punto que lo refuerza: useRoomInventory.ts:117-118 documenta explícitamente la intención contraria — «Volver a pulsar el mismo estado lo deshace: es un interruptor, no una acción irreversible que obligue a buscar cómo revertirla». La línea 119 alterna los DOS estados por igual, así que el código cree que «Retirar» es reversible; lo que rompe esa promesa es que la fila desaparece de `live` (línea 35) y con ella el AssetFixer que contiene el botón. O sea: no es que «Averiado» sea interruptor y «Retirar» no, es que la app documenta que ambos lo son y la UI desmonta el único mando de vuelta.

### `ERG-2` · El acelerador «Marcar OK las N restantes» vive arriba del todo; el aviso de que faltan, abajo

**Alta** · esfuerzo M · `src/features/inspection/InspectionPage.tsx:87`

Este botón está renderizado antes de la lista de filas (línea 101), o sea arriba del todo. Las filas salen del inventario (useInspection.ts:77-124), así que en un aula con 8-12 aparatos más las comprobaciones de sala la lista es larga. El recorrido real es: bajar, encontrar la avería en la fila 9, rellenar gravedad y nota, y entonces querer cerrar el resto — pero el botón que lo hace ya está fuera de pantalla, arriba. Y la barra fija de abajo, que sí está bajo el pulgar, se limita a informar de lo que falta sin ofrecer resolverlo: `Faltan ${missing.length} comprobacion...` (línea 247). Información y acción en extremos opuestos de la pantalla, justo en la operación que el equipo repite ~276 veces.

**Arreglo.** Mover el atajo al sitio donde ya se anuncia el problema: en la barra fija, sustituir el texto pasivo «Faltan N comprobaciones» por un botón `markRestOk` cuando `missing.length > 0`. La barra ya tiene una fila superior libre (línea 243). El botón de arriba puede quedarse para el caso «Todo correcto» de entrada, pero el de «marcar las restantes» tiene que estar donde está el pulgar cuando surge la necesidad.

> **Matiz del verificador.** Matiz sobre el arreglo: la línea 243 no es «una fila superior libre», es el `div mb-2 flex items-center justify-between text-xs text-muted` que ya contiene el contador de pendientes (245-248) y el indicador de guardado (249). El cambio correcto es sustituir el `<span>` del contador (244-248) por el botón `markRestOk` cuando `missing.length > 0`, conservando el `<span>{saving ? 'Guardando…' : 'Guardado'}</span>` a la derecha.

### `ERG-3` · Añadir una foto comprime varios megapíxeles sin dar ninguna señal: el botón se queda mudo

**Alta** · esfuerzo S · `src/features/inspection/InspectionPage.tsx:213`

`onPickPhoto` (línea 56) llama a `capturePhoto`, que ejecuta `imageCompression` reescalando a 1600px y 0,2 MB (photos.ts:54-60). Con una foto de 12 MP en un iPad de flota eso son segundos. Durante todo ese tiempo el estado del componente no cambia: solo hay `photoError` y `photoCount` (líneas 37-38), no hay bandera de ocupado. La etiqueta sigue diciendo «Añadir foto», el botón sigue habilitado y sigue abriendo el selector. El técnico, que no ve nada, vuelve a pulsar. La propia aplicación ya sabe hacer esto bien en otras pantallas: ReportsPage.tsx:89-93 (`disabled={... || generate.isPending}` y texto «Generando…») y LockScreen.tsx:154-157 (`busy`). Aquí no.

**Arreglo.** Añadir `const [subiendo, setSubiendo] = useState(false)`, ponerlo a true al entrar en `onPickPhoto` y a false en un `finally`. En el botón: `disabled={subiendo}` y etiqueta `subiendo ? 'Procesando la foto…' : ...`. Es el mismo patrón que ya usa ReportsPage.

> **Matiz del verificador.** Detalle técnico que conviene decir bien: `useWebWorker: true` (photos.ts:57) mantiene el hilo principal libre, así que la interfaz no se congela. Eso empeora el problema en vez de mitigarlo — no hay ni siquiera el tirón de la interfaz como señal involuntaria de que algo está pasando. El botón simplemente no reacciona.

### `ERG-4` · Las tres teclas de gravedad miden 32px, justo después de declarar una avería

**Alta** · esfuerzo S · `src/features/inspection/InspectionPage.tsx:149`

32px de alto (text-xs = 16px de interlínea + py-2 = 8+8), por debajo del mínimo de 44px que el propio proyecto se impone y documenta en TriState.tsx:14 («44px de alto mínimo: se pulsa con el pulgar, de pie, en un aula»). El TriState de la línea 121 cumple con `h-11`; estas no. Y son consecuentes: la gravedad decide la prioridad de la incidencia, y el valor por defecto silencioso es 'media' (useInspection.ts:241), así que un fallo al pulsar «Impide la clase» deja la avería crítica archivada como molestia. Encima son tres en `grid-cols-3 gap-2` (línea 143), así que en un móvil estrecho cada una ronda los 100px de ancho y «Impide la clase» parte en dos líneas dentro de una caja de 32px.

**Arreglo.** Cambiar a `key h-11 px-2 text-xs` (o `h-touch`, dado que es una decisión de una sola vez por incidencia y hay sitio de sobra). Con `h-11` el texto de dos líneas también deja de apretar contra el borde.

> **Matiz del verificador.** Dos precisiones. (1) El comentario del proyecto que fija el mínimo de 44px está en TriState.tsx:11, no en la 14: «- 44px de alto mínimo: se pulsa con el pulgar, de pie, en un aula.» La 14 es otra frase. (2) El «parte en dos líneas dentro de una caja de 32px» es contradictorio: si «Impide la clase» envuelve, la caja crece a 48px. Lo real y comprobable es que en una pantalla ancha la tecla mide 32px, y en una estrecha el texto se aprieta contra los bordes porque sólo hay `px-2`. En ambos casos incumple el estándar propio y es incoherente con el `h-11` de TriState.

### `ERG-5` · La barra fija tapa el campo que el técnico acaba de enfocar: no hay scroll-padding en ninguna parte

**Media** · esfuerzo S · `src/features/inspection/InspectionPage.tsx:239`

Esta barra mide unos 104px más el área segura (12 + 16 de la fila text-xs + 8 de mb-2 + 56 de h-touch + 12), o sea ~138px en un iPhone con barra de gestos. Al enfocar un campo, el navegador desplaza el elemento hasta hacerlo visible en el viewport visual —que descuenta el teclado pero no sabe nada de un overlay `position: fixed`—, así que el campo aterriza detrás de la barra. Afecta a los tres campos de escritura de la pantalla: el textarea «¿Qué has visto?» (línea 158), el número de medida (línea 172) y las observaciones (línea 227), y también a los inputs de AssetFixer (RoomInventory.tsx:214-250). Un grep de `scroll-padding`, `scrollIntoView` y `visualViewport` sobre todo `src/` no devuelve nada: no hay ninguna compensación, ni en CSS ni en JS.

**Arreglo.** Una línea en index.css, dentro de `@layer base`, en la regla `html` que ya existe (línea 11): `scroll-padding-bottom: calc(9rem + env(safe-area-inset-bottom));`. El desplazamiento automático al enfocar respeta ese margen y el campo queda por encima de la barra. Es lo mismo que ya se hace con `pb-32` para el contenido estático, pero para el scroll de foco.

> **Matiz del verificador.** El mecanismo está descrito de forma demasiado universal. El solape es seguro cuando el viewport de disposición se reduce con el teclado (Chrome/Android) y cuando no hay teclado software que ocupe pantalla (iPad con teclado físico o flotante): ahí el navegador deja el campo pegado al borde inferior, justo detrás de los ~138px de barra. En Safari de iOS con el teclado acoplado, la barra `position: fixed` queda ella misma bajo el teclado mientras se escribe, y el campo aparece detrás de la barra al cerrar el teclado con la página ya desplazada. En todos esos casos la causa y el arreglo son los mismos: no hay ninguna compensación de scroll para un overlay de ~138px, y `scroll-padding-bottom` en la regla `html` de index.css:11 la añade con una línea.

### `ERG-6` · «Corregir» es el objetivo más pequeño de la aplicación: 24px de alto

**Media** · esfuerzo S · `src/features/inventory/RoomInventory.tsx:145`

24px de alto (text-xs = 16px de interlínea + py-1 = 4+4), poco más de la mitad del mínimo de 44px. Es la única puerta de entrada a todo AssetFixer: renombrar, modelo, número de serie, marcar averiado y retirar. Además está `shrink-0` al final de una fila donde puede haber dos etiquetas más («Sin validar» línea 135, «Averiado» línea 140), así que en un móvil queda arrinconado contra el borde derecho — la esquina peor para un pulgar derecho que sujeta el aparato. El comentario de cabecera del fichero (líneas 10-13) dice que el inventario se degrada si corregirlo cuesta; este botón es exactamente ese coste.

**Arreglo.** `className="key key-quiet shrink-0 h-11 px-3 text-xs"`. Si preocupa el ancho de la fila, quitarle el texto y dejar un icono con `aria-label="Corregir"` mantiene los 44px sin robar sitio a las etiquetas.

> **Matiz del verificador.** El titular «el objetivo más pequeño de la aplicación» es falso y además se contradice con ERG-7 del mismo lote: el «← Volver» de RoomPlate.tsx:29-35 mide ~17px, y «Cerrar sesión» (App.tsx:163, `px-3 py-1.5 text-xs`) mide 28px. Los 24px de «Corregir» son correctos; el titular honesto es «uno de los objetivos más pequeños de la aplicación, a 24px, y el único acceso a todo AssetFixer».

### `ERG-7` · «← Volver» es texto suelto de 11px sin ningún relleno: ~17px de alto

**Media** · esfuerzo S · `src/components/RoomPlate.tsx:29`

La clase no tiene ni padding ni altura: solo `mb-2`, que es margen exterior y no agranda el objetivo. Con font-size 11px y la interlínea 1.5 del preflight de Tailwind, la caja pulsable mide unos 17px de alto y unos 70px de ancho. Es la única salida de la revisión —App.tsx oculta la barra de pestañas mientras `inspecting` (línea 235)—, así que si el técnico ha abierto la sala equivocada de las 276, el único camino de vuelta es una franja de 17px. Comparado con el resto de la pantalla llama la atención: la misma vista tiene botones de 56px.

**Arreglo.** Convertirlo en objetivo real sin cambiar cómo se ve, con relleno y margen negativo compensatorio: `className="-ml-2 mb-1 inline-flex h-11 items-center px-2 font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-accent"`. El texto queda ópticamente donde estaba y el área pulsable pasa a 44px.

> **Matiz del verificador.** Nota sobre el arreglo propuesto: la cabecera es `px-3` (RoomPlate.tsx:28), así que el `-ml-2` deja el botón a 4px del borde de la pantalla en vez de a 12. Sigue siendo válido, pero si se quiere conservar la alineación óptica exacta con la placa, `-ml-1 px-1` con `h-11 inline-flex items-center` da los 44px de alto sin desplazar el texto.

### `ERG-8` · La barra de pestañas mide 40px, por debajo del mínimo, y es la navegación principal

**Media** · esfuerzo S · `src/App.tsx:247`

40px de alto (text-xs = 16px de interlínea + py-3 = 12+12). El `paddingBottom: env(safe-area-inset-bottom)` está en el `<nav>` (línea 238), no en el botón, así que no suma al objetivo: solo aparta la barra de gestos. Faltan 4px para el mínimo de 44 en el control que más se toca fuera de la revisión, y con hasta seis pestañas para un admin (`TABS`, líneas 35-42) dentro de un `scroll-x flex` cada una es también estrecha. El proyecto acertó al ponerla abajo, al alcance del pulgar; el tamaño se queda a medio camino.

**Arreglo.** `px-3 py-3` → `flex h-touch w-full items-center justify-center px-3`, reutilizando el token de 56px que ya define tailwind.config.js:69 y que usa el resto de la aplicación. Como mínimo `py-3.5` para llegar a 44px.

### `ERG-9` · En el almacén, «−» y «+» son de 36px, están a 4px uno del otro, no dan feedback y no se pueden deshacer

**Media** · esfuerzo M · `src/features/inventory/StockPage.tsx:114`

Tres problemas en el mismo control. (1) `h-9 w-9` son 36x36px, por debajo de 44, y los dos botones van en un `inline-flex gap-1` (línea 113), o sea a 4px de distancia: sumar y restar existencias son acciones opuestas separadas por menos de la mitad de la anchura de un dedo. (2) `move.isPending` no se usa en ninguna parte: los botones nunca se deshabilitan y la fila no cambia hasta que vuelve `invalidateQueries` (línea 50). El técnico pulsa, la cifra no se mueve, vuelve a pulsar, y se registran dos movimientos — que además no son editables por diseño (comentario de las líneas 19-22). (3) No hay confirmación ni deshacer para un movimiento en la dirección equivocada.

**Arreglo.** Subir a `h-11 w-11` y separarlos (`gap-3`), que es lo que impide el toque cruzado. Y usar el estado que la mutación ya expone: `disabled={move.isPending}` en ambos, con la fila afectada atenuada mientras vuela. Para el deshacer basta lo barato: tras un movimiento correcto, mostrar durante unos segundos un «Deshacer» que registre el movimiento inverso.

> **Matiz del verificador.** Precisión sobre la cita del comentario: las líneas 19-22 dicen que `on_hand` no es editable porque es `SUM(qty)` sobre los movimientos, no literalmente que los movimientos sean inmutables. La afirmación práctica se sostiene igual —no existe en la aplicación ninguna UI para editar o borrar un movimiento— y el diseño append-only que describe ese comentario es justo lo que hace correcto el arreglo propuesto: el «Deshacer» debe registrar el movimiento inverso, nunca borrar el original.

### `ERG-10` · Cuando el almacén falla, el mensaje culpa siempre al permiso — aunque el problema sea que no hay cobertura

**Media** · esfuerzo M · `src/features/inventory/StockPage.tsx:139`

El texto es fijo y no mira el error: se muestra igual si la inserción la rechazó una política de permisos, si el servidor devolvió un 500 o —lo más probable en esta aplicación— si no hay red. Esta pantalla escribe directamente contra Supabase (líneas 40-48), sin Dexie ni cola de salida, así que en un sótano de los 23 edificios cualquier movimiento falla y el técnico lee que no tiene permisos. Se va convencido de que le falta un rol. Y el mensaje es un callejón sin salida: no hay botón de reintentar, y el aviso aparece al final de la página (línea 139), lejos de la fila que falló. Compárese con la revisión, que sí dice «Guardando…/Guardado» (InspectionPage.tsx:249).

**Arreglo.** Distinguir los dos casos, que es lo único que cambia lo que el técnico hace después: si `move.error` es de red o el navegador está `!navigator.onLine`, decir «Sin conexión: el movimiento no se ha registrado» y ofrecer un botón «Reintentar» que llame a `move.mutate(move.variables)`; reservar «Solo un supervisor registra compras» para el error de permiso real. Y anclar el mensaje a la fila que falló en vez de al pie de la tabla.

> **Matiz del verificador.** Sobre el arreglo: `move.variables` existe en TanStack Query v5 pero su tipo incluye `undefined`, así que el reintento debe ir guardado, p. ej. `onClick={() => move.variables && move.mutate(move.variables)}`. Y conviene recordar que anclar el mensaje a la fila exige guardar el `stock_item_id` que falló, porque `move.variables` sólo conserva el de la última llamada.

### `ERG-11` · El campo de número de serie autocapitaliza y autocorrige; ningún campo de la app declara enterKeyHint

**Baja** · esfuerzo S · `src/features/inventory/RoomInventory.tsx:244`

Es un `type="text"` desnudo. En iOS eso significa autoCapitalize por frases y autocorrección activas: un número de serie como «hd4x-22b» entra como «Hd4x-22b», y cadenas alfanuméricas cortas son justo lo que el corrector reescribe. El `font-mono` de la clase deja claro que el campo espera un identificador literal, pero nada se lo dice al teclado. Un grep de `autoCapitalize`, `autoCorrect` y `spellCheck` sobre todo `src/` no devuelve ni una coincidencia; tampoco de `enterKeyHint`, así que la tecla de retorno dice «intro» genérico en todos los campos, incluido el buscador de equipos (línea 73), que además no está dentro de un `<form>` y por tanto no hace nada al pulsarla. El único campo con el teclado bien pedido es la medida de horas de lámpara (InspectionPage.tsx:174, `inputMode="decimal"`).

**Arreglo.** En serie y modelo (líneas 234-250): `autoCapitalize="characters" autoCorrect="off" spellCheck={false}` para la serie, y `autoCapitalize="off" autoCorrect="off"` para el modelo. Añadir `enterKeyHint="done"` a los campos de AssetFixer y `enterKeyHint="search"` al buscador de equipos (línea 73), enganchando ahí un `onKeyDown` que acepte el primer resultado de `hits` para que la tecla haga lo que promete.

> **Matiz del verificador.** Es falso que la medida de horas de lámpara sea «el único campo con el teclado bien pedido». LockScreen.tsx:134-142 pide el teclado correctamente y con más cuidado que ninguno: `type="password"` + `inputMode="numeric"` + `pattern="\d*"` + `maxLength` + `autoComplete` conmutado entre 'new-password' y 'current-password'; además LockScreen.tsx:82 usa `type="email"` y StockPage.tsx:64 usa `type="search"`. La afirmación correcta es: hay tres campos con el teclado bien pedido —el PIN (LockScreen.tsx:134-142), el correo (LockScreen.tsx:82) y la medida de lámpara (InspectionPage.tsx:173-174)— y ninguno de ellos está en el inventario, que es donde se teclean identificadores literales. El resto del hallazgo, incluida la ausencia total de `enterKeyHint` en el proyecto, se mantiene íntegro.


---

## Fluidez y rendimiento percibido

### `FLU-1` · InspectionPage repite las dos consultas que su propio hook ya hace

**Alta** · esfuerzo S · `src/features/inspection/InspectionPage.tsx:45`

useInspection.ts:139-143 ya monta exactamente estas dos consultas —`db.assets.where('room_id').equals(room.id)` y `db.assetTypes.toArray()`— y ya construye el Map en useInspection.ts:145-148. InspectionPage las vuelve a montar tal cual en sus líneas 41-46. Cada apertura de sala hace por tanto cuatro suscripciones liveQuery en vez de dos, dos lecturas completas de la tabla `assetTypes` en vez de una, y construye dos Maps idénticos. Y como son observables independientes, dar de alta un equipo desde el aula (useRoomInventory.ts:83, `db.assets.put`) dispara dos re-ejecuciones y dos renders encadenados del árbol entero de la revisión en vez de uno. `dexie-react-hooks` compara el resultado por referencia (`current.result !== val`, useObservable.ts), y `toArray()` devuelve un array nuevo siempre: ninguno de los dos renders se descarta.

**Arreglo.** Devolver `assets`, `types` y `typesById` desde `useInspection` (ya los tiene calculados en las líneas 139-148) y borrar las líneas 41-46 de InspectionPage, pasando a `RoomInventory` lo que devuelva el hook.

### `FLU-2` · Cada tecla en la nota de una incidencia re-renderiza la revisión entera

**Alta** · esfuerzo M · `src/features/inspection/InspectionPage.tsx:160`

Cada pulsación llama a `setCheck`, que clona el Map en useInspection.ts:233 (`const checks = new Map(prev.checks)`) y devuelve un `draft` nuevo. En todo el proyecto no hay un solo `React.memo` —el grep de `memo` solo encuentra `useMemo`/`useCallback` en useInspection.ts y useRoomInventory.ts— y `TriState` (TriState.tsx:57) recibe además un `onChange` recreado en cada render (InspectionPage.tsx:129). Resultado por carácter tecleado: se vuelven a renderizar las 9 filas con sus 27 botones de TriState, los 9 bloques de detalle y todo `RoomInventory` con sus `AssetFixer`. En un iPad de gama media eso es el retraso clásico entre la tecla y la letra. Nótese que `AssetFixer` sí lo hace bien: guarda en estado local y llama al padre en `onBlur` (RoomInventory.tsx:218).

**Arreglo.** Copiar el patrón de `AssetFixer`: mantener el texto de la nota en estado local del bloque de incidencia y llamar a `setCheck` en `onBlur`, no en `onChange`. Y extraer la fila a un `<FilaRevision>` envuelto en `React.memo` pasándole `checkKey` como prop, para que el `setCheck` estable (ya es `useCallback`) pueda ir sin closure nueva.

> **Matiz del verificador.** Dos matices. (1) El mismo defecto está también en el textarea de observaciones, InspectionPage.tsx:227-229 (`onChange={(e) => setNotes(e.target.value)}`), que se teclea en toda revisión, no solo cuando hay incidencia — arreglarlo con estado local + onBlur da más beneficio que el de la nota, porque el de la nota solo aparece con `result === 'incidencia'`. (2) «el retraso clásico entre la tecla y la letra» está algo exagerado: el coste por pulsación no es solo el render, es que cada `setCheck` además llama a `scheduleSave` (useInspection.ts:248) desde dentro del updater de `setDraft`, que reprograma los dos temporizadores y dispara `setSaving(true)`. El arreglo propuesto (estado local + onBlur) corta las dos cosas a la vez.

### `FLU-3` · El detalle de incidencia se monta en las 9 filas aunque esté cerrado

**Alta** · esfuerzo M · `src/features/inspection/InspectionPage.tsx:136`

`.collapse-y` (index.css:153-165) colapsa con `grid-template-rows: 0fr` + `overflow: hidden`, no con `display:none`: el contenido sigue en el árbol y sigue participando en el layout. Con `ROOM_CHECKS = ['red']` (types.ts:32), una sala de 8 equipos da 9 filas, y cada fila monta un `<textarea>` (línea 158) y 3 botones de gravedad (líneas 144-155). Son 9 textareas y 27 botones invisibles que el navegador maqueta en cada reflow de la página. La inmensa mayoría de las revisiones no abre ni uno.

**Arreglo.** Montar el contenido solo cuando hace falta y dejar el `collapse-y` para el que se abre: `{check?.result === 'incidencia' && (<div className="collapse-y" data-open>…</div>)}`. Para conservar la transición de entrada, montar con `data-open={false}` y ponerlo a `true` en el siguiente frame; al cerrar, desmontar con 160 ms de retardo.

### `FLU-4` · RoomInventory monta un formulario completo por equipo dentro de un panel que nace cerrado

**Alta** · esfuerzo S · `src/features/inventory/RoomInventory.tsx:160`

`AssetFixer` se renderiza para todos los equipos, no solo para el que se está corrigiendo: el condicional vive en el `data-open` del `collapse-y` (línea 156), no en el montaje. Cada `AssetFixer` son tres `<input>` con estado propio (líneas 203-205) y dos botones. Con 8 equipos en la sala son 24 inputs y 16 botones. Y todo eso cuelga del `collapse-y` exterior de la línea 65, cuyo `open` arranca en `false` (línea 28): al abrir una sala se construye y se maqueta un formulario de unos 40 controles que nadie ha pedido ver y que la mayoría de las revisiones no abre nunca.

**Arreglo.** `{fixing === asset.id && <AssetFixer … />}` dentro del `collapse-y` de la línea 155, y montar la `<ul>` de equipos (línea 116) solo cuando `open` sea `true`.

### `FLU-5` · El guardado remoto reencola todas las comprobaciones, una transacción tras otra

**Alta** · esfuerzo M · `src/features/inspection/useInspection.ts:221`

A los 3 s de la última pulsación se reencola el borrador entero, no lo que cambió. Cada `enqueue` (dexie.ts:126-146) hace un `db.outbox.get` y un `db.outbox.put` en transacciones separadas: con 9 comprobaciones son 20 transacciones IndexedDB seguidas para reflejar un solo toque. El nivel local hace lo mismo en la línea 209, `db.checks.bulkPut([...next.checks.values()])` reescribe las 9 filas para cambiar una. Y como cada `put` sobre `outbox` es su propia transacción, cada uno emite su propio evento de cambio y dispara FLU-6. Todo esto cae exactamente 3 s después de tocar, es decir mientras el técnico ya está pulsando la fila siguiente.

**Arreglo.** Llevar en un `ref` el conjunto de `check_key` tocados desde el último envío y encolar solo esos. Envolver las escrituras en una sola transacción (`db.transaction('rw', db.outbox, …)`) para que sean un único evento de cambio, y hacer lo mismo con el `bulkPut` local, limitándolo a las filas modificadas.

> **Matiz del verificador.** El cierre («cae exactamente 3 s después de tocar, es decir mientras el técnico ya está pulsando la fila siguiente») no se sostiene: el temporizador remoto se reinicia en cada `setCheck` (useInspection.ts:214, `if (remoteTimer.current) clearTimeout(remoteTimer.current)`), así que la ráfaga solo salta tras 3 s SIN tocar nada — típicamente mientras el técnico camina hacia el siguiente aparato, y coincidiendo con la primera pulsación que llegue después. Lo que sí agrava el cuadro y no se menciona: a las 20 transacciones les sigue `void flush()` (línea 224), que hace otro `db.outbox.toArray()` completo (outbox.ts:192) y luego un update + un delete por entrada. El resto del hallazgo y el arreglo (ref de check_key tocados + una sola `db.transaction('rw', ...)`) son correctos. `bulkPut` ya es una única transacción, así que ahí lo que sobra es el volumen de filas, no el número de transacciones.

### `FLU-6` · SyncChip relee las tablas outbox y photos enteras en cada escritura de la cola

**Alta** · esfuerzo M · `src/components/SyncChip.tsx:30`

`pendingSummary` (dexie.ts:161) hace `db.outbox.toArray()` y `db.photos.toArray()` —tablas completas, incluidos los Blob de las fotos en cola— y luego cuatro `filter` en JS sobre el resultado. La chapa está en la cabecera de App.tsx:152, montada siempre, también durante la revisión. Cada escritura en `outbox` reejecuta la consulta: el guardado remoto mete unas 20 (FLU-5) y `flush` añade dos más por entrada (`db.outbox.update` en outbox.ts:91 y `db.outbox.delete` en 101). Una revisión de 9 filas produce del orden de 40 barridos completos de dos tablas y 40 renders de la cabecera, encadenados, justo mientras el técnico trabaja.

**Arreglo.** Sustituir los `toArray()` por conteos indexados: `db.outbox.where('status').equals('pendiente').count()`, `.equals('rechazado').count()` y los equivalentes en `photos` (ambos índices ya existen, dexie.ts:107-108). Calcular `oldestAt` solo si el conteo de pendientes es mayor que cero, añadiendo `createdAt` al índice de `outbox` para poder resolverlo con `orderBy('createdAt').first()`.

> **Matiz del verificador.** Dos números mal. (1) No son «cuatro filter», son cinco (dexie.ts:162, 169, 170, 171, 172) más un `reduce` sobre la concatenación de ambas tablas (163-166). (2) La cuenta de reejecuciones está inflada: el guardado remoto produce 10 escrituras sobre `outbox` (1 inspección + 9 checks; los `get` no emiten evento), y `flush` añade 2 por entrada, así que el orden real es ~30 barridos completos por revisión, no 40. Sigue siendo desproporcionado. Y ojo con el arreglo tal como está redactado: `total` hoy cuenta `status !== 'rechazado'`, que incluye las entradas en `'enviando'` (y `'subiendo'` en photos), así que contar solo `.equals('pendiente')` haría parpadear el contador a la baja durante la subida. Lo correcto es `db.outbox.count()` menos `db.outbox.where('status').equals('rechazado').count()`, y lo equivalente en `photos`.

### `FLU-7` · El colapso anima grid-template-rows, que es una propiedad de layout

**Media** · esfuerzo M · `src/index.css:158`

`grid-template-rows` no se compone en la GPU: el navegador rehace el layout de la rejilla y de todo lo que va por debajo en cada frame de la transición. En la pantalla de revisión hay como mínimo 11 `collapse-y` a la vez —la barra «Todo correcto» de InspectionPage.tsx:84, uno por fila (línea 136), el del inventario (RoomInventory.tsx:65) y uno por equipo (RoomInventory.tsx:155)— y el árbol que se reflowea contiene alrededor de un centenar de controles de formulario por culpa de FLU-3 y FLU-4. Marcar la última comprobación cierra la barra superior y hace bailar toda la lista durante 160 ms, con el dedo encima.

**Arreglo.** Primero adelgazar el árbol: FLU-3 y FLU-4 quitan unos 75 controles del layout y con eso el reflow puede bastar. Si aún se nota, usar altura fija con `transform: scaleY` + `opacity` en los bloques cuyo alto sí se conoce —tres botones de gravedad más un textarea de dos filas lo es— y reservar `grid-template-rows` para el inventario, que es de alto variable y se abre a mano.

> **Matiz del verificador.** El «como mínimo 11» no es un mínimo: el número depende del inventario de la sala. Con `ROOM_CHECKS = ['red']` y 0 equipos son 3 `collapse-y`; con 8 equipos son 19 (1 barra + 9 filas + 1 inventario + 8 equipos). Y el arreglo propuesto tiene una trampa: cambiar `grid-template-rows` por `transform: scaleY` no es equivalente — scaleY no reflowea porque el hueco se queda reservado, así que el contenido de debajo NO sube al cerrar, que es justo el salto que el comentario de index.css:142-152 e InspectionPage.tsx:78-83 quieren evitar. La parte válida del arreglo es la primera frase: aplicar FLU-3 y FLU-4 y volver a medir; el cambio de técnica de animación solo cabe en bloques donde reservar el hueco sea aceptable.

### `FLU-8` · backdrop-blur en la cabecera pegajosa, sobre un fondo que ya es opaco al 95 %

**Media** · esfuerzo S · `src/App.tsx:148`

`backdrop-filter: blur()` obliga a WebKit a recapturar y desenfocar el fondo en cada frame de desplazamiento, y en un iPad es de las cosas más caras que se pueden poner en un elemento `sticky`. Aquí, además, no se ve: `bg-ground/95` deja pasar un 5 % del fondo, y `--ground` es un color sólido (tokens.css:26). Se paga el coste al desplazarse por la lista de salas y por la revisión a cambio de un efecto prácticamente invisible.

**Arreglo.** Quitar `backdrop-blur` y dejar `bg-ground` opaco. Si se quiere conservar la traslucidez, bajar a `bg-ground/80` para que el desenfoque se note y justifique el coste, pero midiendo el desplazamiento en el dispositivo real antes de dejarlo.

> **Matiz del verificador.** La referencia al token está desplazada una línea: `--ground: 236 240 240;` está en tokens.css:25, no en la 26 (la 26 es `--surface`). En tema oscuro el mismo token se redefine en tokens.css:113 y 158 (`--ground: 20 22 24;`), igual de opaco, así que la conclusión no cambia en ninguno de los dos temas.

### `FLU-9` · La lista de salas hace dos barridos completos de tabla teniendo los índices delante

**Media** · esfuerzo S · `src/features/rooms/RoomListPage.tsx:33`

`.filter()` en Dexie no es un `where`: deserializa las 276 salas y ejecuta la lambda sobre cada una, aunque `rooms` tiene índice por `zone_id` (dexie.ts:97). Lo mismo pasa en la línea 45, `db.inspections.filter((i) => i.status === 'borrador')`, con el índice `status` disponible (dexie.ts:103) — y esa tabla no la purga nadie: no hay ni un solo `db.inspections.delete` en el proyecto, así que crece una fila por revisión cerrada para siempre. A 276 salas por ronda, en un año son miles de filas leídas y filtradas en JS cada vez que se abre un edificio. Encima la consulta de la línea 30 repite el `db.zones.where(...)` que ya hace la de la línea 25.

**Arreglo.** `db.rooms.where('zone_id').anyOf([...zoneIds]).toArray()` y `db.inspections.where('status').equals('borrador').toArray()`. Fusionar las consultas de las líneas 25 y 30 en un solo `useLiveQuery` que devuelva `{ zonesById, rooms }`. Y borrar de Dexie las inspecciones completas en cuanto `outbox` suelta su entrada.

### `FLU-10` · El bundle de arranque trae las pantallas que el técnico ni siquiera puede ver

**Media** · esfuerzo S · `src/App.tsx:10`

Solo `DashboardPage` es `lazy` (línea 24). `IncidentsPage`, `StockPage`, `CleanupPage` —que arrastra `AssetTypeTray`— y `ReportsPage` se importan estáticamente en las líneas 8-11, aunque `visibleTabs` (línea 143) las oculta por rol y un técnico nunca abre Informes ni Datos. El resultado es `dist/assets/index-vA5M1A6g.js` con 668 KB (203 KB gzip); comprobado con grep sobre el fichero construido: contiene «import_quarantine», «Fusionar con» y «Bajo mínimo». Ahí dentro va también `browser-image-compression` (photos.ts:10), que solo hace falta si se saca una foto. Es todo descarga y parseo en el primer arranque, que es justo el que ocurre con peor cobertura.

**Arreglo.** Pasar las cuatro páginas a `lazy()` con el mismo patrón que ya usa `DashboardPage` en la línea 24, y cambiar el import de photos.ts a dinámico dentro de `capturePhoto`: `const { default: imageCompression } = await import('browser-image-compression')`.

### `FLU-11` · AssetTypeTray pinta el catálogo confirmado entero dentro de cada fila pendiente

**Media** · esfuerzo M · `src/features/admin/AssetTypeTray.tsx:154`

El `<select>` de fusión (líneas 147-161) se repite en cada tipo pendiente, y dentro de cada uno se pintan todas las opciones del catálogo confirmado. Con 30 pendientes y 80 confirmados son 2.400 nodos `<option>` más 30 `<select>`, y el `.filter()` de la línea 155 recorre el catálogo una vez por fila. Aparte, la consulta de uso de la línea 59 se baja **todas** las filas de `assets` no retiradas —una por equipo de las 276 salas— solo para contarlas en el cliente en las líneas 60-63.

**Arreglo.** Sustituir el `<select>` por un `<input list="catalogo">` con un único `<datalist id="catalogo">` renderizado una sola vez fuera del `map`. Y mover el conteo al servidor con una vista o un agregado, o como mínimo memoizarlo en vez de recorrer todo el inventario en el cliente.

> **Matiz del verificador.** Precisión menor a favor del código: la consulta de uso proyecta una sola columna (`select('asset_type_id')`), no filas completas, así que el peso es de número de filas, no de ancho. A cambio, hay un problema que el hallazgo no ve y que apunta al mismo sitio: PostgREST limita por defecto la respuesta (típicamente 1000 filas), así que con un inventario grande ese conteo en cliente no solo es caro, es que se queda corto en silencio — razón de más para moverlo al servidor.

### `FLU-12` · 200 incidencias sin virtualizar que se recargan al volver a primer plano

**Baja** · esfuerzo S · `src/features/incidents/IncidentsPage.tsx:37`

`select('*')` sin proyección y `.limit(200)`: al marcar «Incluir resueltas» se traen 200 filas completas y el `.map()` de la línea 76 las pinta todas sin virtualizar —unos 2.000 nodos— con un `new Date()` por fila (línea 77). Además `refetchOnWindowFocus: true` (main.tsx:14) con `staleTime: 60_000` (main.tsx:10) hace que basten 60 s fuera de la app para que al volver del bloqueo se rehaga la petición y se repinte la lista entera; en una ronda de aulas el iPad entra y sale de la pantalla de bloqueo constantemente. Y si hay más de 200 incidencias, el límite recorta en silencio: no hay paginación ni aviso.

**Arreglo.** Proyectar solo lo que se pinta (`id,title,severity,state,opened_at,external_ref`), bajar el límite a 50 con un botón «ver más», y sacar un único `Date.now()` fuera del `map`. Poner `refetchOnWindowFocus: false` en esta consulta concreta, que no es dato de trabajo en el aula.


---

## Coherencia de diseño

### `DIS-1` · Las filas de edificio y de sala no responden al toque: son los únicos botones de la app sin canto ni hundido

**Alta** · esfuerzo S · `src/features/rooms/RoomListPage.tsx:71`

Los dos objetivos que el técnico pulsa más veces al día —el edificio (App.tsx:176-180, mismo patrón con py-4) y la sala, 23 + 276 filas— no llevan .key ni .key-quiet, ni hover, ni :active, ni fondo. El sistema define en index.css:106 `.key:active:not(:disabled) { transform: scale(0.97) }` precisamente para eso, y aquí no se aplica: al tocar una fila no pasa absolutamente nada hasta que la pantalla siguiente termina de montarse. Con guante, de pie y con la pantalla lavada por el proyector, la duda de «¿lo he pulsado?» acaba en doble toque. Todos los botones secundarios (Corregir, Empezar, Descargar) sí tienen respuesta; los principales no.

**Arreglo.** Añadir a la fila una respuesta táctil sin convertirla en tecla: `active:bg-raised transition-colors duration-100` en el className de ambos botones (RoomListPage.tsx:71 y App.tsx:179). Si se quiere el mismo lenguaje que el resto, `active:scale-[0.99]` con `transition-transform duration-100 ease-out`. No hace falta .key: basta con que el toque se vea.

> **Matiz del verificador.** El problema se sostiene, pero «son los únicos botones de la app sin canto ni hundido» es inexacto. Sin .key hay también: RoomPlate.tsx:29 («← Volver»), RoomListPage.tsx:53 («← Edificios»), RoomInventory.tsx:53-57 (el desplegable del inventario, mismo patrón `flex w-full … px-4 py-3 text-left`), App.tsx:243-251 (las pestañas de la barra inferior) y UpdatePrompt.tsx:46 («Ahora no»). Lo correcto: las filas de edificio y de sala son los dos objetivos más pulsados del día y no dan ninguna señal al tocarlos; el arreglo (`active:bg-raised transition-colors duration-100`) debería aplicarse también a RoomInventory.tsx:57, que es la misma fila-botón dentro de la revisión.

### `DIS-2` · Las dos salidas de la app son distintas entre sí y ambas por debajo del objetivo táctil

**Alta** · esfuerzo S · `src/components/RoomPlate.tsx:32`

«← Volver» es la única salida de la pantalla de revisión y mide lo que mide su texto: 11px de alto, sin padding, sin área de toque. La otra salida del mismo flujo, «← Edificios» (RoomListPage.tsx:53, `className="text-sm text-accent"`), tampoco tiene padding y además usa otro tamaño (14px), otra familia (sans en vez de mono), otra caja y otra etiqueta. Dos pantallas consecutivas del mismo recorrido, dos «atrás» que no se parecen y que no se aciertan con el pulgar a la primera. Contradice tailwind.config.js:69 (`touch: '3.5rem'`, «se toca con el pulgar, de pie, en un aula») y el comentario de TriState.tsx:11 («44px de alto mínimo»).

**Arreglo.** Unificar los dos «atrás» en un mismo tratamiento con área de toque real: mismo texto («← Volver»), misma tipografía y `-ml-2 inline-flex h-11 items-center px-2` en ambos, para que el objetivo sea de 44px sin que el elemento crezca visualmente. Idealmente extraer un `<BotonVolver>` en components/ y usarlo en RoomPlate.tsx:29 y RoomListPage.tsx:53.

> **Matiz del verificador.** Dos matices. (1) «mide 11px de alto» es el tamaño de fuente, no el alto de la caja: sin `leading` declarado el botón mide ~13-14px, que sigue siendo un tercio del mínimo. (2) «es la única salida de la pantalla de revisión» necesita precisión: también salen «Guardar» y «Guardar y siguiente sala» (InspectionPage.tsx:253-268), pero ambos exigen la revisión completa (`disabled={missing.length > 0}`) y la barra de pestañas está oculta durante la revisión (App.tsx:235 `{!inspecting && …}`), así que «← Volver» sí es la única forma de abandonar la pantalla sin completarla — lo que refuerza el hallazgo.

### `DIS-3` · «Guardar» se queda apagado sin decir dónde faltan las comprobaciones

**Alta** · esfuerzo M · `src/features/inspection/InspectionPage.tsx:255`

Los dos botones de cierre de la revisión se deshabilitan (index.css:110 los deja al 40% de opacidad) y la única pista de por qué está a 12px en gris muted, arriba a la izquierda de la barra: `Faltan ${missing.length} comprobaciones` (línea 247). Nada en la lista señala cuáles son las filas sin marcar: una fila sin tocar y una fila marcada N/A se distinguen solo por el relleno de tres teclas de 52px de ancho. En una sala con diez aparatos, el técnico acaba recorriendo la lista con el dedo buscando el hueco. Es el momento de más fricción de la pantalla principal.

**Arreglo.** Dos cambios pequeños: (1) marcar la fila pendiente en el propio TriState, con el mismo raíl fino de 3px que ya usa RoomListPage.tsx:78 (`<span aria-hidden className="h-8 w-[3px] bg-warn" />` cuando `value === null`); (2) hacer que el contador de la línea 247 sea pulsable y desplace hasta la primera fila sin marcar (`scrollIntoView({ block: 'center' })`), en vez de ser texto muerto.

> **Matiz del verificador.** Dos precisiones que no anulan el hallazgo. (1) Una fila marcada N/A sí se distingue de una sin tocar por algo más que el relleno de la tecla: TriState.tsx:44-46 aplica `opacity-55` a toda la fila con `value === 'na'`. Lo que no existe es señal alguna en las filas *pendientes*. (2) Hay una vía de escape que el hallazgo no menciona: InspectionPage.tsx:87-96 muestra «Marcar OK las N restantes» mientras faltan comprobaciones. Resuelve el caso «dalo todo por bueno», no el caso «¿cuáles me faltan por mirar?», que es el que describe el hallazgo. El arreglo (raíl de pendiente + contador que desplaza a la primera fila sin marcar) sigue siendo válido.

### `DIS-4` · «Ninguna abierta.» es lo que se ve también cuando no hay red: las listas online no distinguen vacío, cargando y fallo

**Alta** · esfuerzo M · `src/features/incidents/IncidentsPage.tsx:126`

El queryFn se traga el error (línea 39-40: `const { data } = await q` / `return (data ?? []) as IncidentRow[]` — no se lee `error`), así que sin cobertura react-query da éxito con lista vacía y el técnico lee «Ninguna abierta.» cuando en realidad hay incidencias y lo que falla es la red. Mientras carga no hay nada: `incidents` es undefined, la comparación con 0 es falsa y la pantalla queda con el título y un hueco. El mismo patrón exacto en StockPage.tsx:138 («Ningún artículo coincide.» sale al cargar, al fallar y al filtrar sin resultados: tres situaciones, un mensaje que solo describe la tercera) y en ReportsPage.tsx:125. Y contradice el comentario de main.tsx:11-13: «las pantallas de supervisión son online y así lo dicen enseguida» — no lo dicen nunca.

**Arreglo.** En los tres queryFn, propagar el fallo: `const { data, error } = await q; if (error) throw error`. Después, en cada pantalla, ramificar los tres estados con `isPending` / `isError` / lista vacía: cargando → tres filas esqueleto (`animate-pulse bg-raised`) con la altura de las reales; error → «Sin conexión. Esta pantalla necesita red.» con un botón `.key .key-quiet` de «Reintentar» sobre `refetch()`; vacío → el texto actual.

> **Matiz del verificador.** Corrige el estado «cargando»: solo StockPage muestra el mensaje de vacío mientras carga, porque deriva `rows` de `levels ?? []` (líneas 53-55) y `rows.length === 0` es cierto desde el primer fotograma. En IncidentsPage y ReportsPage la comparación es `incidents?.length === 0` / `reports?.length === 0`, que con `undefined` es falsa: durante la carga no sale el mensaje, sale el título sobre un hueco en blanco. La parte del fallo de red —mensaje de vacío mintiendo— es correcta en las tres.

### `DIS-5` · El panel muestra ceros en verde cuando no hay red, en vez de decir que no ha podido leer nada

**Alta** · esfuerzo M · `src/features/dashboard/DashboardPage.tsx:20`

No hay rama de error, y no la puede haber: queries.ts:54 hace `.then((rs) => rs.map((r) => r.count ?? 0))`, así que sin cobertura todos los contadores caen a 0 y `useSummary` termina en éxito. Resultado: «Incidencias abiertas 0» con tono ok, «Salas con problemas 0» con tono ok y «Lámparas < 20% 0» con tono ok (líneas 37-53) — tres bloques verdes afirmando que todo está bien cuando el panel no ha leído ni una fila. Es el peor fallo posible en una pantalla cuyo trabajo es decir dónde hay que ir. La única señal contraria es «Revisadas este mes 0», que sale en aviso por el umbral del 25%.

**Arreglo.** En queries.ts, dejar de enmascarar: en `useSummary` comprobar `rs.find(r => r.error)` y lanzarlo, y en las demás consultas destructurar `{ data, error }` y `throw error`. En DashboardPage separar `if (isError)` con «No se han podido leer los datos. El panel necesita conexión.» y un botón de reintento, y reservar «Cargando…» para `isPending`.

### `DIS-6` · Los − y + del almacén miden 36px, la mitad de lo que el propio sistema exige

**Media** · esfuerzo S · `src/features/inventory/StockPage.tsx:117`

Son los botones más repetidos de la pantalla (uno por artículo, dos por fila) y se pulsan de pie, con una mano, descontando material del carro. `h-9 w-9` son 36px: por debajo de los 44px que TriState.tsx:11 declara como mínimo innegociable y muy lejos del `h-touch` (56px) que el sistema define en tailwind.config.js:69 para exactamente este caso. Además van pegados (`gap-1` = 4px), así que restar cuando se quería sumar es un error de un solo píxel de desvío.

**Arreglo.** Subirlos a `h-11 w-11` y separar la pareja con `gap-2`. Cabe: la columna es la última de la tabla y está alineada a la derecha. Si el alto de fila molesta, mantener `py-2` en el `<td>` y dejar que el botón sobresalga con `-my-1`.

### `DIS-7` · Cada pestaña tiene una cabecera distinta, y el Panel no tiene título

**Media** · esfuerzo M · `src/features/dashboard/DashboardPage.tsx:27`

Cinco pantallas de primer nivel, cinco cabeceras: RoomListPage.tsx:52 usa `<header className="border-b border-line bg-surface px-4 py-3">` con h1 + subtítulo; IncidentsPage.tsx:64 y StockPage.tsx:59 ponen el h1 suelto sin borde ni fondo, uno con subtítulo y el otro sin ninguno; ReportsPage.tsx:63 igual pero con subtítulo; y el Panel no tiene h1 en absoluto — su primer encabezado es un `.eyebrow` de 11px en versalitas. A eso se suma que el ancho de contenido salta de pestaña a pestaña: `max-w-5xl` aquí, `max-w-4xl` en Incidencias/Almacén/Datos, `max-w-3xl` en Informes y sin límite en el listado de salas. En iPad, cambiar de pestaña mueve el margen izquierdo tres veces.

**Arreglo.** Un único encabezado de página compartido —el patrón de RoomListPage: `<header>` con borde inferior, h1 `text-xl font-semibold` y una línea de contexto en `text-sm text-muted`— aplicado a las cinco pestañas, y un solo ancho (`max-w-4xl`) en todas. En el Panel añadir `<h1 className="text-xl font-semibold">Panel</h1>` y bajar «Situación» a lo que es: un eyebrow de sección, no el título de la pantalla.

> **Matiz del verificador.** «uno con subtítulo y el otro sin ninguno» es falso: ni Incidencias ni Almacén tienen subtítulo. Incidencias lleva en la misma línea del h1 una casilla «Incluir resueltas» (IncidentsPage.tsx:65-72) y Almacén no lleva nada (StockPage.tsx:59-61, con dos líneas en blanco donde debería ir). El único con subtítulo es Informes (ReportsPage.tsx:64: «Diario a las 07:00 · semanal los lunes»). Añádase que la pestaña «Datos» titula «Edificios sin identificar», que es el nombre de su primera sección, no el de la pantalla.

### `DIS-8` · En las tarjetas del panel el estado va solo en color, justo lo que su comentario dice que no pasa

**Media** · esfuerzo S · `src/components/StatTile.tsx:33`

El comentario de la línea 19-23 afirma: «El estado se codifica en el raíl lateral *además* de en el color del número, para que se lea igual sin distinguir bien los colores». Pero el raíl es color y nada más: mismo ancho, misma posición y misma forma en los cuatro tonos (TONE, líneas 3-8: `bg-line` / `bg-ok` / `bg-warn` / `bg-crit`), y va `aria-hidden`, así que tampoco se anuncia. Dos codificaciones del mismo canal no son dos canales. En «Salas con problemas» (DashboardPage.tsx:43-47), que no lleva `detail`, un 0 en ok y un 3 en aviso son tipográficamente idénticos. La app hace esto bien en TriState (símbolo + texto + color) y en IncidentsPage (etiqueta de texto); aquí no.

**Arreglo.** Añadir un glifo al eyebrow según el tono, como hace TriState: `✓` para ok, `!` para aviso, `✕` para crítico, delante del `label`, y quitarle el `aria-hidden` al raíl no hace falta si el glifo lleva su propio texto alternativo. Alternativa más barata: rellenar siempre `detail` con el umbral («0 de 276», «por debajo de 20%»), que da la lectura sin depender del tono.

> **Matiz del verificador.** Ajusta la frase «un 0 en ok y un 3 en aviso son tipográficamente idénticos»: los números son distintos, claro; lo idéntico es el *tratamiento* — mismo tamaño, misma fuente, mismo raíl de 4px y misma caja, con el tono viviendo solo en el matiz de color del número y del raíl. En una pantalla lavada por el proyector no hay forma de saber si un valor está marcado como problema. El resto (raíl aria-hidden, TriState y IncidentsPage sí duplicando canal con símbolo y etiqueta) es exacto.

### `DIS-9` · La lista de salas no tiene ni estado de carga ni estado vacío: dice «0 salas» y se queda en blanco

**Media** · esfuerzo S · `src/features/rooms/RoomListPage.tsx:57`

Mientras `useLiveQuery` resuelve, `rooms` es undefined: la cabecera afirma «0 salas» y el `<ul>` de la línea 60 se pinta vacío. Si además el maestro se ha descargado a medias o el edificio no tiene salas todavía, ese estado es permanente y no hay ni una palabra que lo explique — solo el nombre del edificio flotando sobre una pantalla en blanco. La pantalla anterior del mismo recorrido sí lo resuelve (App.tsx:193-197: «Sin datos. Conéctate una vez para descargarlos.»), así que el técnico recibe dos tratos distintos con dos pasos de diferencia.

**Arreglo.** Distinguir los dos casos: mientras `rooms === undefined`, omitir el recuento de la línea 57 (mostrar solo «las más antiguas primero») y pintar cuatro filas esqueleto; cuando `rooms.length === 0`, un `<li className="p-6 text-sm text-muted">` con el mismo texto que ya usa la lista de edificios.

### `DIS-10` · Cuatro pantallas esperan con cuatro palabras distintas y ninguna tiene forma

**Media** · esfuerzo M · `src/App.tsx:126`

El arranque de la app dice «Cargando…» en p-8; el panel dice «Cargando el panel…» en p-6 (App.tsx:221); la revisión dice «Preparando…» en p-6 (InspectionPage.tsx:49); el catálogo dice «Cargando el catálogo…» sin padding (AssetTypeTray.tsx:88). Cuatro textos, cuatro cajas, cero relación entre ellos, y ninguno usa el sistema: ni tarjeta, ni esqueleto, ni la propia lámpara del SyncChip. El de arranque además es texto gris pequeño solo en una pantalla por lo demás vacía, que es indistinguible de un fallo de carga.

**Arreglo.** Un único componente de espera en components/ (por ejemplo `<Cargando texto="…" />`) que reserve el sitio del contenido con bloques `bg-raised` y `animate-pulse` en vez de una frase, y usarlo en los cuatro puntos. Si se quiere mantener el texto, que sea el mismo verbo en los cuatro y siempre dentro de la misma caja.

### `DIS-11` · Los gráficos del panel piden una fuente que no está instalada, así que salen en otra tipografía

**Baja** · esfuerzo S · `src/design/charts.ts:64`

El proyecto solo instala dos fuentes: `@fontsource-variable/instrument-sans` y `@fontsource/ibm-plex-mono` (package.json:24-25, importadas en index.css:1-3), y la sans de la app es «Instrument Sans Variable» (tailwind.config.js:56). «IBM Plex Sans Variable» no existe en el bundle, así que todas las etiquetas de eje y los tooltips de las dos gráficas caen a `system-ui` — es decir, el único sitio de la aplicación que no se escribe con la fuente de la aplicación, y encima cambia de aspecto entre iPad y Android. La cabecera de la tarjeta que las contiene sí va en Instrument Sans, así que la diferencia se ve en el mismo bloque.

**Arreglo.** Cambiar el valor por el mismo que declara Tailwind: `fontFamily: '"Instrument Sans Variable", system-ui, sans-serif'`. Un solo string; el comentario de la línea 61 sobre que «el panel y el PDF salen idénticos» también depende de esto.

> **Matiz del verificador.** Falta el porqué, que además condiciona el arreglo: el worker de informes pide esa misma familia — reports-worker/src/charts.ts:27 `textStyle: { fontFamily: 'IBM Plex Sans, sans-serif', … }` y template.ts:76,79 `font-family: "IBM Plex Sans", sans-serif` — así que el valor del cliente parece un intento de igualar el PDF, no un descuido suelto. Como en la web no se instala ninguna IBM Plex Sans, el efecto real es el contrario: el panel se aparta de la fuente de la app *y* del PDF a la vez. Y el comentario de charts.ts:55-62 («el panel y el PDF salen idénticos») habla de `animation: false`, no de tipografía. Arreglo correcto: poner `"Instrument Sans Variable"` en charts.ts:64 y, si de verdad se quiere paridad con el PDF, cambiar también la familia del worker.

### `DIS-12` · «Ahora no» es el único botón con rounded-ctl suelto, sin canto ni hundido, al lado de una tecla

**Baja** · esfuerzo S · `src/components/UpdatePrompt.tsx:46`

En la franja de versión nueva conviven dos botones a un centímetro: «Actualizar» con `key key-accent` (línea 53) y «Ahora no» con `rounded-ctl` a pelo. El segundo toma el radio del sistema pero ninguna de las tres cosas que definen la tecla en index.css:95-104 —`--sheen`, `--edge` y el hundido de 120ms—, así que ni parece pulsable ni responde al toque. Es el único caso de la aplicación (el resto de botones sí usan .key/.key-quiet), y cae justo en el momento en que el técnico tiene que decidir si le interrumpes la ronda o no.

**Arreglo.** Cambiar el className por `key key-quiet px-3 py-2 text-sm font-medium text-muted`. La variante silenciosa existe exactamente para este par: misma forma y mismo hundido, sin color propio, así que la jerarquía frente a «Actualizar» se mantiene.

> **Matiz del verificador.** El paréntesis «el resto de botones sí usan .key/.key-quiet» es falso y conviene quitarlo: también van sin .key las filas de edificio (App.tsx:176), las de sala (RoomListPage.tsx:68), las pestañas de la barra inferior (App.tsx:243), el desplegable del inventario (RoomInventory.tsx:53) y los dos «atrás» (RoomPlate.tsx:29, RoomListPage.tsx:53). Lo exacto es lo que dice el título: es el único botón que hereda `rounded-ctl` sin la tecla, es decir, el único que *parece* una tecla a medio hacer, y encima al lado de una de verdad. El arreglo propuesto (`key key-quiet px-3 py-2 text-sm font-medium text-muted`) es correcto.


---

## Accesibilidad y formularios

### `A11Y-1` · Escribir el modelo y marcar «Averiado» seguido borra el modelo recién escrito

**Alta** · esfuerzo S · `src/features/inventory/RoomInventory.tsx:163`

Las dos llamadas capturan el MISMO objeto `asset` del render actual. Secuencia real: el técnico escribe «Epson EB-2250U» en Modelo (línea 238) y toca «Averiado» (línea 257). El pointerdown desenfoca el input, dispara el onBlur y lanza `patchAsset(asset, {model:'Epson…'})`; acto seguido el click lanza `setStatus(asset,'averiado')` con el mismo `asset` obsoleto. En useRoomInventory.ts:101 cada una hace `const next = { ...asset, ...patch }`, así que la segunda escribe `model: null` encima de la primera —y encola ese null al servidor—. El liveQuery aún no ha re-renderizado, no hay forma de que la segunda vea la primera. Lo mismo con Nº de serie y con «Retirar de la sala». Es justo la secuencia que hace un técnico: apunta el modelo del aparato que tiene delante y lo marca averiado. El dato se pierde en silencio: el input sigue mostrando el texto tecleado.

**Arreglo.** En `patchAsset` (useRoomInventory.ts:100) releer el registro antes de fusionar, en vez de fiarse del prop: `const current = (await db.assets.get(asset.id)) ?? asset; const next = { ...current, ...patch }`. Con eso la segunda escritura ya ve el modelo que acaba de guardar la primera, y de paso deja de pisar cualquier cambio llegado por sincronización.

> **Matiz del verificador.** Una precisión sobre el mecanismo: la afirmación «no hay forma de que la segunda vea la primera» es demasiado absoluta como ley general — es una carrera, no un determinismo. Lo que la hace prácticamente segura en el dispositivo objetivo es que en Safari de iOS los eventos mousedown/mouseup/click se sintetizan en ráfaga JUSTO DESPUÉS del touchend, con milisegundos entre ellos; el `await db.assets.put()` de patchAsset más la notificación del liveQuery (InspectionPage.tsx:41-44) más el render de React no caben en ese hueco. En escritorio, con un clic lento, el re-render puede llegar a tiempo y el fallo no aparece — lo que lo vuelve un bug intermitente y por tanto más difícil de que alguien lo reporte. Vale la pena añadir dos consecuencias visibles que refuerzan el hallazgo: (1) tras la pisada, RoomInventory.tsx:130 pasa a mostrar «Sin modelo ni serie» en la fila mientras el input de arriba sigue enseñando «Epson EB-2250U»; (2) si el técnico cierra «Corregir» sin volver a enfocar el campo, el dato ya no se recupera nunca, porque el onBlur no vuelve a dispararse. El arreglo propuesto es el correcto.

### `A11Y-2` · El anillo de foco no se ve en NINGÚN botón: `.key` pisa el box-shadow del ring

**Alta** · esfuerzo S · `src/index.css:45`

`ring-2` de Tailwind se pinta con `box-shadow`, y `outline-none` mata el contorno nativo. Pero `.key` (index.css:98) declara `box-shadow: var(--edge)` y `.key-quiet` (:130) `box-shadow: var(--edge-quiet)`. Compilé el CSS y lo confirmé: `:focus-visible` sale del bloque `base` ANTES que `.key` del bloque `components`, y ambos selectores tienen la misma especificidad (0,1,0) — gana el último, o sea `.key`. Resultado: todo botón con `.key` (los tres de TriState, Gravedad, Guardar, Guardar y siguiente sala, Corregir, Sincronizar…) y todo `.card` clicable (StatTile) queda con `outline: 2px solid transparent` y sin anillo. Con un teclado externo o Control por Botón en el iPad —lo que usa quien no acierta con guantes— no hay ninguna pista de dónde está el foco. Los inputs y textareas sí lo tienen porque no llevan `.key`, lo que hace el fallo aún más desconcertante: unos controles marcan foco y otros no.

**Arreglo.** Dejar de usar `ring` (box-shadow) y pasar a `outline`, que ningún componente sobrescribe: `:focus-visible { outline: 2px solid rgb(var(--accent)); outline-offset: 2px; }`. Alternativa si se quiere conservar el ring: añadir en la capa de componentes `.key:focus-visible, .card:focus-visible { box-shadow: var(--edge), 0 0 0 2px rgb(var(--ground)), 0 0 0 4px rgb(var(--accent)); }`.

> **Matiz del verificador.** Solo una corrección de numeración: el `box-shadow: var(--edge-quiet)` de `.key-quiet` está en index.css:129, no en :130 (la 130 es la llave de cierre). Lo demás es exacto.

### `A11Y-3` · Texto a 9 y 10px con el zoom bloqueado, contra la promesa escrita en main.tsx

**Alta** · esfuerzo S · `src/components/TriState.tsx:86`

main.tsx:32-33 justifica bloquear el pellizco así: «Se compensa manteniendo el texto en tamaños que no lo necesiten —nada por debajo de 11px—». No se cumple. `text-[0.625rem]` = 10px son las etiquetas OK / Falla / N/A del control que el técnico toca cientos de veces al día (TriState.tsx:86) y el distintivo «SIN VALIDAR» (TriState.tsx:64). Peor: RoomPlate.tsx:65 usa `text-[0.5625rem]` = 9px para la palabra «Sala», y RoomPlate.tsx:50 `text-[0.625rem]` = 10px para «Edificio H · Planta −2», que es precisamente el contexto que el propio comentario del fichero (líneas 12-13) dice que evita confundir `-2.1` con un sótano. Todo ello en versalitas con tracking de 0.16-0.17em, que a 9px es lo primero que se deshace con el reflejo del proyector. Y como main.tsx:35-37 hace preventDefault de `gesturestart/change/end`, no hay forma de ampliar para leerlo.

**Arreglo.** Subir el suelo a 0.6875rem (11px) en los tres sitios: TriState.tsx:86 y :64, RoomPlate.tsx:50, y RoomPlate.tsx:65 (de 0.5625rem a 0.6875rem). En TriState hay hueco: la tecla mide h-11 (44px) y el símbolo ocupa `text-sm`; basta bajar el símbolo a `text-xs` para que quepa la etiqueta a 11px.

> **Matiz del verificador.** Matiz menor: el «tracking de 0.16-0.17em» aplica a RoomPlate.tsx:50 y :65, no a TriState.tsx:64, que usa `tracking-wide` (0.025em). El argumento del texto a 9-10px se sostiene igual en los cuatro sitios.

### `A11Y-4` · La velocidad medida se guarda como nula si se teclea con coma decimal

**Media** · esfuerzo S · `src/features/inspection/InspectionPage.tsx:172`

La medida que pide esta app es `{ unit: 'Mbps', label: 'Velocidad medida' }` (domain/types.ts:50). Un test de velocidad da «94,3». Con `inputMode="decimal"` el teclado de iOS en es-ES ofrece la COMA, y un `<input type="number">` sanea a cadena vacía cualquier valor que no sea un número en punto flotante con punto: `e.target.value` llega como `''`, la condición lo interpreta como «campo vacío» y guarda `measure: null`. El navegador, en cambio, sigue mostrando «94,» en pantalla porque el DOM ya está en `''` y React no fuerza repintado. El técnico ve su número escrito y en la revisión se guarda un vacío. Además, con guantes es fácil dejar el campo a medias.

**Arreglo.** Pasar a `type="text"` con `inputMode="decimal"` y normalizar en el onChange: `const raw = e.target.value.replace(',', '.'); setCheck(key, 'ok', { measure: raw.trim() === '' ? null : (Number.isNaN(Number(raw)) ? (check.measure ?? null) : Number(raw)), measure_unit: measure.unit })`. Así la coma española funciona y un tecleo a medias no borra lo ya guardado.

### `A11Y-5` · «Corregir», el botón de entrada al inventario, mide 26px de alto

**Media** · esfuerzo S · `src/features/inventory/RoomInventory.tsx:148`

`text-xs` da line-height 1rem (16px), `py-1` suma 8px y el borde 2px: 26px de alto reales. El proyecto define su propio criterio en tailwind.config.js:68-70 —«Objetivo táctil: se toca con el pulgar, de pie, en un aula», `touch: 3.5rem`— y este botón lo incumple por más de la mitad. Es además el único acceso a corregir nombre, modelo y serie de un equipo, y está en una fila estrecha junto a distintivos que le roban sitio. Con guantes finos, de pie y con reflejos, 26px se falla. El mismo patrón `px-2 py-1 text-xs` se repite en IncidentsPage.tsx:106 y :115 («Empezar» / «Resolver») y en CleanupPage.tsx:181.

**Arreglo.** Subir el botón a 44px de alto conservando el ancho compacto: cambiar la clase a `key key-quiet shrink-0 h-11 px-3 text-xs`. Si la fila queda apretada, mover el distintivo «Sin validar» a la segunda línea (junto a modelo/serie), que ya tiene sitio.

> **Matiz del verificador.** Corrección de una línea secundaria: el «Resolver» de IncidentsPage tiene su className en la línea 114 (`className="key key-accent px-2 py-1 text-xs"`), no en la 115 (que es solo el `>` de cierre de la etiqueta). El «Empezar» sí está en :106 tal cual. La cita principal, RoomInventory.tsx:148, es exacta.

### `A11Y-6` · Al colapsar un bloque con `inert` el foco cae al <body> y hay que retabular la pantalla entera

**Media** · esfuerzo S · `src/features/inspection/InspectionPage.tsx:84`

Ese div contiene el botón «Todo correcto / Marcar OK las N restantes» (líneas 87-97). Al pulsarlo, `markRestOk` deja `missing.length === 0`, el propio contenedor del botón que se acaba de activar pasa a `inert`, y el navegador desenfoca su descendiente sin reubicar el foco: acaba en `<body>`. El siguiente Tab reempieza desde el principio del documento (cabecera, «Cerrar sesión», «← Volver»…) en vez de seguir por las filas de la revisión. Pasa igual en RoomInventory.tsx:65 al cerrar «Equipos de la sala», en RoomInventory.tsx:154-158 al cerrar «Corregir», y en InspectionPage.tsx:135-138 cuando se cambia una incidencia a OK con el foco dentro del textarea de detalle. Con teclado externo o Control por Botón en el iPad —la vía de quien no puede tocar con precisión— cada colapso cuesta rehacer todo el recorrido.

**Arreglo.** Antes de que el bloque quede inerte, mandar el foco a un ancla estable. En InspectionPage: dar `ref` al contenedor de filas (línea 101) con `tabIndex={-1}` y llamar a `.focus()` dentro del onClick de `markRestOk`. En RoomInventory: en el onClick del toggle (línea 54) y en el de «Corregir» (línea 147), devolver el foco al botón que se acaba de pulsar con `e.currentTarget.focus()`, que es el destino natural.

> **Matiz del verificador.** Tres de los cuatro ejemplos secundarios son FALSOS y hay que quitarlos, porque en todos ellos el control que provoca el colapso está FUERA del div que se vuelve inerte, así que conserva el foco: (a) RoomInventory.tsx:65 — el botón de «Equipos de la sala» está en las líneas 53-63, fuera del `collapse-y`; (b) RoomInventory.tsx:154-158 — el botón «Corregir» está en las líneas 145-151, fuera; (c) InspectionPage.tsx:135-138 — para cambiar la incidencia a OK hay que activar una tecla del TriState, que vive fuera del bloque colapsable, de modo que el foco ya ha salido del textarea antes de que el bloque se vuelva inerte. En consecuencia, el arreglo propuesto para RoomInventory (`e.currentTarget.focus()` en las líneas 54 y 147) sobra: no hay foco que devolver. El hallazgo debe quedarse SOLO con el caso de InspectionPage.tsx:84 + markRestOk, que es el único donde el elemento activado queda dentro de la región que se inertiza. Dicho eso, sigue siendo el caso que más duele: es el botón de la vía rápida, el que se pulsa en casi todas las salas.

### `A11Y-7` · Los tres botones de Gravedad no dicen que son un grupo ni cuál está elegido

**Media** · esfuerzo S · `src/features/inspection/InspectionPage.tsx:143`

Son botones planos: sin `role`, sin `aria-pressed`, sin nombre de grupo. Lo único que distingue el elegido es `key-crit` frente a `key-quiet`, es decir COLOR. El propio TriState.tsx (comentario de líneas 12-14) declara la regla contraria: «El estado va en icono y texto además de en color. Hay daltonismo en cualquier equipo, y una pantalla con el proyector encendido lava los tonos». Aquí no se cumple. Además, useInspection.ts:241 asigna «media» por defecto en cuanto se marca Falla, así que hay un valor activo que no se anuncia nunca y que el técnico puede no llegar a ver marcado bajo el reflejo. Un lector de pantalla lee «Leve, Molesta, Impide la clase» sin saber cuál rige ni a qué comprobación pertenecen.

**Arreglo.** Envolver el grid en `<div role="radiogroup" aria-label={`Gravedad de ${row.label}`}>` y en cada botón poner `role="radio"` con `aria-checked={check?.severity === s.value}`. Para el requisito no-color, añadir un símbolo visible en el elegido, igual que hace TriState (por ejemplo un `<span aria-hidden>●</span>` delante de la etiqueta cuando está marcado).

### `A11Y-8` · Los textareas de la revisión no tienen etiqueta, solo un placeholder que además se repite

**Media** · esfuerzo S · `src/features/inspection/InspectionPage.tsx:158`

Ni `<label>` ni `aria-label`. El único nombre disponible es el placeholder, que desaparece en cuanto se escribe la primera letra —justo cuando hace falta saber qué campo es— y que además es IDÉNTICO en las N filas con incidencia: un lector de pantalla anuncia «¿Qué has visto?» sin decir si es el del proyector o el de la red. El resto del fichero sí sabe hacerlo: RoomInventory.tsx:72 usa `<span className="sr-only">Añadir equipo</span>` y AssetTypeTray.tsx:127 usa `aria-label`. Aquí se olvidó. El textarea de observaciones (líneas 227-233) tiene el mismo problema.

**Arreglo.** En el de incidencia: `aria-label={`Detalle de la incidencia en ${row.label}`}` — el nombre de la fila ya está a mano en el `map`. En el de observaciones (línea 227): reutilizar el eyebrow que ya existe, `<p className="eyebrow mb-2" id="obs-label">` y `aria-labelledby="obs-label"`, o simplemente `aria-label="Observaciones de la revisión"`.

### `A11Y-9` · «Guardado / Guardando…» y los avisos de la revisión no se anuncian nunca

**Media** · esfuerzo S · `src/features/inspection/InspectionPage.tsx:249`

Este texto es, según el comentario de SyncChip.tsx:24-25, LA respuesta a «¿se ha guardado mi trabajo?»: «La confirmación explícita de que el trabajo está a salvo la da la barra de la revisión». Pero cambia sin `role="status"` ni `aria-live`, así que solo existe para quien mira ese rincón de la pantalla. Lo mismo con el error de foto (línea 222), con el aviso bloqueante «Añade una foto de la incidencia» (línea 224), con el resultado de dar de alta un equipo en RoomInventory.tsx:114 —«Añadido «Proyector 2». Sale en naranja hasta que un coordinador lo valide.»— y con el error del PIN en LockScreen.tsx:150, que dice cuántos intentos quedan antes de borrar la sesión. UpdatePrompt.tsx:33 sí lo hace bien con `role="status"`; es el único.

**Arreglo.** Añadir `role="status"` (implica aria-live=polite) al span de guardado y a los `<p>` informativos de RoomInventory.tsx:114 y InspectionPage.tsx:224, y `role="alert"` a los de error: InspectionPage.tsx:222 y LockScreen.tsx:150. Son atributos sueltos, sin cambio de estructura.

### `A11Y-10` · El `transform: none` de movimiento reducido es letra muerta por especificidad

**Baja** · esfuerzo S · `src/index.css:67`

El comentario de encima (líneas 48-56) promete «se retira todo lo que desplaza: transform, grid-template-rows, y las animaciones con fotogramas». Los dos primeros sí, vía `transition-property` con `!important`. Pero este `.key:active` tiene especificidad (0,2,0) y la regla que pretende anular, `.key:active:not(:disabled)` en index.css:106-108, tiene (0,3,0) porque `:not(:disabled)` aporta la de su argumento. Gana la segunda, y además va después en el CSS compilado (lo verifiqué construyendo la hoja). Resultado: con movimiento reducido activado la tecla SIGUE hundiéndose con `scale(0.97)` en cada pulsación — cientos de veces al día, que es exactamente el movimiento repetitivo que esa preferencia pide quitar. Es la única declaración del bloque sin `!important`.

**Arreglo.** Igualar o superar la especificidad y marcarla: `.key:active:not(:disabled) { transform: none !important; }`.

> **Matiz del verificador.** Un matiz técnico que conviene decir bien: con la preferencia activa, el `transition-property: opacity, color, background-color, border-color, box-shadow !important` de :63 sí saca `transform` de las transiciones, así que la tecla no se hunde con animación de 120ms — salta de golpe a scale(0.97) y vuelve. El desplazamiento repetido sigue ahí, que es lo que la preferencia pide quitar, pero es un salto instantáneo, no un hundimiento animado.

### `A11Y-11` · El desplegable «Fusionar con…» de Datos no tiene nombre accesible, y hay uno por edificio

**Baja** · esfuerzo S · `src/features/admin/CleanupPage.tsx:123`

Sin `<label>` ni `aria-label`. La primera `<option>` hace de rótulo visual, pero eso no da nombre accesible: se anuncia como «cuadro combinado» a secas. Y como se renderiza uno por cada edificio provisional, en la lista hay N controles indistinguibles cuyo efecto —fusionar edificios vía RPC `merge_building`, línea 71— es irreversible desde la interfaz. El fichero hermano ya resuelve esto bien: AssetTypeTray.tsx:150 usa `aria-label={`Fusionar ${type.name} con`}`. Aquí falta.

**Arreglo.** Añadir `aria-label={`Fusionar ${b.code} ${b.name} con`}` al select, y el mismo tratamiento al botón «Fusionar» de la línea 136 (`aria-label={`Fusionar ${b.code}`}`) para que en la lista se distingan unos de otros.


---

## Descartados tras verificación

Parecían problemas y no lo eran. Se listan porque un hallazgo refutado ahorra el tiempo de volver a encontrarlo.

- **`LIST-5`** La gravedad se descarga y no se ve ni se puede ordenar por ella
  
  *La línea 11 (`severity: string`) existe y es cierto que nunca se pinta. Pero el problema descrito no se sostiene contra los datos ni contra el resto del proyecto: las 283 incidencias de supabase/seed.sql tienen severity 'media' — las 283, comprobadas una a una —, la columna es `severity severity not null default 'media'` (20260728000100_schema.sql:209) y ningún punto de la aplicación inserta incidencias (grep sobre src: solo el `update` de IncidentsPage.tsx:55; el severity que elige el técnico en InspectionPage.tsx:144-155 se guarda en `inspection_checks`, otra tabla, useInspection.ts:241). No existe ninguna incidencia «Impide la clase» frente a una «Leve»: pintar el mapa SEVERITY_LABEL pondría «Molesta» en las 283 filas y el orden por gravedad sería un no-op. El arreglo propuesto añadiría un control que no cambia nada.*

- **`LIST-7`** Los mosaicos del panel dan el recuento exacto y las tablas de debajo están recortadas
  
  *Todas las citas de código son exactas (queries.ts:95 `.limit(25)`, queries.ts:116 `.limit(50)`, el `count: 'exact'` de queries.ts:49-50, DashboardPage.tsx:40 y 48-53). Lo que no se sostiene es el efecto: con los datos del producto ninguna de las dos listas se recorta. La vista `alerts_lamp_low` filtra `lamp_pct < 0.20` (20260728000200_views.sql:95) y solo 11 de las 276 salas del seed cumplen — 11 frente a un límite de 25. Y de las 283 incidencias solo 2 no están resueltas, ambas de más de 7 días, frente al `.limit(50)` de las estancadas. Es decir: el mosaico dice 11 y la tabla enseña 11; el pie «25 de 60» no se pintaría nunca. Límite latente, no fricción observable.*

- **`LIST-9`** Los tipos de equipo pendientes se ordenan por fecha, cuando lo que decide es cuántas salas los usan
  
  *Las citas son exactas: AssetTypeTray.tsx:36 `.order('created_at')`, el comentario de 54-55, el cálculo de `usage` en 56-66, el «N en salas» de 109-111 y el `.map()` de la 102; y `created_at` existe (se añade en 20260728000700_inventario.sql:64). Pero el problema no se sostiene al leer el contexto: (a) el dato que decide ya está impreso en cada fila, en la misma línea del nombre (109-111), así que no hay que abrir ni deducir nada para verlo; (b) el catálogo que se sirve viene entero confirmado — `update asset_types set confirmed = true` (inventario.sql:68) y los 8 tipos base insertados con `confirmed=true` (inventario.sql:106-116) —, así que la bandeja arranca vacía y solo la llena lo que teclee un técnico: no hay lista larga que recorrer; (c) «lo más antiguo primero» es un criterio legítimo de bandeja de pendientes — es exactamente el que el hallazgo LIST-6 defiende para la otra bandeja del mismo fichero. Es una preferencia de ordenación, no fricción demostrable.*


---

## Plan de acción

# Plan de acción — fricción real en el aula

**Criterio de ordenación:** cuánta fricción quita al técnico *de pie, con una mano* por unidad de esfuerzo. Todo lo que solo ve un supervisor sentado baja automáticamente de bloque.

---

## Fusiones (el mismo cambio arregla varios hallazgos)

| Paquete | Hallazgos que colapsan | Punto de edición único |
|---|---|---|
| Buscar salas | **NAV-4 + LIST-1** | mismo `<input type="search">`; LIST-1 es la versión de 10 líneas dentro de `RoomListPage.tsx:52-58`, NAV-4 es la misma idea extendida a los 23 edificios |
| Orden por planta | **NAV-5 + LIST-2** | `RoomListPage.tsx:25-42`: ampliar el `Map` de zonas a nombre + `sort_order` y ordenar/agrupar con él |
| Incidencias sin sala | **NAV-8 + LIST-3** | `IncidentsPage.tsx`: resolver `room_id` desde `db.rooms` y filtrar en cliente. Son literalmente el mismo hallazgo visto por navegación y por listado |
| Barra de pestañas 40 px | **NAV-9 + ERG-8** | `App.tsx:247` `px-3 py-3 text-xs` → `flex h-touch w-full items-center justify-center px-3`. Idénticos |
| «Corregir» pequeño | **ERG-6 + A11Y-5** | `RoomInventory.tsx:148` `className="key key-quiet shrink-0 px-2 py-1 text-xs"`. Discrepancia resuelta: son **26 px**, no 24 — `key-quiet` añade `border` (index.css:128) |
| Los dos «atrás» | **ERG-7 + DIS-2** | `RoomPlate.tsx:32` y `RoomListPage.tsx:53`, ninguno con padding. Un `<BotonVolver>` cierra los dos |
| − / + del almacén | **ERG-9 + DIS-6** | `StockPage.tsx:113` `gap-1` y `:117`/`:125` `h-9 w-9`. Mismo control |
| Gravedad | **ERG-4 + A11Y-7** | `InspectionPage.tsx:143-155`. Una sola edición del `<button>` de la línea 149 arregla los 32 px, el `role="radio"` y el estado solo-color |
| Bloque «Corregir» pierde datos | **ERG-1 + A11Y-1** | `RoomInventory.tsx:163-164` (mismo `asset` obsoleto en las dos llamadas) + `:266-269` (`onStatus('retirado')` sin confirmar). Misma visita, mismo par de ficheros |
| Las pantallas online mienten | **DIS-4 + DIS-5 + ERG-10** | misma raíz: nadie lee `error`. `IncidentsPage.tsx:39` `const { data } = await q`, `queries.ts:54`, y la cara de escritura en `StockPage.tsx:139-142` |
| Árbol de la revisión inflado | **FLU-3 + FLU-4 (+ FLU-7)** | montar condicionalmente dentro de `collapse-y`. FLU-7 **depende** de estos dos: el propio hallazgo dice medir después |
| Tormenta de escrituras | **FLU-5 + FLU-6** | causalmente encadenados: cada `enqueue` de `useInspection.ts:217-223` dispara el barrido completo de `SyncChip` |
| Estados de espera | **DIS-9 + DIS-10** | un único `<Cargando />` con esqueleto sirve a los cuatro sitios |

**Dependencias y conflictos que hay que decidir antes de tocar:**
- **NAV-1 no se puede implementar sin NAV-2.** Con `last_inspection_at` escrito en local, «la siguiente» es simplemente la primera del mismo orden de `RoomListPage.tsx:35-41`.
- **ERG-2 y DIS-3 compiten por el mismo elemento**: `InspectionPage.tsx:244-248`. No se pueden aplicar los dos tal cual. Resolución propuesta abajo.
- **NAV-4 sustituye a LIST-1**, no se suma: hacer LIST-1 primero y extenderlo.

---

## Bloque 1 — Arreglar ya

Seis paquetes. Todo cae dentro del bucle `lista → revisión → lista`, que es el 95 % del día.

### 1.1 Cerrar el bucle de la ronda — `NAV-2` → `NAV-1`
La lista es la ruta de trabajo y hoy miente: `useInspection.ts:315` hace `await db.inspections.put(inspection)` y nunca toca `db.rooms`, así que la sala recién terminada sigue con el raíl naranja y en cabeza. Y `App.tsx:216` (`onDone={() => setView({ name: 'salas', building: view.building })}`) ignora el parámetro que `InspectionPage.tsx:18` declara, así que el botón que ocupa dos tercios de la barra promete encadenar salas y devuelve a la lista.

Una línea en `complete()` (`db.rooms.update(inspection.room_id, { last_inspection_at: inspection.occurred_at })`) y el orden vuelve a ser verdad; encima de eso, `onDone(true)` salta a la primera sala del mismo orden. Sin NAV-2 la fila obsoleta no se corrige «cuando haya cobertura» sino solo tras bloquear y desbloquear: `pullMaster()` se llama en un único sitio, `App.tsx:84`.

Si se decide no encadenar salas, **quitar el segundo botón** (`InspectionPage.tsx:261-268`): dos botones idénticos con etiquetas distintas es peor que uno.

### 1.2 Cero pérdidas silenciosas de datos — `A11Y-1`, `A11Y-4`, `NAV-7`, `ERG-1`
Cuatro sitios donde el técnico ve su trabajo en pantalla y el dato no está:
- `RoomInventory.tsx:163-164`: `onPatch` y `onStatus` capturan el mismo `asset` del render. Escribir el modelo y tocar «Averiado» encola `model: null`. Arreglo: releer en `patchAsset` (`useRoomInventory.ts:100`).
- `InspectionPage.tsx:176-181`: `measure: e.target.value === '' ? null : Number(...)` sobre un `type="number"`; el teclado es-ES da coma y «94,3» se guarda como `null` con el número aún visible.
- `InspectionPage.tsx:38` `const [photoCount, setPhotoCount] = useState(0)`: salir y volver reinicia el contador y reaparece «Añade una foto de la incidencia». Usar el **contador en el propio borrador** (ya se persiste) — contar `db.photos` reintroduce el susto porque `outbox.ts:166` las borra al subirlas.
- `RoomInventory.tsx:266-269`: «Retirar de la sala» sin confirmación, cuando cerrar sesión sí se confirma (`App.tsx:159`). Confirmar y sacarlo de la fila `flex gap-2` de la línea 254.

### 1.3 La barra de acción de la revisión — `ERG-2` + `DIS-3`, `NAV-3`, `ERG-5`, `ERG-3`
Es la franja que el pulgar toca sin mirar; hoy solo informa.
- **Decisión sobre el conflicto ERG-2/DIS-3:** sustituir el `<span>` pasivo de `InspectionPage.tsx:244-248` por el botón `markRestOk` (ERG-2), conservando `<span>{saving ? 'Guardando…' : 'Guardado'}</span>` (línea 249); y cubrir la otra mitad de DIS-3 con un raíl de 3 px en las filas pendientes del TriState, igual que `RoomListPage.tsx:78`. Así ambas necesidades se atienden sin pelearse por el mismo hueco.
- `NAV-3`: `UpdatePrompt.tsx:37` lleva `z-30` y la barra de la revisión (`InspectionPage.tsx:240`) no lleva z-index. «Actualizar» (`UpdatePrompt.tsx:53`, `key key-accent`) cae donde vive «Guardar y siguiente sala» (`InspectionPage.tsx:265`, `key key-accent … flex-[2]`): el pulgar recarga la app en mitad del aula. Mover `<UpdatePrompt />` (`App.tsx:261`) dentro del bloque `{!inspecting && …}` y dar `z-20` a la barra.
- `ERG-5`: una línea en la regla `html` de `index.css:11` (`scroll-padding-bottom`), porque los ~138 px de la barra tapan el campo recién enfocado.
- `ERG-3`: `capturePhoto` comprime con `useWebWorker: true`, así que ni siquiera hay tirón de interfaz; el botón sigue diciendo «Añadir foto». Copiar el patrón de `ReportsPage.tsx:89-93`.

### 1.4 Buscador en la lista de salas — `LIST-1`
Diez líneas en `RoomListPage.tsx`, filtrando con `norm()` antes del `.map()` de la línea 61. Hoy hay buscador donde hay 116 artículos (`StockPage.tsx:63-69`, el único `type="search"` del proyecto) y no lo hay donde hay 276 salas. Cubrir códigos no numéricos («LAB CRIMINOLOGÍA», «Sala Reuniones 6»), no solo `planta.punto`.

### 1.5 Barrido único de objetivos táctiles y respuesta al toque — `NAV-9/ERG-8`, `ERG-4/A11Y-7`, `ERG-6/A11Y-5`, `ERG-7/DIS-2`, `ERG-9/DIS-6` (tamaño), `DIS-1`, `DIS-12`, `A11Y-3`
Todo son clases; es una sola pasada y se prueba de una vez. El proyecto ya fija su propia medida (`tailwind.config.js:69`, `touch: '3.5rem'`) y su propio mínimo (`TriState.tsx:11`, 44 px) y luego los incumple en: pestañas 40 px, gravedad 32 px, «Corregir» 26 px, «← Volver» ~14 px, «← Edificios» sin padding, ± del almacén 36 px con 4 px de separación. Añadir en la misma pasada:
- `DIS-1`: `active:bg-raised transition-colors duration-100` en `RoomListPage.tsx:71`, `App.tsx:179` y `RoomInventory.tsx:57` — los objetivos más pulsados del día no dan ninguna señal.
- `DIS-12`: `UpdatePrompt.tsx:46` → `key key-quiet`.
- `A11Y-3`: subir a 11 px `TriState.tsx:86` y `:64`, `RoomPlate.tsx:50` y `:65` (9 px), que es la promesa escrita en `main.tsx:32-33` con el pellizco bloqueado.

### 1.6 Adelgazar la pantalla de revisión — `FLU-1`, `FLU-2`, `FLU-3`, `FLU-4`
- `FLU-1`: borrar `InspectionPage.tsx:41-46` y devolver `assets`/`types`/`typesById` desde el hook, que ya los calcula en `useInspection.ts:139-148`. Es una supresión neta de código.
- `FLU-2`: estado local + `onBlur` en el textarea de nota (`InspectionPage.tsx:160`) **y en el de observaciones** (`:229`), que se teclea en toda revisión. Corta a la vez el render en cascada y el `scheduleSave` por carácter. El patrón ya existe dos ficheros más abajo: `RoomInventory.tsx:218`.
- `FLU-3`/`FLU-4`: montar el detalle de incidencia y el `AssetFixer` solo cuando se abren (`{fixing === asset.id && …}`). Hoy una sala de 8 equipos monta ~40 controles de formulario que nadie ha pedido ver.

---

## Bloque 2 — Merece la pena

Por orden de palanca.

1. **Ruta física, no temporal** — `NAV-5/LIST-2`. Chips de zona bajo la cabecera (versión barata) o cabecera pegajosa por planta usando `sort_order`. Con desempate `localeCompare(…, 'es', { numeric: true })`: '0.2' y '0.10' conviven en el mismo edificio. Se hace en el mismo fichero que 1.4 y que FLU-9 — una sola visita a `RoomListPage.tsx`.
2. **Buscador global** — `NAV-4`. Extender 1.4 a los 23 edificios desde la pantalla de arranque: un toque en vez de dos más dos rastreos visuales. Es la respuesta a «falla el proyector del -2.1 del H» por radio.
3. **Incidencias utilizables** — `NAV-8/LIST-3` + `LIST-4`. Pintar la sala resuelta desde `db.rooms` (con fallback: 118 de 283 tienen `room_id` NULL) — es además el único trozo de esa pantalla que funcionaría sin cobertura —, buscador por título/`external_ref`/sala, y decir que el `.limit(200)` de la línea 37 recorta. Ojo al contexto: con el filtro por defecto la lista tiene 2 filas; esto pesa con «Incluir resueltas».
4. **Dejar de mentir sin red** — `DIS-4/DIS-5/ERG-10`. Propagar `error` en los tres `queryFn` y ramificar `isPending`/`isError`. El panel enseñando «Incidencias abiertas 0» en verde cuando no ha leído una fila es el peor fallo del lote; el almacén culpando al permiso cuando el problema es el sótano es el segundo.
5. **Tormenta de cola** — `FLU-5 + FLU-6`. Un `ref` de `check_key` tocados, una sola `db.transaction('rw', …)`, y conteos indexados en `pendingSummary` (ojo: `db.outbox.count()` menos los `rechazado`, no solo `pendiente`, o el contador parpadea a la baja al subir). Hoy son ~30 barridos completos de dos tablas —con los Blob de las fotos dentro— por revisión.
6. **Un lote de una línea cada uno**: `A11Y-2` (`:focus-visible` con `outline` en vez de `ring`, que `.key` pisa con `box-shadow: var(--edge)`, index.css:98) · `FLU-8` (quitar `backdrop-blur` de `App.tsx:148` sobre un fondo opaco al 95 %) · `LIST-6` (`.order('at')` en `CleanupPage.tsx:60`) · `A11Y-10` (`!important` en `index.css:67`).
7. **Arranque ligero** — `FLU-10`. Cuatro `lazy()` con el patrón que ya usa `App.tsx:24` + import dinámico de `browser-image-compression`. 668 KB que incluyen pantallas que un técnico no puede ni abrir, descargadas justo con la peor cobertura.
8. **No perder el sitio (mitad barata)** — `NAV-6(a)`. Persistir `{ tab, buildingId, roomId }` y rehidratar. El gesto atrás (`NAV-6(b)`) va al bloque 3.
9. **Accesibilidad del trabajo real** — `A11Y-9` (`role="status"` en el «Guardado», que según `SyncChip.tsx:24-25` es *la* respuesta a «¿se ha guardado mi trabajo?»), `A11Y-8` (etiquetas de los textareas), `A11Y-6` (solo el caso `InspectionPage.tsx:84` + `markRestOk`; los otros tres ejemplos eran falsos).
10. **Coherencia dentro de la revisión** — `LIST-10`: exportar `TYPE_ORDER` y ordenar el inventario igual que las filas de arriba. Hoy el mismo equipamiento sale dos veces en la misma pantalla en dos órdenes distintos.
11. `FLU-9` (índices en vez de `.filter()` en `RoomListPage.tsx:33` y `:45`), `ERG-9` (parte de `isPending` + deshacer), `ERG-11` (teclado de números de serie), `DIS-9` (lista de salas sin estado de carga ni vacío).

---

## Bloque 3 — Anotado, no ahora

Nada de esto lo sufre alguien de pie con el iPad en una mano.

- `DIS-7` cabeceras y anchos inconsistentes entre pestañas · `DIS-10` cuatro textos de espera distintos (arreglar con un `<Cargando />` compartido *cuando* se toque DIS-9).
- `DIS-8` StatTile codifica el estado solo en color · `LIST-8` tabla de lámparas sin `<thead>` ni criterio · `DIS-11` fuente de los gráficos (nota: el worker de informes pide la misma familia inexistente; si se quiere paridad hay que tocar los dos).
- `LIST-11` orden del almacén: **no hacer el orden por distancia al umbral**, hoy no hay datos (`min_threshold` es 0 en todo el seed y ningún punto de la app lo fija, así que «Solo bajo mínimo» deja la tabla vacía). Lo que sí tiene datos detrás es ordenar por `total_consumed`, que se descarga y no se usa.
- `FLU-11` AssetTypeTray (admin, uso raro; el conteo en cliente además se queda corto en silencio por el límite de PostgREST) · `FLU-12` virtualizar incidencias — deja de importar si LIST-3/LIST-4 bajan el límite a 50.
- `FLU-7` técnica de animación del colapso: **medir después de FLU-3/FLU-4**, y no cambiar a `scaleY`, que reserva el hueco y reintroduce justo el salto que `index.css:142-152` quiere evitar.
- `NAV-6(b)` `pushState`/`popstate` · `A11Y-11` `aria-label` de los selects de Datos.

---

**Si solo hay una tarde:** 1.1 + 1.2. Lo primero devuelve la ruta de trabajo (276 salas al día lo multiplican todo); lo segundo evita que el técnico deje de fiarse de la aplicación, que es lo único irreversible de esta lista.