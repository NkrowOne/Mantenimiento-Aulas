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

alta dispositivos ana@x.es            # qué ocupa el cupo de la cuenta
alta revocar      ana@x.es --todos    # y liberarlo

alta desactivar ana@x.es              # la baja de quien tiene historial
alta activar    ana@x.es
alta borrar     ana@x.es              # solo si no tiene historial
```

Requisito único: que el servicio tenga `SUPABASE_SERVICE_ROLE_KEY` entre sus
variables de entorno. La URL de la API la deduce de `SUPABASE_UPSTREAM`, que ya
está puesta para que Caddy haga de proxy.

Si además tienes desplegado el worker de informes, su terminal responde a lo
mismo con `npm run admin -- …`.

### Los tres roles

| Rol | Puede |
|---|---|
| `tecnico` | Revisar salas, abrir incidencias, **cerrarlas explicando qué hizo**, consumir material del almacén |
| `supervisor` | Además: marcar incidencias «en curso», registrar compras y corregir a mano una incidencia cerrada |
| `admin` | Además: editar edificios y salas, gestionar usuarios, pestaña Datos, y **emitir informes** con su clave de la IA |

Un cambio de rol tarda hasta una hora en aplicarse, o es inmediato si la persona
cierra y vuelve a entrar con su PIN. El rol viaja dentro del token.

### Quién cierra una incidencia, y qué queda escrito

Cerrarla puede hacerlo **cualquiera del equipo**, desde la ficha del aula o desde
la pestaña de Incidencias, y solo de una forma: **escribiendo qué se hizo**. Sin
esa frase el botón no cierra nada.

Antes cerrar era cosa de supervisores, y la razón era buena: era un toque sin
coste, un botón que borraba trabajo de la lista sin dejar constancia de nada. Y
eso era además un retroceso respecto al Excel, que sí apuntaba qué se hizo: 276
de las 281 incidencias cerradas del histórico importado traen su frase. Con la
explicación obligatoria, cerrar vuelve a ser contar qué se hizo —firmado y con
la hora—, y quien puede contarlo es quien tuvo el aparato delante.

Lo que queda escrito:

- Una fila en `incident_resolutions` —id, explicación, quién y cuándo— que **no
  se reescribe ni se borra**, como un movimiento de almacén o una foto. Si se
  cierra dos veces, quedan las dos y la incidencia conserva el primer cierre.
- La incidencia, cerrada con esa misma explicación en `incidents.resolution`, y
  saliendo en la línea de tiempo de la sala el día que se resolvió.
- La foto, si la hubo, en `attachments` con `entity_type = 'incident'`.
- **El material gastado**, como movimientos de consumo con su incidencia y su
  sala. El formulario de cierre lo pide ahí mismo, que es donde alguien se
  acuerda del cable que acaba de poner; antes vivía detrás de otro botón y no se
  apuntaba casi nunca. Cada apunte resta del almacén en cuanto se pulsa, sin
  esperar al cierre: la pieza se gastó aunque la avería siga abierta.

El apunte enseña las existencias que el dispositivo tiene espejadas y avisa
—sin bloquear— cuando se pasa de ellas. La copia puede estar vieja y quien tiene
el cable en la mano es la persona; lo que no puede es enterarse solo el
servidor, porque el saldo no puede quedar en negativo y ese apunte volvería
rechazado a la cola.

El `UPDATE` directo sobre `incidents` **sigue siendo solo de supervisor**: es lo
que hace falta para reabrir una que se cerró por error o corregir un cierre.

```sql
-- Quién cierra y con cuánto detalle, por si hace falta mirarlo
select p.full_name, count(*) as cierres,
       round(avg(length(r.resolution))) as caracteres_de_media
from incident_resolutions r
left join profiles p on p.id = r.resolved_by
group by 1 order by 2 desc;
```

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
  diga que el equipo estaba bien. Siguen abiertas hasta que alguien las cierre
  desde la ficha del aula, explicando qué pasó, que es donde se decide eso.

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

```bash
alta desactivar ana@x.es
```

Deja de tener rol, y **RLS le impide ver absolutamente nada** — comprobado en la
prueba 13 del proyecto. Sus revisiones e incidencias se conservan, que es justo
lo que da valor a la trazabilidad. De paso revoca sus dispositivos, para que no
se queden ocupando cupo de una cuenta que ya no entra.

Esta es la baja de casi todo el mundo. `alta borrar` existe para el otro caso:
el alta equivocada, la persona que nunca llegó a entrar. Al que tenga historial
la base de datos no lo deja borrar —`by_user`, `opened_by`, `resolved_by`,
`created_by` y compañía apuntan a su perfil sin `on delete`—, así que el
comando se planta antes de intentarlo y **dice cuántas revisiones, incidencias
o informes lo impiden**. Es la protección funcionando, no una avería.

Ojo con un caso que no se ve venir: `enrollment_codes.created_by` también
cuenta. Un administrador que haya dado de alta a alguien alguna vez ya tiene
historial, aunque no haya revisado una sola sala.

### Una cuenta que no puede volver a entrar aunque le des código

Síntoma: `alta codigo ana@x.es` imprime un código con buena pinta, y la
aplicación lo rechaza. Casi siempre es el **cupo de dispositivos**.

Una cuenta admite tres aparatos a la vez, y las filas de `devices` **no se
retiran solas**: ni al caducar la sesión, ni al reinstalar la PWA, ni al borrar
los datos del navegador. Con el cupo lleno de dispositivos que ya no existen
pasan dos cosas a la vez, y las dos cierran la puerta:

- el canje del código responde 403 antes siquiera de mirarlo;
- y como la cuenta «tiene dispositivos», tampoco se le repone la contraseña
  temporal, así que el camino antiguo tampoco sirve.

Se ve y se arregla desde la misma terminal:

```bash
alta dispositivos ana@x.es     # cuáles hay, desde cuándo y cuándo se vieron
alta revocar      ana@x.es 2   # el segundo de la lista
alta revocar      ana@x.es --todos
alta codigo       ana@x.es     # y ahora sí
```

`alta codigo` avisa por su cuenta cuando el cupo está lleno, así que no hace
falta acordarse de mirar.

La columna «visto» es la que distingue un dispositivo vivo de un fantasma. Los
dados de alta antes de esta versión la tienen vacía: no quiere decir que estén
muertos, solo que nadie lo apuntaba todavía.

### Un dispositivo perdido

Con `VITE_LOCK_AFTER_MINUTES=0` la sesión no caduca, así que **si se perdió con
la sesión abierta, quien lo encuentre puede usar la aplicación**. Actúa deprisa:

```bash
alta desactivar ana@x.es
```

Corta el acceso de esa persona a todo y revoca sus dispositivos de una vez. Lo
que corta de verdad es lo primero: sin perfil activo el hook deja de dar rol y
RLS no permite ver nada, en cuanto caduque el token de acceso (una hora como
mucho). Revocar libera el cupo, pero **no cierra una sesión abierta** — no hay
forma de atar una sesión de GoTrue a una fila de `devices`.

Después, para devolverle el acceso desde otro dispositivo:

```bash
alta activar ana@x.es
alta codigo  ana@x.es
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

### Un dispositivo con la versión antigua

El síntoma clásico: dos iPads enseñan cosas distintas para la misma sala —a uno
le falta el triángulo de averías, a otro le sobra un equipo que ya se retiró—.
Casi nunca son los datos: es que uno de los dos lleva días ejecutando la
**versión anterior de la aplicación** desde su caché, con el código de antes de
los arreglos. Se comprueba en la lámpara → el número de `versión` de abajo del
panel, contrastado con el `commit` de `/salud.json`.

La aplicación **se actualiza sola**: al abrirse, al volver a primer plano tras
un rato guardada, y al terminar una revisión si la versión llegó en mitad de
una. Nunca recarga con una revisión abierta ni con una foto a medio guardar, y
no toca nada de lo pendiente: la cola vive en el dispositivo, sobrevive a la
recarga y los reenvíos son idempotentes — actualizar no puede pisar ni duplicar
trabajo.

Lo único que la actualización automática no alcanza es al dispositivo que
todavía ejecuta una versión **anterior a ella**: ese sigue con la política
vieja de «ofrecer y esperar». Hay que empujarlo una vez a mano — en el
dispositivo, lámpara → **Buscar versión nueva** y aceptar, o simplemente cerrar
la pestaña y volver a abrirla con cobertura—. A partir de ahí ya se mantiene
solo.

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

Las altas, las bajas y los nombres se tocan **desde la aplicación**, y solo los
ve un `admin`. Hay dos sitios y no es una duplicación:

- **`Datos → Salas y edificios`** — el panel: la lista completa, el alta de
  edificios y la **papelera**. Cada fila —edificio, planta y sala— tiene su botón
  de acciones `⋯`.
- **La lista de «Revisar»** — manteniendo pulsada la fila del edificio, la de la
  sala o la cabecera de la planta, o pulsando su `⋯`. Ahí está lo mismo menos el
  alta de edificios y la papelera.

En los dos sitios se abre **la misma hoja**, con los mismos verbos y las mismas
frases: lo que se lee antes de dar de baja un edificio en el panel es palabra por
palabra lo que se lee en el pasillo.

Que se pueda desde la lista de trabajo es lo que evita que el maestro envejezca:
un nombre mal escrito se descubre delante de la puerta, con el iPad en la mano, y
obligar a apuntarlo en un papel para corregirlo por la tarde en otra pantalla es
exactamente cómo se llega a una lista de la que nadie se fía. Sigue siendo solo
de administrador — un técnico no ve ninguna de estas acciones, ni el gesto le
hace nada —, y de eso se encarga el servidor y no la pantalla.

**Todo esto necesita conexión**, y es la única parte de la aplicación que la
necesita. Sin cobertura las acciones se ven, pero deshabilitadas y con el motivo
escrito debajo. La asimetría es a propósito: lo que produce el técnico —una
revisión, una incidencia, una foto— nace en el aula y no se puede repetir, así
que se guarda sin red; el maestro es la lista sobre la que trabajan 23
dispositivos a la vez, y la misma sala renombrada en dos iPads sin cobertura son
dos verdades sin forma de reconciliar. Renombrar no es urgente delante de la
puerta; revisar sí, y revisar sigue funcionando sin red.

### Altas

**Una sala nueva nace completa**: con su matrícula `SALA-000xxx`, su QR y el
equipamiento por defecto de su edificio. La planta se escribe tal cual —`1ª
PLANTA`— y si ya existe se reutiliza: «1ª Planta» y «1ª PLANTA» no crean dos. Se
añade desde las acciones del **edificio**: el `⋯` de su fila en el panel, o el
botón `+ Sala` de la cabecera de su lista en «Revisar». Ahí no vale mantener
pulsada una fila, porque la sala que se va a crear todavía no tiene ninguna.

Los edificios se dan de alta solo desde el panel. El código es el sufijo con el
que las incidencias nombran sus salas —«1.7 H»— y la aplicación avisa si no es
una a cuatro letras: no lo prohíbe, porque el servidor tampoco, pero con un
código raro las importaciones de ese edificio acabarán en cuarentena.

### Renombrar: edificio, sala y planta

| Qué | Dónde | Qué cambia de verdad |
|---|---|---|
| **Edificio** | Código y nombre | El código anterior queda de **alias** en todas sus salas, así que las incidencias antiguas —«1.7 H»— se siguen resolviendo, y la próxima importación del Excel también |
| **Sala** | Código, nombre y planta | Igual: el código viejo queda de alias. Cambiar la planta **mueve esa aula**; si la planta de origen se queda sin ninguna, desaparece sola |
| **Planta** | El nombre, para todas sus aulas | Si el nombre nuevo es el de otra planta del mismo edificio, las dos se **fusionan** y sus aulas acaban juntas. La aplicación lo avisa antes, con el número de aulas delante, y el botón pasa a llamarse «Fusionar las plantas» |

Dos verbos distintos a propósito: la hoja de una **sala** se titula «Renombrar la
sala» y cambia la planta de esa aula sola; la de una **planta** se titula
«Renombrar la planta» y cambia el nombre para todas las suyas. Llamarlas igual
haría que alguien renombrara una planta entera creyendo que movía un aula.

Un edificio y una sala abren primero un menú —renombrar, añadir, dar de baja—;
una planta va directa a su formulario, porque renombrarla es lo único que se le
puede hacer: una planta se vacía moviendo sus aulas, y entonces desaparece sola.

**La matrícula no cambia nunca al renombrar.** `SALA-000xxx` va grabada en la
placa atornillada a la puerta y el QR codifica el identificador, no el código:
renombrar no invalida ni una de las 276 placas. Si lo que quieres es que la placa
diga el nombre nuevo, reimprímela desde `Placas de puerta`.

Los choques se avisan mientras escribes —«ya hay una sala 1.7 en esa planta»—,
pero quien decide es el servidor, que es el único que ve las 276 salas a la vez.
Si lo rechaza, el mensaje que sale es el suyo, tal cual.

### Bajas y papelera

**Dar de baja no siempre es borrar**, y la diferencia la decide el servidor —que
es el único que ve el histórico— y la dice en el mensaje:

| Lo que se da de baja | Qué pasa |
|---|---|
| Sala sin nada | Se borra de verdad, con el equipamiento que le puso el defecto |
| Sala con revisiones, incidencias, inventarios o consumos | Se **archiva**: sale de la lista de trabajo, del buscador y de los dispositivos, y todo lo que se hizo allí se conserva entero |
| Edificio vacío | Se borra de verdad y su código **queda libre** |
| Edificio con salas | Se **archiva** entero: desaparece de la lista de trabajo y de los iPads, con sus salas, sus revisiones y su histórico intactos |

Un edificio archivado **se restaura siempre** desde `Datos → Salas y edificios`,
al final de la sección. Cada uno sale con lo que recupera al lado —«39 salas ·
412 revisiones»— para que «Restaurar» sea una decisión y no una apuesta. Su
código sigue ocupado mientras está ahí: es el que llevan las placas y el
histórico, y reciclarlo mientras el original se puede restaurar sería fabricar
dos edificios «H».

**Archivar un edificio no toca sus salas.** Siguen activas debajo de él, y por
eso salen en `Salas archivadas` marcadas con «Se restaura con su edificio» en
lugar del botón de **Reactivar**: reactivar una sola no la devolvería a ninguna
parte, y el servidor lo rechaza. Restaurar el edificio devuelve exactamente lo
que había, incluidas las aulas que alguien había archivado a mano meses antes —
que siguen archivadas, que es lo correcto. Esas son las que salen con la tercera
frase, «Archivada aparte: se reactiva cuando vuelva su edificio»: ni vuelven con
el edificio ni se pueden reactivar todavía, y decirlo es lo que evita restaurar
un edificio esperando un aula que no va a aparecer.

Fusionar sigue existiendo y es otra cosa: está en `Edificios sin identificar`,
se lleva consigo zonas, salas e incidencias, y es lo que toca cuando el problema
es un **duplicado** —el mismo edificio dos veces con códigos distintos— y no un
edificio que sobra. Un edificio archivado no aparece como destino de una fusión,
y si aun así se pide —la lista puede llevar un minuto de retraso respecto a lo
que otro administrador acaba de archivar— el servidor la rechaza: lo que se
moviera allí desaparecería con él.

En los demás dispositivos esto tarda **hasta dos minutos** en verse, o lo que
tarde el iPad en volver a primer plano o a tener red. No hay que pedirle nada a
nadie.

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

Para lo que no cabe en la pantalla, SQL directo. **Renombrar ya no está aquí**:
hacerlo con un `update` a mano se salta lo que hace la aplicación —dejar el
código viejo de alias— y a partir de ahí las incidencias importadas de esa sala
caen en cuarentena sin que nadie relacione una cosa con la otra. Usa la hoja de
la sala, en el panel o en «Revisar».

```sql
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

### La hoja de inventario, y para qué sirve la del edificio

Se imprime desde la ficha de una sala —**«Inventario en PDF»**— y desde la lista
de salas de un edificio —**«Inventario del edificio»**—, y las dos salen del
navegador con «Imprimir → Guardar como PDF», igual que las placas y, desde que
el módulo de informes vive dentro de la aplicación, igual que el propio informe.

La de una sala es la lista que el técnico se lleva al aula. **La del edificio es
la que contesta a lo que se pregunta desde un despacho** y hasta ahora había que
componer a mano: qué hay en un aulario entero, agrupado por planta y sala en el
orden en que se recorre, con la cabecera diciendo cuántos equipos son y cómo se
reparten —instalados, averiados, de baja, **sin número de serie** y **sin
validar**— y con el desglose por tipo. Los dos recuentos del final son los que
suelen justificar la ronda: sin número de serie no se cursa un parte de
garantía, y sin validar significa que alguien apuntó ese aparato desde un aula y
nadie lo ha confirmado.

Y cada sala lleva impresa **su última fecha de levantamiento**, o «sin levantar»,
que es esta misma sección vista desde el papel: la hoja de un edificio dice de un
vistazo qué aulas no ha confirmado nunca nadie.

Sale de la vista `inventory_sheet`, que —como `room_timeline`— **no guarda nada
nuevo**: lee las tablas que ya existen. Conserva a propósito los equipos de salas
archivadas: archivar limpia la lista de trabajo, no el inventario de lo que hubo
allí.

### Qué significa cada fecha, y de dónde sale

Las tres columnas de la derecha se leen a menudo como si fueran la misma cosa, y
no lo son:

| Columna | De dónde sale | Qué se puede afirmar con ella |
|---|---|---|
| **Alta** | `assets.created_at` | Cuándo apareció esa fila. Puede estar vacía: los equipos que trajo el importador y los que materializó `backfill_room_assets` pueden no traerla, y en la hoja salen con un guion en vez de con una fecha inventada |
| **Último cambio** | `assets.updated_at`, que **escribe el servidor** | Cuándo se modificó por última vez lo que la aplicación sabe del aparato: su marca, su modelo, su número de serie, su etiqueta o su estado. **No** es una visita al aula, y **sale con un guion** mientras nadie haya tocado la ficha |
| **Baja** | El último `asset_events` de tipo `baja` | Cuándo salió de la sala, con el motivo que escribió quien pidió la retirada debajo de la fecha. **A dónde fue** se lee en «último cambio», que dice «Baja» o «Devuelto al almacén»: son dos cosas distintas —el segundo suma una unidad al almacén— y es lo que hace que la hoja con bajas sirva para justificar dónde acabó un equipo |

**«Último cambio» es reloj de servidor, y de ahí viene todo su valor.** La pone el
disparador `assets_updated_at`, nunca el dispositivo. Si la escribiera el
cliente, un iPad con la hora mal —o recién vuelto de otra zona horaria— dejaría
en el inventario equipos modificados antes de darse de alta o el año que viene, y
el papel lo repetiría sin pestañear delante de quien firma. Es la misma
separación que ya hacen `inspections.occurred_at` y `recorded_at`: lo que pasó en
el aula lo fecha quien estaba allí, y lo que le pasa a una fila lo fecha la base.

Tres consecuencias prácticas:

- **La casilla está vacía hasta que alguien toca la ficha.** La columna de la
  base no admite huecos y nace con la fecha del alta, así que la hoja publica esa
  fecha **solo cuando va por delante del alta**: mientras las dos digan lo mismo,
  lo que se imprime es el guion. Es lo correcto y no un fallo — «Modificado», con
  la fecha del alta, sobre un equipo que nadie ha tocado nunca es una afirmación
  falsa, y en el parque importado lo serían las 1.094 líneas.
- **Un UPDATE que no cambia nada no mueve la fecha.** Cada sincronización reenvía
  filas que el dispositivo ya tenía; sin esa comprobación, el inventario entero
  diría que se tocó hoy y la columna no valdría para nada. Así que «último
  cambio» se puede leer como lo que parece: desde cuándo nadie corrige ese
  aparato.
- **Y como es del servidor, una hoja hecha sin cobertura no la trae.** El espejo
  del dispositivo no guarda `updated_at`, ni `asset_events`, ni los equipos
  retirados. Esa hoja sale con un recuadro **«Atención: hoja incompleta»**
  impreso: si te llega una así, **no la archives** — le faltan todas las bajas y
  la columna de último cambio. Se vuelve a imprimir con conexión y ya está
  entera.

Un caso que conviene conocer antes de que alguien pregunte: hay bajas **sin
evento**. Cuando se descarta un equipo con «No está» desde `Equipos sin validar`
y de él ya colgaba algo firmado, el servidor lo retira en vez de borrarlo, y esa
retirada no deja `asset_events` — era una propuesta rechazada, no un aparato que
se muriera. Para esos la hoja aproxima la fecha de baja con `updated_at`, y en
los que ya estaban retirados antes de que esa columna existiera, eso es la fecha
del alta. Es lo único que la base sabe de ellos y se dice tal cual, en lugar de
fabricar una fecha plausible que es justo el dato que se está pidiendo.

```sql
-- Qué equipos siguen sin marca. La columna nació vacía a propósito: el Excel
-- traía marca y modelo pegados dentro de `model` y separarlos por el primer
-- espacio habría fallado en silencio en unos cientos de filas. Se rellena desde
-- el aula, en «Corregir» del equipo.
select building_code,
       count(*) as equipos,
       count(*) filter (where coalesce(brand, '') = '') as sin_marca
from inventory_sheet
where baja_at is null
group by building_code
order by 3 desc;

-- Dónde acabó cada equipo que salió de un edificio, con su destino y su motivo
select room_code, label, model, serial, baja_at, baja_destino, baja_motivo
from inventory_sheet
where building_code = 'H' and baja_at is not null
order by baja_at desc;
```

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

**El informe se hace en la propia aplicación**, en la pestaña **Informes**, que
es de administrador: un informe es un documento que se firma y se archiva, lleva
dentro el reparto del trabajo con nombres, y emitirlo con IA hace pasar la clave
del despliegue por el navegador de quien lo pide. No hay ningún servicio detrás: la pantalla lee los datos, calcula las cifras, le
pide a Gemini que redacte el análisis y compone el documento. Lo único que hay
que configurar —y solo si se quiere el análisis redactado— es la clave de
Gemini, que se pega en esa misma pantalla.

Se elige:

| Qué se elige | Para qué sirve |
|---|---|
| **Periodo** | Semana en curso, semana pasada, mes en curso, mes pasado, ayer, o dos fechas cualesquiera. Debajo se lee qué días va a cubrir antes de pedirlo |
| **Secciones** | Las dieciséis del informe, entre ellas la lista de todas las revisiones hechas y el diario de lo que pasó cada día. «Reparto del trabajo» lleva nombres de personas y por eso hay que marcarla a mano |
| **Cuánto se tarda en cerrar** | La mediana, la media y las cerradas en menos de 48 h. **Se puede desmarcar**: es una cifra que describe bien y justifica mal, y hay reuniones donde no ayuda |
| **Cada cierre, con sus días** | Lo contrario: cada cierre en una línea, con la hora a la que se abrió, la hora a la que se cerró, cuánto llevó escrito entero —«24 días y 2 h», no «24,1»— y qué se hizo. Es lo que sirve para justificar por qué una tardó lo que tardó. Van primero las que más tardaron, que son por las que se pregunta |
| **Fotos del periodo** | Las de las revisiones **y** las de las incidencias, **dentro del propio documento**. No son enlaces: un enlace de Storage caduca en un minuto y el informe se archiva para dentro de un año. Cada una dice de cuándo es —«En la revisión», «Incidencia abierta», «Al resolverla»— y las de una misma incidencia van seguidas, de cómo se encontró a cómo quedó. Entran hasta cuarenta, reducidas al tamaño al que se imprimen —57 mm de ancho, unos 45 KB cada una en vez de 226 KB—, y las que no caben se cuentan al pie |
| **Análisis con IA** | Si se desmarca, el informe sale con el análisis calculado |
| **Escrito para** | Dirección (estado, tendencia y decisiones) o equipo técnico (qué salas tocar y con qué material) |
| **En qué fijarse** | Una instrucción libre para la redacción: «céntrate en el edificio H». No cambia ninguna cifra |
| **Nota en portada** | Un texto que se imprime tal cual bajo el título. No pasa por la IA |

Al pulsar **Generar**, la pantalla va diciendo por dónde va —leyendo los datos,
redactando el análisis, componiendo el documento— y termina enseñando el informe
entero en la propia página. Con IA suele tardar entre veinte segundos y un
minuto; sin ella, unos segundos.

Desde ahí salen dos botones:

- **Descargar PDF** abre el informe en una pestaña y lanza el diálogo de
  imprimir, que es de donde sale el PDF: en el iPad, «Imprimir» y después
  «Compartir → Guardar en Archivos»; en el ordenador, «Guardar como PDF» en el
  destino, en lugar de una impresora. Es el mismo gesto que la hoja de
  inventario y que las placas.
- **Descargar el original** guarda el HTML del que sale ese PDF: un solo fichero
  que se abre en cualquier navegador, sin conexión y sin nada instalado. Es lo
  que conviene guardar para archivar; no es el PDF.

El informe queda además **archivado** en la lista de abajo, y cada entrada lleva
un distintivo con **cómo salió su análisis**:

| Distintivo | Qué pasó |
|---|---|
| **Redactado con IA** (verde) | Se pidió con IA y la IA lo escribió |
| **Análisis calculado** (gris) | Se pidió sin IA. Salió como se quería |
| **La IA falló** (ámbar) | Se pidió con IA, no se pudo, y salió con el análisis calculado. **El motivo se lee en la propia línea** —sin clave, clave sin permiso, cuota agotada— sin abrir el documento |

El ámbar es el que importa: antes esos dos últimos casos ponían lo mismo, así que
una clave caducada podía pasar semanas dando informes peores sin que nada lo
dijera. Los informes emitidos antes de este cambio no guardaron el dato y salen
sin distintivo — de esos no consta.

Mientras se genera, la línea de estado dice **por dónde va la redacción**: «Calculando
las cifras: redactando con *el modelo*…», y si la IA no puede, lo dice en ámbar en
ese momento, no al final. El informe sigue adelante con el análisis calculado.

### Si algo va mal

Ya no hay tubería que diagnosticar: el informe se hace delante de quien lo pide,
así que cuando falla, falla a la vista y con el motivo escrito. Lo que puede
aparecer:

| Lo que dice | Qué significa | Qué hacer |
|---|---|---|
| **No se ha podido leer *algo*** | Una de las consultas no ha llegado: sin conexión, o el perfil no es de administrador | Comprueba la conexión y el rol. El informe no se emite a medias a propósito: una cifra corta sin avisar es peor que ninguna |
| **El análisis ha salido calculado y no redactado por la IA: …** | El informe está bien; lo que ha fallado es la redacción. El motivo va en la misma frase (sin clave, clave sin permiso, cuota agotada) | Si es la clave, se arregla en la tarjeta de arriba de esa misma pantalla |
| **El informe está hecho, pero no se ha podido guardar…** | El documento existe y se puede imprimir, pero no ha entrado en el archivo. Suele ser que falta la migración `20260821000100_informes_en_el_navegador.sql` | Descárgalo para no perderlo y aplica las migraciones pendientes |
| **El navegador ha bloqueado la ventana del informe** | «Descargar PDF» abre una pestaña, y el navegador la trata como emergente | Permite las ventanas emergentes de esta dirección, o usa «Descargar el original» |
| **Un edificio sale con «· archivado» y un guion en «Salas»** | No es un fallo: ese edificio está en la papelera, así que no tiene aulas en la lista de trabajo, pero durante el periodo se trabajó en él y eso se cuenta igual | Nada, salvo que no debiera estar archivado: se restaura desde **Datos → papelera** |

#### Cuando faltan datos de un edificio en el histórico

Renombrar un edificio **no pierde nada**: `rename_building` cambia el código y el
nombre de la misma fila, y las revisiones y las incidencias cuelgan de la sala,
no del texto. Si al renombrar CRAI a T. Moro parece que se ha perdido el
histórico, lo que ha pasado es otra cosa, y son dos:

1. **El edificio (o sus aulas) está archivado.** Hasta este cambio, el informe
   leía las salas de `room_overview` —que es la lista de trabajo y filtra lo
   archivado— y dejaba caer en silencio todo lo que pasó en ellas: no salían en
   el reparto por edificio, ni en el diario, ni en la lista de cierres, aunque
   los totales de arriba sí las contaran. Ahora salen, marcadas, y el pie del
   informe dice cuántas salas del periodo ya no están en la lista de trabajo.
2. **Se creó un edificio nuevo en vez de renombrar el que había.** Entonces hay
   dos: el viejo con todo el histórico y el nuevo con aulas recién creadas, que
   por eso aparecen como no revisadas. Eso no lo arregla el informe, porque no
   hay nada que arreglar en él: son dos edificios distintos y cada uno tiene lo
   suyo.

   Hoy la aplicación **no** puede unirlos desde el panel: la fusión de edificios
   existe (`merge_building`) pero la pantalla de Datos solo la ofrece para los
   edificios provisionales que dejó la importación, no para dos que se crearon a
   mano. Y aunque se llame a la función directamente, si las mismas aulas están
   duplicadas en los dos —dos «1.7»— la fusión se rechaza por el índice único de
   la planta. Hace falta decidir aula por aula cuál se queda.

Para distinguir un caso del otro, mira en **Datos**: si aparece un CRAI en la
papelera, es el primero —y este cambio ya lo arregla—; si aparece un CRAI
**activo** con aulas, al lado de un T. Moro también activo, es el segundo.

**Un informe emitido no se regenera nunca: se versiona.** Si los datos cambian
después, el documento del viernes sigue diciendo lo que decía el viernes. Es lo
que le da valor como registro.

Si en el archivo aparecen informes emitidos solos los viernes, es que el
despliegue tiene además el worker antiguo y su `pg_cron`. Sigue funcionando y no
estorba; no hace falta para nada de lo de arriba.

### El análisis con IA

Lo que hay que tener claro antes de activarlo:

> **Las cifras las calcula el sistema. La IA solo escribe el texto.**

Ni un número del informe sale del modelo. Si en su redacción aparece una cifra de
tres dígitos que no está en los datos —o dos fórmulas de las que delatan a un
texto generado— se tira el texto entero y se emite con el análisis calculado.

**El documento no dice en ninguna parte que se haya usado IA.** Es un documento
del servicio que habla del estado del campus, y va limpio. Si necesitas saber
cómo se redactó un informe concreto, está en la pantalla de Informes: cada
entrada del archivo lleva su distintivo.

La tarjeta de arriba de esa pantalla resume lo mismo para el **último** informe.
Si pidió IA y no la tuvo, se pone en rojo con el motivo y la fecha, ahí mismo
donde se cambia la clave. Eso necesita aplicada la migración
`20260825000100_el_archivo_dice_si_la_ia_fallo.sql`; sin ella la tarjeta sigue
funcionando como antes, pero no distingue el fallo.

**Sin clave, el informe sale igual.** El análisis lo escriben las reglas del
sistema: es un texto completo, con su párrafo de entrada y su lista de cosas que
hacer, no un hueco con un aviso.

Para activarlo hace falta una clave de
[Google AI Studio](https://aistudio.google.com/apikey) —es de pago por uso; un
informe semanal cuesta céntimos— y pegarla en Informes → «Poner la clave de
Gemini». Ahí se elige entre dos botones:

- **Guardar para todo el equipo** la deja en la configuración del despliegue. Es
  lo normal: se pone una vez y la usa cualquier administrador desde cualquier
  dispositivo.
- **Guardar solo aquí** la deja únicamente en ese navegador. Es la salida si
  prefieres que no haya ninguna clave guardada en la base.

No hay que tocar ningún fichero ni reiniciar nada. La clave no se muestra nunca,
ni recortada: la pantalla solo dice si hay una guardada.

Una cosa que conviene saber, porque es un cambio respecto a versiones
anteriores: al generarse el informe en el navegador, **la clave guardada para el
equipo llega al navegador de cualquier administrador** cuando pide un informe
con IA. Antes vivía solo en el servidor porque era el servidor quien llamaba a
Google. Ni un técnico ni un supervisor la ven —la función que la devuelve exige
administrador—, pero si en tu despliegue eso no es aceptable, la salida es no
guardar ninguna clave para el equipo y que cada administrador use «Guardar solo
aquí».

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
