-- ============================================
-- POLÍTICAS RLS - SEGURIDAD
-- ============================================
-- Regla: Todo denegado por defecto, solo permitir lo necesario

-- ============================================
-- TABLA: users
-- ============================================
-- Los usuarios solo pueden leer su propio perfil
CREATE POLICY "users_select_own" ON public.users
  FOR SELECT USING (auth.uid() = id);

-- Los usuarios pueden actualizar su propio perfil
CREATE POLICY "users_update_own" ON public.users
  FOR UPDATE USING (auth.uid() = id);

-- El backend (service_role) puede insertar usuarios via webhook
CREATE POLICY "users_insert_service" ON public.users
  FOR INSERT WITH CHECK (true);

-- ============================================
-- TABLA: suscriptions
-- ============================================
-- Los usuarios solo pueden leer sus propias suscripciones
CREATE POLICY "suscriptions_select_own" ON public.suscriptions
  FOR SELECT USING (auth.uid() = user_id);

-- El backend puede gestionar suscripciones (webhook de pagos)
CREATE POLICY "suscriptions_insert_service" ON public.suscriptions
  FOR INSERT WITH CHECK (true);

CREATE POLICY "suscriptions_update_service" ON public.suscriptions
  FOR UPDATE USING (true);

-- ============================================
-- TABLA: sessions (sesiones del club)
-- ============================================
-- Cualquier usuario autenticado puede ver las sesiones (contenido público)
CREATE POLICY "sessions_select_auth" ON public.sessions
  FOR SELECT USING (auth.role() = 'authenticated');

-- ============================================
-- TABLA: books (libros del mes)
-- ============================================
-- Cualquier usuario autenticado puede ver los libros (contenido público)
CREATE POLICY "books_select_auth" ON public.books
  FOR SELECT USING (auth.role() = 'authenticated');

-- ============================================
-- TABLA: extra_sessions (compras de sesiones extra)
-- ============================================
-- Los usuarios solo pueden ver sus propias compras
CREATE POLICY "extra_sessions_select_own" ON public.extra_sessions
  FOR SELECT USING (auth.uid() = user_id);

-- El backend puede insertar compras via webhook
CREATE POLICY "extra_sessions_insert_service" ON public.extra_sessions
  FOR INSERT WITH CHECK (true);

-- ============================================
-- TABLA: sessions_register (asistencia a sesiones)
-- ============================================
-- Los usuarios solo pueden ver su propio historial de asistencia
CREATE POLICY "sessions_register_select_own" ON public.sessions_register
  FOR SELECT USING (auth.uid() = user_id);

-- El backend puede registrar asistencia
CREATE POLICY "sessions_register_insert_service" ON public.sessions_register
  FOR INSERT WITH CHECK (true);

CREATE POLICY "sessions_register_update_service" ON public.sessions_register
  FOR UPDATE USING (true);;
