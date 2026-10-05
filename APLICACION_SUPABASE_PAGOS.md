# Aplicación de pagos en Supabase — 2026-10-05

El usuario autorizó los commits en develop y la publicación en main/producción.
La sesión de Supabase quedó disponible y se verificó que corresponde al proyecto
configurado en el backend. Los siguientes resultados sustituyen los pendientes
de base de datos descritos en las entregas locales de fases 5–7.

## Respaldo y ensayo

- Esquema real consultado: PostgreSQL 17.6; tablas, columnas, restricciones,
  índices, RLS, permisos y triggers contrastados con la implementación.
- Supabase no reportaba respaldos físicos disponibles. Se generó un archivo
  custom de pg_dump 17.11 con los esquemas public, auth y storage. Se usaron las
  herramientas portátiles oficiales de EDB y el rol que utiliza la CLI de Supabase.
- Respaldo fuera del repositorio, en la carpeta local
  `%TEMP%\club-lectura-publicacion-20261004\antes-migraciones-verificado.dump`.
  SHA-256: `efa1d0b1b6bdeba688d4161e2da023e4e21d80e64eb88d6183960c8b5d17560d`.
  Conservarlo en un almacenamiento privado duradero antes de limpiar temporales.
- Se restauró public en PostgreSQL temporal, incluidos datos, restricciones,
  índices, políticas y grants; se incorporaron las definiciones reales de las
  funciones auth.uid/role/jwt para comprobar las políticas. El archivo también
  contiene auth/storage, pero no se ensayó una restauración completa de esos
  servicios administrados ni de archivos físicos de Storage.
- Datos restaurados: 21 usuarios, 4 sesiones, 26 suscripciones, 2 pagos rechazados
  y ninguna compra extra. Cero preapprovals duplicados. Las tres migraciones
  nuevas y la consulta de acceso de los 21 usuarios funcionaron en esa restauración.

Los informes técnicos permanecen en backend/logs/publicacion y los planes de
reparación en backend/logs/conciliacion, ambos ignorados por Git. No publicar el
respaldo: contiene información privada. No sobrescribir cobros posteriores con él.

## Migraciones y conciliación aplicadas

Se recuperaron mediante `supabase migration fetch` ocho migraciones históricas
que ya estaban aplicadas en el proyecto y faltaban en el repositorio. Se conservó
su historial remoto. No se marcaron artificialmente como revertidas.

La simulación de db push confirmó únicamente las tres migraciones nuevas.
Después del ensayo se aplicaron con `--skip-vault`; migration list confirmó
las once versiones coincidentes entre local y remoto:

- 20261003180231: reservas, compras y periodos de pagos verificados.
- 20261004165326: conciliación, auditoría y vínculos históricos.
- 20261004181909: contrato mínimo de metadata y limpieza por lotes.

Se revisaron y aplicaron dos reparaciones de vínculo mensual. Cada una reconsultó
Mercado Pago, comparó el snapshot y registró auditoría con el hash del respaldo.
Después se sincronizaron cinco acuerdos y dos pagos: siete recursos procesados,
cero fallos. Los pagos continúan rechazados; no se crearon cobros ni se emitieron
cancelaciones o reembolsos en MP.

Diagnóstico final: cero propuestas, cero pendientes y cero pagos por verificar.
La simulación de limpieza devolvió cero registros pendientes: al registrar de
nuevo los pagos verificados, el trigger ya había reducido su metadata.

## Corrección adicional comprobada contra MP

La búsqueda `/authorized_payments/search` devolvió HTTP 400 con «Invalid value
for limit» al solicitar 100 o 20 resultados en el ambiente consultado. Diez y
dos devolvieron HTTP 200. La conciliación ahora solicita diez por página y conserva
los controles de totalidad, duplicados, offset y máximo de páginas. El webhook
ya buscaba con limit=2 y no necesitó ese cambio.

La nueva prueba reproduce el rechazo y comprueba 23 facturas distribuidas entre
tres páginas. Falló antes del cambio y pasó después. Suite completa actual:
**135 aprobadas, 0 fallidas, 0 omitidas** (118 principales y 17 PostgreSQL nativo).
La consulta real y la conciliación confirmaron posteriormente la corrección.

## Pendientes independientes

Los advisors reportaron los mismos once avisos antes y después, sin avisos nuevos:
ejecución de handle_new_user por roles cliente, protección de contraseñas filtradas
y optimizaciones de políticas RLS. Su tratamiento requiere un cambio separado.
La auditoría de producción sigue con tres avisos moderados de qs/Express,
cero altos y cero críticos. No se aplicó audit fix --force.

Las comprobaciones de despliegue deben verificar el commit de Railway, los archivos
servidos por Netlify, health, CORS y la protección de rutas. El flujo completo de
Google OAuth y un pago real aprobado requieren una sesión de usuario y una compra
válida; los ensayos no prueban que MP aprobará cc_rejected_high_risk. El comando
de sincronización está disponible; la programación automática del job sigue pendiente.
