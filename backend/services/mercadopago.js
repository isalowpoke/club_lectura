import mercadopago from 'mercadopago';
import { supabaseClient } from './supabase.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';
console.log('[MP] FRONTEND_URL:', FRONTEND_URL);

mercadopago.configure({
  access_token: process.env.MERCADOPAGO_ACCESS_TOKEN,
});

export async function crearPreferenciaSuscripcion(usuarioId, email) {
  try {
    const preference = {
      items: [
        {
          title: 'Suscripcion Mensual - Club de Lectura',
          description: 'Acceso a todas las sesiones, libro del mes y contenido exclusivo',
          category_id: 'reading',
          quantity: 1,
          currency_id: 'MXN',
          unit_price: 80.00,
        },
      ],
      payer: {
        email: email,
      },
      external_reference: usuarioId,
      statement_descriptor: 'CLUB DE LECTURA',
    };

    if (FRONTEND_URL.startsWith('https://')) {
      preference.back_urls = {
        success: `${FRONTEND_URL}/dashboard.html?payment=success`,
        failure: `${FRONTEND_URL}/precios.html?payment=failure`,
        pending: `${FRONTEND_URL}/dashboard.html?payment=pending`,
      };
      preference.auto_return = 'approved';
    }

    console.log('[MP] Creando preferencia suscripcion...');
    const response = await mercadopago.createPreference(preference);
    console.log('[MP] Response OK, id:', response.body?.id);
    return { data: response.body, error: null };

  } catch (error) {
    console.error('[MP] ERROR creando preferencia de suscripcion:', error.message);
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
          category_id: 'special_session',
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

async function procesarPagoSuscripcion(usuarioId, payment) {
  const status = payment.status === 'approved' ? 'active' :
                 payment.status === 'rejected' ? 'cancelled' : 'pending';

  const { data: existente } = await supabaseClient
    .from('suscriptions')
    .select('sub_id')
    .eq('user_id', usuarioId)
    .single();

  const fechaInicio = new Date();
  const fechaFin = new Date();
  fechaFin.setDate(fechaFin.getDate() + 30);

  const suscripcionData = {
    user_id: usuarioId,
    plan: 'mensual',
    status: status,
    mp_sub_id: String(payment.id),
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
      .select('sub_id')
      .eq('user_id', usuarioId)
      .eq('status', 'active')
      .single();

    if (error || !suscripcion) {
      return { data: null, error: error || new Error('No se encontro suscripcion activa') };
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
