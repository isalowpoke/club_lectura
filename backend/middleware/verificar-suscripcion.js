import verificarUsuario from './verificar-usuario.js';
import { obtenerAccesoUsuario } from '../services/suscripciones.js';

// Exige usuario autenticado Y suscripcion vigente (respetando la gracia de cobro).
//
// Antes usaba .single() sobre `suscriptions`, lo que rompia con el caso normal de
// un suscriptor de pago que ademas tiene el trial `gratis` activo: varias filas
// coincidian, .single() fallaba y el usuario recibia 403 siendo suscriptor de pago.
// La decision ahora viene de obtenerAccesoUsuario, la misma que usa /api/pagos.
export default async function verificarSuscripcionActiva(req, res, next) {
  try {
    return verificarUsuario(req, res, async () => {
      const { suscripcion, tieneAcceso, graciaVencida } = await obtenerAccesoUsuario(req.usuario.id);

      if (!tieneAcceso) {
        return res.status(403).json({
          success: false,
          error: graciaVencida
            ? 'Se requiere una renovacion al corriente'
            : 'Se requiere suscripcion activa',
          code: 'NO_SUBSCRIPTION',
        });
      }

      req.suscripcion = suscripcion;
      next();
    });
  } catch (error) {
    console.error('Error verificando suscripcion:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
}
