import express from 'express';
import { supabaseClient } from '../services/supabase.js';
import {
  crearPreapprovalSuscripcion,
  crearPreferenciaSesionExtra,
  procesarWebhookMercadoPago,
  procesarWebhookSuscripcionPreapproval,
  procesarWebhookSuscripcionPagoAutorizado,
  procesarWebhookSuscripcionCancelada,
  cancelarSuscripcion,
  interpretarFechaUtc,
  calcularLimiteGracia
} from '../services/mercadopago.js';
import verificarFirmaWebhook from '../middleware/verificar-firma-webhook.js';

const router = express.Router();

// Helper: Verificar usuario autenticado
async function verificarUsuario(req, res, next) {
  try {
    const session = req.headers.authorization?.split(' ')[1];
    if (!session) {
      return res.status(401).json({ success: false, error: 'Token no proporcionado' });
    }

    const { data: { user }, error: errorUser } = await supabaseClient.auth.getUser(session);
    if (errorUser || !user) {
      return res.status(401).json({ success: false, error: 'Token invalido' });
    }

    req.usuario = user;
    next();

  } catch (error) {
    console.error('Error verificando usuario:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
}

// ============================================
// POST /api/pagos/suscripcion
// ============================================
router.post('/suscripcion', verificarUsuario, async (req, res) => {
  try {
    const usuarioId = req.usuario.id;
    const email = req.usuario.email;
    console.log('[PAGOS] Creando preferencia para:', email, usuarioId);

    const { data, error } = await crearPreapprovalSuscripcion(usuarioId, email);
    if (error) {
      console.error('[PAGOS] Error creando preapproval:', JSON.stringify(error));
      return res.status(500).json({ success: false, error: 'Error al crear suscripcion recurrente: ' + (error.message || JSON.stringify(error)) });
    }

    console.log('[PAGOS] Preapproval creado:', data?.id, 'init_point:', data?.init_point ? 'OK' : 'FALTA');

    return res.json({
      success: true,
      data: {
        init_point: data.init_point,
        preference_id: data.id,
      }
    });

  } catch (error) {
    console.error('Error en POST /api/pagos/suscripcion:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// ============================================
// POST /api/pagos/sesion-extra
// ============================================
router.post('/sesion-extra', verificarUsuario, async (req, res) => {
  try {
    const usuarioId = req.usuario.id;
    const email = req.usuario.email;
    const { sesion_id } = req.body;

    if (!sesion_id) {
      return res.status(400).json({ success: false, error: 'sesion_id es requerido' });
    }

    // Verificar que la sesion existe y es especial
    const { data: sesion, error: errorSesion } = await supabaseClient
      .from('sessions')
      .select('id, title, type, price')
      .eq('id', sesion_id)
      .single();

    if (errorSesion || !sesion) {
      return res.status(404).json({ success: false, error: 'Sesion no encontrada' });
    }

    if (sesion.type !== 'especial') {
      return res.status(400).json({ success: false, error: 'Solo se pueden comprar sesiones especiales' });
    }

    // Verificar que el usuario no haya comprado ya esta sesion.
    // Solo cuentan las compras vigentes: una rechazada libera el lugar para
    // reintentar. maybeSingle evita el error PGRST116 de .single() cuando
    // existen varias filas historicas.
    const { data: compraExistente, error: errorCompra } = await supabaseClient
      .from('extra_sessions')
      .select('id')
      .eq('user_id', usuarioId)
      .eq('session_id', sesion_id)
      .neq('status', 'rechazada')
      .limit(1)
      .maybeSingle();

    if (errorCompra) {
      console.error('Error verificando compra previa:', errorCompra);
      return res.status(500).json({ success: false, error: 'Error al verificar compra previa' });
    }

    if (compraExistente) {
      return res.status(400).json({ success: false, error: 'Ya compraste esta sesion' });
    }

    // El monto lo define el servidor desde el precio de la sesion: el cliente
    // no puede elegir cuanto paga.
    const montoFinal = sesion.price || 50.00;

    const { data, error } = await crearPreferenciaSesionExtra(
      usuarioId, email, sesion_id, sesion.title, montoFinal
    );

    if (error) {
      console.error('Error creando preferencia de sesion extra:', error);
      return res.status(500).json({ success: false, error: 'Error al crear preferencia de pago' });
    }

    return res.json({
      success: true,
      data: {
        init_point: data.init_point,
        preference_id: data.id,
      }
    });

  } catch (error) {
    console.error('Error en POST /api/pagos/sesion-extra:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// ============================================
// POST /api/pagos/webhook
// ============================================
router.post('/webhook', async (req, res) => {
  try {
    const webhookData = req.body;
    const tipoNotificacion = req.query.type || webhookData.type;

    // Validar firma HMAC si el secreto esta configurado (produccion)
    const dataId = req.query['data.id'] || webhookData.data?.id || webhookData.id || null;
    const { valida: firmaValida, motivo: motivoFirma } = verificarFirmaWebhook({
      xSignature: req.headers['x-signature'],
      xRequestId: req.headers['x-request-id'],
      dataId,
      secret: process.env.MERCADOPAGO_WEBHOOK_SECRET,
    });

    if (!firmaValida) {
      console.warn('[WEBHOOK] Firma invalida, request rechazado. Motivo:', motivoFirma);
      return res.status(401).json({ success: false, error: 'Firma invalida' });
    }
    if (motivoFirma.startsWith('MERCADOPAGO_WEBHOOK_SECRET no configurado')) {
      console.warn('[WEBHOOK]', motivoFirma, '- se continua en modo desarrollo');
    }

    // Validar que sea una notificacion conocida
    let result;
    if (tipoNotificacion === 'payment') {
      result = await procesarWebhookMercadoPago(webhookData);
    } else if (tipoNotificacion === 'subscription_preapproval' || tipoNotificacion === 'subscription_created') {
      // Evento real de MP para vinculacion/actualizacion de una suscripcion.
      result = await procesarWebhookSuscripcionPreapproval(webhookData);
    } else if (tipoNotificacion === 'subscription_authorized_payment') {
      result = await procesarWebhookSuscripcionPagoAutorizado(webhookData);
    } else if (tipoNotificacion === 'subscription_cancelled') {
      result = await procesarWebhookSuscripcionCancelada(webhookData);
    } else {
      return res.status(200).json({ success: true, message: 'Tipo de notificacion no manejado' });
    }

    const { data, error } = result;
    if (error) {
      console.error('Error procesando webhook:', error);
      return res.status(200).json({ success: false, error: 'Error procesando webhook' });
    }

    return res.status(200).json({ success: true, data });

  } catch (error) {
    console.error('Error en webhook de Mercado Pago:', error);
    return res.status(200).json({ success: false, error: 'Error procesando webhook' });
  }
});

// ============================================
// POST /api/pagos/cancelar
// ============================================
router.post('/cancelar', verificarUsuario, async (req, res) => {
  try {
    const usuarioId = req.usuario.id;

    const { data, error } = await cancelarSuscripcion(usuarioId);
    if (error) {
      console.error('Error cancelando suscripcion:', error);
      return res.status(500).json({ success: false, error: error.message || 'Error al cancelar suscripcion' });
    }

    return res.json({
      success: true,
      message: 'Suscripcion cancelada exitosamente'
    });

  } catch (error) {
    console.error('Error en POST /api/pagos/cancelar:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// ============================================
// GET /api/pagos/estado
// ============================================
router.get('/estado', verificarUsuario, async (req, res) => {
  try {
    const usuarioId = req.usuario.id;
    const ahora = new Date().toISOString();

    // Ventana de gracia: un cobro de renovacion fallido NO quita el acceso al
    // instante (MP reintenta), pero una vez vencida la gracia la fila deja de dar
    // acceso aunque siga 'active'. El filtro se aplica aqui y no con .or() porque
    // embeber un timestamp en la sintaxis de PostgREST es fragil de parsear.
    const limiteGraciaMs = new Date(calcularLimiteGracia()).getTime();

    // Suscripcion vigente (gratis o de pago) que da acceso
    const { data: candidatas, error } = await supabaseClient
      .from('suscriptions')
      .select('*')
      .eq('user_id', usuarioId)
      .eq('status', 'active')
      .gte('end_date', ahora)
      .order('sub_id', { ascending: false });

    if (error) {
      console.error('Error obteniendo estado de suscripcion:', error);
      return res.status(500).json({ success: false, error: 'Error al obtener estado' });
    }

    let suscripcion = null;
    let graciaVencida = false;
    for (const fila of candidatas || []) {
      if (!fila.failed_at) {
        suscripcion = fila;
        break;
      }
      const falloMs = interpretarFechaUtc(fila.failed_at).getTime();
      if (falloMs > limiteGraciaMs) {
        suscripcion = fila;
        break;
      }
      // Habia una activa pero la gracia del cobro fallido ya se agoto.
      graciaVencida = true;
    }

    // Suscripcion de pago programada o con cobro pendiente (durante/despues de la prueba)
    const { data: pendiente } = await supabaseClient
      .from('suscriptions')
      .select('sub_id, init_date, end_date')
      .eq('user_id', usuarioId)
      .eq('plan', 'mensual')
      .eq('status', 'pending')
      .not('mp_sub_id', 'is', null)
      .order('init_date', { ascending: true })
      .limit(1)
      .maybeSingle();

    const ahoraMs = Date.now();
    const pagoProgramado = !!pendiente && interpretarFechaUtc(pendiente.init_date).getTime() >= ahoraMs;
    const pagoPendienteCobro = !!pendiente && !pagoProgramado;

    const proximaCobro = pendiente?.init_date
      || (suscripcion ? suscripcion.end_date : null);

    return res.json({
      success: true,
      data: {
        tiene_suscripcion: !!suscripcion,
        estado: suscripcion ? 'activa' : 'inactiva',
        plan: suscripcion?.plan || null,
        precio: suscripcion?.price || null,
        fecha_fin: suscripcion?.end_date
          ? interpretarFechaUtc(suscripcion.end_date).toISOString()
          : null,
        en_prueba: suscripcion?.plan === 'gratis',
        renovacion_fallida: graciaVencida,
        pago_programado: pagoProgramado,
        pago_pendiente_cobro: pagoPendienteCobro,
        proxima_fecha_cobro: proximaCobro
          ? interpretarFechaUtc(proximaCobro).toISOString()
          : null,
      }
    });

  } catch (error) {
    console.error('Error en GET /api/pagos/estado:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// ============================================
// GET /api/pagos/historial
// ============================================
router.get('/historial', verificarUsuario, async (req, res) => {
  try {
    const usuarioId = req.usuario.id;

    const { data: pagos, error } = await supabaseClient
      .from('pagos')
      .select('*')
      .eq('user_id', usuarioId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      console.error('Error obteniendo historial de pagos:', error);
      return res.status(500).json({ success: false, error: 'Error al obtener historial' });
    }

    return res.json({
      success: true,
      data: pagos || []
    });

  } catch (error) {
    console.error('Error en GET /api/pagos/historial:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

export default router;
