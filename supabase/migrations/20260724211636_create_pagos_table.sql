-- ============================================
-- TABLA: pagos (metadata de transacciones)
-- ============================================
CREATE TABLE IF NOT EXISTS public.pagos (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mp_payment_id TEXT UNIQUE NOT NULL,
  user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  sesion_id BIGINT,
  monto NUMERIC,
  moneda TEXT DEFAULT 'MXN',
  estado_mp TEXT,
  tipo TEXT CHECK (tipo IN ('suscripcion', 'sesion_extra')),
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Habilitar RLS
ALTER TABLE public.pagos ENABLE ROW LEVEL SECURITY;

-- Políticas: usuario solo ve sus pagos
CREATE POLICY "pagos_select_own" ON public.pagos
  FOR SELECT USING (auth.uid() = user_id);

-- Backend puede insertar pagos
CREATE POLICY "pagos_insert_service" ON public.pagos
  FOR INSERT WITH CHECK (true);

CREATE POLICY "pagos_upsert_service" ON public.pagos
  FOR UPDATE USING (true);;
