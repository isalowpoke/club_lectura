import { supabaseClient } from './supabase.js';
import { interpretarFechaUtc } from './periodos-pago.js';

// Una sola decision para dashboard, sesiones y middleware, en un snapshot SQL.
export async function obtenerAccesoUsuario(usuarioId) {
  const { data, error } = await supabaseClient.rpc('estado_acceso_pagos', { p_usuario: usuarioId });
  if (error || !data) throw new Error('No se pudo consultar el acceso');
  return data;
}

export function presentarEstadoAcceso(acceso) {
  const { suscripcion, tieneAcceso, enGracia, graciaVencida, acuerdos = [] } = acceso;
  const autorizado = acuerdos.length === 1 && acuerdos[0].recurrence_status === 'authorized' ? acuerdos[0] : null;
  const pendiente = acuerdos.some((a) => a.recurrence_status === 'pending');
  const proxima = autorizado?.next_payment_at || null;
  const pagoProgramado = !!proxima && Number.isFinite(Date.parse(proxima)) && Date.parse(proxima) > Date.now();
  return { tiene_suscripcion: tieneAcceso, estado: tieneAcceso ? 'activa' : 'inactiva',
    plan: suscripcion?.plan || null, precio: suscripcion?.price || null,
    fecha_fin: interpretarFechaUtc(suscripcion?.end_date)?.toISOString() || null, en_prueba: suscripcion?.plan === 'gratis',
    en_gracia: enGracia, renovacion_fallida: enGracia || graciaVencida,
    checkout_pendiente: pendiente, pago_programado: pagoProgramado,
    pago_pendiente_cobro: !!autorizado && !pagoProgramado && !tieneAcceso,
    cobro_rechazado: autorizado?.ultimo_estado_pago === 'rejected',
    puede_cancelar: acuerdos.some((a) => a.recurrence_status !== 'cancelled'),
    recurrencia_cancelada: tieneAcceso && suscripcion?.plan === 'mensual' && ['cancelled', 'paused'].includes(suscripcion.recurrence_status),
    requiere_revision: !!acceso.operacionPendiente || acuerdos.length > 1 || acuerdos.some((a) => !a.recurrence_status),
    proxima_fecha_cobro: pagoProgramado ? proxima : null };
}
