import express from 'express';
import { supabaseClient } from '../services/supabase.js';

const router = express.Router();

router.get('/keep-alive', async (req, res) => {
  try {
    if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
      return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    const { count, error } = await supabaseClient
      .from('sessions')
      .select('id', { count: 'exact', head: true });

    if (error) {
      return res.status(500).json({ success: false, error: 'Error consultando la base de datos' });
    }

    return res.json({ success: true, count });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

export default router;