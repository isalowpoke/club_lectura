-- Fase 6: reparaciones estructurales auditadas. Los pagos se reconsultan y
-- procesan despues con aplicar_pago_verificado; esta RPC no concede acceso.
begin;
alter table public.compras_extras add column legacy_external_reference text;
create unique index compras_extras_legacy on public.compras_extras(legacy_external_reference)
  where legacy_external_reference is not null;
create table public.vinculos_pagos_extras (
  mp_payment_id text primary key,
  user_id uuid not null references public.users(id),
  compra_id uuid not null references public.compras_extras(id),
  created_at timestamptz not null default now()
);
create table public.conciliaciones_pagos (
  id uuid primary key,
  user_id uuid not null references public.users(id),
  solicitud jsonb not null,
  antes jsonb not null,
  despues jsonb not null,
  respaldo_sha256 text not null check(respaldo_sha256 ~ '^[a-f0-9]{64}$'),
  estado text not null default 'aplicada' check(estado in ('aplicada','revertida')),
  created_at timestamptz not null default now(),
  reverted_at timestamptz
);
create index conciliaciones_pagos_usuario on public.conciliaciones_pagos(user_id,created_at);
create index vinculos_pagos_extras_compra on public.vinculos_pagos_extras(compra_id);
create index vinculos_pagos_extras_usuario on public.vinculos_pagos_extras(user_id);
alter table public.vinculos_pagos_extras enable row level security;
alter table public.conciliaciones_pagos enable row level security;
revoke all on public.vinculos_pagos_extras, public.conciliaciones_pagos from public, anon, authenticated;
grant select,insert,update,delete on public.vinculos_pagos_extras,public.conciliaciones_pagos to service_role;

create function public.snapshot_conciliacion(p_usuario uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'suscripciones', coalesce((select jsonb_agg(to_jsonb(s) order by sub_id) from public.suscriptions s where user_id=p_usuario),'[]'::jsonb),
    'reserva', (select to_jsonb(r) from public.reservas_cobros r where user_id=p_usuario),
    'compras', coalesce((select jsonb_agg(to_jsonb(c) order by id) from public.compras_extras c where user_id=p_usuario),'[]'::jsonb),
    'vinculos', coalesce((select jsonb_agg(to_jsonb(v) order by mp_payment_id) from public.vinculos_pagos_extras v where user_id=p_usuario),'[]'::jsonb),
    'pagos', coalesce((select jsonb_agg((to_jsonb(p)-'metadata') || jsonb_build_object('metadata_hash',md5(coalesce(metadata::text,''))) order by id) from public.pagos p where user_id=p_usuario),'[]'::jsonb),
    'verificados', coalesce((select jsonb_agg(to_jsonb(p) order by mp_payment_id) from public.pagos_verificados p where user_id=p_usuario),'[]'::jsonb),
    'extras', coalesce((select jsonb_agg(to_jsonb(e) order by id) from public.extra_sessions e where user_id=p_usuario),'[]'::jsonb)
  );
$$;

create function public.aplicar_conciliacion(p_id uuid,p_usuario uuid,p_esperado jsonb,p_datos jsonb,p_respaldo text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_antes jsonb; v_despues jsonb; v_audit public.conciliaciones_pagos;
  v_fila public.suscriptions; v_destino public.suscriptions; v_compra uuid;
begin
  -- Operacion de mantenimiento corta: sin HTTP dentro. Orden fijo y bloqueo
  -- de escrituras para comprobar el snapshot aun frente a altas/preferencias.
  lock table public.users, public.suscriptions, public.pagos, public.extra_sessions,
    public.reservas_cobros, public.compras_extras, public.pagos_verificados,
    public.vinculos_pagos_extras, public.conciliaciones_pagos in share row exclusive mode;
  select * into v_audit from public.conciliaciones_pagos where id=p_id;
  if found then
    if v_audit.user_id is distinct from p_usuario or v_audit.solicitud is distinct from p_datos
      or v_audit.estado <> 'aplicada' then raise exception 'Operacion reutilizada con otros datos o revertida'; end if;
    return jsonb_build_object('id',p_id,'repetida',true);
  end if;
  if p_respaldo is null or p_respaldo !~ '^[a-f0-9]{64}$' then raise exception 'Respaldo requerido'; end if;
  v_antes := public.snapshot_conciliacion(p_usuario);
  if v_antes is distinct from p_esperado then raise exception 'Plan obsoleto; generar otro diagnostico'; end if;
  if p_datos->>'tipo' = 'vinculo_mensual' then
    select * into strict v_fila from public.suscriptions where sub_id=(p_datos->>'sub_id')::uuid and user_id=p_usuario and plan='mensual';
    if v_fila.mp_sub_id is distinct from p_datos->>'payment_id' or v_fila.mp_sub_id !~ '^[0-9]+$'
      or exists(select 1 from public.pagos_verificados where sub_id=v_fila.sub_id) then raise exception 'Origen no reparable'; end if;
    select * into v_destino from public.suscriptions where mp_sub_id=p_datos->>'mp_sub_id';
    if found then
      if v_destino.user_id <> p_usuario or v_destino.plan <> 'mensual' or v_destino.price is distinct from v_fila.price then raise exception 'Destino discrepante'; end if;
      -- Conservar la fila falsa y su copia auditada; no borrar historial.
      update public.suscriptions set mp_sub_id=null,status='cancelled',recurrence_status='cancelled' where sub_id=v_fila.sub_id;
    else
      if nullif(p_datos->>'mp_sub_id','') is null then raise exception 'Acuerdo requerido'; end if;
      update public.suscriptions set mp_sub_id=p_datos->>'mp_sub_id',status='pending',recurrence_status=null,
        recurrence_updated_at=null,billing_anchor_at=null,billing_offset_minutes=null,next_payment_at=null where sub_id=v_fila.sub_id;
    end if;
  elsif p_datos->>'tipo' = 'alta_incierta' then
    if not exists(select 1 from public.reservas_cobros where user_id=p_usuario and estado='enviando'
      and token=(p_datos->>'token')::uuid) then raise exception 'Reserva no recuperable'; end if;
    select * into v_destino from public.suscriptions where mp_sub_id=p_datos->'acuerdo'->>'id';
    if found then
      if v_destino.user_id <> p_usuario or v_destino.plan <> 'mensual' or v_destino.price <> 80 then raise exception 'Acuerdo ajeno'; end if;
      delete from public.reservas_cobros where user_id=p_usuario;
    else
      perform public.registrar_acuerdo_cobro(p_usuario,(p_datos->>'token')::uuid,p_datos->'acuerdo');
    end if;
  elsif p_datos->>'tipo' = 'preferencia_incierta' then
    if not exists(select 1 from public.compras_extras where id=(p_datos->>'compra_id')::uuid and user_id=p_usuario
      and preference_id is null and estado in ('creando','incierta')) then raise exception 'Pedido no recuperable'; end if;
    perform public.registrar_preferencia_extra((p_datos->>'compra_id')::uuid,p_datos->>'preference_id',p_datos->>'init_point');
  elsif p_datos->>'tipo' = 'extra_historico' then
    if not exists(select 1 from public.extra_sessions where id=(p_datos->>'extra_id')::bigint and user_id=p_usuario
      and mp_pay_id=p_datos->>'payment_id' and session_id=(p_datos->>'session_id')::bigint
      and price::numeric=(p_datos->>'monto')::numeric) then raise exception 'Compra historica discrepante'; end if;
    select id into v_compra from public.compras_extras where legacy_external_reference=p_datos->>'referencia';
    if not found then
      insert into public.compras_extras(user_id,session_id,monto,moneda,estado,legacy_external_reference)
        values(p_usuario,(p_datos->>'session_id')::bigint,(p_datos->>'monto')::numeric,'MXN','rechazada',p_datos->>'referencia') returning id into v_compra;
    elsif not exists(select 1 from public.compras_extras where id=v_compra and user_id=p_usuario
      and session_id=(p_datos->>'session_id')::bigint and monto=(p_datos->>'monto')::numeric) then raise exception 'Pedido historico discrepante'; end if;
    insert into public.vinculos_pagos_extras(mp_payment_id,user_id,compra_id) values(p_datos->>'payment_id',p_usuario,v_compra);
  else raise exception 'Tipo de conciliacion invalido'; end if;
  v_despues := public.snapshot_conciliacion(p_usuario);
  insert into public.conciliaciones_pagos(id,user_id,solicitud,antes,despues,respaldo_sha256)
    values(p_id,p_usuario,p_datos,v_antes,v_despues,p_respaldo);
  return jsonb_build_object('id',p_id,'repetida',false);
end $$;

create function public.revertir_conciliacion(p_id uuid) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare v public.conciliaciones_pagos; s public.suscriptions; c public.compras_extras;
begin
  lock table public.users, public.suscriptions, public.pagos, public.extra_sessions,
    public.reservas_cobros, public.compras_extras, public.pagos_verificados,
    public.vinculos_pagos_extras, public.conciliaciones_pagos in share row exclusive mode;
  select * into strict v from public.conciliaciones_pagos where id=p_id;
  if v.estado='revertida' then return false; end if;
  if public.snapshot_conciliacion(v.user_id) is distinct from v.despues then raise exception 'Hay cambios posteriores; no revertir automaticamente'; end if;
  -- Solo revierte estructura. Si ya hubo replay/pago/webhook, el snapshot
  -- difiere y exige nueva conciliacion con MP, nunca revivir un pago viejo.
  delete from public.vinculos_pagos_extras where user_id=v.user_id;
  delete from public.compras_extras where user_id=v.user_id and id not in
    (select (x->>'id')::uuid from jsonb_array_elements(v.antes->'compras') x);
  for c in select * from jsonb_populate_recordset(null::public.compras_extras,v.antes->'compras') loop
    update public.compras_extras set preference_id=c.preference_id,init_point=c.init_point,estado=c.estado,
      updated_at=c.updated_at where id=c.id;
  end loop;
  insert into public.vinculos_pagos_extras select * from jsonb_populate_recordset(null::public.vinculos_pagos_extras,v.antes->'vinculos');
  delete from public.suscriptions where user_id=v.user_id and sub_id not in
    (select (x->>'sub_id')::uuid from jsonb_array_elements(v.antes->'suscripciones') x);
  for s in select * from jsonb_populate_recordset(null::public.suscriptions,v.antes->'suscripciones') loop
    update public.suscriptions set mp_sub_id=s.mp_sub_id,status=s.status,recurrence_status=s.recurrence_status,
      recurrence_updated_at=s.recurrence_updated_at,billing_anchor_at=s.billing_anchor_at,
      billing_offset_minutes=s.billing_offset_minutes,next_payment_at=s.next_payment_at where sub_id=s.sub_id;
  end loop;
  delete from public.reservas_cobros where user_id=v.user_id;
  if v.antes->'reserva' <> 'null'::jsonb then
    insert into public.reservas_cobros select * from jsonb_populate_record(null::public.reservas_cobros,v.antes->'reserva');
  end if;
  update public.conciliaciones_pagos set estado='revertida',reverted_at=now() where id=p_id;
  return true;
end $$;
revoke all on function public.snapshot_conciliacion(uuid), public.aplicar_conciliacion(uuid,uuid,jsonb,jsonb,text),public.revertir_conciliacion(uuid) from public,anon,authenticated;
grant execute on function public.snapshot_conciliacion(uuid), public.aplicar_conciliacion(uuid,uuid,jsonb,jsonb,text),public.revertir_conciliacion(uuid) to service_role;
commit;
