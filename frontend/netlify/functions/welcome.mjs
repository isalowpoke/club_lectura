// welcome.mjs - Netlify Function que envia el correo de bienvenida a nuevos
// usuarios con acceso a la comunidad (links + QR inline por comunidad).
// Railway bloquea SMTP saliente, asi que el envio vive en Netlify (AWS).
// Endpoint interno: POST /api/welcome (protegido con WELCOME_SECRET).

import nodemailer from 'nodemailer';
import QRCode from 'qrcode';

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const WELCOME_SECRET = process.env.WELCOME_SECRET;

function escaparHTML(texto) {
  return String(texto || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function esUrlValida(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
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

  // Endpoint interno: requiere el secreto compartido con el backend
  const secretoRecibido = req.headers.get('x-welcome-secret');
  if (!secretoRecibido || secretoRecibido !== WELCOME_SECRET) {
    return responder(401, { error: 'No autorizado' });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return responder(400, { error: 'Cuerpo invalido' });
  }

  const { email, nombre, grupos } = body;

  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 250) {
    return responder(400, { error: 'Correo electronico invalido' });
  }
  if (nombre !== undefined && (typeof nombre !== 'string' || nombre.length > 200)) {
    return responder(400, { error: 'Nombre invalido' });
  }
  if (grupos !== undefined && !Array.isArray(grupos)) {
    return responder(400, { error: 'Grupos invalidos' });
  }

  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    return responder(500, { error: 'El envio de correos no esta configurado' });
  }

  const nombreLimpio = String(nombre || email.split('@')[0]).trim();
  const gruposLimpios = (grupos || [])
    .filter((g) => g && typeof g === 'object' && typeof g.url === 'string' && esUrlValida(g.url))
    .slice(0, 6)
    .map((g) => ({
      nombre: String(g.nombre || 'Comunidad').slice(0, 100),
      url: g.url.trim(),
      descripcion: g.description ? String(g.description).slice(0, 300) : '',
    }));

  const attachments = [];
  let bloqueComunidades = '';

  if (gruposLimpios.length > 0) {
    const bloques = await Promise.all(gruposLimpios.map(async (grupo, index) => {
      const cid = `qr_${index}`;
      const png = await QRCode.toBuffer(grupo.url, {
        width: 220,
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
      });
      attachments.push({
        filename: `qr-${index}.png`,
        content: png,
        cid,
      });
      return `
        <table role="presentation" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin:0 0 20px 0;background:#ffffff;width:100%">
          <tr>
            <td style="padding-bottom:8px">
              <h3 style="margin:0;color:#1E293B;font-size:18px">${escaparHTML(grupo.nombre)}</h3>
              ${grupo.descripcion ? `<p style="margin:4px 0 0 0;color:#64748b;font-size:14px">${escaparHTML(grupo.descripcion)}</p>` : ''}
            </td>
          </tr>
          <tr>
            <td style="padding:12px 0">
              <a href="${escaparHTML(grupo.url)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#2563EB;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600;font-size:14px">Unirse al grupo</a>
            </td>
          </tr>
          <tr>
            <td style="text-align:center;padding-top:12px">
              <img src="cid:${cid}" alt="QR del acceso" width="220" height="220" style="max-width:220px;height:auto;border:0" />
              <p style="margin:8px 0 0 0;color:#94a3b8;font-size:12px">Escanea para unirte</p>
            </td>
          </tr>
        </table>`;
    }));
    bloqueComunidades = bloques.join('\n');
  }

  const html = `
    <div style="background:#F8FAFC;padding:32px 16px;font-family:Arial,Helvetica,sans-serif">
      <div style="max-width:560px;margin:0 auto;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0">
        <div style="background:#2563EB;padding:28px 32px">
          <h1 style="margin:0;color:#FFFFFF;font-size:24px">Bienvenido al Club de Lectura</h1>
        </div>
        <div style="padding:32px">
          <p style="color:#1E293B;font-size:16px;margin:0 0 16px 0">Hola, <strong>${escaparHTML(nombreLimpio)}</strong></p>
          <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 24px 0">
            Ya formas parte del club. Aqui tienes los accesos a nuestra comunidad para no perderte
            las sesiones, el libro del mes y las novedades.
          </p>
          ${bloqueComunidades}
          <p style="color:#94a3b8;font-size:13px;line-height:1.5;margin:16px 0 0 0">
            Si los enlaces dejaron de funcionar, entra a tu panel y consulta la seccion "Comunidad"
            para obtener los accesos actualizados.
          </p>
        </div>
      </div>
    </div>`;

  const bloqueTexto = gruposLimpios.length > 0
    ? `\n\nAccesos a la comunidad:\n${gruposLimpios.map((g) => `${g.nombre}: ${g.url}`).join('\n')}`
    : '';

  const text = `Hola ${nombreLimpio}

Ya formas parte del Club de Lectura. Bienvenido/a!${bloqueTexto}

Si los enlaces dejaron de funcionar, entra a tu panel y consulta la seccion "Comunidad" para obtener los accesos actualizados.`;

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
      from: `"Club de Lectura" <${GMAIL_USER}>`,
      to: email.trim(),
      subject: `Bienvenido al Club de Lectura, ${nombreLimpio}`,
      text,
      html,
      attachments,
    });
  } catch (error) {
    console.error('Error enviando correo de bienvenida:', error);
    return responder(500, { error: 'No se pudo enviar el correo de bienvenida' });
  }

  return new Response(
    JSON.stringify({ success: true, message: 'Bienvenida enviada correctamente' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};