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
- [x] Business profile fields, branches, catalogue, hours, service areas and invitations.
- [x] Customer profiles, saved locations, bookings, quotes, status events and notifications.
- [x] Business-scoped service-request and booking reads and writes.
- [ ] Apply migrations 001–004 to the actual development database.
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

## Business workspace data model

Migration 003 adds the following business-owned resources:

- businesses profile fields for description, business contact details, website, country, currency and time zone;
- business_branches with addresses, contact details, active status and a single primary branch per business;
- business_services with category, slug, description, fixed/hourly/quote pricing, currency and optional duration;
- business_hours for weekly opening times at business or branch level;
- business_service_areas for supported country, region, city and postal-code prefixes;
- business_invitations with role, token hash, inviter, expiry and acceptance status.

The branch foreign keys include business_id as part of the reference, preventing a branch from another business from being attached to a business's hours or service coverage. Service catalogue prices are stored in the smallest currency unit and must be interpreted using the configured currency. The current model does not yet include tax, discounts, travel fees or provider commission.

Invitation tokens are stored as hashes. Since no email provider is connected, the API returns the raw token once to the authorized inviter with a pending-delivery notice. The inviter must share it privately. Email verification and automated email delivery remain future work.

## Customer and booking data model

Migration 004 adds:

- customer_profiles: phone, preferred language and locale for a customer account;
- customer_locations: customer-owned service addresses with a default-address constraint;
- bookings: a customer request tied to one active business service, optional branch and selected address;
- booking_quotes: versioned price quotes, expiry and customer response state;
- booking_status_events: an append-only status history with the acting user and note;
- notifications: in-app notifications scoped to the recipient user.

The booking record snapshots the service name, category, pricing model, currency, service price, recipient and full service address. The snapshots prevent edits to the original service listing or saved address from silently changing existing bookings. The currency is retained with the booking, and prices are stored in the smallest currency unit.

Composite foreign keys enforce that the service and branch belong to the same business, that a saved location belongs to the customer making the booking, and that quotes/status events belong to the booking's business. A customer cannot attach another customer's saved location or another business's branch through a guessed UUID.

The current schema has no payment intent or provider assignment table yet. No payment is collected by the current booking flow. It also does not implement a slot-capacity ledger; business opening hours and coverage areas are used for validation, but simultaneous booking conflicts require a later availability/capacity phase.

## Existing data and backfill

Migration 002 deliberately adds nullable business ownership columns to existing service_requests. It does not automatically assign old requests to a new business. Requests with NULL business_id are not visible in the authenticated business API.

Before retaining old records, identify their true owner and use a reviewed, auditable backfill. Do not attach legacy requests to an arbitrary account or business merely to make them visible.

## Local setup

1. Create a development PostgreSQL database with your chosen managed provider.
2. Copy apps/api/.env.example to apps/api/.env.
3. Set DATABASE_URL in the local environment. Do not commit the .env file.
4. Run npm run migrate --workspace @swiftserve/api to apply migrations 001–004 in order.
5. Start the API and open /readyz. It should report PostgreSQL storage when the connection succeeds.
6. Register a test business, create a service, branch and coverage area; register a test customer, save an address and request a booking.
7. Issue and accept a test quote, then verify the booking, status history and notifications remain after restarting the API.

For deployment, add DATABASE_URL as a secret environment variable in the hosting provider. Do not put it in frontend code, a GitHub source file or a public CI log.

## Supabase connection guidance

Use the connection string format recommended by Supabase for the hosting environment. Pooler and direct connection options have different use cases; choose the one supported by the host and database workload. Require TLS where supported.

## Before a real pilot

- Create a least-privilege database role for the API.
- Keep development and production databases separate.
- Enable automated backups and test restoration.
- Run the migration runner and verify all four schema versions against the actual development database.
- Verify customer address ownership, booking isolation, quote lifecycle and notifications against the deployed PostgreSQL environment.
- Enforce business ownership in every read and write query.
- Establish data minimization, retention and deletion practices.
- Review session expiry, revocation and device token storage.
- Never store payment card details directly.
