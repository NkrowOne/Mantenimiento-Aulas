# Permisos para sincronizar con SharePoint, y qué pedirle a IT

Qué acceso necesita exactamente la sincronización de los dos libros, con el mínimo
privilegio posible, y el correo que hay que mandarle a IT de la universidad. El diseño
de la sincronización está en [`sincronizacion-sharepoint.md`](sincronizacion-sharepoint.md);
esto es la parte que depende de que otra persona conceda algo.

Todo lo de aquí está contrastado contra `learn.microsoft.com`. Lo que no se ha podido
confirmar está en el apartado 7, dicho como lo que es.

---

## 0. Antes de leer nada de esto: puede que no haga falta

Todo este documento trata de **automatizar el transporte** del fichero. Si el libro se
sube a mano a la aplicación y se descarga ya parcheado —la opción 0 del apartado 5 del
[documento de diseño](sincronizacion-sharepoint.md)—, **no hace falta nada de lo que
viene aquí**: ni registro de aplicación, ni consentimiento, ni `Sites.Selected`, ni
certificado. La sincronización funciona igual; lo que la dispara es una persona.

Sigue leyendo si se quiere automatizar ese viaje.

---

## 1. El problema que hay que mirar antes de pedir nada

**La documentación de Microsoft dice que la API de libro de Excel no admite permisos de
aplicación.** Todas las páginas de referencia v1.0 que necesitamos —`workbook: createSession`,
`Update range`, `Create TableRow`, `Worksheet: Range`, `List worksheets`, `List tables`—
declaran literalmente `Application | Not supported.`, y el único permiso que documentan es
el **delegado** `Files.ReadWrite`. La página general de Excel en Graph, en su sección
«Authorization and scopes», solo lista `Files.Read` y `Files.ReadWrite`.

Eso choca de frente con lo que necesita este proyecto: un proceso desatendido, sin nadie
delante que inicie sesión, escribiendo celdas concretas. Hay informes de que funciona con
token app-only, pero están en hilos de Microsoft Q&A —uno marcado como generado por IA—,
que no son documentación. Tampoco figura como incidencia conocida.

Así que el orden correcto no es «pedir permisos y luego programar», sino al revés:

> **Paso 0: probarlo en un sitio de pruebas antes de pedir nada en producción.**

Y cuando se pida, decirle a IT que esa parte se apoya en un comportamiento que la
documentación de Microsoft no respalda. Es su decisión saberlo.

### La prueba de concepto

Pídele a IT un **sitio de SharePoint desechable** y un **registro de aplicación de
pruebas** con `Sites.Selected` y rol `write` sobre ese sitio — exactamente la misma
petición que la definitiva, en un entorno que no importa. Con un token app-only
(`client_credentials`, `scope=https://graph.microsoft.com/.default`), en este orden:

```
1. GET   /drives/{driveId}/items/{itemId}/workbook/worksheets
2. POST  /drives/{driveId}/items/{itemId}/workbook/createSession   {"persistChanges": true}
3. PATCH /drives/{driveId}/items/{itemId}/workbook/worksheets/{hoja}/range(address='A1:B2')
         {"values": [[...]]}      ← sobre una hoja CON fórmulas reales
4. POST  /drives/{driveId}/items/{itemId}/workbook/tables/{tabla}/rows
5. GET   /drives/{driveId}/root/delta?token=latest
   GET   /drives/{driveId}/items/{itemId}   con cabecera if-none-match
```

Si (1)–(4) devuelven 200/201, la vía principal es viable y el riesgo que queda es «no
documentado, Microsoft puede cerrarlo sin aviso». Si devuelven `accessDenied`,
`EditModeAccessDenied` o `FileOpenUserUnauthorized`, la escritura celda a celda con
app-only está muerta y hay que ir al apartado 6.

Dos detalles de ruta que la prueba ya deja fijados:

- Usa **`/drives/{driveId}/items/{itemId}/workbook/...`**, que sí aparece en los ejemplos
  oficiales de SDK. La ruta `/sites/{siteId}/drive/items/{itemId}/workbook/...` no está
  documentada en ninguna página de Excel.
- **`Files.ReadWrite` delegado, sin `.All`, no vale como plan B fácil**: su descripción es
  «los ficheros del usuario que ha iniciado sesión», es decir su OneDrive. Nada confirma
  que alcance un `.xlsx` de una biblioteca de un sitio ajeno.

---

## 2. Lo que se pide: un permiso, un sitio, un rol

**App-only con certificado + `Sites.Selected` de Microsoft Graph + rol `write` sobre un
sitio dedicado** al que se mueven los dos libros.

Por qué esta y no otra:

- Es la única que cumple las cuatro condiciones a la vez: proceso desatendido, escritura
  celda a celda, mínimo privilegio demostrable y **solo tráfico HTTPS saliente** — que es
  lo que permite este despliegue, detrás de VPN y sin entrada desde Internet.
- **`Sites.Selected` por sí solo no da acceso a nada.** Es su gracia: una aplicación con
  ese permiso concedido «inicialmente no tendría acceso» a ningún sitio. Hacen falta tres
  pasos —consentimiento, concesión sobre el sitio concreto, y token con ese ámbito— y si
  falta cualquiera de los tres, la aplicación no entra. Ese es el argumento que hace que
  IT lo apruebe.
- **No rompe la herencia de permisos.** Conceder a nivel de colección de sitios no la
  rompe, porque es la raíz de la herencia. Permisionar por debajo sí la rompe y consume
  ámbitos de seguridad únicos.
- **Es revocable en caliente**, sin tocar el consentimiento: un `DELETE` sobre la
  concesión y se acabó.
- No depende del identificador de cada fichero: si alguien borra un `.xlsx` y sube otro
  con el mismo nombre, la sincronización sigue. Con concesión fichero a fichero, no.

**Certificado, no secreto de cliente.** Microsoft: «Client secrets are less secure than
certificate or federated credentials and therefore should not be used in production
environments». Las credenciales federadas no aplican aquí: los escenarios documentados
(GitHub Actions, Kubernetes, «Other issuer») exigen un emisor OIDC alcanzable por Entra,
o sea publicado hacia Internet — justo lo que no hay. La identidad administrada tampoco
existe fuera de Azure.

---

## 3. La petición literal a IT

Copiable en un correo.

> **Asunto: Solicitud de permisos acotados en Microsoft Entra ID / SharePoint Online para
> la sincronización de Mantenimiento de Aulas**
>
> Necesitamos que un proceso servidor desatendido lea y escriba celdas concretas de dos
> ficheros `.xlsx` alojados en SharePoint Online. El proceso corre on-premise detrás de la
> VPN, solo hace tráfico HTTPS **saliente** y no expone ninguna URL. Pedimos el mínimo
> privilegio posible; concretamente:
>
> **1) Registro de aplicación**
> Crear un registro dedicado en Microsoft Entra ID, «Mantenimiento-Aulas — sincronización
> SharePoint», **sin URI de redirección** (no hay flujo interactivo). Necesitamos el
> *Application (client) ID* y el *Directory (tenant) ID*.
>
> **2) Credencial**
> Subir un **certificado** en «Certificates & secrets → Certificates → Upload certificate»
> y facilitarnos el *Thumbprint*. **No** queremos secreto de cliente: Microsoft desaconseja
> los secretos en producción. Indicadnos la fecha de caducidad y si el tenant tiene
> *application management policies* que limiten la vida de los certificados.
>
> **3) Un único permiso de aplicación, con consentimiento de administrador**
> API: **Microsoft Graph** → **Application permissions** → **`Sites.Selected`**
> Identificador del rol de aplicación: `883ea226-0bf2-4a8f-9f9d-92c9162a727d`
> *Admin consent required: Yes.*
> **Importante:** hay dos permisos llamados `Sites.Selected`, uno en Microsoft Graph y otro
> en el API «Office 365 SharePoint Online». Necesitamos **el de Microsoft Graph**.
> Al ser un *app role* de Graph, el consentimiento no lo puede otorgar un *Application
> Administrator* ni un *Cloud Application Administrator*: hace falta **Privileged Role
> Administrator** (o Global Administrator), o un rol personalizado con el permiso de
> conceder permisos a aplicaciones.
> Tras este paso la aplicación **sigue sin acceso a nada**, y es intencionado.
>
> **4) Concesión explícita sobre UN solo sitio**
> Pedimos crear un sitio de SharePoint **dedicado** (p. ej. `/sites/mantenimiento-aulas`)
> donde alojaremos únicamente los dos `.xlsx`, y conceder a la aplicación el rol `write`
> **solo sobre ese sitio**. Lo ejecuta una persona con rol **SharePoint Administrator o
> superior** desde su propia sesión (Graph Explorer vale):
>
> ```http
> POST https://graph.microsoft.com/v1.0/sites/{siteId}/permissions
> Content-Type: application/json
>
> {
>   "roles": ["write"],
>   "grantedToIdentities": [
>     { "application": { "id": "{client-id}", "displayName": "Mantenimiento-Aulas" } }
>   ]
> }
> ```
>
> El `{siteId}` tiene el formato `host,siteCollectionId,webId` y se obtiene con
> `GET /sites/{hostname}:/sites/{ruta-del-sitio}`. La respuesta es `201 Created`;
> **guardad el campo `id`**: es lo que permite auditar, degradar o revocar después.
> Equivalente en PowerShell: `Grant-PnPAzureADAppSitePermission -AppId {client-id}
> -DisplayName "Mantenimiento-Aulas" -Permissions Write -Site {url-del-sitio}` (PnP es
> open source y sin SLA de soporte de Microsoft; la vía Graph de arriba es oficial).
> `write` es «Read and modify the metadata and contents of the resource»: el rol mínimo
> que permite escribir. **No pedimos `owner`, `manage` ni `fullcontrol`.**
>
> **5) Control y reversibilidad, para vuestro registro**
> - Auditar quién tiene acceso: `GET /sites/{siteId}/permissions`
> - Degradar a solo lectura sin revocar: `PATCH /sites/{siteId}/permissions/{id}` con
>   `{"roles": ["read"]}`
> - Revocar el acceso al sitio: `DELETE /sites/{siteId}/permissions/{id}`
> - Corte total: revocar el consentimiento de `Sites.Selected` en Entra ID. El acceso se
>   pierde en cuanto se revoca el ámbito.

---

## 4. Lo que NO se pide

Esto va en el correo: es la mitad que hace que se apruebe.

| Permiso que **no** se solicita | Identificador del rol |
|---|---|
| `Sites.Read.All` | — |
| `Sites.ReadWrite.All` | `9492366f-7969-46a4-8d15-ed1a20078fff` |
| `Sites.Manage.All` | — |
| `Sites.FullControl.All` | `a82116e5-55eb-4c41-a434-62fe8a61c773` |
| `Files.Read.All` | — |
| `Files.ReadWrite.All` | `75359482-378d-4052-8f01-80520e7db3cd` |
| `User.Read.All` y cualquier permiso de correo, calendario o directorio | — |

Tampoco se pide registro por `appregnew.aspx` / `appinv.aspx` ni principal de Azure ACS:
**ACS está retirado desde el 2 de abril de 2026**, sin prórroga, junto con los
SharePoint Add-Ins.

`Sites.FullControl.All` aparece en esta propuesta **solo** como el privilegio que la
persona de IT ejerce una vez para crear la concesión. La aplicación no lo tiene en ningún
momento.

Una precisión que conviene hacer bien: `Sites.Selected` **no concede nada sobre el
directorio de Entra ID** —ni usuarios, ni grupos, ni correo, ni calendario—. Su alcance es
contenido de SharePoint y OneDrive, y solo el de los sitios con concesión explícita. Lo
que **no** hay que decir es «no ve datos de usuarios»: si dentro de ese sitio hay datos
personales, la aplicación los verá con el rol concedido. Por eso el sitio tiene que ser
dedicado y contener solo los dos libros.

Y una regla interna: **no añadir nunca un ámbito `.All` «por si acaso»** a ese mismo
registro. Todos los ámbitos del token se honran, así que uno solo anula todo el trabajo de
acotación.

---

## 5. Si IT no autoriza dar acceso a un sitio entero

**`Files.SelectedOperations.Selected` (aplicación) + rol `write` concedido fichero a
fichero.** Es el grano más fino que existe: «Manages application access at the file or
library folder level». Está en la referencia v1.0 y no lleva marca de preview.

```http
POST https://graph.microsoft.com/v1.0/drives/{driveId}/items/{itemId}/permissions
{ "grantedToV2": { "application": { "id": "{clientId}", "displayName": "..." } },
  "roles": ["write"] }
```

Ojo: **este endpoint solo acepta `grantedToV2`**, no `grantedToIdentities` — al revés que
el de sitio. Y dos contras que hay que decirle a IT: rompe la herencia de permisos en cada
fichero, y la concesión está atada al identificador del elemento, así que si alguien
reemplaza un `.xlsx` (borrar y volver a subir) la sincronización se cae hasta que un
administrador rehaga la concesión.

---

## 6. Si la prueba del paso 0 falla

Es un caso distinto de «IT dice que no», y ninguna salida es gratis:

- **(a) Cuenta de servicio con permisos delegados.** Un usuario de M365 real al que solo se
  le da acceso a esa carpeta, con login interactivo inicial y un `refresh_token` guardado
  en el servidor. Microsoft lo desaconseja expresamente («We do not recommend user accounts
  as service accounts because they are less secure») y para «servicio no alojado en Azure»
  marca *service principal: recomendado* y *cuenta de usuario: no recomendado*. Además el
  refresh token **no está acotado al recurso**, sobrevive hasta 90 días de inactividad pero
  muere ante cambio de contraseña, revocación de administrador o eventos de Continuous
  Access Evaluation —y SharePoint Online suscribe justo esos—. ROPC está deprecado y el
  device code flow está desaconsejado y bloqueado en muchos tenants universitarios.
- **(b) Descargar, editar y volver a subir el fichero.** Con `Sites.Selected` + `write`
  basta y **sí está documentado**. Pero contradice la regla de conservar fórmulas y
  formato, que es medio proyecto.
- **(c) Migrar los dos libros a listas de SharePoint.** Lo más limpio a medio plazo —delta
  nativo por elemento, versionado por elemento, `if-match`/412 para concurrencia—, pero
  implica rediseñar el modelo de datos, y su permiso más acotado
  (`Lists.SelectedOperations.Selected`) es precisamente el peor documentado.

---

## 7. Lo que queda sin confirmar

Dicho tal cual, porque es lo que decide si el proyecto sale:

1. **Que `/workbook/...` funcione con token app-only.** Ninguna página normativa lo
   confirma; todas dicen lo contrario. **Es el riesgo número uno.**
2. **Que `Sites.Selected` sea aceptado por los endpoints que vamos a usar.** No aparece en
   la tabla de permisos de `driveItem: delta`, ni de `Get driveItem`, ni de `List versions`
   —que en app-only solo documentan `Files.Read.All` y superiores—, ni en las páginas de
   Excel. Sí aparece en `driveitem-post-permissions`. Hay una desincronización real entre
   el documento conceptual de *Selected permissions* y las tablas de referencia; la prueba
   del paso 0 tiene que cubrirla.
3. **Roles con dos nombres**: `read/write/owner/fullcontrol` en un documento y
   `read/write/manage/fullcontrol` en otro. Coinciden en `write`, que es el que pedimos, y
   con la misma definición. La página `site-post-permissions` no tiene fila «Application»
   (duplica la de «Delegated») pero sí dice que en flujo delegado hace falta SharePoint
   Administrator o superior, que es la vía que pedimos.
4. **Formato condicional**: no hay documentación sobre si la API de libro lo preserva al
   escribir. En Graph no existe recurso de formato condicional; el concepto solo vive en
   Office.js y Office Scripts, que son otra plataforma. **Hay que probarlo sobre los dos
   libros reales**, que tienen cuatro.
5. **Hojas y celdas protegidas**: no está documentado si una escritura de Graph sobre una
   hoja protegida falla, se ignora o la sortea. Sí está confirmado que `accessDenied` cubre
   «performing changes to locked cells», y que `worksheetProtection: protect`/`unprotect`
   son `Application: Not supported` — o sea que **un worker app-only no puede hacer el
   ciclo desproteger → escribir → proteger**. Y `workbookWorksheetProtectionOptions` tiene
   once propiedades y **ninguna es `allowEditRanges`**. Esto cambia el diseño: ver el
   apartado 8.
6. **Tamaño máximo de fichero**: Microsoft no publica cifra, solo los códigos
   `unsupportedWorkbook` e `invalidSessionUnsupportedWorkbook` («exceeds the size limit»).
   No presentar los 100 MB de Excel para la web como si fueran el límite de la API.
7. **Auditoría**: el esquema de auditoría de SharePoint incluye `ApplicationId` y
   `ApplicationDisplayName`, y `UserId` puede aparecer como `app@sharepoint`. Pero no hay
   documento que garantice que las acciones bajo `Sites.Selected` queden registradas con el
   `clientId` de la aplicación. **Verificarlo en el piloto** —escritura de prueba →
   Microsoft Purview → búsqueda de auditoría → exportar → comprobar `AuditData`— antes de
   vendérselo a IT como control de cumplimiento.
8. **Romper la herencia por debajo del sitio**: si se concede a nivel de sitio y luego
   alguien rompe la herencia en una biblioteca, no hay documentación sobre si la entrada de
   la aplicación se copia al nuevo ámbito ni si puede quitarse de ahí. Si IT quiere esa
   exclusión selectiva, hay que probarla antes de prometerla.

**Nada de lo que se pide está en preview ni deprecado**: `Sites.Selected` y los
`*.SelectedOperations.Selected` están en la referencia v1.0 sin marca. Matiz honesto: no
existe una entrada de changelog que declare formalmente su disponibilidad general; es lo
que se ve en la referencia.

Dependen de cómo tenga configurado el tenant la universidad: las políticas de
consentimiento pueden restringirlo aunque el permiso no lo exija; las *application
management policies* pueden acortar la vida del certificado; las políticas de acceso
condicional rompen la vía delegada (no la app-only); y el presupuesto de unidades de
recurso se comparte con las demás aplicaciones del tenant, así que una herramienta de
copia de seguridad o de DLP ajena puede provocarnos throttling.

---

## 8. Lo que esto cambia en el diseño

Tres cosas del documento de diseño quedan corregidas por lo verificado aquí:

**La protección de hoja no sirve de control.** Se había previsto bloquear las columnas
propias de la aplicación para que nadie las editara. Pero esas son exactamente las celdas
que el worker escribe, `accessDenied` cubre «cambios en celdas bloqueadas», y app-only no
puede desproteger. Así que el control no es la protección: es que **la aplicación
reescribe esa columna en la pasada siguiente y lo deja dicho en la hoja `Sincronización`**.
Fondo gris y una nota en la cabecera, sí; candado, no —salvo que la prueba del paso 0
demuestre que la escritura app-only pasa por encima de la protección.

**Se compara `cTag`, no `eTag`.** `cTag` es «un eTag del contenido del elemento… no cambia
si solo cambian los metadatos». Renombrar el fichero, tocar una columna de biblioteca o
aplicar una etiqueta de retención cambia el `eTag` y no debe disparar una
resincronización. Detalle: delta omite `ctag` en operaciones de creación y modificación en
OneDrive for Business, así que delta sirve de disparador barato y el `cTag` se lee después
con un `GET` del elemento. Y **tras cada escritura propia hay que releer y guardar el
`cTag` resultante**, o el worker se resincroniza consigo mismo en bucle.

**Y los webhooks quedan descartados por partida doble**, no solo por la falta de URL
pública: no se puede suscribir un fichero suelto —«You can't subscribe to drive or
driveItem instances that aren't folders»— y la latencia máxima documentada para
`driveItem` es de **seis horas**. Un sondeo cada media hora es más rápido en el peor caso.

---

## 9. Reglas de escritura que salen de la documentación

Van en el código, no en el correo. Cada una evita un destrozo concreto:

- **Leer antes de escribir.** Un `GET .../range(address='A1:Z10')` devuelve en la misma
  respuesta `values`, `formulas`, `numberFormat`, `text` y `valueTypes`.
- **Las fórmulas se detectan mirando `formulas`** —cadena que empieza por `=`—, nunca
  `valueTypes`: ese campo describe el tipo del *resultado*, no si hay fórmula.
- **`null` en el array 2-D significa «ignora esta celda»**: «The `null` input is to
  instruct the API to ignore the cell for that particular input». Es la única defensa
  documentada para no pisar fórmulas ni formato al escribir un rango.
- **`""` no es «no tocar»: es BORRAR.** Vacía el valor, pone el formato en `General` y
  borra la fórmula. Un `?? ''` mal puesto en Node vacía celdas de producción.
- **Una sola celda contra un rango mayor se replica** por todo el rango, como un
  CTRL+Enter. Un error construyendo el payload rellena cientos de celdas con el mismo dato.
- Si alguna vez se escriben fórmulas a propósito, con `formulas` (A1 en inglés), **nunca
  `formulasLocal`** (`=SUM(A1, 1.5)` se convierte en `=SUMME(A1; 1,5)`).
- **Las sesiones son cortas**: ~5 minutos de inactividad la persistente, ~7 la no
  persistente; al expirar devuelven 404. `invalidSessionReCreatable` significa recrear y
  seguir; `invalidSessionAccessConflict` significa que otro cliente tiene el libro
  bloqueado y **no** hay que recrear.
- **No hay transaccionalidad.** Con `persistChanges: true` cada llamada correcta ya está
  guardada; la sesión es una optimización de rendimiento, no un modo borrador. El worker
  tiene que ser idempotente y saber reanudar desde un estado parcial.
- **Estrictamente secuencial por libro**: «for each workbook, only send the next request
  after receiving a successful response to the current request». Nada de concurrencia.
- **`$batch` admite 20 subpeticiones como máximo**, y las que reciben throttling no se
  reintentan solas. Para filas de tabla, varias filas en una sola llamada.
- **Throttling**: respetar `Retry-After`. Excel documenta 5.000 peticiones/10 s por
  aplicación y 1.500/10 s por aplicación y tenant, con el aviso de que «Excel API
  throttling isn't defined with simple and universal limit numbers».
- **Decorar el tráfico**: `User-Agent: NONISV|UFV|MantenimientoAulas/1.0`, y un único
  AppID — Microsoft advierte expresamente de no crear varios para esquivar el throttling.
- **Gestionar el `410 Gone` del delta** (`resyncChangesApplyDifferences` /
  `resyncChangesUploadDifferences`).
