import express from 'express';
import { supabaseClient } from '../services/supabase.js';

const router = express.Router();

// POST /webhook - Webhook de Supabase para crear registros cuando un nuevo usuario se registra
router.post('/webhook', async (req, res) => {
  try {
    const { user, type } = req.body;
    
    if (type === 'INSERT' && user) {
      const usuarioData = {
        id: user.id,
        email: user.email,
        role: 'free',
      };
      
      const { data, error } = await supabaseClient
        .from('users')
        .insert(usuarioData)
        .select()
        .single();
      
      if (error) {
        console.error('Error insertando usuario en BD local:', error);
        return res.status(500).json({ success: false, error: 'Error creando registro de usuario' });
      }
      
      // Crear mes gratis automatico
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
        console.error('Error creando mes gratis:', errorSub);
      }
      
      console.log(`Nuevo usuario registrado: ${user.email} (ID: ${user.id}) - Mes gratis activado`);
      return res.json({ success: true, data });
    }
    
    return res.json({ success: true });
    
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
    
    const ahora = new Date().toISOString();
    
    let suscripcion = null;
    if (usuario.role === 'admin') {
      suscripcion = 'active';
    } else {
      const { data: suscripcionData } = await supabaseClient
        .from('suscriptions')
        .select('*')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .gte('end_date', ahora)
        .single();
      
      suscripcion = suscripcionData?.status || null;
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
