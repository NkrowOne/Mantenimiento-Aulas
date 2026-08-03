#!/bin/sh
#
# Qué sabe el contenedor sobre su propia configuración.
#
# Un despliegue de esto puede quedar «verde y roto» de dos maneras que no se
# parecen en nada, y ninguna se ve desde fuera:
#
#   - de CONSTRUCCIÓN: `VITE_SUPABASE_ANON_KEY` se hornea dentro del bundle. Si
#     faltó al compilar no hay variable que añadir después —hay que reconstruir
#     la imagen— y en el contenedor esa variable ya no existe. Lo único que
#     queda de ella es lo que el build dejó escrito.
#   - de EJECUCIÓN: `SUPABASE_UPSTREAM` la pone la plataforma. Si falta, Caddy
#     arranca, sirve la PWA y responde 200 aquí mismo, pero `/rest`, `/auth` y
#     `/storage` devuelven 503. Es el más traicionero de los dos.
#
# De ahí los tres modos: el informe en JSON que se sirve en `/salud.json`, el
# mismo informe en texto para el registro —que es lo único que enseña el panel
# de la plataforma— y la sonda que usa el HEALTHCHECK.
#
# Regla que no se salta nunca: aquí se publica si un secreto ESTÁ, jamás su
# valor, ni su longitud, ni un prefijo. `/salud.json` es público.

set -u

# El informe de construcción lo escribe el plugin `salud-json` de Vite y el
# Dockerfile lo aparta FUERA de `/srv/dist`. Apartarlo no es manía: el arranque
# reescribe `/srv/dist/salud.json`, así que leer de ahí sería, en el segundo
# arranque, leer nuestra propia salida.
CONSTRUCCION=${SALUD_CONSTRUCCION:-/srv/salud-construccion.json}

# ── Lo que dejó dicho el build ────────────────────────────────────────────
#
# Sacar con `sed` un JSON de propósito general sería mala idea. Este no lo es:
# lo escribe `JSON.stringify` sin espacios, las claves son nuestras y son
# únicas en todo el fichero. El valor se copia TAL CUAL aparece, con sus
# comillas si las lleva, así que lo que se reinyecta ya es JSON válido sin
# tener que escapar nada.
campo() {
	sed -n "s/.*\"$1\":\([^,}]*\).*/\1/p" "$CONSTRUCCION" 2>/dev/null
}

version=$(campo version)
# Qué código está en el aire. `version` no lo dice —nada la sube, así que todos
# los despliegues anuncian el mismo `0.1.0`— y sin esto la única forma de
# responder «¿está desplegado el arreglo?» era descargarse el bundle y buscar
# cadenas dentro.
commit=$(campo commit)
[ -n "$commit" ] || commit='"desconocido"'
clave_anonima=$(campo clave_anonima)
url_api=$(campo url_api)
bloqueo_min=$(campo bloqueo_min)

faltan=''
avisos=''
faltan_texto=''
avisos_texto=''

# Cada anotación se guarda dos veces: como elemento de un array JSON y como
# texto suelto. Sale más barato que deshacer el JSON después para imprimirlo, y
# sobre todo no deja el mensaje a merced de su propia puntuación.
#
# Los textos son literales nuestros: no llevan comillas ni barras invertidas,
# así que no hay nada que escapar. El día que uno lleve un valor de fuera, esto
# deja de ser cierto.
falta() {
	faltan="${faltan:+$faltan,}\"$1\""
	faltan_texto="${faltan_texto:+$faltan_texto, }$1"
}
aviso() {
	avisos="${avisos:+$avisos,}\"$1\""
	avisos_texto="${avisos_texto:+$avisos_texto
}$1"
}

# Si el informe de construcción no está —el plugin dejó de emitirlo, `dist` se
# copió mal— se dice que no se sabe. «No lo sé» es una respuesta legítima y muy
# preferible a inventarse un `false`, que mandaría a reconstruir la imagen por
# nada.
[ -n "$version" ] || version='"desconocida"'
[ -n "$url_api" ] || url_api=null
[ -n "$bloqueo_min" ] || bloqueo_min=null

case "$clave_anonima" in
	true) ;;
	false) falta 'VITE_SUPABASE_ANON_KEY' ;;
	*)
		clave_anonima=null
		aviso 'no se ha podido leer el informe del build: lo de construccion esta sin comprobar'
		;;
esac

# ── Lo que hay ahora mismo en el entorno ──────────────────────────────────

# El mismo valor por defecto que `Caddyfile.skyway` (`:{$PORT:8080}`) y que el
# `ENV PORT` de la imagen.
puerto=${PORT:-8080}

# `PORT` definida y VACÍA es el caso peor y el menos evidente: el `{$PORT:8080}`
# del Caddyfile se sustituye ANTES de analizar el fichero y solo pone el 8080
# cuando la variable no está; con ella vacía el sitio queda en `:` y Caddy
# escucha en el 443. El enrutador de la plataforma deja de encontrar el
# servicio y la sonda pregunta a un puerto donde no hay nadie: el contenedor se
# marca enfermo —con razón, es inalcanzable— pero sin esta línea nadie sabría
# por qué.
if [ -n "${PORT+definida}" ] && [ -z "${PORT}" ]; then
	puerto=443
	aviso 'PORT esta definida y vacia: Caddy escuchara en el 443 y el enrutador no encontrara el servicio'
fi

# La FORMA de `SUPABASE_UPSTREAM`, nunca su valor: es un nombre de la red
# privada y no tiene por qué salir a un extremo público. La forma, en cambio,
# es justo lo que se equivoca: Caddy quiere `host:puerto` pelado, mientras que
# `alta` acepta el esquema, y esa asimetría invita a ponerlo mal en los dos.
case "${SUPABASE_UPSTREAM:-}" in
	'')
		upstream='"ausente"'
		falta 'SUPABASE_UPSTREAM'
		;;
	https://*)
		upstream='"con esquema"'
		aviso 'SUPABASE_UPSTREAM lleva https://: Caddy hablara TLS contra un Kong que sirve HTTP plano y dara 502'
		;;
	http://*)
		upstream='"con esquema"'
		aviso 'SUPABASE_UPSTREAM lleva esquema: Caddy quiere host:puerto pelado'
		;;
	*/*)
		upstream='"con ruta"'
		aviso 'SUPABASE_UPSTREAM lleva una ruta o una barra final: Caddy la toma como parte del host y dara 502'
		;;
	*)
		upstream='"host:puerto"'
		;;
esac

# El hook que mete el rol en el JWT.
#
# Es la variable cuya ausencia sale más cara de todo el despliegue, y hasta
# ahora este informe no la miraba: por eso `/salud.json` decía `"faltan":[]` con
# la aplicación sin enseñar ni una fila. Sin el hook, el token sale sin el claim
# `app_role`, `public.is_staff()` es falso y PostgREST responde `200 []` a TODAS
# las lecturas — un despliegue indistinguible de una base vacía.
#
# Se declara en el servicio de auth, no en este, así que verlo aquí no prueba
# nada y no verlo tampoco: por eso una es aviso y la otra falta. Lo que sí zanja
# la pregunta es el botón «Ver diagnóstico del servidor» de la propia
# aplicación, que lee el claim del token de verdad.
case "${GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED:-}" in
	true|TRUE|1)
		hook_rol='"activo"'
		;;
	'')
		hook_rol='"sin declarar aqui"'
		aviso 'GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED no esta en este servicio: si tampoco esta en el de auth, el token sale sin app_role y RLS devuelve 200 [] en todo'
		;;
	*)
		hook_rol='"desactivado"'
		falta 'GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED'
		;;
esac

# Si las migraciones fallaron, `arranque.sh` deja esta señal. Sin ella el
# informe decía «ok» sobre una base que no tiene las tablas que la aplicación va
# a pedir, y el fallo solo aparecía en el registro del arranque, que es donde
# nadie mira una semana después.
migraciones='"al dia"'
if [ -f /srv/dist/.migraciones-fallidas ]; then
	migraciones='"fallidas"'
	falta 'MIGRACIONES'
fi

# Presencia, nunca el valor. Su ausencia NO es un fallo del despliegue: la PWA
# funciona entera sin ella; lo único que no se podrá hacer es dar de alta
# usuarios desde la terminal del panel con `alta`.
if [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
	clave_de_servicio=true
else
	clave_de_servicio=false
	aviso 'SUPABASE_SERVICE_ROLE_KEY ausente: la PWA funciona, pero alta no podra crear usuarios'
fi

# Qué despliegue concreto se está sirviendo. `version` no basta: nada la sube
# sola, así que dos despliegues distintos anuncian el mismo `0.1.0`. Skyway
# inyecta `SKYWAY_DEPLOYMENT`; se publican ocho caracteres, suficientes para
# distinguirlos y sin nada dentro que interpretar.
despliegue=null
if [ -n "${SKYWAY_DEPLOYMENT:-}" ]; then
	despliegue="\"$(printf '%s' "$SKYWAY_DEPLOYMENT" | tr -cd 'a-zA-Z0-9' | cut -c1-8)\""
fi

if [ -n "$faltan" ]; then
	estado='"desconfigurado"'
else
	estado='"ok"'
fi

# ── Salidas ───────────────────────────────────────────────────────────────

json() {
	# `ok` es `true` siempre y a propósito: dice que el servidor sirve, no que
	# esté bien configurado. Eso lo dice `estado`.
	printf '{"ok":true,"estado":%s,"version":%s,"commit":%s,"configurada":%s,"revisado":"arranque","instante":"%s","despliegue":%s,"construccion":{"clave_anonima":%s,"url_api":%s,"bloqueo_min":%s},"ejecucion":{"upstream":%s,"puerto":%s,"clave_de_servicio":%s,"hook_rol":%s,"migraciones":%s},"faltan":[%s],"avisos":[%s]}\n' \
		"$estado" "$version" "$commit" "$clave_anonima" \
		"$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$despliegue" \
		"$clave_anonima" "$url_api" "$bloqueo_min" \
		"$upstream" "$puerto" "$clave_de_servicio" "$hook_rol" "$migraciones" \
		"$faltan" "$avisos"
}

# Cada línea sale en su propio `printf` y con un prefijo de exactamente ocho
# caracteres. Suena a manía y no lo es: cuando un despliegue falla, Skyway
# vuelca las últimas líneas del contenedor recortando ocho caracteres a cada
# una —da por hecha la cabecera de multiplexado de Docker, que solo lleva la
# primera línea de cada escritura—. Un `printf` por línea evita el recorte; el
# prefijo hace que, si aun así recorta, lo que se pierda sea el prefijo y no el
# mensaje.
linea() { printf '[salud] %s\n' "$1"; }

texto() {
	linea '─── configuración del despliegue ───────────────────────────'
	cabecera="version $(printf '%s' "$version" | tr -d '"') · commit $(printf '%s' "$commit" | tr -d '"') · puerto $puerto"
	if [ -n "$faltan" ]; then
		linea "FALTA CONFIGURACIÓN · $cabecera"
	elif [ -n "$avisos" ]; then
		# Ni «todo bien» ni «falta algo»: no falta nada imprescindible, pero hay
		# cosas que van a doler. Decir «todo correcto» aquí sería mentir.
		linea "sin variables ausentes, pero hay avisos · $cabecera"
	else
		linea "todo lo necesario está presente · $cabecera"
	fi
	if [ -n "$faltan_texto" ]; then
		linea "✗ faltan: $faltan_texto"
	fi
	if [ -n "$avisos_texto" ]; then
		# Uno por línea: son frases largas y apelotonadas se leen mal en el visor
		# del panel. El `\n` del `printf` importa: sin él, `read` se come el
		# último aviso al llegar al final sin salto de línea.
		printf '%s\n' "$avisos_texto" | while IFS= read -r a; do
			linea "! $a"
		done
	fi
	case "$clave_anonima" in
		false)
			linea '  La clave anónima se compila DENTRO del bundle: no basta con añadir'
			linea '  la variable y reiniciar, hay que volver a construir la imagen.'
			;;
	esac
	case "$upstream" in
		'"ausente"')
			linea '  Sin SUPABASE_UPSTREAM la PWA carga pero /rest, /auth y /storage'
			linea '  responden 503. Es host:puerto de Kong en la red privada.'
			;;
	esac
	case "$hook_rol" in
		'"sin declarar aqui"'|'"desactivado"')
			linea '  El hook del rol se declara en el servicio de AUTH, no en este.'
			linea '  Sin él el token sale sin app_role y RLS devuelve 200 [] en todo:'
			linea '  la aplicación entra, no da un error y no enseña ni una fila.'
			linea '  Para saber si llega de verdad: botón «Ver diagnóstico del servidor».'
			;;
	esac
	case "$migraciones" in
		'"fallidas"')
			linea '  Las migraciones no se han podido aplicar: la base puede no tener'
			linea '  las tablas ni las funciones que la aplicación va a pedir.'
			linea '  Relánzalas desde la terminal de este servicio con: migrar'
			;;
	esac
	if [ -n "$faltan" ] || [ -n "$avisos" ]; then
		# Se dice en voz alta para que nadie busque un fallo del arranque que no
		# existe: el servicio va a levantar igual. Tumbarlo por esto escondería
		# el problema en vez de señalarlo.
		linea 'El servicio arranca igualmente; esto no ha impedido nada.'
	fi
	linea 'Informe completo en /salud.json'
	linea '────────────────────────────────────────────────────────────'
}

# Pedir una URL con lo que haya en la imagen, que no siempre es lo mismo.
#
# Esto costó una caída entera del dominio y merece contarse. La sonda llamaba a
# `wget` a pelo. Funcionó mientras la imagen de servicio fue `caddy:2-alpine`,
# donde BusyBox lo trae; el día que pasó a `node:22-slim` —para que WeasyPrint y
# el worker de informes viajaran dentro— dejó de existir: el Dockerfile oficial
# de Node instala `wget` y `curl` para bajarse el binario y los PURGA después.
#
# A partir de ahí la sonda no fallaba «un poco»: `command not found` cae por el
# mismo `||` que «Caddy no contesta», así que el HEALTHCHECK daba ENFERMO
# siempre, con Caddy sirviendo perfectamente al otro lado.
#
# Y un contenedor enfermo no es un contenedor con una etiqueta fea: **Traefik
# lo borra del enrutador**. Su `keepContainer` descarta lo que no esté
# `healthy` y lo apunta solo en el registro de depuración, que por defecto no
# se imprime. Resultado: el dominio devolviendo 404 desde el primer despliegue
# que usó la imagen nueva, con las etiquetas correctas, la red correcta y NI UN
# ERROR en ningún registro de ninguna pieza. Se tardó una mañana en encontrarlo.
#
# Por eso ahora se pregunta qué hay antes de usarlo, y `node` cierra la lista:
# en esta imagen es lo único garantizado, porque es de lo que va la imagen.
descargar() {
	if command -v wget >/dev/null 2>&1; then
		wget -q -O - -T 3 "$1" 2>/dev/null
	elif command -v curl >/dev/null 2>&1; then
		curl -fsS --max-time 3 "$1" 2>/dev/null
	elif command -v node >/dev/null 2>&1; then
		node -e 'const r=require("http").get(process.argv[1],{timeout:3000},s=>{if(s.statusCode<200||s.statusCode>299){process.exit(1)}let d="";s.on("data",c=>d+=c);s.on("end",()=>process.stdout.write(d))});r.on("timeout",()=>{r.destroy();process.exit(1)});r.on("error",()=>process.exit(1))' "$1" 2>/dev/null
	else
		return 127
	fi
}

# La sonda del HEALTHCHECK. Solo dice enfermo cuando Caddy no sirve; una
# variable ausente sale por el cuerpo, nunca por el código de salida.
sonda() {
	cuerpo=$(descargar "http://127.0.0.1:${PORT:-8080}/salud.json")
	estado=$?

	# Sin NADA con que preguntar, la respuesta honesta es «no lo sé», y «no lo
	# sé» no puede significar «enfermo»: eso es exactamente lo que tiró el
	# dominio: el enrutador retira los contenedores enfermos, así que una sonda
	# que no puede sondear apagaría el servicio en vez de informar sobre él.
	# Se dice en voz alta y se deja pasar; el fallo, si lo hay, se verá por
	# donde tiene que verse.
	if [ "$estado" -eq 127 ]; then
		echo 'SANO (sin comprobar: no hay wget, curl ni node en esta imagen)'
		exit 0
	fi

	if [ "$estado" -ne 0 ]; then
		# Ni respuesta, o una que no es 2xx. Aquí sí: el servicio no sirve. Un
		# 404 significa que ni siquiera hay `index.html` al que caer, es decir,
		# que `/srv/dist` está vacío.
		echo "ENFERMO: Caddy no responde, o no devuelve 2xx, en el puerto ${PORT:-8080}"
		exit 1
	fi
	case "$cuerpo" in
		*'"ok":true'*) ;;
		*)
			# `try_files` devuelve el index.html de la PWA cuando el fichero no
			# está, así que un 200 aquí no prueba que el informe exista. Sin esta
			# comprobación, la sonda no podría detectar la ausencia de su propio
			# objetivo. No marca enfermo: el servicio sirve.
			echo 'SANO, pero /salud.json no es el informe (se está sirviendo index.html: el fichero no está en /srv/dist)'
			exit 0
			;;
	esac
	case "$cuerpo" in
		*'"estado":"desconfigurado"'*)
			echo "SANO pero DESCONFIGURADO, faltan: $(printf '%s' "$cuerpo" | sed -n 's/.*"faltan":\[\([^]]*\)\].*/\1/p' | sed 's/","/, /g; s/"//g')"
			exit 0
			;;
	esac
	case "$cuerpo" in
		*'"avisos":[]'*) echo 'SANO y configurado' ;;
		*) echo 'SANO y configurado, con avisos: ver /salud.json' ;;
	esac
	exit 0
}

case "${1:---json}" in
	--json) json ;;
	--texto) texto ;;
	--sonda) sonda ;;
	*)
		echo "Uso: salud [--json|--texto|--sonda]" >&2
		exit 2
		;;
esac
