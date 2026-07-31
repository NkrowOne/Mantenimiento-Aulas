#!/usr/bin/env bash
#
# Copia de seguridad diaria.
#
#   ./scripts/backup.sh                    # crear copia
#   ./scripts/backup.sh --probar <fichero> # restaurar en una base desechable
#
# En cron:
#   30 3 * * *  cd /opt/aulas && ./scripts/backup.sh >> /var/log/aulas-backup.log 2>&1
#
# El compose de Supabase no trae copias de ningún tipo. Y una copia que nunca
# se ha restaurado no es una copia: por eso `--probar` forma parte del script y
# no de un documento que nadie lee.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
set -a; . ./.env; set +a

DESTINO="${BACKUP_DIR:-/var/backups/aulas}"
RETENCION_DIAS="${BACKUP_RETENTION_DAYS:-30}"
sello=$(date +%Y%m%d-%H%M)

probar() {
  local fichero="$1"
  [ -f "$fichero" ] || { echo "No existe $fichero" >&2; exit 1; }

  echo "▸ Restaurando $fichero en una base desechable"
  docker compose exec -T db psql -U postgres -d postgres -q \
    -c 'drop database if exists prueba_restauracion' \
    -c 'create database prueba_restauracion'

  # Un volcado cortado a la mitad es un .gz perfectamente válido: `gunzip -t`
  # no lo distingue. pg_dump firma el final con un marcador, y un fichero que
  # no lo lleva no es una copia — es la mitad de una. Se comprueba ANTES de
  # restaurar, porque restaurar media copia también «funciona» y el recuento
  # de salas puede darse por bueno con las tablas de después de rooms vacías.
  if ! gunzip -c "$fichero" | tail -5 | grep -q 'PostgreSQL database dump complete'; then
    echo "✗ El volcado no llega hasta el final: falta el marcador de pg_dump" >&2
    exit 1
  fi

  # Sin ON_ERROR_STOP a propósito, y conviene decir por qué: el volcado
  # completo trae `create extension pg_cron`, que en una base que no es
  # `cron.database_name` falla SIEMPRE — un error esperado que no invalida
  # nada. El criterio de éxito es el marcador de arriba más los recuentos.
  gunzip -c "$fichero" | docker compose exec -T db psql -U postgres -d prueba_restauracion -q

  local salas incidencias
  salas=$(docker compose exec -T db psql -U postgres -d prueba_restauracion -tAc \
          'select count(*) from rooms')
  incidencias=$(docker compose exec -T db psql -U postgres -d prueba_restauracion -tAc \
                'select count(*) from incidents')

  docker compose exec -T db psql -U postgres -d postgres -q \
    -c 'drop database prueba_restauracion'

  echo "  salas restauradas: $salas"
  echo "  incidencias:       $incidencias"

  if [ "$salas" -lt 200 ]; then
    echo "✗ La copia parece incompleta: se esperaban ~276 salas" >&2
    exit 1
  fi
  echo "✓ La copia es restaurable"
}

if [[ "${1:-}" == '--probar' ]]; then
  probar "${2:?Indica el fichero a probar}"
  exit 0
fi

mkdir -p "$DESTINO"

echo "▸ Volcando la base de datos"
docker compose exec -T db pg_dump -U postgres -d postgres --clean --if-exists \
  | gzip > "$DESTINO/db-$sello.sql.gz"
echo "  $(du -h "$DESTINO/db-$sello.sql.gz" | cut -f1)"

# Las fotos no están en la base de datos: viven en el volumen de Storage. Una
# copia solo de Postgres dejaría las incidencias sin sus pruebas gráficas.
#
# El volumen se busca por su ETIQUETA de Compose, no por un nombre adivinado.
# El nombre real lleva delante el del proyecto —el directorio, o
# COMPOSE_PROJECT_NAME—, así que el «aulas_storage-data» que había escrito a
# mano solo existía si el directorio se llamaba «aulas». Con cualquier otro
# nombre, `docker run -v` CREABA en silencio un volumen nuevo y vacío, y la
# «copia» archivaba cero fotos con cara de éxito. Una copia que puede estar
# vacía sin decirlo no es una copia: si el volumen no aparece, esto FALLA.
echo "▸ Copiando los ficheros de Storage"
VOL_STORAGE=$(docker volume ls -q --filter label=com.docker.compose.volume=storage-data)
if [ -z "$VOL_STORAGE" ]; then
  echo "✗ No se encuentra el volumen de Storage (etiqueta com.docker.compose.volume=storage-data)" >&2
  exit 1
fi
if [ "$(printf '%s\n' "$VOL_STORAGE" | wc -l)" -ne 1 ]; then
  echo "✗ Hay más de un volumen storage-data en este Docker; fija COMPOSE_PROJECT_NAME y concreta cuál" >&2
  printf '%s\n' "$VOL_STORAGE" | sed 's/^/    /' >&2
  exit 1
fi
docker run --rm \
  -v "$VOL_STORAGE":/origen:ro \
  -v "$DESTINO":/destino \
  alpine tar czf "/destino/storage-$sello.tar.gz" -C /origen .
echo "  $(du -h "$DESTINO/storage-$sello.tar.gz" | cut -f1)"

echo "▸ Limpiando copias de más de $RETENCION_DIAS días"
find "$DESTINO" -name '*.gz' -mtime "+$RETENCION_DIAS" -delete -print | sed 's/^/  borrada /'

# Comprobación mínima de que el volcado sirve para algo. Un pg_dump que falla a
# la mitad deja un fichero .gz perfectamente válido y perfectamente inútil.
if ! gunzip -t "$DESTINO/db-$sello.sql.gz" 2>/dev/null; then
  echo "✗ El volcado está corrupto" >&2
  exit 1
fi

echo "✓ Copia completada: $DESTINO/db-$sello.sql.gz"
echo "  Pruébala de vez en cuando con: ./scripts/backup.sh --probar $DESTINO/db-$sello.sql.gz"
