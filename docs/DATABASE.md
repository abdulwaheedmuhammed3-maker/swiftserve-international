# Database Setup

## Managed PostgreSQL

SwiftServe uses PostgreSQL for persistent API storage when DATABASE_URL is configured. Supabase is a suitable managed PostgreSQL option for development. Keep the database private and store its connection string only in the deployment provider's secret environment settings.

Never paste database credentials into chat, commit them to GitHub, or place them in screenshots.

## Current implementation

- [x] PostgreSQL client dependency is present.
- [x] Repository adapter reads DATABASE_URL and uses a bounded connection pool.
- [x] API queries use parameterized SQL.
- [x] Initial service_requests migration is present.
- [x] Production refuses to start without DATABASE_URL.
- [x] Server checks the database before listening when DATABASE_URL is configured.
- [ ] Run integration tests against a real PostgreSQL database.
- [ ] Verify records survive API restarts.
- [ ] Add a documented migration runner and migration history table.
- [ ] Configure automated backups, restore testing and least-privilege database roles.

Without DATABASE_URL, local development uses an in-memory Map. This is intentionally temporary: all records disappear when the process stops. The in-memory mode must never be used for production.

## Initial schema

The migration at apps/api/db/migrations/001_initial_schema.sql creates service_requests with a UUID, service category, description, area, status and timestamps. It includes constraints and indexes for the current API filters.

This is only the initial request table. It does not yet contain user identity, business ownership, provider assignment, booking schedules, payment records, audit history or privacy retention fields. Do not use this table for real multi-business data until the identity and authorization migrations have been implemented.

## Local setup

1. Create a development PostgreSQL database with your chosen managed provider.
2. Apply apps/api/db/migrations/001_initial_schema.sql using the provider's SQL editor or a trusted PostgreSQL client.
3. Copy apps/api/.env.example to apps/api/.env.
4. Set DATABASE_URL in the local environment. Do not commit the .env file.
5. Start the API and open /readyz. It should report PostgreSQL storage when the connection succeeds.
6. Create a test request, restart the API, and verify that the request remains.

For deployment, add DATABASE_URL as a secret environment variable in the hosting provider. Do not put it in frontend code, a GitHub source file, or a public CI log.

## Supabase connection guidance

Use the connection string format recommended by Supabase for the hosting environment. Pooler and direct connection options have different use cases; choose the one supported by the host and database workload. Require TLS where supported.

## Before a real pilot

- Create a least-privilege database role for the API.
- Keep development and production databases separate.
- Enable automated backups and test restoration.
- Add migrations that establish users, businesses and business memberships before enabling real accounts.
- Enforce business ownership in every query and write.
- Establish data minimization, retention and deletion practices.
- Never store payment card details directly.
