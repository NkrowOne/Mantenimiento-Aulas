#!/bin/sh
#
# Punto de entrada del contenedor de la PWA.
#
# Hace cuatro cosas antes de ceder el proceso a Caddy, y ninguna puede impedir
# que el servicio arranque: un diagnóstico que tumba lo que diagnostica es peor
# que no tenerlo, y lo mismo vale para una migración.
#
#   1. Rehace `/srv/dist/salud.json` juntando lo que dejó dicho el build con lo
#      que hay ahora mismo en el entorno. Es el único momento en que hace falta:
#      el entorno de un contenedor se fija al crearlo, así que esta foto no
#      puede quedarse vieja sin que se cree un contenedor nuevo, que volverá a
#      ejecutar esto.
#   2. Escribe el mismo diagnóstico en la salida estándar, que es lo ÚNICO que
#      enseña el panel: Skyway no lee el estado de salud de Docker, así que la
#      salida del HEALTHCHECK no la ve nadie desde allí.
#   3. Aplica a la base las migraciones que le falten, si hay DATABASE_URL.
#   4. Arranca Caddy.

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

# Las migraciones que le falten a la base, y tampoco pueden impedir que el
# servicio arranque: la PWA es estática y funciona sin conexión, así que un
# Postgres que tarda en levantar no es motivo para dejar el iPad en blanco.
# `migrar` no toca nada si no hay DATABASE_URL o si la base no es la del
# despliegue, y lo deja dicho.
#
# Va DESPUÉS del informe de salud, aunque eso empuje sus líneas hacia arriba:
# en marcha esto imprime una sola línea («la base ya estaba al día»), y cuando
# imprime más es porque ha pasado algo que hay que leer —y entonces conviene
# que sea lo último, no lo penúltimo.
migrar || printf '[migrar] El esquema no se ha podido poner al día: la aplicación se sirve igual.\n'

# Lo último antes de ceder el proceso, y a propósito: a partir de aquí el
# registro de acceso de Caddy empuja estas líneas hacia arriba, y cuando un
# despliegue falla Skyway solo vuelca las últimas quince.
exec "$@"
