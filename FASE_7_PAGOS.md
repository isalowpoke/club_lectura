# Fase 7: datos mínimos, SDK y preparación de despliegue

Implementada localmente en `develop`, 2026-10-04. No se aplicaron migraciones,
limpieza ni cambios de configuración en Supabase, Railway o Netlify. Esta fase
no acredita que Mercado Pago vaya a aprobar un pago rechazado por riesgo.

## Cambios implementados

El backend usa el SDK oficial `mercadopago@3.6.1`, fijado en package.json y
package-lock.json, en lugar de la API de la versión 1. Consulta pagos con Payment,
crea/consulta acuerdos con PreApproval, cancela mediante PUT con `status=cancelled`
y crea preferencias con Preference. Consume las respuestas directas del SDK.

El adaptador crea una configuración por operación: el SDK modifica sus opciones
y compartirlas podía mezclar claves de idempotencia entre solicitudes. Altas y
preferencias reciben las claves estables de sus reservas locales. Se desactivan
los reintentos automáticos del SDK y se mantiene el límite de cuatro segundos.
La reserva durable y la conciliación siguen resolviendo resultados inciertos;
un timeout no libera una reserva ni autoriza otra compra.

El historial devuelve exclusivamente `mp_payment_id`, `monto`, `moneda`,
`estado_mp`, `tipo`, `created_at` y `estado_texto`. El servidor traduce los estados,
incluidos reembolso, contracargo, cancelación y procesamiento. Un estado desconocido
se presenta como «Estado por verificar». El frontend escapa ese texto. No se
envían metadata, datos del pagador ni futuras columnas añadidas a la tabla.

La migración `20261004181909_metadata_minima_pagos.sql` instala un trigger que
minimiza metadata en INSERT y UPDATE de esa columna. Conserva únicamente:

| Campo | Restricción |
| --- | --- |
| preapproval_id, authorized_payment_id, preference_id, merchant_order_id | Cadena de hasta 100 caracteres alfanuméricos o guiones; admite IDs numéricos y los normaliza a texto. |
| status_detail | Cadena de hasta 100 caracteres: minúsculas, dígitos y guion bajo. |
| live_mode | Booleano. |
| date_approved | Cadena con formato ISO y zona; conservarla no sustituye la validación de fechas del procesador. |
| reembolsado | Número no negativo, hasta 12 dígitos enteros y dos decimales. |

Admite objetos históricos y objetos serializados una vez dentro de JSONB;
recupera referencias conocidas de metadata anidada y `order.id`. Descarta campos
desconocidos, payer/card, estructuras inesperadas y JSON serializado inválido.
No copia los datos descartados a auditoría. Las tres funciones nuevas son
SECURITY INVOKER, con search_path vacío y ejecución exclusiva de service_role.

## Limpieza histórica

La migración no recorre ni borra automáticamente metadata histórica. Desde
`backend`, con credenciales del ambiente elegido y las migraciones aplicadas:

```powershell
npm.cmd run pagos:conciliar -- metadata --limite 100
```

Simula por defecto y guarda un informe local ignorado por Git. `detectados` cuenta
las filas que requieren limpieza al inicio de la transacción; `procesados` es cero
en simulación. No exporta el contenido privado. El límite válido es de 1 a 500.

Después del respaldo verificado, reparación y replay de fase 6, aplicar por lotes:

```powershell
$env:CONCILIACION_HABILITADA = 'true'
npm.cmd run pagos:conciliar -- metadata --limite 100 --aplicar
npm.cmd run pagos:conciliar -- metadata --limite 100
```

Repetir la aplicación supervisada hasta que una simulación posterior indique
`detectados=0`. Salida 2 significa filas pendientes; salida 1 indica error; salida
0 significa que la corrida no informó pendientes. Con conexiones concurrentes,
las filas bloqueadas se omiten mediante SKIP LOCKED y se retoman después. El conteo
corresponde a esa transacción, no certifica ausencia de escrituras posteriores.
La RPC actualiza exclusivamente metadata; conserva importes, estados y periodos.
El conteo examina la tabla: medir su duración antes de usarlo en un historial grande.

La eliminación de campos no tiene reversión automática. La conciliación de fase 6
incluye un hash de metadata en sus snapshots: una limpieza puede invalidar planes
y bloquear reversiones anteriores. Terminar reparación/replay antes de limpiar,
y generar un diagnóstico nuevo después. No restaurar un respaldo antiguo sobre
pagos posteriores ni reintroducir datos de tarjetas para revertir el SDK.

## Configuración y orden de activación

1. Contrastar el esquema completo mediante `supabase/diagnostico/esquema-pagos.sql`,
   ensayar el respaldo real y resolver diferencias con la base de pruebas. Ejecutar
   advisors de seguridad/rendimiento en Supabase aislado. Estas tareas siguen pendientes.
2. Ensayar las tres migraciones en orden: `20261003180231_pagos_reservas_y_periodos.sql`,
   `20261004165326_conciliacion_pagos.sql`, `20261004181909_metadata_minima_pagos.sql`.
   Confirmar RPC/permisos/trigger. Las migraciones no reparan por sí solas la historia.
3. Instalar con `npm ci` usando el lockfile y Node >=22. Verificación local de esta
   entrega: Node 24.18.0. Ejecutar `npm run test:pagos` antes de publicar.
4. En Railway, definir `NODE_ENV=production`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
   `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET` y `FRONTEND_URL`.
   `MERCADOPAGO_MODE` admite `production` o `test`; por defecto production.
   Los orígenes deben usar HTTPS, sin rutas, query, credenciales ni fragmentos.
   `FRONTEND_URLS`, si se usa, es una lista separada por comas de orígenes permitidos
   y sustituye la lista derivada de FRONTEND_URL. El dominio histórico
   `https://clublecturahispano.netlify.app` sigue incluido explícitamente en CORS.
   El arranque falla con un error sin valores sensibles ante configuración inválida.
5. Confirmar que las credenciales, aplicación, cobrador, webhook y ambiente MP
   corresponden entre sí. Verificar las variables públicas del frontend y su URL
   de API. Ninguna clave de servicio/token privado pertenece a Netlify frontend.
6. En el ambiente aislado, comprobar HTTPS, health, login real, CORS desde el dominio
   elegido, OPTIONS, rutas privadas e historial de dos usuarios distintos. Verificar
   reentrega firmada y actualización de BD con fixtures autorizados del ambiente;
   no convertir un pago productivo en una prueba implícita.
7. Verificar la topología real de proxy: Express mantiene `trust proxy=1`.
   Comprobar que la IP efectiva no queda compartida por todos los usuarios ni
   puede sustituirse mediante headers enviados por el cliente. Los limitadores
   locales son por proceso: varias réplicas no comparten cuotas. Navegación:
   100 solicitudes/15 min; webhook: 300/min. Ajustar infraestructura si el despliegue
   requiere cuotas distribuidas. No se ha validado la topología remota.
8. Coordinar migraciones, conciliación histórica y activación del backend según
   [CONCILIACION_PAGOS.md](CONCILIACION_PAGOS.md). Revisar resultado antes de habilitar
   el job periódico y efectuar la limpieza histórica al final.

La configuración HTTP se extrae de server.js para probar exactamente el middleware
de producción. Las variantes de mayúsculas y barra final del webhook usan su cuota
independiente. Se conserva la verificación de firma; JSON inválido devuelve 400,
cuerpo demasiado grande 413 y errores internos 500, sin volcar cuerpos privados.

Para revertir un despliegue, detener cambios de pagos y evaluar la compatibilidad
del backend anterior con el esquema y los periodos ya registrados. El contrato
aditivo del historial permite revertir la UI por separado. No borrar tablas,
periodos, auditoría ni historial para volver al SDK anterior.

## Evidencia y pendientes

Suite completa: **134 pruebas aprobadas**, 117 principales y 17 con PostgreSQL
nativo. Incluye el SDK instalado con transporte HTTP simulado, idempotencia bajo
concurrencia, PUT de cancelación, ausencia de reintento ante 503, contrato público,
limpieza histórica por lotes, permisos, trigger y concurrencia entre conexiones.
Los tests HTTP usan la configuración real de CORS, Helmet, parser y rate limiting.
No cargan credenciales ni envían cobros. La UI se prueba con DOM simulado; falta
revisión real de navegador/Netlify y Auth/PostgREST/Railway/Supabase integrados.

Auditoría de dependencias de producción (`npm audit --omit=dev`, 2026-10-04):
antes, 9 avisos (2 críticos y 7 moderados); después del SDK, 3 moderados, sin
críticos ni altos. Quedan Express/body-parser/qs, derivados de avisos de qs:
[parsing de arrays](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) y
[isBuffer controlado](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g).
Se registran para una actualización compatible aparte con regresión HTTP; no se
ejecutó `audit fix --force`. La instalación incluyendo desarrollo reportó además
cuatro avisos altos; el resultado de producción no significa que todo el árbol
de herramientas esté libre de avisos. Repetir auditoría antes del despliegue.

Fuentes: [SDK oficial de MP](https://github.com/mercadopago/sdk-nodejs),
[RLS de Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security),
[Express detrás de proxies](https://expressjs.com/en/guide/behind-proxies/).
La revisión del adaptador también usó el código de la versión instalada 3.6.1.

## Preparación de la publicación — 2026-10-04

El usuario autorizó registrar los cambios en develop y publicarlos en main/producción.
Se consultaron las ramas remotas y la suite completa volvió a aprobar sus 134 pruebas.
Se revisaron los archivos modificados/nuevos contra los secretos privados del .env;
no se encontraron coincidencias. .env, logs.md y el estado local de la CLI quedan
excluidos de Git.

La API de Supabase configurada en backend/.env todavía no expone las tablas
`reservas_cobros`, `compras_extras`, `pagos_verificados`, `vinculos_pagos_extras`
y `conciliaciones_pagos`, ni las funciones `reservar_cobro`, `estado_acceso_pagos`,
`aplicar_pago_verificado` y `limpiar_metadata_pagos`. Es una comprobación de solo
lectura de su esquema REST; no sustituye revisar el catálogo PostgreSQL completo.

La CLI informó `AccessTokenRequiredError`: falta iniciar sesión para inspeccionar
el proyecto y preparar respaldo/migraciones. Se solicitó ejecutar
`npx.cmd --yes supabase login` en otra terminal, sin compartir secretos por chat.
La publicación a main queda pendiente de resolver esta dependencia, porque
el backend nuevo ya requiere esas funciones para operar. La autorización del
usuario para continuar con el despliegue sigue vigente.
