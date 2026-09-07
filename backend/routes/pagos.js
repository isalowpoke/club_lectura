import express from 'express';
import { supabaseClient } from '../services/supabase.js';
import {
  crearPreferenciaSuscripcion,
  crearPreferenciaSesionExtra,
  procesarWebhookMercadoPago,
  cancelarSuscripcion
} from '../services/mercadopago.js';

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

    const { data, error } = await crearPreferenciaSuscripcion(usuarioId, email);
    if (error) {
      console.error('[PAGOS] Error creando preferencia:', JSON.stringify(error));
      return res.status(500).json({ success: false, error: 'Error al crear preferencia de pago: ' + (error.message || JSON.stringify(error)) });
    }

    console.log('[PAGOS] Preferencia creada:', data?.id, 'init_point:', data?.init_point ? 'OK' : 'FALTA');

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
    const { sesion_id, monto } = req.body;

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

    // Verificar que el usuario no haya comprado ya esta sesion
    const { data: compraExistente } = await supabaseClient
      .from('extra_sessions')
      .select('id')
      .eq('user_id', usuarioId)
      .eq('session_id', sesion_id)
      .single();

    if (compraExistente) {
      return res.status(400).json({ success: false, error: 'Ya compraste esta sesion' });
    }

    const montoFinal = monto || sesion.price || 50.00;

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

    // Validar que sea una notificacion de pago
    if (webhookData.type !== 'payment') {
      return res.status(200).json({ success: true, message: 'Tipo de notificacion no manejado' });
    }

    const { data, error } = await procesarWebhookMercadoPago(webhookData);
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

    const { data: suscripcion, error } = await supabaseClient
      .from('suscriptions')
      .select('*')
      .eq('user_id', usuarioId)
      .eq('status', 'active')
      .gte('end_date', ahora)
      .order('sub_id', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error obteniendo estado de suscripcion:', error);
      return res.status(500).json({ success: false, error: 'Error al obtener estado' });
    }

    return res.json({
      success: true,
      data: {
        tiene_suscripcion: !!suscripcion,
        estado: suscripcion?.status || null,
        plan: suscripcion?.plan || null,
        fecha_fin: suscripcion?.end_date || null,
        precio: suscripcion?.price || null,
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
