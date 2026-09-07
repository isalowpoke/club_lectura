// src/middleware/verificar-suscripcion.js
import { supabaseClient } from '../services/supabase.js';

async function verificarSuscripcionActiva(req, res, next) {
  try {
    const session = req.headers.authorization?.split(' ')[1];
    if (!session) {
      return res.status(401).json({ success: false, error: 'Token no proporcionado' });
    }
    
    const { data: { user }, error: errorUser } = await supabaseClient.auth.getUser(session);
    if (errorUser || !user) {
      return res.status(401).json({ success: false, error: 'Token invalido' });
    }
    
    const ahora = new Date().toISOString();
    
    const { data: suscripcion, error: errorSuscripcion } = await supabaseClient
      .from('suscriptions')
      .select('*')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .gte('end_date', ahora)
      .single();
    
    if (errorSuscripcion || !suscripcion) {
      return res.status(403).json({ 
        success: false, 
        error: 'Se requiere suscripcion activa',
        code: 'NO_SUBSCRIPTION'
      });
    }
    
    req.usuario = user;
    req.suscripcion = suscripcion;
    next();
    
  } catch (error) {
    console.error('Error verificando suscripcion:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
}

function verificarSuscripcionSolo(req, res, next) {
  return verificarSuscripcionActiva(req, res, next);
}

export default { verificarSuscripcionSolo };