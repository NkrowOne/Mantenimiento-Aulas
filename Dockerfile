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
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_LOCK_AFTER_MINUTES=$VITE_LOCK_AFTER_MINUTES

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

# ── Servicio ─────────────────────────────────────────────────────────────
FROM caddy:2-alpine

# Node está aquí solo para el alta de usuarios. Son unos 50 MB en una imagen
# que sirve ficheros estáticos, y es lo que cuesta poder administrar el
# despliegue desde la terminal del panel en vez de desde un portátil.
RUN apk add --no-cache nodejs

COPY Caddyfile.skyway /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv/dist
COPY --from=build /alta/admin-user.cjs /opt/alta/admin-user.cjs

# El informe del build, apartado FUERA de `/srv/dist`. El arranque reescribe
# `/srv/dist/salud.json` juntando esto con el entorno; si leyera del mismo sitio
# donde escribe, en el segundo arranque estaría leyendo su propia salida.
COPY --from=build /app/dist/salud.json /srv/salud-construccion.json

# `salud` también sirve suelto desde la terminal del panel, que es donde alguien
# querrá preguntarlo cuando algo vaya mal.
COPY scripts/salud.sh /usr/local/bin/salud
COPY scripts/arranque.sh /usr/local/bin/arranque
RUN chmod +x /usr/local/bin/salud /usr/local/bin/arranque

# Un envoltorio en el PATH: en la terminal del panel se escribe
# `alta crear --email … --nombre "…"`, no la ruta a un fichero .cjs.
RUN printf '#!/bin/sh\nexec node /opt/alta/admin-user.cjs "$@"\n' > /usr/local/bin/alta \
    && chmod +x /usr/local/bin/alta

# La orden se anuncia a sí misma con este nombre en sus mensajes de ayuda.
ENV ADMIN_CLI=alta

# Necesita SUPABASE_SERVICE_ROLE_KEY en el entorno del servicio. NO se declara
# aquí a propósito: una clave de servicio no se graba en una capa de imagen. La
# URL de la API sale de SUPABASE_UPSTREAM, la misma que ya usa el Caddyfile.

ENV PORT=8080
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
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD salud --sonda

# El arranque rehace el informe y lo escribe en el registro antes de ceder el
# proceso. Va en ENTRYPOINT y no dentro del CMD porque la plataforma puede
# sustituir el CMD por un `startCmd` suyo: el ENTRYPOINT sobrevive a eso y el
# diagnóstico sigue saliendo.
ENTRYPOINT ["/usr/local/bin/arranque"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
