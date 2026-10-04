import test from 'node:test';
import assert from 'node:assert/strict';
import { crearClienteMercadoPago } from '../services/cliente-mercadopago.js';

test('SDK real usa rutas/metodos actuales, respuestas directas y claves aisladas', async (t) => {
  const llamadas = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    llamadas.push({ url, ...options });
    return new Response(JSON.stringify({ id: '123', status: 'approved' }), { status: 200 });
  });
  const cliente = crearClienteMercadoPago('token-ficticio');
  assert.equal((await cliente.obtenerPago('123')).id, '123');
  await cliente.obtenerAcuerdo('abc');
  await Promise.all([cliente.crearAcuerdo({ external_reference: 'uno' }, 'reserva-uno'),
    cliente.crearAcuerdo({ external_reference: 'dos' }, 'reserva-dos')]);
  await cliente.crearPreferencia({ items: [] }, 'compra-uno');
  await cliente.cancelarAcuerdo('abc');
  assert.deepEqual(llamadas.map((r) => [new URL(r.url).pathname,r.method]), [
    ['/v1/payments/123','GET'],['/preapproval/abc','GET'],['/preapproval/','POST'],
    ['/preapproval/','POST'],['/checkout/preferences/','POST'],['/preapproval/abc','PUT']]);
  assert.equal(llamadas[2].headers['X-Idempotency-Key'], 'reserva-uno');
  assert.equal(llamadas[3].headers['X-Idempotency-Key'], 'reserva-dos');
  assert.equal(llamadas[4].headers['X-Idempotency-Key'], 'compra-uno');
  assert.deepEqual(JSON.parse(llamadas[5].body), { status: 'cancelled' });
  assert.ok(llamadas.every((r) => r.signal instanceof AbortSignal));
});

test('SDK real no reintenta silenciosamente un POST fallido', async (t) => {
  let llamadas = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    llamadas += 1;
    return new Response(JSON.stringify({ message: 'fallo ficticio' }), { status: 503 });
  });
  await assert.rejects(crearClienteMercadoPago('token-ficticio').crearAcuerdo({}, 'reserva-uno'));
  assert.equal(llamadas, 1);
});
