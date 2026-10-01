// auth.js - Autenticacion con Supabase
// Configuracion de Supabase
const SUPABASE_URL = 'https://sktkxbmrktgxeduwnunu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNrdGt4Ym1ya3RneGVkdXdudW51Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NjgzNzMsImV4cCI6MjEwMDE0NDM3M30.rytE9Be4E8vPQsuGj3sp8bcRiPlF_-MjSmDHNgnWPmA';
const BACKEND_URL = (window.APP_CONFIG && window.APP_CONFIG.BACKEND_URL) || 'http://localhost:3000';

// Inicializar cliente Supabase (global)
const supabaseClient = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// ============================================
// UTILIDADES
// ============================================

// Sanitizar HTML para prevenir XSS
function sanitizarHTML(texto) {
  if (!texto) return '';
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML;
}

function mostrarNotificacion(mensaje, tipo = 'info') {
  const notificacion = document.createElement('div');
  const colores = {
    success: 'bg-green-500',
    error: 'bg-red-500',
    info: 'bg-blue-500'
  };
  notificacion.className = `fixed top-4 right-4 px-4 py-3 rounded-lg shadow-lg z-50 ${colores[tipo] || colores.info} text-white`;
  notificacion.textContent = mensaje;
  document.body.appendChild(notificacion);
  
  setTimeout(() => notificacion.remove(), 3000);
}

function formatearMoneda(monto) {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    minimumFractionDigits: 0
  }).format(monto);
}

function formatearFecha(fechaStr) {
  if (!fechaStr) return '-';
  const fecha = new Date(fechaStr);
  return fecha.toLocaleDateString('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
}

// ============================================
// AUTENTICACION
// ============================================

async function iniciarSesionGoogle() {
  if (!supabaseClient) {
    mostrarNotificacion('Error: Supabase no disponible', 'error');
    return;
  }
  
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}/dashboard.html`
    }
  });
  
  if (error) {
    console.error('Error al iniciar sesion:', error);
    mostrarNotificacion('Error al iniciar sesion', 'error');
  }
}

async function cerrarSesion() {
  try {
    if (supabaseClient) {
      const { error } = await supabaseClient.auth.signOut({ scope: 'local' });
      if (error) {
        console.error('Error al cerrar sesion en Supabase:', error);
      }
    }
  } catch (e) {
    console.error('Error al cerrar sesion:', e);
  }
  
  localStorage.removeItem('clubLecturaSesion');
  mostrarNotificacion('Sesion cerrada correctamente', 'success');
  window.location.href = 'index.html';
}

async function verificarSesion() {
  if (!supabaseClient) return null;
  
  if (typeof supabaseClient.auth.initialize === 'function') {
    try { await supabaseClient.auth.initialize(); } catch (e) { /* continuar con getSession */ }
  }
  
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    localStorage.setItem('clubLecturaSesion', JSON.stringify(session));
    return session;
  }
  return null;
}

function obtenerUsuario() {
  const sesionStr = localStorage.getItem('clubLecturaSesion');
  if (!sesionStr) return null;
  
  try {
    const sesion = JSON.parse(sesionStr);
    return sesion?.user || null;
  } catch {
    return null;
  }
}

function obtenerToken() {
  const sesionStr = localStorage.getItem('clubLecturaSesion');
  if (!sesionStr) return null;
  
  try {
    const sesion = JSON.parse(sesionStr);
    return sesion?.access_token || null;
  } catch {
    return null;
  }
}

// ============================================
// API DEL BACKEND
// ============================================

async function apiRequest(endpoint, options = {}) {
  const token = obtenerToken();
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  const response = await fetch(`${BACKEND_URL}${endpoint}`, {
    ...options,
    headers,
  });
  
  const result = await response.json();
  
  if (!response.ok || result.success === false) {
    return { data: null, error: result.error || 'Error desconocido' };
  }
  
  return { data: result.data, error: null };
}

// Peticiones GET de solo lectura con reintento: si el backend esta
// "dormido" (Railway) o fallo transitorio, se reintenta 1 vez.
async function apiRequestGET(endpoint, reintentos = 1) {
  let ultimoError = null;
  for (let intento = 0; intento <= reintentos; intento++) {
    let resultado;
    try {
      resultado = await apiRequest(endpoint);
    } catch (error) {
      resultado = { data: null, error };
    }
    if (!resultado.error) return { data: resultado.data, error: null };
    ultimoError = resultado.error;
    if (intento < reintentos) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return { data: null, error: ultimoError };
}

// ============================================
// ESTADO DE SUSCRIPCION
// ============================================

let estadoSuscripcion = null;

async function verificarEstadoSuscripcion() {
  try {
    const { data, error } = await apiRequestGET('/api/pagos/estado');
    if (error) throw error;
    
    estadoSuscripcion = data;
    return data;
  } catch (error) {
    console.error('Error verificando suscripcion:', error);
    return null;
  }
}

function tieneSuscripcionActiva() {
  return estadoSuscripcion?.tiene_suscripcion && estadoSuscripcion?.estado === 'activa';
}

// ============================================
// PAGOS
// ============================================

async function crearPagoSuscripcion() {
  try {
    const { data, error } = await apiRequest('/api/pagos/suscripcion', {
      method: 'POST',
    });
    
    if (error) throw error;
    
    if (data?.init_point) {
      window.location.href = data.init_point;
    }
  } catch (error) {
    console.error('Error creando pago:', error);
    mostrarNotificacion('Error al iniciar pago', 'error');
  }
}

async function crearPagoSesionExtra(sesionId, monto) {
  try {
    const { data, error } = await apiRequest('/api/pagos/sesion-extra', {
      method: 'POST',
      body: JSON.stringify({ sesion_id: sesionId, monto }),
    });
    
    if (error) throw error;
    
    if (data?.init_point) {
      window.location.href = data.init_point;
    }
  } catch (error) {
    console.error('Error creando pago sesion extra:', error);
    mostrarNotificacion('Error al iniciar pago', 'error');
  }
}

async function cancelarSuscripcion() {
  if (!confirm('Seguro que deseas cancelar tu suscripcion?')) return false;
  
  try {
    const { data, error } = await apiRequest('/api/pagos/cancelar', {
      method: 'POST',
    });
    
    if (error) throw error;
    
    mostrarNotificacion('Suscripcion cancelada', 'success');
    estadoSuscripcion = { tiene_suscripcion: false, estado: null };
    return true;
  } catch (error) {
    console.error('Error cancelando suscripcion:', error);
    mostrarNotificacion('Error al cancelar suscripcion', 'error');
    return false;
  }
}

// ============================================
// SESIONES
// ============================================

async function obtenerProximasSesiones() {
  try {
    const { data, error } = await apiRequestGET('/api/sesiones');
    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error obteniendo sesiones:', error);
    return [];
  }
}

async function obtenerLibros() {
  try {
    const { data, error } = await apiRequestGET('/api/sesiones/libros');
    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error obteniendo libros:', error);
    return [];
  }
}

async function obtenerHistorialPagos() {
  try {
    const { data, error } = await apiRequest('/api/pagos/historial');
    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error obteniendo historial:', error);
    return [];
  }
}

// ============================================
// BIENVENIDA
// ============================================

// Pide al backend el correo de bienvenida (link + QR de la comunidad).
// El backend lo envia una sola vez (idempotente via welcome_sent_at).
// Best-effort: si falla, no molesta al usuario.
async function solicitarCorreoBienvenida() {
  try {
    await apiRequest('/api/auth/bienvenida', { method: 'POST' });
  } catch (error) {
    console.error('Error solicitando correo de bienvenida:', error);
  }
}

// ============================================
// COMUNIDAD
// ============================================

async function obtenerGrupos() {
  try {
    const { data, error } = await apiRequestGET('/api/grupos');
    if (error) throw error;
    return { data: data || [], error: null };
  } catch (error) {
    console.error('Error obteniendo grupos:', error);
    return { data: null, error };
  }
}

// ============================================
// INICIALIZACION
// ============================================

function configurarEventosAuth() {
  const btnLogin = document.getElementById('btn-login');
  const btnLogout = document.getElementById('btn-logout');
  const btnLoginMobile = document.getElementById('btn-login-mobile');
  
  if (btnLogin) {
    btnLogin.addEventListener('click', (e) => {
      e.preventDefault();
      iniciarSesionGoogle();
    });
  }
  
  if (btnLoginMobile) {
    btnLoginMobile.addEventListener('click', (e) => {
      e.preventDefault();
      iniciarSesionGoogle();
    });
  }
  
  if (btnLogout) {
    btnLogout.addEventListener('click', (e) => {
      e.preventDefault();
      cerrarSesion();
    });
  }
}

async function inicializarAuth() {
  configurarEventosAuth();
  const sesion = await verificarSesion();
  if (sesion) {
    solicitarCorreoBienvenida();
  }
  if (typeof actualizarHeaderAuth === 'function') {
    actualizarHeaderAuth();
  }
  return sesion;
}

// Exponer globalmente
window.Auth = {
  inicializarAuth,
  verificarSesion,
  obtenerUsuario,
  obtenerToken,
  iniciarSesionGoogle,
  cerrarSesion,
  verificarEstadoSuscripcion,
  tieneSuscripcionActiva,
  crearPagoSuscripcion,
  crearPagoSesionExtra,
  cancelarSuscripcion,
  obtenerProximasSesiones,
  obtenerLibros,
  obtenerHistorialPagos,
  obtenerGrupos,
  solicitarCorreoBienvenida,
  apiRequest,
  apiRequestGET,
  formatearMoneda,
  formatearFecha,
  mostrarNotificacion,
  sanitizarHTML,
  BACKEND_URL,
};
