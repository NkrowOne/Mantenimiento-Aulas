# Mantenimiento de Aulas y Salas

PWA para la revisión de aulas y salas de reunión del campus: registro offline, gestión de
inventario instalado, gestión de stock de almacén e informes autogenerados.

> **Estado del proyecto:** Fase 0 — prototipo de interfaz aprobado. El código de producción
> todavía no existe.

## Qué resuelve

Hoy el mantenimiento se lleva en un único Excel de cinco hojas. Del análisis de ese fichero
salieron los problemas que definen el alcance:

- **El stock no se descuenta.** `Bolsa 2026` marca `Total Instalado = 0` en los 43 artículos,
  mientras el registro de mantenimiento recoge 96 consumos reales. En `Bolsa 2025` hay un
  artículo con existencias **−2**.
- **Los datos no están normalizados.** Las columnas SÍ/NO tienen ocho variantes
  (`si`, `SI`, `Si`, `SÍ`, `NO`, `no`, `No`, vacío) y la columna de micrófono mezcla
  booleanos, marcas y números de serie.
- **Hay fechas imposibles** guardadas como texto: `29-01-026`, `27-03-296`, `1902-26`.
- **No hay trazabilidad.** Es imposible saber quién revisó qué ni cuándo cambió un dato.

## Decisiones de arquitectura

| Área | Decisión |
|---|---|
| Aplicación | Next.js 15 (App Router) + TypeScript + Tailwind v4, un solo contenedor |
| Base de datos | Postgres 16 + Drizzle ORM |
| Producción | Skyway (Docker propio) vía `docker-compose` |
| Pruebas | Railway, desplegado desde GitHub con el mismo `Dockerfile` |
| Identidad | UUID v7 **generado en el cliente** — los registros creados sin cobertura nacen con su identidad definitiva |
| Offline | IndexedDB (Dexie) + cola de salida idempotente. Sin depender de Background Sync, que iOS no soporta |
| Fotos | WebP calidad 0,8, máx. 1600 px, comprimidas en el dispositivo |
| Roles | `operador` (acceso completo) y `lector` (solo lectura) |

El plan completo, con modelo de datos, protocolo de sincronización y fases de entrega, está en
**[`docs/PLAN.md`](docs/PLAN.md)**.

## Prototipo de interfaz

`prototipo/index.html` es un prototipo navegable y autocontenido — sin dependencias, sin red,
sin CDN. Ábrelo en cualquier navegador.

Cuatro pantallas: **revisión de sala**, **ficha de sala**, **cuadro de mando** e **informe**.
Los controles funcionan: pulsa «Todo correcto», marca un fallo y observa cómo aparece el botón
de abrir incidencia.

### Sistema de diseño

**Firma: la placa de puerta.** Cada aula del campus lleva una placa grabada. Es el objeto más
característico de este oficio y encierra la tesis del proyecto: *la identidad vive en el
código, no en el nombre*. Aparece a tres escalas — la placa del sistema en la cabecera, la del
aula en su ficha, y un sello en el pie del informe — y en la cabecera recibe un único barrido
de escaneo al cargar, que es literalmente la interacción central de la aplicación. Toda la
audacia del diseño se gasta aquí; el resto se mantiene deliberadamente callado.

**Tipografía.** Instrument Sans para prosa e interfaz; **IBM Plex Mono** para todo código,
serie, cifra y etiqueta de estado. Plex se dibujó para contextos técnicos e industriales, que
es exactamente este dominio: `5310306901678` es legible en monoespaciada y no lo es en
proporcional. Ambas van incrustadas como subconjunto latino — 38 KB las cuatro variantes.

**Formas.** Escala de radios en lugar de un radio único: plano en superficies y regiones de
datos, 3 px solo en lo que se pulsa. Los indicadores son una tira dividida por filetes, no
tarjetas flotantes con raíl de color. Las secciones son etiquetas colgadas de una regla, sin
cajas anidadas. Los seis bloques de revisión son filas continuas de una hoja de servicio.

**Color.** Acento petrol `#008C9E` en claro, `#22A7B8` en oscuro, validado por script: croma
≥ 0,10, banda de luminosidad y contraste ≥ 3:1 en ambos modos. La primera pareja candidata
**falló** —ΔE 1,0 bajo protanopía, indistinguible— y se descartó. Los colores de estado son
reservados y siempre van con icono y texto: nunca color solo.

**Interacción.** Revisión por excepción — una sala sin incidencias se cierra en unos
5 segundos. Un único triestado OK / FALLA / N/A para los seis bloques, con objetivos de 44 px
en la mitad inferior de la pantalla y sin depender de pasar el ratón.

### Regenerar

```bash
python3 prototipo/build.py                    # incrusta las fuentes → index.html
python3 prototipo/subset.py /ruta/a/los/ttf   # regenera los subconjuntos (necesita fonttools)
```

## Estructura

```
docs/PLAN.md              Plan aprobado: contexto, arquitectura, modelo de datos, fases
prototipo/index.html      Prototipo autocontenido (generado)
prototipo/index.src.html  Fuente del prototipo, con marcadores de fuente
prototipo/build.py        Incrusta las fuentes y compone index.html
prototipo/subset.py       Regenera los subconjuntos de fuente
prototipo/fuentes/        Subconjuntos woff2 + licencias OFL
```

Instrument Sans e IBM Plex Mono se distribuyen bajo SIL Open Font License; las licencias
están en `prototipo/fuentes/`.
