import express from 'express';
import rateLimit from 'express-rate-limit';
import { enviarCorreoContacto } from '../services/email.js';

const router = express.Router();

// Rate limit especifico del formulario (anti-spam)
// El limite global (/api/) ya aplica; este es mas estricto para contacto.
const limiteContacto = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'Demasiados mensajes enviados, intenta de nuevo en 1 hora' }
});

// POST /api/contacto - Enviar mensaje al club
router.post('/contacto', limiteContacto, async (req, res) => {
  try {
    const { nombre, email, subject, mensaje, website } = req.body;

    // Honeypot: si el campo oculto viene lleno es un bot
    if (website) {
      return res.json({ success: true }); // responder exito sin procesar
    }

    // Validacion de campos
    if (!nombre || typeof nombre !== 'string' || nombre.trim().length < 2 || nombre.length > 100) {
      return res.status(400).json({ success: false, error: 'Nombre invalido (2-100 caracteres)' });
    }
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 250) {
      return res.status(400).json({ success: false, error: 'Correo electronico invalido' });
    }
    const asunto = (String(subject || 'general')).slice(0, 100);
    if (!mensaje || typeof mensaje !== 'string' || mensaje.trim().length < 10 || mensaje.length > 5000) {
      return res.status(400).json({ success: false, error: 'Mensaje invalido (minimo 10 caracteres)' });
    }

    await enviarCorreoContacto({
      nombre: nombre.trim().slice(0, 100),
      email: email.trim(),
      asunto: asunto.trim(),
      mensaje: mensaje.trim(),
    });

    return res.json({ success: true, message: 'Mensaje enviado correctamente' });
  } catch (error) {
    console.error('Error enviando correo de contacto:', error);
    const mensaje = error.codigo === 'SMTP_NO_CONFIGURADO'
      ? 'El envio de correos no esta configurado'
      : 'No se pudo enviar el mensaje, intenta de nuevo';
    return res.status(500).json({ success: false, error: mensaje });
  }
});

export default router;