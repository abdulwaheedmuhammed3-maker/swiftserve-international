# Database Setup

## Managed PostgreSQL

SwiftServe uses PostgreSQL for persistent API storage when DATABASE_URL is configured. Supabase is a suitable managed PostgreSQL option for development. Keep the database private and store its connection string only in the deployment provider's secret environment settings.

Never paste database credentials into chat, commit them to GitHub, or place them in screenshots.

## Current implementation

- [x] PostgreSQL client dependency and bounded connection pool.
- [x] Production guard against missing DATABASE_URL.
- [x] Startup connectivity check and separate readiness endpoint.
- [x] Parameterized SQL repository operations.
- [x] Initial service-request schema.
- [x] User, business, membership and session data model.
- [x] Business-scoped service-request reads and writes in the API repository.
- [ ] Apply migrations 001 and 002 to the actual development database.
- [x] Add an ordered migration runner with checksums and applied-migration history.
- [x] Add PostgreSQL integration tests for accounts, sessions and business isolation in CI.
- [ ] Verify records survive API restarts.
- [ ] Configure automated backups, restore testing and least-privilege database roles.

Without DATABASE_URL, local development uses in-memory stores. Records disappear when the process stops. In-memory mode must never be used for production.

## Migration order and runner

Set DATABASE_URL to the target PostgreSQL database, then run:

    npm run migrate --workspace @swiftserve/api

The migration runner:
- discovers numbered SQL files in apps/api/db/migrations;
- applies them in filename order, one transaction per migration;
- records each applied filename and SHA-256 checksum in schema_migrations;
- skips migrations already applied with the same checksum;
- fails if an applied migration file has been edited.

Do not edit an already-applied migration. Add a new numbered migration instead. The API checks for the required tables and recorded migration versions during startup/readiness.

For Render, the service start command can apply pending migrations before starting the API:

    npm run migrate --workspace @swiftserve/api && npm start

Always verify the target DATABASE_URL before running a migration command. Never run a development migration against the production database by mistake.

## Identity and business tables

Migration 002 adds:

- users: normalized unique email, full name, account type, password hash and account status.
- businesses: business identity and status.
- business_memberships: user-to-business relationship and owner/admin/manager/staff role.
- sessions: SHA-256 bearer-token hash, expiry and revocation state.
- service_requests.business_id: business ownership foreign key.
- service_requests.created_by_user_id: creator reference.

Password hashes use scrypt. Raw bearer tokens are returned once at registration/login and are not stored in the database; only a SHA-256 hash is stored. Sessions expire after seven days and can be revoked at logout.

## Existing data and backfill

Migration 002 deliberately adds nullable business ownership columns to existing service_requests. It does not automatically assign old requests to a new business. Requests with NULL business_id are not visible in the authenticated business API.

Before retaining old records, identify their true owner and use a reviewed, auditable backfill. Do not attach legacy requests to an arbitrary account or business merely to make them visible.

## Local setup

1. Create a development PostgreSQL database with your chosen managed provider.
2. Apply migrations 001 and 002 in order.
3. Copy apps/api/.env.example to apps/api/.env.
4. Set DATABASE_URL in the local environment. Do not commit the .env file.
5. Start the API and open /readyz. It should report PostgreSQL storage when the connection succeeds.
6. Register a test business account and create a test request.
7. Restart the API, sign in again, and verify that the account, business and request remain.

For deployment, add DATABASE_URL as a secret environment variable in the hosting provider. Do not put it in frontend code, a GitHub source file or a public CI log.

## Supabase connection guidance

Use the connection string format recommended by Supabase for the hosting environment. Pooler and direct connection options have different use cases; choose the one supported by the host and database workload. Require TLS where supported.

## Before a real pilot

- Create a least-privilege database role for the API.
- Keep development and production databases separate.
- Enable automated backups and test restoration.
- Add a migration runner and schema-version check.
- Verify identity and tenant-isolation behaviour against real PostgreSQL.
- Enforce business ownership in every read and write query.
- Establish data minimization, retention and deletion practices.
- Review session expiry, revocation and device token storage.
- Never store payment card details directly.
