alter table public.suscriptions
  add column if not exists failed_at timestamp;

comment on column public.suscriptions.failed_at is
  'Primer cobro de renovacion no aprobado. El acceso se conserva durante la gracia (7 dias); GET /api/pagos/estado deja de dar acceso cuando failed_at es anterior al limite. Se limpia al aprobarse un pago.';;
