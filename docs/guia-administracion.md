# Guía de administración

Cómo editar los datos, confirmar los nombres que quedaron dudosos al importar,
y gestionar usuarios y stock. Todo desde el servidor o desde la propia
aplicación; nada requiere tocar código.

---

## 1. Confirmar los nombres dudosos

Es lo primero que conviene hacer tras desplegar. El importador **no adivina**:
lo que no pudo interpretar con confianza quedó marcado, y sale en la pestaña
**Datos** (solo visible para administradores).

### Edificios sin identificar

Seis códigos aparecen en el histórico de incidencias pero no en la hoja de
estado del Excel:

| Código | Incidencias | Qué sabemos |
|---|---|---|
| **`BC`** | 38 | El más importante. Aparece también en la Bolsa como `Monitor 86" (edificio BC)`. Sospecha razonable: el CRAI o Biblioteca Central |
| `TM` | 17 | |
| `S` | 6 | |
| `G` | 2 | |
| `CEFF` | 1 | Sala 14 |
| `CC` | 1 | |

Para cada uno, dos botones:

- **Fusionar con…** — eliges el edificio real y se llevan consigo zonas, salas e
  incidencias. Las plantas con el mismo nombre se unifican solas.
- **Es un edificio propio** — se queda como está y deja de aparecer marcado.

Un clic y resuelto. **No corre prisa**: mientras tanto la aplicación funciona
igual, solo que esas 65 incidencias cuelgan de un edificio provisional.

### Incidencias sin sala

La importación no pudo identificar el aula de parte del histórico («0.1 BC»,
«2.3 TM», «Ventanilla Única»…) y las guardó **sin sala** en vez de inventarles
una: no salen en ninguna ficha ni cuentan en ningún edificio. En
`Incidencias sin sala` se ven con el texto de aula que traía el Excel y se les
asigna la suya con dos toques. Cada asignación deja además ese texto como
**alias** de la sala, así que la próxima importación —y el buscador— lo
resuelven solos, y cierra su fila de cuarentena con autor.

En la pestaña de Incidencias, la búsqueda entiende también salas y edificios de
verdad: teclear `H` lista el histórico completo del edificio H —resueltas
incluidas—, y `1.7 H` la sala, se escriba en el orden que se escriba.

### Cuarentena de importación

208 filas del Excel que no se pudieron interpretar, con su texto original a la
vista. Son de tres tipos:

1. **Salas sin identificar** — `Ventanilla Unica`, `Modulo 5 buhardilla`,
   `Odontologia`. Nombres que no corresponden a ninguna sala del maestro.
2. **Material no interpretable** — `Cambio Tini S4KQ2080`. El parser saca
   cantidad, artículo y número de serie cuando puede; cuando no, lo deja tal cual
   en vez de inventárselo.
3. **Fechas ilegibles**.

Pulsa **Revisada** cuando la hayas mirado. No borra nada: solo deja de
aparecer.

> Las correcciones que **sí** se aplicaron están registradas con su valor
> original en la tabla `import_fixes`: 18 arreglos, entre ellos una incidencia
> fechada en 2005, el texto `29-01-026`, y resoluciones anteriores a su
> apertura. Nada se corrigió en silencio.

## 2. Usuarios

Desde el servidor, con el `.env` cargado:

```bash
npm run admin:user -- listar
npm run admin:user -- crear  ana@x.es "Ana Ruiz" tecnico
npm run admin:user -- codigo ana@x.es
npm run admin:user -- rol    ana@x.es supervisor
npm run admin:user -- borrar ana@x.es
```

El alta cabe en una orden y el orden de los argumentos da igual: el email se
reconoce por la `@`, el rol porque solo puede ser una de tres palabras, y lo que
quede es el nombre. Lo que no encaje en ninguno de los tres huecos detiene el
comando y se dice en voz alta: un rol mal escrito o un nombre sin comillas
daría de alta a alguien mal y sin avisar.

**El código solo se muestra una vez.** Si se pierde, no hay que borrar a nadie
ni buscar otro comando: repite el mismo `crear`. Si el email ya existe le da un
código nuevo y **anula el anterior**, y deja el nombre y el rol como estaban
salvo que los escribas.

### Si el despliegue está sobre una plataforma (Skyway, Railway, Fly…)

Ahí no hay repositorio ni `npm`: la imagen del servicio es Caddy sirviendo la
PWA ya compilada, y por eso `npm run admin:user …` responde `sh: npm: not
found`. Las mismas órdenes viajan dentro de la imagen como `alta`, y se
escriben en la terminal del servicio, desde el panel:

```bash
alta listar
alta crear  ana@x.es "Ana Ruiz" tecnico
alta crear  ana@x.es                  # ya existe: código nuevo, el viejo anulado
alta codigo ana@x.es
alta rol    ana@x.es supervisor
alta borrar ana@x.es
```

Requisito único: que el servicio tenga `SUPABASE_SERVICE_ROLE_KEY` entre sus
variables de entorno. La URL de la API la deduce de `SUPABASE_UPSTREAM`, que ya
está puesta para que Caddy haga de proxy.

Si además tienes desplegado el worker de informes, su terminal responde a lo
mismo con `npm run admin -- …`.

### Los tres roles

| Rol | Puede |
|---|---|
| `tecnico` | Revisar salas, abrir incidencias, consumir material del almacén |
| `supervisor` | Además: cerrar incidencias, registrar compras y generar informes |
| `admin` | Además: editar edificios y salas, gestionar usuarios, pestaña Datos y configurar la clave de la IA de los informes |

Un cambio de rol tarda hasta una hora en aplicarse, o es inmediato si la persona
cierra y vuelve a entrar con su PIN. El rol viaja dentro del token.

### Qué entra en la pestaña de Incidencias, y qué no

Conviene saberlo antes de mirar el número: **un equipo marcado «Falla» en una
revisión abre una incidencia**, sola, en cuanto el técnico cierra la revisión.
Antes ese fallo se quedaba dentro de la revisión y no se lo pedía a nadie.

Consecuencias prácticas:

- **El recuento de incidencias abiertas sube** en cuanto esto se despliega. No es
  que se hayan roto más cosas: es que las averías que ya estaban registradas
  ahora se ven. Y solo un `supervisor` puede cerrarlas, así que la cola es suya.
- **No se duplican por ronda.** Si el proyector sigue roto la semana siguiente,
  la revisión no abre una segunda: la que hay sigue contando los días. La
  incidencia guarda de qué comprobación salió, en `incidents.check_key`.
- **Un fallo apuntado con la app antigua también acaba aquí.** Quien abre la
  incidencia es el dispositivo al cerrar la revisión, y un iPad puede pasarse
  días sirviendo la versión anterior desde su caché — sus fallos quedaban
  guardados en la revisión y sin incidencia. El servidor lo repasa solo
  (`abrir_incidencias_de_revisiones()`, al desplegar y cada madrugada): mira la
  última revisión vigente de cada sala y abre lo que falte, con la fecha de la
  visita y sin tocar lo ya resuelto. Si una revisión con «Falla» no enseña su
  incidencia hoy, mañana a primera hora estará.
- **Las observaciones no entran.** Se escriben en la revisión, debajo de las
  fotos, viven en `inspections.notes` y se leen en la ficha del aula. La pestaña
  de Incidencias es la lista de lo que hay que arreglar; una nota de seguimiento
  no lo es. Las observaciones importadas del Excel siguen en el histórico de cada
  sala, con su marca, y siguen puntuando en el índice de fiabilidad.
- **Las solicitudes sí entran**, marcadas como tal: son trabajo pedido y no hay
  otro sitio donde reclamarlas.

### Una revisión corregida, y qué significa para los números

Un técnico puede **corregir** una revisión ya cerrada desde la ficha del aula. No
la reescribe: se crea una fila nueva en `inspections` con `corrects` apuntando a
la anterior y `corrected_at` diciendo cuándo. La corregida se queda intacta —el
congelado sigue en pie para todo el mundo salvo un administrador— y las dos
versiones se leen en la ficha.

Lo que hay que saber para no interpretar mal una cifra:

- **La corrección conserva `occurred_at`**, la fecha de la visita. Corregir en
  julio una revisión de marzo no mueve la fecha de «última revisión» del aula ni
  la saca de la lista de pendientes.
- **Todo lo que cuenta revisiones cuenta `inspections_vigentes`** —cerradas y sin
  corrección encima— y cuenta **visitas**, no filas: `room_overview`,
  `room_reliability`, `alerts_repeat_offenders`, `room_timeline` y el worker de
  informes. Si escribes una consulta nueva sobre `inspections`, usa esa vista o
  contarás la misma visita dos veces.
- **Las incidencias que abrió la original no se cierran** porque la corrección
  diga que el equipo estaba bien. Siguen en la cola del supervisor, con su
  resolución, que es donde se decide eso.

```sql
-- Qué se ha corregido y quién, para mirarlo de cuando en cuando
select r.code, base.occurred_at as visita, c.corrected_at,
       pb.full_name as la_hizo, pc.full_name as la_corrigio
from inspections c
join inspections base on base.id = c.corrects
join rooms r          on r.id = c.room_id
left join profiles pb on pb.id = base.by_user
left join profiles pc on pc.id = c.by_user
where c.status = 'completa'
order by c.corrected_at desc;
```

```sql
-- Las averías que ha abierto la revisión, con el aparato al que apuntan
select i.opened_at, r.code, i.title, i.severity, a.serial
from incidents i
join rooms r on r.id = i.room_id
left join assets a on a.id = i.asset_id
where i.opened_from_inspection_id is not null and i.state <> 'resuelta'
order by i.opened_at;
```

### Dar de baja a alguien

```sql
update profiles set active = false where email = 'ana@x.es';
```

Deja de tener rol, y **RLS le impide ver absolutamente nada** — comprobado en la
prueba 13 del proyecto. Sus revisiones e incidencias se conservan, que es justo
lo que da valor a la trazabilidad.

Esta es la baja de casi todo el mundo. `alta borrar` existe para el otro caso:
el alta equivocada, la persona que nunca llegó a entrar. Al que tenga historial
la base de datos no lo deja borrar —`by_user`, `opened_by` y `resolved_by`
apuntan a su perfil sin `on delete`—, así que el comando falla y remite aquí.
Es la protección funcionando, no una avería.

### Un dispositivo perdido

Con `VITE_LOCK_AFTER_MINUTES=0` la sesión no caduca, así que **si se perdió con
la sesión abierta, quien lo encuentre puede usar la aplicación**. Actúa deprisa:

```sql
-- 1. Cortar el acceso de esa persona a todo, ahora mismo
update profiles set active = false where email = 'ana@x.es';

-- 2. Dejar constancia del dispositivo
update devices set revoked_at = now()
where profile_id = (select id from profiles where email = 'ana@x.es');
```

El paso 1 es el que corta de verdad: sin perfil activo el hook deja de dar rol y
RLS no permite ver nada, en cuanto caduque el token de acceso (una hora como
mucho). Después, para devolverle el acceso desde otro dispositivo:

```sql
update profiles set active = true where email = 'ana@x.es';   -- reactivar
```

```bash
npm run admin:user -- codigo ana@x.es                         -- código nuevo
```

Si el dispositivo se perdió **con la sesión cerrada**, no hay urgencia: sin el
PIN los datos guardados son ilegibles.

### Un dispositivo que no consigue subir su cola

La lámpara de la cabecera marca pendientes y el número no baja. Antes de tocar
nada: **el trabajo no se ha perdido**. Vive en el dispositivo y no lo borra ni
cerrar sesión, ni fallar el PIN cinco veces, ni recargar. Lo que pasa es que
mientras no suba existe en un solo sitio, y eso es lo que hay que resolver.

**Primero, poner el trabajo a salvo.** En el dispositivo, pulsa la lámpara →
**Guardar copia de lo pendiente**. Sale un fichero `pendientes-aulas-….json`
con todos los cambios y las fotos dentro; mándalo por AirDrop o correo. No
necesita red del servidor ni permisos: es local. A partir de ese momento el
trabajo ya no depende de ese iPad.

**Después, meterlo por otro lado.** En un equipo con sesión de administrador:
`Datos → Recuperar trabajo de un dispositivo → Elegir fichero de copia`. Se
vuelve a encolar y se sube con esa sesión. Importar dos veces la misma copia no
duplica nada: el identificador de cada fila se genera al pulsar, no al enviar, y
es la clave de idempotencia.

**Y luego, por qué no subía.** Abre la lámpara: debajo del contador sale el
motivo del último intento, y `Ver diagnóstico del servidor` dice si es cosa de
permisos. Los dos casos habituales:

- *Amarillo, «N pendientes»* — no es rechazo del servidor: o no hay línea, o la
  cola está esperando su turno de reintento. **Sincronizar** lo intenta ya, sin
  esperar.
- *Rojo, «N sin enviar»* — el servidor los ha rechazado. El motivo sale escrito
  debajo. **Reintentar** los devuelve a la cola una vez arreglada la causa
  (normalmente un rol o un perfil desactivado: mira el diagnóstico).

Cerrar sesión no borra nada, pero **para la subida en seco**: sin sesión no se
puede mandar nada al servidor. Si alguien cierra sesión creyendo que así se
guarda, está haciendo justo lo contrario. La aplicación avisa cuando quedan
cambios sin subir.

### El despliegue muere con «policy … already exists»

Le pasó a este proyecto y bloqueó la salida del arreglo que la gente de campo
estaba esperando, así que conviene reconocerlo rápido:

```
ERROR:  policy "personal lee solicitudes de retirada" for table "asset_removals" already exists
```

Significa que una migración se está aplicando por segunda vez. `create policy` no
admite `if not exists`, así que muere ahí; y con `ON_ERROR_STOP=1` se lleva por
delante el despliegue entero, incluidas las migraciones que venían detrás.

Ya no debería ocurrir: todas las políticas llevan delante su `drop policy if
exists`, y `npm run check:migraciones` —que corre dentro de `verify:all`— falla
si alguien añade una sin él. Si aun así aparece, es que la base tiene el registro
de aplicadas desincronizado. Se arregla anotando lo que ya está sin volver a
ejecutarlo:

```bash
psql "$DATABASE_URL" -c "insert into public.schema_migrations (filename)
  values ('00000000000000_bootstrap_roles.sql'), ('…')
  on conflict do nothing"
```

Los dos scripts de despliegue imprimen esa orden ya montada con la lista
completa cuando detectan la situación. Repasa la lista antes de pegarla y quita
las que sepas que **no** se han aplicado todavía.

Conviene además que la aplicación esté **instalada en la pantalla de inicio**.
iOS puede desalojar el almacenamiento de un sitio que lleve siete días sin
abrirse; instalada, no. La aplicación pide almacenamiento persistente al
arrancar, pero eso lo concede iOS por heurística y no es una garantía.

## 3. Editar edificios, salas y equipamiento

Las altas y las bajas se hacen **desde la aplicación**, en `Datos → Salas y
edificios`, y solo las ve un `admin`. Es a propósito: el maestro sostiene el
histórico, los informes y las placas de la puerta, y una sala creada desde el
aula con el código mal escrito se convierte en una sala duplicada de la que
nadie sabe cuál es la buena.

**Una sala nueva nace completa**: con su matrícula `SALA-000xxx`, su QR y el
equipamiento por defecto de su edificio. La planta se escribe tal cual —`1ª
PLANTA`— y si ya existe se reutiliza: «1ª Planta» y «1ª PLANTA» no crean dos.

**Dar de baja no siempre es borrar**, y la diferencia la decide el servidor:

| La sala tiene… | Qué pasa |
|---|---|
| Nada | Se borra de verdad, con el equipamiento que le puso el defecto |
| Revisiones, incidencias, inventarios o consumos | Se **archiva**: sale de la lista de trabajo, del buscador y de los dispositivos, y todo lo que se hizo allí se conserva entero |

Las archivadas salen plegadas al final de la sección, con un botón de
**Reactivar**. Borrarlas de verdad sería tirar el histórico de un año para
limpiar una lista.

Un edificio se borra solo cuando está vacío. Si todavía tiene salas, el
servidor lo rechaza y dice cuántas: para el caso frecuente —el duplicado— lo que
toca es **Fusionar**, que está en `Edificios sin identificar` y se lleva consigo
zonas, salas e incidencias.

### El equipamiento por defecto

`Datos → Equipamiento por defecto` declara **lo que toda sala lleva**, para que
un aula nueva no nazca vacía. Dos ámbitos, y el segundo existe porque el primero
no llega:

- **En todas las salas** — el global.
- **Solo en un edificio** — y **manda sobre el global** para ese tipo. Es lo que
  permite decir «en todas partes una pantalla; en el EPS, dos» sin repetir la
  lista veintitrés veces.

Se aplica solo al crear la sala. Para las que ya existen está **Aplicar ahora**,
con la cifra delante —«se crearían 35 equipos en 18 salas»— porque es una
escritura masiva sobre inventario real. Solo **añade lo que falta**: una sala con
tres pantallas donde el defecto dice una se queda con sus tres. Y quitar un
defecto no quita nada de ninguna sala: lo materializado es inventario de verdad.

El equipo **se elige del catálogo, no se escribe**: esto instala en 276 aulas de
una vez, y un nombre suelto sería la vía más rápida de meter ahí un duplicado.
Los tipos **sin validar** —los que creó alguien desde un aula— salen marcados y
se pueden declarar igual: suele ser justo el que hace falta, y esconderlo solo
escondía la decisión. Conviene revisarlos antes en la bandeja de tipos, que está
en esta misma pantalla.

### Cambios en lote

Para lo que no cabe en la pantalla, SQL directo:

```sql
-- Renombrar una sala
update rooms set name = 'Aula Magna' where code = '1.7'
  and zone_id in (select z.id from zones z
                  join buildings b on b.id = z.building_id
                  where b.code = 'H');

-- Corregir el equipamiento: es lo que decide qué comprobaciones aparecen
update rooms
set capabilities = capabilities || '{"microfono": true, "camara": true}'::jsonb
where code = '2.3';

-- Dar de baja una sala sin borrar su historial (es lo que hace «Dar de baja»
-- desde la aplicación cuando la sala tiene histórico)
update rooms set active = false where code = '0.6';
```

**`capabilities` describe el equipamiento**, pero ya no es lo que dibuja el
formulario: la revisión pregunta por los **elementos** de `assets`, uno por
aparato. Si cambias `capabilities`, materializa los elementos que falten:

```sql
select public.backfill_room_assets();   -- idempotente, no duplica nada
```

Campos: `proyector`, `altavoces`, `camara`, `microfono`, `botonera`, `tv`.

## Catálogo de equipos

Un técnico puede **dar de alta equipos y tipos desde el aula**. Entran sin
confirmar, salen en naranja y **se usan igual**: bloquear la revisión hasta que
alguien apruebe un nombre es el camino más corto a que el equipo deje de apuntar
lo que encuentra.

La contrapartida son las dos bandejas del panel, y responden a dos preguntas
distintas.

### Equipos sin validar — ¿está de verdad ese aparato en esa aula?

`Datos → Equipos sin validar` lista lo que alguien apuntó desde un aula,
agrupado por sala y con quién y cuándo. «Micrófono Jabra» puede ser un tipo
perfectamente validado y aun así ser mentira que haya uno en el 2.4.

- **Validar** — uno, los de una sala, o los de la lista entera.
- **No está** — **lo borra de la sala**. Un equipo sin validar es una propuesta,
  y una propuesta rechazada no tiene por qué dejar un aparato retirado en el
  histórico de una sala donde nunca hubo nada. Queda la fila de auditoría con
  quién lo descartó, que es todo lo que hay que conservar. Si de él ya colgaba
  algo firmado —una revisión que lo comprobó, una incidencia que lo señala— el
  servidor lo retira en vez de borrarlo, y lo dice.

Un equipo **ya validado** no sale por aquí: para ese está la solicitud de
retirada, más abajo.

Lo que carga una máquina —el importador, el equipamiento por defecto— nace
validado: no es la propuesta de nadie que haya estado en el aula.

### Retiradas por autorizar — ¿este aparato sale de la sala?

Quitar un equipo **no** lo hace el técnico: lo **pide**. En el aula elige a dónde
va, y hasta que alguien lo autorice el equipo sigue en la sala y sigue contando
en las revisiones, porque sigue estando ahí.

| Destino | Qué hace al autorizarse |
|---|---|
| **Dar de baja** | El aparato se ha muerto. Sale del inventario, conserva la sala en la que estuvo, y la baja queda en su histórico |
| **Devolver al almacén** | Está bien y vuelve a la estantería. Sale del inventario, se queda sin sala y **suma una unidad al almacén** |

La segunda es la que faltaba: con un solo botón de «retirar», cada equipo que
volvía al almacén era una unidad que el sistema perdía — el aula dejaba de
tenerla y el almacén no la ingresaba nunca.

`Datos → Retiradas por autorizar` enseña el aparato, la sala, quién lo pide, por
qué y —si vuelve al almacén— **en qué artículo va a caer la unidad, antes de
autorizar**. Si ese tipo de equipo no tiene artículo de almacén, lo dice en
naranja: la retirada se hará igual y el ingreso no, así que hay que enlazarlo en
`Almacén` y ajustar a mano.

Autorizar hace cuatro cosas en una sola operación —retira el equipo, deja el
evento en el histórico de la sala, ingresa la unidad y cierra la solicitud—
porque a medias quedaría un aparato retirado que nadie ingresó. **No retirarlo**
cierra la solicitud y deja el equipo donde está.

Solo puede haber una solicitud viva por equipo, y quien la firmó puede
retirarla mientras nadie la haya decidido.

### Tipos sin validar — ¿cómo se llama esa clase de aparato?

`Datos → Tipos de equipo sin validar`, y tiene tres salidas. Ninguna es borrar:
lo que alguien apuntó porque lo tenía delante existe.

| | Cuándo | Qué hace |
|---|---|---|
| **Confirmar** | Era un tipo nuevo legítimo | Deja de salir en naranja |
| **Corregir nombre** | Estaba bien pero mal escrito | Renombra y **guarda el nombre viejo como alias**, así quien lo teclee mañana encuentra este |
| **Agrupar** | Ya existía con otras palabras | Se marcan los que son lo mismo, se elige cuál sobrevive y se le pone el nombre bueno de una vez |

**Renombrar y agrupar son globales de verdad**: el nombre nuevo baja hasta la
etiqueta de cada equipo en cada sala, así que «Cañón» y «Cañón 2» pasan a leerse
«Proyector» y «Proyector 2» en las cuarenta aulas. Si en el aula siguiera
poniendo lo de antes, el renombrado no habría llegado a donde se lee. Las
etiquetas escritas a mano —«Pantalla atril»— no se tocan: valen más que el
nombre del tipo, porque las escribió quien estuvo delante.

Se agrupa en bloque, y no de uno en uno, porque así es como llegan: «Jabra»,
«Mic Jabra» y «Micro jabra» aparecen la misma semana y son el mismo micrófono.

Los duplicados de grafía —«Micrófono» y «microfono»— no llegan aquí: los para el
índice único sobre el nombre normalizado, y el cliente refuerza lo mismo
derivando el id del nombre, así que dos técnicos sin cobertura que registren lo
mismo generan **la misma fila**. Lo que sí llega es el duplicado de vocabulario
—«Cañón» y «Proyector»—, y para eso está la fusión.

Los alias son la mitad del valor: quien escribe `jab` encuentra el micrófono que
ya existe y nunca llega a la opción de crear.

```sql
-- Ver qué hay pendiente y cuánto se usa
select t.name, count(a.id) as en_salas
  from asset_types t left join assets a on a.asset_type_id = t.id
 where not t.confirmed and t.merged_into is null
 group by t.name order by 2 desc;

-- Añadir un alias a mano
update asset_types set aliases = aliases || 'proyeltor'
 where id = public.asset_type_id('Proyector');
```

Todo cambio en `rooms`, `buildings`, `stock_items`, `assets`, `incidents` y
`profiles` **queda auditado** con autor y valores anterior y posterior:

```sql
select at, by_user, old_data->>'name', new_data->>'name'
from audit_log where table_name = 'rooms' order by at desc limit 20;
```

### Auditoría de inventario — el mismo aparato apuntado dos veces

El síntoma con el que se llega aquí: alguien teclea «Monitor Atril», la
aplicación guarda «Monitor Atril 2», y en la lista de la sala no aparece ningún
«Monitor Atril». Casi siempre son **dos filas para un solo aparato**: un
dispositivo con el espejo atrasado volvió a apuntar un equipo que ya existía, y
el servidor —que no puede rechazar la fila sin perder el trabajo— la guardó con
el siguiente número libre. Desde entonces cada choque de esos queda además
**registrado** con el par identificado, así que la bandeja no adivina: enseña.

En `Auditoría de inventario` hay dos cosas:

- **El resumen del servidor**: cuántos equipos, incidencias, revisiones y salas
  hay de verdad en la base. Si un iPad enseña menos, ese dispositivo no ha
  terminado de descargar — se arregla sincronizando, no re-apuntando equipos.
- **Los posibles duplicados**: pares de la misma sala, mismo tipo y mismo nombre
  base, con lo que cuelga de cada lado (revisiones, incidencias, eventos).
  Decide siempre una persona, y hay tres salidas:

| | Qué hace |
|---|---|
| **Es el mismo: quedarse con uno** | El otro se **retira, no se borra**: su serie y su modelo viajan al que se queda si le faltaban, sus incidencias se repuntan, sus revisiones se siguen leyendo enteras («retirado desde entonces»), y la etiqueta base vuelve al superviviente — el «Monitor Atril 2» vuelve a llamarse «Monitor Atril». |
| **Quedarse con el otro** | Lo mismo, en el sentido contrario. Mira los registros de cada lado: el que tiene historia es el que conviene conservar. |
| **Son dos aparatos** | No toca nada y el par deja de proponerse. |

Fusionar no puede perder datos por diseño: todo lo que el duplicado tenía sigue
guardado y legible. Equivocarse de sentido tampoco pierde nada — solo deja
retirado el lado con más historia, que se puede consultar igual.

```sql
-- Los choques de etiqueta que el servidor ha tenido que recolocar
select at, pedida, asignada, resolved
  from asset_label_conflicts order by at desc limit 20;
```

## 4. Almacén

Desde la pestaña **Almacén**, con `+` y `−` por artículo.

**Las existencias no son un campo editable: son la suma de los movimientos.**
Por eso no puede repetirse el descuadre del Excel, que llegó a tener stock
negativo. Para corregir un recuento físico, registra un ajuste:

```sql
insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, note)
select gen_random_uuid(), id, 12, 'ajuste', now(), 'Recuento físico de julio'
from stock_items where name = 'Cable HDMI fibra 15 m';
```

### De dónde sale el consumo

El material se apunta **en la incidencia**, no en el almacén: botón **Material**
en la fila de la incidencia, se busca el artículo y se pone la cantidad. Así el
movimiento nace sabiendo para qué fue y en qué sala, que es lo que permite
contestar «cuánto material se llevó el edificio H». Se puede apuntar sin
cobertura: va por la cola de salida como las revisiones.

El `−` de la pestaña Almacén sigue estando y sirve para lo demás —una
instalación programada, una sustitución preventiva—, pero ese consumo queda sin
destino y por eso no aparece repartido por edificio.

Dos consultas que ya tienen datos de verdad:

```sql
-- Qué se gasta más
select * from material_consumption_ranking limit 10;

-- Cuánto se gastó cada mes, que sustituye a las doce columnas de la hoja Bolsa
select * from stock_monthly_consumption order by month desc, consumed desc;
```

### Un movimiento no se corrige: se contrapone

`stock_movements` es un libro de asientos y está cerrado a solo-alta. Ni la
aplicación ni la API dejan modificar ni borrar un movimiento: **para corregir un
error se registra el contrario**, y las dos filas se quedan. Es lo que hace el
botón «Deshacer» de la pantalla de Almacén.

Si necesitas reparar algo a mano —un movimiento importado con la fecha mal— hay
que desactivar el disparador a propósito, y eso se nota:

```sql
alter table stock_movements disable trigger stock_movements_solo_alta;
-- … la reparación, anotando qué y por qué en import_fixes …
alter table stock_movements enable trigger stock_movements_solo_alta;
```

### Las existencias no bajan de cero

**No se puede gastar lo que no hay.** El `−` sale apagado en los artículos a
cero, y si la cifra de la pantalla se ha quedado vieja —otro técnico gastó la
última unidad hace un minuto— el servidor rechaza el movimiento y lo dice.

Que el saldo sea una suma ya impedía el descuadre de teclear una cifra a mano,
que es de donde salían los negativos de la hoja Bolsa. No impedía restar más de
lo que hay: cuatro toques en un artículo a cero lo dejaban en −4, y el informe
de consumo daba esa cifra por buena.

Cuando un técnico te diga que el material está en el almacén pero la aplicación
no le deja apuntarlo, **casi siempre falta registrar la compra que lo trajo**:

```sql
insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, note)
select gen_random_uuid(), id, 20, 'compra', now(), 'Pedido de septiembre'
from stock_items where name = 'Cable HDMI fibra 15 m';
```

La regla frena lo que empeora un saldo, nunca lo que lo arregla: si un artículo
llegara a estar en negativo, las entradas que lo cuadran se aceptan igual. Para
verlos —no debería haber ninguno—:

```sql
select name, on_hand from stock_levels where on_hand < 0;
```

### Cómo se escriben los nombres

Los artículos se llaman siempre igual: siglas en mayúscula (`HDMI`, `USB`,
`RS-232`, `DisplayPort`), longitudes en metros con la unidad separada (`10 m`,
nunca `10mts` ni `10 metros`) y el resto en minúscula salvo marcas y modelos,
que van tal cual (`iiyama T2454MSC`).

No es manía de estilo: la lista venía de dos sitios —la hoja *Bolsa* y el texto
libre de «Material Usado»— y llegó a tener 111 artículos donde hay 45. «Matriz
HDMI» y «Matriz Hdmi» eran dos filas, el mismo cable de fibra estaba seis veces
escrito de seis maneras, y el informe de consumo repartía su gasto entre todas.

Hay un índice único sobre el nombre normalizado, así que **la base ya no deja
crear «teclado» si existe «Teclado»**. Si al dar de alta un artículo salta un
error de duplicado, es que ya está en la lista con otras mayúsculas o tildes:
búscalo antes de insistir.

Las 23 entradas que no llegaban a ser un artículo —«mts», «pulgadas», «cables
de»— quedaron **archivadas**: no salen en la pestaña Almacén, pero siguen
enlazadas a las incidencias que las citan. Para verlas:

```sql
select name from stock_items where not active order by name;
```

Si alguna sí era material y no está ya en la lista, ponle el nombre bueno y
reactívala:

```sql
update stock_items set name = 'Canaleta de suelo', active = true
where name = 'mts canaleta de suelo';
```

Cada fusión y cada renombrado quedó registrado con su nombre original:

```sql
select original, corrected, reason from import_fixes
where source = 'Almacén' order by id;
```

### Umbrales de aviso

Ningún artículo avisa por defecto: **no se puede estar por debajo de un mínimo
que nadie ha fijado**. Actívalos donde importe:

```sql
update stock_items set min_threshold = 5
where name in ('Lámpara proyector NP44', 'Cable HDMI fibra 15 m');
```

Los artículos por debajo salen en rojo y en el panel.

## 5. Las placas de puerta

Se imprimen desde la lista de salas del edificio, con **Placas**: una por
puerta, con la matrícula (`SALA-000087`), el código del aula y el QR.

Tres cosas que deciden si funcionan o no:

- **Imprime en A4 sin ajuste de escala.** Si la impresora reduce, el código se
  emborrona y deja de leerse.
- **Sale en blanco y negro aunque la aplicación esté en modo oscuro.** Una hoja
  de placas en negativo se come un cartucho y sale ilegible.
- **El QR apunta al identificador interno de la sala, no a su nombre ni a su
  matrícula.** Renombrar el aula, cambiarla de planta o corregir su código **no
  rompe la placa**. Lo único que la invalida es borrar la sala, o mudar el
  despliegue a otro dominio — para eso, una redirección desde el viejo.

Y para leerlas hay dos caminos, los dos válidos:

- **La cámara del móvil**, sin abrir nada antes. El QR es una URL.
- **«Escanear el QR del aula»**, arriba de la pantalla de Revisar, para cuando
  ya se está dentro de la aplicación. Lleva linterna, que en un pasillo a
  oscuras es la diferencia entre leer y no leer.

Los dos entran **directos a la revisión**. La ficha de la sala queda a un toque,
en la placa de la cabecera.

## 6. Inventario por levantar

Al importar quedaron **41 salas con cero equipos registrados** y 75 equipos sin
número de serie. La aplicación no puede saber si esas aulas están vacías o si
nadie ha ido nunca a mirar — y por eso **no insiste**: un aviso que sale en 41
sitios y no se puede quitar deja de leerse en dos días, y arrastra consigo a los
avisos que sí importaban.

Lo que hay en su lugar es un acto explícito. El técnico, desde la propia
revisión, confirma **«esto es todo lo que hay»** y la sala deja de estar
pendiente. Queda registrado quién y cuándo, en la tabla `room_inventories`, que
es **append-only**: el recuento del curso siguiente es una fila nueva, no pisa
la anterior.

Dónde se ve el pendiente:

- **Panel** → tarjeta *Inventario por levantar*, en gris. Desaparece sola.
- **Lista de salas** → etiqueta *Sin inventariar*, para poder ir a por ellas
  mientras se está en el edificio.
- **Historial** → cada confirmación sale como entrada de la familia *Equipo*.

```sql
-- Qué falta, por edificio
select building_code, count(*) as sin_levantar
from room_overview where last_inventory_at is null
group by building_code order by 2 desc;

-- Quién ha levantado qué, y cuándo
select r.code, v.occurred_at, p.full_name, v.asset_count, v.note
from room_inventories v
join rooms r on r.id = v.room_id
left join profiles p on p.id = v.by_user
order by v.occurred_at desc limit 50;
```

Si el curso que viene quieres forzar un recuento general, **no hace falta borrar
nada**: las salas siguen apareciendo con su última fecha, y basta con pedir que
se vuelvan a confirmar.

## 7. Historial

La pestaña **Historial** cruza lo que hasta ahora había que mirar en tres
sitios: revisiones, incidencias, material y movimientos de equipos, todo en una
lista y filtrable por tipo, edificio, sala y fechas.

Es de donde salen las respuestas que se piden a final de curso:

- *Cuánto material se llevó el edificio H* → filtro **Material** + edificio H +
  **Este curso**.
- *Qué pasó la semana del apagón* → fechas exactas, sin filtro de tipo.
- *Si el proyector del 1.7 lleva tres averías o una* → filtro **Incidencia** +
  esa sala.

Sale de la vista `room_timeline`, que **no guarda nada nuevo**: lee de las
tablas que ya existen. Por eso no puede desincronizarse ni contradecir a las
otras pantallas.

## 8. Informes

**El automático sale los viernes a las 07:00**, con la semana hasta el jueves
—de lunes a jueves—. El viernes a esa hora aún no ha pasado: meterlo vacío en el
periodo hacía que la comparación con la semana anterior saliera «bajando» todos
los viernes, por diseño. Queda archivado en la pestaña **Informes**, con
descarga; quien quiera la semana con el viernes dentro la pide a mano el lunes.

Cualquier otro se pide a mano desde esa misma pantalla. Se elige:

| Qué se elige | Para qué sirve |
|---|---|
| **Periodo** | Semana en curso, semana pasada, mes en curso, mes pasado, ayer, o dos fechas cualesquiera. Debajo se lee qué días va a cubrir antes de pedirlo |
| **Secciones** | Las trece del informe, entre ellas la lista de todas las revisiones hechas y el diario de lo que pasó cada día. «Reparto del trabajo» lleva nombres de personas y por eso hay que marcarla a mano |
| **Análisis con IA** | Si se desmarca, el informe sale con el análisis calculado |
| **Escrito para** | Dirección (estado, tendencia y decisiones) o equipo técnico (qué salas tocar y con qué material) |
| **En qué fijarse** | Una instrucción libre para la redacción: «céntrate en el edificio H». No cambia ninguna cifra |
| **Nota en portada** | Un texto que se imprime tal cual bajo el título. No pasa por la IA |

Genera y espera: la pantalla avisa cuando el PDF está. Con IA suele tardar entre
veinte segundos y un minuto.

### Si no sale ningún informe

En la misma pantalla hay un desplegable — **«¿No sale el informe?»** — que le
pregunta a la base por la tubería entera y contesta con palabras: si pg_net está
instalado y **despachando su cola** (que son dos cosas distintas), qué contestó
el worker las últimas veces, y qué hizo el cron. Se abre solo cuando un informe
tarda más de la cuenta.

Los tres diagnósticos que resuelven casi todo:

| Lo que dice | Qué significa | Qué hacer |
|---|---|---|
| **Peticiones encoladas y nadie las despacha** | `pg_net` no está en `shared_preload_libraries`: todo parece funcionar y ningún informe se genera nunca. Fue un fallo real de este proyecto | Comprueba que la lista del servicio `db` en `docker-compose.yml` incluye `pg_net` y reinicia la base |
| **El worker rechaza la llamada (401)** | El token de `app_config` no coincide con el del contenedor de informes | `scripts/deploy.sh` los siembra iguales; vuelve a desplegar o iguálalos a mano |
| **No se alcanza el worker** | El contenedor `aulas-reports` está caído o fuera de la red | `docker compose up -d reports-worker` y mira su registro |

**Un informe emitido no se regenera nunca: se versiona.** Si los datos cambian
después, el PDF del viernes sigue diciendo lo que decía el viernes. Es lo que le
da valor como registro.

### El análisis con IA

Lo que hay que tener claro antes de activarlo:

> **Las cifras las calcula la base de datos. La IA solo escribe el texto.**

Ni un número del informe sale del modelo. Si en su redacción aparece una cifra de
tres dígitos que no está en los datos —o dos fórmulas de las que delatan a un
texto generado— se tira el texto entero y se emite con el análisis calculado.

**El PDF no dice en ninguna parte que se haya usado IA.** Es un documento del
servicio que habla del estado del campus, y va limpio. Si necesitas saber cómo se
redactó un informe concreto, está en la pantalla de Informes: cada entrada del
archivo lo indica debajo de su periodo.

**Sin clave, el informe sale igual.** El análisis lo escriben las reglas del
sistema: es un texto completo, con su párrafo de entrada y su lista de cosas que
hacer, no un hueco con un aviso.

Para activarlo hacen falta dos cosas: una clave de
[Google AI Studio](https://aistudio.google.com/apikey) —es de pago por uso; un
informe semanal cuesta céntimos— y ponerla en un sitio:

- **En el servidor**, en `GEMINI_API_KEY` del `.env`. Es lo preferible.
- **Desde la aplicación**, en Informes → «Poner la clave de Gemini», con perfil
  de administrador. Sirve cuando no hay acceso al servidor. Se guarda en
  `app_config`, que solo leen los administradores y el worker.

Si están las dos, manda la del servidor. La clave no se muestra nunca, ni
recortada: la pantalla solo dice si hay una guardada.

El modelo (`gemini-3.6-flash`) y cuánto se le deja pensar (`high`) se cambian en
la misma pantalla. Bajar el razonamiento sale más barato y se nota: el análisis
pasa de agrupar avisos a parafrasearlos.

## 9. Ajustes que quizá quieras cambiar

Se tocan en el `.env` y requieren reconstruir la aplicación (`npm run build`),
porque se compilan dentro:

| Variable | Por defecto | Qué hace |
|---|---|---|
| `VITE_LOCK_AFTER_MINUTES` | `0` | Inactividad antes de volver a pedir el PIN. **0 = nunca**: la sesión dura hasta que el técnico pulsa «Cerrar sesión». Pon `480` (una jornada) si los dispositivos se comparten entre turnos o salen del campus |

En base de datos, sin reconstruir nada:

```sql
-- Cambiar el día o la hora del informe automático.
--
-- Se programan tres disparos (05:00, 06:00 y 07:00) y la función comprueba qué
-- hora es DE VERDAD en Madrid antes de hacer nada: `pg_cron` interpreta sus
-- horarios en `cron.timezone`, que aquí es Europe/Madrid pero en un Postgres
-- gestionado suele quedarse en GMT. Exactamente uno de los tres cae a las 07:00
-- peninsulares en cualquiera de los dos casos y en los dos horarios del año.
--
-- Para moverlo a otro día, cambia el 5 (viernes) del final: 1 es lunes.
select cron.schedule('informe-semanal', '0 5,6,7 * * 5',
                     $$select public.informe_semanal_programado()$$);

-- Y para cambiar la HORA hay que tocar las dos cosas: los disparos de arriba y
-- la comprobación de dentro de `informe_semanal_programado()`.
```

Los umbrales de las alertas (lámpara al 20%, incidencia estancada a los 7 días,
sala sin revisar a los 180) están en las vistas `alerts_*` de
`supabase/migrations/20260728000200_views.sql`. Cambiarlos es reescribir la
vista con `create or replace view`.

## 10. Comprobaciones periódicas

```bash
npm run backup                        # a diario, por cron
npm run backup -- --probar <fichero>  # de vez en cuando: una copia sin
                                      # restaurar nunca no es una copia
```

Y una consulta que conviene mirar de cuando en cuando — revisiones que llegaron
tarde por falta de cobertura:

```sql
select count(*) from inspections
where recorded_at - occurred_at > interval '1 hour'
  -- Las correcciones fuera: conservan la fecha de la visita que corrigen, así
  -- que una revisión de marzo corregida hoy tiene cuatro meses de «retraso» sin
  -- que nadie haya estado sin cobertura ni un minuto.
  and corrects is null;
```

Si crece mucho, hay zonas del campus donde los técnicos trabajan sin red más de
lo previsto.
