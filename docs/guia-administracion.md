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
| `admin` | Además: editar edificios y salas, gestionar usuarios, pestaña Datos |

Un cambio de rol tarda hasta una hora en aplicarse, o es inmediato si la persona
cierra y vuelve a entrar con su PIN. El rol viaja dentro del token.

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

### Tres dispositivos por persona

Cada persona puede tener la aplicación en hasta tres aparatos. El primero se da
de alta con un código; **el segundo y el tercero, no**: en la pantalla de entrada
se elige «Con mi PIN», se escribe el correo y el PIN de siempre, y ya está. No
hace falta llamar a nadie.

Cada uno ve los suyos en **Mi cuenta** —la chapa del rol, arriba a la izquierda—
y puede revocar el que sobre. Desde la terminal, para verlos o retirarlos por
alguien:

```bash
npm run admin:user -- dispositivos ana@x.es     # cuáles, y cuántos huecos quedan
npm run admin:user -- revocar <id-del-aparato>  # retira uno
npm run admin:user -- revocar ana@x.es --todos  # retira todos los suyos
```

El tope está en `app_config.max_dispositivos` y se cambia sin desplegar:

```sql
update app_config set value = '4' where key = 'max_dispositivos';
```

### Un dispositivo perdido

Con `VITE_LOCK_AFTER_MINUTES=0` la sesión no caduca, así que **si se perdió con
la sesión abierta, quien lo encuentre puede usar la aplicación**. Actúa deprisa:

```sql
-- 1. Cortar el acceso de esa persona a todo, ahora mismo
update profiles set active = false where email = 'ana@x.es';
```

```bash
# 2. Retirar el aparato, con su nombre y su fecha en el registro
npm run admin:user -- revocar ana@x.es --todos
```

El paso 1 es el que corta de verdad: sin perfil activo el hook deja de dar rol y
RLS no permite ver nada, en cuanto caduque el token de acceso (una hora como
mucho). Revocar es el registro y el cierre del dispositivo —borra su sesión
guardada la próxima vez que abra con línea— pero **no una expulsión inmediata**:
su refresh token sigue valiendo para GoTrue hasta que caduque.

Después, para devolverle el acceso desde otro dispositivo:

```sql
update profiles set active = true where email = 'ana@x.es';   -- reactivar
```

```bash
npm run admin:user -- codigo ana@x.es                         -- código nuevo
```

**Si además se teme por el PIN**, el código nuevo es obligatorio y no opcional:
rota la contraseña de la cuenta, con lo que el sobre cifrado que abría el PIN
deja de servir para dar de alta nada. Hasta que alguien use ese código, la opción
«Con mi PIN» de esa cuenta dice que la vinculación está en pausa y pide el
código. Los dispositivos que siguen en manos de su dueño no se enteran.

Si el dispositivo se perdió **con la sesión cerrada**, no hay urgencia: sin el
PIN los datos guardados son ilegibles.

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

Solo se puede declarar con equipos del **catálogo confirmado**. Si se pudiera
escribir un nombre suelto, esto sería la vía más rápida de meter un duplicado en
276 aulas de una vez.

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
- **No está** — lo retira del inventario. Deja de contar en la sala y se queda
  en su histórico, que es donde tiene que quedarse.

Lo que carga una máquina —el importador, el equipamiento por defecto— nace
validado: no es la propuesta de nadie que haya estado en el aula.

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

### Modelos sin validar — ¿de qué marca y modelo es?

`Inventario → Catálogo`, y es la bandeja que más trabajo tiene el primer día: el
Excel traía el modelo en una casilla de texto libre, sin marca, y de ahí salen
cincuenta y cinco modelos deducidos con duplicados dentro.

```
ME403U   ·   ME-403U   ·   ME403U *          ← el mismo proyector, tres veces
EB-992F  ·  EB-992F EEB  ·  EB-992 F EEB     ← y otra vez
NO  ·  NET  ·  *****                          ← lo que alguien escribió en su día
```

La pantalla abre con **los grupos que casi seguro son el mismo modelo** —los que
solo cambian en guiones, espacios o asteriscos— porque encontrarlos a ojo en una
lista de cincuenta es exactamente el trabajo que nadie hace.

| | Cuándo | Qué hace |
|---|---|---|
| **Validar** | El modelo existe y se llama así | Deja de salir en naranja |
| **Corregir** | Le falta la marca, o el nombre está mal | Guarda marca y modelo, deja el nombre viejo de alias y lo da por validado |
| **Fusionar** | Es el mismo que otro | Mueve sus equipos al bueno y deja lápida con su nombre de alias |
| **Retirar** | Descatalogado | Deja de ofrecerse. Los equipos que lo llevan lo conservan |

Fusionar y retirar **se confirman con el alcance delante** —cuántos equipos se
mueven— y por encima de diez equipos hay que teclear la palabra: son operaciones
que la aplicación no sabe deshacer.

Ponerle la marca a los cincuenta y cinco modelos es un rato; asignar el modelo a
los 1.094 equipos, no: `Inventario → Equipos`, se filtra por tipo y edificio, se
seleccionan los que son iguales y se les pone el modelo de una vez. Esa pantalla
también exporta a CSV lo que se esté viendo, que es lo que permite cruzarlo con
una factura o con el listado del proveedor.

```sql
-- Qué queda por hacer
select count(*) filter (where asset_model_id is null) as sin_modelo,
       count(*) filter (where installed_at is null)   as sin_fecha,
       count(*) as total
  from assets where status <> 'retirado';

-- Los modelos, con cuántos equipos lleva cada uno
select t.name as tipo, coalesce(nullif(m.brand,''),'(sin marca)') as marca,
       m.model, count(a.id) as equipos, m.confirmed
  from asset_models m
  join asset_types t on t.id = m.asset_type_id
  left join assets a on a.asset_model_id = m.id
 where m.merged_into is null
 group by 1,2,3,5 order by 4 desc;
```

Todo cambio en `rooms`, `buildings`, `stock_items`, `assets`, `asset_types`,
`asset_models`, `devices`, `incidents` y `profiles` **queda auditado** con autor y
valores anterior y posterior:

```sql
select at, by_user, old_data->>'name', new_data->>'name'
from audit_log where table_name = 'rooms' order by at desc limit 20;
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

Se emiten solos: **diario a las 07:00** y **semanal los lunes a las 07:30**.
Quedan archivados en la pestaña **Informes**, con descarga.

Para uno a medida, elige rango de fechas y pulsa Generar.

**Un informe emitido no se regenera nunca: se versiona.** Si los datos cambian
después, el PDF del lunes sigue diciendo lo que decía el lunes. Es lo que le da
valor como registro.

## 9. Ajustes que quizá quieras cambiar

Se tocan en el `.env` y requieren reconstruir la aplicación (`npm run build`),
porque se compilan dentro:

| Variable | Por defecto | Qué hace |
|---|---|---|
| `VITE_LOCK_AFTER_MINUTES` | `0` | Inactividad antes de volver a pedir el PIN. **0 = nunca**: la sesión dura hasta que el técnico pulsa «Cerrar sesión». Pon `480` (una jornada) si los dispositivos se comparten entre turnos o salen del campus |

En base de datos, sin reconstruir nada:

```sql
-- Cambiar la hora de los informes
select cron.unschedule('informe-diario');
select cron.schedule('informe-diario', '0 6 * * *',
                     $$select public.request_report('diario')$$);
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
where recorded_at - occurred_at > interval '1 hour';
```

Si crece mucho, hay zonas del campus donde los técnicos trabajan sin red más de
lo previsto.
