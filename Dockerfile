# La PWA, para una plataforma que construye desde el repositorio.
#
# Existe sobre todo para que la plataforma NO use Nixpacks. Nixpacks funciona,
# pero genera su propio Caddyfile y descarta el del repositorio, y ahí se pierde
# lo único que importa de verdad: que la API se sirva desde el mismo origen que
# la PWA. Sin eso, el navegador exige CORS y `supabase/kong.yml` no lo lleva.
#
# De regalo, fija la versión de Node —Nixpacks elige la más nueva que cumpla
# `engines`, y eso cambia solo— y se ahorra el minuto y medio de Nix por build.

# ── Compilación ──────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Playwright es dependencia de desarrollo y solo la usan `npm run smoke` y
# `preview`. Su postinstall se baja Chromium —unos 500 MB que aquí no pinta
# nada— y encima falla en Alpine, que no es una plataforma que soporte.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# El manifiesto antes que el código: mientras las dependencias no cambien, esta
# capa se reaprovecha y `npm ci` no vuelve a ejecutarse.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# La clave anónima se compila DENTRO del bundle, así que tiene que estar aquí y
# no en el arranque. Es pública por diseño —la protección real es RLS, no
# esconderla—, pero conviene saber que queda grabada en la imagen.
#
# La URL de la API no está: por defecto es el propio origen. Se puede forzar con
# VITE_SUPABASE_URL para un despliegue con la API en otro nombre.
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_SUPABASE_URL
ARG VITE_LOCK_AFTER_MINUTES=0
# Qué commit se está compilando, para que `/salud.json` pueda decirlo. Sin esto,
# saber si lo desplegado incluye un arreglo concreto obliga a descargarse el
# bundle y buscar cadenas dentro.
ARG VITE_COMMIT=desconocido
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_LOCK_AFTER_MINUTES=$VITE_LOCK_AFTER_MINUTES \
    VITE_COMMIT=$VITE_COMMIT

RUN npm run build

# El alta de usuarios, empaquetada en un fichero suelto.
#
# En la imagen de servicio no hay repositorio ni `node_modules`, así que la
# orden viaja con sus dependencias dentro y allí basta Node para ejecutarla.
# Sin esto, dar de alta a alguien exigía otra máquina con el repositorio
# clonado: el contenedor solo lleva Caddy y los ficheros compilados.
#
# El `target` va por debajo del Node del repositorio a propósito: en la imagen
# de servicio la versión la decide el Alpine de Caddy, no `engines`, y sube o
# baja sola cuando cambie la base.
RUN npx esbuild reports-worker/src/admin-user.ts \
      --bundle --platform=node --target=node20 --format=cjs \
      --outfile=/alta/admin-user.cjs

# Las migraciones viajan igual, y por el mismo motivo con más razón:
# `scripts/init-plataforma.sh` necesita bash, psql y el repositorio, y en la
# imagen de servicio no hay ninguno de los tres. Su única dependencia
# (`postgres`) está en el `package.json` de la raíz para que este `npm ci` la
# traiga; al navegador no llega, porque nada de `src/` la importa.
RUN npx esbuild reports-worker/src/migraciones.ts \
      --bundle --platform=node --target=node20 --format=cjs \
      --outfile=/alta/migraciones.cjs

# Y el worker de informes ENTERO, por el mismo camino que el alta y las
# migraciones: un solo fichero con sus dependencias dentro (postgres, echarts,
# supabase — todas están en el package.json de la raíz). Es lo que permite que
# un despliegue de un solo servicio genere informes sin desplegar nada más: el
# arranque lo lanza en su propio puerto si hay WORKER_TOKEN, y quien prefiera
# el worker como servicio aparte sigue teniendo reports-worker/Dockerfile.
RUN npx esbuild reports-worker/src/server.ts \
      --bundle --platform=node --target=node20 --format=cjs \
      --outfile=/alta/informes.cjs

# ── Servicio ─────────────────────────────────────────────────────────────
# Debian con Node, y Caddy como binario copiado — no al revés. El motivo es
# WeasyPrint: el worker de informes vive ahora dentro de esta imagen y necesita
# Pango y Cairo, que en Debian son la receta ya probada del Dockerfile del
# worker; Caddy es un binario estático de Go y viaja bien a cualquier base.
FROM node:22-slim

COPY --from=caddy:2 /usr/bin/caddy /usr/local/bin/caddy

# WeasyPrint necesita Pango y Cairo; sin ellas falla en tiempo de ejecución con
# un error poco descriptivo sobre libgobject. `ca-certificates` es para las
# salidas HTTPS del worker (Gemini) y de `alta`.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      python3 python3-pip \
      libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b libcairo2 \
      fonts-ibm-plex \
    && pip3 install --break-system-packages --no-cache-dir weasyprint \
    && apt-get purge -y python3-pip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY Caddyfile.skyway /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv/dist
COPY --from=build /alta/admin-user.cjs /opt/alta/admin-user.cjs
COPY --from=build /alta/migraciones.cjs /opt/alta/migraciones.cjs
COPY --from=build /alta/informes.cjs /opt/alta/informes.cjs

# El informe del build, apartado FUERA de `/srv/dist`. El arranque reescribe
# `/srv/dist/salud.json` juntando esto con el entorno; si leyera del mismo sitio
# donde escribe, en el segundo arranque estaría leyendo su propia salida.
COPY --from=build /app/dist/salud.json /srv/salud-construccion.json

# El SQL, tal cual está en el repositorio: `migrar` lo lee de aquí y lleva la
# cuenta en `public.schema_migrations`, con los mismos nombres de fichero que
# usa `init-plataforma.sh`. Así da igual cuál de los dos aplicara cada una.
COPY --from=build /app/supabase/migrations /opt/migraciones

# `salud` también sirve suelto desde la terminal del panel, que es donde alguien
# querrá preguntarlo cuando algo vaya mal.
COPY scripts/salud.sh /usr/local/bin/salud
COPY scripts/arranque.sh /usr/local/bin/arranque
RUN chmod +x /usr/local/bin/salud /usr/local/bin/arranque

# Envoltorios en el PATH: en la terminal del panel se escribe
# `alta crear ana@x.es "Ana"`, no la ruta a un fichero .cjs.
RUN printf '#!/bin/sh\nexec node /opt/alta/admin-user.cjs "$@"\n' > /usr/local/bin/alta \
    && printf '#!/bin/sh\nexec node /opt/alta/migraciones.cjs "$@"\n' > /usr/local/bin/migrar \
    && chmod +x /usr/local/bin/alta /usr/local/bin/migrar

# La orden se anuncia a sí misma con este nombre en sus mensajes de ayuda.
ENV ADMIN_CLI=alta

# Necesita SUPABASE_SERVICE_ROLE_KEY en el entorno del servicio. NO se declara
# aquí a propósito: una clave de servicio no se graba en una capa de imagen. La
# URL de la API sale de SUPABASE_UPSTREAM, la misma que ya usa el Caddyfile.
#
# Y DATABASE_URL si se quiere que el propio arranque ponga la base al día: tiene
# que ser el Postgres del despliegue (`migrar` se niega si no encuentra
# `auth.users` y `storage.buckets`, que es como se detecta una base equivocada).
# Sin ella, el arranque lo dice en el registro y sirve la aplicación igual.
#
# Con WORKER_TOKEN (y esa misma DATABASE_URL), el arranque levanta además el
# worker de informes DENTRO de este contenedor, en PORT_INFORMES (8090 por
# defecto): `app_config.reports_worker_url` apunta entonces a
# `http://<este-servicio>:8090/generate`. Sin token, no arranca y se dice.

ENV PORT=8080
ENV PORT_INFORMES=8090
EXPOSE 8080

# Comprueba que Caddy sirve, no solo que el proceso existe. El estado de la
# configuración sigue yendo en el cuerpo (`estado`, `faltan`) y no en el código
# de salida: una variable ausente deja la aplicación inservible pero el servicio
# sano, y marcarlo enfermo lo tumbaría en vez de solo señalarlo. Peor todavía
# aquí, donde Skyway sondea esta misma ruta durante el despliegue y exige 2xx:
# devolver error abortaría el despliegue y restauraría la versión anterior, que
# estará igual de desconfigurada, sin decir por qué —la sonda de Skyway tira el
# cuerpo—. Un problema legible se convertiría en uno mudo.
#
# Lo que cambia respecto de antes es que ese cuerpo ahora SE LEE: el resumen
# queda en `docker inspect … State.Health`, y un `/salud.json` que en realidad
# es el index.html —porque `try_files` cae a la SPA cuando el fichero falta—
# deja de pasar por bueno.
#
# El periodo de gracia cubre las migraciones: se aplican antes de ceder el
# proceso a Caddy, y en el primer arranque son unos segundos —o hasta medio
# minuto si la base todavía está levantando, que es lo normal cuando la
# plataforma arranca la pila entera a la vez. Con los 5 s de antes, un
# despliegue nuevo se pintaba enfermo mientras hacía justo lo que debía.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD salud --sonda

# El arranque rehace el informe, pone la base al día y lo escribe todo en el
# registro antes de ceder el proceso. Va en ENTRYPOINT y no dentro del CMD
# porque la plataforma puede sustituir el CMD por un `startCmd` suyo: el
# ENTRYPOINT sobrevive a eso y el diagnóstico sigue saliendo.
ENTRYPOINT ["/usr/local/bin/arranque"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
