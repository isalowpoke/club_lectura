export function interpretarFechaUtc(valor) {
  if (!valor) return null;
  const texto = String(valor).replace(' ', 'T');
  const fecha = new Date(/(Z|[+-]\d{2}:\d{2})$/i.test(texto) ? texto : `${texto}Z`);
  return Number.isFinite(fecha.getTime()) ? fecha : null;
}

export function fechaProveedor(valor) {
  if (typeof valor !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/i.test(valor)) {
    throw new Error('Fecha del proveedor sin zona horaria');
  }
  const fecha = interpretarFechaUtc(valor);
  if (!fecha) throw new Error('Fecha del proveedor invalida');
  return fecha.toISOString();
}

// Siempre calcular desde el ancla original: 31 enero -> 28 febrero -> 31 marzo.
export function desfaseProveedor(valor) {
  fechaProveedor(valor);
  if (/Z$/i.test(valor)) return 0;
  const partes = valor.match(/([+-])(\d{2}):(\d{2})$/);
  return (partes[1] === '-' ? -1 : 1) * (Number(partes[2]) * 60 + Number(partes[3]));
}

function mesDesdeAncla(ancla, meses, desfase) {
  const fecha = new Date(ancla.getTime() + desfase * 60000);
  const dia = fecha.getUTCDate();
  fecha.setUTCDate(1);
  fecha.setUTCMonth(fecha.getUTCMonth() + meses);
  const ultimo = new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth() + 1, 0)).getUTCDate();
  fecha.setUTCDate(Math.min(dia, ultimo));
  return new Date(fecha.getTime() - desfase * 60000);
}

export function periodoFacturado(factura, preapproval, fila) {
  const inicio = new Date(fechaProveedor(factura.debit_date));
  const ancla = new Date(fechaProveedor(fila.billing_anchor_at || preapproval.auto_recurring?.start_date));
  const desfase = fila.billing_offset_minutes ?? desfaseProveedor(preapproval.auto_recurring?.start_date);
  const local = (fecha) => new Date(fecha.getTime() + desfase * 60000);
  let meses = (local(inicio).getUTCFullYear() - local(ancla).getUTCFullYear()) * 12 + local(inicio).getUTCMonth() - local(ancla).getUTCMonth();
  // Asignar al ciclo que contiene la fecha de debito, manteniendo el ancla.
  // El retraso del intento no desplaza los ciclos siguientes. Comparar fechas
  // civiles del proveedor evita errores al cruzar medianoche UTC por minutos.
  if (local(mesDesdeAncla(ancla, meses, desfase)).toISOString().slice(0, 10) > local(inicio).toISOString().slice(0, 10)) meses--;
  if (meses < 0) {
    throw new Error('Factura fuera del ciclo del acuerdo');
  }
  return { inicio: mesDesdeAncla(ancla, meses, desfase).toISOString(), fin: mesDesdeAncla(ancla, meses + 1, desfase).toISOString(), ancla: ancla.toISOString() };
}
