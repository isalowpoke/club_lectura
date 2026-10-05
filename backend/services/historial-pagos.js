// Contrato publico: no incluye metadata, identificadores de otros usuarios ni
// detalles internos del antifraude. Estados no reconocidos no se llaman pendientes.
const ESTADOS = {
  approved: 'Aprobado', rejected: 'Rechazado', pending: 'Pendiente',
  in_process: 'En proceso', authorized: 'Autorizado, pendiente de captura',
  cancelled: 'Cancelado', refunded: 'Reembolsado', charged_back: 'Contracargo',
  in_mediation: 'En mediación',
};
export function presentarPago(pago) {
  return { mp_payment_id: pago.mp_payment_id, monto: pago.monto, moneda: pago.moneda,
    estado_mp: pago.estado_mp, tipo: pago.tipo, created_at: pago.created_at,
    estado_texto: Object.hasOwn(ESTADOS, pago.estado_mp) ? ESTADOS[pago.estado_mp] : 'Estado por verificar' };
}
