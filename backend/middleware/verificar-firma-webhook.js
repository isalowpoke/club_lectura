// verificar-firma-webhook.js - Validacion de firma HMAC de Mercado Pago
import { createHmac, timingSafeEqual } from 'node:crypto';

// Algoritmo oficial MP:
//   manifiesto = "id:{data.id};request-id:{x-request-id};ts:{ts};"
//   (se omiten los pares cuyos valores no esten presentes)
//   firma = HMAC-SHA256(secreto, manifiesto) en hexadecimal
//   compararla en tiempo constante contra v1 del header x-signature
export function verificarFirmaWebhook({ xSignature, xRequestId, dataId, secret }) {
  if (!secret) {
    return { valida: true, motivo: 'MERCADOPAGO_WEBHOOK_SECRET no configurado (validacion omitida)' };
  }
  if (!xSignature) {
    return { valida: false, motivo: 'Falta header x-signature' };
  }

  let ts = null;
  let v1 = null;
  for (const parte of xSignature.split(',')) {
    const idx = parte.indexOf('=');
    if (idx === -1) continue;
    const clave = parte.slice(0, idx).trim();
    const valor = parte.slice(idx + 1);
    if (clave === 'ts') ts = valor;
    if (clave === 'v1') v1 = valor;
  }

  if (!ts || !v1) {
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
  return { valida: timingSafeEqual(a, b), motivo: 'OK' };
}

export default verificarFirmaWebhook;