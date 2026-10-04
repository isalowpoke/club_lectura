import { readFile } from 'node:fs/promises';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import express from 'express';
import { prepararBD, sembrar, ejecutarRPC } from './bd-pagos.js';

const USUARIO = '11111111-1111-4111-8111-111111111111';

export async function crearEntorno() {
  const db = await prepararBD();
  const estado = {
    payment: { id: 1234, external_reference: USUARIO, status: 'approved',
      transaction_amount: 80, currency_id: 'MXN', live_mode: true,
      collector_id: 42, date_approved: '2026-10-03T00:00:00Z',
      date_created: '2026-10-03T00:00:00Z', date_last_updated: '2026-10-03T00:00:00Z' },
    factura: { id: 7890, preapproval_id: 'abc123', external_reference: USUARIO,
      currency_id: 'MXN', transaction_amount: '80.00', status: 'processed',
      debit_date: '2026-10-03T00:00:00Z', payment: { id: 1234 } },
    preapproval: { id: 'abc123', external_reference: USUARIO, collector_id: 42,
      status: 'pending', last_modified: '2026-10-03T00:00:00Z', init_point: 'https://www.mercadopago.com.mx/checkout',
      auto_recurring: { start_date: '2026-10-03T00:00:00Z', frequency: 1, frequency_type: 'months',
        currency_id: 'MXN', transaction_amount: 80 } },
    tablas: { suscriptions: [{ sub_id: '22222222-2222-4222-8222-222222222222', user_id: USUARIO, plan: 'mensual',
      mp_sub_id: 'abc123', price: 80, status: 'pending', init_date: null, end_date: null }],
      pagos: [], users: [{ id: USUARIO, role: 'free' }] },
    escrituras: [], consultasMP: [], errorBD: null, errorMP: false, errorRPC: null, altas: [], cancelaciones: [], preferencias: [],
    cuenta: { id: 42 }, resultados: null, total: null,
    env: { MERCADOPAGO_WEBHOOK_SECRET: 'secreto-ficticio', MERCADOPAGO_MODE: 'production' },
  };
  const clonar = (valor) => structuredClone(valor);
  let siembra;
  const asegurarSiembra = () => siembra ||= sembrar(db, estado.tablas);
  const supabaseClient = { auth: { async getUser(token) {
    return token === 'jwt-ficticio' ? { data: { user: { id: USUARIO, email: 'prueba@example.invalid' } }, error: null }
      : { data: { user: null }, error: new Error('JWT no valido') };
  } }, async rpc(nombre, parametros) {
    try {
      await asegurarSiembra();
      if (estado.errorRPC === nombre || (nombre === 'aplicar_pago_verificado' && ['pagos','suscriptions'].includes(estado.errorBD?.tabla))) {
        throw new Error('Fallo de persistencia simulado');
      }
      const data = await ejecutarRPC(db, nombre, parametros);
      if (nombre !== 'estado_acceso_pagos') estado.escrituras.push({ tabla: nombre, operacion: 'rpc', valores: clonar(parametros) });
      for (const tabla of ['users','suscriptions','pagos','extra_sessions','compras_extras','pagos_verificados','reservas_cobros','vinculos_pagos_extras','conciliaciones_pagos']) {
        estado.tablas[tabla] = (await db.query(`select to_jsonb(fila) as datos from ${tabla} fila`)).rows.map((r) => r.datos);
      }
      return { data, error: null };
    } catch (error) { return { data: null, error }; }
  }, from(tabla) {
    let operacion = 'select'; let valores; let unico = false; let limite; let seleccion = '*'; let orden;
    const filtros = [];
    const igualdades = {};
    const consulta = {
      select(campos = '*') { seleccion = campos; return this; },
      order(campo, opciones) { orden = { campo, ...opciones }; return this; },
      eq(campo, valor) { igualdades[campo] = valor; filtros.push((fila) => fila[campo] === valor); return this; },
      gt(campo, valor) { filtros.push((fila) => fila[campo] > valor); return this; },
      neq(campo, valor) { filtros.push((fila) => fila[campo] !== valor); return this; },
      gte(campo, valor) { filtros.push((fila) => fila[campo] >= valor); return this; },
      limit(valor) { limite = valor; return this; },
      maybeSingle() { unico = true; return this; },
      update(valor) { operacion = 'update'; valores = valor; return this; },
      insert(valor) { operacion = 'insert'; valores = valor; return this; },
      upsert(valor) { operacion = 'upsert'; valores = valor; return this; },
      then(resolve, reject) {
        try {
          if (estado.errorBD?.tabla === tabla && estado.errorBD.operacion === operacion &&
              (!estado.errorBD.plan || estado.errorBD.plan === igualdades.plan)) {
            return Promise.resolve({ data: null, error: { message: 'Fallo BD simulado' } }).then(resolve, reject);
          }
          const filas = estado.tablas[tabla] || [];
          let elegidas = filas.filter((fila) => filtros.every((filtro) => filtro(fila)));
          if (orden) elegidas.sort((x, y) => String(x[orden.campo]).localeCompare(String(y[orden.campo])) * (orden.ascending === false ? -1 : 1));
          if (limite) elegidas = elegidas.slice(0, limite);
          if (unico && elegidas.length > 1) {
            return Promise.resolve({ data: null, error: { code: 'PGRST116' } }).then(resolve, reject);
          }
          if (operacion !== 'select') {
            estado.escrituras.push({ tabla, operacion, valores: clonar(valores) });
            if (operacion === 'update') elegidas.forEach((fila) => Object.assign(fila, valores));
            if (operacion === 'insert') filas.push(clonar(valores));
            if (operacion === 'upsert') {
              const previa = filas.find((fila) => fila.mp_payment_id === valores.mp_payment_id);
              if (previa) Object.assign(previa, valores);
              else filas.push(clonar(valores));
            }
          }
          if (seleccion !== '*') elegidas = elegidas.map((fila) => Object.fromEntries(seleccion.split(',').map((campo) => {
            const clave = campo.trim(); return [clave, fila[clave]];
          })));
          return Promise.resolve({ data: clonar(unico ? elegidas[0] || null : elegidas), error: null }).then(resolve, reject);
        } catch (error) { return Promise.reject(error).then(resolve, reject); }
      },
    };
    return consulta;
  } };
  const context = createContext({ console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout,
    process: { env: estado.env }, URL, AbortSignal, Buffer,
    fetch: async (url) => {
      estado.consultasMP.push(url);
      if (estado.errorMP) return { ok: false, status: 503 };
      let data;
      const ruta = new URL(url);
      if (ruta.pathname === '/authorized_payments/search') {
        if (ruta.searchParams.get('payment_id') !== String(estado.payment.id)) throw new Error('Filtro incorrecto');
        const results = estado.resultados ?? [estado.factura];
        data = { results, paging: { total: estado.total ?? results.length } };
      } else if (ruta.pathname === '/authorized_payments/7890') data = estado.factura;
      else if (ruta.pathname === '/users/me') data = estado.cuenta;
      else throw new Error(`Red no simulada: ${ruta.pathname}`);
      return { ok: true, json: async () => clonar(data) };
    },
  });
  const sdk = { configure() {}, getPayment: async () => {
    if (estado.errorMP) throw new Error('MP no disponible');
    return { body: clonar(estado.payment) };
  }, preapproval: { get: async (id) => {
    estado.consultasMP.push(`preapproval/${id}`);
    return { body: clonar(estado.preapproval) };
  }, create: async (body) => {
    estado.altas.push(clonar(body));
    if (estado.errorAlta) throw new Error('Respuesta perdida');
    return { body: { ...clonar(estado.preapproval), ...clonar(body), last_modified: '2026-10-03T00:00:00Z' } };
  }, cancel: async (id) => {
    estado.cancelaciones.push(id);
    if (!estado.errorCancelar) estado.preapproval.status = 'cancelled';
    if (estado.errorCancelar || estado.cancelarConErrorDespues) throw new Error('Fallo al cancelar');
    return { body: clonar(estado.preapproval) };
  } }, createPreference: async (body) => {
    estado.preferencias.push(clonar(body));
    return { body: { id: `pref-${estado.preferencias.length}`, init_point: 'https://www.mercadopago.com.mx/checkout' } };
  } };
  const mocks = new Map([
    ['mercadopago', {
      MercadoPagoConfig: class {},
      Payment: class { async get({ id }) { return (await sdk.getPayment(id)).body; } },
      PreApproval: class {
        async get({ id }) { return (await sdk.preapproval.get(id)).body; }
        async create({ body }) { return (await sdk.preapproval.create(body)).body; }
        async update({ id, body }) {
          if (body.status !== 'cancelled') throw new Error('Actualizacion no simulada');
          return (await sdk.preapproval.cancel(id)).body;
        }
      },
      Preference: class { async create({ body }) { return (await sdk.createPreference(body)).body; } },
    }], ['dotenv', { default: { config() {} } }],
    ['express', { default: express }],
    ['supabase.js', { supabaseClient }],
  ]);
  const cache = new Map();
  async function cargar(specifier, padre = new URL('../../services/mercadopago.js', import.meta.url).href) {
    const claveMock = mocks.has(specifier) ? specifier : specifier.split('/').at(-1);
    if (mocks.has(claveMock) || specifier.startsWith('node:')) {
      const exports = mocks.get(claveMock) || await import(specifier);
      return new SyntheticModule(Object.keys(exports), function () {
        for (const [nombre, valor] of Object.entries(exports)) this.setExport(nombre, valor);
      }, { context });
    }
    const url = new URL(specifier, padre);
    if (cache.has(url.href)) return cache.get(url.href);
    const modulo = new SourceTextModule(await readFile(url, 'utf8'), {
      context, identifier: url.href, initializeImportMeta(meta) { meta.url = url.href; },
    });
    cache.set(url.href, modulo);
    await modulo.link((nombre, referencia) => cargar(nombre, referencia.identifier));
    return modulo;
  }
  const servicio = await cargar(new URL('../../services/mercadopago.js', import.meta.url).href);
  await servicio.evaluate();
  const rutas = await cargar(new URL('../../routes/pagos.js', import.meta.url).href);
  await rutas.evaluate();
  const handler = rutas.namespace.default.stack.find((capa) => capa.route?.path === '/webhook').route.stack[0].handle;
  return { estado, servicio: servicio.namespace, handler, db, asegurarSiembra, supabaseClient,
    acceso: async (ahora) => { await asegurarSiembra(); return ejecutarRPC(db, 'estado_acceso_pagos', { p_usuario: USUARIO, ...(ahora ? { p_ahora: ahora } : {}) }); },
    rutas: rutas.namespace.default };
}
