import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth.js';
import sesionesRoutes from './routes/sesiones.js';
import pagosRoutes from './routes/pagos.js';

dotenv.config();

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

// CORS - Permitir frontend
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:8080',
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
  console.log(`Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:8080'}`);
});

export default app;
