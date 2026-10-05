import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHmac } from 'node:crypto';
import { crearEntorno } from './helpers/entorno-pagos.js';

async function servidor(t) {
  const entorno = await crearEntorno();
  const app = express();
  app.use(express.json()); app.use('/api/pagos', entorno.rutas);
  const http = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { http.once('listening', resolve); http.once('error', reject); });
  t.after(() => new Promise((resolve, reject) => http.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${http.address().port}/api/pagos`;
  const solicitar = async (ruta, opciones = {}) => {
    const response = await fetch(`${base}${ruta}`, { ...opciones, signal: AbortSignal.timeout(5000) });
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, data };
  };
  return { ...entorno, solicitar };
}

function aviso(id = '1234') {
  const ts = '1791000000'; const requestId = 'peticion-ficticia';
  const firma = createHmac('sha256', 'secreto-ficticio').update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex');
  return { method: 'POST', headers: { 'Content-Type': 'application/json',
    'x-request-id': requestId, 'x-signature': `ts=${ts},v1=${firma}` },
  body: JSON.stringify({ type: 'payment', data: { id } }) };
}

test('HTTP: todas las rutas privadas rechazan solicitudes sin JWT antes de consultar MP', async (t) => {
  const e = await servidor(t);
  for (const [ruta, method] of [['/estado','GET'], ['/historial','GET'], ['/suscripcion','POST'], ['/sesion-extra','POST'], ['/cancelar','POST']]) {
    const r = await e.solicitar(ruta, { method });
    assert.equal(r.status, 401); assert.equal(r.data.success, false);
  }
  assert.equal((await e.solicitar('/estado', { headers: { Authorization: 'Bearer invalido' } })).status, 401);
  assert.equal(e.estado.consultasMP.length, 0); assert.equal(e.estado.escrituras.length, 0);
});

test('HTTP: query/body distintos, IDs repetidos y firma incorrecta no llegan a MP', async (t) => {
  const e = await servidor(t);
  assert.equal((await e.solicitar('/webhook?data.id=1235', aviso())).status, 400);
  assert.equal((await e.solicitar('/webhook?data.id=1234&data.id=1234', aviso())).status, 400);
  const peticion = aviso(); peticion.headers['x-signature'] = 'ts=1791000000,v1=' + '0'.repeat(64);
  assert.equal((await e.solicitar('/webhook?data.id=1234', peticion)).status, 401);
  assert.equal(e.estado.consultasMP.length, 0);
});

test('HTTP: fallo SQL responde 500; reentrega firmada y duplicado registran un solo pago', async (t) => {
  const e = await servidor(t); e.estado.errorRPC = 'aplicar_pago_verificado';
  assert.equal((await e.solicitar('/webhook?data.id=1234&type=payment', aviso())).status, 500);
  assert.equal((await e.db.query('select * from pagos_verificados')).rows.length, 0);
  e.estado.errorRPC = null;
  for (let i = 0; i < 2; i += 1) {
    const r = await e.solicitar('/webhook?data.id=1234&type=payment', aviso());
    assert.equal(r.status, 200); assert.equal(r.data.success, true);
  }
  assert.equal((await e.db.query('select * from pagos')).rows.length, 1);
});

test('HTTP: historial filtra el usuario y no expone metadata privada', async (t) => {
  const e = await servidor(t);
  e.estado.tablas.pagos = [
    { user_id: '11111111-1111-4111-8111-111111111111', mp_payment_id: '1', monto: 80, moneda: 'MXN',
      estado_mp: 'rejected', tipo: 'suscripcion', created_at: '2026-10-03', metadata: { privado: 'no exponer' } },
    { user_id: '33333333-3333-4333-8333-333333333333', mp_payment_id: '2', monto: 80 },
  ];
  const r = await e.solicitar('/historial', { headers: { Authorization: 'Bearer jwt-ficticio' } });
  assert.equal(r.status, 200); assert.equal(r.data.data.length, 1);
  assert.deepEqual(Object.keys(r.data.data[0]).sort(), ['created_at','estado_mp','estado_texto','moneda','monto','mp_payment_id','tipo']);
});

test('HTTP: sesion invalida y verbo GET no inician cobros', async (t) => {
  const e = await servidor(t);
  const headers = { Authorization: 'Bearer jwt-ficticio', 'Content-Type': 'application/json' };
  for (const sesion_id of [0, -1, 'abc', 1.5]) {
    assert.equal((await e.solicitar('/sesion-extra', { method: 'POST', headers, body: JSON.stringify({ sesion_id }) })).status, 400);
  }
  for (const ruta of ['/cancelar','/suscripcion','/sesion-extra']) {
    assert.equal((await e.solicitar(ruta, { headers })).status, 404);
  }
  assert.equal(e.estado.altas.length, 0); assert.equal(e.estado.preferencias.length, 0);
});
