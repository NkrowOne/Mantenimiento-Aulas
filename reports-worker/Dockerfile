# Worker de informes: Node para los datos y el SVG, WeasyPrint para el PDF.
#
# Sin Chromium. ECharts renderiza los gráficos a SVG en servidor, así que la
# plantilla no necesita JavaScript y basta WeasyPrint: ~300MB frente a ~1,5GB
# de una imagen con navegador, y ningún proceso que se quede colgado.
FROM node:22-slim

# WeasyPrint necesita Pango y Cairo; sin ellas falla en tiempo de ejecución
# con un error poco descriptivo sobre libgobject.
RUN apt-get update && apt-get install -y --no-install-recommends \
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
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Además del servidor, `src` trae la orden de altas de usuario
# (`npm run admin -- crear …`): en un despliegue sobre plataforma este es el
# único contenedor que puede ejecutarla. Ver `src/admin-user.ts`.
COPY src ./src
COPY tsconfig.json ./

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

CMD ["npx", "tsx", "src/server.ts"]
