// config.js - Configuracion del frontend
// BACKEND_URL: auto-detecta local vs produccion.
window.APP_CONFIG = {
  BACKEND_URL: (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:3000'
    : 'https://clublectura-production.up.railway.app',
};