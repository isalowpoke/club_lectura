// dashboard.js - Panel de usuario completo

// ============================================
// CARGAR DATOS DEL DASHBOARD
// ============================================

async function cargarDashboard() {
  const usuario = Auth.obtenerUsuario();
  
  if (!usuario) {
    mostrarSeccionLogin();
    return;
  }
  
  mostrarSeccionDashboard();
  mostrarInfoUsuario(usuario);
  
  // Cargar datos en paralelo
  await Promise.all([
    cargarEstadoSuscripcion(),
    cargarProximasSesiones(),
    cargarLibroDelMes(),
    cargarHistorial(),
  ]);
}

// ============================================
// MOSTRAR/OCULTAR SECCIONES
// ============================================

function mostrarSeccionLogin() {
  document.getElementById('login-required')?.classList.remove('hidden');
  document.getElementById('dashboard-content')?.classList.add('hidden');
}

function mostrarSeccionDashboard() {
  document.getElementById('login-required')?.classList.add('hidden');
  document.getElementById('dashboard-content')?.classList.remove('hidden');
}

function mostrarInfoUsuario(usuario) {
  const emailEl = document.getElementById('user-email-display');
  if (emailEl) {
    emailEl.textContent = usuario.email || 'usuario@email.com';
  }
}

// ============================================
// ESTADO DE SUSCRIPCION
// ============================================

async function cargarEstadoSuscripcion() {
  const container = document.getElementById('suscripcion-estado');
  const btnPagar = document.getElementById('btn-suscribirse');
  const btnCancelar = document.getElementById('btn-cancelar-suscripcion');
  
  const estado = await Auth.verificarEstadoSuscripcion();
  
  // Sin acceso y sin nada programado
  if (!estado || !estado.tiene_suscripcion) {
    // Primer cobro fallido en el corte: MP reintenta
    if (estado?.pago_pendiente_cobro) {
      if (container) {
        container.innerHTML = `
          <div class="flex items-center gap-2 text-amber-600 font-semibold">
            <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/>
            </svg>
            Cobro pendiente
          </div>
          <div class="text-sm text-gray-600 mt-2">El cobro de tu suscripcion no se pudo completar. Mercado Pago reintentara automaticamente y se te restaurara el acceso cuando se apruebe.</div>
          <div class="text-sm text-gray-600">Fecha intentada: ${Auth.formatearFecha(estado.proxima_fecha_cobro)}</div>
          <div class="text-xs text-amber-600 mt-1">Puedes cancelar la suscripcion para detener los reintentos.</div>
        `;
      }
      
      if (btnPagar) btnPagar.classList.add('hidden');
      if (btnCancelar) {
        btnCancelar.textContent = 'Cancelar suscripcion';
        btnCancelar.classList.remove('hidden');
      }
      document.getElementById('info-sin-suscripcion')?.classList.add('hidden');
      return;
    }
    
    if (container) {
      container.innerHTML = `
        <div class="flex items-center gap-2 text-red-600 font-semibold">
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/>
          </svg>
          Sin suscripcion activa
        </div>
        <p class="text-sm text-gray-600 mt-2">Suscribete para acceder a todo el contenido</p>
      `;
    }
    
    if (btnPagar) {
      btnPagar.textContent = 'Suscribirse Ahora - $80 MXN/mes';
      btnPagar.classList.remove('hidden');
    }
    if (btnCancelar) btnCancelar.classList.add('hidden');
    
    document.getElementById('info-sin-suscripcion')?.classList.remove('hidden');
    
    return;
  }
  
  document.getElementById('info-sin-suscripcion')?.classList.add('hidden');
  
  const diasRestantes = estado.fecha_fin 
    ? Math.ceil((new Date(estado.fecha_fin) - new Date()) / (1000 * 60 * 60 * 24))
    : '-';
  const fechaVencimiento = Auth.formatearFecha(estado.fecha_fin);
  
  // Suscripcion de pago programada durante la prueba gratis
  if (estado.pago_programado) {
    if (container) {
      container.innerHTML = `
        <div class="flex items-center gap-2 text-green-600 font-semibold">
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
          </svg>
          Suscripcion programada
        </div>
        <div class="text-sm text-gray-600 mt-2">Ya aseguraste tu mes. Tu mes gratis sigue vigente hasta el ${Auth.sanitizarHTML(fechaVencimiento)} (${diasRestantes} dias).</div>
        <div class="text-sm text-gray-600">Primer cobro de $80 MXN: ${Auth.formatearFecha(estado.proxima_fecha_cobro)}</div>
        <div class="text-xs text-amber-600 mt-1">Puedes cancelar la suscripcion programada antes del cobro sin cargos.</div>
      `;
    }
    
    if (btnPagar) btnPagar.classList.add('hidden');
    if (btnCancelar) {
      btnCancelar.textContent = 'Cancelar suscripcion programada';
      btnCancelar.classList.remove('hidden');
    }
    
    return;
  }
  
  // Prueba gratis vigente: CTA para asegurar el proximo mes
  if (estado.en_prueba) {
    if (container) {
      container.innerHTML = `
        <div class="flex items-center gap-2 text-green-600 font-semibold">
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
          </svg>
          Suscripcion Activa - Mes Gratis
        </div>
        <div class="text-sm text-gray-600 mt-2">Sin costo · Vence: ${Auth.sanitizarHTML(fechaVencimiento)} (${diasRestantes} dias)</div>
        <div class="text-xs text-amber-600 mt-1">Asegura tu proximo mes: el cobro iniciara justo al terminar tu mes gratis.</div>
      `;
    }
    
    if (btnPagar) {
      btnPagar.textContent = 'Asegurar mi Mes - cobro al terminar el gratis';
      btnPagar.classList.remove('hidden');
    }
    if (btnCancelar) btnCancelar.classList.add('hidden');
    
    return;
  }
  
  // Suscripcion de pago activa
  const textoPlan = `Plan ${Auth.sanitizarHTML(estado.plan || 'Mensual')}`;
  const textoPrecio = `${Auth.formatearMoneda(estado.precio || 80)}/mes`;
  
  if (container) {
    const proximoCobro = estado.proxima_fecha_cobro
      ? `<div class="text-sm text-gray-600">Proximo cobro: ${Auth.formatearFecha(estado.proxima_fecha_cobro)}</div>`
      : '';
    
    container.innerHTML = `
      <div class="flex items-center gap-2 text-green-600 font-semibold">
        <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
        </svg>
        Suscripcion Activa
      </div>
      <div class="text-sm text-gray-600 mt-2">${textoPlan} - ${textoPrecio}</div>
      <div class="text-sm text-gray-600">Vence: ${Auth.sanitizarHTML(fechaVencimiento)} (${diasRestantes} dias)</div>
      ${proximoCobro}
    `;
  }
  
  if (btnPagar) btnPagar.classList.add('hidden');
  if (btnCancelar) {
    btnCancelar.textContent = 'Cancelar Suscripcion';
    btnCancelar.classList.remove('hidden');
  }
}

// ============================================
// PROXIMAS SESIONES
// ============================================

async function cargarProximasSesiones() {
  const container = document.getElementById('proxima-sesion-info');
  const tieneSuscripcion = Auth.tieneSuscripcionActiva();
  
  const sesiones = await Auth.obtenerProximasSesiones();
  
  if (!sesiones || sesiones.length === 0) {
    if (container) {
      container.innerHTML = `
        <div class="text-gray-500 text-center py-4">
          <p>No hay sesiones programadas</p>
        </div>
      `;
    }
    return;
  }
  
  const sesionProxima = sesiones[0];
  const fechaSesion = new Date(sesionProxima.date);
  const ahora = new Date();
  const diffDias = Math.ceil((fechaSesion - ahora) / (1000 * 60 * 60 * 24));
  
  let tiempoTexto = '';
  const hora = String(sesionProxima.hour || '19:00').slice(0, 5);
  if (diffDias === 0) tiempoTexto = `Hoy a las ${hora}`;
  else if (diffDias === 1) tiempoTexto = `Manana a las ${hora}`;
  else tiempoTexto = `${Auth.formatearFecha(sesionProxima.date)} a las ${hora}`;
  
  if (container) {
    const tituloLimpio = Auth.sanitizarHTML(sesionProxima.title);
    const linkLimpio = sesionProxima.link ? Auth.sanitizarHTML(sesionProxima.link) : '';
    
    const linkHtml = tieneSuscripcion && linkLimpio
      ? `<a href="${linkLimpio}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-blue-600 hover:underline text-sm font-medium">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
          </svg>
          Unirse a la reunion
         </a>`
      : `<span class="text-gray-400 text-sm">${tieneSuscripcion ? 'Enlace disponible pronto' : 'Requiere suscripcion'}</span>`;
    
    container.innerHTML = `
      <div class="font-semibold">${tituloLimpio}</div>
      <div class="text-sm text-gray-600 mt-1">${tiempoTexto}</div>
      <div class="text-xs text-gray-500 mt-1 capitalize">Tipo: ${Auth.sanitizarHTML(sesionProxima.type)}</div>
      <div class="mt-3">${linkHtml}</div>
    `;
  }
  
  const listaContainer = document.getElementById('lista-proximas-sesiones');
  if (listaContainer && sesiones.length > 1) {
    const html = sesiones.slice(0, 3).map(s => {
      const titulo = Auth.sanitizarHTML(s.title);
      const tipo = Auth.sanitizarHTML(s.type);
      return `
        <div class="flex items-center justify-between py-2 border-b last:border-0">
          <div>
            <div class="font-medium text-sm">${titulo}</div>
            <div class="text-xs text-gray-600">${s.hour} | ${Auth.formatearFecha(s.date)}</div>
          </div>
          <span class="text-xs px-2 py-1 rounded-full ${s.type === 'especial' ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'}">${tipo}</span>
        </div>
      `;
    }).join('');
    listaContainer.innerHTML = html;
  }
}

// ============================================
// LIBRO DEL MES
// ============================================

async function cargarLibroDelMes() {
  const container = document.getElementById('libro-del-mes');
  
  const libros = await Auth.obtenerLibros();
  
  if (!libros || libros.length === 0) {
    if (container) {
      container.innerHTML = `
        <div class="text-gray-500 text-center py-4">
          <p>Proximamente nuevo libro del mes</p>
        </div>
      `;
    }
    return;
  }
  
  const libro = libros[0];
  
  if (container) {
    const titulo = Auth.sanitizarHTML(libro.title);
    const autor = Auth.sanitizarHTML(libro.author);
    const genero = Auth.sanitizarHTML(libro.genre);
    const descripcion = Auth.sanitizarHTML(libro.description);
    const mes = Auth.sanitizarHTML(libro.month);
    
    container.innerHTML = `
      <div class="flex flex-col md:flex-row gap-6">
        <div class="md:w-1/3">
          <div class="bg-gradient-to-br from-blue-50 to-purple-50 rounded-lg p-6 text-center">
            <div class="text-5xl mb-4">📖</div>
            <h3 class="font-semibold">${titulo}</h3>
            <p class="text-sm text-gray-600 mt-2">${autor}</p>
            ${genero ? `<span class="inline-block mt-2 bg-blue-100 text-blue-800 px-3 py-1 rounded-full text-xs">${genero}</span>` : ''}
          </div>
        </div>
        
        <div class="md:w-2/3">
          <p class="text-gray-700 mb-4">${descripcion || 'Libro seleccionado para este mes de lectura.'}</p>
          
          ${mes ? `<div class="text-sm text-gray-600">Mes: <span class="font-medium">${mes}</span></div>` : ''}
          
          <div class="flex gap-3 mt-4">
            <a href="proximas-sesiones.html" class="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg">Ver sesiones</a>
          </div>
        </div>
      </div>
    `;
  }
}

// ============================================
// HISTORIAL DE PAGOS
// ============================================

async function cargarHistorial() {
  const container = document.getElementById('historial-pagos');
  
  const pagos = await Auth.obtenerHistorialPagos();
  
  if (!pagos || pagos.length === 0) {
    if (container) {
      container.innerHTML = `
        <div class="text-gray-500 text-center py-4">
          <p>No hay pagos registrados</p>
        </div>
      `;
    }
    return;
  }
  
  if (container) {
    const html = pagos.map(pago => {
      const estadoColor = pago.estado_mp === 'approved' ? 'text-green-600' : 
                         pago.estado_mp === 'rejected' ? 'text-red-600' : 'text-amber-600';
      const estadoTexto = pago.estado_mp === 'approved' ? 'Aprobado' :
                          pago.estado_mp === 'rejected' ? 'Rechazado' : 'Pendiente';
      const tipoTexto = pago.tipo === 'suscripcion' ? 'Suscripcion Mensual' : 'Sesion Extra';
      
      return `
        <div class="flex items-center justify-between py-2 border-b last:border-0">
          <div>
            <div class="font-medium text-sm">${Auth.sanitizarHTML(tipoTexto)}</div>
            <div class="text-xs text-gray-600">${Auth.formatearFecha(pago.created_at)}</div>
          </div>
          <div class="text-right">
            <div class="font-medium text-sm">${Auth.formatearMoneda(pago.monto)}</div>
            <div class="text-xs ${estadoColor}">${Auth.sanitizarHTML(estadoTexto)}</div>
          </div>
        </div>
      `;
    }).join('');
    
    container.innerHTML = html;
  }
}

// ============================================
// CANCELAR SUSCRIPCION
// ============================================

async function manejarCancelarSuscripcion() {
  const exito = await Auth.cancelarSuscripcion();
  if (exito) {
    await cargarEstadoSuscripcion();
  }
}

// ============================================
// EVENT LISTENERS
// ============================================

function configurarEventListeners() {
  const btnSuscribirse = document.getElementById('btn-suscribirse');
  if (btnSuscribirse) {
    btnSuscribirse.addEventListener('click', () => Auth.crearPagoSuscripcion());
  }
  
  const btnSuscribirseDashboard = document.getElementById('btn-suscribirse-dashboard');
  if (btnSuscribirseDashboard) {
    btnSuscribirseDashboard.addEventListener('click', () => Auth.crearPagoSuscripcion());
  }
  
  const btnCancelar = document.getElementById('btn-cancelar-suscripcion');
  if (btnCancelar) {
    btnCancelar.addEventListener('click', manejarCancelarSuscripcion);
  }
  
  const btnLogoutDashboard = document.getElementById('btn-logout-dashboard');
  if (btnLogoutDashboard) {
    btnLogoutDashboard.addEventListener('click', (e) => {
      e.preventDefault();
      Auth.cerrarSesion();
    });
  }
  
  const btnSesionExtra = document.getElementById('btn-sesion-extra');
  if (btnSesionExtra) {
    btnSesionExtra.addEventListener('click', () => {
      window.location.href = 'proximas-sesiones.html';
    });
  }
}

// ============================================
// INICIALIZACION
// ============================================

function inicializarDashboard() {
  configurarEventListeners();
  cargarDashboard();
}

window.Dashboard = {
  inicializarDashboard,
  cargarDashboard,
  cargarEstadoSuscripcion,
  cargarProximasSesiones,
  cargarLibroDelMes,
  cargarHistorial,
};
