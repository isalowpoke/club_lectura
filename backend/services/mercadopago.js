import { crearClienteMercadoPago } from './cliente-mercadopago.js';
import { randomUUID } from 'node:crypto';
import { supabaseClient } from './supabase.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { validarIdRecurso, validarPagoSuscripcion, validarPagoExtra } from './validar-pago-suscripcion.js';
import { interpretarFechaUtc, fechaProveedor, periodoFacturado, desfaseProveedor } from './periodos-pago.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
const mercadopago = crearClienteMercadoPago(process.env.MERCADOPAGO_ACCESS_TOKEN);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';
export { interpretarFechaUtc };

function conflicto(mensaje) {
  return Object.assign(new Error(mensaje), { status: 409 });
}

async function rpc(nombre, parametros) {
  const { data, error } = await supabaseClient.rpc(nombre, parametros);
  if (error) throw new Error(`No se pudo completar ${nombre}`);
  return data;
}

async function limitarLlamada(operacion) {
  let temporizador;
  try {
    return await Promise.race([operacion(), new Promise((_, reject) => {
      temporizador = setTimeout(() => reject(new Error('Tiempo de espera agotado en MP')), 4000);
    })]);
  } finally { clearTimeout(temporizador); }
}

export async function consultarMercadoPago(ruta) {
  const response = await fetch(`https://api.mercadopago.com${ruta}`, {
    headers: { Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}` },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`Consulta MP HTTP ${response.status}`);
  return response.json();
}

export async function obtenerPreapproval(id) {
  try {
    const esperado = validarIdRecurso(id);
    const response = await limitarLlamada(() => mercadopago.obtenerAcuerdo(esperado));
    if (validarIdRecurso(response?.id) !== esperado) throw new Error('Preapproval MP discrepante');
    return { data: response, error: null };
  } catch (error) { return { data: null, error }; }
}

export async function obtenerPago(id) {
  try {
    const esperado = validarIdRecurso(id);
    const response = await limitarLlamada(() => mercadopago.obtenerPago(esperado));
    if (validarIdRecurso(response?.id) !== esperado) throw new Error('Pago MP discrepante');
    return { data: response, error: null };
  } catch (error) { return { data: null, error }; }
}

export async function obtenerPagoAutorizado(id) {
  try {
    const esperado = validarIdRecurso(id);
    const data = await consultarMercadoPago(`/authorized_payments/${encodeURIComponent(esperado)}`);
    if (validarIdRecurso(data.id) !== esperado) throw new Error('Factura MP discrepante');
    return { data, error: null };
  } catch (error) { return { data: null, error }; }
}

function datosAcuerdo(pre) {
  if (!['pending', 'authorized', 'paused', 'cancelled'].includes(pre.status)) throw new Error('Estado de acuerdo desconocido');
  return { id: validarIdRecurso(pre.id), status: pre.status,
    last_modified: fechaProveedor(pre.last_modified),
    start_date: pre.auto_recurring?.start_date ? fechaProveedor(pre.auto_recurring.start_date) : null,
    offset_minutes: pre.auto_recurring?.start_date ? desfaseProveedor(pre.auto_recurring.start_date) : null,
    next_payment_date: pre.next_payment_date ? fechaProveedor(pre.next_payment_date) : null };
}

async function sincronizarAcuerdo(pre, usuarioId) {
  if (pre.external_reference !== usuarioId) throw new Error('Usuario del preapproval discrepante');
  return rpc('sincronizar_acuerdo_cobro', { p_usuario: usuarioId, p_acuerdo: datosAcuerdo(pre) });
}

async function acuerdosUsuario(usuarioId) {
  const { data, error } = await supabaseClient.from('suscriptions')
    .select('sub_id, mp_sub_id, recurrence_status').eq('user_id', usuarioId).eq('plan', 'mensual');
  if (error) throw new Error('No se pudieron consultar los acuerdos existentes');
  return (data || []).filter((fila) => fila.mp_sub_id);
}

export async function crearPreapprovalSuscripcion(usuarioId, email) {
  const token = randomUUID();
  let reservada = false;
  let enviando = false;
  try {
    reservada = await rpc('reservar_cobro', { p_usuario: usuarioId, p_token: token });
    if (!reservada) throw conflicto('Hay una operación en proceso o pendiente de verificación. No se creó otro cobro.');
    const vigentes = [];
    for (const fila of await acuerdosUsuario(usuarioId)) {
      if (fila.recurrence_status === 'cancelled') continue;
      const { data: pre, error } = await obtenerPreapproval(fila.mp_sub_id);
      if (error || !pre) throw new Error('No se pudo verificar un acuerdo previo');
      await sincronizarAcuerdo(pre, usuarioId);
      if (pre.status !== 'cancelled') vigentes.push(pre);
    }
    if (vigentes.length > 1) throw conflicto('Existen varios acuerdos. Revisa su cancelación antes de iniciar otro.');
    if (vigentes.length === 1) {
      const pre = vigentes[0];
      if (pre.status === 'paused') throw conflicto('Existe un acuerdo pausado; cancélalo antes de crear otro.');
      if (pre.status === 'pending' && !pre.init_point) throw new Error('Checkout existente no disponible');
      return { data: { ...pre, ya_autorizada: pre.status === 'authorized' }, error: null, reutilizado: true };
    }
    const { data: pruebas, error: errorPrueba } = await supabaseClient.from('suscriptions')
      .select('init_date, end_date').eq('user_id', usuarioId).eq('plan', 'gratis').eq('status', 'active');
    if (errorPrueba) throw new Error('No se pudo verificar el periodo gratuito');
    const finales = (pruebas || []).map((fila) => {
      const fecha = interpretarFechaUtc(fila.end_date);
      if (!fecha || !interpretarFechaUtc(fila.init_date)) throw new Error('Periodo gratuito incompleto');
      return fecha.getTime();
    });
    const acceso = await rpc('estado_acceso_pagos', { p_usuario: usuarioId });
    const finPagado = interpretarFechaUtc(acceso.suscripcion?.end_date)?.getTime() || 0;
    const inicio = Math.max(0, finPagado, ...finales);
    const body = { payer_email: email, reason: 'Suscripcion Mensual - Club de Lectura',
      external_reference: usuarioId, back_url: `${FRONTEND_URL}/dashboard.html?retorno=mp`, status: 'pending',
      auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: 80, currency_id: 'MXN' } };
    if (inicio > Date.now()) body.auto_recurring.start_date = new Date(inicio).toISOString().replace('Z', '-00:00');
    if (!await rpc('marcar_envio_cobro', { p_usuario: usuarioId, p_token: token })) throw conflicto('La reserva expiró antes del envío. Intenta nuevamente.');
    // El estado enviando no caduca: un POST puede completarse despues del timeout.
    enviando = true;
    const response = await limitarLlamada(() => mercadopago.crearAcuerdo(body, token));
    if (response?.external_reference !== usuarioId) throw new Error('Alta de acuerdo discrepante');
    await rpc('registrar_acuerdo_cobro', { p_usuario: usuarioId, p_token: token, p_acuerdo: datosAcuerdo(response) });
    return { data: response, error: null, reutilizado: false };
  } catch (error) { return { data: null, error }; }
  finally {
    if (reservada && !enviando) await rpc('liberar_reserva_cobro', { p_usuario: usuarioId, p_token: token });
  }
}

export async function cancelarSuscripcion(usuarioId) {
  const token = randomUUID();
  let reservada = false;
  try {
    reservada = await rpc('reservar_cobro', { p_usuario: usuarioId, p_token: token });
    if (!reservada) throw conflicto('Hay una operación pendiente de verificación.');
    let incompletas = 0;
    for (const fila of await acuerdosUsuario(usuarioId)) {
      try {
        let { data: pre, error } = await obtenerPreapproval(fila.mp_sub_id);
        if (error || !pre || pre.external_reference !== usuarioId) throw new Error('Acuerdo no verificable');
        if (pre.status !== 'cancelled') {
          try { await limitarLlamada(() => mercadopago.cancelarAcuerdo(validarIdRecurso(pre.id))); }
          catch { /* Verificar resultado incluso ante timeout o doble cancelacion. */ }
          ({ data: pre, error } = await obtenerPreapproval(fila.mp_sub_id));
          if (error || pre?.status !== 'cancelled') throw new Error('Cancelacion no confirmada');
        }
        await sincronizarAcuerdo(pre, usuarioId);
      } catch {
        // Un registro historico defectuoso no impide detener los demas acuerdos.
        incompletas++;
      }
    }
    if (incompletas) throw conflicto('Se procesaron los acuerdos verificables; quedan acuerdos pendientes de revisión.');
    return { data: { cancelled: true }, error: null };
  } catch (error) { return { data: null, error }; }
  finally {
    if (reservada) await rpc('liberar_reserva_cobro', { p_usuario: usuarioId, p_token: token });
  }
}

export async function crearPreferenciaSesionExtra(usuarioId, email, sesionId) {
  try {
    const compra = await rpc('reservar_compra_extra', { p_usuario: usuarioId, p_sesion: sesionId });
    if (!compra.nueva) {
      if (compra.estado === 'lista' && compra.init_point) return { data: { id: compra.preference_id, init_point: compra.init_point }, error: null };
      throw conflicto(compra.estado === 'pagada' ? 'Esta sesión ya está pagada.' : 'La compra está pendiente de verificación.');
    }
    const preference = { items: [{ title: 'Sesion Especial - Club de Lectura', quantity: 1,
      currency_id: compra.moneda, unit_price: Number(compra.monto) }], payer: { email },
      external_reference: `extra:${compra.id}`, statement_descriptor: 'CLUB DE LECTURA',
      payment_methods: { excluded_payment_types: [{ id: 'ticket' }], installments: 1 } };
    if (FRONTEND_URL.startsWith('https://')) {
      preference.back_urls = { success: `${FRONTEND_URL}/dashboard.html?retorno=mp`,
        failure: `${FRONTEND_URL}/sesion-especial.html?id=${sesionId}&retorno=mp`,
        pending: `${FRONTEND_URL}/dashboard.html?retorno=mp` };
      preference.auto_return = 'approved';
    }
    const response = await limitarLlamada(() => mercadopago.crearPreferencia(preference, compra.id));
    await rpc('registrar_preferencia_extra', { p_compra: compra.id, p_preferencia: String(response.id), p_url: response.init_point });
    return { data: response, error: null };
  } catch (error) { return { data: null, error }; }
}

async function resolverPagoSuscripcion(payment, facturaConsultada) {
  let factura = facturaConsultada;
  if (!factura) {
    const respuesta = await consultarMercadoPago(`/authorized_payments/search?payment_id=${encodeURIComponent(validarIdRecurso(payment.id))}&limit=2`);
    if (!Array.isArray(respuesta.results) || respuesta.results.length !== 1 || Number(respuesta.paging?.total ?? respuesta.results.length) !== 1) {
      throw new Error('No se pudo resolver una unica factura para el pago');
    }
    factura = respuesta.results[0];
  }
  const { data: preapproval, error } = await obtenerPreapproval(factura.preapproval_id);
  if (error || !preapproval) throw new Error('No se pudo verificar el preapproval');
  const { data: fila, error: errorBD } = await supabaseClient.from('suscriptions')
    .select('sub_id, user_id, mp_sub_id, plan, price, billing_anchor_at, billing_offset_minutes').eq('mp_sub_id', validarIdRecurso(factura.preapproval_id)).maybeSingle();
  if (errorBD) throw new Error('No se pudo verificar la suscripcion local');
  const cuenta = await consultarMercadoPago('/users/me');
  const vinculo = validarPagoSuscripcion({ payment, factura, preapproval, fila,
    cobradorId: cuenta.id, modo: process.env.MERCADOPAGO_MODE || 'production' });
  return { ...vinculo, subId: fila.sub_id, periodo: periodoFacturado(factura, preapproval, fila), preapproval };
}

export async function procesarWebhookMercadoPago(webhookData, facturaConsultada = null) {
  try {
    const { data: payment, error } = await obtenerPago(webhookData.data?.id);
    if (error || !payment) throw new Error('No se pudo consultar el pago');
    const referencia = payment.external_reference;
    if (typeof referencia !== 'string' || !referencia) throw new Error('Pago sin referencia');
    let vinculo;
    let compra;
    if (referencia.includes(':')) {
      if (facturaConsultada) throw new Error('Factura con referencia de sesion extra');
      let compraId = referencia.slice(6);
      let referenciaHistorica = null;
      if (!referencia.startsWith('extra:')) {
        const { data: vinculoHistorico, error: errorVinculo } = await supabaseClient.from('vinculos_pagos_extras')
          .select('compra_id, user_id').eq('mp_payment_id', String(payment.id)).maybeSingle();
        if (errorVinculo || !vinculoHistorico) throw new Error('Compra historica pendiente de conciliacion');
        compraId = vinculoHistorico.compra_id;
        referenciaHistorica = referencia;
      }
      const { data, error: errorCompra } = await supabaseClient.from('compras_extras')
        .select('*').eq('id', compraId).maybeSingle();
      if (errorCompra || !data) throw new Error('Compra extra no registrada');
      compra = data;
      const cuenta = await consultarMercadoPago('/users/me');
      if (referenciaHistorica && referenciaHistorica !== `${compra.user_id}:${compra.session_id}`) throw new Error('Referencia historica discrepante');
      validarPagoExtra({ payment, compra, cobradorId: cuenta.id, modo: process.env.MERCADOPAGO_MODE || 'production', referenciaHistorica });
    } else {
      vinculo = await resolverPagoSuscripcion(payment, facturaConsultada);
    }
    const fecha = fechaProveedor(payment.date_last_updated);
    const creado = fechaProveedor(payment.date_created);
    const reembolsado = payment.transaction_amount_refunded ?? 0;
    if (!Number.isFinite(Number(reembolsado)) || Number(reembolsado) < 0 || Number(reembolsado) > Number(payment.transaction_amount)) {
      throw new Error('Importe reembolsado invalido');
    }
    const pago = { mp_payment_id: String(payment.id), user_id: vinculo?.usuarioId || compra.user_id,
      sub_id: vinculo?.subId || null, factura_id: vinculo?.facturaId || null,
      compra_extra_id: compra?.id || null, monto: payment.transaction_amount, moneda: payment.currency_id,
      estado_mp: payment.status, reembolsado: Number(reembolsado), mp_updated_at: fecha, created_at: creado,
      periodo_inicio: vinculo?.periodo.inicio || null, periodo_fin: vinculo?.periodo.fin || null,
      metadata: { status_detail: payment.status_detail, live_mode: payment.live_mode,
        date_approved: payment.date_approved, authorized_payment_id: vinculo?.facturaId,
        preapproval_id: vinculo?.mpSubId, reembolsado: Number(reembolsado) } };
    if (vinculo) await sincronizarAcuerdo(vinculo.preapproval, vinculo.usuarioId);
    const aplicado = await rpc('aplicar_pago_verificado', { p_pago: pago });
    return { data: { processed: true, applied: aplicado }, error: null };
  } catch (error) { return { data: null, error }; }
}

export async function procesarWebhookSuscripcionPreapproval(webhookData) {
  const { data: pre, error } = await obtenerPreapproval(webhookData.data?.id);
  if (error || !pre) throw new Error('No se pudo consultar el acuerdo');
  await sincronizarAcuerdo(pre, pre.external_reference);
  return { data: { processed: true, estado_mp: pre.status }, error: null };
}

export async function procesarWebhookSuscripcionPagoAutorizado(webhookData) {
  const { data: factura, error } = await obtenerPagoAutorizado(webhookData.data?.id);
  if (error || !factura) throw error || new Error('Factura no disponible');
  if (!factura.payment?.id) {
    if (factura.status === 'scheduled' && factura.payment?.id == null) return { data: { processed: false, reason: 'factura_sin_pago' }, error: null };
    throw new Error('Factura sin payment.id verificable');
  }
  return procesarWebhookMercadoPago({ type: 'payment', data: { id: factura.payment.id } }, factura);
}

export const procesarWebhookSuscripcionCancelada = procesarWebhookSuscripcionPreapproval;
