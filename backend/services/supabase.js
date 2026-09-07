import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

export const supabaseUrl = process.env.SUPABASE_URL;
export const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
export const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

// Cliente para operaciones del servidor (con privilegios de servicio)
export const supabaseClient = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Helper: Obtener usuario por ID
export async function obtenerUsuarioPorId(usuarioId) {
  const { data, error } = await supabaseClient
    .from('users')
    .select('*')
    .eq('id', usuarioId)
    .single();
  
  return { data, error };
}

// Helper: Actualizar usuario
export async function actualizarUsuario(usuarioId, updates) {
  const { data, error } = await supabaseClient
    .from('users')
    .update(updates)
    .eq('id', usuarioId)
    .select()
    .single();
  
  return { data, error };
}

// Helper: Obtener suscripcion por usuario
export async function obtenerSuscripcionPorUsuarioId(usuarioId) {
  const { data, error } = await supabaseClient
    .from('suscriptions')
    .select('*')
    .eq('user_id', usuarioId)
    .eq('status', 'active')
    .single();
  
  return { data, error };
}
