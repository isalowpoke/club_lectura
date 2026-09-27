// ============================================
// CONFIGURACION SMTP - GMAIL (App Password)
// ============================================

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

// nodemailer se carga bajo demanda para que un fallo en su instalacion
// nunca impida arrancar el servidor (los demas endpoints siguen sirviendo).
async function obtenerTransporter() {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return null;
  const { default: nodemailer } = await import('nodemailer');
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD,
    },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 15000,
  });
}

// ============================================
// ENVIAR CORREO DE CONTACTO
// ============================================

export async function enviarCorreoContacto({ nombre, email, asunto, mensaje }) {
  const destinatario = process.env.CONTACTO_TO_CLUB || GMAIL_USER;
  
  const transporter = await obtenerTransporter();
  if (!transporter) {
    const error = new Error('SMTP de Gmail no configurado (GMAIL_USER / GMAIL_APP_PASSWORD)');
    error.codigo = 'SMTP_NO_CONFIGURADO';
    throw error;
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