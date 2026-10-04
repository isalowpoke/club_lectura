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
    cargarComunidad(),
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
  let titulo = 'No se pudo consultar la suscripción';
  const detalles = [];
  if (estado) {
    titulo = estado.tiene_suscripcion ? 'Suscripción activa' : 'Sin suscripción activa';
    if (estado.en_prueba) titulo = 'Mes gratis activo';
    if (estado.en_gracia) titulo = 'Acceso en periodo de gracia';
    if (estado.fecha_fin && estado.tiene_suscripcion) detalles.push('Acceso hasta: ' + Auth.formatearFecha(estado.fecha_fin));
    if (estado.recurrencia_cancelada) detalles.push('Los próximos cobros están detenidos. Conservas el periodo pagado.');
    if (estado.renovacion_fallida) detalles.push(estado.en_gracia ? 'La renovación fue rechazada. Los reintentos no amplían la gracia.' : 'La gracia de renovación terminó.');
    if (estado.checkout_pendiente) detalles.push('Falta completar la autorización en Mercado Pago. Puedes continuar el checkout.');
    if (estado.pago_programado) detalles.push('Próximo cobro: ' + Auth.formatearFecha(estado.proxima_fecha_cobro));
    if (estado.pago_pendiente_cobro) detalles.push(estado.cobro_rechazado ? 'El último cobro fue rechazado. Consulta el motivo en Mercado Pago.' : 'El acuerdo está autorizado; esperamos la confirmación del cobro.');
    if (estado.requiere_revision) detalles.push('Hay acuerdos pendientes de revisar. Evita iniciar otra suscripción.');
  }
  if (container) {
    const encabezado = document.createElement('p');
    encabezado.className = 'font-semibold text-gray-900';
    encabezado.textContent = titulo;
    const parrafos = detalles.map((texto) => {
      const p = document.createElement('p');
      p.className = 'text-sm text-gray-600 mt-2';
      p.textContent = texto;
      return p;
    });
    container.replaceChildren(encabezado, ...parrafos);
  }
  const puedePagar = !!estado && !estado.requiere_revision && (estado.checkout_pendiente ||
    (!estado.pago_programado && !estado.pago_pendiente_cobro && (!estado.tiene_suscripcion || estado.en_prueba || estado.recurrencia_cancelada)));
  if (btnPagar) {
    btnPagar.classList.toggle('hidden', !puedePagar);
    btnPagar.textContent = estado?.checkout_pendiente ? 'Continuar en Mercado Pago' :
      estado?.tiene_suscripcion ? 'Programar el siguiente mes' : 'Suscribirse — $80 MXN/mes';
  }
  if (btnCancelar) {
    btnCancelar.classList.toggle('hidden', !estado?.puede_cancelar);
    btnCancelar.textContent = 'Detener próximos cobros';
  }
  document.getElementById('info-sin-suscripcion')?.classList.toggle('hidden', !!estado?.tiene_suscripcion);
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
          <p>Proximamente nuevo libro actual</p>
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
    const sesion = libro.sessions && libro.sessions.date
      ? libro.sessions
      : null;
    
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
          <p class="text-gray-700 mb-4">${descripcion || 'Libro seleccionado para este ciclo de lectura.'}</p>
          
          ${mes ? `<div class="text-sm text-gray-600">Libro de: <span class="font-medium">${mes}</span>${sesion ? ` · Sesion: <span class="font-medium">${Auth.formatearFecha(sesion.date)}</span>` : ''}</div>` : ''}
          
          <div class="flex gap-3 mt-4">
            <a href="proximas-sesiones.html" class="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg">Ver sesiones</a>
          </div>
        </div>
      </div>
    `;
  }
}

// ============================================
// COMUNIDAD
// ============================================

async function cargarComunidad() {
  const container = document.getElementById('comunidad-info');
  if (!container) return;

  const { data, error } = await Auth.obtenerGrupos();

  if (error || !data || data.length === 0) {
    container.innerHTML = `
      <div class="text-gray-500 text-center py-4">
        <p>Los accesos estan disponibles para suscriptores activos.</p>
      </div>
    `;
    return;
  }

  const html = data.map((grupo) => {
    const nombre = Auth.sanitizarHTML(grupo.name);
    const descripcion = grupo.description ? Auth.sanitizarHTML(grupo.description) : '';
    const url = Auth.sanitizarHTML(grupo.url);
    return `
      <div class="flex items-center justify-between py-3 border-b last:border-0">
        <div>
          <div class="font-medium">${nombre}</div>
          ${descripcion ? `<div class="text-xs text-gray-600 mt-1">${descripcion}</div>` : ''}
        </div>
        <a href="${url}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg whitespace-nowrap ml-4">
          Unirse
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
          </svg>
        </a>
      </div>
    `;
  }).join('');

  container.innerHTML = html;
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
      const estadoTexto = pago.estado_texto || 'Estado por verificar';
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
  // El boton se deshabilita mientras corre la redireccion: un doble clic no debe
  // generar dos preapprovals (MP los toma como intento duplicado).
  const irAlPago = (boton) => async () => {
    if (boton.disabled) return;
    boton.disabled = true;
    const textoOriginal = boton.textContent;
    boton.textContent = 'Redirigiendo a Mercado Pago...';
    try {
      await Auth.crearPagoSuscripcion();
    } finally {
      boton.disabled = false;
      boton.textContent = textoOriginal;
    }
  };

  const btnSuscribirse = document.getElementById('btn-suscribirse');
  if (btnSuscribirse) {
    btnSuscribirse.addEventListener('click', irAlPago(btnSuscribirse));
  }

  const btnSuscribirseDashboard = document.getElementById('btn-suscribirse-dashboard');
  if (btnSuscribirseDashboard) {
    btnSuscribirseDashboard.addEventListener('click', irAlPago(btnSuscribirseDashboard));
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
  cargarComunidad,
  cargarHistorial,
};
