// Validacion previa a cualquier escritura. Los objetos provienen de MP/BD,
// nunca del cuerpo del webhook ni de datos de compra enviados por el navegador.
export function validarIdRecurso(valor) {
  if ((typeof valor !== 'string' && typeof valor !== 'number') ||
      (typeof valor === 'number' && !Number.isSafeInteger(valor)) ||
      !/^[a-z\d-]+$/i.test(String(valor))) {
    throw new Error('ID de recurso MP invalido');
  }
  return String(valor).toLowerCase();
}

function exigir(condicion, codigo) {
  if (!condicion) throw new Error(`Validacion de pago: ${codigo}`);
}

function centavos(valor) {
  exigir((typeof valor === 'number' || typeof valor === 'string') &&
    /^\d+(\.\d{1,2})?$/.test(String(valor)), 'importe_invalido');
  const importe = Number(valor) * 100;
  exigir(Number.isSafeInteger(Math.round(importe)) && importe > 0, 'importe_invalido');
  return Math.round(importe);
}

export function validarPagoSuscripcion({ payment, factura, preapproval, fila, cobradorId, modo }) {
  exigir(modo === 'production' || modo === 'test', 'ambiente_no_configurado');
  exigir(payment.live_mode === (modo === 'production'), 'ambiente_discrepante');
  const mpSubId = validarIdRecurso(factura.preapproval_id);
  exigir(validarIdRecurso(factura.payment?.id) === validarIdRecurso(payment.id), 'pago_factura');
  exigir(validarIdRecurso(preapproval.id) === mpSubId, 'factura_preapproval');
  exigir(fila && fila.plan === 'mensual' && fila.mp_sub_id === mpSubId, 'suscripcion_no_registrada');
  exigir(fila.user_id && payment.external_reference === fila.user_id &&
    preapproval.external_reference === fila.user_id, 'usuario_discrepante');
  if (factura.external_reference != null) {
    exigir(String(factura.external_reference) === fila.user_id, 'usuario_factura');
  }
  for (const referencia of [payment.preapproval_id, payment.metadata?.preapproval_id]) {
    if (referencia != null) exigir(validarIdRecurso(referencia) === mpSubId, 'referencia_preapproval');
  }
  exigir(cobradorId != null && String(payment.collector_id) === String(cobradorId) &&
    String(preapproval.collector_id) === String(cobradorId), 'cobrador_discrepante');
  if (payment.application_id != null && preapproval.application_id != null) {
    exigir(String(payment.application_id) === String(preapproval.application_id), 'aplicacion_discrepante');
  }
  const recurrencia = preapproval.auto_recurring;
  exigir(recurrencia?.frequency === 1 && recurrencia.frequency_type === 'months', 'recurrencia_discrepante');
  // MXN es la moneda contratada por este producto. price se guarda al darlo de alta.
  exigir(payment.currency_id === 'MXN' && factura.currency_id === 'MXN' &&
    recurrencia.currency_id === 'MXN', 'moneda_discrepante');
  const esperado = centavos(fila.price);
  exigir([payment.transaction_amount, factura.transaction_amount, recurrencia.transaction_amount]
    .every((importe) => centavos(importe) === esperado), 'importe_discrepante');
  if (payment.status === 'approved') {
    exigir(typeof payment.date_approved === 'string' &&
      /(Z|[+-]\d{2}:\d{2})$/i.test(payment.date_approved) &&
      Number.isFinite(Date.parse(payment.date_approved)), 'fecha_aprobacion_invalida');
  }
  return { mpSubId, usuarioId: fila.user_id, facturaId: validarIdRecurso(factura.id) };
}

export function validarPagoExtra({ payment, compra, cobradorId, modo, referenciaHistorica = null }) {
  exigir(modo === 'production' || modo === 'test', 'ambiente_no_configurado');
  exigir(payment.live_mode === (modo === 'production'), 'ambiente_discrepante');
  const referencia = referenciaHistorica === null ? `extra:${compra.id}` : referenciaHistorica;
  if (referenciaHistorica !== null) exigir(referenciaHistorica === compra.legacy_external_reference, 'vinculo_historico_discrepante');
  exigir(payment.external_reference === referencia, 'compra_discrepante');
  exigir(cobradorId != null && String(payment.collector_id) === String(cobradorId), 'cobrador_discrepante');
  exigir(payment.currency_id === compra.moneda && compra.moneda === 'MXN', 'moneda_discrepante');
  exigir(centavos(payment.transaction_amount) === centavos(compra.monto), 'importe_discrepante');
  if (payment.status === 'approved') {
    exigir(typeof payment.date_approved === 'string' && Number.isFinite(Date.parse(payment.date_approved)), 'fecha_aprobacion_invalida');
  }
}
