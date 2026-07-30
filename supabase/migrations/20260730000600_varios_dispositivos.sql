-- =============================================================================
-- El mismo usuario, hasta en tres dispositivos
--
-- Hasta aquí cada dispositivo exigía su propio código de alta, y eso ponía a un
-- administrador en medio de algo que no es una decisión suya: quien ya tiene la
-- aplicación en el iPad y quiere abrirla en el móvil no está pidiendo acceso
-- —ya lo tiene—, está cambiando de aparato. Cobrarle una llamada y un código de
-- 24 horas por eso hace que el segundo dispositivo sencillamente no se use.
--
-- Lo que se pide: **email + el PIN que ya tiene**. Sin código.
--
-- Y ahí está el problema de fondo, porque el PIN de este proyecto no es una
-- contraseña: no se envía, no se guarda, no tiene hash en ninguna parte. Solo
-- deriva la clave que descifra la sesión guardada EN ESE dispositivo. Un
-- dispositivo nuevo no tiene ninguna sesión que descifrar, así que el PIN, tal y
-- como estaba, no sirve para entrar desde otro sitio: no hay nada contra lo que
-- comprobarlo.
--
-- LA PIEZA QUE FALTA: LA BÓVEDA
--
-- Se guarda en el servidor un sobre que **solo el PIN abre**:
--
--   PBKDF2(PIN, salt, 310.000)  ->  clave maestra
--     HKDF(maestra, "verificador")  ->  lo que se manda al servidor a comprobar
--     HKDF(maestra, "envoltorio")   ->  AES-GCM que envuelve la contraseña real
--
-- El servidor guarda el salt, el hash del verificador y el sobre cifrado. Nunca
-- el PIN, y nunca la contraseña. Un dispositivo nuevo deriva las dos mitades del
-- PIN que le teclean, enseña el verificador, y si cuadra recibe el sobre y lo
-- abre en local. Con la contraseña dentro entra por la puerta normal de GoTrue.
--
-- Las dos mitades salen de la misma clave maestra pero por HKDF con etiquetas
-- distintas, así que **son independientes**: tener el verificador no acerca ni
-- un paso a la clave del envoltorio.
--
-- POR QUÉ ESTO NO CONVIERTE UN PIN DE CUATRO DÍGITOS EN LA LLAVE DE TODO
--
-- Cuatro dígitos son 10.000 combinaciones. Si el sobre se entregara a quien lo
-- pidiera, probarlas todas sería cuestión de minutos en una GPU y el diseño
-- entero se vendría abajo. Por eso el sobre **no se entrega nunca sin pasar por
-- el verificador**, y el verificador se comprueba aquí dentro, con contador:
-- cinco fallos bloquean cinco minutos, diez bloquean quince, quince bloquean una
-- hora. La fuerza bruta deja de ser un problema de cómputo y pasa a ser uno de
-- tiempo de pared: 10.000 intentos a ese ritmo son años.
--
-- Lo que sí cambia, y hay que decirlo claro: quien se lleve un volcado ENTERO de
-- la base —bóvedas y pimienta— puede romper un PIN de cuatro dígitos sin
-- conexión y quedarse con la contraseña de esa cuenta. En un volcado entero ya
-- se lleva `auth.users` y puede hacer lo que quiera de todos modos, así que esto
-- no abre una puerta nueva; pero es la razón por la que la aplicación recomienda
-- seis dígitos y no cuatro.
--
-- Y EL TOPE DE TRES
--
-- No es una restricción de licencia, es higiene: sin tope, un PIN filtrado se
-- convierte en un número indefinido de dispositivos que nadie sabe que existen.
-- Con tope, el cuarto no entra y alguien tiene que ir a la lista y revocar uno,
-- que es exactamente el momento en el que se descubre el dispositivo que sobra.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0 — La pimienta
--
-- Un secreto del despliegue que se mezcla con el verificador antes de guardarlo.
-- Con él, el hash de la bóveda por sí solo no vale para nada: hace falta también
-- esta tabla, que no tiene ni una política de RLS y por tanto no la lee nadie
-- desde la API. Es defensa en profundidad, no la defensa principal —esa es el
-- contador de intentos—, y por eso no complica nada más.
--
-- `gen_random_uuid()` dos veces son 256 bits del generador criptográfico de
-- Postgres. Se genera una sola vez: volver a ejecutar esta migración no la
-- cambia, y menos mal, porque cambiarla invalidaría todas las bóvedas.
-- -----------------------------------------------------------------------------

create table if not exists app_secrets (
  key        text primary key,
  value      text not null,
  created_at timestamptz not null default now()
);

comment on table app_secrets is
  'Secretos del despliegue. Sin políticas de RLS a propósito: no se leen desde la API.';

alter table app_secrets enable row level security;

insert into app_secrets (key, value)
values ('pin_pepper', gen_random_uuid()::text || gen_random_uuid()::text)
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- 1 — La bóveda
--
-- Una fila por usuario, no por dispositivo: el PIN es de la persona y vale en
-- todos sus aparatos. Cambiarlo se hace una vez y se aplica a todos.
-- -----------------------------------------------------------------------------

create table if not exists pin_vaults (
  profile_id      uuid primary key references profiles(id) on delete cascade,

  -- Parámetros de derivación. Van en la fila y no en una constante del código
  -- porque tienen que poder subir con los años sin invalidar lo ya guardado:
  -- cada bóveda recuerda con qué se derivó la suya.
  kdf_salt        text not null,
  kdf_iterations  int  not null,

  -- Lo que se compara. NUNCA el verificador en claro: su hash con pimienta.
  verifier_hash   text not null,

  -- El sobre. `wrapped_secret` es la contraseña de GoTrue cifrada con AES-GCM;
  -- sin la clave que sale del PIN es ruido, también para quien lea esta tabla.
  wrapped_iv      text not null,
  wrapped_secret  text not null,

  /*
   * La bóveda ha quedado atrás.
   *
   * Pasa cuando un administrador emite un código de alta nuevo: ese código ES la
   * contraseña de GoTrue, así que la que hay envuelta aquí deja de valer en ese
   * mismo instante. Sin esta marca, vincular un dispositivo devolvería una
   * contraseña muerta y el fallo aparecería dos pasos más adelante, en el inicio
   * de sesión, con un mensaje que no menciona el motivo real.
   *
   * La levanta un disparador sobre `enrollment_codes`, y la baja el propio
   * dispositivo que use el código: al entrar rota la contraseña a una nueva y
   * vuelve a escribir la bóveda entera.
   */
  stale           boolean not null default false,

  -- Contador de intentos fallidos. Es lo único que hace seguro un PIN corto.
  failed_attempts int not null default 0,
  last_failure_at timestamptz,
  locked_until    timestamptz,

  updated_at      timestamptz not null default now()
);

comment on table pin_vaults is
  'El sobre que abre el PIN: contraseña de la cuenta cifrada en el cliente. El servidor nunca ve ni el PIN ni la contraseña.';

alter table pin_vaults enable row level security;

-- Sin una sola política, y es deliberado: ni siquiera el dueño la lee desde
-- PostgREST. Todo entra y sale por las funciones de más abajo, que son las que
-- cuentan los intentos. Una política de lectura «solo mi fila» parecería
-- inofensiva y sería justo el agujero: convertiría el ataque en uno sin
-- conexión, sin contador y sin bloqueo.

-- -----------------------------------------------------------------------------
-- 2 — Los dispositivos, con identidad estable
--
-- `devices` existía desde el principio pero no servía para lo que ahora hace
-- falta: no había forma de saber si dos filas eran dos aparatos o el mismo
-- registrándose otra vez. Sin eso, el tope de tres se agota volviendo a entrar
-- en el mismo iPad.
--
-- `device_key` es un identificador que genera el propio dispositivo la primera
-- vez y guarda en su almacenamiento local. No identifica al aparato de verdad
-- —borrar los datos del navegador lo cambia— y eso está bien: lo que tiene que
-- hacer es que volver a entrar en el mismo sitio no consuma un hueco nuevo.
-- -----------------------------------------------------------------------------

alter table devices
  add column if not exists device_key     text,
  add column if not exists enrolled_via   text not null default 'codigo',
  add column if not exists revoked_by     uuid references profiles(id),
  add column if not exists revoked_reason text,
  add column if not exists last_seen_ua   text;

comment on column devices.device_key is
  'Identificador que genera el propio dispositivo. Evita que volver a entrar en el mismo aparato consuma otro hueco.';
comment on column devices.enrolled_via is
  '«codigo» = alta con código de un solo uso. «pin» = vinculado con el PIN desde otro dispositivo.';

-- Un aparato, una fila. Parcial porque las filas antiguas no tienen clave y no
-- por eso deben chocar entre ellas.
create unique index if not exists devices_key_idx
  on devices (profile_id, device_key)
  where device_key is not null;

-- La lista de «mis dispositivos» pregunta por los vivos de un usuario.
create index if not exists devices_activos_idx
  on devices (profile_id)
  where revoked_at is null;

/*
 * Las filas de antes no tienen clave, y hay que hacer algo con ellas.
 *
 * Dejarlas vivas sería lo peor de las dos opciones: cuentan para el tope de tres
 * y no se pueden reconocer, así que alguien con dos iPads registrados tres veces
 * cada uno se encontraría con que no le entra ninguno. Y no se pueden adoptar:
 * no hay forma de saber qué aparato es cada una.
 *
 * Así que se retiran, con el motivo escrito. No se pierde nada: el dispositivo
 * de verdad se vuelve a registrar solo la próxima vez que abra la aplicación
 * —ya tiene sesión, no le pide nada a nadie— y esta vez con clave.
 */
update devices
   set revoked_at = coalesce(revoked_at, now()),
       revoked_reason = coalesce(
         revoked_reason,
         'Registro anterior a la vinculación por PIN. El dispositivo vuelve a registrarse solo al abrir la aplicación.'
       )
 where device_key is null;

-- Cuántos dispositivos por persona. En `app_config` y no como constante porque
-- es exactamente el tipo de número que alguien querrá cambiar sin desplegar.
insert into app_config (key, value) values ('max_dispositivos', '3')
on conflict (key) do nothing;

create or replace function public.max_dispositivos()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select nullif(btrim(value), '')::int from app_config where key = 'max_dispositivos'),
    3
  )
$$;

comment on function public.max_dispositivos() is
  'Tope de dispositivos activos por usuario. Se cambia en app_config, sin desplegar.';

-- La auditoría cubre las tablas del maestro y esta nació después. Importa:
-- revocar un dispositivo es una decisión con consecuencias —alguien deja de
-- poder trabajar— y sin esto no dejaría autor por ningún lado.
drop trigger if exists devices_audit on devices;
create trigger devices_audit
  after insert or update or delete on devices
  for each row execute function public.audit_trigger();

-- -----------------------------------------------------------------------------
-- 3 — El hash del verificador
--
-- `sha256(bytea)` es del núcleo de Postgres desde la 11, así que esto no depende
-- de en qué esquema haya quedado instalada pgcrypto —que en este proyecto puede
-- ser `public` o `extensions` según por dónde se desplegara—. Un detalle
-- pequeño que evita el fallo más molesto de todos: una función que existe en
-- desarrollo y no en producción.
-- -----------------------------------------------------------------------------

create or replace function public.hash_verificador(p_verificador text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select encode(
    sha256(convert_to(
      p_verificador || ':' || (select value from app_secrets where key = 'pin_pepper'),
      'UTF8'
    )),
    'hex'
  )
$$;

revoke execute on function public.hash_verificador(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4 — Paso 1 de la vinculación: con qué derivar
--
-- El dispositivo nuevo necesita el salt y las iteraciones para poder calcular el
-- verificador. Los dos son públicos por definición —un salt no es un secreto—,
-- pero contestarlos tal cual convertiría esta función en un detector de correos:
-- «este email existe, este no». Con 17 edificios y una plantilla pequeña, eso es
-- media lista de personal.
--
-- Así que a un email desconocido se le contesta con un salt **falso y estable**,
-- derivado del propio email y de la pimienta: tiene la misma forma, el mismo
-- tamaño y sale siempre igual. Quien lo pruebe derivará un verificador
-- perfectamente formado, lo enviará, y recibirá el mismo «no cuadra» que
-- recibiría con el PIN equivocado de una cuenta real.
-- -----------------------------------------------------------------------------

create or replace function public.parametros_de_vinculacion(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_salt  text;
  v_iters int;
begin
  select v.kdf_salt, v.kdf_iterations
    into v_salt, v_iters
    from pin_vaults v
    join profiles p on p.id = v.profile_id
   where lower(p.email) = lower(btrim(p_email))
     and p.active
     and not v.stale;

  if v_salt is null then
    -- 16 bytes en base64, exactamente la forma que tiene uno de verdad.
    v_salt := encode(
      substring(
        sha256(convert_to(
          lower(btrim(coalesce(p_email, ''))) || ':salt:' ||
          (select value from app_secrets where key = 'pin_pepper'),
          'UTF8'
        )) from 1 for 16
      ),
      'base64'
    );
    v_iters := 310000;
  end if;

  return jsonb_build_object('salt', v_salt, 'iteraciones', v_iters);
end;
$$;

comment on function public.parametros_de_vinculacion(text) is
  'Salt e iteraciones con los que derivar el verificador. Contesta igual a un email que no existe.';

-- -----------------------------------------------------------------------------
-- 5 — Paso 2: el verificador a cambio del sobre
--
-- Aquí está todo lo que hace seguro el diseño, así que va en una sola función y
-- en una sola transacción: comprobar el bloqueo, comprobar el verificador,
-- contar el fallo o limpiarlo, mirar el tope de dispositivos y solo entonces
-- soltar el sobre.
--
-- El orden importa. El tope se mira ANTES de devolver nada: si el cuarto
-- dispositivo recibiera el sobre y fallara después, ya tendría la contraseña de
-- la cuenta en la mano y el tope no habría servido de nada.
--
-- Y NO SE FALLA CON `raise`. Esto es lo que hace que el contador funcione.
--
-- En PL/pgSQL, una excepción deshace todo lo que la función haya escrito en esa
-- transacción. La primera versión de esto contaba el intento fallido y a
-- continuación lanzaba «el PIN no es correcto»… lo que revertía el propio
-- contador. El resultado era un freno que parecía estar y no estaba: diez mil
-- intentos, todos con el contador a cero, exactamente el ataque sin conexión que
-- se quería impedir. Lo destapó la prueba 54 de `rls-test.sql`, que lo intenta
-- cinco veces y exige ver el bloqueo.
--
-- Así que el fallo se DEVUELVE, no se lanza. La función siempre termina bien y
-- el contador se guarda. `ok` dice si hay sobre, y `motivo` por qué no.
-- -----------------------------------------------------------------------------

create or replace function public.vincular_dispositivo(
  p_email        text,
  p_verificador  text,
  p_dispositivo  text,
  p_etiqueta     text default 'Navegador',
  p_agente       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_vault    pin_vaults%rowtype;
  v_profile  uuid;
  v_stale    boolean;
  v_fallos   int;
  v_minutos  int;
  v_activos  int;
  v_tope     int;
  v_existe   boolean;
  -- Se repite en tres sitios y tiene que ser LA MISMA en los tres: es lo que
  -- impide distinguir «ese correo no existe» de «ese PIN no es».
  c_no       constant jsonb := jsonb_build_object(
    'ok', false, 'motivo', 'credenciales',
    'mensaje', 'El correo o el PIN no son correctos.'
  );
begin
  if p_dispositivo is null or length(btrim(p_dispositivo)) < 8 then
    return jsonb_build_object(
      'ok', false, 'motivo', 'sin_dispositivo',
      'mensaje', 'Falta el identificador del dispositivo.'
    );
  end if;

  select p.id, v.stale
    into v_profile, v_stale
    from profiles p
    left join pin_vaults v on v.profile_id = p.id
   where lower(p.email) = lower(btrim(p_email))
     and p.active;

  -- Cuenta que no existe, cuenta desactivada o cuenta sin bóveda: los tres
  -- llevan al mismo sitio, y a propósito. Distinguirlos sería volver a montar el
  -- detector de correos que el paso 1 se ha molestado en evitar.
  if v_profile is null then
    return c_no;
  end if;

  -- La bóveda caducada sí se dice, y no es una inconsistencia: para llegar aquí
  -- hace falta un email real, y quien lo escribe es casi siempre el dueño.
  -- Callarlo lo mandaría a probar el PIN veinte veces contra algo que ya no
  -- puede funcionar.
  if v_stale then
    return jsonb_build_object(
      'ok', false, 'motivo', 'caducada',
      'mensaje', 'Se ha generado un código de alta nuevo para esta cuenta, así que la vinculación por PIN ya no vale. Da de alta este dispositivo con ese código.'
    );
  end if;

  select * into v_vault from pin_vaults where profile_id = v_profile for update;

  if v_vault.profile_id is null then
    return c_no;
  end if;

  if v_vault.locked_until is not null and v_vault.locked_until > now() then
    return jsonb_build_object(
      'ok', false, 'motivo', 'bloqueado',
      'minutos', greatest(1, ceil(extract(epoch from (v_vault.locked_until - now())) / 60)::int),
      'mensaje', format(
        'Demasiados intentos. Vuelve a probar en %s minutos.',
        greatest(1, ceil(extract(epoch from (v_vault.locked_until - now())) / 60)::int)
      )
    );
  end if;

  if v_vault.verifier_hash is distinct from public.hash_verificador(p_verificador) then
    -- Un fallo de hace más de un día no cuenta: quien se equivoca en marzo y
    -- vuelve a equivocarse en julio no está atacando nada, y arrastrarle el
    -- contador acabaría bloqueándole una hora por dos erratas en cuatro meses.
    v_fallos := case
      when v_vault.last_failure_at is null or v_vault.last_failure_at < now() - interval '24 hours'
        then 1
      else v_vault.failed_attempts + 1
    end;

    v_minutos := case
      when v_fallos % 5 <> 0 then null
      when v_fallos <= 5     then 5
      when v_fallos <= 10    then 15
      else 60
    end;

    update pin_vaults
       set failed_attempts = v_fallos,
           last_failure_at = now(),
           locked_until = case
             when v_minutos is null then locked_until
             else now() + make_interval(mins => v_minutos)
           end
     where profile_id = v_profile;

    if v_minutos is not null then
      return jsonb_build_object(
        'ok', false, 'motivo', 'bloqueado', 'minutos', v_minutos,
        'mensaje', format('Demasiados intentos. Vuelve a probar en %s minutos.', v_minutos)
      );
    end if;

    return c_no;
  end if;

  -- A partir de aquí el PIN es correcto. Falta el hueco.
  select exists (
    select 1 from devices
     where profile_id = v_profile
       and device_key = btrim(p_dispositivo)
       and revoked_at is null
  ) into v_existe;

  v_tope := public.max_dispositivos();
  select count(*) into v_activos
    from devices
   where profile_id = v_profile and revoked_at is null;

  if not v_existe and v_activos >= v_tope then
    -- El contador sí se limpia: el PIN era correcto y esto no es un intento
    -- fallido, es un tope. Dejarlo subido castigaría a quien acierta.
    update pin_vaults
       set failed_attempts = 0, last_failure_at = null, locked_until = null
     where profile_id = v_profile;

    return jsonb_build_object(
      'ok', false, 'motivo', 'sin_hueco', 'maximo', v_tope,
      'mensaje', format(
        'Ya tienes %s dispositivos activos, que es el máximo. Entra en uno de ellos y revoca el que no uses.',
        v_tope
      )
    );
  end if;

  update pin_vaults
     set failed_attempts = 0,
         last_failure_at = null,
         locked_until = null
   where profile_id = v_profile;

  if v_existe then
    update devices
       set last_seen_at = now(),
           label = coalesce(nullif(btrim(p_etiqueta), ''), label),
           last_seen_ua = left(p_agente, 300)
     where profile_id = v_profile and device_key = btrim(p_dispositivo);
  else
    insert into devices (profile_id, label, user_agent, device_key, enrolled_via, last_seen_at, last_seen_ua)
    values (
      v_profile,
      coalesce(nullif(btrim(p_etiqueta), ''), 'Navegador'),
      left(p_agente, 300),
      btrim(p_dispositivo),
      'pin',
      now(),
      left(p_agente, 300)
    );
  end if;

  return jsonb_build_object(
    'ok',      true,
    'iv',      v_vault.wrapped_iv,
    'secreto', v_vault.wrapped_secret
  );
end;
$$;

comment on function public.vincular_dispositivo(text, text, text, text, text) is
  'Canjea el verificador derivado del PIN por el sobre cifrado. Devuelve el fallo en vez de lanzarlo: lanzarlo revertiría el contador de intentos.';

-- -----------------------------------------------------------------------------
-- 6 — Escribir la bóveda
--
-- La escribe el propio dueño, ya autenticado, y siempre entera: el salt nuevo,
-- el verificador nuevo y el sobre nuevo se calculan juntos en el cliente y no
-- tienen sentido por separado. Escribir media bóveda dejaría una cuenta con un
-- verificador que no abre su propio sobre.
--
-- Escribirla limpia el bloqueo y la marca de caducada, que es justo lo que se
-- quiere: acabo de demostrar quién soy con una sesión válida.
-- -----------------------------------------------------------------------------

create or replace function public.guardar_boveda(
  p_salt        text,
  p_iteraciones int,
  p_verificador text,
  p_iv          text,
  p_secreto     text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Hace falta una sesión iniciada.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_iteraciones, 0) < 100000 then
    raise exception 'Iteraciones insuficientes para derivar un PIN.'
      using errcode = 'check_violation';
  end if;
  if coalesce(btrim(p_salt), '') = ''
     or coalesce(btrim(p_verificador), '') = ''
     or coalesce(btrim(p_iv), '') = ''
     or coalesce(btrim(p_secreto), '') = '' then
    raise exception 'La bóveda llega incompleta.'
      using errcode = 'check_violation';
  end if;

  insert into pin_vaults (
    profile_id, kdf_salt, kdf_iterations, verifier_hash,
    wrapped_iv, wrapped_secret, stale,
    failed_attempts, last_failure_at, locked_until, updated_at
  )
  values (
    auth.uid(), p_salt, p_iteraciones, public.hash_verificador(p_verificador),
    p_iv, p_secreto, false,
    0, null, null, now()
  )
  on conflict (profile_id) do update set
    kdf_salt        = excluded.kdf_salt,
    kdf_iterations  = excluded.kdf_iterations,
    verifier_hash   = excluded.verifier_hash,
    wrapped_iv      = excluded.wrapped_iv,
    wrapped_secret  = excluded.wrapped_secret,
    stale           = false,
    failed_attempts = 0,
    last_failure_at = null,
    locked_until    = null,
    updated_at      = now();
end;
$$;

comment on function public.guardar_boveda(text, int, text, text, text) is
  'Guarda o rehace la bóveda del usuario en sesión. Entera y de una vez.';

-- -----------------------------------------------------------------------------
-- 7 — Qué sabe la aplicación de su propia bóveda
--
-- Solo lo que necesita para decidir: si existe, si ha caducado y de cuándo es.
-- Nunca el sobre. Un dispositivo con sesión viva no tiene por qué poder
-- descargarse el material con el que atacar el PIN sin conexión.
-- -----------------------------------------------------------------------------

create or replace function public.estado_boveda()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  if auth.uid() is null then
    raise exception 'Hace falta una sesión iniciada.'
      using errcode = 'insufficient_privilege';
  end if;

  select jsonb_build_object(
           'existe',     true,
           'caducada',   b.stale,
           'actualizada', b.updated_at,
           'iteraciones', b.kdf_iterations
         )
    into v
    from pin_vaults b
   where b.profile_id = auth.uid();

  return coalesce(
    v,
    jsonb_build_object('existe', false, 'caducada', false, 'actualizada', null, 'iteraciones', null)
  ) || jsonb_build_object(
    'dispositivos', (select count(*) from devices where profile_id = auth.uid() and revoked_at is null),
    'maximo', public.max_dispositivos()
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 8 — Registrar el dispositivo que entra con código
--
-- El camino del código también respeta el tope, y también por una función: la
-- política de `insert` de `devices` deja escribir la fila propia, pero una
-- política no sabe contar filas de forma fiable frente a dos altas a la vez.
-- Aquí se cuenta con la fila bloqueada y el cuarto no entra.
-- -----------------------------------------------------------------------------

create or replace function public.registrar_dispositivo(
  p_dispositivo text,
  p_etiqueta    text default 'Navegador',
  p_agente      text default null,
  p_via         text default 'codigo'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo      uuid := auth.uid();
  v_id      uuid;
  v_activos int;
  v_tope    int;
begin
  if v_yo is null then
    raise exception 'Hace falta una sesión iniciada.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_dispositivo is null or length(btrim(p_dispositivo)) < 8 then
    raise exception 'Falta el identificador del dispositivo.'
      using errcode = 'check_violation';
  end if;

  -- Bloquea el perfil mientras se cuenta, para que dos altas simultáneas no
  -- vean las dos «solo hay dos» y entren las dos.
  perform 1 from profiles where id = v_yo for update;

  select id into v_id
    from devices
   where profile_id = v_yo and device_key = btrim(p_dispositivo) and revoked_at is null;

  if v_id is null then
    v_tope := public.max_dispositivos();
    select count(*) into v_activos from devices where profile_id = v_yo and revoked_at is null;

    if v_activos >= v_tope then
      raise exception 'Ya tienes % dispositivos activos, que es el máximo. Revoca uno desde cualquiera de ellos.', v_tope
        using errcode = 'check_violation';
    end if;

    insert into devices (profile_id, label, user_agent, device_key, enrolled_via, last_seen_at, last_seen_ua)
    values (
      v_yo,
      coalesce(nullif(btrim(p_etiqueta), ''), 'Navegador'),
      left(p_agente, 300),
      btrim(p_dispositivo),
      case when p_via in ('codigo', 'pin') then p_via else 'codigo' end,
      now(),
      left(p_agente, 300)
    )
    returning id into v_id;
  else
    update devices
       set last_seen_at = now(),
           label = coalesce(nullif(btrim(p_etiqueta), ''), label),
           last_seen_ua = left(p_agente, 300)
     where id = v_id;
  end if;

  return jsonb_build_object('id', v_id, 'maximo', public.max_dispositivos());
end;
$$;

-- -----------------------------------------------------------------------------
-- 9 — Latido: «sigo aquí» y «¿me habéis echado?»
--
-- Dos preguntas en una llamada porque se hacen en el mismo momento —al
-- sincronizar— y separarlas sería una petición más por cada bajada.
--
-- La revocación se resuelve así, en el cliente, y conviene ser honesto sobre lo
-- que eso significa: el refresh token del dispositivo revocado sigue siendo
-- válido para GoTrue hasta que caduque. Revocar aquí es «este dispositivo deja
-- de usarse y se borra a sí mismo la sesión guardada», no una expulsión que el
-- servidor pueda imponer. Para eso hace falta la orden de administración, que
-- rota la contraseña y emite un código nuevo.
-- -----------------------------------------------------------------------------

create or replace function public.latido_dispositivo(p_dispositivo text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yo      uuid := auth.uid();
  v_revocado timestamptz;
  v_hay     boolean;
begin
  if v_yo is null then
    raise exception 'Hace falta una sesión iniciada.'
      using errcode = 'insufficient_privilege';
  end if;

  select true, revoked_at
    into v_hay, v_revocado
    from devices
   where profile_id = v_yo and device_key = btrim(p_dispositivo)
   order by enrolled_at desc
   limit 1;

  if v_hay and v_revocado is null then
    update devices
       set last_seen_at = now()
     where profile_id = v_yo and device_key = btrim(p_dispositivo) and revoked_at is null;
  end if;

  return jsonb_build_object(
    'registrado', coalesce(v_hay, false),
    'revocado',   v_revocado is not null
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 10 — Revocar
--
-- El dueño revoca los suyos; un coordinador, los de cualquiera —es quien recibe
-- la llamada de «he perdido el iPad»—. No se borra la fila: queda con fecha y
-- autor, que es lo que convierte «faltan dispositivos» en «lo quitó Ana el 4».
-- -----------------------------------------------------------------------------

create or replace function public.revocar_dispositivo(p_id uuid, p_motivo text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dueno uuid;
begin
  select profile_id into v_dueno from devices where id = p_id;
  if v_dueno is null then
    raise exception 'Ese dispositivo no existe.';
  end if;
  if v_dueno <> auth.uid() and not public.is_supervisor() then
    raise exception 'Solo puedes revocar tus dispositivos.'
      using errcode = 'insufficient_privilege';
  end if;

  update devices
     set revoked_at = now(),
         revoked_by = auth.uid(),
         revoked_reason = nullif(btrim(p_motivo), '')
   where id = p_id and revoked_at is null;
end;
$$;

-- -----------------------------------------------------------------------------
-- 11 — El código nuevo caduca la bóveda
--
-- `alta codigo ana@x.es` rota la contraseña de GoTrue al código recién emitido.
-- La bóveda envuelve la contraseña ANTERIOR, así que a partir de ese instante
-- contiene algo que ya no abre nada.
--
-- Se marca en vez de borrarse para poder decir POR QUÉ no funciona. Una bóveda
-- borrada y una cuenta que nunca tuvo bóveda se ven igual desde fuera, y el
-- mensaje que le toca a cada una es distinto.
-- -----------------------------------------------------------------------------

create or replace function public.caducar_boveda()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update pin_vaults set stale = true, updated_at = now()
   where profile_id = new.profile_id;
  return new;
end;
$$;

drop trigger if exists enrollment_codes_caducan_boveda on enrollment_codes;
create trigger enrollment_codes_caducan_boveda
  after insert on enrollment_codes
  for each row execute function public.caducar_boveda();

-- -----------------------------------------------------------------------------
-- 12 — Permisos
--
-- `alter default privileges … grant execute on functions to anon` (bootstrap)
-- hace que toda función nazca ejecutable por anónimos, así que los dos pasos de
-- la vinculación ya lo son y no hay que conceder nada. Lo que sí hay que hacer
-- es lo contrario: quitar de en medio las que no deben serlo.
-- -----------------------------------------------------------------------------

grant  execute on function public.parametros_de_vinculacion(text) to anon, authenticated;
grant  execute on function public.vincular_dispositivo(text, text, text, text, text) to anon, authenticated;
grant  execute on function public.guardar_boveda(text, int, text, text, text) to authenticated;
grant  execute on function public.estado_boveda() to authenticated;
grant  execute on function public.registrar_dispositivo(text, text, text, text) to authenticated;
grant  execute on function public.latido_dispositivo(text) to authenticated;
grant  execute on function public.revocar_dispositivo(uuid, text) to authenticated;
grant  execute on function public.max_dispositivos() to anon, authenticated;

revoke execute on function public.guardar_boveda(text, int, text, text, text) from anon;
revoke execute on function public.estado_boveda() from anon;
revoke execute on function public.registrar_dispositivo(text, text, text, text) from anon;
revoke execute on function public.latido_dispositivo(text) from anon;
revoke execute on function public.revocar_dispositivo(uuid, text) from anon;

-- Y la vista que enseña «mis dispositivos» sin exponer el agente de usuario
-- entero en la lista: el nombre del navegador basta para reconocer un aparato, y
-- la cadena completa ocupa tres líneas y no dice nada más.
create or replace view mis_dispositivos as
select
  d.id,
  d.profile_id,
  d.label,
  d.enrolled_via,
  d.enrolled_at,
  d.last_seen_at,
  d.revoked_at,
  d.revoked_reason,
  p.full_name as revocado_por,
  d.device_key
from devices d
left join profiles p on p.id = d.revoked_by;

alter view mis_dispositivos set (security_invoker = on);

comment on view mis_dispositivos is
  'Los dispositivos que ve cada persona: los suyos, y todos si es coordinador (lo decide la RLS de devices).';

notify pgrst, 'reload schema';
