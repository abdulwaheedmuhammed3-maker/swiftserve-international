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
- [x] Provider profiles, skills, coverage areas, weekly availability and business links.
- [x] Provider invitation, verification review and booking assignment tables.
- [x] Payment intent/transaction, allocation, refund/payout and webhook event tables.
- [x] Review, business response, dispute and dispute-message tables.
- [ ] Apply migrations 001–006 to the actual development database.
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

## Provider operations data model

Migration 005 adds:

- provider_profiles: provider display/contact details, home country, time zone, onboarding status and manual verification status;
- provider_skills: supported service categories and years of experience;
- provider_service_areas: country, region, city and postal-code-prefix coverage;
- provider_availability: one weekly availability window per day in the provider's time zone;
- business_provider_memberships: the provider's active/inactive link to a business;
- provider_invitations: expiring business invitations stored by token hash;
- booking_assignments: provider offer/accept/decline/cancel/completion state, schedule, business/booking/provider membership references;
- provider_status_events: provider verification and review-state history.

A booking assignment has composite foreign keys to its booking and business-provider membership. PostgreSQL enforces one active offer/accepted assignment per booking. The API serializes assignment creation per provider and rejects time overlaps for offered or accepted jobs.

The assignment API verifies active business membership, provider verification/onboarding state, service skill, coverage area and weekly availability in the provider's configured time zone. This is not a full provider capacity engine: travel time, job buffers, business slot capacity, rescheduling and multi-day/overnight schedules are not implemented.

Provider verification currently records a manual review decision. No identity-document file storage, biometric checks, background-check vendor or automated KYC integration is implemented. The admin review route uses the SWIFTSERVE_ADMIN_API_KEY secret as an initial administrative gate; a full admin user/role and review audit identity system remains future work.

Provider invitations store token hashes. As no outbound email provider is connected, the raw token is returned once to the business user for private sharing. Acceptance requires a signed-in provider account whose email matches the invitation.

## Payments and trust data model

Migration 006 adds:

- bookings.payment_status: not_required, pending, paid, failed, partially_refunded or refunded;
- payment_intents: customer/booking-scoped hosted-checkout attempts, idempotency key, provider reference, amount, currency and verification state;
- payment_transactions: verified charge/refund/adjustment records with provider references;
- payment_allocations: intended platform/business/provider allocations;
- refunds: refund request/processing ledger records;
- payouts: business/provider payout ledger records and external account references;
- payment_webhook_events: signed event hashes, idempotency and processing state;
- service_reviews and service_review_responses: one review per completed booking and one business response;
- service_disputes and service_dispute_messages: booking dispute state and participant/admin-only messages.

Payment intents reference the business and booking through a composite foreign key. Amounts are stored in the smallest currency unit, and the currency is stored on every payment/transaction/ledger row. The hosted-checkout adapters store only gateway references and checkout URLs; SwiftServe does not store card numbers, CVV values or customer wallet balances.

The current payment flow verifies provider transaction status, exact reference, amount and currency before marking the booking paid. Webhook signatures are checked before processing, and provider event identifiers are stored to prevent duplicate settlement. The API requires an Idempotency-Key on payment creation.

Important: payment allocation, refund and payout tables are ledger foundations only. The API does not yet submit external refund or payout transfers, reconcile bank settlement, or calculate final platform/business/provider commission shares. A row in those tables is not evidence that funds moved. Payment collection is disabled unless a gateway provider, server-side credentials, HTTPS return URL and currency configuration are supplied.

The initial adapters support Paystack and Flutterwave hosted checkout. Runtime variables include PAYMENT_PROVIDER, PAYMENT_RETURN_URL, PAYSTACK_SECRET_KEY, FLUTTERWAVE_SECRET_KEY and FLUTTERWAVE_WEBHOOK_SECRET_HASH. Optional per-gateway currency allowlists can restrict the currencies enabled in that environment. The default allowlists are code configuration only; verify actual merchant/product/country/currency capability and settlement access with the gateway before enabling a market.

Reviews are limited to completed bookings, and a customer can create only one review for a booking. Disputes are limited to eligible bookings and one dispute per booking. The current platform admin endpoint uses SWIFTSERVE_ADMIN_API_KEY as a temporary gate; it does not yet use administrator accounts/roles or record an authenticated admin actor on resolutions.

## Existing data and backfill

Migration 002 deliberately adds nullable business ownership columns to existing service_requests. It does not automatically assign old requests to a new business. Requests with NULL business_id are not visible in the authenticated business API.

Before retaining old records, identify their true owner and use a reviewed, auditable backfill. Do not attach legacy requests to an arbitrary account or business merely to make them visible.

## Local setup

1. Create a development PostgreSQL database with your chosen managed provider.
2. Copy apps/api/.env.example to apps/api/.env.
3. Set DATABASE_URL in the local environment. Do not commit the .env file.
4. Run npm run migrate --workspace @swiftserve/api to apply migrations 001–006 in order.
5. Start the API and open /readyz. It should report PostgreSQL storage when the connection succeeds.
6. Register a test business, create a service, branch and coverage area; register a test customer, save an address and request a booking.
7. Register a provider, add skills, areas and availability, submit for review and approve using the configured admin secret.
8. Invite the provider to the business, accept the invitation, assign a confirmed booking and complete the provider workflow.
9. Configure gateway test credentials only in the local API environment, verify a gateway test checkout and signed webhook, then test disabled mode after removing the credentials.
10. Submit a review, open a test dispute, exchange messages and resolve it using the protected admin route.
11. Restart the API and verify customer, provider, payment, review and dispute records remain.

For deployment, add DATABASE_URL as a secret environment variable in the hosting provider. Do not put it in frontend code, a GitHub source file or a public CI log.

## Supabase connection guidance

Use the connection string format recommended by Supabase for the hosting environment. Pooler and direct connection options have different use cases; choose the one supported by the host and database workload. Require TLS where supported.

## Before a real pilot

- Create a least-privilege database role for the API.
- Keep development and production databases separate.
- Enable automated backups and test restoration.
- Run the migration runner and verify all six schema versions against the actual development database.
- Verify customer address ownership, booking isolation, quote lifecycle, provider verification, invitations, assignment authorization and schedule conflicts against the deployed PostgreSQL environment.
- Before enabling live checkout, run each gateway's test mode for initialization, signature verification, amount/currency mismatch, duplicate webhook, refund and payout reconciliation.
- Enforce business ownership in every read and write query.
- Establish data minimization, retention and deletion practices.
- Review session expiry, revocation and device token storage.
- Never store payment card details directly.
