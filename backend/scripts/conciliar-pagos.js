import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crearConciliador } from '../services/conciliacion-pagos.js';

const ayuda = `Conciliacion de pagos (diagnostico por defecto; sin cobros remotos).
  diagnosticar
  aplicar --plan archivo.json --id UUID --respaldo respaldo.dump
  revertir --id UUID
  sincronizar [--aplicar]
  metadata [--limite 100] [--aplicar]
Escrituras requieren CONCILIACION_HABILITADA=true en el backend.
Los informes se guardan en backend/logs/conciliacion (ignorado por Git).
El respaldo debe haberse restaurado y verificado en un ambiente aislado.
El hash registra el archivo utilizado; no demuestra por si solo su restauracion.
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { process.stdout.write(ayuda); return; }
  const comando = args.shift() || 'diagnosticar';
  if (!['diagnosticar','aplicar','revertir','sincronizar','metadata'].includes(comando)) throw new Error('Comando invalido; usar --help');
  const opciones = {};
  while (args.length) {
    const clave = args.shift();
    if (!['--plan','--id','--respaldo','--aplicar','--limite'].includes(clave) || Object.hasOwn(opciones, clave)) throw new Error('Argumentos invalidos');
    opciones[clave] = clave === '--aplicar' ? true : args.shift();
    if (!opciones[clave] || (typeof opciones[clave] === 'string' && opciones[clave].startsWith('--'))) throw new Error('Falta valor de argumento');
  }
  const permitidas = { diagnosticar: [], aplicar: ['--plan','--id','--respaldo'], revertir: ['--id'], sincronizar: ['--aplicar'], metadata: ['--limite','--aplicar'] }[comando];
  if (Object.keys(opciones).some((c) => !permitidas.includes(c))) throw new Error('Opcion incompatible con el comando');
  if (comando === 'aplicar' && permitidas.some((c) => !opciones[c])) throw new Error('Aplicar requiere plan, id y respaldo');
  if (comando === 'revertir' && !opciones['--id']) throw new Error('Revertir requiere id');
  const { supabaseClient } = await import('../services/supabase.js');
  const mp = await import('../services/mercadopago.js');
  const escribir = ['aplicar','revertir'].includes(comando) || opciones['--aplicar'];
  if (escribir && process.env.CONCILIACION_HABILITADA !== 'true') throw new Error('Conciliacion de escritura deshabilitada');
  const conciliador = crearConciliador({ bd: supabaseClient, consultarMP: mp.consultarMercadoPago,
    procesarPago: mp.procesarWebhookMercadoPago, procesarAcuerdo: mp.procesarWebhookSuscripcionPreapproval,
    modo: process.env.MERCADOPAGO_MODE || 'production' });
  let resultado;
  if (comando === 'diagnosticar') resultado = await conciliador.diagnosticar();
  if (comando === 'sincronizar') resultado = await conciliador.sincronizar({ aplicar: !!opciones['--aplicar'] });
  if (comando === 'metadata') resultado = await conciliador.limpiarMetadata({ limite: Number(opciones['--limite'] || 100), aplicar: !!opciones['--aplicar'] });
  if (comando === 'revertir') resultado = { revertida: await conciliador.revertir(opciones['--id']) };
  if (comando === 'aplicar') {
    const plan = JSON.parse(await readFile(resolve(opciones['--plan']), 'utf8'));
    const accion = plan.acciones?.find((a) => a.id === opciones['--id']);
    if (!accion) throw new Error('Operacion no encontrada en el plan');
    const respaldo = resolve(opciones['--respaldo']);
    const info = await stat(respaldo);
    if (!info.isFile() || info.size === 0) throw new Error('Respaldo vacio o invalido');
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(respaldo)) digest.update(chunk);
    const hash = digest.digest('hex');
    resultado = await conciliador.aplicar(plan, accion, hash);
  }
  const archivo = fileURLToPath(new URL(`../logs/conciliacion/${Date.now()}-${randomUUID()}.json`, import.meta.url));
  await mkdir(dirname(archivo), { recursive: true });
  await writeFile(archivo, JSON.stringify(resultado, null, 2), { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ archivo, propuestas: resultado.acciones?.length,
    pendientes: resultado.pendientes?.length, pagos_por_verificar: resultado.pagos_por_verificar?.length,
    procesados: resultado.procesados, detectados: resultado.detectados, fallos: resultado.fallos?.length }) + '\n');
  if (resultado.fallos?.length || resultado.pendientes?.length) process.exitCode = 2;
  if (comando === 'metadata' && resultado.detectados > resultado.procesados) process.exitCode = 2;
}

try { await main(); }
catch (error) {
  // Errores externos pueden contener cuerpos/tokens: no volcarlos en consola.
  process.stderr.write('Conciliacion incompleta. Verifica argumentos, configuracion, migraciones y vigencia del plan. No se confirma exito.\n');
  process.exitCode = 1;
}
