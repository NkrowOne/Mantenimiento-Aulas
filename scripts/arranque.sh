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
escribir_salud() {
	if motivo=$( { salud --json > "$PARCIAL"; } 2>&1 ) && mv "$PARCIAL" "$DESTINO" 2>/dev/null; then
		return 0
	fi
	rm -f "$PARCIAL" 2>/dev/null
	printf '[salud] No he podido reescribir %s: %s\n' "$DESTINO" "${motivo:-motivo desconocido}"
	printf '[salud] Se sirve el informe del build: dirá lo de la compilación y nada del entorno.\n'
	return 1
}

# La señal de un arranque anterior no dice nada de este. Borrarla antes de nada
# evita que un fallo ya resuelto se quede pegado al informe para siempre.
rm -f /srv/dist/.migraciones-fallidas 2>/dev/null

escribir_salud

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
if ! migrar; then
	printf '[migrar] El esquema no se ha podido poner al día: la aplicación se sirve igual.\n'
	# Y que conste en el informe, no solo aquí. Un `"faltan":[]` sobre una base
	# que no tiene las tablas ni las funciones que la aplicación va a pedir es
	# una mentira que se descubre semanas después, cuando el registro del
	# arranque hace mucho que se perdió.
	#
	# Por eso el informe se reescribe: se emitió antes de migrar —y ahí va bien,
	# porque `migrar` conviene que hable el último— así que aquella foto no sabía
	# nada de esto.
	touch /srv/dist/.migraciones-fallidas 2>/dev/null
	escribir_salud
fi

# El worker de informes, DENTRO de este contenedor.
#
# En un despliegue de un solo servicio no hay dónde más ponerlo: viaja
# empaquetado en la imagen (`/opt/alta/informes.cjs`, como `alta` y `migrar`) y
# arranca aquí si tiene lo que necesita — el token con el que `request_report`
# lo llamará y la base de la que saca los datos. En su PROPIO puerto: `PORT` es
# el de Caddy, y los dos procesos no pueden compartirlo.
#
# Con bucle de reinicio, porque aquí no hay un `restart: unless-stopped` que lo
# rescate: el proceso principal del contenedor es Caddy, y un worker caído sin
# bucle sería un worker caído hasta el siguiente despliegue. Y en segundo
# plano, claro: el worker nunca puede impedir que la PWA se sirva.
if [ -n "${DATABASE_URL:-}" ] && [ -n "${WORKER_TOKEN:-}" ]; then
	if [ "${#WORKER_TOKEN}" -lt 16 ]; then
		printf '[informes] WORKER_TOKEN tiene menos de 16 caracteres: el worker se niega a arrancar con uno así.\n'
	else
		# La URL de Storage, deducida del mismo SUPABASE_UPSTREAM que ya usa el
		# Caddyfile: por la red interna y sin depender de ningún dominio público.
		if [ -z "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_UPSTREAM:-}" ]; then
			SUPABASE_URL="http://${SUPABASE_UPSTREAM}"
			export SUPABASE_URL
		fi
		printf '[informes] Worker de informes dentro del contenedor, puerto %s.\n' "${PORT_INFORMES:-8090}"
		printf '[informes] app_config.reports_worker_url debe apuntar a http://<este-servicio>:%s/generate\n' "${PORT_INFORMES:-8090}"
		(
			while :; do
				PORT="${PORT_INFORMES:-8090}" node /opt/alta/informes.cjs
				printf '[informes] El worker se ha parado; se reinicia en 3 segundos.\n'
				sleep 3
			done
		) &
	fi
else
	printf '[informes] Sin WORKER_TOKEN o sin DATABASE_URL: el worker de informes no arranca en este contenedor.\n'
fi

# Lo último antes de ceder el proceso, y a propósito: a partir de aquí el
# registro de acceso de Caddy empuja estas líneas hacia arriba, y cuando un
# despliegue falla Skyway solo vuelca las últimas quince.
exec "$@"
