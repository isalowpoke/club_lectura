import express from 'express';
import { configurarHttp, responderErrorHttp } from './middleware/configurar-http.js';
import dotenv from 'dotenv';
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

configurarHttp(app);

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
app.use(responderErrorHttp);

// ============================================
// INICIAR SERVIDOR
// ============================================

app.listen(PORT);

export default app;
