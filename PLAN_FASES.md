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
- `routes/auth.js`: **el alta la hace el trigger de Supabase** (`handle_new_user`),
  NO el webhook `/api/auth/webhook` (ese webhook no se ejecuta en produccion), asi
  que la bienvenida se dispara desde `POST /api/auth/bienvenida`, que el frontend
  llama tras iniciar sesion. Es idempotente: si `welcome_sent_at` ya esta escrito
  no reenvia. Nombre desde `user_metadata.full_name` con fallback al prefijo.
- `routes/grupos.js`: `GET /api/grupos` con `verificarSuscripcionSolo` (solo
  suscripcion activa, sea `gratis` o `mensual`) -> 403 si no hay.

**Cambios (frontend):**
- `netlify/functions/welcome.mjs`: envia el correo (SMTP 587/STARTTLS, igual que
  `contacto.mjs`) con boton + **QR inline por comunidad** (`qrcode` -> attachment
  `cid`); endpoint interno protegido por `WELCOME_SECRET`.
- `netlify.toml`: redirect `/api/welcome` -> `/.netlify/functions/welcome`.
- `dashboard.html` / `js/dashboard.js`: tarjeta **Comunidad** con un boton por grupo.
- `js/auth.js`: `obtenerGrupos()` (reutiliza `apiRequestGET` con reintento) y
  `solicitarCorreoBienvenida()` (llamada en `inicializarAuth` si hay sesion).

**Verificado (local + produccion):**
- `welcome.mjs`: sin secreto -> 401; correo invalido -> 400; envio real con grupos
  de la BD (QR PNG inline) -> 200; sin grupos -> 200.
- `POST /api/auth/bienvenida`: 1er llamado -> `enviado:true` + `welcome_sent_at`
  escrito; 2do llamado -> `enviado:false` (idempotente); sin token -> 401.
- `GET /api/grupos`: sin token -> 401; token invalido -> 401; con suscripcion
  `gratis` activa -> 200 con la lista; sin suscripcion -> 403; con plan
  `mensual` activo -> 200. Usuario efimero y filas de prueba eliminados al final.
- Produccion (post-merge): `/api/welcome` responde 401 sin secreto y 200 con el
  secreto leyendo la fila real de `groups`; `/api/grupos` -> 200 con la lista.

**Descubrimiento importante:**
- El alta de `users` + mes gratis la hace el **trigger de Supabase**
  (`on_auth_user_created` / `handle_new_user`), no el webhook HTTP
  `/api/auth/webhook` del backend (ese webhook no esta conectado en produccion,
  por eso el primer intento de bienvenida nunca se disparo y `welcome_sent_at`
  quedaba en NULL). Por eso la bienvenida se pide desde el frontend.
- La tabla `groups` tiene RLS **sin politicas** a proposito (solo el service key
  accede); el advisor lo reporta como `INFO`, no es un problema.

**Pendiente al deploy:**
- Netlify: `WELCOME_SECRET` (mismo valor que en Railway) + `GMAIL_USER` /
  `GMAIL_APP_PASSWORD` (ya existen) y redesplegar.
- Railway: `NETLIFY_WELCOME_URL=https://clublecturahispano.netlify.app/api/welcome`
  y `WELCOME_SECRET` (mismo valor que en Netlify).
- Llenar `groups` con las invitaciones reales (WhatsApp/Discord) desde Supabase.
- E2E: registrarse de verdad y confirmar el correo + los QR.

---

## Fix de pagos: estado real + idempotencia (sin OXXO)

**Por que:** `procesarPagoSesionExtra` calculaba `status` y **nunca lo usaba**:
la tabla no tenia columna de estado, asi que un pago rechazado por MP (fondos
insuficientes, tarjeta invalida) **igual registraba la compra y daba acceso** a
la sesion. Con OXXO (`pending`) pasaba lo mismo. Ademas cada reenvio del webhook
insertaba otra fila. `procesarPagoSuscripcion` recalculaba
`end_date = ahora + 30` en cada replay, **extendiendo la suscripcion para
siempre**, y pisaba la fila del mes gratis.

**Esquema (`extra_sessions`):**
- `status text not null default 'pending'` con check
  `('pending','pagada','rechazada')`.
- `uniq_extra_sessions_user_sesion_activa` unique parcial `(user_id, session_id)`
  `where status <> 'rechazada'`: una compra viva por sesion, pero una rechazada
  **libera** el lugar para reintentar.
- `uniq_extra_sessions_mp_pay_id` unique parcial `(mp_pay_id)`: un pago de MP no
  genera dos filas aunque se reenvie la notificacion.

**Codigo:**
- `procesarPagoSesionExtra`: usa el estado real, guarda por `mp_pay_id` antes de
  insertar, y una compra ya `pagada` **nunca se degrada** (un `rejected` tardio
  no quita el acceso). `23505` en carrera se trata como flujo normal.
- `procesarPagoSuscripcion`: guarda por `mp_sub_id` -> si ya esta `active` no se
  toca (fin de la extension infinita). Si hay trial `gratis` vigente, la fila del
  trial se deja **intacta** y la de pago se crea aparte.
- `crearPreferenciaSesionExtra`: `excluded_payment_types: [{ id: 'ticket' }]` e
  `installments: 1`. **OXXO/ticket sale del checkout**: el ticket se paga por
  fuera y su webhook llega `pending` horas despues con ventana de expiracion;
  sin reconciliacion dejaba compras fantasma o cobros huerfanos.
- `/api/pagos/sesion-extra`: el check de compra previa usa
  `.neq('status','rechazada').limit(1).maybeSingle()` (`.single()` fallaba con
  `PGRST116` y el error se descartaba en silencio) y **el monto sale de
  `sessions.price`**: el cliente ya no puede elegir cuanto paga.
- `js/sesion-especial.js`: el `session_id` se obtiene de `GET /api/sesiones`
  (estaba hardcodeado `'special-001'`, un string que no existe en la BD, con
  `sessions.id` numerico) y se muestra el precio real.
- `procesarPagoSuscripcion` / `procesarPagoSesionExtra` se exportan para poder
  testearlas; `Auth.apiRequestGET` se agrega a los exports.

**Verificado (sandbox, token TEST):**
- Preference creada con `excluded_payment_types: ["ticket"]` e
  `installments: 1`; `unit_price` = 50 (de `sessions.price`), el `monto` del
  cliente se ignora.
- `rejected` -> `rechazada` (sin acceso); reintento `approved` -> `pagada`.
- 3 entregas del mismo pago rechazado -> 1 fila; 4 del mismo aprobado -> 2 filas
  (no duplica); `rejected` posterior NO degrada la compra `pagada`.
- Unique `(user_id, session_id)` -> `23505` en compra duplicada; unique
  `mp_pay_id` -> `23505` en fila repetida; reintento tras rechazo permitido.
- Replay de suscripcion (3x): 1 sola fila y `end_date` identico (ya no se
  extiende); rechazado -> `pending`; pago aprobado -> `active` + rol
  `suscriptor`; con trial vigente quedan `["gratis/active","mensual/active"]`.
- Usuario de prueba y filas eliminados al final.

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
      **CORREGIDO 2026-10-01:** credenciales PROD confirmadas en Railway
      (`APP_USR-...`, cuenta 1060021514 `site_status: active`, `sell.allow: true`,
      `required_action: null`) y webhook validando firma (401 sin `x-signature`).
      *La nota anterior de este check ("produccion corre en modo sandbox") quedo
      desmentida: los tokens TEST y PROD de una misma app comparten espacio de
      datos y el mismo `collector_id`, asi que esa comparacion no servia como
      prueba.*
- [x] `MERCADOPAGO_WEBHOOK_SECRET` activo en Railway (las peticiones sin firma dan 401).
- [ ] Probar E2E con un pago real del dueño (autorizar el preapproval en el checkout y
      reembolsar), y luego revisar `suscriptions`/`pagos`/`users` al llegar los webhooks.

### Pagos con credenciales PROD: no usar tarjetas ni cuentas de prueba

Anotacion que **ya no aplica** y que Provoco el rechazo del primer intento:
las tarjetas de prueba (`5474 9254 3267 0366`, `4075 5957 1648 3764`) y las cuentas
de prueba de MP son solo para credenciales `TEST-`. Con credenciales `APP_USR-` hay
que pagar con tarjeta real y **reembolsar** despues.

### Antifraude: no repetir el intento con los mismos datos

El 2026-10-01 el pago se rechazo con "por motivos de seguridad" y **MP nunca creo
un objeto de pago**, asi que no hay `status_detail` que diga el motivo exacto. Lo
que si se pudo observar y reproducir:

- Habia dos preapprovals identicos (mismo `external_reference`, mismo
  `payer_email`, mismo `$80`) creados a las 18:53 y las 19:19.
- Al reproducir el patron desde las pruebas, MP respondio
  **`local_rate_limited` (HTTP 429)** al intentar crear preapprovals seguidos.
  O sea, MP **limita la tasa de creacion de preapprovals**, no solo el antifraude
  del checkout.

La documentacion de MP cubre la parte de antifraude:

> `cc_rejected_other_reason` "se trata de una estimacion de riesgo de fraude".
> `cc_rejected_high_risk` puede aparecer "cuando se intentan realizar dos pagos
> consecutivos con los mismos items o con parametros muy similares (como `payer` e
> `items` identicos)". El motor antifraude lo interpreta como duplicado, lo
> rechaza "por precaucion, bloqueando todos los pagos posteriores
  temporalmente".

Por eso `POST /api/pagos/suscripcion` ahora **reutiliza** el preapproval vigente
en vez de crear uno por clic, cancela en MP los que ya no sirven, y el frontend
bloquea el reintento inmediato durante 60 s. Asi se atacan las dos causas: el
limite de tasa y el detector de duplicados.
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