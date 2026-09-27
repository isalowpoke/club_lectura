// contacto.mjs - Netlify Function para el formulario de contacto.
// Envia el correo por SMTP de Gmail (587/STARTTLS) via una funcion serverless;
// el egress de Railway bloquea SMTP, asi que el envio vive en Netlify (AWS).

import nodemailer from 'nodemailer';

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const CONTACTO_TO_CLUB = process.env.CONTACTO_TO_CLUB || GMAIL_USER;

// Rate limit ligero en memoria (10 mensajes/hora por IP)
const intentosPorIp = new Map();
const LIMITE = 10;
const VENTANA_MS = 60 * 60 * 1000;

function permitido(ip) {
  const ahora = Date.now();
  const intentos = (intentosPorIp.get(ip) || []).filter((t) => ahora - t < VENTANA_MS);
  if (intentos.length >= LIMITE) {
    intentosPorIp.set(ip, intentos);
    return false;
  }
  intentos.push(ahora);
  intentosPorIp.set(ip, intentos);
  return true;
}

function responder(status, data) {
  return new Response(JSON.stringify({ success: false, ...data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }
  if (req.method !== 'POST') {
    return responder(405, { error: 'Metodo no permitido' });
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'anonimo';
  if (!permitido(ip)) {
    return responder(429, { error: 'Demasiados mensajes enviados, intenta de nuevo en 1 hora' });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return responder(400, { error: 'Cuerpo invalido' });
  }

  const { nombre, email, subject, mensaje, website } = body;

  // Honeypot: si el campo oculto viene lleno es un bot
  if (website) {
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!nombre || typeof nombre !== 'string' || nombre.trim().length < 2 || nombre.length > 100) {
    return responder(400, { error: 'Nombre invalido (2-100 caracteres)' });
  }
  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 250) {
    return responder(400, { error: 'Correo electronico invalido' });
  }
  if (!mensaje || typeof mensaje !== 'string' || mensaje.trim().length < 10 || mensaje.length > 5000) {
    return responder(400, { error: 'Mensaje invalido (minimo 10 caracteres)' });
  }

  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    return responder(500, { error: 'El envio de correos no esta configurado' });
  }

  const asunto = (String(subject || 'general')).slice(0, 100).trim();
  const a = new Date().toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City',
    dateStyle: 'full',
    timeStyle: 'short',
  });

  let transporter;
  try {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });

    await transporter.sendMail({
      from: `"Club de Lectura Web" <${GMAIL_USER}>`,
      to: CONTACTO_TO_CLUB,
      replyTo: email.trim(),
      subject: `[Web] ${asunto} - ${nombre.trim().slice(0, 100)}`,
      text: `Nuevo mensaje desde el formulario de contacto del sitio.\n\nNombre: ${nombre.trim()}\nCorreo: ${email.trim()}\nAsunto: ${asunto}\nFecha: ${a}\n\nMensaje:\n${mensaje.trim()}`,
    });
  } catch (error) {
    console.error('Error enviando correo de contacto:', error);
    return responder(500, { error: 'No se pudo enviar el mensaje, intenta de nuevo' });
  }

  return new Response(
    JSON.stringify({ success: true, message: 'Mensaje enviado correctamente' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};