# PLAN_FASES - Preparacion para produccion (Club de Lectura)

Plan de implementacion por fases. Cada fase se ejecuta, se verifica y requiere
aprobacion del usuario para pasar a la siguiente.

## Decisiones tomadas
- Pregunta 1 (recurrencia): SI, suscripcion recurrente mensual con `preapproval` de MP.
- Pregunta 2 (dominio): aun no existe dominio; se usa placeholder hasta el deploy.
- Pregunta 3 (webhook secret): `MERCADOPAGO_WEBHOOK_SECRET` configurable por env, sin valor real.

## Fases (orden de ejecucion)

| # | Tema | Tipo | Estado |
|---|------|------|--------|
| 1 | RLS: restringir politicas de escritura a `service_role` | Migracion Supabase | completado |
| 2 | `BACKEND_URL` configurable en frontend (dejar localhost) | Codigo frontend | completado |
| 3 | Alta automatica de `users` + mes gratis al registrarse (trigger) | Migracion + codigo | completado |
| 4 | CORS multi-dominio + preparacion OAuth/produccion | Codigo backend | completado |
| 5 | Verificacion de firma del webhook MP (X-Signature) | Codigo backend | completado |
| 6 | `category_id` validos de Mercado Pago | Codigo backend | completado |
| 7 | Suscripcion recurrente real con `preapproval` | Codigo backend | completado* |

> *La creacion real del `preapproval` no pudo E2E-probarse en sandbox: MP rechaza
> `/preapproval` en esta cuenta de prueba sinon que el payer sea una cuenta MP valida
> vinculada (errores `Payer is associated with a different site` / `User bad request`
> / `Resource not found`). El plan (`/preapproval_plan`) SI se crea (HTTP 201). La
> logica local (webhooks subscription_* , cancel, DB) esta verificada E2E.

---

## Fase 1 - RLS: cerrar politicas "service" a service_role
**Objetivo:** impedir que la anon key publica inserte/actualice en
`users`, `pagos`, `suscriptions`, `extra_sessions`, `sessions_register`.
Hoy esas politicas tienen `roles={public}` con `with_check=true`.

**Cambios (migracion):**
- `ALTER POLICY ... TO service_role` en las politicas de INSERT/UPDATE.
- `REVOKE INSERT, UPDATE, DELETE ON <tablas> FROM anon, authenticated` (defensa en profundidad).

**Verificacion:**
- `pg_policies` muestra roles `{service_role}` en politicas de escritura.
- Insert como `anon` debe fallar (RLS/permisos).
- Backend sigue funcionando (`/api/health`, `/api/sesiones`, `/api/sesiones/libros`).

---

## Fase 2 - BACKEND_URL configurable en el frontend
**Objetivo:** dejar de apuntar a `http://localhost:3000` en produccion.

**Cambios:**
- Nuevo `frontend/js/config.js` con `window.APP_CONFIG.BACKEND_URL`
  (localhost si corre en local, placeholder https en otro caso).
- `frontend/js/auth.js:5` -> usar `window.APP_CONFIG.BACKEND_URL` con fallback localhost.
- Incluir `js/config.js` antes de `auth.js` en TODAS las paginas HTML.

**Verificacion:** local sigue funcionando; sin BACKEND_URL hardcodeado salvo fallback.

---

## Fase 3 - Alta automatica de `users` + mes gratis al registrarse
**Objetivo:** crear fila en `users` (y suscripcion gratis 30 dias) via trigger,
sin depender de configurar un webhook externo.

**Cambios (migracion):**
- Funcion `handle_new_user()` (security definer) + trigger
  `on_auth_user_created` (AFTER INSERT en `auth.users`), idempotente.

**Verificacion:** al registrar un usuario aparece en `users` y `suscriptions`
(gratis 30 dias); `/api/auth/usuario/estado` responde OK.

---

## Fase 4 - CORS multi-dominio + preparacion OAuth/produccion
**Objetivo:** backend acepte dev (8080) y produccion; dejar documentado setup
de Supabase y Google para cuando exista el dominio.

**Cambios (backend):**
- `server.js`: CORS con lista de origenes desde env `FRONTEND_URLS` (CSV),
  fallback `http://localhost:8080`.
- `.env`: `FRONTEND_URLS=http://localhost:8080,https://TU-DOMINIO-NETLIFY` (placeholder).

**Pendiente al deploy (no bloqueante):**
- Supabase: Site URL + Redirect URLs con el dominio.
- Google OAuth: agregar origin/redirect de produccion.

**Verificacion:** preflight OPTIONS 204 cross-origin; health OK.

---

## Fase 5 - Verificacion de firma del webhook MP
**Objetivo:** validar `X-Signature` + `X-Request-Id` (AGENTS: "verificar firma webhook").

**Cambios (backend):**
- Middleware en `/api/pagos/webhook` que valida HMAC con `MERCADOPAGO_WEBHOOK_SECRET`
  (env opcional; si no esta configurado, se loguea aviso y continua en dev).
- Mantener la re-validacion del pago contra la API de MP (ya existe).

**Verificacion:** con firma invalida -> 400; con firma valida simulada -> procede.

---

## Fase 6 - category_id validos de MP
**Objetivo:** evitar rechazos de preferencia con credenciales reales.

**Cambios (backend `services/mercadopago.js`):**
- Reemplazar `'reading'` y `'special_session'` por IDs oficiales segun docs de MP.

**Verificacion:** con token TEST la preferencia se crea sin errores (tiene init_point).

---

## Fase 7 - Suscripcion recurrente real (preapproval)
**Objetivo:** cobro mensual automatico con `preapproval` en vez de pago unico.

**Vision del negocio (confirmada):** Mercado Pago aloja TODO el pago (tarjeta, cuenta MP
y demas medios). Nosotros NUNCA tocamos datos de tarjeta y solo guardamos referencias
(`mp_sub_id`, `mp_payment_id`, monto, estado). El frontend solo redirige a `init_point`.
Se descarta el camino de `card_token_id`/formulario de tarjeta propio (eliminado).

**Cambios (backend) - implementado:**
- `services/mercadopago.js`:
  - `crearPreapprovalSuscupcion(usuarioId, email)` -> preapproval pendiente (flujo
    clasico con `init_point` de `/subscriptions/checkout`). MP aloja metodo de pago.
  - `obtenerPreapproval`, `cancelarPreapproval`, `obtenerPagoAutorizado`.
  - Webhooks: `subscription_created`, `subscription_authorized_payment` (reusa el pago
    real y activa la suscripcion), `subscription_cancelled`. `mp_sub_id` se vincula al
    preapproval real (`payment.preapproval_id`).
  - `cancelarSuscripcion` ahora cancelar el preapproval en MP antes de marcar `cancelled`.
- `routes/pagos.js`: `/suscipcion` crea preapproval, `/webhook` despacha
  `payment` + eventos de suscripcion.

**Verificado:**
- `subscription_cancelled` -> suscription `cancelled` + user `free`. (E2E local)
- Dispatcher: tipo desconocido -> OK "no manejado"; pago autorizado con id falso ->
  error controlado `success:false` (sin crashear).
- Sintaxis OK y backend reiniciado.

**Pendiente al deploy (MP/panel):**
- Habilitar el producto **Suscripciones** en la aplicacion MP (panel).
- Probar en TEST con la cuenta de pruebas del panel: crear preapproval en TEST y
  autorizar el checkout en el navegador con esa cuenta (solo asi se podra E2E real).
- Configurar webhook URL (`https://<backend>/api/pagos/webhook`) + `MERCADOPAGO_WEBHOOK_SECRET`.
- `FRONTEND_URL` https real (MP rechaza http/localhost como `back_url`).

---

## Checklist al deploy (fuera de fases)
- [x] Codigo commit-teado en `develop` y mergeado a `main`.
- [x] Repo remoto: `https://github.com/isalowpoke/club_lectura` (ramas `main` y `develop`).
- [x] `package.json`: `engines.node >= 20`.
- [~] `config.js`: `BACKEND_URL` con placeholder `TU-BACKEND.up.railway.app` (reemplazar al generar el subdominio).
- [ ] Poner `MERCADOPAGO_ACCESS_TOKEN` y `MERCADOPAGO_PUBLIC_KEY` reales (PROD) en Railway.
- [ ] Poner `MERCADOPAGO_WEBHOOK_SECRET` del panel de MP.
- [ ] Habilitar **Suscripciones** en la aplicacion de MP y probar E2E en TEST con la
      cuenta de pruebas del panel (Fase 7).
- [ ] `FRONTEND_URL` y `FRONTEND_URLS` con el dominio real de Netlify (https).
- [ ] Supabase: Site URL, Redirect URLs y Google OAuth con el dominio.
- [ ] Activar "Email logins" o dejar solo Google (impacta tests de sesion).

---

## Estado de deploy (en curso)

Repo `github.com/isalowpoke/club_lectura` conectado. Falta (pasos del usuario):
- Railway: crear proyecto + service con Root Directory = `backend`, y pegar las env vars.
- Netlify: conectar el repo, Base directory = `frontend`, publish = `.`.
- Supabase: ajustar URLs de auth (valores abajo).
- Mercado Pago: token PROD + Suscripciones + webhook (pendiente hasta que el sitio este arriba).

### Variables de entorno para Railway (backend)
```
SUPABASE_URL=https://sktkxbmrktgxeduwnunu.supabase.co
SUPABASE_ANON_KEY=<anon key de auth.js / panel>
SUPABASE_SERVICE_KEY=<service key del panel - SOLO backend>
MERCADOPAGO_ACCESS_TOKEN=<PROD, no TEST>
MERCADOPAGO_PUBLIC_KEY=<PROD>
MERCADOPAGO_WEBHOOK_SECRET=<secreto del panel MP>
FRONTEND_URL=https://clublecturahispano.netlify.app
FRONTEND_URLS=https://clublecturahispano.netlify.app
CRON_SECRET=<cadena aleatoria>
PORT=3000
```

### Supabase - URLs de auth
- Site URL: `https://clublecturahispano.netlify.app`
- Redirect URLs: agregar `https://clublecturahispano.netlify.app/**` (mantener `http://localhost:8080/**` para dev)
- Google OAuth: verificar que el redirect URI de callback de Supabase esta en Google Cloud.