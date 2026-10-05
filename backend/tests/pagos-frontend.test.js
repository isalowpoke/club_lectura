import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

function elemento() {
  const clases = new Set();
  return { textContent: '', children: [], className: '', disabled: false,
    classList: { toggle(c, activa) { if (activa) clases.add(c); else clases.delete(c); },
      contains(c) { return clases.has(c); } },
    replaceChildren(...children) { this.children = children; }, remove() {} };
}

async function cargarUI(estado) {
  const nodos = new Map(['suscripcion-estado','btn-suscribirse','btn-cancelar-suscripcion','info-sin-suscripcion'].map((id) => [id, elemento()]));
  const ctx = createContext({ window: {}, document: { getElementById: (id) => nodos.get(id), createElement: elemento },
    Auth: { verificarEstadoSuscripcion: async () => estado, formatearFecha: (f) => f } });
  runInContext(await readFile(new URL('../../frontend/js/dashboard.js', import.meta.url), 'utf8'), ctx);
  await ctx.window.Dashboard.cargarEstadoSuscripcion();
  return nodos;
}

test('checkout incompleto permite continuar sin presentarlo como cobro programado', async () => {
  const nodos = await cargarUI({ tiene_suscripcion: false, checkout_pendiente: true, puede_cancelar: true });
  assert.equal(nodos.get('btn-suscribirse').textContent, 'Continuar en Mercado Pago');
  assert.equal(nodos.get('btn-suscribirse').classList.contains('hidden'), false);
});

test('cancelacion conserva periodo pagado en UI y oculta nueva cancelacion', async () => {
  const nodos = await cargarUI({ tiene_suscripcion: true, recurrencia_cancelada: true,
    puede_cancelar: false, fecha_fin: '2026-11-03T00:00:00Z' });
  assert.equal(nodos.get('btn-cancelar-suscripcion').classList.contains('hidden'), true);
  assert.ok(nodos.get('suscripcion-estado').children.some((p) => p.textContent.includes('Conservas el periodo pagado')));
});

test('fecha nula y cobro en proceso no se presentan como rechazo ni fecha inventada', async () => {
  const nodos = await cargarUI({ tiene_suscripcion: false, pago_pendiente_cobro: true,
    cobro_rechazado: false, proxima_fecha_cobro: null });
  const texto = nodos.get('suscripcion-estado').children.map((p) => p.textContent).join(' ');
  assert.ok(texto.includes('esperamos la confirmación'));
  assert.equal(texto.includes('rechazado'), false);
  assert.equal(texto.includes('Fecha intentada'), false);
});

test('precios y dashboard comparten bloqueo de solicitud de suscripcion', async () => {
  let requests = 0;
  let resolver;
  const respuesta = new Promise((resolve) => { resolver = resolve; });
  const ctx = createContext({ window: { location: { href: '' } },
    localStorage: { getItem: () => null }, document: { createElement: elemento, body: { appendChild() {} } },
    setTimeout() {}, console: { error() {} },
    fetch: async () => { requests++; await respuesta; return { ok: true, json: async () => ({ success: true, data: { ya_autorizada: true } }) }; } });
  runInContext(await readFile(new URL('../../frontend/js/auth.js', import.meta.url), 'utf8'), ctx);
  ctx.Auth = ctx.window.Auth;
  runInContext(await readFile(new URL('../../frontend/js/pagos.js', import.meta.url), 'utf8'), ctx);
  const primero = ctx.window.Auth.crearPagoSuscripcion();
  const segundo = ctx.window.Pagos.iniciarCheckoutSuscripcion();
  resolver();
  await Promise.all([primero, segundo]);
  assert.equal(requests, 1);
  assert.equal(ctx.window.location.href, 'dashboard.html');
});
