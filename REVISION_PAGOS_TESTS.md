# Revisión previa a implementar: pagos

Este primer informe describe la revisión histórica anterior a los cambios.
La implementación de pasos 1–2 y su suite nueva se documentan al final.

Rama: develop. En la revisión inicial: sin modificaciones en backend/frontend, sin cobros, cancelaciones,
webhooks productivos de prueba ni escrituras a Supabase.
La única consulta remota de esta revisión ampliada fue GET /users/me de MP.

## Método y límites

31 casos ejecutados con Node.js, assert y VM: 25 reproducciones de fallos/riesgos
y 6 controles satisfactorios. Las aserciones comprueban el comportamiento actual
problemático: que pasen NO significa que la aplicación esté corregida.
Varios casos amplían un mismo hallazgo o requieren definir una política de negocio;
no equivalen a 25 defectos independientes ni a 25 incidentes en producción.

Se leyó el código real de services/mercadopago.js, services/suscripciones.js,
middleware/verificar-firma-webhook.js, routes/pagos.js y frontend/js/pagos.js.
Solo en memoria se retiraron imports/exports y la carga dotenv para inyectar
adaptadores controlados. No se alteraron los cuerpos de las funciones probadas.
Se fijó el reloj y se simularon respuestas MP, consultas/escrituras Supabase y
request/response de Express. Las llamadas de red del harness están sustituidas;
no carga .env ni importa los clientes reales.

El simulador de BD implementa los filtros usados, pero no reproduce toda la
semántica de PostgreSQL/RLS/constraints. T22 inyecta explícitamente un 23505.
T06/T24 coordinan promesas para reproducir un orden concurrente adverso; no son
pruebas de carga. Los handlers se invocan directamente: no se prueba aquí toda la
cadena HTTP, middleware JWT, CORS, rate limiter ni un navegador real.
T13 no demuestra que sea posible fabricar una respuesta de MP en producción.

Harness temporal conservado fuera del código de la aplicación:
`C:/Users/PC/AppData/Local/Temp/club-lectura-audit-payments.cjs`.
Salida de la última ejecución:
`C:/Users/PC/AppData/Local/Temp/club-lectura-audit-results.json`.
Estos archivos pueden desaparecer al limpiar temporales; este informe conserva resultados.

Reejecución desde la raíz del proyecto (PowerShell, sin cargar credenciales):

```powershell
node (Join-Path $env:TEMP 'club-lectura-audit-payments.cjs')
```

## Resultados

| Caso | Resultado observado | Plan |
|---|---|---|
| T01 | Factura con payment.id válido falla por esperar payment_id | P1-01 |
| T02 | ID del pago termina en mp_sub_id | P1-02 |
| T03 | Cancelado remoto produce error y conserva pending local | P1-03 |
| T04 | Excepción de factura responde HTTP 200, success false | P1-04 |
| T05 | Escrituras fallidas terminan en processed true | P1-05 |
| T06 | Dos altas concurrentes generan dos llamadas MP create | P1-07 |
| T07 | Una mensual activa no impide otra alta | P1-07 |
| T08 | Error al consultar trial omite start_date en el alta | P1-08 |
| T09 | Un pago pending escribe failed_at | P2-02 |
| T10 | Replay aprobado viejo limpia un fallo más reciente | P2-02 |
| T11 | Vencimiento hace perder acceso antes de 7 días; sin flag de gracia vencida | P2-02 |
| T12 | Pendiente con fecha nula provoca 500 en handler /estado | P2-03 |
| T13 | Importe insuficiente, moneda distinta y modo test activan, en fixtures separados | P1-10 |
| T14 | Refunded se trata como fallo temporal y conserva acceso | P2-02 |
| T15 | Replay aprobado cambia cancelled a active | P1-11 |
| T16 | Pago del 1 de enero vence el 31 de enero al sumar 30 días | P2-05 |
| T17 | Sin date_approved, el periodo depende de la hora de procesamiento | P1-11 |
| T18 | Firma de ID en query valida mientras se procesa otro ID del body | P1-09 |
| T19 | Sin secreto se acepta la verificación, incluso con entorno production | P1-09 |
| T20 | Checkout incompleto con fecha futura aparece como pago programado | P2-04 |
| T21 | Historial incluye metadata completa del proveedor | P2-06 |
| T22 | 23505 de otra compra pendiente se ignora; queda sin reflejar pago aprobado | P1-12 |
| T23 | Tipo legacy cancelado escribe BD sin consultar estado remoto | P1-09 |
| T24 | Actualización concurrente de preapproval acorta la vigencia extendida | P1-11 |
| T25 | Función de pagos usada por precios envía dos POST ante dos invocaciones | P1-07 |
| C01 | Firma HMAC correcta aceptada; firma incorrecta rechazada | Control correcto |
| C02 | Rechazo inicial no concede acceso | Control correcto |
| C03 | Preapproval authorized solo no concede acceso | Control correcto |
| C04 | Cancelar mensual conserva trial vigente | Control correcto |
| C05 | Solicitud secuencial reutiliza preapproval pending | Control correcto |
| C06 | Error DB distinto de 23505 en sesión extra se propaga | Control correcto |

Los controles positivos evitan interpretar que todo el flujo está roto. El límite
principal sigue siendo la falta de una prueba de integración posterior contra BD
aislada; no se hicieron pruebas destructivas ni cargos para ampliar cobertura.

## Observaciones de revisión estática

- El SDK instalado cancela mediante PUT; su aviso getPayment deprecated no lanza
  por sí solo una excepción. No explica el high_risk.
- Precios invoca la función Pagos que no incluye el bloqueo de 60 s de Auth.
- El sitio del club no integra security.js/Device ID. El checkout final lo aloja
  MP: no se puede deducir que faltó Device ID en las transacciones reales.
- El rate limiter global incluye /api/pagos/webhook: una ráfaga puede competir por
  su cuota. No se reprodujo un 429 de notificaciones; revisar antes de escalar tráfico.
- recalcularRol usa limit(1) sin ordenar y puede elegir una activa cuya gracia
  venció antes que otra vigente. No decide acceso; revisar consistencia informativa
  al abordar P2-02, sin presentarlo como fuga de contenido.

## Evidencia externa y conclusiones

GET /users/me: MLM, active, sell.allow true, buy.allow true, códigos vacíos y email
confirmado. No permite descartar restricciones internas del motor de riesgo.
Las fuentes oficiales sobre rechazos y Device ID están enlazadas en el plan.
La causa privada de cc_rejected_high_risk sigue sin identificarse. Duplicaciones,
autopago e instrumentación son líneas de investigación con distinto nivel de evidencia.

## Regresión después de implementar los pasos 1–2

Fecha: 2026-10-03. Node v24.18.0. Comando desde `backend`: `npm.cmd test`.
Resultado: **46 tests aprobados, 0 fallidos, 0 omitidos**. `git diff --check` sin
errores de espacios. Las advertencias CRLF son de conversión de finales de línea.

Suite permanente: `backend/tests/pagos.test.js`, con adaptadores en
`backend/tests/helpers/entorno-pagos.js`. Carga ESM real mediante VM, sin quitar
imports/exports ni transformar funciones. Simula SDK, Supabase, dotenv y fetch;
no lee credenciales ni realiza cobros, cancelaciones o escrituras remotas.

Cobertura:

- HMAC válido, inválido, hexadecimal malformado y secreto ausente.
- IDs y tipos discrepantes; ID solo en query; rechazo del ID superior del evento.
- Pago y factura, reentregas, ambos órdenes y ejecución concurrente sobre el mismo
  preapproval. Comprueba identidad única; no prueba atomicidad de vigencias en SQL.
- Rechazo `cc_rejected_high_risk` registrado sin crear suscripción falsa ni acceso.
- Discrepancias de importe, moneda, ambiente, usuario, cobrador, aplicación,
  recurrencia y fecha; cero escrituras cuando falla validación.
- Factura ausente, ambigua, paginada, programada sin pago, ID erróneo y referencia
  indebida a sesión extra; ninguna relación se completa inventando identificadores.
- Fallo MP o escrituras de pagos/mensualidad: HTTP 500 y reentrega recuperable.
- Cancelación legacy reconsulta MP, protege dueño local y conserva precio del alta.
- Metadata nueva sin los campos payer/card del proveedor.

Límites: request/response de Express simulados, sin red HTTP real ni PostgreSQL.
La suite anterior de 31 reproducciones documenta defectos históricos y no se
presenta como regresión vigente. Siguen pendientes acceso por periodos, gracia,
reembolsos, carreras entre facturas, alta duplicada y reparación histórica.
El detalle y la configuración están en [IMPLEMENTACION_PAGOS_FASES.md](IMPLEMENTACION_PAGOS_FASES.md).

## Entrega de fases 3–4, con reglas comerciales confirmadas

Resultado final: **81 tests aprobados, 0 fallidos, 0 omitidos**, Node v24.18.0,
`npm.cmd test` desde `backend`. Comprobación de sintaxis de backend/frontend y
`git diff --check` satisfactorias.

Se agregó PGlite 0.5.8 como dependencia de desarrollo, con versión fija y lockfile.
La migración real se ejecuta en PostgreSQL embebido; las RPC usan sus funciones
SQL y restricciones, no una imitación en JavaScript. Las consultas PostgREST,
SDK/HTTP de MP y DOM siguen simulados. Los módulos de aplicación se cargan sin
transformar su código y sin cargar `.env` durante la suite.

Cobertura adicional:

- Reservas SQL competitivas, token obsoleto, expiración anterior al envío y
  bloqueo posterior al envío incierto. Solo una llamada remota de alta simulada.
- Consulta fallida del trial sin creación; inicio posterior al trial; acuerdo
  autorizado reutilizable; cancelación repetida y respuesta perdida confirmada con GET.
- Cancelación conserva periodo pagado. Un registro histórico inválido no impide
  cancelar otros acuerdos verificables, pero la respuesta informa el resultado incompleto.
- Ciclos 28/29/30/31 días, cambio de año, ancla ausente y desfase horario de MP.
- Gracia exactamente hasta siete días desde vencimiento, no en rechazo inicial
  ni pending. Replay antiguo no borra el fallo de la siguiente factura.
- Aprobación tardía conserva el periodo facturado; evento viejo de preapproval
  no acorta periodos ni reactiva recurrencia cancelada.
- Reembolso total y contracargo revocan el pago; parcial conserva acceso y marca
  revisión; un trial independiente sobrevive. Rol admin no se degrada por estos eventos.
- Un trigger de fallo SQL fuerza rollback después de insertar el registro del
  pago y antes de completar historial. La transacción revierte y la reentrega funciona.
- Roles anon/authenticated no ejecutan RPC financieras ni leen tablas nuevas;
  service_role sí opera. Funciones SECURITY INVOKER y RLS habilitado.
- Precio de sesión extra congelado antes de preferencia; cambio de catálogo no
  cambia la validación. Conflicto real de índices entre pago antiguo aprobado y
  pedido nuevo pending resuelto conservando historial. Segundo aprobado se marca
  para revisión; reembolsar uno no elimina el otro pago válido.
- Estado HTTP con fechas nulas, checkout pending frente a authorized programado;
  DOM del dashboard y flujo compartido precios/dashboard con un solo POST en curso.

Fuera de la suite se consultó por GET el OpenAPI de Supabase para los tipos de
las tablas y, por GET, las fechas de un acuerdo/factura ya investigados de MP.
No hubo cobros, cancelaciones, webhooks de prueba ni escrituras remotas. Las fechas
reales mostraron un cruce de medianoche UTC entre creación y débito, incorporado
a la regresión. La causa privada de `cc_rejected_high_risk` no cambia por ello.

PGlite utiliza una conexión; estas pruebas **no certifican contención entre
conexiones independientes**, el esquema remoto completo ni el despliegue HTTP.
Fase 5 conserva integración en Supabase/PostgreSQL aislado, varias conexiones,
advisors y navegador. Fase 6 conserva conciliación y reparación histórica.
La migración **no está aplicada en producción**; no desplegar el backend nuevo
sin migración y conciliación de pagos históricos.

## Entrega de fase 5 — 2026-10-03

Resultado: **102 tests aprobados, 0 fallidos, 0 omitidos**, Node v24.18.0:

- `npm.cmd test`: 88 tests; incluye cinco pruebas por HTTP local real y dos
  nuevas regresiones de pedidos extra.
- `npm.cmd run test:postgres`: 14 tests sobre PostgreSQL nativo 18.4.
- `npm.cmd run test:pagos`: comando que encadena ambas suites.

La nueva suite inicia un clúster temporal exclusivo, sin `.env` ni URLs remotas,
y usa conexiones con `pg_backend_pid` distintos. Las funciones de negocio se
ejecutan como service_role sin superusuario. La espera real entre conexiones se
comprueba con `pg_blocking_pids` antes de confirmar/revertir la primera transacción.
El clúster se detiene y su directorio temporal se elimina después de la suite.
No hay un servicio PostgreSQL permanente.

Pruebas nuevas de integración:

1. Sesiones independientes y privilegios efectivos del backend.
2. Una sola reserva entre conexiones; recuperación tras rollback de la ganadora.
3. Replay simultáneo, carrera por payment ID entre dueños diferentes, aprobación
   contra reembolso y cancelación contra aprobación.
4. Reserva única de compra extra y rollback del pago completo ante fallo SQL.
5. Periodo sin fecha de fin e historial de otro usuario rechazados sin escritura parcial.
6. Permisos de las nueve RPC, SECURITY INVOKER, search_path y RLS de tablas nuevas,
   incluso después de conceder SELECT temporalmente a los roles cliente.
7. Migración con preapprovals duplicados revierte por completo y conserva sus filas.
8. Consulta de diagnóstico del esquema ejecutable como transacción de solo lectura.

Se reprodujeron cinco fallos nuevos antes de corregirlos: tres en PostgreSQL nativo
(carrera de identidad global, fin NULL, historial discrepante) y dos en PGlite
(pending antiguo de pedido extra y marca incompleta de dobles aprobaciones).
La migración local aún no publicada incorpora las cinco correcciones.

Las pruebas HTTP usan sockets reales, JSON parser, router y middleware de usuario
reales; Supabase Auth remoto y MP siguen simulados. Verifican 401 en todas las rutas
privadas, HMAC/ID, 500 y reentrega, historial filtrado y GET sin mutación. Las
consultas PostgREST se simulan; las RPC del resto de esa suite ejecutan SQL PGlite.
Las pruebas HTTP no arrancan `server.js`: CORS/rate limiting quedan fuera.

Límites: el esquema base comparte las restricciones conocidas con la suite previa;
no es un dump completo del proyecto. No certifica triggers/grants desconocidos,
Auth/PostgREST reales, versión/extensiones de Supabase, advisors del proyecto ni
navegador/Railway/Netlify. La consulta `supabase/diagnostico/esquema-pagos.sql`
permite obtener la estructura relevante sin leer filas de usuarios/pagos.

La fase 6 no se implementa en esta entrega: faltan esquema completo, respaldo con
restauración ensayada e inventario verificado para preparar una reparación por
registro. No se aplicó la migración ni se escribieron datos en servicios externos.

Documentación consultada: [bloqueos de PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html),
[RLS de Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security),
[PostgreSQL portátil](https://github.com/leinelissen/embedded-postgres) y
[changelog de Supabase](https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes).
El aviso de extensiones se revisó; esta migración no usa ltree, cifrado pgcrypto,
btree_gist ni operadores personalizados. El esquema completo sigue pendiente.

## Entrega de fase 6 — 2026-10-04

`npm.cmd run test:pagos`: **122 aprobados, 0 fallidos, 0 omitidos**.
Suite principal 106; PostgreSQL nativo 16. CLI `--help` ejecutado sin cargar
credenciales ni conectarse a servicios. No se añadieron dependencias en esta fase.

Las 18 pruebas nuevas de la suite principal cubren: diagnóstico sin escrituras
ni datos privados, reparación del acuerdo falso y conservación del historial,
idempotencia, reversión exacta antes de replay, snapshot/evidencia MP obsoletos,
rollback al fallar auditoría, recuperación de alta, ausencia/ambigüedad/fallo MP,
preferencia recuperada, extra histórico verificado, job en simulación y con replay,
reintento tras fallo, paginación, permisos, inventario incompleto y plan manipulado.

Dos pruebas nuevas de PostgreSQL nativo comprueban la espera real entre
reparaciones concurrentes, rechazo del snapshot perdedor y bloqueo de reversión
tras un pago posterior. La inspección de permisos ahora cubre doce RPC y las
cinco tablas nuevas de fases 3–6. La consulta de esquema incluye la auditoría.

La migración `20261004165326_conciliacion_pagos.sql` se ejecutó solamente en
bases temporales junto con la anterior. Se probó la restauración de los snapshots
estructurales de fixtures, **no la restauración de un respaldo productivo**.
No se aplicaron cambios en Supabase ni se activó un scheduler en Railway.
El esquema completo, los advisors remotos y la aplicación a los registros reales
siguen pendientes. Los comandos y el procedimiento están en
[CONCILIACION_PAGOS.md](CONCILIACION_PAGOS.md).

## Entrega de fase 7 — 2026-10-04

`npm.cmd run test:pagos`: **134 aprobados, 0 fallidos, 0 omitidos**.
Suite principal 117; PostgreSQL nativo 17. Se añadieron doce pruebas:

- Dos del adaptador con el SDK oficial 3.6.1 instalado y fetch simulado: métodos,
  rutas, respuestas directas, cancelación PUT, claves estables distintas en altas
  simultáneas y ausencia de reintento de POST ante 503.
- Seis de minimización/historial: objeto y JSON serializado, tipos inválidos,
  referencias anidadas incluso con campos superiores nulos, trigger para nuevas
  escrituras, simulación/lotes/idempotencia sin alterar columnas financieras,
  permisos y contrato público con estados terminales correctos.
- Tres de configuración y HTTP: variables de producción, HTTPS, errores sin
  valores privados, CORS/preflight/Helmet, JSON inválido y cuotas separadas para
  navegación y webhook incluso con mayúsculas/barra final. Usan el middleware
  extraído de server.js, router real y sockets locales; no arrancan el despliegue.
- Una de PostgreSQL nativo: dos conexiones limpian filas distintas con SKIP LOCKED;
  se conserva el importe total y la siguiente simulación no detecta pendientes.

La inspección de permisos ahora incluye quince funciones de fases 3–7, con
SECURITY INVOKER y search_path vacío. Las tres migraciones se ejecutan solamente
en fixtures PGlite y clúster PostgreSQL temporal. La prueba de historial HTTP
comprueba la lista exacta de siete campos y el filtro del usuario autenticado.

La actualización de SDK reduce la auditoría productiva de nueve avisos (dos
críticos) a tres moderados de qs/Express; su actualización aparte queda en el plan.
No certifica el árbol de desarrollo ni corrige por sí misma cc_rejected_high_risk.
No se aplicó limpieza remota ni se enviaron cobros. Siguen pendientes esquema
completo/advisors/respaldo real, Auth/PostgREST y navegador/topología de hosting.
La guía de activación y límites está en [FASE_7_PAGOS.md](FASE_7_PAGOS.md).
