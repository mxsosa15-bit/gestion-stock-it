# Gestión IT DOSEP

Aplicación Angular con una API Express y almacenamiento compartido en PostgreSQL. El inventario se guarda en el esquema aislado `gestion_it`; otros sistemas deberían consumir la API y no modificar sus tablas directamente.

## Requisitos

- Windows Server o Windows para desarrollo.
- Node.js compatible con Angular 21 y npm.
- PostgreSQL accesible desde el servidor de la aplicación.
- Una base de datos y un usuario PostgreSQL dedicados a Gestión IT.

## Preparar PostgreSQL

Creá una base y un usuario propios. Ejecutá estos comandos desde `psql` como administrador de PostgreSQL, reemplazando el marcador de contraseña localmente:

```sql
CREATE ROLE gestion_it_app LOGIN PASSWORD 'REEMPLAZAR_LOCALMENTE';
CREATE DATABASE gestion_it OWNER gestion_it_app;
```

La aplicación crea las tablas dentro del esquema `gestion_it`; no requiere permisos de superusuario. No reutilices este usuario para otros sistemas.

## Configuración local/servidor

Desde PowerShell, en la raíz del proyecto:

```powershell
Copy-Item .env.example .env
```

Editá `.env` sin compartirlo ni guardarlo en Git:

```dotenv
DATABASE_URL=postgres://gestion_it_app:CONTRASENA@localhost:5432/gestion_it
SESSION_SECRET=GENERAR_UN_SECRETO_ALEATORIO_DE_AL_MENOS_32_CARACTERES
PORT=4000
PG_POOL_MAX=10
PG_SSL=false
COOKIE_SECURE=false
TRUST_PROXY=false
```

Usá una contraseña PostgreSQL URL-encoded si contiene caracteres reservados. Para generar el secreto de sesión con Node:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

En producción, habilitá HTTPS mediante el proxy inverso institucional, configurá `COOKIE_SECURE=true` y `TRUST_PROXY=true` únicamente si Express recibe solicitudes desde ese proxy confiable. No expongas PostgreSQL ni el puerto de desarrollo de Angular a la red de usuarios.

## Migración y desarrollo

Instalá dependencias, aplicá la migración y ejecutá Angular junto a la API de desarrollo:

```powershell
npm install
npm run db:migrate
npm start
```

La interfaz estará disponible en `http://localhost:4200`; `/api` se redirige a la API local. Las migraciones numeradas son aditivas y se aplican en orden. La primera persona que abra la aplicación configura la cuenta administradora inicial; luego esa cuenta puede crear cuentas locales desde **Reportes** con perfiles de administración, operación, solicitante (asignado a un área) o dashboard de solo lectura, que únicamente puede consultar el dashboard operativo.

El comando `npm run db:migrate` aplica en orden los archivos SQL numerados de `database/migrations`. Los reclamos se generan desde cuentas solicitantes, requieren categoría, detalle y la selección de un puesto o usuario de su propia área. El selector obtiene los puestos del inventario del servidor; la API vuelve a validar el área y conserva el ID y el nombre afectado en el ticket. El panel del equipo operador recibe cambios en vivo, muestra el área y el afectado, ofrece filtros por estado, categoría y fecha, y exporta los resultados a CSV. Para derivar un equipo al taller, el operador registra su identificación; el titular del reclamo debe iniciar sesión, verificar el equipo y aprobar o rechazar la derivación. Una vez aprobada, aparece en **Taller y scrap**; allí el operador registra el trabajo realizado y la devolución, lo que termina el reclamo en una única transacción. El inventario del área no se modifica. La decisión del solicitante y la devolución quedan asociadas a sus cuentas y a la fecha del servidor. Aplicá `npm run db:migrate` para habilitar las migraciones. El perfil dashboard consulta stock y parque sin permisos de escritura.

Las notificaciones de tickets usan Server-Sent Events autenticados; en despliegues con varias instancias de API se necesita un mecanismo compartido de publicación de eventos entre instancias. Los IDs creados por la interfaz usan UUID v4 de `uuid`, compatible con navegadores donde `crypto.randomUUID()` no está disponible.

Las cuentas solicitantes solo consultan reclamos de su propia área; las cuentas de operación y administración conservan la cola global. En **Pisos y áreas**, el explorador permite consultar los puestos, componentes, equipos de red y reclamos asociados a cada área. Los reemplazos del parque muestran el equipo saliente y el entrante, registran un motivo obligatorio y requieren confirmar el movimiento antes de actualizar el stock. El **Dashboard operativo** resume reclamos, equipos derivados al taller y alertas de stock, y actualiza la actividad con SSE. Las migraciones registran también la fecha real de resolución de los reclamos para que el gráfico semanal refleje cuándo se cerraron.

El módulo **Transferencias** crea automáticamente una persona de inventario al dar de alta un puesto con usuario asignado. Permite mover una persona sin sus equipos, mover componentes y equipos de red sin trasladar a la persona, o mudar un área completa a otro piso. Las operaciones se validan y guardan junto con un historial de origen/destino en una transacción de PostgreSQL, usando control de revisión del inventario. La información de acceso de las cuentas de la aplicación y los reclamos históricos no se modifica al trasladar una persona del inventario.

La pantalla **Etiquetas de patrimonio** registra cada unidad física por número de serie, permite cargar equipos manualmente o mediante CSV (`numero_serie` requerido; `tipo`, `marca`, `modelo`, `especificacion` y `numero_patrimonio` opcionales), asociar posteriormente el número de la etiqueta recibida y generar códigos CODE128 para impresión. Aplicá las migraciones antes de usar estos módulos.

Para una base de prueba, la aplicación comienza con inventario vacío. Los datos de `localStorage` de instalaciones anteriores no se importan automáticamente. La restauración desde JSON está limitada a administradores y solo funciona mientras el inventario del servidor esté vacío.

## Compilación y ejecución

```powershell
npm test -- --watch=false
npm run build
$env:NODE_ENV = "production"
npm run serve:ssr:gestion-stock-it
```

La instancia Express sirve la aplicación Angular compilada y la API en el mismo puerto (`PORT`, por defecto `4000`). En un servidor compartido, publicá la aplicación detrás del proxy HTTPS institucional y asigná a cada sistema su propio esquema PostgreSQL, usuario y credenciales.

## Respaldo y recuperación

- **Respaldo completo recomendado:** programá `pg_dump` de la base `gestion_it` en una ubicación de respaldo controlada, con retención y pruebas de restauración periódicas.
- **Respaldo operativo:** una persona puede descargar el inventario en JSON desde **Reportes**. Es un respaldo del contenido del inventario, no de cuentas ni sesiones. La importación JSON está pensada para inicializar una base vacía.
- Restringí el acceso a los respaldos; contienen información sobre puestos, usuarios asignados y equipamiento.

## Pruebas

```powershell
npm test -- --watch=false
npm run build
```
