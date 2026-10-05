import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as esperar } from 'node:timers/promises';
import { iniciarPostgres } from './helpers/postgres-aislado.js';
import { esquemaBase } from './helpers/esquema-pagos.js';

const USUARIO = '11111111-1111-4111-8111-111111111111';
const OTRO = '33333333-3333-4333-8333-333333333333';
const SUB = '22222222-2222-4222-8222-222222222222';
const SUB2 = '44444444-4444-4444-8444-444444444444';
let cluster; let admin; let a; let b;
const rpc = async (c, nombre, valores) => (await c.query(
  `select public.${nombre}(${valores.map((_, i) => `$${i + 1}`).join(',')}) as data`, valores)).rows[0].data;
const pago = (cambios = {}) => ({ mp_payment_id: '1234', user_id: USUARIO, sub_id: SUB,
  factura_id: '7890', compra_extra_id: null, monto: 80, moneda: 'MXN', estado_mp: 'approved',
  reembolsado: 0, periodo_inicio: '2026-10-03T00:00:00Z', periodo_fin: '2026-11-03T00:00:00Z',
  mp_updated_at: '2026-10-03T00:00:00Z', created_at: '2026-10-03T00:00:00Z', metadata: {}, ...cambios });
const aplicar = (c, datos = pago()) => rpc(c, 'aplicar_pago_verificado', [datos]);

before(async () => {
  cluster = await iniciarPostgres();
  admin = await cluster.conectar();
  await admin.query(esquemaBase);
  await admin.query(await readFile(new URL('../../supabase/migrations/20261003180231_pagos_reservas_y_periodos.sql', import.meta.url), 'utf8'));
  await admin.query(await readFile(new URL('../../supabase/migrations/20261004165326_conciliacion_pagos.sql', import.meta.url), 'utf8'));
  await admin.query(await readFile(new URL('../../supabase/migrations/20261004181909_metadata_minima_pagos.sql', import.meta.url), 'utf8'));
  a = await cluster.conectar('service_role'); b = await cluster.conectar('service_role');
});
after(async () => { if (cluster) await cluster.cerrar(); });
beforeEach(async () => {
  await admin.query('truncate users, sessions, suscriptions, pagos, extra_sessions, reservas_cobros, compras_extras, pagos_verificados cascade');
  await admin.query("insert into users(id,role) values($1,'free'),($2,'free')", [USUARIO, OTRO]);
  await admin.query("insert into suscriptions(sub_id,user_id,plan,mp_sub_id,price,status,recurrence_status) values($1,$2,'mensual','abc123',80,'pending','authorized'),($3,$4,'mensual','def456',80,'pending','authorized')", [SUB, USUARIO, SUB2, OTRO]);
  await admin.query("insert into sessions(id,type,price) values(1,'especial',50)");
});

async function esperarBloqueo(cliente) {
  const pid = (await cliente.query('select pg_backend_pid() as pid')).rows[0].pid;
  return async () => {
    const limite = Date.now() + 3000;
    while (Date.now() < limite) {
      const r = await admin.query('select cardinality(pg_blocking_pids($1)) as n', [pid]);
      if (r.rows[0].n > 0) return;
      await esperar(10);
    }
    assert.fail('La segunda conexion no llego al bloqueo esperado');
  };
}

test('PostgreSQL nativo usa sesiones distintas y rol de backend sin superusuario', async () => {
  const uno = (await a.query('select pg_backend_pid() pid, current_user rol')).rows[0];
  const dos = (await b.query('select pg_backend_pid() pid')).rows[0];
  assert.notEqual(uno.pid, dos.pid); assert.equal(uno.rol, 'service_role');
  const rol = (await a.query('select rolsuper, rolbypassrls from pg_roles where rolname=current_user')).rows[0];
  assert.deepEqual(rol, { rolsuper: false, rolbypassrls: true });
});

test('dos conexiones reservan una sola alta y la perdedora espera el commit', async () => {
  const bloqueada = await esperarBloqueo(b);
  await a.query('begin');
  let segundo;
  try {
    assert.equal(await rpc(a, 'reservar_cobro', [USUARIO, randomUUID()]), true);
    segundo = rpc(b, 'reservar_cobro', [USUARIO, randomUUID()]);
    await bloqueada();
  } finally { await a.query('commit'); }
  assert.equal(await segundo, false);
  assert.equal((await admin.query('select count(*)::int n from reservas_cobros')).rows[0].n, 1);
});

test('rollback de primera reserva permite que otra conexion adquiera la unica reserva', async () => {
  const bloqueada = await esperarBloqueo(b);
  await a.query('begin'); let segundo;
  try {
    await rpc(a, 'reservar_cobro', [USUARIO, randomUUID()]);
    segundo = rpc(b, 'reservar_cobro', [USUARIO, randomUUID()]); await bloqueada();
  } finally { await a.query('rollback'); }
  assert.equal(await segundo, true);
});

test('replay simultaneo crea un pago y conserva exactamente su periodo', async () => {
  await Promise.all([aplicar(a), aplicar(b)]);
  assert.equal((await admin.query('select count(*)::int n from pagos')).rows[0].n, 1);
  assert.equal((await admin.query('select count(*)::int n from pagos_verificados')).rows[0].n, 1);
  assert.equal((await rpc(a, 'estado_acceso_pagos', [USUARIO, '2026-11-03T00:00:00Z'])).tieneAcceso, false);
});

test('pago concurrente con otro dueno se rechaza despues de esperar, sin mezclar ledger e historial', async () => {
  const bloqueada = await esperarBloqueo(b);
  await a.query('begin'); let segundo;
  try {
    await aplicar(a);
    segundo = aplicar(b, pago({ user_id: OTRO, sub_id: SUB2, estado_mp: 'rejected' }))
      .then(() => ({ aceptado: true }), (error) => ({ error }));
    await bloqueada();
  } finally { await a.query('commit'); }
  const resultado = await segundo;
  assert.ok(resultado.error, 'El segundo dueno no debe poder alterar el primer pago');
  for (const tabla of ['pagos', 'pagos_verificados']) {
    const fila = (await admin.query(`select user_id, estado_mp from ${tabla}`)).rows[0];
    assert.deepEqual(fila, { user_id: USUARIO, estado_mp: 'approved' });
  }
});

test('aprobacion y reembolso concurrentes convergen a reembolsado', async () => {
  await Promise.all([aplicar(a), aplicar(b, pago({ estado_mp: 'refunded', reembolsado: 80, mp_updated_at: '2026-10-04T00:00:00Z' }))]);
  assert.equal((await rpc(a, 'estado_acceso_pagos', [USUARIO, '2026-10-15T00:00:00Z'])).tieneAcceso, false);
  assert.equal((await admin.query('select estado_mp from pagos_verificados')).rows[0].estado_mp, 'refunded');
});

test('cancelacion y aprobacion concurrentes conservan el periodo y detienen la recurrencia', async () => {
  await Promise.all([aplicar(a), rpc(b, 'sincronizar_acuerdo_cobro', [USUARIO,
    { id: 'abc123', status: 'cancelled', last_modified: '2026-10-04T00:00:00Z' }])]);
  assert.equal((await rpc(a, 'estado_acceso_pagos', [USUARIO, '2026-10-15T00:00:00Z'])).tieneAcceso, true);
  assert.equal((await admin.query('select recurrence_status from suscriptions where sub_id=$1', [SUB])).rows[0].recurrence_status, 'cancelled');
});

test('dos compras extra concurrentes comparten pedido sin violar indice parcial', async () => {
  const resultados = await Promise.all([rpc(a, 'reservar_compra_extra', [USUARIO, 1]), rpc(b, 'reservar_compra_extra', [USUARIO, 1])]);
  assert.equal(resultados[0].id, resultados[1].id);
  assert.equal(resultados.filter((r) => r.nueva).length, 1);
});

test('fallo de historial revierte el pago completo y permite reentrega', async () => {
  await admin.query("create function public.fallar_prueba() returns trigger language plpgsql as $$ begin raise exception 'fallo de prueba'; end $$; create trigger fallo before insert on pagos for each row execute function public.fallar_prueba()");
  try {
    await assert.rejects(aplicar(a), /fallo de prueba/);
    assert.equal((await admin.query('select count(*)::int n from pagos_verificados')).rows[0].n, 0);
    assert.equal((await admin.query('select role from users where id=$1', [USUARIO])).rows[0].role, 'free');
  } finally { await admin.query('drop trigger fallo on pagos; drop function public.fallar_prueba()'); }
  assert.equal(await aplicar(b), true);
});

test('periodo mensual sin fin se rechaza en la base y no deja historial', async () => {
  await assert.rejects(aplicar(a, pago({ periodo_fin: null })), /constraint|periodo/i);
  assert.equal((await admin.query('select count(*)::int n from pagos')).rows[0].n, 0);
});

test('historial previo de otro usuario bloquea la aplicacion y conserva su evidencia', async () => {
  await admin.query("insert into pagos(mp_payment_id,user_id,monto,moneda,tipo,estado_mp) values('1234',$1,80,'MXN','suscripcion','pending')", [OTRO]);
  await assert.rejects(aplicar(a), /historial|Identidad/i);
  assert.equal((await admin.query('select count(*)::int n from pagos_verificados')).rows[0].n, 0);
  assert.equal((await admin.query('select estado_mp from pagos')).rows[0].estado_mp, 'pending');
});

test('permisos de todas las RPC, search_path y RLS de las tablas nuevas', async () => {
  const funciones = (await admin.query("select oid, proname, prosecdef, proconfig from pg_proc where pronamespace='public'::regnamespace")).rows;
  assert.equal(funciones.length, 15);
  for (const f of funciones) {
    assert.equal(f.prosecdef, false); assert.ok(f.proconfig.includes('search_path=""'));
    for (const rol of ['anon', 'authenticated', 'service_role']) {
      assert.equal((await admin.query("select has_function_privilege($1,$2::oid,'execute') ok", [rol, f.oid])).rows[0].ok, rol === 'service_role', `${f.proname}/${rol}`);
    }
  }
  const tablas = ['reservas_cobros', 'compras_extras', 'pagos_verificados', 'conciliaciones_pagos', 'vinculos_pagos_extras'];
  await aplicar(a);
  for (const rol of ['anon', 'authenticated']) {
    const c = await cluster.conectar(rol);
    for (const tabla of tablas) {
      assert.equal((await admin.query('select relrowsecurity from pg_class where oid=$1::regclass', [tabla])).rows[0].relrowsecurity, true);
      await assert.rejects(c.query(`select * from ${tabla}`), /permission denied/);
      // RLS sigue cerrada incluso si alguien concede SELECT accidentalmente.
      await admin.query(`grant select on ${tabla} to ${rol}`);
      try { assert.equal((await c.query(`select * from ${tabla}`)).rows.length, 0); }
      finally { await admin.query(`revoke select on ${tabla} from ${rol}`); }
    }
    await assert.rejects(rpc(c, 'aplicar_pago_verificado', [pago()]), /permission denied/);
  }
});

test('duplicados historicos abortan toda la migracion sin eliminar filas ni agregar columnas', async () => {
  await admin.query('create database prueba_migracion');
  const c = await cluster.conectar(undefined, 'prueba_migracion');
  await c.query(esquemaBase.replace('create role anon; create role authenticated; create role service_role bypassrls;', ''));
  await c.query('insert into users(id) values($1)', [USUARIO]);
  await c.query("insert into suscriptions(user_id,plan,mp_sub_id) values($1,'mensual','duplicado'),($1,'mensual','duplicado')", [USUARIO]);
  await assert.rejects(c.query(await readFile(new URL('../../supabase/migrations/20261003180231_pagos_reservas_y_periodos.sql', import.meta.url), 'utf8')), /unique|duplicate/i);
  await c.query('rollback');
  assert.equal((await c.query('select count(*)::int n from suscriptions')).rows[0].n, 2);
  assert.equal((await c.query("select count(*)::int n from information_schema.columns where table_name='suscriptions' and column_name='recurrence_status'")).rows[0].n, 0);
  assert.equal((await c.query("select to_regclass('public.pagos_verificados') tabla")).rows[0].tabla, null);
});

test('consulta de diagnostico funciona en transaccion de solo lectura y no exporta filas', async () => {
  const resultado = await admin.query(await readFile(new URL('../../supabase/diagnostico/esquema-pagos.sql', import.meta.url), 'utf8'));
  const esquema = resultado.find((r) => r.rows[0]?.esquema_pagos)?.rows[0].esquema_pagos;
  assert.equal(esquema.tablas.length, 10);
  assert.equal(esquema.tablas.find((t) => t.tabla === 'pagos_verificados').rls, true);
  assert.equal(JSON.stringify(esquema).includes(USUARIO), false);
});

test('reparaciones concurrentes esperan y rechazan el segundo snapshot obsoleto', async () => {
  await admin.query("update suscriptions set mp_sub_id='1234' where sub_id=$1", [SUB]);
  const antes = await rpc(a,'snapshot_conciliacion',[USUARIO]);
  const datos = { tipo:'vinculo_mensual',sub_id:SUB,payment_id:'1234',mp_sub_id:'real123' };
  const bloqueada = await esperarBloqueo(b); const id = randomUUID();
  await a.query('begin'); let segundo;
  try {
    await rpc(a,'aplicar_conciliacion',[id,USUARIO,antes,datos,'a'.repeat(64)]);
    segundo = rpc(b,'aplicar_conciliacion',[randomUUID(),USUARIO,antes,datos,'a'.repeat(64)])
      .then(()=>({aceptado:true}),(error)=>({error}));
    await bloqueada();
  } finally { await a.query('commit'); }
  assert.match((await segundo).error?.message || '',/Plan obsoleto/);
  assert.equal((await admin.query('select count(*)::int n from conciliaciones_pagos')).rows[0].n,1);
  assert.equal(await rpc(a,'revertir_conciliacion',[id]),true);
  assert.deepEqual(await rpc(a,'snapshot_conciliacion',[USUARIO]),antes);
});

test('reversion de estructura se bloquea tras un pago real posterior y no borra historial', async () => {
  await admin.query("update suscriptions set mp_sub_id='1234' where sub_id=$1", [SUB]);
  const antes = await rpc(a,'snapshot_conciliacion',[USUARIO]); const id = randomUUID();
  await rpc(a,'aplicar_conciliacion',[id,USUARIO,antes,{tipo:'vinculo_mensual',sub_id:SUB,payment_id:'1234',mp_sub_id:'abc123'},'a'.repeat(64)]);
  await aplicar(b);
  await assert.rejects(rpc(a,'revertir_conciliacion',[id]),/cambios posteriores/);
  assert.equal((await admin.query('select count(*)::int n from pagos')).rows[0].n,1);
});

test('limpieza concurrente de metadata omite filas bloqueadas y no altera pagos', async () => {
  await admin.query('alter table pagos disable trigger pagos_metadata_minima');
  try {
    await admin.query("insert into pagos(mp_payment_id,user_id,monto,metadata) values('1',$1,80,'{\"card\":{\"ficticio\":true}}'),('2',$1,80,'{\"payer\":{\"ficticio\":true}}')",[USUARIO]);
  } finally { await admin.query('alter table pagos enable trigger pagos_metadata_minima'); }
  await a.query('begin');
  try {
    assert.equal((await rpc(a,'limpiar_metadata_pagos',[1,true])).procesados,1);
    assert.equal((await rpc(b,'limpiar_metadata_pagos',[1,true])).procesados,1);
  } finally { await a.query('commit'); }
  assert.equal((await rpc(b,'limpiar_metadata_pagos',[100,false])).detectados,0);
  assert.equal((await admin.query('select sum(monto)::int monto from pagos')).rows[0].monto,160);
});
