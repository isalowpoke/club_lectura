import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

export function validarConfiguracionPagos(env) {
  if (!['production','test'].includes(env.MERCADOPAGO_MODE || 'production')) throw new Error('MERCADOPAGO_MODE invalido');
  if (env.NODE_ENV !== 'production') return;
  for (const clave of ['SUPABASE_URL','SUPABASE_SERVICE_KEY','MERCADOPAGO_ACCESS_TOKEN','MERCADOPAGO_WEBHOOK_SECRET','FRONTEND_URL']) {
    if (!env[clave]?.trim()) throw new Error(`Falta ${clave}`);
  }
  for (const valor of [env.SUPABASE_URL, env.FRONTEND_URL, ...(env.FRONTEND_URLS || '').split(',').filter(Boolean)]) {
    let url;
    try { url = new URL(valor.trim()); }
    catch { throw new Error('Origen invalido en la configuracion de produccion'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Se requieren origenes HTTPS sin rutas ni credenciales en produccion');
    }
  }
}

export function configurarHttp(app, env = process.env, { maxSolicitudes = 100, maxWebhooks = 300 } = {}) {
  validarConfiguracionPagos(env);
  const normalizar = (origen) => (/^https?:\/\//i.test(origen) ? origen : `https://${origen}`).replace(/\/+$/, '');
  const origenes = (env.FRONTEND_URLS || env.FRONTEND_URL || 'http://localhost:8080')
    .split(',').map((o) => o.trim()).filter(Boolean).map(normalizar);
  if (!origenes.includes('https://clublecturahispano.netlify.app')) origenes.push('https://clublecturahispano.netlify.app');
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(cors({ origin: origenes, credentials: true }));
  // Verificar este numero de saltos en el ambiente de Railway elegido.
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: maxSolicitudes,
    skip: (req) => /^\/pagos\/webhook\/?$/i.test(req.path),
    message: { success: false, error: 'Demasiadas peticiones, intenta de nuevo en 15 minutos' } }));
  app.use('/api/pagos/webhook', rateLimit({ windowMs: 60 * 1000, max: maxWebhooks,
    message: { success: false, error: 'Demasiadas notificaciones; reintentar' } }));
}

export function responderErrorHttp(error, req, res, next) {
  if (res.headersSent) return next(error);
  const status = error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 500;
  return res.status(status).json({ success: false, error: status === 400 ? 'JSON invalido' :
    status === 413 ? 'Solicitud demasiado grande' : 'Error interno del servidor' });
}
