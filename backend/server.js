import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import authRoutes from './routes/auth.js';
import sesionesRoutes from './routes/sesiones.js';
import pagosRoutes from './routes/pagos.js';
import gruposRoutes from './routes/grupos.js';
import keepaliveRoutes from './routes/keepalive.js';

dotenv.config({ path: fileURLToPath(new URL('.env', import.meta.url)) });

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// MIDDLEWARES GLOBALES
// ============================================

// Seguridad - Headers HTTP
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// CORS - Permitir origenes del frontend (dev + produccion)
// FRONTEND_URLS acepta lista CSV: "http://localhost:8080,https://dominio"
// El dominio de produccion de Netlify se incluye siempre como respaldo
// (evita que un env mal configurado en Railway rompa el acceso en produccion).
const PROD_FRONTEND = 'https://clublecturahispano.netlify.app';
const normalizarOrigen = (o) => (/^https?:\/\//i.test(o) ? o : `https://${o}`).replace(/\/+$/, '');
const origenesPermitidos = process.env.FRONTEND_URLS
  ? process.env.FRONTEND_URLS.split(',').map((o) => o.trim()).filter(Boolean).map(normalizarOrigen)
  : [normalizarOrigen(process.env.FRONTEND_URL || 'http://localhost:8080')];
if (!origenesPermitidos.includes(PROD_FRONTEND)) {
  origenesPermitidos.push(PROD_FRONTEND);
}

app.use(cors({
  origin: origenesPermitidos,
  credentials: true
}));

// Parsear JSON en requests
app.use(express.json());

// Rate limiting - Proteccion contra abuso
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, error: 'Demasiadas peticiones, intenta de nuevo en 15 minutos' }
});
app.use('/api/', limiter);

// ============================================
// RUTAS
// ============================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'API Club de Lectura funcionando', timestamp: new Date().toISOString() });
});

// Rutas
app.use('/api/auth', authRoutes);
app.use('/api/sesiones', sesionesRoutes);
app.use('/api/pagos', pagosRoutes);
app.use('/api/grupos', gruposRoutes);
app.use('/api', keepaliveRoutes);

// ============================================
// MANEJO DE ERRORES
// ============================================

// 404 - Ruta no encontrada
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Ruta no encontrada' });
});

// Error interno del servidor
app.use((err, req, res, next) => {
  console.error('Error del servidor:', err);
  res.status(500).json({ success: false, error: 'Error interno del servidor' });
});

// ============================================
// INICIAR SERVIDOR
// ============================================

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  console.log(`Frontend URLs: ${origenesPermitidos.join(', ')}`);
});

export default app;
