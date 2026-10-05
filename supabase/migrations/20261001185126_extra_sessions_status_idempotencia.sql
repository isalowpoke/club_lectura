-- 1) Columna de estado: distingue compra pagada de pago pendiente/rechazado.
--    Antes no existia: cualquier webhook insertaba fila y daba acceso.
alter table public.extra_sessions
  add column if not exists status text not null default 'pending';

-- 2) Dominio de valores permitidos (protege contra estados inventados).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'extra_sessions_status_check') then
    alter table public.extra_sessions
      add constraint extra_sessions_status_check
      check (status in ('pending', 'pagada', 'rechazada'));
  end if;
end $$;

-- 3) Una sola compra viva por (usuario, sesion). Las rechazadas quedan fuera
--    para permitir reintentar tras un pago fallido.
create unique index if not exists uniq_extra_sessions_user_sesion_activa
  on public.extra_sessions (user_id, session_id)
  where status <> 'rechazada';

-- 4) Idempotencia del webhook: un mp_pay_id no puede generar dos filas,
--    aunque Mercado Pago reintente la notificacion.
create unique index if not exists uniq_extra_sessions_mp_pay_id
  on public.extra_sessions (mp_pay_id)
  where mp_pay_id is not null;;
