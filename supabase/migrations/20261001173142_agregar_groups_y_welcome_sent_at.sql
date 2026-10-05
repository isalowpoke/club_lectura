-- Tabla de comunidades (WhatsApp, Discord, etc.) gestionada por el admin
create table if not exists public.groups (
  id bigint generated always as identity primary key,
  name text not null,
  url text not null,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.groups is 'Comunidades externas (WhatsApp, Discord, etc.) con link de invitacion';

-- RLS habilitado y SIN politicas: niega todo al cliente (solo service key lee/escribe)
alter table public.groups enable row level security;

-- Columna de idempotencia/reenvio del correo de bienvenida
alter table public.users
  add column if not exists welcome_sent_at timestamptz;;
