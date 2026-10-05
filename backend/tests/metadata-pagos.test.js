import test from 'node:test';
import assert from 'node:assert/strict';
import { prepararBD, ejecutarRPC } from './helpers/bd-pagos.js';
import { presentarPago } from '../services/historial-pagos.js';

const USUARIO='11111111-1111-4111-8111-111111111111';
const minimizar=(db,p_datos)=>ejecutarRPC(db,'metadata_minima_pago',{p_datos});

test('metadata historica como objeto o JSON serializado conserva solo evidencia minima tipada', async () => {
  const db=await prepararBD();
  const viejo={payer:{email:'privado@example.invalid'},card:{last_four_digits:'0000'},
    status_detail:'cc_rejected_high_risk',live_mode:true,preapproval_id:'abc123',authorized_payment_id:123,
    transaction_amount_refunded:20,date_approved:'2026-10-03T00:00:00Z',order:{id:567},metadata:{preference_id:'pref-1',privado:'dato'}};
  const esperado={status_detail:'cc_rejected_high_risk',live_mode:true,preapproval_id:'abc123',authorized_payment_id:'123',
    reembolsado:20,date_approved:'2026-10-03T00:00:00Z',merchant_order_id:'567',preference_id:'pref-1'};
  assert.deepEqual(await minimizar(db,viejo),esperado);
  // JSONB string: pasar JSON.stringify dos veces al driver; ejecutarRPC pasa strings literales.
  assert.deepEqual(await minimizar(db,JSON.stringify(JSON.stringify(viejo))),esperado);
  assert.deepEqual(await minimizar(db,{preapproval_id:null,metadata:{preapproval_id:'abc'},
    merchant_order_id:null,order:{id:123},reembolsado:null,transaction_amount_refunded:20}),
    {preapproval_id:'abc',merchant_order_id:'123',reembolsado:20});
  assert.deepEqual(await minimizar(db,{status_detail:{email:'privado'},date_approved:'privado@example.invalid',live_mode:'si',preapproval_id:{payer:'privado'},reembolsado:-1}),{});
});

test('metadata nula, arrays y JSON string malformado se minimizan sin romper limpieza', async () => {
  const db=await prepararBD();
  for(const valor of [null,[],JSON.stringify('no es JSON')]) assert.deepEqual(await minimizar(db,valor),{});
});

test('trigger impide almacenar campos privados nuevos y no cambia columnas financieras', async () => {
  const db=await prepararBD();
  await db.query('insert into users(id) values($1)',[USUARIO]);
  await db.query("insert into pagos(mp_payment_id,user_id,monto,estado_mp,tipo,metadata) values('123',$1,80,'approved','suscripcion',$2)",
    [USUARIO,JSON.stringify({payer:{email:'privado'},card:{numero:'ficticio'},live_mode:true})]);
  const fila=(await db.query('select monto,estado_mp,metadata from pagos')).rows[0];
  assert.equal(Number(fila.monto),80); assert.equal(fila.estado_mp,'approved'); assert.deepEqual(fila.metadata,{live_mode:true});
});

test('limpieza simula, avanza por lotes y es idempotente sin tocar el pago', async () => {
  const db=await prepararBD(); await db.query('insert into users(id) values($1)',[USUARIO]);
  await db.exec('alter table pagos disable trigger pagos_metadata_minima');
  try {
    for(let i=1;i<=3;i++) await db.query("insert into pagos(mp_payment_id,user_id,monto,estado_mp,metadata) values($1,$2,80,'rejected',$3)",
      [String(i),USUARIO,JSON.stringify({card:{ficticio:'dato'},preapproval_id:'abc'})]);
  } finally { await db.exec('alter table pagos enable trigger pagos_metadata_minima'); }
  const antes=(await db.query("select to_jsonb(p)-'metadata' datos from pagos p order by id")).rows;
  const limpiar=(p_aplicar)=>ejecutarRPC(db,'limpiar_metadata_pagos',{p_limite:2,p_aplicar});
  assert.deepEqual(await limpiar(false),{detectados:3,procesados:0,simulacion:true});
  assert.equal((await limpiar(true)).procesados,2);
  assert.equal((await limpiar(true)).procesados,1);
  assert.deepEqual(await limpiar(true),{detectados:0,procesados:0,simulacion:false});
  assert.deepEqual((await db.query("select to_jsonb(p)-'metadata' datos from pagos p order by id")).rows,antes);
});

test('limpieza rechaza lotes invalidos y roles cliente', async () => {
  const db=await prepararBD();
  await assert.rejects(ejecutarRPC(db,'limpiar_metadata_pagos',{p_limite:501,p_aplicar:true}),/invalidos/);
  for(const rol of ['anon','authenticated']) {
    await db.exec(`set role ${rol}`);
    try { await assert.rejects(ejecutarRPC(db,'limpiar_metadata_pagos',{p_limite:1,p_aplicar:true}),/permission denied/); }
    finally { await db.exec('reset role'); }
  }
});

test('contrato de historial distingue estados terminales y no filtra propiedades nuevas de BD', () => {
  for(const [estado_mp,texto] of [['refunded','Reembolsado'],['charged_back','Contracargo'],['cancelled','Cancelado'],['in_process','En proceso'],['desconocido','Estado por verificar']]) {
    const pago=presentarPago({estado_mp,metadata:{privado:true},user_id:USUARIO,correo:'privado'});
    assert.equal(pago.estado_texto,texto); assert.equal('metadata' in pago,false); assert.equal('user_id' in pago,false); assert.equal('correo' in pago,false);
  }
});
