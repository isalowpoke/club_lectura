-- Fase 7. Instala la proteccion de escrituras nuevas. La limpieza historica
-- es explicita y por lotes mediante limpiar_metadata_pagos; no corre al migrar.
begin;
create function public.metadata_minima_pago(p_datos jsonb) returns jsonb
language plpgsql immutable security invoker set search_path = '' as $$
declare v jsonb := p_datos; r jsonb := '{}'::jsonb; clave text; valor jsonb;
begin
  if jsonb_typeof(v)='string' then
    begin v := (v #>> '{}')::jsonb; exception when others then return r; end;
  end if;
  if jsonb_typeof(v) is distinct from 'object' then return r; end if;
  foreach clave in array array['preapproval_id','authorized_payment_id','preference_id','merchant_order_id'] loop
    valor := coalesce(nullif(v->clave,'null'::jsonb),nullif(v->'metadata'->clave,'null'::jsonb));
    if clave='merchant_order_id' then valor := coalesce(valor,v->'order'->'id'); end if;
    if jsonb_typeof(valor) in ('string','number') and (valor #>> '{}') ~ '^[a-zA-Z0-9-]{1,100}$' then
      r := r || jsonb_build_object(clave,valor #>> '{}');
    end if;
  end loop;
  if jsonb_typeof(v->'status_detail')='string' and v->>'status_detail' ~ '^[a-z0-9_]{1,100}$' then
    r := r || jsonb_build_object('status_detail',v->'status_detail');
  end if;
  if jsonb_typeof(v->'live_mode')='boolean' then r := r || jsonb_build_object('live_mode',v->'live_mode'); end if;
  if jsonb_typeof(v->'date_approved')='string' and v->>'date_approved' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' then
    r := r || jsonb_build_object('date_approved',v->'date_approved');
  end if;
  valor := coalesce(nullif(v->'reembolsado','null'::jsonb),v->'transaction_amount_refunded');
  if jsonb_typeof(valor) in ('number','string') and (valor #>> '{}') ~ '^\d{1,12}(\.\d{1,2})?$' then
    r := r || jsonb_build_object('reembolsado',(valor #>> '{}')::numeric);
  end if;
  return r;
end $$;

create function public.restringir_metadata_pago() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin new.metadata := public.metadata_minima_pago(new.metadata); return new; end $$;
create trigger pagos_metadata_minima before insert or update of metadata on public.pagos
  for each row execute function public.restringir_metadata_pago();

create function public.limpiar_metadata_pagos(p_limite integer default 100,p_aplicar boolean default false) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare fila record; total bigint; procesados integer := 0;
begin
  if p_limite is null or p_limite < 1 or p_limite > 500 or p_aplicar is null then raise exception 'Parametros de limpieza invalidos'; end if;
  select count(*) into total from public.pagos where metadata is distinct from public.metadata_minima_pago(metadata);
  if p_aplicar then
    for fila in select id from public.pagos where metadata is distinct from public.metadata_minima_pago(metadata)
      order by id limit p_limite for update skip locked loop
      update public.pagos set metadata=public.metadata_minima_pago(metadata) where id=fila.id;
      procesados := procesados + 1;
    end loop;
  end if;
  return jsonb_build_object('detectados',total,'procesados',procesados,'simulacion',not p_aplicar);
end $$;
revoke all on function public.metadata_minima_pago(jsonb),public.restringir_metadata_pago(),public.limpiar_metadata_pagos(integer,boolean) from public,anon,authenticated;
grant execute on function public.metadata_minima_pago(jsonb),public.restringir_metadata_pago(),public.limpiar_metadata_pagos(integer,boolean) to service_role;
commit;
