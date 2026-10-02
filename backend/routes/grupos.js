// grupos.js - Comunidades externas (WhatsApp, Discord, etc.).
// Solo accesible para usuarios con suscripcion activa (gratis o de pago).

import express from 'express';
import { supabaseClient } from '../services/supabase.js';
import verificarSuscripcion from '../middleware/verificar-suscripcion.js';

const router = express.Router();

// GET /api/grupos - Lista de comunidades activas
router.get('/', verificarSuscripcion, async (req, res) => {
  try {
    const { data, error } = await supabaseClient
      .from('groups')
      .select('name, url, description')
      .eq('active', true)
      .order('id', { ascending: true });

    if (error) {
      console.error('Error obteniendo grupos:', error);
      return res.status(500).json({ success: false, error: 'Error al obtener la comunidad' });
    }

    return res.json({ success: true, data: data || [] });

  } catch (error) {
    console.error('Error en GET /api/grupos:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

export default router;