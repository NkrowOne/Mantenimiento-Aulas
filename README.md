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

`prototipo/index.html` es un prototipo navegable y autocontenido — sin dependencias, sin red.
Ábrelo en cualquier navegador.

Cuatro pantallas: **revisión de sala**, **ficha de sala**, **cuadro de mando** e **informe**.
Los controles funcionan: pulsa «Todo correcto», marca un fallo y observa cómo aparece el botón
de abrir incidencia.

Notas de diseño que el prototipo demuestra:

- **Revisión por excepción.** Una sala sin incidencias se cierra en unos 5 segundos; solo se
  despliega el bloque que falla.
- **Un único lenguaje de control.** Los seis bloques usan el mismo triestado OK / FALLA / N/A,
  con objetivos de 44 px y sin depender de pasar el ratón.
- **Nunca solo color.** Cada estado lleva icono y texto, para daltonismo y para pantallas
  lavadas por el proyector.
- **La paleta se validó, no se eligió a ojo.** La primera pareja de color candidata falló por
  ser indistinguible bajo protanopía y se descartó.

## Estructura

```
docs/PLAN.md          Plan aprobado: contexto, arquitectura, modelo de datos, fases
prototipo/index.html  Prototipo de interfaz autocontenido
```
