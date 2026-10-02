import { supabaseClient } from './supabase.js';
import { interpretarFechaUtc, calcularLimiteGracia } from './mercadopago.js';

// Unica fuente de verdad de "¿este usuario tiene acceso ahora?".
//
// La comparten GET /api/pagos/estado, GET /api/sesiones (que entrega el enlace de
// la reunion) y el middleware de suscripcion. Que la decision viva en un solo
// sitio es lo que impide que una ruta se quede sin chequear.
//
// Criterio: una fila `suscriptions` con `status = 'active'` y `end_date` vigente,
// cuyo `failed_at` (primer cobro de renovacion no aprobado) no sea anterior a la
// ventana de gracia. El trial `plan = 'gratis'` cuenta igual, asi que durante el
// mes gratis el acceso viene de ahi y no de la fila de pago.
export async function obtenerAccesoUsuario(usuarioId) {
  const ahora = new Date().toISOString();
  const limiteGraciaMs = new Date(calcularLimiteGracia()).getTime();

  const { data: candidatas, error } = await supabaseClient
    .from('suscriptions')
    .select('*')
    .eq('user_id', usuarioId)
    .eq('status', 'active')
    .gte('end_date', ahora)
    .order('sub_id', { ascending: false });

  if (error) {
    throw new Error('Error consultando suscripciones: ' + error.message);
  }

  let suscripcion = null;
  let graciaVencida = false;

  for (const fila of candidatas || []) {
    if (!fila.failed_at) {
      suscripcion = fila;
      break;
    }
    if (interpretarFechaUtc(fila.failed_at).getTime() > limiteGraciaMs) {
      suscripcion = fila;
      break;
    }
    // Habia una activa pero su gracia de cobro ya se agoto.
    graciaVencida = true;
  }

  return {
    suscripcion,
    tieneAcceso: !!suscripcion,
    graciaVencida,
  };
}
