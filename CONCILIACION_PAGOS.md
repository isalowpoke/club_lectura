# Operación de la fase 6

**Actualización 2026-10-05:** aplicada y verificada en el proyecto; dos vínculos
reparados y siete recursos sincronizados, sin pendientes ni fallos. Ver
[APLICACION_SUPABASE_PAGOS.md](APLICACION_SUPABASE_PAGOS.md). Los párrafos siguientes
documentan la entrega local y el procedimiento para futuras intervenciones.

Implementación local en `develop`, 2026-10-04. La migración y los comandos se
probaron en bases aisladas. **No se aplicaron en Supabase ni se programó un job
productivo.** Falta contrastar el esquema completo solicitado en `logs.md` y
ensayar un respaldo real antes de ejecutar reparaciones en ese proyecto.

## Qué resuelve

- Inventario paginado de suscripciones, reservas, pedidos, historial y compras
  extra. Cada propuesta incluye un snapshot financiero y evidencia mínima de MP.
- Corrige el fallo histórico de guardar un payment ID como preapproval. Si ya
  existe el acuerdo correcto, conserva la fila falsa, desvinculada, y su copia
  auditada. No elimina pagos ni inventa periodos.
- Recupera un alta `enviando` únicamente cuando hay un acuerdo remoto inequívoco,
  creado después del envío, del mismo usuario/cobrador y con las condiciones
  contratadas. Una búsqueda vacía, incompleta o ambigua conserva la reserva.
- Recupera preferencias de pedidos inciertos comprobando referencia, cobrador,
  ítem, importe y moneda. No crea otra preferencia. MP limita la búsqueda de
  preferencias a los últimos 90 días; ausencia no prueba que nunca se creara.
- Importa el vínculo de un pago extra histórico `usuario:sesion` si existe una
  compra local con el mismo payment ID y precio verificable. Conserva ese precio,
  aunque el catálogo actual sea distinto. Los avisos legacy posteriores requieren
  ese vínculo explícito; una referencia enviada por sí sola no basta.
- Reconcilia pagos conocidos y descubre pagos de facturas/pedidos cuyo webhook
  faltó. Consulta también acuerdos cancelados para recuperar historia pendiente.
  Reutiliza los procesadores y validaciones de pagos existentes; no duplica reglas
  de acceso ni suma periodos al momento de ejecutar el job.

La reparación estructural y el replay son pasos separados. La primera no concede
acceso. Si falla el replay, la asociación queda auditada y la siguiente corrida
puede reintentarlo sin crear otro cobro. Un pago rechazado seguirá rechazado.

## Preparación antes de producción

1. Ejecutar `supabase/diagnostico/esquema-pagos.sql` en SQL Editor y contrastar su
   salida con la base de pruebas. Resolver diferencias de triggers, permisos,
   tipos e índices; ejecutar advisors en Supabase aislado. La consulta no lee
   filas de usuarios ni de pagos y no es un respaldo.
2. Obtener un respaldo consistente del proyecto antes de la reparación. Restaurar
   el respaldo en un ambiente aislado y verificar tablas, restricciones, conteos
   y accesos de muestra. Mantenerlo fuera de Git y del frontend. El comando calcula
   SHA-256 del archivo para asociarlo a la auditoría; **el hash no certifica la
   restauración**. Ese ensayo sigue pendiente del respaldo real.
3. Ensayar las migraciones, en orden:
   `20261003180231_pagos_reservas_y_periodos.sql` y
   `20261004165326_conciliacion_pagos.sql`, seguidas por
   `20261004181909_metadata_minima_pagos.sql` (fase 7).
   Duplicados de preapproval pueden impedir la primera: requieren propuesta
   específica basada en el inventario, no borrado automático.
4. Pausar cambios de pagos durante la reparación histórica y preparar la
   activación coordinada del backend. No publicar el backend nuevo sin completar
   los pagos/periodos verificados que justifican los accesos históricos.

## Comandos

Desde `backend`, con las credenciales del **ambiente elegido** configuradas en
`.env` y `MERCADOPAGO_MODE` coherente con ellas:

```powershell
npm.cmd run pagos:conciliar -- --help
npm.cmd run pagos:conciliar -- diagnosticar
npm.cmd run pagos:conciliar -- sincronizar
```

Los dos últimos comandos consultan datos y escriben solamente un informe local
en `backend/logs/conciliacion/`, ignorado por Git. El segundo enumera recursos a
reprocesar; no acredita que todos los pagos sean válidos sin ejecutar su validación.
Los informes no contienen respuestas completas de MP, payer/card ni metadata
privada histórica. El snapshot conserva un hash de esa metadata para detectar
cambios sin copiarla. Las reservas/tokens internos del informe requieren acceso
restringido al operador; no publicarlo en el frontend ni en un PR.

El plan distingue `acciones`, `pendientes` y `pagos_por_verificar`. Hay como máximo
una reparación por usuario en cada plan; tras aplicarla se genera otro plan para
la siguiente. Una compra sin payment ID o un periodo activo sin pago verificable
queda señalado para obtener evidencia, sin convertirlo automáticamente en cobro.

Después de revisar una acción concreta y ensayar su respaldo:

```powershell
$env:CONCILIACION_HABILITADA = 'true'
npm.cmd run pagos:conciliar -- aplicar --plan 'ruta-del-plan.json' --id 'uuid-de-la-accion' --respaldo 'ruta-del-respaldo.dump'
npm.cmd run pagos:conciliar -- diagnosticar
```

El comando reconsulta MP y compara el snapshot local antes de escribir. Un cambio
de cuenta, evidencia, dueño, importe o estado local obliga a generar otro plan.
La RPC vuelve a comparar dentro de la transacción. Una respuesta perdida puede
reintentarse con el mismo ID: devuelve que ya fue aplicada y no la repite.
El registro en `conciliaciones_pagos` conserva antes/después, evidencia mínima,
ID de operación, hash del respaldo y estado. Un fallo de auditoría revierte
también la reparación. Las RPC/tablas nuevas solo son accesibles al backend.

## Reversión

```powershell
npm.cmd run pagos:conciliar -- revertir --id 'uuid-de-la-accion'
```

Restaura exactamente la estructura previa **si el snapshot financiero no cambió
desde esa operación**. Se verificó restauración local de vínculo, reserva y
preferencia, e idempotencia de la reversión. No restaura roles ni borra pagos.
Si ya hubo webhook, replay u otra reparación, se rechaza la reversión automática:
diagnosticar nuevamente contra MP y preparar la corrección correspondiente.
No usar un respaldo antiguo para sobrescribir cobros posteriores.

La reparación y reversión toman bloqueos de tablas durante una transacción corta;
no hacen HTTP dentro. Son herramientas de mantenimiento con tráfico pausado.
No deben confundirse con el job periódico, que usa las RPC ordinarias de pagos.

## Replay y ejecución periódica

Una vez reparadas las asociaciones verificables:

```powershell
npm.cmd run pagos:conciliar -- sincronizar --aplicar
```

Puede configurarse como comando de un job periódico del backend después de
validar el ambiente. Empezar con una corrida supervisada y revisar duración y
límites de MP antes de fijar frecuencia. No se instaló ni habilitó un scheduler
en esta entrega. La escritura requiere `CONCILIACION_HABILITADA=true`.

La corrida revisa IDs locales, facturas de todos los acuerdos registrados y
pagos de los pedidos conocidos; no presupone que un estado terminal sea inmutable
para siempre. Así puede detectar reembolsos posteriores. Todas las páginas deben
ser coherentes: resultados truncados/repetidos, cambios de total, timeouts y
errores quedan reportados. El límite es 100 páginas por búsqueda/inventario,
con 10 resultados por página de MP y 100 filas por página del inventario local;
no se interpreta llegar al límite como éxito. El ambiente MP verificado rechazó
20 y 100 en la búsqueda de facturas, y aceptó 10. No extrapolar los límites de
otro endpoint ni asumir que la primera página contiene todo el historial.

No hay cursor persistente que salte un fallo: cada corrida vuelve a recorrer los
recursos y la persistencia existente evita duplicados. Si crece el volumen, dividir
el inventario y diseñar checkpoints durables antes de ampliar ese límite.
Recursos remotos sin acuerdo/pedido local ni evidencia para vincularlos requieren
investigación; el job no inventa compradores.

Códigos de salida: `0` corrida completada, `1` error global/configuración/plan
obsoleto, `2` pendientes o fallos por recurso. Conservar los informes y alertar
sobre salidas distintas de cero. `procesados` cuenta recursos consultados/aplicados,
no pagos aprobados. Una ejecución con fallos no confirma conciliación completa.

## Limpieza de metadata después de la conciliación

La fase 7 agrega `npm.cmd run pagos:conciliar -- metadata --limite 100`:
simula por defecto; `--aplicar` escribe con `CONCILIACION_HABILITADA=true`.
La migración instala el trigger para nuevas escrituras, pero no limpia por sí
sola el historial. Ejecutar la limpieza después de las reparaciones y el replay.
Suprimir campos cambia el hash de metadata usado por los snapshots; invalida
planes y puede bloquear reversiones previas. Generar un nuevo diagnóstico al
terminar. No se copian campos privados a auditoría para hacerlos reversibles.
Ver procedimiento, códigos de salida y pruebas en [FASE_7_PAGOS.md](FASE_7_PAGOS.md).

## Verificación

`npm.cmd test` y `npm.cmd run test:postgres`. Las pruebas no cargan credenciales
ni envían solicitudes reales a MP. PostgreSQL nativo verifica reparación
concurrente, rechazo de snapshot obsoleto, reversión protegida y permisos. PGlite
prueba cada tipo de recuperación, rollback al fallar auditoría, evidencia cambiante,
replay, datos privados, ausencia/ambigüedad y paginación.

Fuentes: [funciones de Supabase](https://supabase.com/docs/guides/database/functions),
[búsqueda de acuerdos MP](https://www.mercadopago.com.mx/developers/es/reference/online-payments/subscriptions/search-preapproval/get),
[búsqueda de preferencias MP](https://www.mercadopago.com.mx/developers/es/reference/online-payments/checkout-pro-preferences/search-preferences/get),
[facturas MP](https://www.mercadopago.com.mx/developers/es/reference/online-payments/subscriptions/authorized-payment-search/get).
