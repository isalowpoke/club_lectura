import express from 'express';
import { supabaseClient } from '../services/supabase.js';
import verificarUsuario from '../middleware/verificar-usuario.js';
import { obtenerAccesoUsuario } from '../services/suscripciones.js';

const router = express.Router();

// La columna sessions.date es `timestamp without time zone` y se guarda en hora local
// de Mexico (America/Mexico_City). Comparar contra new Date().toISOString() (UTC)
// produce corrimientos: durante unas horas al dia las sesiones de "hoy" desaparecen.
function ahoraNaiveCDMX() {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const m = {};
  for (const p of partes) m[p.type] = p.value;
  return `${m.year}-${m.month}-${m.day} ${m.hour}:${m.minute}:${m.second}`;
}

// GET / - Proximas sesiones
//
// Requiere sesion iniciada, y `sessions.link` (el enlace de la reunion, que es lo
// que se esta vendiendo) SOLO se devuelve a quien tiene suscripcion vigente. Antes
// esta ruta no tenia ni autenticacion ni chequeo de suscripcion y hacia
// `select('*')`, asi que cualquier visitante anonimo se llevaba el enlace de
// Google Meet de las sesiones futuras sin pagar nada.
router.get('/', verificarUsuario, async (req, res) => {
  try {
    const { data: sesiones, error } = await supabaseClient
      .from('sessions')
      .select('*')
      .gte('date', ahoraNaiveCDMX())
      .order('date', { ascending: true })
      .limit(10);
    
    if (error) {
      console.error('Error obteniendo sesiones:', error);
      return res.status(500).json({ success: false, error: 'Error obteniendo sesiones' });
    }

    const { tieneAcceso } = await obtenerAccesoUsuario(req.usuario.id);

    // Sin suscripcion se conserva el catalogo (titulo, fecha, descripcion) y se
    // quita unicamente el enlace.
    const data = tieneAcceso
      ? sesiones
      : (sesiones || []).map(({ link, ...resto }) => resto);

    return res.json({ success: true, data, tiene_suscripcion: tieneAcceso });
    
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
      .select('*, sessions!books_session_id_fkey(date, hour, title)')
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
