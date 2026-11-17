# Supabase Setup (Phone-Friendly)

Supabase provides managed PostgreSQL. Use a separate development project first. Do not store real customer information in the development database.

## 1. Create a development project

1. Open https://supabase.com/dashboard.
2. Sign in and choose New project.
3. Name it swiftserve-dev.
4. Choose a strong database password and store it in a password manager.
5. Select a region suitable for your first development and pilot environment.
6. Wait for the database to finish provisioning.

Do not send the database password or connection string in chat, screenshots, GitHub issues or source files.

## 2. Configure the API connection

1. In Supabase, open Project Settings → Database.
2. Find Connection string and select URI.
3. Choose the connection method appropriate for the host. Use the Supabase pooler option when required by the hosting environment.
4. Copy the connection string privately.
5. Add it as DATABASE_URL in the API runtime environment. For Render, use the service's Environment settings and mark the value as secret.
6. Never add DATABASE_URL to the Android app, frontend code, repository, or public CI log.

## 3. Apply database migrations

The repository includes a migration runner. With DATABASE_URL configured in the API runtime or local environment, run from the repository root:

    npm run migrate --workspace @swiftserve/api

The runner applies migrations in filename order, records checksums in schema_migrations, and skips migrations that have already been applied unchanged. Do not edit an applied migration; add a new numbered migration for future schema changes.

The current migration files are:

1. apps/api/db/migrations/001_initial_schema.sql
2. apps/api/db/migrations/002_identity_business_scope.sql
3. apps/api/db/migrations/003_business_operations.sql
4. apps/api/db/migrations/004_customer_bookings.sql
5. apps/api/db/migrations/005_provider_operations.sql

For Render, configure the start command to run migrations before the server:

    npm run migrate --workspace @swiftserve/api && npm start

Before running the command, confirm that DATABASE_URL points to the intended development database. Do not run development migrations against production unintentionally.

## 4. Verify the API and persistence

After deploying or starting the API:

1. Open /health to confirm the process responds.
2. Open /readyz to confirm the database schema and recorded migrations are ready.
3. Register a test business, publish an active service, create a branch and add a service area.
4. Register a separate customer, save a service location and create a booking request.
5. Issue a quote from the business account, accept it from the customer account and inspect the booking status history and notifications.
6. Register a provider, configure skills, coverage and availability, request verification and approve the provider using the protected admin route.
7. Invite the provider to the business, accept the invitation and assign the confirmed booking; test the provider's accept/start/complete workflow.
8. Restart the API, sign in again and verify customer, business and provider records remain visible only to authorized accounts.

A successful /health response alone does not prove PostgreSQL is ready. Use /readyz for dependency and schema readiness.

## 5. CI integration tests

GitHub Actions runs a temporary PostgreSQL 16 database, applies migrations 001–005, and tests account persistence, session revocation, business isolation, customer locations, service bookings, quotes, notifications, provider verification, invitations and booking assignments. This automated integration suite does not replace verifying your own Supabase project and Render deployment.

## 6. Important limitations

Migration 002 adds nullable ownership columns to existing service requests. Older requests are not automatically assigned to a business and remain hidden from authenticated business request endpoints until their ownership is reviewed and backfilled deliberately.

The platform is not production-ready. Customer discovery, saved locations, booking requests, quotes and in-app notifications exist in the API. Provider profiles, skills, coverage, weekly availability, manual verification review, business linking and booking assignment now exist in the API, but provider/customer Android experiences, identity-document upload and automated KYC, payment collection/refunds, reviews, disputes, complete slot-capacity controls and automated email/SMS/push delivery remain incomplete. Provider verification currently requires an explicit manual review using the protected admin API key; it is not an automated identity check.

Before a pilot, configure a least-privilege database role, TLS, separate development and production environments, automated backups and restore tests, privacy and retention procedures. Rotate the database password immediately if it is accidentally exposed.
