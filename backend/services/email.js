import nodemailer from 'nodemailer';

// ============================================
// CONFIGURACION SMTP - GMAIL (App Password)
// ============================================

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

function crearTransporter() {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return null;
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD,
    },
  });
}

// ============================================
// ENVIAR CORREO DE CONTACTO
// ============================================

export async function enviarCorreoContacto({ nombre, email, asunto, mensaje }) {
  const destinatario = process.env.CONTACTO_TO_CLUB || GMAIL_USER;
  
  const transporter = crearTransporter();
  if (!transporter) {
    throw new Error('SMTP de Gmail no configurado (GMAIL_USER / GMAIL_APP_PASSWORD)');
  }
  
  const a = new Date().toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City',
    dateStyle: 'full',
    timeStyle: 'short',
  });
  
  const resultado = await transporter.sendMail({
    from: `"Club de Lectura Web" <${GMAIL_USER}>`,
    to: destinatario,
    replyTo: email,
    subject: `[Web] ${asunto} - ${nombre}`,
    text: `Nuevo mensaje desde el formulario de contacto del sitio.\n\nNombre: ${nombre}\nCorreo: ${email}\nAsunto: ${asunto}\nFecha: ${a}\n\nMensaje:\n${mensaje}`,
  });
  
  return resultado;
}