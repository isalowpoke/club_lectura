// contacto.js - Envio del formulario de contacto
async function enviarMensajeContacto() {
  const form = document.getElementById('contact-form');
  if (!form) return;

  const btnEnviar = form.querySelector('button[type="submit"]');
  const nombre = document.getElementById('name')?.value.trim();
  const email = document.getElementById('email')?.value.trim();
  const subject = document.getElementById('subject')?.value;
  const mensaje = document.getElementById('message')?.value.trim();
  const website = document.getElementById('website')?.value; // honeypot

  if (!nombre || !email || !subject || !mensaje) {
    Auth.mostrarNotificacion('Completa todos los campos', 'error');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    Auth.mostrarNotificacion('Correo electronico invalido', 'error');
    return;
  }
  if (mensaje.length < 10) {
    Auth.mostrarNotificacion('El mensaje debe tener al menos 10 caracteres', 'error');
    return;
  }

  if (btnEnviar) {
    btnEnviar.disabled = true;
    btnEnviar.textContent = 'Enviando...';
  }

  try {
    const response = await fetch('/api/contacto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre, email, subject, mensaje, website }),
    });
    const result = await response.json();

    if (!response.ok || result.success === false) {
      throw new Error(result.error || 'Error desconocido');
    }

    Auth.mostrarNotificacion('Mensaje enviado, te responderemos pronto', 'success');
    form.reset();
  } catch (e) {
    console.error('Error enviando mensaje:', e);
    Auth.mostrarNotificacion('No se pudo enviar el mensaje, intenta de nuevo', 'error');
  } finally {
    if (btnEnviar) {
      btnEnviar.disabled = false;
      btnEnviar.textContent = 'Enviar Mensaje';
    }
  }
}

function inicializarContacto() {
  const form = document.getElementById('contact-form');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      enviarMensajeContacto();
    });
  }
}

window.Contacto = {
  inicializarContacto,
};