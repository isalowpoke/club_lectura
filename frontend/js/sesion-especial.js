// sesion-especial.js - Compra de sesion especial

// ============================================
// VERIFICAR SUSCRIPCION
// ============================================

async function verificarSuscripcionParaSesionEspecial() {
  const usuario = Auth.obtenerUsuario();
  if (!usuario) return false;
  
  const estado = await Auth.verificarEstadoSuscripcion();
  return estado?.tiene_suscripcion && estado?.estado === 'activa';
}

// ============================================
// PROCESAR COMPRA
// ============================================

async function procesarCompraSesionEspecial(sesionId) {
  const usuario = Auth.obtenerUsuario();
  
  if (!usuario) {
    Auth.mostrarNotificacion('Inicia sesion para continuar', 'info');
    window.location.href = 'login.html';
    return;
  }
  
  const esSuscrito = await verificarSuscripcionParaSesionEspecial();
  
  if (esSuscrito) {
    Auth.mostrarNotificacion('Ya tienes acceso con tu suscripcion', 'success');
    return;
  }
  
  // Procesar pago. El monto lo fija el servidor desde sessions.price.
  await Pagos.iniciarCheckoutSesionExtra(sesionId);
}

// ============================================
// INICIALIZACION
// ============================================

async function inicializarSesionEspecial() {
  // Verificar suscripcion y mostrar aviso
  const esSuscrito = await verificarSuscripcionParaSesionEspecial();
  const aviso = document.getElementById('aviso-sin-pago');
  
  if (esSuscrito && aviso) {
    aviso.classList.remove('hidden');
  }

  // El id de la sesion especial sale de la BD: hardcodearlo fallaba contra el
  // endpoint (sessions.id es numerico).
  const btnComprar = document.getElementById('btn-comprar-acceso');
  let sesionId = null;

  try {
    const { data, error } = await Auth.apiRequestGET('/api/sesiones');
    if (!error) {
      const especial = (data || []).find((s) => s.type === 'especial');
      if (especial) {
        sesionId = especial.id;
        if (btnComprar) btnComprar.dataset.sesionId = especial.id;

        // El precio lo fija el servidor (backend -> sessions.price): se pinta
        // desde la BD para no contradecir lo que MP va a cobrar.
        if (especial.price) {
          const precioTexto = `$${especial.price} MXN`;
          const precio = document.getElementById('precio-sesion-especial');
          if (precio) precio.textContent = precioTexto;

          const textoBoton = document.getElementById('texto-boton-compra');
          if (textoBoton) textoBoton.textContent = `Adquirir Acceso - ${precioTexto}`;
        }

        // El endpoint entrega 'date' (fecha) y 'hour' (hora de inicio).
        if (especial.date || especial.hour) {
          const fecha = document.getElementById('fecha-sesion-especial');
          if (fecha && especial.date) {
            fecha.textContent = Auth.formatearFecha(especial.date);
          }
          const hora = document.getElementById('hora-sesion-especial');
          if (hora && especial.hour) {
            hora.textContent = String(especial.hour).slice(0, 5);
          }
        }
      } else if (btnComprar) {
        btnComprar.disabled = true;
      }
    }
  } catch (error) {
    console.error('Error cargando la sesion especial:', error);
  }

  if (btnComprar) {
    btnComprar.addEventListener('click', (e) => {
      e.preventDefault();
      if (!sesionId) {
        Auth.mostrarNotificacion('No hay sesion especial disponible', 'error');
        return;
      }
      procesarCompraSesionEspecial(sesionId);
    });
  }
}

// Exponer globalmente
window.SesionEspecial = {
  inicializarSesionEspecial,
  procesarCompraSesionEspecial,
  verificarSuscripcionParaSesionEspecial,
};
