import mercadopago from 'mercadopago';
import { supabaseClient } from './supabase.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';
console.log('[MP] FRONTEND_URL:', FRONTEND_URL);

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

    console.log('[MP] Creando preapproval suscripcion...');
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

  const { usuarioId } = await vincularPreapprovalConUsuario(preapprovalId);

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

async function procesarPagoSuscripcion(usuarioId, payment) {
  const status = payment.status === 'approved' ? 'active' :
                 payment.status === 'rejected' ? 'cancelled' : 'pending';

  const { data: existente } = await supabaseClient
    .from('suscriptions')
    .select('sub_id')
    .eq('user_id', usuarioId)
    .order('init_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  const fechaInicio = new Date();
  const fechaFin = new Date();
  fechaFin.setDate(fechaFin.getDate() + 30);

  const suscripcionData = {
    user_id: usuarioId,
    plan: 'mensual',
    status: status,
    mp_sub_id: String(payment.preapproval_id || payment.id),
    init_date: existente ? undefined : fechaInicio.toISOString(),
    end_date: status === 'active' ? fechaFin.toISOString() : undefined,
    price: payment.transaction_amount,
  };

  if (existente) {
    await supabaseClient
      .from('suscriptions')
      .update(suscripcionData)
      .eq('sub_id', existente.sub_id);
  } else {
    await supabaseClient
      .from('suscriptions')
      .insert(suscripcionData);
  }

  if (status === 'active') {
    await supabaseClient
      .from('users')
      .update({ role: 'suscriptor' })
      .eq('id', usuarioId);
  }
}

async function procesarPagoSesionExtra(usuarioId, sesionId, payment) {
  const status = payment.status === 'approved' ? 'pagada' : 'rechazada';

  await supabaseClient
    .from('extra_sessions')
    .insert({
      user_id: usuarioId,
      session_id: sesionId,
      price: payment.transaction_amount,
      pur_date: new Date().toISOString(),
      mp_pay_id: String(payment.id),
    });
}

export async function cancelarSuscripcion(usuarioId) {
  try {
    const { data: suscripcion, error } = await supabaseClient
      .from('suscriptions')
      .select('sub_id, mp_sub_id')
      .eq('user_id', usuarioId)
      .eq('status', 'active')
      .maybeSingle();

    if (error || !suscripcion) {
      return { data: null, error: error || new Error('No se encontro suscripcion activa') };
    }

    // Cancelar el preapproval en Mercado Pago para cortar el cobro recurrente
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

    await supabaseClient
      .from('users')
      .update({ role: 'free' })
      .eq('id', usuarioId);

    return { data: { cancelled: true }, error: null };

  } catch (error) {
    console.error('Error cancelando suscripcion:', error);
    return { data: null, error };
  }
}
