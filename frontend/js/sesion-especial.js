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
  
  // Procesar pago
  await Pagos.iniciarCheckoutSesionExtra(sesionId, 50);
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
  
  // Configurar boton de compra
  const btnComprar = document.getElementById('btn-comprar-acceso');
  if (btnComprar) {
    btnComprar.addEventListener('click', (e) => {
      e.preventDefault();
      procesarCompraSesionEspecial('special-001');
    });
  }
}

// Exponer globalmente
window.SesionEspecial = {
  inicializarSesionEspecial,
  procesarCompraSesionEspecial,
  verificarSuscripcionParaSesionEspecial,
};
