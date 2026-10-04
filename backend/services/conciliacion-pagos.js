import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validarIdRecurso, validarPagoSuscripcion, validarPagoExtra } from './validar-pago-suscripcion.js';
import { fechaProveedor, desfaseProveedor, periodoFacturado } from './periodos-pago.js';

// Dependencias inyectadas: diagnosticar nunca llama a procesadores ni escribe BD.
// Las respuestas MP completas viven solo en memoria; el plan contiene evidencia minima.
export async function buscarTodasMP(consultar, ruta, parametros = {}) {
  const filas = []; const ids = new Set(); let total;
  for (let pagina = 0; pagina < 100; pagina += 1) {
    const query = new URLSearchParams({ ...parametros, limit: '100', offset: String(filas.length) });
    const respuesta = await consultar(`${ruta}?${query}`);
    const lote = respuesta.results ?? respuesta.elements;
    const cantidad = respuesta.paging?.total ?? respuesta.total;
    if (!Array.isArray(lote) || !Number.isSafeInteger(cantidad) || cantidad < 0 ||
        (total !== undefined && cantidad !== total)) throw new Error('Busqueda MP incompleta o cambiante');
    total = cantidad;
    for (const fila of lote) {
      const id = validarIdRecurso(fila.id);
      if (ids.has(id)) throw new Error('Paginacion MP repetida');
      ids.add(id); filas.push(fila);
    }
    if (filas.length === total) return filas;
    if (!lote.length || filas.length > total) throw new Error('Paginacion MP incompleta');
  }
  throw new Error('Limite de paginacion MP; no asumir ausencia');
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const exigir = (condicion, mensaje) => { if (!condicion) throw new Error(mensaje); };
const acuerdoMinimo = (pre) => ({ id: validarIdRecurso(pre.id), status: pre.status,
  last_modified: fechaProveedor(pre.last_modified), start_date: fechaProveedor(pre.auto_recurring?.start_date),
  offset_minutes: desfaseProveedor(pre.auto_recurring.start_date),
  next_payment_date: pre.next_payment_date ? fechaProveedor(pre.next_payment_date) : null });

export function crearConciliador({ bd, consultarMP, procesarPago, procesarAcuerdo, modo = 'production' }) {
  exigir(['production', 'test'].includes(modo), 'Modo MP invalido');
  const consultarId = async (ruta, id) => {
    const esperado = validarIdRecurso(id);
    const dato = await consultarMP(`${ruta}/${encodeURIComponent(esperado)}`);
    exigir(validarIdRecurso(dato.id) === esperado, 'ID remoto discrepante');
    return dato;
  };
  const rpc = async (nombre, args) => {
    const { data, error } = await bd.rpc(nombre, args);
    if (error) throw new Error(`No se pudo ejecutar ${nombre}; revisar estado y reintentar`);
    return data;
  };
  async function listar(tabla, clave, campos) {
    const filas = []; let cursor;
    for (let pagina = 0; pagina < 100; pagina += 1) {
      let q = bd.from(tabla).select(campos).order(clave, { ascending: true }).limit(100);
      if (cursor !== undefined) q = q.gt(clave, cursor);
      const { data, error } = await q;
      if (error || !Array.isArray(data)) throw new Error(`Inventario incompleto: ${tabla}`);
      filas.push(...data);
      if (data.length < 100) return filas;
      const siguiente = data.at(-1)[clave];
      exigir(siguiente !== cursor, 'Cursor de inventario repetido'); cursor = siguiente;
    }
    throw new Error('Inventario excede limite; dividir la operacion');
  }
  async function usuarios() {
    const conjuntos = await Promise.all([
      listar('suscriptions','sub_id','sub_id,user_id'), listar('reservas_cobros','user_id','user_id'),
      listar('compras_extras','id','id,user_id'), listar('pagos','id','id,user_id'),
      listar('extra_sessions','id','id,user_id'),
    ]);
    const ids = [...new Set(conjuntos.flat().map((r) => r.user_id))].sort();
    exigir(ids.every((id) => UUID.test(id)), 'Inventario con usuario no verificable'); return ids;
  }
  function verificarAcuerdo(pre, usuario, cuenta, importe = 80) {
    exigir(pre.external_reference === usuario && String(pre.collector_id) === String(cuenta.id), 'Acuerdo ajeno');
    exigir(['pending','authorized','paused','cancelled'].includes(pre.status), 'Estado de acuerdo invalido');
    const r = pre.auto_recurring;
    exigir(r?.frequency === 1 && r.frequency_type === 'months' && r.currency_id === 'MXN' &&
      Number(r.transaction_amount) === Number(importe), 'Condiciones de acuerdo discrepantes');
    if (pre.live_mode != null) exigir(pre.live_mode === (modo === 'production'), 'Ambiente de acuerdo discrepante');
    return acuerdoMinimo(pre);
  }
  async function proponer(usuario, snapshot, cuenta) {
    // Una reparacion por usuario por plan. La siguiente se diagnostica contra
    // un snapshot nuevo, evitando aplicar en cadena precondiciones obsoletas.
    for (const fila of snapshot.suscripciones) {
      if (fila.plan !== 'mensual' || !/^\d+$/.test(fila.mp_sub_id || '')) continue;
      const payment = await consultarId('/v1/payments', fila.mp_sub_id);
      const facturas = await buscarTodasMP(consultarMP, '/authorized_payments/search', { payment_id: String(payment.id) });
      exigir(facturas.length === 1, 'Factura ausente o ambigua');
      const factura = facturas[0]; const pre = await consultarId('/preapproval', factura.preapproval_id);
      const candidata = { ...fila, mp_sub_id: validarIdRecurso(pre.id) };
      validarPagoSuscripcion({ payment, factura, preapproval: pre, fila: candidata, cobradorId: cuenta.id, modo });
      verificarAcuerdo(pre, usuario, cuenta, fila.price); periodoFacturado(factura, pre, candidata);
      const destino = snapshot.suscripciones.find((s) => s.mp_sub_id === candidata.mp_sub_id);
      exigir(!destino || (destino.plan === 'mensual' && Number(destino.price) === Number(fila.price)), 'Destino historico ambiguo');
      return { datos: { tipo: 'vinculo_mensual', sub_id: fila.sub_id, payment_id: String(payment.id), mp_sub_id: candidata.mp_sub_id },
        evidencia: { payment_id: String(payment.id), factura_id: String(factura.id),
          estado: payment.status, payment_updated_at: fechaProveedor(payment.date_last_updated),
          acuerdo_updated_at: fechaProveedor(pre.last_modified) } };
    }
    if (snapshot.reserva?.estado === 'enviando') {
      const todos = await buscarTodasMP(consultarMP, '/preapproval/search');
      const inicio = Date.parse(snapshot.reserva.updated_at);
      exigir(Number.isFinite(inicio), 'Reserva sin fecha verificable');
      const propios = todos.filter((p) => p.external_reference === usuario);
      const candidatos = propios.filter((p) => Date.parse(p.date_created) >= inicio);
      exigir(candidatos.length === 1, 'Alta incierta sin candidato unico; conservar reserva');
      const pre = await consultarId('/preapproval', candidatos[0].id);
      exigir(Date.parse(pre.date_created) >= inicio, 'Fecha del acuerdo discrepante');
      const acuerdo = verificarAcuerdo(pre, usuario, cuenta);
      exigir(!propios.some((p) => String(p.id) !== String(pre.id) && p.status !== 'cancelled'), 'Otros acuerdos activos; revision manual');
      return { datos: { tipo: 'alta_incierta', token: snapshot.reserva.token, acuerdo },
        evidencia: { acuerdo_id: acuerdo.id, acuerdo_updated_at: acuerdo.last_modified } };
    }
    for (const compra of snapshot.compras) {
      if (compra.preference_id || !['creando','incierta'].includes(compra.estado)) continue;
      const referencias = await buscarTodasMP(consultarMP, '/checkout/preferences/search', { external_reference: `extra:${compra.id}` });
      exigir(referencias.length === 1, 'Preferencia ausente o ambigua; conservar pedido');
      const pre = await consultarId('/checkout/preferences', referencias[0].id);
      exigir(pre.external_reference === `extra:${compra.id}` && String(pre.collector_id) === String(cuenta.id), 'Preferencia ajena');
      exigir(Array.isArray(pre.items) && pre.items.length === 1 && pre.items[0].quantity === 1 &&
        pre.items[0].currency_id === compra.moneda && Number(pre.items[0].unit_price) === Number(compra.monto), 'Importe de preferencia discrepante');
      const url = new URL(pre.init_point);
      exigir(url.protocol === 'https:' && /(^|\.)mercadopago\.com\.mx$/.test(url.hostname), 'Checkout inesperado');
      return { datos: { tipo: 'preferencia_incierta', compra_id: compra.id, preference_id: String(pre.id), init_point: pre.init_point },
        evidencia: { preference_id: String(pre.id), created_at: fechaProveedor(pre.date_created) } };
    }
    for (const extra of snapshot.extras) {
      if (!extra.mp_pay_id || snapshot.vinculos.some((v) => v.mp_payment_id === extra.mp_pay_id) ||
          snapshot.verificados.some((p) => p.mp_payment_id === extra.mp_pay_id)) continue;
      const payment = await consultarId('/v1/payments', extra.mp_pay_id);
      if (payment.external_reference?.startsWith('extra:')) continue;
      exigir(Number.isSafeInteger(extra.session_id) && extra.session_id > 0, 'Sesion historica no verificable');
      const referencia = `${usuario}:${extra.session_id}`;
      exigir(payment.external_reference === referencia, 'Referencia historica extra discrepante');
      const compra = { id: 'historica', monto: extra.price, moneda: 'MXN', legacy_external_reference: referencia };
      validarPagoExtra({ payment, compra, cobradorId: cuenta.id, modo, referenciaHistorica: referencia });
      return { datos: { tipo: 'extra_historico', extra_id: extra.id, payment_id: String(payment.id),
        session_id: extra.session_id, monto: Number(extra.price), referencia },
        evidencia: { payment_id: String(payment.id), estado: payment.status, updated_at: fechaProveedor(payment.date_last_updated) } };
    }
    return null;
  }
  async function diagnosticar() {
    const cuenta = await consultarMP('/users/me'); exigir(cuenta.id != null, 'Cuenta MP no verificable');
    const resultado = { version: 1, modo, collector_id: String(cuenta.id), generado_at: new Date().toISOString(), acciones: [], pendientes: [], pagos_por_verificar: [] };
    for (const usuario of await usuarios()) {
      const snapshot = await rpc('snapshot_conciliacion', { p_usuario: usuario });
      const conocidos = new Set([...snapshot.pagos.map((p) => p.mp_payment_id), ...snapshot.extras.map((e) => e.mp_pay_id)].filter(Boolean));
      for (const id of conocidos) if (!snapshot.verificados.some((p) => p.mp_payment_id === id)) {
        resultado.pagos_por_verificar.push({ usuario, payment_id: id });
      }
      for (const extra of snapshot.extras) if (!extra.mp_pay_id) {
        resultado.pendientes.push({ usuario, extra_id: extra.id, motivo: 'Compra historica sin payment ID; requiere evidencia adicional' });
      }
      try {
        const propuesta = await proponer(usuario, snapshot, cuenta);
        if (propuesta) resultado.acciones.push({ id: randomUUID(), usuario, esperado: snapshot, ...propuesta });
        else if (snapshot.suscripciones.some((s) => s.plan === 'mensual' && s.status === 'active' &&
            !snapshot.verificados.some((p) => p.sub_id === s.sub_id))) {
          resultado.pendientes.push({ usuario, motivo: 'Acceso historico sin pago verificado; conciliar antes del despliegue' });
        }
      } catch (error) {
        // Mensajes propios de validacion. No incluir cuerpos HTTP, emails ni tarjetas.
        resultado.pendientes.push({ usuario, motivo: error.message.startsWith('Consulta MP') ? 'Consulta MP no disponible' : error.message });
      }
    }
    return resultado;
  }
  async function aplicar(plan, accion, respaldoSha256) {
    exigir(plan.version === 1 && plan.modo === modo && plan.acciones.some((a) => a.id === accion.id), 'Plan invalido');
    exigir(UUID.test(accion.id) && UUID.test(accion.usuario), 'Identificador de plan invalido');
    const cuenta = await consultarMP('/users/me');
    exigir(String(cuenta.id) === plan.collector_id, 'Cuenta MP cambio');
    const { data: previa, error: errorPrevia } = await bd.from('conciliaciones_pagos')
      .select('id,user_id,solicitud,estado').eq('id', accion.id).maybeSingle();
    exigir(!errorPrevia, 'No se pudo verificar operacion previa');
    if (previa) {
      exigir(previa.user_id === accion.usuario && previa.estado === 'aplicada' &&
        isDeepStrictEqual(previa.solicitud, { ...accion.datos, evidencia: accion.evidencia }), 'Operacion reutilizada o revertida');
      return { id: accion.id, repetida: true };
    }
    const actual = await rpc('snapshot_conciliacion', { p_usuario: accion.usuario });
    exigir(isDeepStrictEqual(actual, accion.esperado), 'Plan obsoleto; generar otro diagnostico');
    const fresco = await proponer(accion.usuario, actual, cuenta);
    exigir(fresco && isDeepStrictEqual(fresco.datos, accion.datos) && isDeepStrictEqual(fresco.evidencia, accion.evidencia), 'Evidencia MP cambio; generar otro diagnostico');
    return rpc('aplicar_conciliacion', { p_id: accion.id, p_usuario: accion.usuario, p_esperado: actual,
      p_datos: { ...fresco.datos, evidencia: fresco.evidencia }, p_respaldo: respaldoSha256 });
  }
  async function sincronizar({ aplicar: escribir = false } = {}) {
    const pagos = new Set(); const acuerdos = new Set(); const fallos = [];
    for (const usuario of await usuarios()) {
      const s = await rpc('snapshot_conciliacion', { p_usuario: usuario });
      for (const p of [...s.pagos, ...s.verificados]) if (p.mp_payment_id) pagos.add(validarIdRecurso(p.mp_payment_id));
      for (const p of s.extras) if (p.mp_pay_id) pagos.add(validarIdRecurso(p.mp_pay_id));
      for (const compra of s.compras) {
        const referencia = compra.legacy_external_reference || `extra:${compra.id}`;
        try {
          for (const p of await buscarTodasMP(consultarMP, '/v1/payments/search', { external_reference: referencia })) {
            exigir(p.external_reference === referencia, 'Resultado extra ajeno'); pagos.add(validarIdRecurso(p.id));
          }
        } catch { fallos.push({ tipo: 'busqueda_extra', id: compra.id }); }
      }
      for (const sub of s.suscripciones) {
        if (sub.plan !== 'mensual' || !sub.mp_sub_id || /^\d+$/.test(sub.mp_sub_id)) continue;
        acuerdos.add(sub.mp_sub_id);
        try {
          for (const factura of await buscarTodasMP(consultarMP, '/authorized_payments/search', { preapproval_id: sub.mp_sub_id })) {
            exigir(factura.preapproval_id === sub.mp_sub_id, 'Factura ajena');
            if (factura.payment?.id) pagos.add(validarIdRecurso(factura.payment.id));
          }
        } catch { fallos.push({ tipo: 'busqueda_facturas', id: sub.mp_sub_id }); }
      }
    }
    let procesados = 0;
    if (escribir) {
      for (const [tipo, ids, handler] of [['acuerdo',acuerdos,procesarAcuerdo],['pago',pagos,procesarPago]]) {
        for (const id of ids) {
          try {
            const r = await handler({ data: { id } });
            if (r?.error) throw r.error;
            procesados += 1;
          } catch { fallos.push({ tipo, id }); }
        }
      }
    }
    return { simulacion: !escribir, pagos: [...pagos], acuerdos: [...acuerdos], procesados, fallos };
  }
  return { diagnosticar, aplicar, sincronizar,
    limpiarMetadata: ({ limite = 100, aplicar: escribir = false } = {}) => rpc('limpiar_metadata_pagos', { p_limite: limite, p_aplicar: escribir }),
    revertir: (id) => { exigir(UUID.test(id), 'ID invalido'); return rpc('revertir_conciliacion', { p_id: id }); } };
}
