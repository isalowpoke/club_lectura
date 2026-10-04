# Implementación de las correcciones de pagos

Fecha: 2026-10-03; fase 7 actualizada el 2026-10-04. Rama autorizada: `develop`.
Origen: orden de siete pasos de [PLAN_DIAGNOSTICO_PAGOS.md](PLAN_DIAGNOSTICO_PAGOS.md).
Implementados localmente los pasos 1–4, la suite de fase 5 y las herramientas de
fases 6–7. Sigue pendiente contrastar el esquema completo de Supabase y ensayar un
respaldo real antes de aplicar la conciliación. No incluye despliegue ni reparación
de datos productivos.

## Fase 1. Contrato de acceso y cobro

Entregable: reglas y criterios de aceptación siguientes, aplicadas por el código de fase 4.

**Reglas comerciales confirmadas por el usuario:** conservar el periodo pagado al
cancelar y conceder siete días de gracia en una renovación fallida, junto con las
reglas de esta tabla. No se ejecutan reembolsos de dinero automáticamente.

| Situación | Regla de diseño |
| --- | --- |
| Mensualidad | Un mes calendario anclado al ciclo de facturación del acuerdo; no sumar 30 días ni sumar meses al día en que llegó el webhook. |
| Fin de mes | Para un ancla 31, usar el último día válido de febrero y recuperar el ancla 31 en marzo. Guardar instantes en UTC y mostrar fechas locales. Contrastar ancla y periodo con `debit_date` y recurrencia real de MP antes de migrar. |
| Primer pago aprobado | Otorga exclusivamente su periodo verificado; requiere identidad, importe, moneda, ambiente y fecha de aprobación verificables. |
| Checkout pendiente o acuerdo autorizado | No prueba cobro ni concede por sí mismo acceso de pago. El trial tiene su propia vigencia. |
| Pago pendiente/en proceso | No equivale a rechazo ni inicia gracia; conserva otros periodos ya pagados. |
| Primer cobro rechazado | No concede acceso ni gracia por no haber un periodo previo pagado; respeta un trial todavía vigente. |
| Renovación rechazada | Gracia de siete días desde el vencimiento del último periodo pagado, únicamente si corresponde a la siguiente factura de ese acuerdo. Reintentos y entregas tardías no reinician el plazo. |
| Cancelación/pausa de recurrencia | Detiene futuros cobros. Conserva el acceso previamente pagado hasta su vencimiento. No genera una nueva gracia ni cancela un trial independiente. |
| Reembolso total/contracargo | Invalida el derecho originado por ese pago; recalcula acceso respetando otros periodos pagados y trial válido. No ordenar devoluciones de dinero desde el webhook. |
| Reembolso parcial | Registrar el importe devuelto, conservar el periodo y derivar la decisión comercial a revisión; no prorratear días automáticamente. |
| Aprobación repetida o antigua | No amplía dos veces el mismo periodo ni borra fallos de una factura posterior. Un cobro tardío se atribuye al ciclo que pagó. |

Diseño implementado en fase 4: separar estado de recurrencia (MP), pagos/facturas y derechos
de acceso por periodo. No inferir los tres de `suscriptions.status`. Evaluar las
restricciones y migración en BD aislada antes de implementar. Criterios mínimos:
febrero bisiesto/no bisiesto, fin de mes, aprobación tardía, fallo al vencimiento,
cancelación con periodo pagado, reembolso con otro periodo válido y eventos antiguos.

## Fase 2. Identidad y validación de mensualidades

Implementada localmente en `develop`:

1. Normalizar `data.id` y tipo; rechazar diferencias entre query/body, IDs compuestos
   y números inseguros. El ID superior del aviso nunca sustituye al ID del recurso.
2. Verificar HMAC sobre el mismo ID que consumen los handlers. Sin secreto, HTTP 503;
   firma inválida, 401; recurso inconsistente, 400. Validar formato hexadecimal completo.
3. Leer `factura.payment.id` y conservar `factura.preapproval_id`. Para eventos
   `payment`, buscar la factura por `payment_id`. Exigir un resultado inequívoco;
   no seleccionar el primero de varios ni ignorar paginación adicional.
4. Consultar el preapproval y una fila mensual local existente. Comparar dueño,
   IDs y condiciones antes de registrar pagos o tocar acceso. Ningún fallback al
   ID del pago; las altas pertenecen al flujo de creación de preapproval.
5. Exigir MXN, recurrencia de un mes e importe igual al `price` registrado en el
   alta, factura y acuerdo. Los avisos de preapproval ya no sobrescriben ese precio.
   MXN permanece como contrato fijo del producto; una ampliación de monedas/precios
   requerirá condiciones versionadas, no editar acuerdos históricos a ciegas.
6. Verificar `live_mode` contra la configuración, cobrador de pago/acuerdo contra
   `/users/me` y aplicación cuando ambos recursos la informan. El pagador de MP no
   se compara con el UUID del usuario del club.
7. Revalidar contra MP la cancelación legacy. Una etiqueta de evento no es prueba
   de cancelación. No procesar preapprovals inexistentes localmente o de otro usuario.
8. Una factura `scheduled` sin pago se reconoce sin conceder acceso. Errores al
   consultar o relaciones no verificables no se confirman como procesados.

Dependencias adelantadas de fases posteriores:

- HTTP 500 ante errores propagados y comprobación del upsert de pagos y updates
  mensuales. Permite reentrega cuando MP/BD falla o la factura todavía no aparece.
  No sustituye la revisión completa de persistencia ni garantiza atomicidad.
- Metadata nueva limitada a `status_detail`, `live_mode`, `date_approved`, ID de
  factura y preapproval. Conserva correlación sin guardar la respuesta de pago con
  datos personales/tarjeta. La limpieza histórica y el contrato del historial siguen pendientes.
- Tests de regresión de este alcance se incorporan ahora; la fase 5 amplía cobertura.

Configuración del backend:

- `MERCADOPAGO_WEBHOOK_SECRET`: requerido para aceptar avisos, también localmente.
- `MERCADOPAGO_MODE`: `production` (valor predeterminado) o `test`. Debe coincidir
  con las credenciales/datos del ambiente; un valor diferente bloquea la validación.
  Las pruebas automatizadas usan objetos ficticios y no necesitan credenciales.
- Token existente: se usa para consultas de pago, factura, acuerdo y `/users/me`.
  Las consultas HTTP directas tienen timeout de cuatro segundos por solicitud;
  el presupuesto total del handler/SDK se revisará con persistencia en fase 4.

Datos históricos sin fila mensual real o con relaciones ambiguas quedan pendientes
de revisión y producen error reintentable; el webhook no inventa registros para
repararlos. La fase 2 no requirió cambios de esquema. Las fases 3–4 añaden la
migración descrita abajo; las pruebas no escribieron en servicios remotos.

## Fase 3. Altas y cancelación — implementada

- `reservas_cobros` reserva por usuario mediante INSERT/ON CONFLICT atómico.
  El token evita que un proceso cuya reserva expiró pueda enviar el POST después.
  Una reserva previa al envío vence a los 60 segundos; una marcada `enviando`
  no se libera por timeout ni fallo de persistencia, porque MP pudo crear el acuerdo.
  Esa incertidumbre bloquea otra alta y requiere la reconciliación de fase 6.
- Creación, consulta del trial y consulta de acceso fallan explícitamente ante error.
  El nuevo cobro respeta el mayor vencimiento del trial y del periodo pagado vigente.
  Se reutilizan acuerdos pending/authorized; varios acuerdos o uno pausado requieren
  revisión/cancelación antes de otra alta. No se cancela un acuerdo útil para recrearlo.
- La cancelación verifica el estado de todos los acuerdos mensuales reales del
  usuario; una cancelación ya realizada se sincroniza sin volver a cancelarla.
  Después de una respuesta fallida de cancelación se vuelve a consultar MP.
- Precios y dashboard usan la misma función frontend de suscripción, con una
  solicitud en curso por página. La garantía entre pestañas/instancias está en SQL.
- `compras_extras` conserva monto y moneda antes de crear la preferencia. Una
  preferencia existente se reutiliza; un intento sin respuesta no genera otra.

## Fase 4. Persistencia y acceso — implementada

- `pagos_verificados` guarda por payment ID el acuerdo/factura o pedido extra,
  versión del recurso MP, periodo, estado e importe reembolsado. La RPC aplica
  registro financiero, historial, compra extra y rol dentro de una transacción.
  Un fallo intermedio revierte todas esas escrituras. Las funciones comprueban
  existencia, dueño y condiciones; no se aceptan cero filas como actualización exitosa.
- Las mutaciones se serializan por usuario mediante bloqueo de fila en `users`,
  con transacciones cortas sin llamadas HTTP dentro. La recurrencia se sincroniza
  aparte con la versión `last_modified`; no sobrescribe periodos ni precio.
- El acceso consulta un snapshot SQL: periodo aprobado válido, trial o gracia de
  la renovación siguiente. Cancelación/pausa no elimina periodo pagado ni trial;
  pending no inicia gracia; reembolso total/contracargo revoca ese pago; parcial
  mantiene el periodo y marca revisión. Un replay no resucita un pago reembolsado.
- El ciclo se obtiene del ancla contractual y `debit_date`, no de la entrega ni de
  `date_approved`. Conserva el día original al pasar por febrero y fin de mes.
  Se conserva el desfase horario del ancla y se almacenan límites UTC. Se verificó
  mediante GET un acuerdo con inicio `2026-10-02T19:58:58-04:00` y factura con
  débito `2026-10-02T20:00:44-04:00`: cruzan medianoche UTC, pero pertenecen al
  mismo ciclo. El caso está en regresión. Una fecha/ancla no verificable produce
  error; no se inventa una fecha de aprobación o vigencia.
- Los pagos extra conservan todos los intentos en el historial y resuelven una
  compra vigente incluso cuando un pago antiguo se aprueba después de otro pedido.
  Varios cobros aprobados se marcan para revisión; no se devuelven automáticamente.
  Esto corrige registro/estado; no amplía el alcance del acceso a contenido extra
  aplazado explícitamente en PLAN_FASES.md.
- Dashboard distingue checkout incompleto, acuerdo autorizado, cobro pendiente,
  rechazo, gracia y recurrencia detenida. Las fechas nulas son válidas y no implican
  un cobro programado. Cancelar refresca el estado sin eliminar acceso en memoria.
- Webhooks usan cuota separada de navegación. HMAC sigue obligatorio; fallos de
  procesamiento responden 500. Cada llamada MP tiene un límite de cuatro segundos.

### Migración y orden de activación

Archivo generado con la CLI de Supabase:
`supabase/migrations/20261003180231_pagos_reservas_y_periodos.sql`.
Probado sobre PGlite 0.5.8 y PostgreSQL nativo 18.4 con conexiones independientes;
**no aplicado en Supabase**. La migración todavía no publicada incorpora las
correcciones descubiertas en fase 5; no se reescribió una migración ya desplegada.

1. Completar el contraste del esquema real en Supabase aislado y sus advisors.
   La concurrencia entre conexiones y los permisos SQL ya se probaron localmente.
   El esquema de prueba reproduce tipos leídos del OpenAPI y restricciones
   documentadas; no es un dump completo.
2. Preparar respaldo y revisar datos históricos en fase 6. El índice único de
   preapproval rechaza duplicados; no elimina ni combina filas por su cuenta.
3. Aplicar la migración al ambiente elegido antes del backend nuevo. Restaurar
   los pagos/periodos históricos desde evidencia MP y revisar acuerdos falsos o
   inciertos antes de habilitar tráfico. Las filas monthly antiguas por sí solas
   ya no conceden acceso: publicar sin conciliarlas puede interrumpir accesos.
4. Desplegar backend y frontend coordinados, verificar acceso y webhooks. Esta
   entrega no autorizó ni ejecutó ese despliegue.

La migración agrega columnas/tablas y RPC con SECURITY INVOKER, RLS en tablas
nuevas y permisos exclusivamente para `service_role`. No modifica roles cliente
ni expone nuevas RPC a anon/authenticated. No contiene borrado de datos históricos.
Ante fallo de despliegue, detener tráfico de pagos y volver a la versión revisada
del backend; no borrar el historial nuevo para revertir. Definir la conciliación
necesaria antes de volver a una versión que interprete `status` como acceso.

## Fase 5. Pruebas de integración — implementada y validada localmente

La suite ahora incluye PostgreSQL nativo temporal, con puerto aleatorio en
`127.0.0.1`, contraseña efímera y varias conexiones. No consume `.env` ni una
`DATABASE_URL` existente. Crea su propio clúster, ejecuta la migración y elimina
exclusivamente ese directorio temporal al terminar. Las operaciones financieras
se ejecutan como `service_role` sin privilegio de superusuario.

- Contención observada mediante `pg_blocking_pids`, sin depender de que dos
  promesas parezcan simultáneas: una reserva gana; si revierte, la otra puede ganar.
- Replay, aprobación/reembolso, aprobación/cancelación y compras extra entre
  conexiones independientes; se conservan unicidad, periodos e historial.
- Fallo de historial revierte el registro completo; la reentrega permite recuperar.
- Se revisan las nueve RPC: SECURITY INVOKER, search_path vacío y permisos de
  ejecución. Anon/authenticated tampoco leen las tablas nuevas aunque se les
  conceda SELECT temporalmente para comprobar que RLS sigue bloqueando filas.
- Duplicados históricos abortan la migración completa sin borrar filas ni dejar
  columnas parciales. Es una prueba de rechazo seguro, no una reparación histórica.
- Servidor HTTP local con router real, parser JSON y middleware real de usuario;
  Auth remoto y MP simulados. Comprueba autenticación, firma y discrepancia de ID,
  500/reentrega, GET sin mutaciones e historial sin metadata privada.

**Cinco errores adicionales reproducidos y corregidos:**

1. Dos usuarios podían competir por un payment ID todavía no confirmado y el
   `ON CONFLICT` del segundo modificaba el pago del primero. Se serializa primero
   por payment ID con bloqueo transaccional, luego por usuario; se vuelve a validar
   identidad después de esperar. Importe y moneda también son inmutables.
2. El CHECK de periodos admitía un fin NULL por la lógica ternaria de SQL.
   Ahora exige ambos límites explícitamente.
3. Un historial previo de otro dueño o compra podía coexistir con un registro
   nuevo incompatible. La transacción rechaza la discrepancia sin sobrescribir
   evidencia; requiere conciliación.
4. Un pago pending de un pedido extra antiguo podía intentar reactivarlo y chocar
   con el índice del pedido nuevo vigente. Conserva el pago sin desplazar ese pedido.
5. Dos aprobaciones en pedidos extra distintos solo marcaban uno para revisión.
   Ahora se marcan todos los cobros aprobados vigentes de esa compra; no se
   ordenan reembolsos automáticos.

Comandos desde `backend`:

```powershell
npm.cmd test                 # 88 tests: servicios, SQL PGlite, HTTP y DOM
npm.cmd run test:postgres    # 14 tests: PostgreSQL nativo y conexiones independientes
npm.cmd run test:pagos       # ambas suites
```

Dependencias de desarrollo fijadas: `embedded-postgres@18.4.0-beta.17` y
`pg@8.23.1`, además de PGlite. El servidor usa PostgreSQL nativo, no WASM.
En Windows la ejecución requirió permiso fuera del sandbox porque `os.userInfo`
estaba bloqueado. No instala un servicio del sistema ni cambia ExecutionPolicy.
En Linux debe ejecutarse con un usuario normal; el runner no crea usuarios del SO.

**Pendiente para cerrar la validación del ambiente:** disponer del esquema
completo, incluidos triggers, políticas, grants y restricciones históricas, y
validarlo en Supabase aislado con sus advisors. PostgreSQL 18.4 local no certifica
la versión/extensiones de Supabase, PostgREST, Auth remoto ni Railway/Netlify.
Las pruebas HTTP montan el router de pagos: no prueban el CORS/rate limiter de
`server.js`. La interfaz sigue con DOM simulado; falta revisión en navegador.

Para obtener el esquema relevante, está preparada y probada la consulta de solo
lectura `supabase/diagnostico/esquema-pagos.sql`. Puede ejecutarse en SQL Editor
y agregar su resultado a `logs.md`; no lee filas de usuarios/pagos. Ese informe
no sustituye el respaldo de datos requerido para fase 6.

## Fase 6. Conciliación — implementada localmente

La nueva solicitud autorizó implementar esta fase; la aplicación productiva sigue
pendiente del esquema completo y del respaldo real. Ver operación, límites y
comandos en [CONCILIACION_PAGOS.md](CONCILIACION_PAGOS.md).

- CLI `npm.cmd run pagos:conciliar -- diagnosticar`: inventario paginado, propuesta
  por registro y snapshots financieros. Separa pagos por verificar y situaciones
  ambiguas. No exporta payer/card ni metadata privada histórica.
- Repara vínculos donde se guardó payment ID como preapproval; conserva filas
  falsas en auditoría y las desvincula cuando ya existe la fila correcta.
- Recupera altas `enviando` y preferencias inciertas únicamente con evidencia
  remota inequívoca y condiciones verificadas. No libera por búsquedas vacías,
  por paginación incompleta ni por timeout; no crea cobros/preferencias nuevos.
- Importa vínculos extra históricos con payment ID, referencia y precio local
  verificables. Los webhooks legacy posteriores exigen ese vínculo auditado.
- Antes de aplicar, reconsulta MP y compara snapshot. La RPC vuelve a comparar
  dentro de una transacción y registra antes/después/evidencia/hash del respaldo.
  Un fallo de auditoría revierte la reparación. Reintentar un ID aplicado es inocuo.
- La reversión estructural exige snapshot sin cambios posteriores. Si llegó un
  pago/replay, se bloquea; no borra historial ni revive un estado financiero antiguo.
- El comando `sincronizar` descubre facturas/pagos sin aviso y reconsulta pagos
  conocidos, incluidos posibles reembolsos. Por defecto simula; `--aplicar` usa
  los handlers y validaciones existentes. Puede ejecutarse como job periódico,
  con fallos reportados y sin saltar recursos fallidos en la siguiente corrida.

Migración creada mediante CLI:
`supabase/migrations/20261004165326_conciliacion_pagos.sql`.
Agrega auditoría, vínculos extra legacy, RLS y tres RPC de backend. Se aplica después
de la migración anterior, antes de usar las herramientas. No está aplicada en
Supabase. Las reparaciones toman bloqueos de mantenimiento cortos y requieren
tráfico de pagos pausado; el job normal usa las RPC de pagos habituales.

Comandos de escritura requieren `CONCILIACION_HABILITADA=true`. La reparación
requiere además un archivo de respaldo cuyo SHA-256 se registra; el hash no prueba
que se restauró. El ensayo de un respaldo real, la ejecución del inventario en
el proyecto, la reparación productiva y la activación del scheduler siguen pendientes.
No se modificaron datos remotos ni se ejecutaron cobros/cancelaciones.

## Fase 7. Metadata, SDK y configuración HTTP — implementada localmente

Procedimiento y criterios de activación en [FASE_7_PAGOS.md](FASE_7_PAGOS.md).

- SDK oficial actualizado y fijado en 3.6.1. Adaptador con configuración por
  operación, claves de idempotencia de reservas y sin reintentos automáticos.
  Pruebas sobre el SDK instalado verifican consulta, creación y PUT de cancelación.
- Contrato público de historial con siete campos; estados de reembolso, contracargo,
  cancelación y proceso se presentan correctamente, sin metadata ni PII.
- Migración `20261004181909_metadata_minima_pagos.sql`: lista mínima de metadata,
  trigger para nuevas escrituras y limpieza histórica explícita por lotes, con
  simulación predeterminada y permisos exclusivos de backend. Conserva referencias
  de conciliación e importes; se probó SKIP LOCKED entre conexiones independientes.
- Middleware HTTP compartido con server.js y probado sobre sockets reales:
  CORS, Helmet, errores JSON y cuotas separadas de navegación/webhook, incluidas
  variantes de mayúsculas y barra final. Validación de variables HTTPS al arrancar
  en producción, sin exponer valores privados en errores de configuración.
- Auditoría productiva tras actualizar SDK: de 9 avisos (2 críticos) a 3 moderados
  asociados a qs/Express. Se documenta su actualización separada; no se declara
  todo el árbol de dependencias libre de vulnerabilidades.

La limpieza cambia hashes usados por los snapshots de fase 6. Ejecutarla después
de reparación/replay y regenerar planes; no hay reversión automática de los campos
eliminados. No se aplicó en Supabase ni se publicaron backend/frontend.

## Trabajo restante

| Fase | Trabajo técnico | Criterio de salida |
| --- | --- | --- |
| 5 — cierre de ambiente | Contrastar esquema completo y ejecutar advisors en Supabase aislado; navegador y topología real del despliegue. | La suite local ya valida RLS nuevo, unicidad, concurrencia, rollback y configuración HTTP. Falta evidencia de equivalencia con el proyecto Supabase. |
| 6 — aplicación al ambiente | Herramientas y migración implementadas; falta esquema contrastado, ensayo de respaldo, inventario real y aplicación revisada. | Trazabilidad restaurada en el ambiente elegido; activar job tras validar resultado. |
| 7 — activación en ambiente | SDK, contrato de historial, trigger, CLI de limpieza y tests HTTP implementados. Ensayar integración completa, revisar avisos restantes de dependencias y aplicar limpieza después de conciliación. | Suite local aprobada; quedan validación remota y revisión previa a publicar conforme a FASE_7_PAGOS.md. |

La validación monetaria ahora cubre mensualidades y nuevos pedidos extra. Las
preferencias históricas sin pedido verificable quedan para conciliación de fase 6.

## Verificación de esta entrega

Resultado actual: **134 tests aprobados, 0 fallidos**: 117 en la suite principal
y 17 en PostgreSQL nativo. La entrega anterior tenía 122 tests.
Ver evidencia en [REVISION_PAGOS_TESTS.md](REVISION_PAGOS_TESTS.md).
`git diff --check` no reportó errores de espacios.

Desde `backend`, ejecutar `npm.cmd test` en PowerShell o `npm test` donde esté
habilitado el lanzador correspondiente. No cambiar ExecutionPolicy para ejecutar
la suite. El comando usa Node >=22 y `--experimental-vm-modules` solamente en tests.

Se cargan los módulos ESM reales, sin modificar su código en memoria. Los tests de
servicios sustituyen SDK, dotenv y fetch; los del adaptador usan el SDK instalado
y sustituyen únicamente su transporte HTTP. No se carga `.env`. Las lecturas PostgREST
se simulan y las RPC ejecutan SQL real en PGlite. La suite adicional ejecuta las
RPC en PostgreSQL nativo y comprueba contención real. Los tests anteriores del
handler usan request/response simulados; las pruebas HTTP usan sockets reales,
incluidos CORS y rate limiting en fase 7.
Las pruebas frontend ejecutan los scripts con DOM simulado; no reemplazan la
revisión en navegador del despliegue. Ninguna suite envía cobros reales.

Consultar [REVISION_PAGOS_TESTS.md](REVISION_PAGOS_TESTS.md) para distinguir la
reproducción histórica de fallos de las nuevas pruebas de regresión.

Fuentes de contrato: [facturas MP](https://www.mercadopago.com.mx/developers/es/reference/online-payments/subscriptions/get-authorized-payment/get),
[búsqueda por pago](https://www.mercadopago.com.mx/developers/es/reference/online-payments/subscriptions/authorized-payment-search/get),
[webhooks](https://www.mercadopago.com.mx/developers/es/docs/checkout-pro-preferences/additional-content/notifications/webhooks),
[maybeSingle de Supabase](https://supabase.com/docs/reference/javascript/maybesingle).
