-- sessions.link es el enlace de la reunion: es el producto que se vende. Estaba
-- legible por PostgREST con la anon key publica (que vive en el frontend), lo que
-- allows saltarse por completo el gate de suscripcion. RLS no filtra columnas,
-- asi que se restringe el SELECT por columna para anon/authenticated. El backend
-- usa service_role y sigue viendo la tabla completa.
revoke select on public.sessions from anon, authenticated;

grant select (id, created_at, date, title, description, hour, type, price, img_url)
  on public.sessions to anon, authenticated;;
