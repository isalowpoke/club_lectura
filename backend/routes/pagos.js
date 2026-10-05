import express from 'express';
import { supabaseClient } from '../services/supabase.js';
import { crearPreapprovalSuscripcion, crearPreferenciaSesionExtra, procesarWebhookMercadoPago,
  procesarWebhookSuscripcionPreapproval, procesarWebhookSuscripcionPagoAutorizado,
  procesarWebhookSuscripcionCancelada, cancelarSuscripcion } from '../services/mercadopago.js';
import { obtenerAccesoUsuario, presentarEstadoAcceso } from '../services/suscripciones.js';
import verificarUsuario from '../middleware/verificar-usuario.js';
import { presentarPago } from '../services/historial-pagos.js';
import verificarFirmaWebhook, { normalizarWebhook } from '../middleware/verificar-firma-webhook.js';

const router = express.Router();

function responderError(res, error) {
  return res.status(error.status === 409 ? 409 : 500).json({ success: false,
    error: error.status === 409 ? error.message : 'No se pudo completar la operación. Intenta verificar su estado nuevamente.' });
}

router.post('/suscripcion', verificarUsuario, async (req, res) => {
  try {
    const { data, error } = await crearPreapprovalSuscripcion(req.usuario.id, req.usuario.email);
    if (error) return responderError(res, error);
    return res.json({ success: true, data: { init_point: data.init_point,
      preference_id: data.id, ya_autorizada: !!data.ya_autorizada } });
  } catch (error) { return responderError(res, error); }
});

router.post('/sesion-extra', verificarUsuario, async (req, res) => {
  try {
    const sesionId = Number(req.body?.sesion_id);
    if (!Number.isSafeInteger(sesionId) || sesionId <= 0) {
      return res.status(400).json({ success: false, error: 'sesion_id invalido' });
    }
    // La reserva SQL toma el precio y verifica la sesion en la misma transaccion.
    const { data, error } = await crearPreferenciaSesionExtra(req.usuario.id, req.usuario.email, sesionId);
    if (error) return responderError(res, error);
    return res.json({ success: true, data: { init_point: data.init_point, preference_id: data.id } });
  } catch (error) { return responderError(res, error); }
});

router.post('/webhook', async (req, res) => {
  try {
    if (!process.env.MERCADOPAGO_WEBHOOK_SECRET?.trim()) {
      return res.status(503).json({ success: false, error: 'Webhook no configurado' });
    }
    let webhookData;
    try { webhookData = normalizarWebhook(req.query, req.body); }
    catch { return res.status(400).json({ success: false, error: 'Recurso de webhook invalido' }); }
    const { valida } = verificarFirmaWebhook({ xSignature: req.headers['x-signature'],
      xRequestId: req.headers['x-request-id'], dataId: webhookData.data.id, secret: process.env.MERCADOPAGO_WEBHOOK_SECRET });
    if (!valida) return res.status(401).json({ success: false, error: 'Firma invalida' });
    const handlers = { payment: procesarWebhookMercadoPago,
      subscription_preapproval: procesarWebhookSuscripcionPreapproval,
      subscription_created: procesarWebhookSuscripcionPreapproval,
      subscription_authorized_payment: procesarWebhookSuscripcionPagoAutorizado,
      subscription_cancelled: procesarWebhookSuscripcionCancelada };
    if (!Object.hasOwn(handlers, webhookData.type)) return res.json({ success: true, message: 'Tipo de notificacion no manejado' });
    const { data, error } = await handlers[webhookData.type](webhookData);
    if (error) throw error;
    return res.json({ success: true, data });
  } catch (error) {
    console.error('[WEBHOOK] Procesamiento fallido:', error.message);
    return res.status(500).json({ success: false, error: 'Error procesando webhook' });
  }
});

router.post('/cancelar', verificarUsuario, async (req, res) => {
  try {
    const { data, error } = await cancelarSuscripcion(req.usuario.id);
    if (error) return responderError(res, error);
    return res.json({ success: true, data, message: 'Recurrencia cancelada; se conserva el periodo pagado.' });
  } catch (error) { return responderError(res, error); }
});

router.get('/estado', verificarUsuario, async (req, res) => {
  try {
    return res.json({ success: true, data: presentarEstadoAcceso(await obtenerAccesoUsuario(req.usuario.id)) });
  } catch (error) { return responderError(res, error); }
});

router.get('/historial', verificarUsuario, async (req, res) => {
  try {
    const { data, error } = await supabaseClient.from('pagos')
      .select('mp_payment_id, monto, moneda, estado_mp, tipo, created_at')
      .eq('user_id', req.usuario.id).order('created_at', { ascending: false }).limit(20);
    if (error) throw new Error('Historial no disponible');
    return res.json({ success: true, data: (data || []).map(presentarPago) });
  } catch (error) { return responderError(res, error); }
});

export default router;
