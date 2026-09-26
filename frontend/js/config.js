// config.js - Configuracion del frontend
// BACKEND_URL: auto-detecta local vs produccion.
// ANTES DE SALIR A PRODUCCION: reemplazar TU-BACKEND.up.railway.app por el
// subdominio real que genere Railway para el backend.
window.APP_CONFIG = {
  BACKEND_URL: (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:3000'
    : 'https://TU-BACKEND.up.railway.app',
};