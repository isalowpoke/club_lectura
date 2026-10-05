-- ============================================================
-- Fase 1: Cerrar politicas de escritura al rol service_role
-- Impide que la anon key (public) inserte/actualice datos sensibles
-- ============================================================

-- 1) Polticas de INSERT/UPDATE -> service_role
ALTER POLICY "users_insert_service" ON public.users TO service_role;
ALTER POLICY "suscriptions_insert_service" ON public.suscriptions TO service_role;
ALTER POLICY "suscriptions_update_service" ON public.suscriptions TO service_role;
ALTER POLICY "extra_sessions_insert_service" ON public.extra_sessions TO service_role;
ALTER POLICY "sessions_register_insert_service" ON public.sessions_register TO service_role;
ALTER POLICY "sessions_register_update_service" ON public.sessions_register TO service_role;
ALTER POLICY "pagos_insert_service" ON public.pagos TO service_role;
ALTER POLICY "pagos_upsert_service" ON public.pagos TO service_role;

-- 2) Defensa en profundidad: revocar escritura a anon/authenticated
REVOKE INSERT, UPDATE, DELETE ON public.users FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.suscriptions FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.extra_sessions FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.sessions_register FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.pagos FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.sessions FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.books FROM anon, authenticated;;
