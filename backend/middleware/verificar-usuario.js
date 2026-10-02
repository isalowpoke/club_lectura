import { supabaseClient } from '../services/supabase.js';

// Exige un JWT valido y deja el usuario en req.usuario. NO decide si tiene
// suscripcion: para eso esta services/suscripciones.js.
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

export default verificarUsuario;
