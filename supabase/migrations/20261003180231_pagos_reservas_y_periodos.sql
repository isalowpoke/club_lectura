-- Fases 3-4. Ejecutar primero en BD aislada. No repara datos historicos.
begin;
alter table public.suscriptions
  add column if not exists recurrence_status text,
  add column if not exists recurrence_updated_at timestamptz,
  add column if not exists billing_anchor_at timestamptz,
  add column if not exists billing_offset_minutes smallint,
  add column if not exists next_payment_at timestamptz;
create unique index if not exists suscriptions_mp_sub_id_unico
  on public.suscriptions(mp_sub_id) where mp_sub_id is not null;

create table public.reservas_cobros (
  user_id uuid primary key references public.users(id),
  token uuid not null,
  estado text not null check (estado in ('reservada','enviando')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.compras_extras (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id),
  session_id bigint not null references public.sessions(id),
  monto numeric(12,2) not null check (monto > 0),
  moneda text not null default 'MXN' check (moneda = 'MXN'),
  estado text not null check (estado in ('creando','lista','incierta','pagada','rechazada')),
  preference_id text unique,
  init_point text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index compras_extras_vigente on public.compras_extras(user_id, session_id)
  where estado <> 'rechazada';

create table public.pagos_verificados (
  mp_payment_id text primary key,
  user_id uuid not null references public.users(id),
  sub_id uuid references public.suscriptions(sub_id),
  factura_id text,
  compra_extra_id uuid references public.compras_extras(id),
  monto numeric(12,2) not null check (monto > 0),
  moneda text not null check (moneda = 'MXN'),
  estado_mp text not null check (estado_mp in ('pending','in_process','authorized','approved','rejected','cancelled','refunded','charged_back','in_mediation')),
  reembolsado numeric(12,2) not null default 0 check (reembolsado >= 0 and reembolsado <= monto),
  periodo_inicio timestamptz,
  periodo_fin timestamptz,
  mp_updated_at timestamptz not null,
  requiere_revision boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((sub_id is not null and factura_id is not null and compra_extra_id is null
    and periodo_inicio is not null and periodo_fin is not null and periodo_fin > periodo_inicio)
    or (sub_id is null and factura_id is null and compra_extra_id is not null
    and periodo_inicio is null and periodo_fin is null))
);
create index pagos_verificados_usuario_periodo on public.pagos_verificados(user_id, periodo_fin);
create index pagos_verificados_acuerdo_periodo on public.pagos_verificados(sub_id, periodo_inicio);
create index pagos_verificados_compra on public.pagos_verificados(compra_extra_id);
alter table public.reservas_cobros enable row level security;
alter table public.compras_extras enable row level security;
alter table public.pagos_verificados enable row level security;
revoke all on public.reservas_cobros, public.compras_extras, public.pagos_verificados from public, anon, authenticated;
grant select, insert, update, delete on public.reservas_cobros, public.compras_extras, public.pagos_verificados to service_role;

create function public.reservar_cobro(p_usuario uuid, p_token uuid) returns boolean
language plpgsql security invoker set search_path = '' as $$
begin
  insert into public.reservas_cobros(user_id, token, estado, expires_at)
    values(p_usuario, p_token, 'reservada', now() + interval '60 seconds')
    on conflict(user_id) do update set token = excluded.token, estado = 'reservada',
      expires_at = excluded.expires_at, updated_at = now()
      where reservas_cobros.estado = 'reservada' and reservas_cobros.expires_at < now();
  return found;
end $$;

create function public.marcar_envio_cobro(p_usuario uuid, p_token uuid) returns boolean
language plpgsql security invoker set search_path = '' as $$
begin
  update public.reservas_cobros set estado = 'enviando', updated_at = now()
    where user_id = p_usuario and token = p_token and estado = 'reservada' and expires_at > now();
  return found;
end $$;

create function public.liberar_reserva_cobro(p_usuario uuid, p_token uuid) returns boolean
language plpgsql security invoker set search_path = '' as $$
begin
  -- No liberar automaticamente un POST cuyo resultado remoto puede ser incierto.
  delete from public.reservas_cobros where user_id = p_usuario and token = p_token and estado = 'reservada';
  return found;
end $$;

create function public.registrar_acuerdo_cobro(p_usuario uuid, p_token uuid, p_acuerdo jsonb) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare v_id uuid;
begin
  perform 1 from public.reservas_cobros where user_id = p_usuario and token = p_token and estado = 'enviando' for update;
  if not found then raise exception 'Reserva de alta no disponible'; end if;
  insert into public.suscriptions(user_id, plan, status, mp_sub_id, price, recurrence_status,
    recurrence_updated_at, billing_anchor_at, billing_offset_minutes, next_payment_at)
    values(p_usuario, 'mensual', 'pending', p_acuerdo->>'id', 80, p_acuerdo->>'status',
      (p_acuerdo->>'last_modified')::timestamptz, (p_acuerdo->>'start_date')::timestamptz,
      (p_acuerdo->>'offset_minutes')::smallint,
      (p_acuerdo->>'next_payment_date')::timestamptz) returning sub_id into v_id;
  delete from public.reservas_cobros where user_id = p_usuario and token = p_token;
  return v_id;
end $$;

create function public.estado_acceso_pagos(p_usuario uuid, p_ahora timestamptz default now()) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_acceso jsonb; v_gracia boolean := false; v_gracia_vencida boolean := false; v_acuerdos jsonb;
begin
  -- Un periodo aprobado conserva acceso aunque su acuerdo ya este cancelado.
  select to_jsonb(s) || jsonb_build_object('end_date', p.periodo_fin, 'init_date', p.periodo_inicio)
    into v_acceso from public.pagos_verificados p join public.suscriptions s using(sub_id)
    where p.user_id = p_usuario and p.estado_mp = 'approved' and p.reembolsado < p.monto
      and p.periodo_inicio <= p_ahora and p.periodo_fin > p_ahora
    order by p.periodo_fin desc, p.mp_payment_id limit 1;
  if v_acceso is null then
    select to_jsonb(s) into v_acceso from public.suscriptions s
      where s.user_id = p_usuario and s.plan = 'gratis' and s.status = 'active'
      and s.init_date <= p_ahora at time zone 'UTC' and s.end_date > p_ahora at time zone 'UTC'
      order by s.end_date desc, s.sub_id limit 1;
  end if;
  if v_acceso is null then
    select to_jsonb(s) || jsonb_build_object('end_date', anterior.periodo_fin + interval '7 days')
      into v_acceso
      from public.pagos_verificados anterior join public.suscriptions s using(sub_id)
      where anterior.user_id = p_usuario and anterior.estado_mp = 'approved' and anterior.reembolsado < anterior.monto
        and s.recurrence_status = 'authorized' and anterior.periodo_fin <= p_ahora
        and anterior.periodo_fin + interval '7 days' > p_ahora
        and exists(select 1 from public.pagos_verificados fallo where fallo.sub_id = anterior.sub_id
          and fallo.periodo_inicio = anterior.periodo_fin and fallo.estado_mp = 'rejected')
        and not exists(select 1 from public.pagos_verificados resuelto where resuelto.sub_id = anterior.sub_id
          and resuelto.periodo_inicio = anterior.periodo_fin and resuelto.estado_mp in ('approved','refunded','charged_back'))
      order by anterior.periodo_fin desc, anterior.mp_payment_id limit 1;
    v_gracia := v_acceso is not null;
  end if;
  if v_acceso is null then
    select exists(select 1 from public.pagos_verificados p join public.suscriptions s using(sub_id)
      where p.user_id = p_usuario and s.recurrence_status = 'authorized' and p.estado_mp = 'rejected'
      and p.periodo_inicio + interval '7 days' <= p_ahora
      and exists(select 1 from public.pagos_verificados previo where previo.sub_id = p.sub_id
        and previo.estado_mp = 'approved' and previo.reembolsado < previo.monto and previo.periodo_fin = p.periodo_inicio)
      and not exists(select 1 from public.pagos_verificados resuelto where resuelto.sub_id = p.sub_id
        and resuelto.periodo_inicio = p.periodo_inicio and resuelto.estado_mp in ('approved','refunded','charged_back')))
      into v_gracia_vencida;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('mp_sub_id', s.mp_sub_id,
    'recurrence_status', s.recurrence_status, 'next_payment_at', s.next_payment_at,
    'ultimo_estado_pago', (select p.estado_mp from public.pagos_verificados p where p.sub_id = s.sub_id
      order by p.periodo_inicio desc, p.mp_updated_at desc, p.mp_payment_id limit 1))), '[]'::jsonb)
    into v_acuerdos from public.suscriptions s where s.user_id = p_usuario and s.plan = 'mensual'
      and s.mp_sub_id is not null and (s.recurrence_status is null or s.recurrence_status <> 'cancelled');
  return jsonb_build_object('suscripcion', v_acceso, 'tieneAcceso', v_acceso is not null,
    'enGracia', v_gracia, 'graciaVencida', v_gracia_vencida, 'acuerdos', v_acuerdos,
    'operacionPendiente', exists(select 1 from public.reservas_cobros where user_id = p_usuario and estado = 'enviando'));
end $$;

create function public.sincronizar_acuerdo_cobro(p_usuario uuid, p_acuerdo jsonb) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare v_fila public.suscriptions; v_estado text := p_acuerdo->>'status'; v_fecha timestamptz := (p_acuerdo->>'last_modified')::timestamptz;
begin
  perform 1 from public.users where id = p_usuario for update;
  select * into strict v_fila from public.suscriptions where mp_sub_id = p_acuerdo->>'id' and user_id = p_usuario and plan = 'mensual' for update;
  if v_fecha is null or v_estado not in ('pending','authorized','paused','cancelled') then raise exception 'Acuerdo incompleto'; end if;
  if v_fila.recurrence_updated_at > v_fecha or (v_fila.recurrence_status = 'cancelled' and v_estado <> 'cancelled') then return false; end if;
  update public.suscriptions set recurrence_status = v_estado, recurrence_updated_at = v_fecha,
    next_payment_at = case when v_estado = 'authorized' then (p_acuerdo->>'next_payment_date')::timestamptz else null end,
    billing_anchor_at = coalesce(billing_anchor_at, (p_acuerdo->>'start_date')::timestamptz),
    billing_offset_minutes = coalesce(billing_offset_minutes, (p_acuerdo->>'offset_minutes')::smallint),
    status = case when v_estado in ('cancelled','paused') then v_estado else 'pending' end
    where sub_id = v_fila.sub_id;
  update public.users set role = case when (public.estado_acceso_pagos(p_usuario)->>'tieneAcceso')::boolean then 'suscriptor' else 'free' end where id = p_usuario and role is distinct from 'admin';
  return true;
end $$;

create function public.reservar_compra_extra(p_usuario uuid, p_sesion bigint) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_compra public.compras_extras; v_sesion public.sessions;
begin
  perform 1 from public.users where id = p_usuario for update;
  if not found then raise exception 'Usuario inexistente'; end if;
  select * into v_compra from public.compras_extras where user_id = p_usuario and session_id = p_sesion and estado <> 'rechazada';
  if found then return to_jsonb(v_compra) || '{"nueva":false}'::jsonb; end if;
  if exists(select 1 from public.extra_sessions where user_id = p_usuario and session_id = p_sesion and status <> 'rechazada') then
    raise exception 'Compra previa pendiente de conciliar';
  end if;
  select * into strict v_sesion from public.sessions where id = p_sesion and type = 'especial';
  if v_sesion.price is null or v_sesion.price <= 0 then raise exception 'Precio de sesion invalido'; end if;
  insert into public.compras_extras(user_id, session_id, monto, estado)
    values(p_usuario, p_sesion, v_sesion.price, 'creando') returning * into v_compra;
  return to_jsonb(v_compra) || '{"nueva":true}'::jsonb;
end $$;

create function public.registrar_preferencia_extra(p_compra uuid, p_preferencia text, p_url text) returns boolean
language plpgsql security invoker set search_path = '' as $$
begin
  update public.compras_extras set preference_id = p_preferencia, init_point = p_url,
    estado = case when estado in ('creando','incierta') then 'lista' else estado end, updated_at = now()
    where id = p_compra and (preference_id is null or preference_id = p_preferencia);
  if not found then raise exception 'Compra no disponible'; end if;
  return true;
end $$;

create function public.aplicar_pago_verificado(p_pago jsonb) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
  v_usuario uuid := (p_pago->>'user_id')::uuid;
  v_sub uuid := (p_pago->>'sub_id')::uuid;
  v_compra uuid := (p_pago->>'compra_extra_id')::uuid;
  v_id text := p_pago->>'mp_payment_id';
  v_fecha timestamptz := (p_pago->>'mp_updated_at')::timestamptz;
  v_anterior public.pagos_verificados;
  v_orden public.compras_extras;
  v_mejor public.pagos_verificados;
  v_extra public.extra_sessions;
  v_historial public.pagos;
  v_status text;
begin
  -- El ID de MP es global: el bloqueo por usuario no serializa dos duenos
  -- distintos que intentan insertar el mismo ID aun no confirmado por el otro.
  -- Siempre tomar este bloqueo antes del usuario, sin llamadas externas en SQL.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('club:payment:' || v_id, 0));
  -- Todas las mutaciones del usuario comparten el mismo orden de bloqueo.
  perform 1 from public.users where id = v_usuario for update;
  if not found then raise exception 'Usuario inexistente'; end if;
  if v_sub is not null then
    perform 1 from public.suscriptions where sub_id = v_sub and user_id = v_usuario and plan = 'mensual'
      and price::numeric = (p_pago->>'monto')::numeric for update;
    if not found then raise exception 'Suscripcion o precio discrepante'; end if;
  else
    select * into strict v_orden from public.compras_extras where id = v_compra and user_id = v_usuario for update;
    if v_orden.monto <> (p_pago->>'monto')::numeric or v_orden.moneda <> p_pago->>'moneda' then raise exception 'Compra discrepante'; end if;
  end if;
  select * into v_anterior from public.pagos_verificados where mp_payment_id = v_id for update;
  if found then
    if v_anterior.user_id <> v_usuario or v_anterior.sub_id is distinct from v_sub or v_anterior.compra_extra_id is distinct from v_compra
      or v_anterior.factura_id is distinct from p_pago->>'factura_id'
      or v_anterior.monto is distinct from (p_pago->>'monto')::numeric
      or v_anterior.moneda is distinct from p_pago->>'moneda'
      or v_anterior.periodo_inicio is distinct from (p_pago->>'periodo_inicio')::timestamptz
      or v_anterior.periodo_fin is distinct from (p_pago->>'periodo_fin')::timestamptz then raise exception 'Identidad de pago inmutable'; end if;
    if v_anterior.mp_updated_at > v_fecha then return false; end if;
    if v_anterior.estado_mp in ('refunded','charged_back') and p_pago->>'estado_mp' not in ('refunded','charged_back') then return false; end if;
    if v_anterior.estado_mp = 'approved' and p_pago->>'estado_mp' in ('pending','in_process','authorized','rejected','cancelled') then return false; end if;
  end if;
  select * into v_historial from public.pagos where mp_payment_id = v_id for update;
  if found and (v_historial.user_id is distinct from v_usuario
    or v_historial.sesion_id is distinct from v_orden.session_id
    or v_historial.monto is distinct from (p_pago->>'monto')::numeric
    or v_historial.moneda is distinct from p_pago->>'moneda'
    or v_historial.tipo is distinct from case when v_sub is null then 'sesion_extra' else 'suscripcion' end) then
    raise exception 'Identidad del historial discrepante; requiere conciliacion';
  end if;
  insert into public.pagos_verificados(mp_payment_id, user_id, sub_id, factura_id, compra_extra_id,
    monto, moneda, estado_mp, reembolsado, periodo_inicio, periodo_fin, mp_updated_at, requiere_revision)
    values(v_id, v_usuario, v_sub, p_pago->>'factura_id', v_compra, (p_pago->>'monto')::numeric, p_pago->>'moneda',
      p_pago->>'estado_mp', (p_pago->>'reembolsado')::numeric, (p_pago->>'periodo_inicio')::timestamptz,
      (p_pago->>'periodo_fin')::timestamptz, v_fecha, (p_pago->>'reembolsado')::numeric > 0)
    on conflict(mp_payment_id) do update set estado_mp = excluded.estado_mp, reembolsado = greatest(pagos_verificados.reembolsado, excluded.reembolsado),
      mp_updated_at = excluded.mp_updated_at, requiere_revision = pagos_verificados.requiere_revision or excluded.requiere_revision, updated_at = now();
  insert into public.pagos(mp_payment_id, user_id, sesion_id, monto, moneda, estado_mp, tipo, metadata, created_at)
    values(v_id, v_usuario, v_orden.session_id, (p_pago->>'monto')::numeric, p_pago->>'moneda', p_pago->>'estado_mp',
      case when v_sub is null then 'sesion_extra' else 'suscripcion' end, p_pago->'metadata', (p_pago->>'created_at')::timestamptz)
    on conflict(mp_payment_id) do update set estado_mp = excluded.estado_mp, metadata = excluded.metadata;
  if v_sub is null then
    -- Resolver la compra por pagos aprobados, no por el ultimo webhook recibido.
    select p.* into v_mejor from public.pagos_verificados p join public.compras_extras c on c.id = p.compra_extra_id
      where c.user_id = v_usuario and c.session_id = v_orden.session_id
      order by (p.estado_mp = 'approved' and p.reembolsado < p.monto) desc, p.mp_updated_at desc, p.mp_payment_id limit 1;
    v_status := case when v_mejor.estado_mp = 'approved' and v_mejor.reembolsado < v_mejor.monto then 'pagada'
      when v_mejor.estado_mp in ('rejected','cancelled','refunded','charged_back') or v_mejor.reembolsado = v_mejor.monto then 'rechazada' else 'pending' end;
    select * into v_extra from public.extra_sessions where mp_pay_id = v_mejor.mp_payment_id for update;
    if found then
      update public.extra_sessions set status = 'rechazada'
        where user_id = v_usuario and session_id = v_orden.session_id and id <> v_extra.id and status <> 'rechazada';
      update public.extra_sessions set status = v_status, price = v_mejor.monto where id = v_extra.id;
    else
      select * into v_extra from public.extra_sessions where user_id = v_usuario and session_id = v_orden.session_id
        and status <> 'rechazada' for update;
      if found then
        update public.extra_sessions set mp_pay_id = v_mejor.mp_payment_id, status = v_status, price = v_mejor.monto where id = v_extra.id;
      else
        insert into public.extra_sessions(user_id, session_id, mp_pay_id, status, price, pur_date)
          values(v_usuario, v_orden.session_id, v_mejor.mp_payment_id, v_status, v_mejor.monto, now() at time zone 'UTC');
      end if;
    end if;
    -- Conservar todos los cobros y marcar un segundo aprobado para revision, sin reembolsar automaticamente.
    update public.pagos_verificados p set requiere_revision = true
      from public.compras_extras pedido
      where pedido.id = p.compra_extra_id and pedido.user_id = v_usuario and pedido.session_id = v_orden.session_id
      and p.estado_mp = 'approved' and p.reembolsado < p.monto
      and (select count(*) from public.pagos_verificados x join public.compras_extras c on c.id = x.compra_extra_id
        where c.user_id = v_usuario and c.session_id = v_orden.session_id and x.estado_mp = 'approved' and x.reembolsado < x.monto) > 1;
    if v_status = 'pagada' then
      -- Un intento antiguo puede aprobarse despues de abrir otro pedido. Primero
      -- cerrar el pedido alternativo para respetar la unicidad de compra vigente.
      update public.compras_extras set estado = 'rechazada', updated_at = now()
        where user_id = v_usuario and session_id = v_orden.session_id and id <> v_mejor.compra_extra_id;
      update public.compras_extras set estado = 'pagada', updated_at = now() where id = v_mejor.compra_extra_id;
    else
      update public.compras_extras set estado = case when v_status = 'pending' then 'lista' else v_status end,
        updated_at = now() where id = v_compra
        -- Un pending de un pedido viejo no desplaza otra preferencia vigente.
        and (v_status <> 'pending' or not exists(select 1 from public.compras_extras otro
          where otro.user_id = v_usuario and otro.session_id = v_orden.session_id
          and otro.id <> v_compra and otro.estado <> 'rechazada'));
    end if;
  end if;
  update public.users set role = case when (public.estado_acceso_pagos(v_usuario)->>'tieneAcceso')::boolean then 'suscriptor' else 'free' end where id = v_usuario and role is distinct from 'admin';
  return true;
end $$;

-- RPC exclusivamente del backend. Ninguna funcion eleva privilegios ni usa auth.user_metadata.
do $$ declare f record; begin
  for f in select p.oid::regprocedure firma from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('reservar_cobro','marcar_envio_cobro','liberar_reserva_cobro',
      'registrar_acuerdo_cobro','estado_acceso_pagos','sincronizar_acuerdo_cobro','reservar_compra_extra',
      'registrar_preferencia_extra','aplicar_pago_verificado')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.firma);
    execute format('grant execute on function %s to service_role', f.firma);
  end loop;
end $$;
commit;
