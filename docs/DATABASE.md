# Database Setup Plan

## Choice: managed PostgreSQL

Use a managed PostgreSQL provider for the first development database. This avoids requiring a computer to install and run a database locally. Create the database in the provider's dashboard, keep it private, and store its connection string as a GitHub Actions secret or deployment environment variable—not in source code.

Do not paste database credentials into chat, commit them to GitHub, or put them in screenshots.

## Current status

- [x] Initial PostgreSQL schema drafted.
- [ ] Create a development PostgreSQL database.
- [ ] Add `DATABASE_URL` to the deployment/runtime secret settings.
- [ ] Add the PostgreSQL client dependency.
- [ ] Replace the in-memory Map with a database repository.
- [ ] Add database integration tests.
- [ ] Verify data remains after an API restart.
- [ ] Add backups and access controls before any real customer data is stored.

The API still uses in-memory storage until the database adapter is implemented and tested. The SQL file alone does not make the API persistent.

## Initial table

The migration `apps/api/db/migrations/001_initial_schema.sql` creates `service_requests` with a UUID, service category, description, service area, status, and timestamps. Constraints mirror the current API's accepted values.

This is a development schema, not the final production data model. Business ownership, authentication, booking scheduling, provider assignment, audit history, and retention rules must be designed before a real pilot.

## Phone-only next actions

1. Open the repository's **Settings** only when creating a database provider account; do not change repository visibility.
2. Create a development PostgreSQL database with the provider you choose.
3. Keep its connection string private. The next implementation step will add database integration without committing credentials.
4. After integration, check the **Actions** tab and confirm tests pass.

## Safety

Never expose a database to the public internet without appropriate authentication and network controls. Use a least-privilege database user, TLS connections, backups, and separate development and production credentials. Do not store payment card data directly.
