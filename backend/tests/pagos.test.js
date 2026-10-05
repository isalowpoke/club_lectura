import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { crearEntorno } from './helpers/entorno-pagos.js';
import { normalizarWebhook, verificarFirmaWebhook } from '../middleware/verificar-firma-webhook.js';

const eventoPago = { type: 'payment', data: { id: '1234' } };
const eventoFactura = { type: 'subscription_authorized_payment', data: { id: '7890' } };
const eventoPreapproval = { type: 'subscription_preapproval', data: { id: 'abc123' } };

function firma(id = '1234') {
  const v1 = createHmac('sha256', 'secreto-ficticio')
    .update(`id:${id};request-id:solicitud;ts:123456;`).digest('hex');
  return `ts=123456,v1=${v1}`;
}

async function notificar(entorno, { query = { 'data.id': '1234', type: 'payment' },
  body = eventoPago, signature = firma() } = {}) {
  const req = { query, body, headers: { 'x-signature': signature, 'x-request-id': 'solicitud' } };
  const respuesta = { codigo: 200, status(codigo) { this.codigo = codigo; return this; },
    json(datos) { this.datos = datos; return this; } };
  await entorno.handler(req, respuesta);
  return respuesta;
}

test('firma valida; firma alterada, hexadecimal malformado y secreto ausente se rechazan', () => {
  const datos = { xSignature: firma(), xRequestId: 'solicitud', dataId: '1234', secret: 'secreto-ficticio' };
  assert.equal(verificarFirmaWebhook(datos).valida, true);
  assert.equal(verificarFirmaWebhook({ ...datos, dataId: '5678' }).valida, false);
  assert.equal(verificarFirmaWebhook({ ...datos, xSignature: firma() + 'zz' }).valida, false);
  assert.equal(verificarFirmaWebhook({ ...datos, secret: undefined }).valida, false);
});

test('normalizacion no usa el ID de la notificacion y rechaza parametros repetidos', () => {
  assert.throws(() => normalizarWebhook({}, { type: 'payment', id: 1234 }));
  assert.throws(() => normalizarWebhook({ 'data.id': ['1234', '5678'] }, eventoPago));
  assert.throws(() => normalizarWebhook({ 'data.id': Number.MAX_SAFE_INTEGER + 1 }, eventoPago));
  assert.equal(normalizarWebhook({ 'data.id': 'ABC123' }, eventoPreapproval).data.id, 'abc123');
});

for (const [nombre, datos, codigo] of [
  ['IDs diferentes', { query: { 'data.id': '5678', type: 'payment' } }, 400],
  ['tipos diferentes', { query: { 'data.id': '1234', type: 'subscription_cancelled' } }, 400],
  ['firma incorrecta', { signature: firma('5678') }, 401],
]) {
  test(`webhook rechaza ${nombre} antes de consultar MP`, async () => {
    const entorno = await crearEntorno();
    assert.equal((await notificar(entorno, datos)).codigo, codigo);
    assert.equal(entorno.estado.consultasMP.length, 0);
    assert.equal(entorno.estado.escrituras.length, 0);
  });
}

test('secreto ausente bloquea webhook con 503 incluso fuera de produccion', async () => {
  const entorno = await crearEntorno();
  delete entorno.estado.env.MERCADOPAGO_WEBHOOK_SECRET;
  assert.equal((await notificar(entorno)).codigo, 503);
  assert.equal(entorno.estado.escrituras.length, 0);
});

test('ID presente solo en query se firma y se procesa como el mismo recurso', async () => {
  const entorno = await crearEntorno();
  const respuesta = await notificar(entorno, { body: { type: 'payment', id: 'evento-distinto' } });
  assert.equal(respuesta.codigo, 200);
  assert.equal((await entorno.acceso('2026-10-04T00:00:00Z')).tieneAcceso, true);
});

for (const orden of [[eventoPago, eventoFactura], [eventoFactura, eventoPago]]) {
  test(`ambos eventos y reentregas en orden ${orden[0].type} conservan una suscripcion real`, async () => {
    const entorno = await crearEntorno();
    for (const evento of [...orden, ...orden]) {
      const funcion = evento.type === 'payment' ? 'procesarWebhookMercadoPago' : 'procesarWebhookSuscripcionPagoAutorizado';
      assert.equal((await entorno.servicio[funcion](evento)).error, null);
    }
    assert.equal(entorno.estado.tablas.suscriptions.length, 1);
    assert.equal(entorno.estado.tablas.suscriptions[0].mp_sub_id, 'abc123');
    assert.equal((await entorno.acceso('2026-10-04T00:00:00Z')).tieneAcceso, true);
    assert.equal(entorno.estado.tablas.pagos.length, 1);
    const metadata = entorno.estado.tablas.pagos[0].metadata;
    assert.equal(metadata.authorized_payment_id, '7890');
    assert.equal(metadata.preapproval_id, 'abc123');
    assert.equal(metadata.external_reference, undefined);
  });
}

test('eventos concurrentes usan el mismo preapproval sin insertar suscripciones', async () => {
  const entorno = await crearEntorno();
  const resultados = await Promise.all([
    entorno.servicio.procesarWebhookMercadoPago(eventoPago),
    entorno.servicio.procesarWebhookSuscripcionPagoAutorizado(eventoFactura),
  ]);
  assert.ok(resultados.every((resultado) => !resultado.error));
  assert.equal(entorno.estado.tablas.suscriptions.length, 1);
  assert.equal(entorno.estado.tablas.pagos_verificados.length, 1);
});

test('cc_rejected_high_risk queda vinculado al preapproval sin conceder acceso', async () => {
  const entorno = await crearEntorno();
  Object.assign(entorno.estado.payment, { status: 'rejected', status_detail: 'cc_rejected_high_risk', date_approved: null });
  assert.equal((await entorno.servicio.procesarWebhookMercadoPago(eventoPago)).error, null);
  assert.equal(entorno.estado.tablas.suscriptions.length, 1);
  assert.equal(entorno.estado.tablas.suscriptions[0].status, 'pending');
  assert.equal(entorno.estado.tablas.suscriptions[0].mp_sub_id, 'abc123');
});

const discrepancias = [
  ['importe', (e) => { e.payment.transaction_amount = 0.01; }],
  ['moneda', (e) => { e.payment.currency_id = 'USD'; }],
  ['ambiente', (e) => { e.payment.live_mode = false; }],
  ['modo mal configurado', (e) => { e.env.MERCADOPAGO_MODE = 'prueba'; }],
  ['usuario pago', (e) => { e.payment.external_reference = 'otro'; }],
  ['usuario factura', (e) => { e.factura.external_reference = 'otro'; }],
  ['usuario preapproval', (e) => { e.preapproval.external_reference = 'otro'; }],
  ['ID de pago', (e) => { e.payment.id = 999; }],
  ['pago de factura', (e) => { e.factura.payment.id = 999; }],
  ['preapproval', (e) => { e.preapproval.id = 'otro'; }],
  ['referencia opcional', (e) => { e.payment.preapproval_id = 'otro'; }],
  ['cobrador del pago', (e) => { e.payment.collector_id = 100; }],
  ['cobrador del acuerdo', (e) => { e.preapproval.collector_id = 100; }],
  ['cuenta autenticada', (e) => { e.cuenta.id = 100; }],
  ['aplicacion', (e) => { e.payment.application_id = 1; e.preapproval.application_id = 2; }],
  ['importe factura', (e) => { e.factura.transaction_amount = '70.00'; }],
  ['precio guardado', (e) => { e.tablas.suscriptions[0].price = 70; }],
  ['recurrencia', (e) => { e.preapproval.auto_recurring.frequency_type = 'days'; }],
  ['sin aprobacion fechada', (e) => { e.payment.date_approved = null; }],
  ['sin suscripcion local', (e) => { e.tablas.suscriptions = []; }],
  ['sin factura', (e) => { e.resultados = []; }],
  ['facturas ambiguas', (e) => { e.resultados = [e.factura, e.factura]; }],
  ['mas paginas de facturas', (e) => { e.total = 2; }],
  ['fallo BD al validar', (e) => { e.errorBD = { tabla: 'suscriptions', operacion: 'select' }; }],
];
for (const [nombre, alterar] of discrepancias) {
  test(`sin escrituras ante ${nombre}; webhook deja reintentar`, async () => {
    const entorno = await crearEntorno();
    alterar(entorno.estado);
    assert.equal((await notificar(entorno)).codigo, 500);
    assert.equal(entorno.estado.escrituras.length, 0);
  });
}

test('ambiente test explicito permite exclusivamente pagos de prueba', async () => {
  const entorno = await crearEntorno();
  entorno.estado.env.MERCADOPAGO_MODE = 'test';
  entorno.estado.payment.live_mode = false;
  assert.equal((await notificar(entorno)).codigo, 200);
});

test('fallo temporal de MP produce 500; reentrega recupera el pago', async () => {
  const entorno = await crearEntorno();
  entorno.estado.errorMP = true;
  assert.equal((await notificar(entorno)).codigo, 500);
  assert.equal(entorno.estado.escrituras.length, 0);
  entorno.estado.errorMP = false;
  assert.equal((await notificar(entorno)).codigo, 200);
});

for (const tabla of ['pagos', 'suscriptions']) {
  test(`fallo de persistencia en ${tabla} no confirma exito; reentrega recupera`, async () => {
    const entorno = await crearEntorno();
    entorno.estado.errorBD = { tabla, operacion: tabla === 'pagos' ? 'upsert' : 'update' };
    assert.equal((await notificar(entorno)).codigo, 500);
    assert.equal(entorno.estado.tablas.suscriptions[0].status, 'pending');
    entorno.estado.errorBD = null;
    assert.equal((await notificar(entorno)).codigo, 200);
    assert.equal(entorno.estado.tablas.pagos.length, 1);
  });
}

test('factura programada sin pago no concede acceso; respuesta malformada falla', async () => {
  const entorno = await crearEntorno();
  entorno.estado.factura.payment = null;
  entorno.estado.factura.status = 'scheduled';
  const resultado = await entorno.servicio.procesarWebhookSuscripcionPagoAutorizado(eventoFactura);
  assert.equal(resultado.data.reason, 'factura_sin_pago');
  assert.equal(entorno.estado.escrituras.length, 0);
  entorno.estado.factura.status = 'processed';
  await assert.rejects(entorno.servicio.procesarWebhookSuscripcionPagoAutorizado(eventoFactura), /payment.id/);
});

test('cancelacion legacy consulta MP y no cancela si el proveedor sigue pending', async () => {
  const entorno = await crearEntorno();
  await entorno.servicio.procesarWebhookSuscripcionCancelada(eventoPreapproval);
  assert.ok(entorno.estado.consultasMP.includes('preapproval/abc123'));
  assert.equal(entorno.estado.tablas.suscriptions[0].status, 'pending');
});

test('preapproval authorized no sobrescribe el precio contratado', async () => {
  const entorno = await crearEntorno();
  entorno.estado.preapproval.status = 'authorized';
  entorno.estado.preapproval.auto_recurring.transaction_amount = 70;
  await entorno.servicio.procesarWebhookSuscripcionPreapproval(eventoPreapproval);
  assert.equal(entorno.estado.tablas.suscriptions[0].price, 80);
});

test('factura consultada debe corresponder al ID del aviso', async () => {
  const entorno = await crearEntorno();
  entorno.estado.factura.id = 9999;
  await assert.rejects(entorno.servicio.procesarWebhookSuscripcionPagoAutorizado(eventoFactura), /Factura MP discrepante/);
  assert.equal(entorno.estado.escrituras.length, 0);
});

test('factura no puede redirigir el cobro hacia una sesion extra', async () => {
  const entorno = await crearEntorno();
  entorno.estado.payment.external_reference += ':2';
  const resultado = await entorno.servicio.procesarWebhookSuscripcionPagoAutorizado(eventoFactura);
  assert.match(resultado.error.message, /sesion extra/);
  assert.equal(entorno.estado.escrituras.length, 0);
});

test('preapproval de otro usuario no modifica la fila local', async () => {
  const entorno = await crearEntorno();
  entorno.estado.preapproval.external_reference = 'otro';
  entorno.estado.preapproval.status = 'cancelled';
  await assert.rejects(entorno.servicio.procesarWebhookSuscripcionPreapproval(eventoPreapproval), /sincronizar/);
  assert.equal(entorno.estado.escrituras.length, 0);
});

test('datos personales/tarjeta del proveedor no entran en metadata nueva', async () => {
  const entorno = await crearEntorno();
  entorno.estado.payment.payer = { email: 'ficticio@example.invalid' };
  entorno.estado.payment.card = { last_four_digits: '0000' };
  await entorno.servicio.procesarWebhookMercadoPago(eventoPago);
  const metadata = entorno.estado.tablas.pagos[0].metadata;
  assert.equal(metadata.payer, undefined);
  assert.equal(metadata.card, undefined);
});
