import EmbeddedPostgres from 'embedded-postgres';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { Client } from 'pg';

// Nunca consume DATABASE_URL ni .env. Cada ejecucion crea su propio cluster.
export async function iniciarPostgres() {
  const temporal = await realpath(tmpdir());
  const directorio = await mkdtemp(join(temporal, 'club-pagos-pg-'));
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const puerto = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const mensajes = [];
  const clave = randomBytes(32).toString('hex');
  const postgres = new EmbeddedPostgres({
    databaseDir: join(directorio, 'data'), port: puerto, user: 'postgres',
    password: clave, authMethod: 'scram-sha-256',
    persistent: true, createPostgresUser: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-h', '127.0.0.1', '-c', 'timezone=UTC', '-c', 'statement_timeout=10000', '-c', 'lock_timeout=7000'],
    onLog: (texto) => { mensajes.push(String(texto)); if (mensajes.length > 30) mensajes.shift(); },
    onError: (texto) => { mensajes.push(String(texto)); },
  });
  const clientes = new Set();
  async function conectar(rol, base = 'postgres') {
    const cliente = new Client({ user: 'postgres', password: clave, host: '127.0.0.1',
      port: puerto, database: base, connectionTimeoutMillis: 5000 });
    await cliente.connect(); clientes.add(cliente);
    if (rol) {
      if (!['service_role', 'anon', 'authenticated'].includes(rol)) throw new Error('Rol de prueba invalido');
      await cliente.query(`set role ${rol}`);
    }
    return cliente;
  }
  async function cerrar() {
    await Promise.allSettled([...clientes].map((c) => c.end()));
    await postgres.stop();
    const resuelto = await realpath(directorio);
    const relativo = relative(temporal, resuelto);
    if (!relativo || relativo.startsWith('..') || isAbsolute(relativo) || !relativo.startsWith('club-pagos-pg-')) {
      throw new Error('Directorio temporal fuera del limite permitido');
    }
    await rm(resuelto, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  try { await postgres.initialise(); await postgres.start(); }
  catch (error) { await cerrar(); throw new Error(`PostgreSQL aislado no pudo iniciar: ${error?.message}. ${mensajes.join('\n')}`); }
  return { conectar, cerrar };
}
