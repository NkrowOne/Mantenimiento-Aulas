#!/bin/sh
#
# Punto de entrada del contenedor de la PWA.
#
# Hace tres cosas antes de ceder el proceso a Caddy, y ninguna puede impedir
# que el servicio arranque: un diagnóstico que tumba lo que diagnostica es peor
# que no tenerlo.
#
#   1. Rehace `/srv/dist/salud.json` juntando lo que dejó dicho el build con lo
#      que hay ahora mismo en el entorno. Es el único momento en que hace falta:
#      el entorno de un contenedor se fija al crearlo, así que esta foto no
#      puede quedarse vieja sin que se cree un contenedor nuevo, que volverá a
#      ejecutar esto.
#   2. Escribe el mismo diagnóstico en la salida estándar, que es lo ÚNICO que
#      enseña el panel: Skyway no lee el estado de salud de Docker, así que la
#      salida del HEALTHCHECK no la ve nadie desde allí.
#   3. Arranca Caddy.

set -u

DESTINO=/srv/dist/salud.json
PARCIAL=/srv/dist/.salud.json.parcial

# Escritura atómica. `file_server` puede estar sirviendo el fichero mientras
# esto ocurre —la sonda del contenedor anterior, un reinicio— y medio JSON es
# peor que un JSON viejo.
# El motivo se captura en vez de dejarlo salir suelto: la queja del shell por
# una redirección que falla no lleva el prefijo `[salud]`, y sin él la
# plataforma se le come los ocho primeros caracteres al volcar las últimas
# líneas de un contenedor muerto. Y el motivo importa: «solo lectura» y
# «directorio inexistente» piden arreglos distintos.
if motivo=$( { salud --json > "$PARCIAL"; } 2>&1 ) && mv "$PARCIAL" "$DESTINO" 2>/dev/null; then
	:
else
	rm -f "$PARCIAL" 2>/dev/null
	printf '[salud] No he podido reescribir %s: %s\n' "$DESTINO" "${motivo:-motivo desconocido}"
	printf '[salud] Se sirve el informe del build: dirá lo de la compilación y nada del entorno.\n'
fi

salud --texto

# Lo último antes de ceder el proceso, y a propósito: a partir de aquí el
# registro de acceso de Caddy empuja estas líneas hacia arriba, y cuando un
# despliegue falla Skyway solo vuelca las últimas quince.
exec "$@"
