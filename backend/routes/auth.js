import express from 'express';
import { supabaseClient } from '../services/supabase.js';
import { obtenerGruposActivos, enviarCorreoBienvenida } from '../services/bienvenida.js';
import { obtenerAccesoUsuario } from '../services/suscripciones.js';

const router = express.Router();

// El alta de usuario la hace el trigger de Supabase (handle_new_user), asi que la
// bienvenida se dispara desde POST /api/auth/bienvenida (el frontend la llama tras
// iniciar sesion). Es idempotente: si welcome_sent_at ya esta escrito no vuelve a
// enviar. Antes existia aqui un POST /webhook que duplicaba ese alta; se elimino
// porque no estaba conectado en produccion y por eso era un endpoint abierto que
// cualquiera podia usar para crear usuarios y trials de 30 dias a un UUID arbitrario.
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
