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

// Un preapproval con estos estados sigue siendo pagable: se puede reutilizar.
const PREAPPROVAL_VIGENTE = ['pending', 'authorized'];

function calcularFinSuscripcion(inicio) {
  const fin = new Date(inicio);
  fin.setDate(fin.getDate() + 30);
  return fin;
}

// El motor antifraude de MP rechaza (y bloquea temporalmente) los intentos
// consecutivos con parametros identicos de payer e items. Por eso se reutiliza
// el preapproval vigente en lugar de crear uno nuevo en cada clic.
async function buscarPreapprovalReutilizable(usuarioId) {
  const { data: filas, error } = await supabaseClient
    .from('suscriptions')
    .select('sub_id, mp_sub_id')
    .eq('user_id', usuarioId)
    .eq('plan', 'mensual')
    .eq('status', 'pending')
    .not('mp_sub_id', 'is', null);

  if (error) {
    console.error('[MP] Error buscando preapproval previo:', error.message);
    return null;
  }

  for (const fila of filas || []) {
    const { data: pre, error: errorPre } = await obtenerPreapproval(fila.mp_sub_id);
    if (errorPre || !pre) continue;
    if (PREAPPROVAL_VIGENTE.includes(pre.status) && pre.init_point) {
      return pre;
    }
  }

  return null;
}

// Los preapprovals que ya no sirven se cancelan en MP y se marcan en la BD, para
// no dejar suscripciones huerfanas ni filas 'pending' que rompan el maybeSingle()
// de GET /api/pagos/estado.
//
// Devuelve:
//   { reutilizar: preapproval } -> hay uno que sigue pagable, se debe reutilizar
//   { error: Error }            -> no se pudo confirmar el estado, no se debe crear otro
//   null                         -> todo limpio, se puede crear uno nuevo
async function cancelarPreapprovalsPrevios(usuarioId) {
  const { data: filas, error } = await supabaseClient
    .from('suscriptions')
    .select('sub_id, mp_sub_id')
    .eq('user_id', usuarioId)
    .eq('plan', 'mensual')
    .eq('status', 'pending')
    .not('mp_sub_id', 'is', null);

  if (error) {
    console.error('[MP] Error listando preapprovals previos:', error.message);
    return { error };
  }

  for (const fila of filas || []) {
    const id = String(fila.mp_sub_id);
    try {
      const respuesta = await mercadopago.preapproval.update({
        id,
        status: 'cancelled',
      });
      console.log('[MP] Preapproval previo cancelado:', id,
        '->', respuesta?.body?.status);
    } catch (errorCancelar) {
      // Puede ser que ya estuviera cancelado o un fallo puntual. Se consulta el
      // estado real en MP antes de decidir nada.
      console.warn('[MP] No se pudo cancelar el preapproval', id, ':', errorCancelar.message);
      const { data: pre, error: errorGet } = await obtenerPreapproval(id);
      if (errorGet || !pre) {
        // Sin estado confirmado no se asume nada: crear otro podria duplicar.
        console.error('[MP] No se pudo verificar el estado de', id,
          ': se aborta para no duplicar el cobro');
        return { error: new Error('No se pudo verificar el estado de un pago previo') };
      }
      if (PREAPPROVAL_VIGENTE.includes(pre.status) && pre.init_point) {
        return { reutilizar: pre };
      }
    }

    await supabaseClient
      .from('suscriptions')
      .update({ status: 'cancelled' })
      .eq('sub_id', fila.sub_id);
  }

  return null;
}

// El preapproval se registra al crearse (no solo cuando llega el webhook) para
// poder reutilizarlo ante un reintento del usuario. Devuelve false si no se pudo
// registrar: en ese caso el preapproval queda sin rastrear y hay que cancelarlo.
async function registrarPreapprovalPendiente(usuarioId, pre) {
  const inicio = pre?.auto_recurring?.start_date || new Date().toISOString();

  const { error } = await supabaseClient.from('suscriptions').insert({
    user_id: usuarioId,
    plan: 'mensual',
    status: 'pending',
    mp_sub_id: String(pre.id),
    price: 80.0,
    init_date: new Date(inicio).toISOString(),
    end_date: calcularFinSuscripcion(inicio).toISOString(),
  });

  if (error) {
    console.error('[MP] Error registrando preapproval pendiente:', error.message);
    return false;
  }

  return true;
}

export async function crearPreapprovalSuscripcion(usuarioId, email) {
  try {
    // Un clic repetido no debe generar un segundo preapproval identico.
    const reutilizable = await buscarPreapprovalReutilizable(usuarioId);
    if (reutilizable) {
      console.log('[MP] Reutilizando preapproval vigente:', reutilizable.id);
      return { data: reutilizable, error: null, reutilizado: true };
    }

    const limpieza = await cancelarPreapprovalsPrevios(usuarioId);
    if (limpieza?.error) {
      return { data: null, error: limpieza.error };
    }
    if (limpieza?.reutilizar) {
      console.log('[MP] Se conserva el preapproval vigente:', limpieza.reutilizar.id);
      return { data: limpieza.reutilizar, error: null, reutilizado: true };
    }

    const body = {
      payer_email: email,
      reason: 'Suscripcion Mensual - Club de Lectura',
      external_reference: usuarioId,
      back_url: `${FRONTEND_URL}/dashboard.html?payment=success`,
      // Suscripcion "sin plan asociado / con pago pendiente": el pagador define
      // el metodo de pago en el checkout. La documentacion exige status pending.
      status: 'pending',
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

    const registrado = await registrarPreapprovalPendiente(usuarioId, response.body);

    if (!registrado) {
      // Sin registro en la BD el siguiente clic no podria reutilizarlo y crearia
      // un preapproval identico (el escenario que dispara el rechazo antifraude),
      // asi que se cancela de inmediato y se falla de forma explicita.
      try {
        await mercadopago.preapproval.update({
          id: String(response.body.id),
          status: 'cancelled',
        });
        console.warn('[MP] Preapproval', response.body.id,
          'cancelado porque no se pudo registrar en la BD');
      } catch (errorCancelar) {
        console.error('[MP] No se pudo cancelar el preapproval', response.body.id,
          ':', errorCancelar.message);
      }
      return { data: null, error: new Error('No se pudo registrar el pago') };
    }

    return { data: response.body, error: null, reutilizado: false };

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

// MP no emite 'subscription_created' ni 'subscription_cancelled': segun su tabla
// de eventos, el aviso real de vinculacion/actualizacion de una suscripcion es
// 'subscription_preapproval' (y el de cada cobro recurrente es
// 'subscription_authorized_payment'). Sin manejarlo, cuando el pagador definia el
// metodo de pago en el checkout la fila se quedaba en 'pending' para siempre.
export async function procesarWebhookSuscripcionPreapproval(webhookData) {
  const preapprovalId = webhookData.data?.id;
  if (!preapprovalId) {
    throw new Error('No se encontro id de preapproval en webhook');
  }

  const { preapproval, usuarioId } = await vincularPreapprovalConUsuario(preapprovalId);
  const estadoMP = preapproval.status;

  const { data: fila } = await supabaseClient
    .from('suscriptions')
    .select('sub_id, status, end_date')
    .eq('mp_sub_id', String(preapprovalId))
    .maybeSingle();

  // El pagador todavia no termino el checkout: no hay nada que sincronizar.
  if (estadoMP === 'pending') {
    return { data: { processed: true, estado_mp: estadoMP }, error: null };
  }

  if (estadoMP === 'cancelled' || estadoMP === 'paused') {
    if (fila) {
      await supabaseClient
        .from('suscriptions')
        .update({ status: estadoMP })
        .eq('sub_id', fila.sub_id);
    }
    console.log('[MP] Suscripcion', preapprovalId, '->', estadoMP, 'en la BD');
    return { data: { processed: true, estado_mp: estadoMP }, error: null };
  }

  if (estadoMP !== 'authorized') {
    return { data: { processed: false, estado_mp: estadoMP }, error: null };
  }

  const inicioMP = preapproval.auto_recurring?.start_date
    ? interpretarFechaUtc(preapproval.auto_recurring.start_date)
    : new Date();

  const { data: prueba } = await supabaseClient
    .from('suscriptions')
    .select('sub_id')
    .eq('user_id', usuarioId)
    .eq('plan', 'gratis')
    .eq('status', 'active')
    .gte('end_date', new Date().toISOString())
    .maybeSingle();

  // Con la prueba vigente y el primer cobro agendado, la fila queda 'pending'
  // (el acceso lo da el trial) y solo se refrescan las fechas. Sin trial, o con
  // el cobro ya vencido, el pagador es suscriptor: 'active'.
  let status = prueba && inicioMP.getTime() > Date.now() ? 'pending' : 'active';

  // Un reenvio nunca le quita el acceso ya otorgado.
  if (fila?.status === 'active') status = 'active';

  const fin = calcularFinSuscripcion(inicioMP);
  if (fila?.end_date && new Date(fila.end_date).getTime() > fin.getTime()) {
    fin.setTime(new Date(fila.end_date).getTime());
  }

  const patch = {
    plan: 'mensual',
    status,
    init_date: inicioMP.toISOString(),
    end_date: fin.toISOString(),
    price: preapproval.auto_recurring?.transaction_amount ?? 80.0,
  };

  if (fila) {
    await supabaseClient
      .from('suscriptions')
      .update(patch)
      .eq('sub_id', fila.sub_id);
  } else {
    await supabaseClient
      .from('suscriptions')
      .insert({ ...patch, user_id: usuarioId, mp_sub_id: String(preapprovalId) });
  }

  if (status === 'active') {
    await supabaseClient
      .from('users')
      .update({ role: 'suscriptor' })
      .eq('id', usuarioId);
  }

  console.log('[MP] Preapproval', preapprovalId, 'authorized -> fila', status, 'para', usuarioId);
  return { data: { processed: true, estado_mp: estadoMP, status }, error: null };
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
  //    procesarWebhookSuscripcionPreapproval).
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
