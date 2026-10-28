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

La interfaz estará disponible en `http://localhost:4200`; `/api` se redirige a la API local. La migración es idempotente. La primera persona que abra la aplicación configura la cuenta administradora inicial; luego esa cuenta puede crear cuentas locales desde **Reportes**.

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
