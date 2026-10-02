import express from 'express';
import crypto from 'crypto';
import { supabaseClient } from '../services/supabase.js';
import { obtenerGruposActivos, enviarCorreoBienvenida } from '../services/bienvenida.js';
import { obtenerAccesoUsuario } from '../services/suscripciones.js';

const router = express.Router();

// Comparacion en tiempo constante para no filtrar el secreto por tiempos de respuesta.
function secretoValido(recibido, esperado) {
  if (typeof recibido !== 'string' || typeof esperado !== 'string' || !esperado) {
    return false;
  }
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// El alta de usuario la hace el trigger de Supabase (handle_new_user), no este
// webhook, asi que la bienvenida se dispara desde POST /api/auth/bienvenida
// (el frontend la llama tras iniciar sesion). Es idempotente: si welcome_sent_at
// ya esta escrito no vuelve a enviar.
async function enviarBienvenidaSiHaceFalta(user) {
  const { data: usuario, error: errorUsuario } = await supabaseClient
    .from('users')
    .select('welcome_sent_at')
    .eq('id', user.id)
    .maybeSingle();

  if (errorUsuario) {
    console.warn('[BIENVENIDA] No se pudo leer el usuario:', errorUsuario.message);
    return { enviado: false, motivo: 'Error leyendo usuario' };
  }

  if (!usuario) {
    // El trigger de Supabase puede tardar un instante en crear la fila
    return { enviado: false, motivo: 'Usuario aun no registrado' };
  }

  if (usuario.welcome_sent_at) {
    return { enviado: false, motivo: 'Ya habia recibido la bienvenida' };
  }

  const nombre = user.user_metadata?.full_name
    || user.user_metadata?.name
    || String(user.email).split('@')[0] || '';

  // Reclamo atomico antes de enviar: leen->envian->marcaba permitia que dos
  // peticiones concurrentes (dos pestanas) enviaran el correo dos veces. El
  // UPDATE ... WHERE welcome_sent_at IS NULL resuelve en una sola fila.
  const marca = new Date().toISOString();
  const { data: reclamo, error: errorReclamo } = await supabaseClient
    .from('users')
    .update({ welcome_sent_at: marca })
    .eq('id', user.id)
    .is('welcome_sent_at', null)
    .select('id')
    .maybeSingle();

  if (errorReclamo) {
    console.warn('[BIENVENIDA] No se pudo reservar el envio:', errorReclamo.message);
    return { enviado: false, motivo: 'Error reservando el envio' };
  }

  if (!reclamo) {
    return { enviado: false, motivo: 'Ya habia recibido la bienvenida' };
  }

  const { data: grupos } = await obtenerGruposActivos();
  const resultado = await enviarCorreoBienvenida(user.email, nombre, grupos);

  if (!resultado.ok) {
    // Se libera el reclamo para que un reintento posterior pueda enviarlo.
    await supabaseClient
      .from('users')
      .update({ welcome_sent_at: null })
      .eq('id', user.id)
      .eq('welcome_sent_at', marca);

    console.warn(`[BIENVENIDA] No se pudo enviar a ${user.email}:`, resultado.error);
    return { enviado: false, motivo: resultado.error };
  }

  console.log(`[BIENVENIDA] Correo enviado a ${user.email}`);
  return { enviado: true, motivo: null };
}

// ============================================
// POST /api/auth/bienvenida
// Envia el correo de bienvenida (link + QR de la comunidad) una sola vez.
// La llama el frontend tras iniciar sesion; responde rapido y no rompe nada
// si falla (best-effort).
// ============================================
router.post('/bienvenida', async (req, res) => {
  try {
    const session = req.headers.authorization?.split(' ')[1];
    if (!session) {
      return res.status(401).json({ success: false, error: 'Token no proporcionado' });
    }

    const { data: { user }, error: errorUser } = await supabaseClient.auth.getUser(session);
    if (errorUser || !user) {
      return res.status(401).json({ success: false, error: 'Token invalido' });
    }

    const resultado = await enviarBienvenidaSiHaceFalta(user);

    return res.json({
      success: true,
      data: { enviado: resultado.enviado, motivo: resultado.motivo }
    });

  } catch (error) {
    console.error('Error en POST /api/auth/bienvenida:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// POST /webhook - Webhook de Supabase para crear registros cuando un nuevo usuario se registra
//
// Este endpoint queda cerrado por defecto: sin SUPABASE_WEBHOOK_SECRET configurado
// responde 503 y no escribe nada. Antes aceptaba el body de cualquiera, asi que
// cualquiera podia insertar filas en `users` y regalar un trial de 30 dias a un
// UUID arbitrario. Sigue el mismo patron de secreto que POST /api/keepalive.
router.post('/webhook', async (req, res) => {
  const secreto = process.env.SUPABASE_WEBHOOK_SECRET;

  if (!secreto) {
    console.error('[auth] SUPABASE_WEBHOOK_SECRET no configurado: /api/auth/webhook deshabilitado');
    return res.status(503).json({ success: false, error: 'Webhook no configurado' });
  }

  if (!secretoValido(req.headers['x-webhook-secret'], secreto)) {
    return res.status(401).json({ success: false, error: 'No autorizado' });
  }

  try {
    const { user, type } = req.body;

    if (type !== 'INSERT' || !user?.id) {
      return res.status(400).json({ success: false, error: 'Payload invalido' });
    }

    // Idempotente: el trigger handle_new_user() ya suele haber creado la fila, y un
    // reenvio del webhook no debe duplicar nada.
    const { data: existente } = await supabaseClient
      .from('users')
      .select('id')
      .eq('id', user.id)
      .maybeSingle();

    if (existente) {
      return res.json({ success: true, data: { ya_existia: true } });
    }

    const { error: errorUsuario } = await supabaseClient
      .from('users')
      .insert({ id: user.id, email: user.email, role: 'free' });

    if (errorUsuario) {
      console.error('Error creando usuario:', errorUsuario.message);
      return res.status(500).json({ success: false, error: 'Error creando registro de usuario' });
    }

    // Mes gratis, solo si no existe ya una fila 'gratis' para ese usuario.
    const { data: trialExistente } = await supabaseClient
      .from('suscriptions')
      .select('sub_id')
      .eq('user_id', user.id)
      .eq('plan', 'gratis')
      .maybeSingle();

    let trialCreado = false;
    if (!trialExistente) {
      const ahora = new Date();
      const finMesGratis = new Date(ahora);
      finMesGratis.setDate(finMesGratis.getDate() + 30);

      const { error: errorSub } = await supabaseClient
        .from('suscriptions')
        .insert({
          user_id: user.id,
          plan: 'gratis',
          status: 'active',
          init_date: ahora.toISOString(),
          end_date: finMesGratis.toISOString(),
          price: 0,
        });

      if (errorSub) {
        console.error('Error creando mes gratis:', errorSub.message);
      } else {
        trialCreado = true;
      }
    }

    console.log(`[auth] Alta via webhook: ${user.email} (ID: ${user.id}) - Mes gratis ${trialCreado ? 'activado' : 'ya existente'}`);
    return res.json({ success: true, data: { creado: true, trial_creado: trialCreado } });

  } catch (error) {
    console.error('Error en webhook de auth:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// GET /usuario/estado - Verificar estado de usuario
router.get('/usuario/estado', async (req, res) => {
  try {
    const session = req.headers.authorization?.split(' ')[1];
    if (!session) {
      return res.status(401).json({ success: false, error: 'Token no proporcionado' });
    }
    
    const { data: { user }, error: errorUser } = await supabaseClient.auth.getUser(session);
    if (errorUser || !user) {
      return res.status(401).json({ success: false, error: 'Token invalido' });
    }
    
    const { data: usuario, error: errorUsuario } = await supabaseClient
      .from('users')
      .select('*')
      .eq('id', user.id)
      .single();
    
    if (errorUsuario) {
      return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
    }
    
    let suscripcion = null;
    if (usuario.role === 'admin') {
      suscripcion = 'active';
    } else {
      // Antes usaba .single() sobre `suscriptions`, que con varias filas
      // coincidentes (el caso normal de un suscriptor de pago que conserva el
      // trial 'gratis') devolvia error y terminaba reportando SIN acceso.
      // obtenerAccesoUsuario es la misma regla que aplica /api/pagos y
      // /api/sesiones, incluida la ventana de gracia del cobro fallido.
      const { tieneAcceso } = await obtenerAccesoUsuario(user.id);
      suscripcion = tieneAcceso ? 'active' : null;
    }
    
    return res.json({
      success: true,
      data: {
        id: usuario.id,
        email: usuario.email,
        role: usuario.role,
        suscripcion: suscripcion,
        tieneContenidoAcceso: suscripcion === 'active',
      }
    });
    
  } catch (error) {
    console.error('Error verificando estado de usuario:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

export default router;
