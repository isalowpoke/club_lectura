// verificar-firma-webhook.js - Validacion de firma HMAC de Mercado Pago
import { createHmac, timingSafeEqual } from 'node:crypto';
import { validarIdRecurso } from '../services/validar-pago-suscripcion.js';

// Algoritmo oficial MP:
//   manifiesto = "id:{data.id};request-id:{x-request-id};ts:{ts};"
//   (se omiten los pares cuyos valores no esten presentes)
//   firma = HMAC-SHA256(secreto, manifiesto) en hexadecimal
//   compararla en tiempo constante contra v1 del header x-signature
export function verificarFirmaWebhook({ xSignature, xRequestId, dataId, secret }) {
  if (typeof secret !== 'string' || !secret.trim()) {
    return { valida: false, motivo: 'MERCADOPAGO_WEBHOOK_SECRET no configurado' };
  }
  if (typeof xSignature !== 'string') {
    return { valida: false, motivo: 'Falta header x-signature' };
  }

  let ts = null;
  let v1 = null;
  for (const parte of xSignature.split(',')) {
    const idx = parte.indexOf('=');
    if (idx === -1) continue;
    const clave = parte.slice(0, idx).trim();
    const valor = parte.slice(idx + 1).trim();
    if (clave === 'ts') ts = valor;
    if (clave === 'v1') v1 = valor;
  }

  if (!/^\d+$/.test(ts || '') || !/^[a-f\d]{64}$/i.test(v1 || '')) {
    return { valida: false, motivo: 'Header x-signature sin ts/v1' };
  }

  let manifiesto = '';
  if (dataId) manifiesto += `id:${String(dataId).toLowerCase()};`;
  if (xRequestId) manifiesto += `request-id:${xRequestId};`;
  manifiesto += `ts:${ts};`;

  const hashCalculado = createHmac('sha256', secret).update(manifiesto).digest('hex');
  const hashRecibido = v1.toLowerCase();

  const a = Buffer.from(hashCalculado, 'hex');
  const b = Buffer.from(hashRecibido, 'hex');
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return { valida: false, motivo: 'Firma no coincide' };
  }
  if (!timingSafeEqual(a, b)) {
    return { valida: false, motivo: 'Firma no coincide' };
  }
  return { valida: true, motivo: 'OK' };
}

export default verificarFirmaWebhook;

// El id de nivel superior identifica la notificacion, no el recurso de MP.
export function normalizarWebhook(query = {}, body = {}) {
  const normalizarId = (valor) => {
    if (valor === undefined || valor === null) return null;
    return validarIdRecurso(valor);
  };
  const queryId = normalizarId(query['data.id']);
  const bodyId = normalizarId(body?.data?.id);
  if (queryId && bodyId && queryId !== bodyId) {
    throw new Error('IDs de recurso discrepantes');
  }
  const id = queryId || bodyId;
  if (!id) throw new Error('Falta data.id');
  if (query.type && body?.type && query.type !== body.type) {
    throw new Error('Tipos de notificacion discrepantes');
  }
  const type = query.type || body?.type;
  if (typeof type !== 'string' || !/^[a-z_]+$/.test(type)) {
    throw new Error('Tipo de notificacion invalido');
  }
  return { type, data: { id } };
}
