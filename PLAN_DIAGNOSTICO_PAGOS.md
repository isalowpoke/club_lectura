# Diagnóstico y plan de corrección de pagos

Estado: diagnóstico técnico documentado; señal antifraude específica pendiente de MP.
Pasos 1–4 desarrollados localmente; reglas comerciales confirmadas. Ver alcance en
[IMPLEMENTACION_PAGOS_FASES.md](IMPLEMENTACION_PAGOS_FASES.md).
Revisión ampliada: 31 casos aislados ejecutados; resultados en
[REVISION_PAGOS_TESTS.md](REVISION_PAGOS_TESTS.md). Los tests reproducen fallos,
no certifican que la aplicación esté lista para producción.
Regresión posterior a fases 3–4: 81 tests aprobados, con SQL real en PGlite y
proveedor simulado. El informe distingue esta suite de las 31 reproducciones históricas.
Rama autorizada: `develop`. El usuario autorizó los pasos 1–2 y después 3–4.
No se han modificado datos productivos ni desplegado cambios. La migración está
preparada y probada localmente; su aplicación y conciliación histórica siguen pendientes.
Evidencia: `logs.md`, código local y consultas GET a Mercado Pago y SELECT a Supabase.
Referencia temporal: intento del 2026-10-03 00:00:45 UTC (2026-10-02 18:00:45 CDMX).
No guardar credenciales, datos de tarjeta ni respuestas completas con datos personales.

## Resultado confirmado del intento

- Pago `182112414620`: HTTP 200 en consulta; `live_mode=true`, `status=rejected`,
  `status_detail=cc_rejected_high_risk`, $80 MXN, `debit_card` / `debvisa`.
- Factura `7032514313`, localizada con `authorized_payments/search?payment_id=182112414620`:
  `payment.id=182112414620`, `payment.status_detail=cc_rejected_high_risk`,
  `status=recycling`, `retry_attempt=1` en el momento de consultar.
- Preapproval vinculado: `e79efdbed3714d839080b38916d1d32e`.
  Consultado directamente: `status=cancelled`.
- Supabase conserva una fila mensual `pending` con ese preapproval y otra `pending`
  con `mp_sub_id=182112414620`, fechas de inicio/fin nulas y `failed_at` informado.
- El pago no trae `preapproval_id` en la raíz. Su relación se obtiene de la factura.
- Los IDs de pagador y cobrador del pago son distintos. Esto no confirma la
  titularidad de las tarjetas ni descarta otras relaciones entre las cuentas.

Conclusión: el rechazo está clasificado como riesgo por Mercado Pago. La API no
expone la señal específica que lo causó. Los errores internos siguientes afectan
el procesamiento posterior; corregirlos no garantiza aprobación del cobro.
Un HTTP 429 anterior no demuestra la causa de este rechazo. Cancelar preapprovals
no debe interpretarse como reinicio del historial antifraude.

### Ampliación con los datos añadidos a logs.md

- El usuario confirma tarjetas reales de BBVA y Nu México; ambas tarjetas y la
  cuenta del negocio pertenecen a él. Ya no tenía mes gratis.
- Segundo pago consultado: `182052837522`, producción, $80 MXN,
  `debit_card/debmaster`, `rejected/cc_rejected_high_risk`.
  Fecha: 2026-10-02 19:15:57 UTC (13:15:57 CDMX).
- Factura `7032502522`, `payment.id=182052837522`, preapproval
  `15ff9941505c4d559cbeb203c040bc4a`, actualmente `cancelled` en MP.
  La búsqueda de factura confirma que el pago corresponde al preapproval aportado.
- No se asigna cada banco a una marca de tarjeta sin confirmación del usuario.
- La diferencia entre payer_id y collector_id observada antes no descarta que
  una misma persona sea titular de las tarjetas y del negocio.

Hipótesis prioritaria: los intentos de cobro a tarjetas del propio vendedor pueden
estar relacionados con la evaluación de riesgo. Es una inferencia por el contexto,
no un motivo específico expuesto por la API. Dos bancos con el mismo rechazo no
demuestran un defecto general de soporte de débito ni dos bloqueos bancarios
independientes. No repetir pruebas de autopago para intentar validar la integración.

La cancelación descrita en logs se hizo en MP mediante PUT /preapproval/{id}
con status=cancelled, previa consulta del estado. Se reportan 19 preapprovals
históricos, mayoritariamente cancelados; ese número no demuestra por sí solo la
causa del antifraude. El POST /preapproval/{id}/cancel reportado devolvió 404;
no confundir esa prueba manual con el comportamiento del SDK sin inspeccionarlo.
Los logs prueban sincronización de dos cancelaciones específicas a la BD, pero
no prueban que todas las cancelaciones de todos los intentos se sincronizaran.

## Hallazgos y trabajo pendiente

### P1-01. Lectura incorrecta del pago de una factura — confirmado

`procesarWebhookSuscripcionPagoAutorizado` lee `authorizedPayment.payment_id`.
La respuesta real y el contrato oficial entregan `payment.id`. Esto reproduce
el error de logs `Pago autorizado sin payment_id`.

- [x] Leer el contrato real de factura y conservar su `preapproval_id` al procesar el pago.
- [x] Distinguir una factura todavía sin pago de un error de consulta; no inventar IDs.
- [x] Validar que pago, factura y suscripción correspondan antes de actualizar acceso.
- [x] Probar fixtures del contrato observado, factura sin pago, rechazo y aprobación.

### P1-02. ID de pago utilizado como ID de suscripción — confirmado en BD

`procesarPagoSuscripcion` usa `payment.preapproval_id || payment.id`.
Para este pago crea una suscripción falsa identificada por el pago. Esto también
puede enviar un ID de pago a la API de preapprovals al reutilizar o cancelar.

- [x] Resolver la suscripción mediante la factura, también para eventos `payment`.
- [x] Eliminar el fallback de identidad a `payment.id`.
- [x] No crear ni activar una suscripción cuando su relación no esté verificada.
- [x] Probar ambos tipos de webhook, entregas repetidas y orden inverso/concurrente:
  un pago debe afectar una única suscripción real (adaptadores simulados; BD real en fase 5).

### P1-03. Cancelación no idempotente y estado local divergente — confirmado

Los logs muestran `You can not modify a cancelled preapproval`. El flujo aborta
antes de sincronizar Supabase. El preapproval investigado está cancelado en MP
y pendiente en BD. No se atribuye toda divergencia a una sola causa sin historial.

- [x] Consultar estado remoto; si ya está cancelado, completar la sincronización local.
- [x] Ante error al cancelar, verificar estado remoto antes de decidir el resultado.
- [x] No convertir errores de red, permisos o IDs incorrectos en una cancelación exitosa.
- [x] Seleccionar suscripciones reales del plan mensual; definir el tratamiento de
  múltiples registros pendientes sin elegir arbitrariamente por orden de ID.
- [ ] Probar doble cancelación, cancelación desde MP, timeout y conservación del trial.

### P1-04. Webhook confirma éxito HTTP cuando el procesamiento falla — confirmado

`routes/pagos.js` responde HTTP 200 incluso en excepciones y `success:false`.
MP interpreta el HTTP 200/201 como confirmación de recepción; el cuerpo false
no solicita un reintento. No existe una cola durable que garantice recuperación.

- [x] Devolver error recuperable cuando falle procesamiento/persistencia, o confirmar
  recepción únicamente tras guardar duraderamente el evento para procesarlo.
- [x] Mantener idempotencia para entregas repetidas; conservar rechazo de firmas inválidas.
- [x] Distinguir eventos ignorables de fallos transitorios y de facturas sin pago aún.
- [x] Probar fallo temporal de MP/BD y recuperación sin duplicar acceso ni registros.

### P1-05. Errores de BD descartados — confirmado por lectura

Varias consultas/escrituras de `procesarWebhookMercadoPago`,
`procesarPagoSuscripcion`, cancelación y sincronización de preapproval no comprueban
`error`. Pueden informar procesamiento exitoso aunque la persistencia haya fallado.

- [x] Comprobar y propagar errores en el flujo de pagos; no emitir éxito antes de verificar escrituras.
- [x] Revisar atomicidad, restricciones e idempotencia antes de diseñar cambios de esquema.
- [x] Probar fallo de persistencia, rollback de la transacción y reentrega posterior.

### P1-06. Reparación de registros afectados y reconciliación — pendiente de diseño

Hay evidencia de una fila con ID incorrecto y una fila desincronizada. No se han
modificado ni borrado. Corregir solo el código no arreglará estos datos históricos.

- [ ] Inventariar de forma acotada las relaciones pago/factura/preapproval afectadas.
- [ ] Preparar una propuesta revisable por registro, conservando el historial de pagos.
- [ ] Respaldar datos afectados y definir reversión antes de cualquier reparación.
- [ ] Aplicar reparación solo en la etapa de implementación autorizada.
- [ ] Diseñar reconciliación que recupere notificaciones perdidas sin conceder acceso
  únicamente porque un preapproval esté `authorized`.

### P2-01. Diagnósticos engañosos y SDK obsoleto — confirmado

El SDK instalado emite el mensaje de obsolescencia de `getPayment` mediante
`console.warn`; no es por sí mismo una excepción ni explica el rechazo.
El mensaje `acceso conservado (gracia 7 dias)` se emite también al insertar una
suscripción `pending` sin acceso. No demuestra que se haya concedido una gracia.

- [ ] Registrar campos técnicos mínimos: IDs correlacionados, status, status_detail
  y resultado real de persistencia, sin PII ni credenciales.
- [ ] Corregir el mensaje de gracia para distinguir rechazo inicial y renovación.
- [x] Fase 7 local: SDK actualizado a 3.6.1 mediante adaptador; pruebas con el SDK
  instalado para creación, consulta, cancelación PUT e idempotencia concurrente.

### P2-02. Estados y orden de eventos de renovación — riesgo confirmado en código

Todo estado distinto de `approved` asigna `failed_at`, incluso `pending`.
Un replay aprobado antiguo limpia `failed_at` sin comprobar si el fallo pertenece
a una renovación posterior. La gracia exige además `end_date >= ahora`, por lo
que no extiende automáticamente siete días desde una renovación fallida al vencer.

- [x] Definir política explícita para pending/in_process, rechazo, reembolso y contracargo.
- [x] Vincular fallos y aprobaciones con el periodo/factura correspondiente.
- [x] Acordar si la gracia extiende acceso después del vencimiento o solo lo conserva
  dentro del periodo pagado; ajustar documentación y pruebas a esa decisión.
- [x] Probar eventos fuera de orden y fallo justo al vencimiento.

### P2-03. Dashboard frente a fechas nulas — riesgo confirmado en código

`GET /estado` llama a `interpretarFechaUtc(pendiente.init_date).getTime()` sin
comprobar null. La fila incorrecta observada tiene `init_date=null`. Si resulta
seleccionada, el endpoint falla con 500; no se ha reproducido por HTTP en esta revisión.

- [x] Tolerar registros incompletos sin inventar fecha de cobro.
- [ ] Probar fila pendiente sin fecha y varias filas históricas.

La revisión ampliada reprodujo el HTTP 500 en el handler, con dependencias
simuladas (T12). No fue necesario ejecutar una petición autenticada en producción.

## Hallazgos adicionales de la revisión previa a implementar

### P1-07. Creaciones duplicadas y protección desigual contra reintentos

T06, T07 y T25 reproducen: dos solicitudes simultáneas pueden llamar dos veces
a crear preapproval; una suscripción mensual `active` se ignora al buscar acuerdos
reutilizables; y el botón de precios usa `Pagos.iniciarCheckoutSuscripcion`, sin
el bloqueo que sí tiene `Auth.crearPagoSuscripcion`. El bloqueo de Auth vive en
memoria de la página y tampoco coordina pestañas ni solicitudes directas al API.

- [x] Serializar/reservar la creación por usuario en el backend y cubrir múltiples
  instancias del servidor; no confiar exclusivamente en deshabilitar botones.
- [x] Comprobar acuerdos activos y autorizados antes de permitir otra alta.
- [x] Unificar las dos funciones frontend y sus estados de solicitud en curso.
- [ ] Si se considera idempotency-key en MP, verificar primero su contrato para
  `/preapproval`; no asumir que funciona igual que `/v1/payments`.
- [ ] Probar concurrencia, recarga y dos pestañas; una sola creación remota.

La duplicación de llamadas quedó demostrada contra un adaptador simulado; no se
crearon acuerdos reales. La prevención de duplicados es relevante para el riesgo,
pero no demuestra qué provocó los dos rechazos históricos.

### P1-08. Error al consultar el trial permite alta con cobro inmediato

T08: al fallar la consulta de prueba gratis, el servicio descarta `error` y crea
el acuerdo sin `start_date`, aunque el fixture tenga trial vigente.

- [x] Abortar la creación cuando no se puede determinar la fecha de cobro.
- [x] Distinguir ausencia de trial de fallo de BD; varias pruebas válidas conservan el mayor vencimiento.
- [x] Probar que un fallo de consulta no produzca ningún alta remota.

### P1-09. La firma y el procesamiento pueden referirse a distintos recursos

T18: la firma se valida usando `query['data.id']`, pero el handler procesa
`body.data.id`. Una firma válida para A permite consultar/procesar B si difieren.
T23: la rama legacy `subscription_cancelled` modifica la BD sin reconsultar MP;
el tipo del evento no está incluido en el manifiesto HMAC actual.
T19: si falta el secreto, se omite la validación incluso con NODE_ENV=production.

- [x] Normalizar un único ID y rechazar discrepancias entre query y body.
- [x] Procesar únicamente el recurso cuya identidad se verificó.
- [x] Eliminar o revalidar contra MP la rama legacy de cancelación.
- [x] Impedir operación del webhook sin el secreto requerido (HTTP 503).
- [x] Mantener pruebas de firma válida/inválida y añadir recursos/tipos discrepantes.

No se observó una explotación real. El pago aún se consulta a MP, por lo que esto
no permite asumir que cualquier JSON de pago inventado sea aceptado. El secreto
sí estaba configurado en las entregas productivas observadas.

### P1-10. Falta validar el pago contra las condiciones de la compra

T13 ejecuta tres fixtures independientes: importe 0.01 MXN, moneda USD y
`live_mode=false`; cada uno activa la mensualidad si MP responde `approved`.

- [x] Validar ambiente, importe/moneda acordados y relación usuario/factura/preapproval en mensualidades.
- [x] Verificar el cobrador/aplicación cuando corresponda al contrato y los campos
  realmente disponibles; no confundir payer con usuario autenticado del club.
- [x] Conservar el precio mensual registrado en el alta; moneda contractual MXN fija.
- [ ] Versionar condiciones antes de introducir cambios de precio/moneda en acuerdos existentes.
- [x] Rechazar discrepancias antes de conceder acceso; emitir motivo técnico sin datos personales.

Son respuestas de proveedor simuladas para probar defensas; no hay evidencia de
cobros productivos con esos valores ni de que un cliente pueda fabricar dichas respuestas.

### P1-11. Vigencia y cancelación no resisten todos los órdenes de eventos

T24: un handler de preapproval lee una fecha vieja; otro pago amplía la vigencia;
el primero termina después y la vuelve a acortar. El máximo calculado en JS no
es una garantía atómica. T15: un replay aprobado vuelve a poner `active` sobre
una fila cancelada. T17: sin `date_approved`, se calcula el periodo desde ahora.

- [ ] Hacer atómica la extensión y asociarla al pago/factura que la justifica.
- [ ] Separar permiso de cobro recurrente y acceso por un periodo ya pagado; no
  hacer que un replay parezca reactivar un acuerdo cancelado en MP.
- [ ] No inventar fecha de aprobación; recuperar información o dejar el caso pendiente.
- [ ] Cubrir estas carreras junto con T10 (pago viejo limpia fallo nuevo).

### P1-12. Conflicto único de sesión extra tratado como éxito sin resolverlo

T22: si hay una compra `pending` para la sesión y otro pago aprobado intenta
insertarse, el error `23505` se trata como éxito aunque no sea un replay del mismo
mp_pay_id. La compra previa puede permanecer pendiente. La prueba inyecta el
error documentado por la restricción parcial; falta validación contra esquema local.

- [ ] Distinguir conflicto del mismo pago y conflicto de otra compra de la sesión.
- [ ] Resolver y registrar el pago aprobado, evitando doble cobro o pérdida de acceso.
- [ ] Verificar las restricciones reales en una BD de pruebas antes de implementar.

### P2-04. Checkout incompleto presentado como cobro programado

T20: una fila local `pending` con inicio futuro activa `pago_programado`, aunque
el preapproval siga `pending` en MP y el usuario no haya autorizado un medio.
La página de precios deshabilita su botón al recibir ese indicador.

- [ ] Distinguir checkout abierto, acuerdo autorizado, cobro programado y cobro fallido.
- [ ] Permitir continuar el checkout existente mientras falte autorización.
- [ ] No inferir autorización únicamente a partir de la fecha de una fila local.

### P2-05. Mes calendario y 30 días no son equivalentes

T16: pago el 1 de enero vence localmente el 31 de enero; una recurrencia mensual
no equivale a sumar 30 días. Puede dejar huecos o extender acceso indebidamente.

- [x] Basar la vigencia en el periodo facturado y la recurrencia real del acuerdo.
- [x] Probar meses de 28/29/30/31 días y cobros tardíos sin acumular deriva.

Ampliación en fase 4: creación y débito reales separados por menos de dos minutos
cruzan medianoche UTC. Se conserva el desfase del ancla de MP para determinar el
ciclo civil, almacenando sus límites en UTC. Caso cubierto por regresión.

### P2-06. Exceso de datos del proveedor en persistencia e historial

T21: `metadata=JSON.stringify(payment)` se persiste y `/historial` devuelve `*`,
incluido el objeto completo. La prueba usa PII ficticia. No se afirma exposición
entre usuarios: la ruta filtra por el usuario autenticado.

- [x] Fase 7 local: lista mínima tipada de metadata y contrato de siete campos
  del historial público, con estado traducido por el backend.
- [x] Fase 7 local: trigger descarta campos privados nuevos; el historial excluye
  metadata y futuras columnas no permitidas.
- [x] Limpieza histórica implementada con simulación, lotes, permisos de backend
  y conservación de referencias verificadas en tests.
- [ ] Aplicar limpieza en el ambiente elegido después de respaldo/conciliación;
  regenerar planes porque la reducción de metadata cambia los snapshots.

## Investigación complementaria de cc_rejected_high_risk

1. MP documenta rechazo por patrones sospechosos y, en Checkout Pro, pagos muy
   similares/consecutivos. P1-07 muestra una fuente interna de solicitudes duplicadas;
   sigue sin existir prueba causal para estos rechazos concretos.
2. El mismo titular de tarjetas y negocio sigue siendo una hipótesis a consultar.
   La revisión no encontró una fuente oficial específica que permita afirmar que
   ese dato explica estos dos pagos. No convertirlo en diagnóstico definitivo.
3. La documentación de Suscripciones recomienda Device ID y datos suficientes.
   El frontend del club no carga `security.js` ni el SDK JS de MP. Sin embargo,
   la captura y el pago ocurren en el checkout alojado de MP: esta ausencia local
   NO demuestra que MP careciera del identificador en esos intentos. Confirmar con
   MP la instrumentación aplicable a `preapproval pending + init_point` antes de
   agregar headers/campos de la API de pagos a un endpoint distinto.
4. GET /users/me en esta revisión devolvió `site_id=MLM`, `site_status=active`,
   `sell.allow=true`, `buy.allow=true`, sin códigos de restricción y email confirmado.
   Esto no revela reglas antifraude privadas ni garantiza autorización transaccional.
5. El SDK instalado implementa `preapproval.cancel` mediante PUT /preapproval/:id
   con status cancelled. Se descarta que el backend use el POST inexistente de
   la prueba manual como explicación del error de cancelación.

- [ ] Añadir a la consulta a MP: señales disponibles para el checkout alojado,
  evaluación de los dos payment IDs y condiciones para una verificación válida.
- [ ] No recomendar rotar cuentas, identidades o dispositivos para eludir riesgo.
  No hay evidencia de un plazo universal de desbloqueo ni de una corrección que
  garantice aprobación. Corregir primero las duplicaciones y la gestión de estados.

## Datos pendientes para cerrar la investigación del rechazo

- [x] Bancos, país y titularidad: BBVA y Nu México, tarjetas y negocio del mismo titular.
- [x] Método de cancelación descrito: consultas GET y cancelación remota PUT.
  La secuencia aportada cubre operaciones específicas, no todo el historial.
- [x] Segundo intento consultado y vinculado: mismo status_detail de riesgo.
- [ ] Obtener de MP el motivo específico y las condiciones para una prueba válida.
  Consulta a soporte preparada abajo; no enviada.

### Verificación adicional: solicitudes al webhook sin firma válida

Logs del 2026-10-02 19:22:14 UTC muestran ausencia de x-signature y falta de ts/v1.
No incluyen identificación suficiente para vincularlos al segundo pago ni confirmar
su origen. Rechazar una solicitud sin firma válida es el comportamiento esperado.

- [x] El usuario aclara que solo la cancelación de preapprovals fue manual;
  no hizo pruebas manuales del webhook. Los pagos fueron intentos reales y los
  rechazos aparecen en la app de Mercado Pago. Esto no identifica por sí solo
  al emisor de las solicitudes HTTP sin firma ni las vincula con esos pagos.
- [ ] Contrastar el historial de Webhooks del panel con
  fecha, tópico, data.id, x-request-id y estado HTTP, sin publicar firmas ni secretos.
  Buscar el 2026-10-02 a las 19:22:14 UTC (13:22:14 CDMX). Si no hay entrega
  coincidente, no atribuir esas solicitudes a MP sin otra evidencia.
- [ ] Revisar si llegan IPN u otro formato al mismo endpoint antes de cambiar validación.
- [ ] Mantener obligatoria la validación; no desactivarla para hacer pasar los avisos.

### Evidencia del historial de Webhooks aportada después

El usuario informa que solo ve una notificación, marcada `200 - entregada`:

- `type=payment`, `action=payment.created`, `api_version=v1`, `live_mode=true`.
- `data.id=182112414620`, el pago ya consultado con `cc_rejected_high_risk`.
- `date_created=2026-10-03T00:00:45Z`: equivale al 2 de octubre a las
  18:00:45 en CDMX (UTC-6). La diferencia de fecha es coherente con UTC.
- URL configurada: https://clublectura-production.up.railway.app/api/pagos/webhook.
- Categorías activadas reportadas: Planes y suscripciones, Pagos (legacy).

Esto confirma una entrega del evento del pago al backend. `payment.created` no
significa pago aprobado y `200 - entregada` no confirma actualización correcta de
Supabase: el código devuelve 200 también cuando falla (P1-04). Tampoco prueba
que esta entrega concreta fallara internamente; el error de factura pertenece a
otro tipo de evento (`subscription_authorized_payment`).

La notificación aportada no coincide con los avisos de firma de las 19:22:14 UTC;
es posterior y no aporta sus headers. No hay evidencia suficiente para atribuir
aquellos avisos a una entrega real de MP ni para declarar defectuosa la firma.
Este punto queda pendiente de observabilidad, sin bloquear las correcciones ya
confirmadas y sin pedir al usuario repetir una búsqueda que no produjo más datos.
No desactivar validación ni cambiar categorías por el mero nombre `legacy`:
el evento recibido usa la Payments API v1 que consume esta integración.

### Consulta preparada para soporte de Mercado Pago (no enviada)

> Integramos Suscripciones sin plan asociado mediante /preapproval y checkout
> alojado. Dos pagos reales de $80 MXN fueron rechazados con cc_rejected_high_risk:
> 182052837522 (2026-10-02 19:15:57 UTC, factura 7032502522, preapproval
> 15ff9941505c4d559cbeb203c040bc4a) y 182112414620 (2026-10-03 00:00:45 UTC,
> factura 7032514313, preapproval e79efdbed3714d839080b38916d1d32e).
> Se usaron tarjetas de débito de BBVA y Nu México del mismo titular de la cuenta
> vendedora. Ambos preapprovals están cancelados. ¿Pueden confirmar si la relación
> entre titular y vendedor motivó el bloqueo, si existe alguna restricción de la
> cuenta/aplicación y cuál es el procedimiento válido para verificar esta integración?

No afirmar que cambiar de tarjeta, esperar un plazo fijo o corregir el webhook
garantizará la aprobación. Una futura compra real de un cliente distinto debe
esperar a que la integración procese y registre correctamente el resultado.

## Orden propuesto de implementación posterior

El detalle técnico, alcance implementado y criterios de salida están en
[IMPLEMENTACION_PAGOS_FASES.md](IMPLEMENTACION_PAGOS_FASES.md).
Pasos 1–4 implementados localmente. El contrato comercial fue confirmado; la
validación cubre mensualidades y nuevas preferencias extra. Las RPC reemplazan
escrituras parciales por transacciones. P2-06 conserva pendiente la limpieza
histórica; fases 5–6 deben preceder a la activación productiva de la migración.
La fase 5 agrega PostgreSQL nativo con conexiones independientes y HTTP real del
router. La concurrencia local ya está validada. Siguen pendientes el contraste del
esquema completo de Supabase, sus advisors y la revisión en navegador/configuración
del despliegue. La fase 6 se implementó localmente el 2026-10-04: diagnóstico,
reparaciones auditadas, reversión protegida y runner periódico. Su aplicación al
proyecto espera esquema contrastado, inventario real y respaldo restaurado/verificado;
no se repararon registros remotos. Ver [CONCILIACION_PAGOS.md](CONCILIACION_PAGOS.md).

La fase 7 se implementó localmente el 2026-10-04: SDK 3.6.1, historial mínimo,
trigger y CLI de limpieza, validación de configuración y pruebas HTTP reales.
Total actual: **134 tests aprobados**. Ver [FASE_7_PAGOS.md](FASE_7_PAGOS.md).
Su limpieza, revisión en navegador y activación remota permanecen pendientes.

### Pendientes detectados al cerrar fase 7

- [ ] Actualizar de forma compatible Express/body-parser/qs y volver a probar
  HTTP. `npm audit --omit=dev` pasó de 9 avisos (2 críticos) a 3 moderados tras
  actualizar MP; los restantes proceden de qs (GHSA-x5fp-wj9c-mxmx y
  GHSA-4mjr-xmp4-gh2g). Revisar también los cuatro avisos altos del árbol de
  desarrollo por separado. No se ejecutó audit fix --force.
- [ ] Verificar `trust proxy=1` en la topología real de Railway y número de réplicas:
  la cuota actual se guarda por proceso. La suite local no certifica esa topología.

### Hallazgos adicionales de fase 5 — corregidos localmente

- [x] F5-01: carrera entre usuarios por el mismo payment ID permitía alterar el
  registro ganador mediante ON CONFLICT. Bloqueo transaccional global por pago
  y comprobación de identidad posterior a la espera.
- [x] F5-02: CHECK de periodo aceptaba fecha fin NULL. Se exige explícitamente.
- [x] F5-03: historial previo con dueño/compra discrepante podía quedar mezclado
  con el registro verificado. Ahora falla la transacción y conserva la evidencia.
- [x] F5-04: pending de pedido extra antiguo podía violar unicidad al reactivarlo
  mientras había otro vigente. Se registra sin desplazar al pedido nuevo.
- [x] F5-05: aprobaciones de pedidos extra distintos solo marcaban uno para
  revisión. Se marcan todos los aprobados vigentes correspondientes.

Las pruebas fallaron antes de cada corrección y pasan después. Resultado:
88 tests principales + 14 de PostgreSQL nativo, **102 aprobados**.
Estos errores de persistencia no demuestran la causa del rechazo antifraude de MP.

1. Definir periodos, gracia, reembolsos y diferencia entre cancelar recurrencia y acceso pagado.
2. Corregir firma/recurso, vínculo factura/pago/suscripción y validación de la compra.
3. Evitar altas duplicadas/adelantadas y hacer idempotente la cancelación.
4. Corregir persistencia, respuesta HTTP, carreras, orden de eventos y estados del dashboard.
5. Convertir reproducciones en tests de regresión que exijan comportamiento correcto;
   ejecutar también pruebas de integración con una BD aislada y restricciones reales.
6. Revisar y aplicar reparación histórica; incorporar reconciliación.
7. Reducir metadata, actualizar SDK y documentación; verificar en develop antes de deploy.

## Fuentes oficiales

- Factura y objeto `payment.id`:
  https://www.mercadopago.com.mx/developers/es/reference/online-payments/subscriptions/get-authorized-payment/get
- Búsqueda de factura por `payment_id`:
  https://www.mercadopago.com.mx/developers/es/reference/online-payments/subscriptions/authorized-payment-search/get
- Confirmación HTTP de webhooks:
  https://www.mercadopago.com.mx/developers/es/docs/checkout-pro-preferences/additional-content/notifications/webhooks
- Rechazos de suscripciones:
  https://www.mercadopago.com.mx/developers/es/docs/subscriptions/how-tos/improve-payment-approval/reasons-for-rejection
- Patrones consecutivos/similares documentados para Checkout Pro:
  https://www.mercadopago.com.mx/developers/es/docs/checkout-pro-preferences/how-tos/improve-payment-approval/reasons-for-rejection
- Device ID y aprobación en Suscripciones:
  https://www.mercadopago.com.mx/developers/es/docs/subscriptions/how-tos/improve-payment-approval/recommendations
