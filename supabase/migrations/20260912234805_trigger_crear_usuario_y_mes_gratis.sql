-- ============================================================
-- Fase 3: Alta automatica de users + mes gratis al registrarse
-- Reemplaza la dependencia del webhook externo (se ejecuta al
-- insertar en auth.users, via Supabase Auth).
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Insertar usuario (idempotente)
  insert into public.users (id, email, role)
  values (new.id, new.email, 'free')
  on conflict (id) do nothing;

  -- Mes gratis de 30 dias (evita duplicados si ya existe suscripcion)
  insert into public.suscriptions (user_id, plan, status, init_date, end_date, price)
  select new.id, 'gratis', 'active', now(), now() + interval '30 days', 0
  where not exists (
    select 1 from public.suscriptions s where s.user_id = new.id
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();;
