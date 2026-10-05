import test from 'node:test';
import assert from 'node:assert/strict';
import { crearEntorno } from './helpers/entorno-pagos.js';
import { ejecutarRPC } from './helpers/bd-pagos.js';
import { periodoFacturado } from '../services/periodos-pago.js';

const USUARIO = '11111111-1111-4111-8111-111111111111';
const TOKEN = '33333333-3333-4333-8333-333333333333';
const TOKEN2 = '44444444-4444-4444-8444-444444444444';
const evento = { data: { id: '1234' } };

async function cobrar(e, cambios = {}) {
  Object.assign(e.estado.payment, cambios);
  e.estado.factura.payment.id = e.estado.payment.id;
  const resultado = await e.servicio.procesarWebhookMercadoPago({ data: { id: String(e.estado.payment.id) } });
  assert.equal(resultado.error, null, resultado.error?.message);
  return resultado;
}

for (const [ancla, inicio, fin] of [
  ['2025-01-31', '2025-02-28', '2025-03-31'],
  ['2024-01-31', '2024-02-29', '2024-03-31'],
  ['2026-03-31', '2026-04-30', '2026-05-31'],
  ['2026-12-31', '2027-01-31', '2027-02-28'],
]) {
  test(`mes calendario anclado ${inicio} hasta ${fin}`, () => {
    const resultado = periodoFacturado({ debit_date: `${inicio}T00:00:00Z` },
      { auto_recurring: { start_date: `${ancla}T00:00:00Z` } }, {});
    assert.equal(resultado.fin, `${fin}T00:00:00.000Z`);
  });
}

test('sin ancla o factura fuera del ciclo no se inventa periodo', () => {
  assert.throws(() => periodoFacturado({ debit_date: '2026-10-03T00:00:00Z' }, {}, {}));
  assert.throws(() => periodoFacturado({ debit_date: '2026-10-02T00:00:00Z' },
    { auto_recurring: { start_date: '2026-10-03T00:00:00Z' } }, {}));
});

test('fechas reales de MP que cruzan medianoche UTC mantienen el mismo ciclo', () => {
  const periodo = periodoFacturado({ debit_date: '2026-10-02T20:00:44.000-04:00' },
    { auto_recurring: { start_date: '2026-10-02T19:58:58.000-04:00' } }, {});
  assert.equal(periodo.inicio, '2026-10-02T23:58:58.000Z');
  assert.equal(periodo.fin, '2026-11-02T23:58:58.000Z');
});

test('dos solicitudes de alta simultaneas crean un solo acuerdo remoto', async () => {
  const e = await crearEntorno();
  e.estado.tablas.suscriptions = [];
  const resultados = await Promise.all([e.servicio.crearPreapprovalSuscripcion(USUARIO, 'a@example.invalid'),
    e.servicio.crearPreapprovalSuscripcion(USUARIO, 'a@example.invalid')]);
  assert.equal(e.estado.altas.length, 1);
  assert.equal(e.estado.tablas.suscriptions.length, 1);
  assert.equal(resultados.filter((r) => !r.error).length, 1);
  assert.equal(resultados.find((r) => r.error).error.status, 409);
});

test('acuerdo autorizado se reutiliza y no inicia otro checkout', async () => {
  const e = await crearEntorno();
  e.estado.preapproval.status = 'authorized';
  const resultado = await e.servicio.crearPreapprovalSuscripcion(USUARIO, 'a@example.invalid');
  assert.equal(resultado.error, null);
  assert.equal(resultado.data.ya_autorizada, true);
  assert.equal(e.estado.altas.length, 0);
});

test('fallo consultando trial impide toda alta remota', async () => {
  const e = await crearEntorno();
  e.estado.tablas.suscriptions = [];
  // Diferenciar la consulta de acuerdos de la de trial.
  e.estado.errorBD = { tabla: 'suscriptions', operacion: 'select', plan: 'gratis' };
  const resultado = await e.servicio.crearPreapprovalSuscripcion(USUARIO, 'a@example.invalid');
  assert.ok(resultado.error);
  assert.equal(e.estado.altas.length, 0);
  assert.equal(e.estado.tablas.reservas_cobros.length, 0);
});

test('trial vigente programa el primer cobro al vencimiento', async () => {
  const e = await crearEntorno();
  e.estado.tablas.suscriptions = [{ user_id: USUARIO, plan: 'gratis', status: 'active',
    init_date: '2026-01-01T00:00:00', end_date: '2099-01-31T00:00:00', price: 0 }];
  assert.equal((await e.servicio.crearPreapprovalSuscripcion(USUARIO, 'a@example.invalid')).error, null);
  assert.equal(e.estado.altas[0].auto_recurring.start_date, '2099-01-31T00:00:00.000-00:00');
});

test('resultado incierto del POST bloquea nuevos intentos incluso con reserva vencida', async () => {
  const e = await crearEntorno();
  e.estado.tablas.suscriptions = [];
  e.estado.errorAlta = true;
  assert.ok((await e.servicio.crearPreapprovalSuscripcion(USUARIO, 'a@example.invalid')).error);
  await e.db.exec("update reservas_cobros set expires_at = now() - interval '2 hours'");
  assert.equal((await e.servicio.crearPreapprovalSuscripcion(USUARIO, 'a@example.invalid')).error.status, 409);
  assert.equal(e.estado.altas.length, 1);
});

test('reserva expirada antes de enviar puede recuperarse; token viejo no envia', async () => {
  const e = await crearEntorno(); await e.asegurarSiembra();
  assert.equal(await ejecutarRPC(e.db, 'reservar_cobro', { p_usuario: USUARIO, p_token: TOKEN }), true);
  await e.db.exec("update reservas_cobros set expires_at = now() - interval '1 second'");
  assert.equal(await ejecutarRPC(e.db, 'reservar_cobro', { p_usuario: USUARIO, p_token: TOKEN2 }), true);
  assert.equal(await ejecutarRPC(e.db, 'marcar_envio_cobro', { p_usuario: USUARIO, p_token: TOKEN }), false);
});

test('cancelar dos veces sincroniza sin perder el periodo pagado', async () => {
  const e = await crearEntorno(); await cobrar(e);
  assert.equal((await e.servicio.cancelarSuscripcion(USUARIO)).error, null);
  assert.equal((await e.servicio.cancelarSuscripcion(USUARIO)).error, null);
  assert.equal(e.estado.cancelaciones.length, 1);
  assert.equal((await e.acceso('2026-10-15T00:00:00Z')).tieneAcceso, true);
  assert.equal(e.estado.tablas.suscriptions[0].recurrence_status, 'cancelled');
});

test('respuesta de cancelacion perdida se confirma mediante GET', async () => {
  const e = await crearEntorno();
  e.estado.cancelarConErrorDespues = true;
  assert.equal((await e.servicio.cancelarSuscripcion(USUARIO)).error, null);
  assert.equal(e.estado.tablas.suscriptions[0].recurrence_status, 'cancelled');
});

test('cancelacion no confirmada devuelve error y no inventa estado cancelled', async () => {
  const e = await crearEntorno(); e.estado.errorCancelar = true;
  assert.ok((await e.servicio.cancelarSuscripcion(USUARIO)).error);
  assert.notEqual(e.estado.tablas.suscriptions[0].recurrence_status, 'cancelled');
});

test('un registro historico invalido no impide cancelar los demas acuerdos', async () => {
  const e = await crearEntorno();
  e.estado.tablas.suscriptions.unshift({ sub_id: TOKEN, user_id: USUARIO, plan: 'mensual',
    mp_sub_id: 'invalido', price: 80, status: 'pending' });
  const resultado = await e.servicio.cancelarSuscripcion(USUARIO);
  assert.ok(resultado.error);
  assert.equal(e.estado.cancelaciones.length, 1);
  assert.equal(e.estado.tablas.suscriptions.find((s) => s.mp_sub_id === 'abc123').recurrence_status, 'cancelled');
});

test('renovacion rechazada tiene siete dias desde el vencimiento; replay antiguo no la borra', async () => {
  const e = await crearEntorno(); e.estado.preapproval.status = 'authorized';
  await cobrar(e);
  e.estado.factura.id = 7891; e.estado.factura.debit_date = '2026-11-03T00:00:00Z';
  await cobrar(e, { id: 1235, status: 'rejected', date_approved: null, date_last_updated: '2026-11-03T00:00:00Z' });
  assert.equal((await e.acceso('2026-11-09T23:59:59Z')).enGracia, true);
  assert.equal((await e.acceso('2026-11-10T00:00:00Z')).tieneAcceso, false);
  e.estado.factura.id = 7890; e.estado.factura.debit_date = '2026-10-03T00:00:00Z';
  await cobrar(e, { id: 1234, status: 'approved', date_approved: '2026-10-03T00:00:00Z', date_last_updated: '2026-10-03T00:00:00Z' });
  assert.equal((await e.acceso('2026-11-10T00:00:00Z')).graciaVencida, true);
});

test('pending no inicia gracia y rechazo inicial no concede acceso', async () => {
  const e = await crearEntorno(); e.estado.preapproval.status = 'authorized';
  await cobrar(e, { status: 'rejected', date_approved: null });
  assert.equal((await e.acceso('2026-10-04T00:00:00Z')).tieneAcceso, false);
  await cobrar(e, { status: 'approved', date_approved: '2026-10-03T00:00:00Z', date_last_updated: '2026-10-04T00:00:00Z' });
  e.estado.factura.id = 7891; e.estado.factura.debit_date = '2026-11-03T00:00:00Z';
  await cobrar(e, { id: 1235, status: 'pending', date_approved: null, date_last_updated: '2026-11-03T00:00:00Z' });
  assert.equal((await e.acceso('2026-11-04T00:00:00Z')).tieneAcceso, false);
});

test('aprobacion tardia respeta factura; webhook de acuerdo no acorta vigencia', async () => {
  const e = await crearEntorno();
  await cobrar(e, { date_approved: '2026-10-10T00:00:00Z', date_last_updated: '2026-10-10T00:00:00Z' });
  e.estado.preapproval.status = 'authorized';
  await e.servicio.procesarWebhookSuscripcionPreapproval({ data: { id: 'abc123' } });
  assert.equal((await e.acceso('2026-11-02T23:59:59Z')).tieneAcceso, true);
  assert.equal((await e.acceso('2026-11-03T00:00:00Z')).tieneAcceso, false);
});

for (const status of ['refunded', 'charged_back']) {
  test(`${status} revoca solo ese pago y replay aprobado no restaura acceso`, async () => {
    const e = await crearEntorno(); await cobrar(e);
    await cobrar(e, { status, date_last_updated: '2026-10-05T00:00:00Z' });
    await cobrar(e, { status: 'approved', date_last_updated: '2026-10-03T00:00:00Z' });
    assert.equal((await e.acceso('2026-10-06T00:00:00Z')).tieneAcceso, false);
  });
}

test('reembolso parcial mantiene periodo y marca revision', async () => {
  const e = await crearEntorno(); await cobrar(e);
  await cobrar(e, { transaction_amount_refunded: 20, date_last_updated: '2026-10-05T00:00:00Z' });
  assert.equal((await e.acceso('2026-10-06T00:00:00Z')).tieneAcceso, true);
  assert.equal(e.estado.tablas.pagos_verificados[0].requiere_revision, true);
});

test('trial independiente sobrevive reembolso del pago mensual', async () => {
  const e = await crearEntorno();
  e.estado.tablas.suscriptions.push({ user_id: USUARIO, plan: 'gratis', status: 'active',
    init_date: '2026-10-01T00:00:00', end_date: '2026-11-01T00:00:00', price: 0 });
  await cobrar(e, { status: 'refunded' });
  assert.equal((await e.acceso('2026-10-06T00:00:00Z')).suscripcion.plan, 'gratis');
});

test('fallo SQL intermedio revierte ledger, historial y rol juntos', async () => {
  const e = await crearEntorno(); await e.asegurarSiembra();
  await e.db.exec("create function public.fallar_test() returns trigger language plpgsql as $$ begin raise exception 'fallo'; end $$; create trigger fallo_test before insert on pagos for each row execute function public.fallar_test();");
  try {
    assert.ok((await e.servicio.procesarWebhookMercadoPago(evento)).error);
    assert.equal((await e.db.query('select * from pagos_verificados')).rows.length, 0);
    assert.equal((await e.db.query('select * from pagos')).rows.length, 0);
  } finally { await e.db.exec('drop trigger fallo_test on pagos; drop function public.fallar_test()'); }
  await cobrar(e);
  assert.equal(e.estado.tablas.pagos_verificados.length, 1);
});

test('anon y authenticated no pueden ejecutar RPC financieros ni leer ledger', async () => {
  const e = await crearEntorno(); await e.asegurarSiembra();
  for (const role of ['anon','authenticated']) {
    await e.db.exec(`set role ${role}`);
    try {
      await assert.rejects(ejecutarRPC(e.db, 'reservar_cobro', { p_usuario: USUARIO, p_token: TOKEN }), /permission denied/);
      await assert.rejects(e.db.query('select * from pagos_verificados'), /permission denied/);
    } finally { await e.db.exec('reset role'); }
  }
  await e.db.exec('set role service_role');
  try { assert.equal(await ejecutarRPC(e.db, 'reservar_cobro', { p_usuario: USUARIO, p_token: TOKEN }), true); }
  finally { await e.db.exec('reset role'); }
});

test('sesion extra conserva precio del pedido aunque cambie el catalogo y resuelve pending previo', async () => {
  const e = await crearEntorno(); e.estado.tablas.sessions = [{ id: 1, type: 'especial', price: 50, title: 'Sesion' }];
  const respuestas = await Promise.all([e.servicio.crearPreferenciaSesionExtra(USUARIO, 'a@example.invalid', 1),
    e.servicio.crearPreferenciaSesionExtra(USUARIO, 'a@example.invalid', 1)]);
  assert.equal(e.estado.preferencias.length, 1);
  assert.ok(respuestas.some((r) => !r.error));
  const compra = e.estado.tablas.compras_extras[0];
  await e.db.exec('update sessions set price = 200 where id = 1');
  Object.assign(e.estado.payment, { external_reference: `extra:${compra.id}`, transaction_amount: 50, status: 'pending' });
  await cobrar(e);
  await cobrar(e, { id: 1235, status: 'approved', date_last_updated: '2026-10-04T00:00:00Z' });
  assert.equal(e.estado.tablas.extra_sessions.length, 1);
  assert.equal(e.estado.tablas.extra_sessions[0].status, 'pagada');
  assert.equal(e.estado.tablas.extra_sessions[0].mp_pay_id, '1235');
  assert.equal(e.estado.tablas.pagos.length, 2);
});

test('pago antiguo extra aprobado tras nuevo pedido pendiente converge sin conflicto unico', async () => {
  const e = await crearEntorno(); e.estado.tablas.sessions = [{ id: 1, type: 'especial', price: 50 }];
  await e.servicio.crearPreferenciaSesionExtra(USUARIO, 'a@example.invalid', 1);
  const primera = e.estado.tablas.compras_extras[0];
  await cobrar(e, { external_reference: `extra:${primera.id}`, transaction_amount: 50, status: 'rejected' });
  await e.servicio.crearPreferenciaSesionExtra(USUARIO, 'a@example.invalid', 1);
  const segunda = e.estado.tablas.compras_extras.find((c) => c.id !== primera.id);
  await cobrar(e, { id: 1235, external_reference: `extra:${segunda.id}`, status: 'pending', date_last_updated: '2026-10-04T00:00:00Z' });
  await cobrar(e, { id: 1234, external_reference: `extra:${primera.id}`, status: 'approved', date_last_updated: '2026-10-05T00:00:00Z' });
  const vigentes = e.estado.tablas.extra_sessions.filter((c) => c.status === 'pagada');
  assert.equal(vigentes.length, 1);
  assert.equal(vigentes[0].mp_pay_id, '1234');
  assert.equal(e.estado.tablas.pagos.length, 2);
});

test('reembolsar uno de dos pagos extra no revoca la otra compra aprobada', async () => {
  const e = await crearEntorno(); e.estado.tablas.sessions = [{ id: 1, type: 'especial', price: 50 }];
  await e.servicio.crearPreferenciaSesionExtra(USUARIO, 'a@example.invalid', 1);
  await cobrar(e, { external_reference: `extra:${e.estado.tablas.compras_extras[0].id}`, transaction_amount: 50 });
  await cobrar(e, { id: 1235, date_last_updated: '2026-10-04T00:00:00Z' });
  assert.ok(e.estado.tablas.pagos_verificados.every((p) => p.requiere_revision));
  await cobrar(e, { status: 'refunded', date_last_updated: '2026-10-05T00:00:00Z', transaction_amount_refunded: 50 });
  assert.equal(e.estado.tablas.extra_sessions.find((c) => c.status === 'pagada').mp_pay_id, '1234');
});

test('pending antiguo no reactiva un pedido rechazado cuando ya existe otro vigente', async () => {
  const e = await crearEntorno(); e.estado.tablas.sessions = [{ id: 1, type: 'especial', price: 50 }];
  await e.servicio.crearPreferenciaSesionExtra(USUARIO, 'a@example.invalid', 1);
  const primera = e.estado.tablas.compras_extras[0];
  await cobrar(e, { external_reference: `extra:${primera.id}`, transaction_amount: 50, status: 'rejected' });
  await e.servicio.crearPreferenciaSesionExtra(USUARIO, 'a@example.invalid', 1);
  const segunda = e.estado.tablas.compras_extras.find((c) => c.id !== primera.id);
  await cobrar(e, { id: 1235, external_reference: `extra:${primera.id}`, status: 'pending', date_last_updated: '2026-10-05T00:00:00Z' });
  assert.equal(e.estado.tablas.compras_extras.find((c) => c.id === primera.id).estado, 'rechazada');
  assert.equal(e.estado.tablas.compras_extras.find((c) => c.id === segunda.id).estado, 'lista');
  assert.equal(e.estado.tablas.pagos.length, 2);
});

test('dos aprobaciones de pedidos extra distintos marcan ambos cobros para revision', async () => {
  const e = await crearEntorno(); e.estado.tablas.sessions = [{ id: 1, type: 'especial', price: 50 }];
  await e.servicio.crearPreferenciaSesionExtra(USUARIO, 'a@example.invalid', 1);
  const primera = e.estado.tablas.compras_extras[0];
  await cobrar(e, { external_reference: `extra:${primera.id}`, transaction_amount: 50, status: 'rejected' });
  await e.servicio.crearPreferenciaSesionExtra(USUARIO, 'a@example.invalid', 1);
  const segunda = e.estado.tablas.compras_extras.find((c) => c.id !== primera.id);
  await cobrar(e, { id: 1235, external_reference: `extra:${segunda.id}`, status: 'approved', date_last_updated: '2026-10-04T00:00:00Z' });
  await cobrar(e, { id: 1234, external_reference: `extra:${primera.id}`, status: 'approved', date_last_updated: '2026-10-05T00:00:00Z' });
  assert.equal(e.estado.tablas.pagos_verificados.length, 2);
  assert.ok(e.estado.tablas.pagos_verificados.every((p) => p.requiere_revision));
});

test('un evento viejo del acuerdo no reactiva recurrencia cancelada', async () => {
  const e = await crearEntorno(); e.estado.preapproval.status = 'cancelled';
  await e.servicio.procesarWebhookSuscripcionPreapproval({ data: { id: 'abc123' } });
  e.estado.preapproval.status = 'authorized';
  e.estado.preapproval.last_modified = '2026-10-02T00:00:00Z';
  await e.servicio.procesarWebhookSuscripcionPreapproval({ data: { id: 'abc123' } });
  assert.equal(e.estado.tablas.suscriptions[0].recurrence_status, 'cancelled');
});

test('recalculo de acceso no degrada rol administrativo', async () => {
  const e = await crearEntorno(); e.estado.tablas.users[0].role = 'admin';
  await cobrar(e, { status: 'rejected' });
  assert.equal(e.estado.tablas.users[0].role, 'admin');
});

test('estado HTTP tolera fechas nulas y distingue pending de authorized futuro', async () => {
  const e = await crearEntorno();
  e.estado.preapproval.next_payment_date = '2099-01-01T00:00:00Z';
  await e.servicio.procesarWebhookSuscripcionPreapproval({ data: { id: 'abc123' } });
  const handler = e.rutas.stack.find((s) => s.route?.path === '/estado').route.stack.at(-1).handle;
  const respuesta = { status() { return this; }, json(data) { this.data = data; } };
  await handler({ usuario: { id: USUARIO } }, respuesta);
  assert.equal(respuesta.data.success, true);
  assert.equal(respuesta.data.data.checkout_pendiente, true);
  assert.equal(respuesta.data.data.pago_programado, false);
  assert.equal(respuesta.data.data.fecha_fin, null);
  e.estado.preapproval.status = 'authorized';
  await e.servicio.procesarWebhookSuscripcionPreapproval({ data: { id: 'abc123' } });
  await handler({ usuario: { id: USUARIO } }, respuesta);
  assert.equal(respuesta.data.data.pago_programado, true);
  assert.equal(respuesta.data.data.tiene_suscripcion, false);
});
