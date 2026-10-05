-- Solo lectura. Ejecutar en el SQL Editor del proyecto para contrastar el
-- esquema real con el de pruebas. No lee filas de usuarios ni de pagos.
begin transaction read only;
with tablas as (
  select c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','p')
    and c.relname in ('users','sessions','suscriptions','pagos','extra_sessions',
      'reservas_cobros','compras_extras','pagos_verificados','vinculos_pagos_extras','conciliaciones_pagos')
), detalle as (
  select t.relname, jsonb_build_object(
    'tabla', t.relname, 'rls', t.relrowsecurity, 'force_rls', t.relforcerowsecurity,
    'columnas', (select jsonb_agg(jsonb_build_object('nombre', a.attname,
      'tipo', pg_catalog.format_type(a.atttypid,a.atttypmod), 'not_null', a.attnotnull,
      'identidad', a.attidentity, 'default', pg_catalog.pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
      from pg_catalog.pg_attribute a left join pg_catalog.pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid=t.oid and a.attnum>0 and not a.attisdropped),
    'restricciones', (select jsonb_agg(jsonb_build_object('nombre', c.conname,
      'definicion', pg_catalog.pg_get_constraintdef(c.oid))) from pg_catalog.pg_constraint c where c.conrelid=t.oid),
    'indices', (select jsonb_agg(pg_catalog.pg_get_indexdef(i.indexrelid)) from pg_catalog.pg_index i where i.indrelid=t.oid),
    'politicas', (select jsonb_agg(to_jsonb(p)) from pg_catalog.pg_policies p where p.schemaname='public' and p.tablename=t.relname),
    'permisos', (select jsonb_agg(to_jsonb(g)) from information_schema.role_table_grants g where g.table_schema='public' and g.table_name=t.relname),
    'triggers', (select jsonb_agg(jsonb_build_object('nombre', tr.tgname,
      'habilitado', tr.tgenabled, 'definicion', pg_catalog.pg_get_triggerdef(tr.oid),
      'funcion', tr.tgfoid::regprocedure::text)) from pg_catalog.pg_trigger tr where tr.tgrelid=t.oid and not tr.tgisinternal)
  ) datos from tablas t
)
select jsonb_build_object('version', version(), 'tablas', (select jsonb_agg(datos order by relname) from detalle),
  'funciones_de_triggers', (select jsonb_agg(jsonb_build_object('funcion', p.oid::regprocedure::text,
    'definicion', pg_catalog.pg_get_functiondef(p.oid))) from pg_catalog.pg_proc p
    where p.oid in (select tr.tgfoid from pg_catalog.pg_trigger tr join tablas t on t.oid=tr.tgrelid where not tr.tgisinternal))
) as esquema_pagos;
rollback;
