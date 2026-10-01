import mercadopago from 'mercadopago';
import { supabaseClient } from './supabase.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';
console.log('[MP] FRONTEND_URL:', FRONTEND_URL);

// Mercado Pago exige fechas con offset y solo acepta el signo '-' (ej: -00:00).
// Se envia la hora UTC con offset -00:00 para pasar su validacion.
function formatearFechaMercadoPago(fecha) {
  return new Date(fecha).toISOString().replace('Z', '-00:00');
}

// Las columnas init_date/end_date son 'timestamp without time zone' (sin zona).
// Semantically son UTC: se interpretan como UTC para evitar corrimientos por tz del servidor.
export function interpretarFechaUtc(valor) {
  if (!valor) return null;
  const texto = String(valor).replace(' ', 'T');
  const tieneZona = /(Z|[+-]\d{2}:\d{2})$/i.test(texto);
  return tieneZona ? new Date(texto) : new Date(texto + 'Z');
}

export async function crearPreapprovalSuscripcion(usuarioId, email) {
  try {
    const body = {
      payer_email: email,
      reason: 'Suscripcion Mensual - Club de Lectura',
      external_reference: usuarioId,
      back_url: `${FRONTEND_URL}/dashboard.html?payment=success`,
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: 80.00,
        currency_id: 'MXN',
      },
    };

    // Si el usuario tiene una prueba gratis vigente, el primer cobro se agenda
    // para el dia en que termina la prueba: se respeta el mes gratis y el pago
    // arranca en el corte (el usuario asegura el proximo mes).
    const { data: prueba } = await supabaseClient
      .from('suscriptions')
      .select('sub_id, end_date')
      .eq('user_id', usuarioId)
      .eq('plan', 'gratis')
      .eq('status', 'active')
      .gte('end_date', new Date().toISOString())
      .maybeSingle();

    if (prueba?.end_date) {
      body.auto_recurring.start_date = formatearFechaMercadoPago(interpretarFechaUtc(prueba.end_date));
    }

    console.log(
      '[MP] Creando preapproval suscripcion...',
      body.auto_recurring.start_date
        ? `primer cobro programado: ${body.auto_recurring.start_date}`
        : 'cobro inmediato'
    );
    const response = await mercadopago.preapproval.create(body);
    console.log('[MP] Preapproval OK, id:', response.body?.id);
    return { data: response.body, error: null };

  } catch (error) {
    console.error('[MP] ERROR creando preapproval de suscripcion:', error.message);
    return { data: null, error };
  }
}

mercadopago.configure({
  access_token: process.env.MERCADOPAGO_ACCESS_TOKEN,
});

export async function obtenerPreapproval(preapprovalId) {
  try {
    const response = await mercadopago.preapproval.get(preapprovalId);
    return { data: response.body, error: null };
  } catch (error) {
    console.error('Error obteniendo preapproval:', error);
    return { data: null, error };
  }
}

export async function cancelarPreapproval(preapprovalId) {
  try {
    const response = await mercadopago.preapproval.cancel(preapprovalId);
    return { data: response.body, error: null };
  } catch (error) {
    console.error('Error cancelando preapproval:', error);
    return { data: null, error };
  }
}

export async function obtenerPagoAutorizado(authorizedPaymentId) {
  try {
    const response = await fetch(`https://api.mercadopago.com/authorized_payments/${authorizedPaymentId}`, {
      headers: { Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}` },
    });
    if (!response.ok) {
      throw new Error(`MercadoPago authorized_payments HTTP ${response.status}`);
    }
    return { data: await response.json(), error: null };
  } catch (error) {
    console.error('Error obteniendo pago autorizado:', error);
    return { data: null, error };
  }
}

export async function crearPreferenciaSesionExtra(usuarioId, email, sesionId, sesionTitulo, monto) {
  try {
    const preference = {
      items: [
        {
          title: `Sesion Especial - ${sesionTitulo}`,
          description: `Acceso a la sesion especial: ${sesionTitulo}`,
          category_id: 'events',
          quantity: 1,
          currency_id: 'MXN',
          unit_price: monto || 50.00,
        },
      ],
      payer: {
        email: email,
      },
      external_reference: `${usuarioId}:${sesionId}`,
      statement_descriptor: 'CLUB DE LECTURA',
      // Solo tarjeta: OXXO/ticket queda excluido a proposito. El ticket se paga
      // por fuera y su webhook llega 'pending' horas despues, con ventana de
      // expiracion; sin reconciliacion dejaba compras fantasma o cobros
      // huerfanos si el usuario nunca pagaba.
      payment_methods: {
        excluded_payment_types: [{ id: 'ticket' }],
        installments: 1,
      },
    };

    if (FRONTEND_URL.startsWith('https://')) {
      preference.back_urls = {
        success: `${FRONTEND_URL}/dashboard.html?payment=success&session=${sesionId}`,
        failure: `${FRONTEND_URL}/proximas-sesiones.html?payment=failure`,
        pending: `${FRONTEND_URL}/dashboard.html?payment=pending`,
      };
      preference.auto_return = 'approved';
    }

    const response = await mercadopago.createPreference(preference);
    return { data: response.body, error: null };

  } catch (error) {
    console.error('Error creando preferencia para sesion extra:', error);
    return { data: null, error };
  }
}

export async function obtenerPago(paymentId) {
  try {
    const response = await mercadopago.getPayment(paymentId);
    return { data: response.body, error: null };
  } catch (error) {
    console.error('Error obteniendo pago:', error);
    return { data: null, error };
  }
}

export async function procesarWebhookMercadoPago(webhookData) {
  try {
    const paymentId = webhookData.data?.id || webhookData.id;

    if (!paymentId) {
      throw new Error('No se encontro ID de pago en el webhook');
    }

    const { data: payment, error: errorPayment } = await obtenerPago(paymentId);
    if (errorPayment || !payment) {
      throw new Error(`Error validando pago con MercadoPago: ${errorPayment?.message}`);
    }

    const externalReference = payment.external_reference;
    if (!externalReference) {
      throw new Error('No se encontro external_reference en el pago');
    }

    const parts = externalReference.split(':');
    const usuarioId = parts[0];
    const sesionId = parts.length > 1 ? parts[1] : null;
    const esPagoSuscripcion = !sesionId;

    await supabaseClient
      .from('pagos')
      .upsert({
        mp_payment_id: String(payment.id),
        user_id: usuarioId,
        sesion_id: sesionId ? Number(sesionId) : null,
        monto: payment.transaction_amount,
        moneda: payment.currency_id,
        estado_mp: payment.status,
        tipo: esPagoSuscripcion ? 'suscripcion' : 'sesion_extra',
        metadata: JSON.stringify(payment),
        created_at: new Date().toISOString(),
      }, { onConflict: 'mp_payment_id' });

    if (esPagoSuscripcion) {
      await procesarPagoSuscripcion(usuarioId, payment);
    } else {
      await procesarPagoSesionExtra(usuarioId, Number(sesionId), payment);
    }

    return { data: { processed: true }, error: null };

  } catch (error) {
    console.error('Error procesando webhook de Mercado Pago:', error);
    return { data: null, error };
  }
}

async function vincularPreapprovalConUsuario(preapprovalId) {
  const { data: preapproval, error } = await obtenerPreapproval(preapprovalId);
  if (error || !preapproval) {
    throw new Error('No se pudo obtener el preapproval: ' + error?.message);
  }
  const usuarioId = preapproval.external_reference;
  if (!usuarioId) {
    throw new Error('Preapproval sin external_reference');
  }
  return { preapproval, usuarioId };
}

export async function procesarWebhookSuscripcionCreacion(webhookData) {
  const preapprovalId = webhookData.data?.id;
  if (!preapprovalId) {
    throw new Error('No se encontro id de preapproval en webhook');
  }

  const { preapproval, usuarioId } = await vincularPreapprovalConUsuario(preapprovalId);

  // Fecha del primer cobro (se agenda al crear el preapproval durante la prueba gratia)
  const startDate = preapproval.auto_recurring?.start_date || null;

  // Prueba gratis vigente: NO tocar la fila de la prueba. Se crea (o actualiza) una
  // fila separada 'mensual/pending' con el primer cobro programado al fin de la prueba.
  const { data: prueba } = await supabaseClient
    .from('suscriptions')
    .select('sub_id')
    .eq('user_id', usuarioId)
    .eq('plan', 'gratis')
    .eq('status', 'active')
    .gte('end_date', new Date().toISOString())
    .maybeSingle();

  if (prueba) {
    const initDate = startDate || new Date().toISOString();
    const endDate = new Date(initDate);
    endDate.setDate(endDate.getDate() + 30);

    const { data: programada } = await supabaseClient
      .from('suscriptions')
      .select('sub_id')
      .eq('mp_sub_id', String(preapprovalId))
      .maybeSingle();

    const patch = {
      plan: 'mensual',
      status: 'pending',
      init_date: new Date(initDate).toISOString(),
      end_date: endDate.toISOString(),
      price: 80.0,
    };

    if (programada) {
      await supabaseClient.from('suscriptions').update(patch).eq('sub_id', programada.sub_id);
    } else {
      await supabaseClient.from('suscriptions').insert({ ...patch, user_id: usuarioId, mp_sub_id: String(preapprovalId) });
    }

    return { data: { processed: true }, error: null };
  }

  // Sin prueba vigente: mantener comportamiento previo (convierte la fila mas reciente)
  const { data: existente } = await supabaseClient
    .from('suscriptions')
    .select('sub_id')
    .eq('user_id', usuarioId)
    .order('init_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  const patch = { mp_sub_id: String(preapprovalId), plan: 'mensual', status: 'pending' };
  if (existente) {
    await supabaseClient.from('suscriptions').update(patch).eq('sub_id', existente.sub_id);
  } else {
    await supabaseClient.from('suscriptions').insert({ ...patch, user_id: usuarioId });
  }

  return { data: { processed: true }, error: null };
}

export async function procesarWebhookSuscripcionPagoAutorizado(webhookData) {
  const authorizedPaymentId = webhookData.data?.id;
  if (!authorizedPaymentId) {
    throw new Error('No se encontro id de pago autorizado');
  }

  const { data: authorizedPayment, error } = await obtenerPagoAutorizado(authorizedPaymentId);
  if (error || !authorizedPayment) {
    throw new Error('Error obteniendo pago autorizado: ' + error?.message);
  }

  const paymentId = authorizedPayment.payment_id;
  if (!paymentId) {
    throw new Error('Pago autorizado sin payment_id');
  }

  return procesarWebhookMercadoPago({ type: 'payment', data: { id: paymentId } });
}

export async function procesarWebhookSuscripcionCancelada(webhookData) {
  const preapprovalId = webhookData.data?.id;
  if (!preapprovalId) {
    throw new Error('No se encontro id de preapproval en webhook');
  }

  const { data: suscripciones } = await supabaseClient
    .from('suscriptions')
    .select('user_id')
    .eq('mp_sub_id', String(preapprovalId));

  await supabaseClient
    .from('suscriptions')
    .update({ status: 'cancelled' })
    .eq('mp_sub_id', String(preapprovalId));

  const usuarioId = suscripciones?.[0]?.user_id;
  if (usuarioId) {
    await supabaseClient
      .from('users')
      .update({ role: 'free' })
      .eq('id', usuarioId);
  }

  return { data: { processed: true }, error: null };
}

export async function procesarPagoSuscripcion(usuarioId, payment) {
  // Solo 'approved' activa la suscripcion. Cualquier otro estado queda 'pending'
  // (tarjeta rechazada, sin fondos, etc.): Mercado Pago reintenta el cobro mensual
  // y la suscripcion se activa cuando el pago se aprueba.
  const status = payment.status === 'approved' ? 'active' : 'pending';
  const mpSubId = String(payment.preapproval_id || payment.id);

  // 1) Idempotencia por preapproval: si la fila de este preapproval ya esta
  //    'active', no se toca. Sin esta guarda cada reenvio del webhook
  //    recalculaba end_date = ahora + 30 y extendia la suscripcion para
  //    siempre.
  const { data: porPreapproval } = await supabaseClient
    .from('suscriptions')
    .select('sub_id, status')
    .eq('mp_sub_id', mpSubId)
    .maybeSingle();

  if (porPreapproval?.status === 'active' && status === 'active') {
    console.log(`[MP] Suscripcion ${mpSubId} ya activa, no se re-procesa`);
    return;
  }

  // 2) Nunca pisar la fila del mes gratis: el trial sigue vigente y la
  //    suscripcion de pago va en su propia fila (mismo criterio que
  //    procesarWebhookSuscripcionCreacion).
  const { data: prueba } = await supabaseClient
    .from('suscriptions')
    .select('sub_id')
    .eq('user_id', usuarioId)
    .eq('plan', 'gratis')
    .eq('status', 'active')
    .gte('end_date', new Date().toISOString())
    .maybeSingle();

  const fechaInicio = new Date();
  const fechaFin = new Date();
  fechaFin.setDate(fechaFin.getDate() + 30);

  const suscripcionData = {
    user_id: usuarioId,
    plan: 'mensual',
    status: status,
    mp_sub_id: mpSubId,
    init_date: fechaInicio.toISOString(),
    end_date: status === 'active' ? fechaFin.toISOString() : null,
    price: payment.transaction_amount,
  };

  if (porPreapproval) {
    // Ya existe la fila de este preapproval: se actualiza en sitio.
    await supabaseClient
      .from('suscriptions')
      .update(suscripcionData)
      .eq('sub_id', porPreapproval.sub_id);
  } else {
    // La fila del trial (si existe) se deja intacta y la de pago se crea
    // aparte, para no perder los dias restantes del mes gratis.
    await supabaseClient
      .from('suscriptions')
      .insert(suscripcionData);
    if (prueba) {
      console.log(`[MP] Trial vigente intacto; suscripcion de pago creada aparte para ${usuarioId}`);
    }
  }

  if (status === 'active') {
    await supabaseClient
      .from('users')
      .update({ role: 'suscriptor' })
      .eq('id', usuarioId);
  }
}

// Mercado Pago notifica 'approved' (cobrado), 'rejected' (rechazado) y
// 'pending' (autorizado pero sin liquidar). Con OXXO excluido del checkout
// no deberia llegar 'pending', pero se conserva el estado por si MP lo enviara.
function mapearEstadoPago(mpStatus) {
  if (mpStatus === 'approved') return 'active';
  if (mpStatus === 'rejected') return 'rejected';
  return 'pending';
}

export async function procesarPagoSesionExtra(usuarioId, sesionId, payment) {
  const estado = mapearEstadoPago(payment.status);
  const mpPayId = String(payment.id);
  const estadoCompra = estado === 'active' ? 'pagada' : estado === 'rejected' ? 'rechazada' : 'pending';

  // Idempotencia: el webhook de MP se reenvia. Si esta fila ya existe solo se
  // actualiza el estado (p.ej. 'pending' -> 'pagada'), nunca se inserta otra.
  const { data: existente, error: errorExistente } = await supabaseClient
    .from('extra_sessions')
    .select('id, status')
    .eq('mp_pay_id', mpPayId)
    .maybeSingle();

  if (errorExistente) {
    console.error('[MP] Error buscando compra existente:', errorExistente.message);
  }

  if (existente) {
    // Una compra ya cobrada no se degrada nunca: un reenvio con otro estado
    // (p.ej. 'rejected' que llega despues) no debe quitar el acceso.
    if (existente.status !== 'pagada') {
      const { error: errorUpdate } = await supabaseClient
        .from('extra_sessions')
        .update({ status: estadoCompra })
        .eq('id', existente.id);

      if (errorUpdate) {
        console.error('[MP] Error actualizando estado de compra:', errorUpdate.message);
      }
    }
    console.log(`[MP] Compra sesion ${sesionId} ya registrada (${mpPayId}), estado: ${estadoCompra}`);
    return;
  }

  // Si no es un pago válido se registra el intento como rechazado para que el
  // unique (user_id, session_id) libere la compra y el usuario pueda reintentar.
  const { error: errorInsert } = await supabaseClient
    .from('extra_sessions')
    .insert({
      user_id: usuarioId,
      session_id: sesionId,
      price: payment.transaction_amount,
      pur_date: new Date().toISOString(),
      mp_pay_id: mpPayId,
      status: estadoCompra,
    });

  if (errorInsert) {
    // 23505 = unique violation: otro webhook gano la carrera. No es fatal.
    if (errorInsert.code === '23505') {
      console.log(`[MP] Compra sesion ${sesionId} ya insertada por otro webhook`);
      return;
    }
    throw errorInsert;
  }

  console.log(`[MP] Compra sesion ${sesionId} registrada con estado: ${estadoCompra}`);
}

export async function cancelarSuscripcion(usuarioId) {
  try {
    // Cancela el preapproval de pago: puede estar 'active' (ya cobrando) o
    // 'pending' (programado durante la prueba gratis, primer cobro en el corte).
    const { data: suscripcion, error } = await supabaseClient
      .from('suscriptions')
      .select('sub_id, mp_sub_id, plan, status')
      .eq('user_id', usuarioId)
      .in('status', ['active', 'pending'])
      .not('mp_sub_id', 'is', null)
      .order('sub_id', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') {
      return { data: null, error };
    }
    if (!suscripcion) {
      return { data: null, error: new Error('No se encontro suscripcion de pago activa o programada') };
    }

    // Cortar el cobro recurrente en Mercado Pago
    if (suscripcion.mp_sub_id) {
      const { error: errorMp } = await cancelarPreapproval(suscripcion.mp_sub_id);
      if (errorMp) {
        console.error('Error cancelando preapproval en MP:', errorMp.message);
        return { data: null, error: new Error('No se pudo cancelar la suscripcion en Mercado Pago') };
      }
    }

    await supabaseClient
      .from('suscriptions')
      .update({ status: 'cancelled' })
      .eq('sub_id', suscripcion.sub_id);

    // Si cancelaba una de pago YA activa, pierde el rol premium.
    // Si cancelaba una programada, la prueba gratis sigue intacta (rol free correcto).
    if (suscripcion.plan === 'mensual' && suscripcion.status === 'active') {
      await supabaseClient
        .from('users')
        .update({ role: 'free' })
        .eq('id', usuarioId);
    }

    return { data: { cancelled: true }, error: null };

  } catch (error) {
    console.error('Error cancelando suscripcion:', error);
    return { data: null, error };
  }
}
