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
npm run admin:user -- crear  --email ana@x.es --nombre "Ana Ruiz" --rol tecnico
npm run admin:user -- codigo --email ana@x.es
npm run admin:user -- rol    --email ana@x.es --rol supervisor
```

**El código solo se muestra una vez.** Si se pierde, genera otro con `codigo`.

### Si el despliegue está sobre una plataforma (Skyway, Railway, Fly…)

Ahí no hay repositorio ni `npm`: la imagen del servicio es Caddy sirviendo la
PWA ya compilada, y por eso `npm run admin:user …` responde `sh: npm: not
found`. Las mismas órdenes viajan dentro de la imagen como `alta`, y se
escriben en la terminal del servicio, desde el panel:

```bash
alta listar
alta crear  --email ana@x.es --nombre "Ana Ruiz" --rol tecnico
alta codigo --email ana@x.es
alta rol    --email ana@x.es --rol supervisor
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

```bash
npm run admin:user -- rol --email ana@x.es --rol tecnico   # reactivar
npm run admin:user -- codigo --email ana@x.es              # código nuevo
```

Si el dispositivo se perdió **con la sesión cerrada**, no hay urgencia: sin el
PIN los datos guardados son ilegibles.

## 3. Editar edificios, salas y equipamiento

Un `admin` puede editarlo desde la aplicación. Para cambios en lote, SQL directo:

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

-- Dar de baja una sala sin borrar su historial
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

Un técnico puede **dar de alta un tipo desde el aula**. Entra sin confirmar, sale
en naranja y **se usa igual**: bloquear la revisión hasta que alguien apruebe un
nombre es el camino más corto a que el equipo deje de apuntar lo que encuentra.

La contrapartida está en **Datos → Equipos sin validar**, y tiene tres salidas.
Ninguna es borrar: lo que alguien apuntó porque lo tenía delante existe.

| | Cuándo | Qué hace |
|---|---|---|
| **Confirmar** | Era un tipo nuevo legítimo | Deja de salir en naranja |
| **Corregir nombre** | Estaba bien pero mal escrito | Renombra y **guarda el nombre viejo como alias**, así quien lo teclee mañana encuentra este |
| **Fusionar** | Ya existía con otra palabra | Mueve los equipos al tipo bueno y el nombre absorbido pasa a ser alias suyo |

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

## 4. Almacén

Desde la pestaña **Almacén**, con `+` y `−` por artículo.

**Las existencias no son un campo editable: son la suma de los movimientos.**
Por eso no puede repetirse el descuadre del Excel, que llegó a tener stock
negativo. Para corregir un recuento físico, registra un ajuste:

```sql
insert into stock_movements (id, stock_item_id, qty, kind, occurred_at, note)
select gen_random_uuid(), id, 12, 'ajuste', now(), 'Recuento físico de julio'
from stock_items where name = 'Cable HDMI Fibra 15 mts';
```

### Umbrales de aviso

Ningún artículo avisa por defecto: **no se puede estar por debajo de un mínimo
que nadie ha fijado**. Actívalos donde importe:

```sql
update stock_items set min_threshold = 5
where name in ('Lámpara Proyector NP44', 'Cable HDMI Fibra 15 mts');
```

Los artículos por debajo salen en rojo y en el panel.

## 5. Informes

Se emiten solos: **diario a las 07:00** y **semanal los lunes a las 07:30**.
Quedan archivados en la pestaña **Informes**, con descarga.

Para uno a medida, elige rango de fechas y pulsa Generar.

**Un informe emitido no se regenera nunca: se versiona.** Si los datos cambian
después, el PDF del lunes sigue diciendo lo que decía el lunes. Es lo que le da
valor como registro.

## 6. Ajustes que quizá quieras cambiar

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

## 7. Comprobaciones periódicas

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
