// pagos.js - Integracion con Mercado Pago via backend

// ============================================
// CREAR PAGO DE SUSCRIPCION
// ============================================

async function iniciarCheckoutSuscripcion() {
  try {
    const { data, error } = await Auth.apiRequest('/api/pagos/suscripcion', {
      method: 'POST',
    });
    
    if (error) throw error;
    
    if (data?.init_point) {
      window.location.href = data.init_point;
    }
  } catch (error) {
    console.error('Error al crear preferencia:', error);
    Auth.mostrarNotificacion('Error al procesar el pago', 'error');
  }
}

// ============================================
// CREAR PAGO DE SESION EXTRA
// ============================================

async function iniciarCheckoutSesionExtra(sesionId, monto) {
  try {
    const { data, error } = await Auth.apiRequest('/api/pagos/sesion-extra', {
      method: 'POST',
      body: JSON.stringify({ sesion_id: sesionId, monto }),
    });
    
    if (error) throw error;
    
    if (data?.init_point) {
      window.location.href = data.init_point;
    }
  } catch (error) {
    console.error('Error al crear preferencia para sesion extra:', error);
    Auth.mostrarNotificacion('Error al procesar el pago', 'error');
  }
}

// ============================================
// EVENT LISTENERS
// ============================================

function configurarEventosPagos() {
  // Boton suscribirse
  const btnSuscribirse = document.getElementById('btn-suscribirse');
  if (btnSuscribirse) {
    btnSuscribirse.addEventListener('click', (e) => {
      e.preventDefault();
      iniciarCheckoutSuscripcion();
    });
  }
  
  // Botones de sesion extra
  const btnsSesionExtra = document.querySelectorAll('.btn-pagar-sesion');
  btnsSesionExtra.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const sesionId = btn.dataset.sesionId;
      const monto = btn.dataset.monto;
      if (sesionId) {
        iniciarCheckoutSesionExtra(sesionId, monto);
      }
    });
  });
}

// ============================================
// VERIFICAR ESTADO DE PAGO (post-redirect)
// ============================================

function verificarPagoReturn() {
  const params = new URLSearchParams(window.location.search);
  const paymentStatus = params.get('payment');
  
  if (paymentStatus === 'success') {
    Auth.mostrarNotificacion('Pago procesado correctamente', 'success');
    // Limpiar URL
    window.history.replaceState({}, document.title, window.location.pathname);
  } else if (paymentStatus === 'failure') {
    Auth.mostrarNotificacion('El pago no pudo ser procesado', 'error');
    window.history.replaceState({}, document.title, window.location.pathname);
  } else if (paymentStatus === 'pending') {
    Auth.mostrarNotificacion('Pago pendiente de confirmacion', 'info');
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

// ============================================
// INICIALIZACION
// ============================================

function inicializarPagos() {
  configurarEventosPagos();
  verificarPagoReturn();
}

// Exponer globalmente
window.Pagos = {
  iniciarCheckoutSuscripcion,
  iniciarCheckoutSesionExtra,
  inicializarPagos,
  verificarPagoReturn,
};
