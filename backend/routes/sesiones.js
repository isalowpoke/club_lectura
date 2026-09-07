import express from 'express';
import { supabaseClient } from '../services/supabase.js';

const router = express.Router();

// GET / - Proximas sesiones (publicas para autenticados)
router.get('/', async (req, res) => {
  try {
    const { data: sesiones, error } = await supabaseClient
      .from('sessions')
      .select('*')
      .gte('date', new Date().toISOString())
      .order('date', { ascending: true })
      .limit(10);
    
    if (error) {
      console.error('Error obteniendo sesiones:', error);
      return res.status(500).json({ success: false, error: 'Error al obtener sesiones' });
    }
    
    return res.json({ success: true, data: sesiones });
    
  } catch (error) {
    console.error('Error en GET /api/sesiones:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// GET /libros - Libros actuales y pasados
router.get('/libros', async (req, res) => {
  try {
    const { data: libros, error } = await supabaseClient
      .from('books')
      .select('*')
      .order('month', { ascending: false })
      .limit(12);
    
    if (error) {
      console.error('Error obteniendo libros:', error);
      return res.status(500).json({ success: false, error: 'Error al obtener libros' });
    }
    
    return res.json({ success: true, data: libros });
    
  } catch (error) {
    console.error('Error en GET /api/sesiones/libros:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

export default router;
