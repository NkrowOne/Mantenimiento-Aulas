# Worker de informes: Node para los datos y el SVG, WeasyPrint para el PDF.
#
# Sin Chromium. ECharts renderiza los gráficos a SVG en servidor, así que la
# plantilla no necesita JavaScript y basta WeasyPrint: ~300MB frente a ~1,5GB
# de una imagen con navegador, y ningún proceso que se quede colgado.
#
# SE CONSTRUYE DESDE LA RAÍZ DEL REPOSITORIO, no desde esta carpeta:
#
#   docker build -f reports-worker/Dockerfile .
#
# (`docker-compose.yml` ya lo hace así.) El motivo es el informe en segundo
# plano: el servidor lo genera con el código de la aplicación —`src/`, el mismo
# que corre en el navegador— para que no haya dos informes distintos, y ese
# código está fuera de esta carpeta. Sobre una plataforma que construya este
# servicio aparte, el «directorio raíz» del servicio tiene que ser la raíz del
# repositorio y la ruta del Dockerfile, `reports-worker/Dockerfile`.

# ── Empaquetado ──────────────────────────────────────────────────────────
# El servidor entero en un fichero, con el código de la aplicación que usa y
# sus dependencias dentro. Es la misma orden que lleva el `Dockerfile` de la
# raíz, a propósito: lo que corre aquí y lo que corre dentro de la imagen de la
# PWA es el mismo fichero.
FROM node:22-slim AS build

WORKDIR /repo

# Playwright es dependencia de desarrollo de la raíz y su postinstall se baja
# Chromium: aquí no pinta nada.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY reports-worker ./reports-worker

RUN npx esbuild reports-worker/src/server.ts \
      --bundle --platform=node --target=node22 --format=cjs \
      --log-override:empty-import-meta=silent \
      --outfile=/out/informes.cjs

# ── Servicio ─────────────────────────────────────────────────────────────
FROM node:22-slim

# WeasyPrint necesita Pango y Cairo; sin ellas falla en tiempo de ejecución
# con un error poco descriptivo sobre libgobject. El `sed` activa la sección
# `contrib` de Debian, donde vive fonts-ibm-plex: la imagen solo trae `main`
# y sin esa línea apt dice que el paquete no existe.
RUN sed -i 's/Components: main/Components: main contrib/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip \
      libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b libcairo2 \
      fonts-ibm-plex \
    && pip3 install --break-system-packages --no-cache-dir weasyprint \
    && apt-get purge -y python3-pip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# `tsx` es dependencia de producción, no de desarrollo: con `--omit=dev` no se
# instalaría y el `npx tsx` del CMD tendría que bajárselo del registro en cada
# arranque en frío. Instalado aquí, el contenedor arranca —y ejecuta las altas
# de usuario— sin depender de que alcance npm.
COPY reports-worker/package.json reports-worker/package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# `src` se queda por la orden de altas de usuario (`npm run admin -- crear …`)
# y por `npm run render`: en un despliegue sobre plataforma este es el único
# contenedor que puede ejecutarlas. Ver `src/admin-user.ts`. El servidor ya no
# arranca de aquí, sino del empaquetado de arriba.
COPY reports-worker/src ./src
COPY reports-worker/tsconfig.json ./
COPY --from=build /out/informes.cjs ./informes.cjs

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# El healthcheck confirma que el proceso responde, no solo que existe: un
# weasyprint colgado deja el proceso vivo y el servicio inútil.
#
# Contra `/salud`, no contra `/generate`. Lo segundo era de antes de que
# existiera el endpoint de salud: sondeaba la ruta real esperando un 401 para
# darla por sana, así que cada minuto dejaba un intento de autenticación
# fallido en los registros y confundía el diagnóstico de un 401 de verdad.
# Además se apoyaba en `$PORT` fijo a 8080 aunque la variable sea configurable.
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/salud').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"

# El empaquetado, y no `tsx src/server.ts`: `src/server.ts` importa el código
# de la aplicación, que en esta imagen solo existe dentro de `informes.cjs`.
CMD ["node", "informes.cjs"]
