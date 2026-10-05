import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { configurarHttp, responderErrorHttp, validarConfiguracionPagos } from '../middleware/configurar-http.js';
import { crearEntorno } from './helpers/entorno-pagos.js';

async function iniciar(t) {
  const e = await crearEntorno(); const app = express();
  configurarHttp(app, { FRONTEND_URL: 'https://frontend.example.invalid' }, { maxSolicitudes: 2, maxWebhooks: 4 });
  app.get('/api/health', (req,res)=>res.json({ success:true }));
  app.use('/api/pagos',e.rutas); app.use(responderErrorHttp);
  const server = app.listen(0,'127.0.0.1');
  await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  t.after(()=>new Promise((resolve)=>server.close(resolve)));
  return (ruta,opciones={})=>fetch(`http://127.0.0.1:${server.address().port}${ruta}`, {...opciones,signal:AbortSignal.timeout(5000)});
}

test('configuracion de produccion exige secreto y origen HTTPS sin filtrar valores', () => {
  const env={NODE_ENV:'production',SUPABASE_URL:'https://bd.example.invalid',SUPABASE_SERVICE_KEY:'ficticio',
    MERCADOPAGO_ACCESS_TOKEN:'ficticio',MERCADOPAGO_WEBHOOK_SECRET:'ficticio',FRONTEND_URL:'https://frontend.example.invalid'};
  assert.doesNotThrow(()=>validarConfiguracionPagos(env));
  assert.throws(()=>validarConfiguracionPagos({...env,MERCADOPAGO_WEBHOOK_SECRET:''}),/MERCADOPAGO_WEBHOOK_SECRET/);
  assert.throws(()=>validarConfiguracionPagos({...env,FRONTEND_URL:'http://frontend.example.invalid'}),/HTTPS/);
  assert.throws(()=>validarConfiguracionPagos({...env,MERCADOPAGO_MODE:'otro'}),/MODE/);
  assert.throws(()=>validarConfiguracionPagos({...env,FRONTEND_URL:'valor-privado'}),(error)=>
    error.message === 'Origen invalido en la configuracion de produccion' && !Object.hasOwn(error,'input'));
});

test('HTTP de despliegue limita navegacion y webhooks por separado sin saltarse firma', async (t) => {
  const get=await iniciar(t);
  assert.equal((await get('/api/health')).status,200);
  assert.equal((await get('/api/health')).status,200);
  assert.equal((await get('/api/health')).status,429);
  for (const ruta of ['/api/pagos/webhook','/api/pagos/webhook/','/api/PAGOS/WEBHOOK','/api/pagos/webhook']) {
    const r=await get(ruta,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'payment',data:{id:'1234'}})});
    assert.equal(r.status,401);
  }
  assert.equal((await get('/api/pagos/webhook',{method:'POST'})).status,429);
});

test('CORS, preflight, headers y JSON invalido usan configuracion real del servidor', async (t) => {
  const get=await iniciar(t);
  const permitido=await get('/api/health',{headers:{Origin:'https://frontend.example.invalid'}});
  assert.equal(permitido.headers.get('access-control-allow-origin'),'https://frontend.example.invalid');
  assert.equal(permitido.headers.get('x-content-type-options'),'nosniff');
  const ajeno=await get('/api/health',{headers:{Origin:'https://ajeno.example.invalid'}});
  assert.equal(ajeno.headers.get('access-control-allow-origin'),null);
  assert.equal((await get('/api/pagos/suscripcion',{method:'OPTIONS',headers:{Origin:'https://frontend.example.invalid','Access-Control-Request-Method':'POST'}})).status,204);
  const roto=await get('/api/pagos/webhook',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'});
  assert.equal(roto.status,400); assert.deepEqual(await roto.json(),{success:false,error:'JSON invalido'});
});
