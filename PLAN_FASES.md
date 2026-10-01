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

## Feature A - "Asegura tu mes" (suscripcion programada al corte de la prueba)
**Objetivo:** que el usuario pueda pagar durante el mes gratis SIN perderlo: el primer
cobro se agenda exactamente al terminar la prueba y MP cobra automatico en el corte.

**Cambios (backend):**
- `services/mercadopago.js`:
  - `crearPreapprovalSuscripcion` consulta la prueba gratis vigente
    (`plan='gratis'`, `status='active'`, `end_date >= now`) y si existe agrega
    `auto_recurring.start_date = end_date` de la prueba. MP exige el formato
    con offset `-00:00` (rechaza `Z` y `+HH:MM`).
  - `procesarWebhookSuscripcionCreacion`: si hay prueba vigente crea una fila
    SEPARADA `mensual/pending` (con `mp_sub_id`, `init_date` = fecha de cobro)
    SIN tocar la fila gratis. Sin prueba: conserva el comportamiento previo.
  - `procesarPagoSuscripcion`: solo `approved` activa; cualquier otro estado queda
    `pending` (MP reintenta) en vez de `cancelled`.
  - `cancelarSuscripcion`: cancela preapproval `active` o `pending` (programado),
    marca solo esa fila `cancelled` y no rompe la prueba gratis vigente.
  - Helper `interpretarFechaUtc` (las columnas `init_date/end_date` son naive).
- `routes/pagos.js` `/estado`:
  - `estado` normalizado a `'activa'/'inactiva'` (corrige `tieneSuscripcionActiva()`).
  - Nuevos campos: `en_prueba`, `pago_programado`, `pago_pendiente_cobro`,
    `proxima_fecha_cobro` (UTC).
  - Fechas normalizadas a UTC (antes naive -> corrimiento por tz del navegador).

**Cambios (frontend):**
- `dashboard.js`: prueba vigente -> CTA "Asegurar mi Mes (cobro al terminar el
  gratis)"; programada -> banner verde con fecha del primer cobro + boton
  "Cancelar suscripcion programada"; cobro fallido en el corte -> aviso amber
  "Cobro pendiente - MP reintenta".
- `precios.html`: boton dinamico sin sesion ("Empezar Gratis"), en prueba
  ("Asegurar mi Mes"), programada (disabled), pago activo ("Gestionar en tu panel").

**Verificado (token PROD + Supabase prod):**
- Preapproval creado con `start_date == fin_prueba` (assert por instante) y
  `back_url` https valido (MP rechaza http en PROD).
- `subscription_created` -> fila `mensual/pending` separada, prueba intacta.
- `cancelarSuscripcion` -> MP cancelado, programada `cancelled`, prueba sigue
  activa, rol `free` sin cambios.
- `/estado` (logica replicada, 5 escenarios): inicio prueba / prueba+programada /
  cobro pendiente / prueba vencida / pago activo -> TODO OK.

**Nota deploy:** `FRONTEND_URL` (https de Netlify) ES obligatoria en Railway: MP
rechaza `back_url` http/localhost al crear preapproval en produccion.

---

## Feature B - Formulario de contacto funcional (Gmail SMTP)
**Objetivo:** el formulario de `contacto.html` envia el mensaje a `clublecturah@gmail.com`
sin almacenar nada en BD.

**Cambios (backend):**
- `services/email.js`: transporter Nodemailer Gmail (`smtp.gmail.com:465` SSL) con
  App Password; `enviarCorreoContacto` con `replyTo` al correo del visitante.
- `routes/contacto.js`: `POST /api/contacto` con validacion de campos, honeypot
  (`website`) que responde exito sin enviar, y rate-limit propio (10/h).
- `server.js`: ruta montada en `/api`.

**Cambios (frontend):**
- `js/contacto.js`: envio via `Auth.apiRequest`, boton con estado "Enviando...",
  notificaciones de exito/error, validacion del lado cliente.
- `contacto.html`: campo oculto honeypot, se reemplaza el `alert()` placeholder,
  se incluye `contacto.js`, correo real `clublecturah@gmail.com` en la info.

**Variables de entorno (backend `.env` y Railway):**
```
GMAIL_USER=clublecturah@gmail.com
GMAIL_APP_PASSWORD=<App Password de Google, requiere 2FA>
CONTACTO_TO_CLUB=clublecturah@gmail.com
```

**Verificado:** envio real OK (correo recibido), honeypot y validaciones 400,
E2E en navegador sin errores de consola.

---

## Fijacion: proximas sesiones (filtro por zona horaria)
**Problema:** la columna `sessions.date` es `timestamp without time zone` guardada en
hora local de Mexico; el API filtraba con `new Date().toISOString()` (UTC), por lo que
durante parte del dia las sesiones de "hoy" en CDMX desaparecian. Ademas la pagina
ocultaba las sesiones `especial` y mostraba la hora con segundos (`19:00:00`).

**Cambios:**
- `routes/sesiones.js`: `ahoraNaiveCDMX()` via `Intl` con `America/Mexico_City`, el
  filtro `gte` usa esa cadena naive (alineada con el schema).
- `proximas-sesiones.html`: se muestran todas las sesiones futuras (regular, normal y
  especial), badge "Pago: $X" para especiales y hora `HH:MM`.

**Verificado:** E2E navegador sin errores; `especial` aparecen; hora formateada.

---

## Fijacion: sesiones proximas en dashboard (hora)
- `dashboard.js`: la hora de la proxima sesion se muestra `HH:MM` (antes `19:00:00`).

---

## Feature C - Correo de bienvenida con acceso a la comunidad (link + QR)
**Objetivo:** cuando un usuario se une (gratis o de pago) recibe un correo de
bienvenida con los enlaces de la comunidad (WhatsApp, Discord, etc.) y un QR por
cada uno; los mismos enlaces quedan disponibles en su dashboard.

**Cambios (BD - migracion `agregar_groups_y_welcome_sent_at`):**
- Tabla `groups` (`name`, `url`, `description`, `active`) administrada por el owner.
  RLS habilitado **sin politicas** -> el cliente no puede leerla; solo el service key.
- `users.welcome_sent_at timestamptz` (idempotencia del envio + reenvio futuro).

**Cambios (backend):**
- `services/bienvenida.js`: `obtenerGruposActivos()` y `enviarCorreoBienvenida()`
  (dispara `POST` HTTPS a la Netlify Function con `x-welcome-secret`, timeout 8s).
  Railway bloquea SMTP saliente, asi que el envio vive en Netlify (AWS).
- `routes/auth.js`: el webhook de registro dispara la bienvenida en segundo plano
  (fire-and-forget) para no retrasar la respuesta ni provocar reintentos de Supabase;
  marca `welcome_sent_at` solo si el envio fue exitoso. Nombre desde
  `user_metadata.full_name` con fallback al prefijo del correo.
- `routes/grupos.js`: `GET /api/grupos` con `verificarSuscripcionSolo` (solo
  suscripcion activa, sea `gratis` o `mensual`) -> 403 si no hay.

**Cambios (frontend):**
- `netlify/functions/welcome.mjs`: envia el correo (SMTP 587/STARTTLS, igual que
  `contacto.mjs`) con boton + **QR inline por comunidad** (`qrcode` -> attachment
  `cid`); endpoint interno protegido por `WELCOME_SECRET`.
- `netlify.toml`: redirect `/api/welcome` -> `/.netlify/functions/welcome`.
- `dashboard.html` / `js/dashboard.js`: tarjeta **Comunidad** con un boton por grupo.
- `js/auth.js`: `obtenerGrupos()` (reutiliza `apiRequestGET` con reintento).

**Verificado (local, `develop`):**
- `welcome.mjs`: sin secreto -> 401; correo invalido -> 400; envio real con 2
  grupos (QR de 1.9 KB PNG generado y enviado inline) -> 200; sin grupos -> 200.
- `GET /api/grupos`: sin token -> 401; token invalido -> 401; con suscripcion
  `gratis` activa -> 200 con la lista; sin suscripcion -> 403; con plan
  `mensual` activo -> 200. Usuario efimero y filas de prueba eliminados al final.
- El webhook de auth confirmó que da de alta `users` + mes gratis y dispara la
  bienvenida (log `Bienvenida no enviada` esperado: `/api/welcome` aun no esta
  desplegado en Netlify).

**Pendiente al deploy:**
- Netlify: `WELCOME_SECRET` (mismo valor que en Railway) + `GMAIL_USER` /
  `GMAIL_APP_PASSWORD` (ya existen) y redesplegar.
- Railway: `NETLIFY_WELCOME_URL=https://clublecturahispano.netlify.app/api/welcome`
  y `WELCOME_SECRET` (mismo valor que en Netlify).
- Llenar `groups` con las invitaciones reales (WhatsApp/Discord) desde Supabase.
- E2E: registrarse de verdad y confirmar el correo + los QR.

---

## Checklist al deploy (fuera de fases)
- [x] Codigo commit-teado en `develop` y mergeado a `main`.
- [x] Repo remoto: `https://github.com/isalowpoke/club_lectura` (ramas `main` y `develop`).
- [x] `package.json`: `engines.node >= 22`.
- [x] `config.js`: `BACKEND_URL=https://clublectura-production.up.railway.app`.
- [x] CORS: dominio Netlify real incl. por codigo en `server.js` (respaldo al env).
- [x] Webhook OAuth verificado: Supabase emite OAuth de Google con callback correcto y
      acepta `https://clublecturahispano.netlify.app/**` (E2E Playwright: el boton de
      login del sitio llega a accounts.google.com sin errores JS).
- [ ] Poner `MERCADOPAGO_ACCESS_TOKEN` y `MERCADOPAGO_PUBLIC_KEY` reales (PROD) en Railway.
      *(verificado: el token PROD existente crea preferencias y preapprovals HTTP 201,
      incl. `category_id=books` y `start_date` agendado).*
- [x] `MERCADOPAGO_WEBHOOK_SECRET` activo en Railway (las peticiones sin firma dan 401).
- [ ] Probar E2E con un pago real del dueño (autorizar el preapproval en el checkout y
      reembolsar), y luego revisar `suscriptions`/`pagos`/`users` al llegar los webhooks.
- [~] Supabase: Site URL todavia apunta a `localhost:3000` en el panel -> cambiarlo a
      `https://clublecturahispano.netlify.app` (no bloquea el login Google, pero es lo
      correcto para codigos de email/redirects por defecto).

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
GMAIL_USER=clublecturah@gmail.com
GMAIL_APP_PASSWORD=<App Password del owner, requiere 2FA>
CONTACTO_TO_CLUB=clublecturah@gmail.com
NETLIFY_WELCOME_URL=https://clublecturahispano.netlify.app/api/welcome
WELCOME_SECRET=<mismo valor que en Netlify>
PORT=3000
```

### Variables de entorno para Netlify (frontend)
```
GMAIL_USER=clublecturah@gmail.com
GMAIL_APP_PASSWORD=<App Password del owner, requiere 2FA>
CONTACTO_TO_CLUB=clublecturah@gmail.com
WELCOME_SECRET=<mismo valor que en Railway>
```

### Supabase - URLs de auth
- Site URL: `https://clublecturahispano.netlify.app`
- Redirect URLs: agregar `https://clublecturahispano.netlify.app/**` (mantener `http://localhost:8080/**` para dev)
- Google OAuth: verificar que el redirect URI de callback de Supabase esta en Google Cloud.