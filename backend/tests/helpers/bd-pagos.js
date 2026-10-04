import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { after } from 'node:test';

import { esquemaBase } from './esquema-pagos.js';
let preparada;
after(async () => { if (preparada) await (await preparada).close(); });
export async function prepararBD() {
  preparada ||= (async () => {
    const db = new PGlite();
    await db.exec(esquemaBase);
    await db.exec(await readFile(new URL('../../../supabase/migrations/20261003180231_pagos_reservas_y_periodos.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../../../supabase/migrations/20261004165326_conciliacion_pagos.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../../../supabase/migrations/20261004181909_metadata_minima_pagos.sql', import.meta.url), 'utf8'));
    return db;
  })();
  const db = await preparada;
  await db.exec('truncate users, sessions, suscriptions, pagos, extra_sessions, reservas_cobros, compras_extras, pagos_verificados cascade');
  return db;
}

export async function sembrar(db, tablas) {
  for (const nombre of ['users', 'sessions', 'suscriptions', 'compras_extras', 'pagos', 'extra_sessions']) {
    for (const fila of tablas[nombre] || []) {
      const campos = Object.keys(fila);
      await db.query(`insert into ${nombre} (${campos.join(',')}) values (${campos.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(fila));
    }
  }
}

export async function ejecutarRPC(db, nombre, parametros) {
  if (!/^[a-z_]+$/.test(nombre) || !Object.keys(parametros).every((p) => /^p_[a-z_]+$/.test(p))) throw new Error('RPC no valido');
  const campos = Object.keys(parametros);
  const { rows } = await db.query(`select public.${nombre}(${campos.map((p, i) => `${p} => $${i + 1}`).join(',')}) as data`,
    Object.values(parametros).map((v) => v && typeof v === 'object' ? JSON.stringify(v) : v));
  return rows[0].data;
}
