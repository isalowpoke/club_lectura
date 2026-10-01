// bienvenida.js - Envio del correo de bienvenida a nuevos usuarios.
// Railway bloquea SMTP saliente, asi que el envio vive en una Netlify Function
// (AWS, SMTP 587/STARTTLS). Este servicio solo dispara la llamada HTTPS.

import { supabaseClient } from './supabase.js';

const NETLIFY_WELCOME_URL = process.env.NETLIFY_WELCOME_URL;
const WELCOME_SECRET = process.env.WELCOME_SECRET;
const TIMEOUT_MS = 8000;

// Leer comunidades activas (WhatsApp, Discord, etc.)
export async function obtenerGruposActivos() {
  const { data, error } = await supabaseClient
    .from('groups')
    .select('name, url, description')
    .eq('active', true)
    .order('id', { ascending: true });

  return { data: data || [], error };
}

// Disparar (fire-and-forget) el correo de bienvenida hacia la Netlify Function.
export async function enviarCorreoBienvenida(email, nombre, grupos) {
  if (!NETLIFY_WELCOME_URL || !WELCOME_SECRET) {
    console.warn('[BIENVENIDA] NETLIFY_WELCOME_URL o WELCOME_SECRET no configurado');
    return { ok: false, error: 'Envio de bienvenida no configurado' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(NETLIFY_WELCOME_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-welcome-secret': WELCOME_SECRET,
      },
      body: JSON.stringify({ email, nombre, grupos: grupos || [] }),
      signal: controller.signal,
    });

    const resultado = await response.json().catch(() => ({}));
    const ok = response.ok && resultado.success !== false;
    if (!ok) {
      console.warn('[BIENVENIDA] Netlify rechazo el envio:', response.status, resultado.error);
    }
    return { ok, error: ok ? null : (resultado.error || `HTTP ${response.status}`) };
  } catch (error) {
    console.error('[BIENVENIDA] No se pudo disparar el correo de bienvenida:', error.message);
    return { ok: false, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}