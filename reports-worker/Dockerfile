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

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
COPY tsconfig.json ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# El healthcheck confirma que el proceso responde, no solo que existe.
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/generate',{method:'POST'}).then(r=>process.exit(r.status===401||r.status===400?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/server.ts"]
