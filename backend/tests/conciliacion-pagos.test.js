import test from 'node:test';
import assert from 'node:assert/strict';
import { crearEntorno } from './helpers/entorno-pagos.js';
import { crearConciliador, buscarTodasMP } from '../services/conciliacion-pagos.js';
import { ejecutarRPC } from './helpers/bd-pagos.js';

const USUARIO = '11111111-1111-4111-8111-111111111111';
const TOKEN = '33333333-3333-4333-8333-333333333333';
const RESPALDO = 'a'.repeat(64);
async function entorno() {
  const e = await crearEntorno(); const consultas = [];
  e.estado.preapproval.date_created = '2026-10-03T00:00:00Z';
  const remoto = { acuerdos: null, preferencias: [], pagos: null, fallar: null };
  const consultarMP = async (ruta) => {
    consultas.push(ruta);
    const url = new URL(ruta, 'https://api.mercadopago.com');
    if (remoto.fallar === url.pathname) throw new Error('Consulta MP HTTP 503');
    if (url.pathname === '/users/me') return structuredClone(e.estado.cuenta);
    if (url.pathname === '/v1/payments/1234') return structuredClone(e.estado.payment);
    if (url.pathname === '/preapproval/abc123') return structuredClone(e.estado.preapproval);
    if (url.pathname === '/checkout/preferences/pref-1') return structuredClone(remoto.preferencias[0]);
    let results;
    if (url.pathname === '/preapproval/search') results = remoto.acuerdos ?? [e.estado.preapproval];
    if (url.pathname === '/authorized_payments/search') results = [e.estado.factura];
    if (url.pathname === '/v1/payments/search') results = remoto.pagos ?? [e.estado.payment];
    if (url.pathname === '/checkout/preferences/search') return { elements: structuredClone(remoto.preferencias), total: remoto.preferencias.length };
    if (results) return { results: structuredClone(results), paging: { total: results.length } };
    throw new Error('Ruta no simulada');
  };
  const c = crearConciliador({ bd: e.supabaseClient, consultarMP,
    procesarPago: e.servicio.procesarWebhookMercadoPago, procesarAcuerdo: e.servicio.procesarWebhookSuscripcionPreapproval });
  const snapshot = () => ejecutarRPC(e.db, 'snapshot_conciliacion', { p_usuario: USUARIO });
  return { ...e, c, consultas, remoto, snapshot };
}
async function planFalso(e) {
  e.estado.tablas.suscriptions[0].mp_sub_id = '1234';
  return e.c.diagnosticar();
}

test('diagnostico de acuerdo falso no escribe y no exporta payer/card ni metadata privada', async () => {
  const e = await entorno(); e.estado.payment.payer = { email: 'privado@example.invalid' };
  e.estado.payment.card = { last_four_digits: '1234' };
  e.estado.tablas.pagos = [{ mp_payment_id: '1234', user_id: USUARIO, metadata: { privado: 'dato-original' } }];
  const plan = await planFalso(e);
  assert.equal(plan.acciones.length, 1); assert.equal(plan.acciones[0].datos.mp_sub_id, 'abc123');
  assert.equal((await e.db.query('select * from conciliaciones_pagos')).rows.length, 0);
  assert.equal((await e.snapshot()).suscripciones[0].mp_sub_id, '1234');
  assert.ok(!JSON.stringify(plan).includes('privado')); assert.ok(!JSON.stringify(plan).includes('dato-original'));
});

test('reparacion de vinculo, replay verificado y repeticion de operacion no duplican pago', async () => {
  const e = await entorno(); const plan = await planFalso(e); const accion = plan.acciones[0];
  assert.equal((await e.c.aplicar(plan, accion, RESPALDO)).repetida, false);
  assert.equal((await e.c.aplicar(plan, accion, RESPALDO)).repetida, true);
  assert.equal((await e.snapshot()).verificados.length, 0);
  assert.equal((await e.servicio.procesarWebhookMercadoPago({ data: { id: '1234' } })).error, null);
  assert.equal((await e.snapshot()).verificados.length, 1);
  await assert.rejects(e.c.revertir(accion.id), /revertir_conciliacion/);
});

test('reparacion estructural revierte exactamente el snapshot antes del replay', async () => {
  const e = await entorno(); const plan = await planFalso(e); const accion = plan.acciones[0];
  await e.c.aplicar(plan, accion, RESPALDO);
  assert.equal(await e.c.revertir(accion.id), true);
  assert.deepEqual(await e.snapshot(), accion.esperado);
  assert.equal(await e.c.revertir(accion.id), false);
  await assert.rejects(e.c.aplicar(plan, accion, RESPALDO), /reutilizada|revertida/);
});

test('fila falsa se conserva desvinculada si ya existe el acuerdo correcto', async () => {
  const e = await entorno();
  e.estado.tablas.suscriptions.push({ ...e.estado.tablas.suscriptions[0], sub_id: TOKEN });
  const plan = await planFalso(e);
  await e.c.aplicar(plan, plan.acciones[0], RESPALDO);
  const s = await e.snapshot(); assert.equal(s.suscripciones.length, 2);
  assert.equal(s.suscripciones.filter((x) => x.mp_sub_id === 'abc123').length, 1);
  assert.equal(s.suscripciones.find((x) => !x.mp_sub_id).status, 'cancelled');
  await e.c.revertir(plan.acciones[0].id);
  assert.deepEqual(await e.snapshot(), plan.acciones[0].esperado);
});

test('cambio local o de evidencia MP invalida el plan sin reparacion parcial', async () => {
  const e = await entorno(); const plan = await planFalso(e);
  e.estado.payment.date_last_updated = '2026-10-04T00:00:00Z';
  await assert.rejects(e.c.aplicar(plan, plan.acciones[0], RESPALDO), /Evidencia MP cambio/);
  await e.db.exec("update suscriptions set status='cancelled'");
  await assert.rejects(e.c.aplicar(plan, plan.acciones[0], RESPALDO), /Plan obsoleto/);
  assert.equal((await e.db.query('select * from conciliaciones_pagos')).rows.length, 0);
});

test('error de auditoria revierte tambien la reparacion', async () => {
  const e = await entorno(); const plan = await planFalso(e);
  await e.db.exec("create function fallo_auditoria() returns trigger language plpgsql as $$ begin raise exception 'fallo'; end $$; create trigger fallo before insert on conciliaciones_pagos for each row execute function fallo_auditoria()");
  try {
    await assert.rejects(e.c.aplicar(plan, plan.acciones[0], RESPALDO));
    assert.deepEqual(await e.snapshot(), plan.acciones[0].esperado);
  } finally { await e.db.exec('drop trigger fallo on conciliaciones_pagos; drop function fallo_auditoria()'); }
});

test('reserva incierta recupera unico acuerdo existente y puede restaurarse sin pago', async () => {
  const e = await entorno(); e.estado.tablas.suscriptions = [];
  await e.asegurarSiembra();
  await e.db.query("insert into reservas_cobros(user_id,token,estado,expires_at,updated_at) values($1,$2,'enviando','2026-10-02','2026-10-02')", [USUARIO,TOKEN]);
  await e.supabaseClient.rpc('snapshot_conciliacion', { p_usuario: USUARIO });
  const plan = await e.c.diagnosticar(); assert.equal(plan.acciones[0].datos.tipo, 'alta_incierta');
  await e.c.aplicar(plan, plan.acciones[0], RESPALDO);
  assert.equal((await e.snapshot()).reserva, null);
  assert.equal((await e.snapshot()).suscripciones[0].mp_sub_id, 'abc123');
  assert.equal(e.estado.altas.length, 0);
  await e.c.revertir(plan.acciones[0].id); assert.deepEqual(await e.snapshot(), plan.acciones[0].esperado);
});

for (const caso of ['sin resultados','ambiguos','fallo remoto']) {
  test(`reserva incierta ${caso} se conserva y queda pendiente`, async () => {
    const e = await entorno(); e.estado.tablas.suscriptions = []; await e.asegurarSiembra();
    await e.db.query("insert into reservas_cobros(user_id,token,estado,expires_at,updated_at) values($1,$2,'enviando','2026-10-02','2026-10-02')", [USUARIO,TOKEN]);
    await e.supabaseClient.rpc('snapshot_conciliacion', { p_usuario: USUARIO });
    if (caso === 'sin resultados') e.remoto.acuerdos = [];
    if (caso === 'ambiguos') e.remoto.acuerdos = [e.estado.preapproval, { ...e.estado.preapproval, id: 'otro' }];
    if (caso === 'fallo remoto') e.remoto.fallar = '/preapproval/search';
    const plan = await e.c.diagnosticar(); assert.equal(plan.acciones.length, 0); assert.equal(plan.pendientes.length, 1);
    assert.equal((await e.snapshot()).reserva.estado, 'enviando');
  });
}

test('preferencia incierta se recupera sin crear otra y revierte sin modificar el pedido', async () => {
  const e = await entorno(); e.estado.tablas.compras_extras = [{ id: TOKEN,user_id: USUARIO,session_id: 1,monto: 50,moneda:'MXN',estado:'incierta' }];
  e.estado.tablas.sessions = [{ id: 1,type:'especial',price:50 }];
  e.remoto.preferencias = [{ id:'pref-1',external_reference:`extra:${TOKEN}`,collector_id:42,
    date_created:'2026-10-03T00:00:00Z',init_point:'https://www.mercadopago.com.mx/checkout',items:[{quantity:1,unit_price:50,currency_id:'MXN'}] }];
  const plan = await e.c.diagnosticar(); await e.c.aplicar(plan, plan.acciones[0], RESPALDO);
  assert.equal((await e.snapshot()).compras[0].preference_id, 'pref-1');
  assert.equal(e.estado.preferencias.length, 0);
  await e.c.revertir(plan.acciones[0].id); assert.deepEqual(await e.snapshot(), plan.acciones[0].esperado);
});

test('pago extra historico requiere vinculo auditado antes de conceder compra', async () => {
  const e = await entorno(); e.estado.tablas.sessions = [{ id: 1,type:'especial',price:200 }];
  e.estado.tablas.extra_sessions = [{ id: 1,user_id: USUARIO,session_id:1,price:50,mp_pay_id:'1234',status:'pending' }];
  Object.assign(e.estado.payment, { external_reference:`${USUARIO}:1`,transaction_amount:50 });
  assert.ok((await e.servicio.procesarWebhookMercadoPago({data:{id:'1234'}})).error);
  const plan = await e.c.diagnosticar(); assert.equal(plan.acciones[0].datos.tipo,'extra_historico');
  await e.c.aplicar(plan,plan.acciones[0],RESPALDO);
  assert.equal((await e.servicio.procesarWebhookMercadoPago({data:{id:'1234'}})).error,null);
  assert.equal((await e.snapshot()).extras[0].status,'pagada');
  assert.equal((await e.snapshot()).compras[0].monto,50);
});

test('conciliacion periodica descubre factura sin webhook, dry-run no escribe y replay converge', async () => {
  const e = await entorno();
  const diagnostico = await e.c.sincronizar(); assert.deepEqual(diagnostico.pagos,['1234']);
  assert.equal((await e.snapshot()).verificados.length,0);
  const aplicado = await e.c.sincronizar({aplicar:true}); assert.equal(aplicado.fallos.length,0);
  await e.c.sincronizar({aplicar:true}); assert.equal((await e.snapshot()).verificados.length,1);
});

test('conciliacion periodica informa fallo sin confirmar exito y permite otra corrida', async () => {
  const e = await entorno(); e.estado.errorRPC='aplicar_pago_verificado';
  const r = await e.c.sincronizar({aplicar:true}); assert.ok(r.fallos.some((f)=>f.tipo==='pago'));
  e.estado.errorRPC=null;
  assert.equal((await e.c.sincronizar({aplicar:true})).fallos.length,0);
});

test('paginacion de MP consume todas las paginas y rechaza resultados truncados/repetidos', async () => {
  let llamadas=0;
  const filas=await buscarTodasMP(async()=>({results:[{id:String(++llamadas)}],paging:{total:3}}),'/busqueda');
  assert.equal(filas.length,3);
  await assert.rejects(buscarTodasMP(async()=>({results:[],paging:{total:1}}),'/busqueda'),/incompleta/);
  await assert.rejects(buscarTodasMP(async()=>({results:[{id:'1'}],paging:{total:2}}),'/busqueda'),/repetida/);
  await assert.rejects(buscarTodasMP(async()=>({results:[]}),'/busqueda'),/incompleta/);
});

test('busqueda de facturas respeta el limite aceptado por MP y recupera las paginas restantes', async () => {
  const facturas = Array.from({length:23},(_,i)=>({id:String(i+1)}));
  const offsets = [];
  const recibidas = await buscarTodasMP(async (ruta) => {
    const url = new URL(ruta,'https://api.mercadopago.com');
    const limite = Number(url.searchParams.get('limit'));
    const offset = Number(url.searchParams.get('offset'));
    if (limite > 10) throw new Error('Consulta MP HTTP 400: Invalid value for limit');
    assert.equal(url.searchParams.get('preapproval_id'),'abc123');
    offsets.push(offset);
    return {results:facturas.slice(offset,offset+limite),paging:{total:facturas.length}};
  },'/authorized_payments/search',{preapproval_id:'abc123'});
  assert.deepEqual(recibidas,facturas);
  assert.deepEqual(offsets,[0,10,20]);
});

test('anon/authenticated no pueden leer auditoria ni usar reparacion o reversion', async () => {
  const e = await entorno(); await e.asegurarSiembra();
  for (const role of ['anon','authenticated']) {
    await e.db.exec(`set role ${role}`);
    try {
      await assert.rejects(e.db.query('select * from conciliaciones_pagos'),/permission denied/);
      await assert.rejects(ejecutarRPC(e.db,'revertir_conciliacion',{p_id:TOKEN}),/permission denied/);
      await assert.rejects(ejecutarRPC(e.db,'snapshot_conciliacion',{p_usuario:USUARIO}),/permission denied/);
    } finally { await e.db.exec('reset role'); }
  }
});

test('inventario separa pagos por verificar y compras sin evidencia suficiente', async () => {
  const e = await entorno();
  e.estado.tablas.pagos = [{ mp_payment_id:'1234',user_id:USUARIO,monto:80 }];
  e.estado.tablas.sessions = [{ id:1,type:'especial',price:50 }];
  e.estado.tablas.extra_sessions = [{ id:1,user_id:USUARIO,session_id:1,price:50,status:'pending' }];
  const plan = await e.c.diagnosticar();
  assert.equal(plan.pagos_por_verificar[0].payment_id,'1234');
  assert.ok(plan.pendientes.some((p)=>p.extra_id===1));
  assert.equal(plan.acciones.length,0);
});

test('plan manipulado o sin respaldo no altera estructura', async () => {
  const e = await entorno(); const plan = await planFalso(e);
  const modificada = structuredClone(plan.acciones[0]); modificada.datos.mp_sub_id='ajeno';
  await assert.rejects(e.c.aplicar(plan,modificada,RESPALDO),/Evidencia MP cambio/);
  await assert.rejects(e.c.aplicar(plan,plan.acciones[0],''),/aplicar_conciliacion/);
  assert.deepEqual(await e.snapshot(),plan.acciones[0].esperado);
});
