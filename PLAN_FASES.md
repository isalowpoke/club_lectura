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
- `routes/auth.js`: **el alta la hace el trigger de Supabase** (`handle_new_user`).
  La bienvenida se dispara desde `POST /api/auth/bienvenida`, que el frontend
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
  (`on_auth_user_created` / `handle_new_user`). Ese webhook HTTP del backend
  nunca estuvo conectado en produccion (por eso el primer intento de
  bienvenida nunca se disparo y `welcome_sent_at` quedaba en NULL), asi que la
  bienvenida se pide desde el frontend. La ruta llego a eliminarse; ver la
  seccion de auditoria de seguridad.
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
- **OXXO en suscripciones: no hay nada que excluir.** El endpoint `/preapproval`
  no expone `excluded_payment_types` (verificado sobre el JSON real del
  preapproval: las claves son `id, payer_id, payer_email, back_url, collector_id,
  application_id, status, reason, external_reference, date_created,
  last_modified, auto_recurring, summarized, next_payment_date, payment_method_id,
  payment_method_id_secondary, first_invoice_offset, subscription_id, owner`; el
  unico selector de medio de pago es `payment_method_id`). Y MP marca en su tabla
  de metodos `*Payment methods not available for Subscriptions`: en Mexico una
  suscripcion solo admite `account_money`, credito y debito, nunca `ticket`.
  Por eso el checkout de suscripcion solo ofrece tarjeta o cuenta de Mercado
  Pago, que es justo lo que se observo al intentar pagar. Correcto, sin cambios.
- **IMPLEMENTACION FUTURA (decidido no hacerlo ahora): `extra_sessions` no
  concede acceso.** Una compra de sesion extra queda registrada en
  `extra_sessions` y se refleja en el historial, pero `GET /api/sesiones` y la
  vista de detalle no la consultan, asi que comprar una sesion extra hoy no
  habilita nada. Falta un gate de entitlement: al listar sesiones, marcar como
  desbloqueada la que tenga una fila en `extra_sessions` con `status='pagada'` y
  `session_id` correspondiente, y reutilizar ese criterio en el frontend para no
  mostrar el candado.
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
- [x] Poner `MERCADOPAGO_ACCESS_TOKEN` y `MERCADOPAGO_PUBLIC_KEY` reales (PROD) en Railway.
      *(verificado: el token PROD existente crea preferencias y preapprovals HTTP 201,
      incl. `category_id=books` y `start_date` agendado).*
      **CORREGIDO 2026-10-01:** credenciales PROD confirmadas en Railway
      (`APP_USR-...`, cuenta 1060021514 `site_status: active`, `sell.allow: true`,
      `required_action: null`) y webhook validando firma (401 sin `x-signature`).
      *La nota anterior de este check ("produccion corre en modo sandbox") quedo
      desmentida: los tokens TEST y PROD de una misma app comparten espacio de
      datos y el mismo `collector_id`, asi que esa comparacion no servia como
      prueba.*
      *Cerrado 2026-10-02: el checkbox quedaba abierto pese a estar verificado.*
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

### Webhook: el evento que faltaba era `subscription_preapproval`

MP no emite `subscription_created` ni `subscription_cancelled` como `type`. Segun
su tabla de eventos, para suscripciones existen:

| Evento | Topico que llega en `type` |
|---|---|
| Vinculacion/actualizacion de una suscripcion | `subscription_preapproval` |
| Cobro recurrente de una suscripcion | `subscription_authorized_payment` |
| Vinculacion de un plan | `subscription_preapproval_plan` |

La ruta solo manejava `subscription_created` / `subscription_cancelled`, asi que
`subscription_preapproval` caia en *"Tipo de notificacion no manejado"*: cuando el
pagador definia el metodo de pago en el checkout, la fila se quedaba en
`pending` para siempre. Ahora `subscription_preapproval` (y el nombre antiguo
`subscription_created`) llaman a `procesarWebhookSuscripcionPreapproval`, que
sincroniza contra el estado real de MP:

- `pending` -> no hace nada (el checkout sigue abierto).
- `authorized` -> **no otorga acceso**. La fila queda `pending` y solo se
  sincronizan las fechas que usa el dashboard (`pago_programado`,
  `proxima_fecha_cobro`). Ver "Regla de acceso" abajo.
- `cancelled` / `paused` -> se refleja en la BD, asi cancelar en MP revoke el
  acceso.

Dos guardas para que un reenvio nunca haga dano: no baja una fila ya `active` a
`pending` y nunca mueve `end_date` hacia atras. Ademas se elimino
`procesarWebhookSuscripcionCreacion`, que quedo sin uso y pisaba la fila del trial.

**Verificado:** evento `pending` procesado e idempotente, `cancelled`
reflejado en la BD, nombre antiguo funcionando, y firma ausente o manipulada
sigue dando 401. El estado `authorized` solo se puede ejercitar con el E2E real
(requiere una tarjeta).

### Regla de acceso: solo un pago aprobado otorga o extiende acceso

**2026-10-02.** El endpoint que decide el acceso es `GET /api/pagos/estado`
(filtra `status = 'active'` y `end_date >= now`), y ese `active` destapa los
enlaces de reunion en el dashboard.

`preapproval.status = 'authorized'` significa que el pagador ** defini un metodo
de pago**, no que MP haya cobrado. El handler lo estaba usando como si fuera un
pago, y activaba la suscripcion (y el rol `suscriptor`) sin que hubiera entrado
un solo peso:

- Con el primer cobro fallido, el acceso dependia de que llegara despues el
  webhook del pago para degradarlo a `pending`.
- Si ese webhook no llegaba (se caia, se agotaban los reintentos de MP, o el
  handler lanzaba) el usuario conservaba el acceso **indefinidamente**. No habia
  ninguna reconciliacion.

Reglas que quedaron:

1. `procesarWebhookSuscripcionPreapproval` nunca escribe `active` ni toca la
   tabla `users`. Con trial vigente el acceso lo da la fila `gratis`; sin trial,
   el acceso llega unicamente con el primer pago aprobado.
2. `procesarPagoSuscripcion` es el unico que activa y el unico que escribe
   `role = 'suscriptor'`.
3. **Extension monotonica:** el periodo que otorga un pago termina en
   `date_approved + 30 dias`, y `end_date` solo avanza si eso va mas lejos que
   el valor actual. Asi un reenvio del mismo webhook no extiende nada y un pago
   viejo que llega tarde no pisa el periodo vigente. Esto elimino la extension
   doble de 30 dias que el codigo anterior Allowaba.
4. `back_url` paso de `?payment=success` a `?retorno=mp`: era inerte, pero
   cualquier UI futura que lo leyera se volveria un mensaje de exito falseable.

### De donde sale el mes gratis (y por que las pruebas lo necesitan)

El trial no lo da el backend: el trigger `on_auth_user_created` sobre
`auth.users` ejecuta `public.handle_new_user()`, que inserta `public.users` con
`role = 'free'` y una fila `suscriptions` de `plan = 'gratis'` por 30 dias
(`where not exists (...)`, asi que es idempotente). Dos consecuencias:

- Todo signup arranca con acceso, y una prueba de la fila `mensual` tiene que
  **expirar el trial** o esa fila tapa el resultado. Esto inicial paso: una
  prueba daba `tiene_suscripcion: true` en verde cuando en realidad el acceso lo
  daba el trial.
- El login por correo esta **deshabilitado** en Supabase ("Email logins are
  disabled"): el unico metodo es Google OAuth, que es lo que usa
  `frontend/js/auth.js` (`signInWithOAuth`). No hay formulario de contrasena en
  el frontend, asi que es consistente. Para obtener un JWT en pruebas hay que
  usar `admin.generateLink` + `verifyOtp`, no `signInWithPassword`.

### Cobro fallido: gracia de 7 dias

Un decline transitorio (sin fondos, tarjeta vencida) ya no le quita el acceso al
cliente de pago en el acto, que era lo que hacia el codigo anterior. Se registro
una columna `suscriptions.failed_at` (timestamp del **primer** fallo; los fallos
seguidos no la pisan, para que la gracia corra siempre desde el primero) y la
regla vive en `GET /api/pagos/estado`:

- `failed_at` nula, o mas reciente que hace 7 dias -> el acceso sigue vigente.
- `failed_at` con mas de 7 dias -> la fila deja de dar acceso y la respuesta
  incluye `renovacion_fallida: true` para que el dashboard pueda explicarlo.
- Un pago aprobado limpia `failed_at`.

Se eligio aplicar la regla en la puerta de acceso y no en un job, justamente para
que la politica sea autoritativa donde se decide y no dependa de un cron.

**Verificado con 27 pruebas** (`procesarPagoSuscripcion` contra la BD real +
`GET /api/pagos/estado` por HTTP con JWT): rechazo inicial deja `pending` sin
rol; aprobado activa y limpia `failed_at`; replay del mismo pago no extiende;
renovacion 31 dias despues extiende; rechazo conserva `active`; segundo rechazo
no pisa `failed_at`; aprobado posterior limpia el fallo; replay de un pago viejo
no retrocede `end_date`; y el corte por gracia a los 8 dias con acceso por HTTP.

### Pendiente: reconciliacion con Mercado Pago

La BD puede divergir de MP si un webhook se pierde, y hoy no hay ninguna red de
seguridad. Queda **aplazado** a proposito (se prefirio cerrar antes el
E2E real). Consta lo que falta:

- `GET /api/pagos/reconciliar` protegido con `x-cron-secret`, reusando el patron
  de `/api/keep-alive` (`.github/workflows/keep-alive.yml` + `secrets.CRON_SECRET`).
- Recorrer `suscriptions` `plan = 'mensual'` con `mp_sub_id` y degradar solo ante
  senales inequivocas: `status` de MP distinto de `authorized` ->
  `cancelled`/`paused`, y fila `active` con preapproval `pending` -> `pending`.
- `preapproval.summarized` expone `last_charged_date`, `charged_quantity`,
  `charged_amount` y `semaphore`. **Los valores de `semaphore` nunca se han
  observado** (no hay ninguna suscripcion cobrada todavia), asi que de momento
  no debe interpretarse: confiese solo en `status`. El E2E real es lo que
  permitira afinarla.
- [x] Supabase: Site URL corregido en el panel a
      `https://clublecturahispano.netlify.app` (confirmado por el usuario).

---

## Auditoria de seguridad: fuga del enlace de las sesiones

`GET /api/sesiones/` no exigia ni JWT ni suscripcion y hacia `.select('*')`, asi que
devolvia el **enlace de la reunion a cualquiera que llamara la ruta**, sin cuenta.
Confirmado contra produccion. El catalogo debia seguir siendo publico, pero el
enlace no.

**Cerrado por dos capas:**

- **BD (ya aplicada en vivo):** migracion `sessions_ocultar_link_a_no_suscriptores`.
  Revoca `SELECT` de tabla y concede a `anon`/`authenticated` solo las columnas
  seguras, dejando `sessions.link` fuera. `service_role` conserva lectura completa,
  asi que por si sola **no** cierra la fuga del backend.
- **Backend:** `services/suscripciones.js` expone `obtenerAccesoUsuario()`, unica
  fuente de verdad para el acceso (incluye la gracia de 7 dias). La ruta ahora pide
  JWT (`middleware/verificar-usuario.js`) y omite `link` sin acceso, conservando el
  catalogo. El frontend ya sabia mostrar "Requiere suscripcion".

Bugs de la misma familia que aparecieron al revisar:

- `middleware/verificar-suscripcion.js` usaba `.single()` sobre `suscriptions`: con
  trial + mensual a la vez (el caso normal de un suscriptor de pago) devolvia error
  y terminaba en 403. Tambien lo arrastraba `routes/auth.js`.
- `users.role` se escribia a ciegas: una cancelacion dejaba el rol en `suscriptor`.
  Ahora `recalcularRol()` lo recalcula desde las filas reales.
- Carrera en el handler de preapproval: escribia `status` desde una lectura vieja y
  un reenvio podia degradar a `pending` una fila que un pago aprobado acababa de
  activar. Se escribe solo con `.neq('status', 'active')`.

**`POST /api/auth/webhook` eliminado.** No exigia ni JWT ni secreto: cualquiera podia
mandar `{type:'INSERT', user:{id,email}}` y crear un `public.users` mas un trial de
30 dias para un UUID arbitrario. Sin escalada de privilegios (el rol venia fijo en
`free` y el acceso ya no depende del rol), pero si permitia ensuciar la BD sin
autenticar. Se verifico que **no hacia falta**: no hay triggers con `pg_net` (nada
que lo invoque), el proyecto no tiene `pg_cron`, el frontend solo llama
`/api/auth/bienvenida`, y el trigger `on_auth_user_created` ya cubria el alta de
forma idempotente. Ademas `PLAN_FASES.md` ya habia documentado dos veces que nunca
estuvo conectado en produccion. Por todo eso se borro la ruta entera en vez de
protegerla: `SUPABASE_WEBHOOK_SECRET` no llega a hacer falta en Railway.

**Verificado:** 28 pruebas de la maquina de estados, 12 de control de acceso a
sesiones y 11 de la eliminacion del webhook, todas contra la BD real.

**Estado: cerrado.** Mergeado a `main` (`b7e0fac`) y desplegado. Verificado contra
produccion (21/21): `GET /api/sesiones/` sin token responde `401`; con token y sin
suscripcion devuelve el catalogo completo sin la columna `link`; con trial vigente
si la incluye; `POST /api/auth/webhook` responde `404`; y un barrido de
`meet.google.com` en las respuestas publicas de `/api/sesiones/`, `/api/health` y
`/api/grupos` no encuentra ninguno. Las tres puertas de acceso
(`/api/sesiones/`, `/api/pagos/estado`, `/api/auth/usuario/estado`) coinciden entre
si porque las tres leen `obtenerAccesoUsuario()`.

Dos asuntos que se abrieron durante la auditoria y quedan resueltos:

- [x] Enlace `https://meet.google.com/zac-rvnv-yth`: ya no se expone por la API y se
      decide no rotarlo por ser irrelevante para el funcionamiento del club.
- [x] 9 usuarios de prueba acumulados en `public.users` (correos `sm-*`, `sec-*`,
      `probe-*`, `verif-deploy-*`), cada uno con su trial `gratis` huerfano y sin
      cuenta en `auth.users`. No afectan al funcionamiento: el acceso se decide
      desde `suscriptions`, no desde `users`, y al no existir cuenta en `auth` nadie
      puede autenticarse como ellos. Se decide dejarlos tal cual. Los 4 huerfanos
      reales se conservan intactos. El cleanup de los tests se corrigio para no
      seguir fugando filas (`PURGAR_PRUEBAS_ANTERIORES=1` purga restos antigos si
      alguna vez hicieran falta).

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