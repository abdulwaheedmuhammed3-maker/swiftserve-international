# SwiftServe International

**Smart living starts here.**

SwiftServe is an international household-services platform, starting with a business-first workflow. It is designed to connect customers with service businesses and providers while giving businesses a workspace to manage requests and bookings.

> **Development status:** the API now includes customer, business and provider accounts; business operations; service discovery; booking/quote workflows; provider onboarding and assignment; Paystack payment intents and verification; refund records; provider payout accounting; reviews and disputes. This remains an MVP under active development, not a production-ready international marketplace. Provider identity-document upload, complete admin roles, email/SMS/push delivery, Android customer/provider screens and real Supabase/Render deployment verification remain outstanding.

## Repository structure

    app/                 Android business MVP
    apps/api/            Node.js REST API
    docs/                Architecture, database, setup and roadmap

## Android business MVP

The Android app supports business account registration, sign-in and sign-out, and business-scoped request management. It can also store development test requests locally on the device.

The app stores the bearer session encrypted with an AES key held by Android Keystore. It currently selects the first business returned by the API; a business switcher and team invitations are not yet implemented.

The app is a development MVP. Do not use it for real customer information until deployment security, business administration, backup/restore, privacy and operational procedures have been reviewed.

A debug APK is produced by the Android APK GitHub Actions workflow. Open the workflow run in the repository's Actions tab and download the SwiftServe-debug-apk artifact.

## API

Requirements:

- Node.js 20 or later
- npm
- PostgreSQL for persistent storage

From the repository root:

    npm install
    npm test
    npm run dev

The API defaults to port 3000. The server binds to 0.0.0.0 by default and uses the PORT environment variable when supplied.

### Configuration and migrations

Copy apps/api/.env.example to apps/api/.env for local development and set DATABASE_URL only when connecting to a development PostgreSQL database.

Run the ordered SQL migration runner after setting DATABASE_URL:

    npm run migrate --workspace @swiftserve/api

The runner applies pending SQL migrations in filename order, stores checksums in schema_migrations and refuses to silently accept changes to an already-applied migration. It is safe to run again during deployment. Never edit an already-applied migration; add a new numbered migration instead.

The current migrations are:
1. apps/api/db/migrations/001_initial_schema.sql
2. apps/api/db/migrations/002_identity_business_scope.sql
3. apps/api/db/migrations/003_business_operations.sql
4. apps/api/db/migrations/004_customer_bookings.sql
5. apps/api/db/migrations/005_provider_operations.sql
6. apps/api/db/migrations/006_finance_reviews_disputes.sql

For Render, the API start command can run migrations before starting the server:

    npm run migrate --workspace @swiftserve/api && npm start

The server checks that the required migration records and tables exist before it starts.

Never commit .env files or real credentials. In production, DATABASE_URL is required and the API refuses to start without it. The server checks the configured database and required core tables before listening. A missing migration makes database readiness fail. Without DATABASE_URL in development, the API uses temporary in-memory storage; those records disappear when the process stops.

Migration 002 adds user accounts, businesses, memberships, sessions and nullable ownership columns on service_requests. Migration 003 adds business profiles, branches, service catalogues, opening hours, service coverage and team invitations. Migration 004 adds customer profiles and saved locations, service bookings, quote history, booking status events and in-app notifications. Migration 005 adds provider profiles, skills, service areas, weekly availability, business-provider memberships, provider invitations and booking assignments. Migration 006 adds payment intents/events, refunds, provider payout accounts and ledger entries, reviews and dispute records/messages/events. Existing requests from before migration 002 have no business owner and are not visible through the authenticated business API. Review and associate any retained records deliberately; do not assign them to an arbitrary business.

### Authentication endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| POST | /api/v1/auth/register | Create a customer, business or provider account |
| POST | /api/v1/auth/login | Start a 7-day bearer session |
| POST | /api/v1/auth/logout | Revoke the current session |
| GET | /api/v1/auth/me | Retrieve the signed-in profile and business memberships |

Business registration creates a business and an owner membership. Provider registration requires a country code and creates a provider profile. Passwords are hashed with scrypt. Opaque session tokens are returned once to the client; only SHA-256 token hashes are stored by the API.

### Business request endpoints

All /api/v1/jobs endpoints require:

- Authorization: Bearer <accessToken>
- X-SwiftServe-Business-Id: <business UUID>

The API verifies active membership before reading or changing business requests. A business cannot access another business's jobs by changing the requested job ID or the business header.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | /api/v1/jobs | Create a service request |
| GET | /api/v1/jobs | List requests for the selected business |
| GET | /api/v1/jobs/:id | Retrieve a request belonging to that business |
| PATCH | /api/v1/jobs/:id | Update request details or supported status |
| DELETE | /api/v1/jobs/:id | Delete a request (owner/admin only) |

The current status lifecycle is pending → accepted → completed, with cancellation allowed from pending or accepted. Completed and cancelled requests are terminal in this MVP.

### Business workspace endpoints

All business workspace endpoints require the same bearer access token and X-SwiftServe-Business-Id header.

| Method | Endpoint | Purpose |
|---|---|---|
| GET / PATCH | /api/v1/business/profile | Read or update business profile |
| GET / POST | /api/v1/business/services | List or add catalogue items |
| GET / PATCH / DELETE | /api/v1/business/services/:id | Read, edit or delete a catalogue item |
| GET / POST | /api/v1/business/branches | List or add branches |
| GET / PATCH / DELETE | /api/v1/business/branches/:id | Read, edit or delete a branch |
| GET / PUT | /api/v1/business/hours | Read or set weekly opening hours |
| GET / POST | /api/v1/business/service-areas | List or add service coverage areas |
| PATCH / DELETE | /api/v1/business/service-areas/:id | Edit or delete a coverage area |
| GET | /api/v1/business/team/members | List active business members |
| PATCH / DELETE | /api/v1/business/team/members/:userId | Change a member role or remove a member |
| GET / POST | /api/v1/business/team/invitations | List or create team invitations |
| DELETE | /api/v1/business/team/invitations/:id | Revoke a pending invitation |
| POST | /api/v1/auth/invitations/accept | Accept an invitation with the signed-in account |

Business profile updates, team changes and destructive operations are role-restricted. A business owner cannot be demoted or removed through the team routes. Branch references are constrained to the same business in PostgreSQL.

Service prices use the priceMinor field, the smallest currency unit (for example, kobo for NGN). The current opening-hours model accepts 24-hour HH:MM values and does not yet support an overnight opening interval.

There is no email delivery provider configured yet. Creating a team invitation returns its raw invitation token once in the API response with a pending-delivery notice. Share it privately; do not place it in logs, public messages or screenshots.

### Customer marketplace and booking endpoints

Public service discovery does not require an account. Customer profile, address and booking routes require a signed-in customer account.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | /api/v1/market/services | Discover active services; filter by countryCode, city, category and search |
| GET / PATCH | /api/v1/customer/profile | Read or update customer contact and locale preferences |
| GET / POST | /api/v1/customer/locations | List or save private service addresses |
| GET / PATCH / DELETE | /api/v1/customer/locations/:id | Read, edit or delete an address owned by the customer |
| GET / POST | /api/v1/customer/bookings | List bookings or request a service |
| GET | /api/v1/customer/bookings/:id | Retrieve one booking belonging to the customer |
| GET | /api/v1/customer/bookings/:id/quotes | View quote history |
| POST | /api/v1/customer/bookings/:id/quotes/:quoteId/response | Accept or decline a pending quote |
| POST | /api/v1/customer/bookings/:id/cancel | Cancel an eligible booking |
| GET | /api/v1/customer/bookings/:id/events | View booking status history |

A booking request must include an active service, a future ISO-8601 start time and either a saved address or an inline service address. The API checks the selected business's active branch and listed service coverage. Address details are copied into the booking record so later edits to a saved customer location do not silently alter an existing booking.

### Business booking and notification endpoints

Business booking routes require the bearer token and X-SwiftServe-Business-Id header.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | /api/v1/business/bookings | List bookings for the selected business |
| GET | /api/v1/business/bookings/:id | Retrieve a business-owned booking |
| GET / POST | /api/v1/business/bookings/:id/quotes | View or issue a price quote |
| PATCH | /api/v1/business/bookings/:id/status | Confirm, decline, cancel or progress a booking |
| GET | /api/v1/business/bookings/:id/events | View booking status history |
| GET | /api/v1/notifications | List notifications for the signed-in user |
| PATCH | /api/v1/notifications/:id/read | Mark an owned notification as read |

Quote values use amountMinor, the smallest unit of the booking currency (for example, kobo for NGN). Quotes expire after 72 hours by default unless the business provides a different expiry. Accepting a quote confirms the booking at the requested time. No payment is collected in this phase.

The current booking lifecycle includes requested, quoted, confirmed, assigned, in_progress, completed, cancelled and declined. Assigned jobs now have an offer/accept/decline workflow and provider progress/completion updates. Payment collection is still not connected.

### Provider onboarding and job endpoints

Provider routes require a signed-in account created with accountType set to provider.

| Method | Endpoint | Purpose |
|---|---|---|
| GET / PATCH | /api/v1/provider/profile | Read or update provider profile |
| GET / PUT | /api/v1/provider/skills | List or replace provider service skills |
| GET / POST | /api/v1/provider/service-areas | List or add provider coverage |
| DELETE | /api/v1/provider/service-areas/:id | Remove a provider coverage area |
| GET / PUT | /api/v1/provider/availability | Read or replace weekly availability |
| POST | /api/v1/provider/verification/request | Submit the provider profile for review |
| POST | /api/v1/provider/invitations/accept | Accept a business invitation |
| GET | /api/v1/provider/bookings | List offered and accepted job assignments |
| GET | /api/v1/provider/bookings/:bookingId | Retrieve an active provider assignment |
| POST | /api/v1/provider/bookings/:bookingId/respond | Accept or decline an offered assignment |
| PATCH | /api/v1/provider/bookings/:bookingId/status | Start or complete assigned work |

A provider must add at least one skill, one coverage area and one availability day before requesting verification. Businesses can only assign work to providers who have been approved and are active members of that business. The assignment API checks the provider's skill, service coverage, local-time weekly availability and overlapping offered/accepted assignments.

Business provider-management routes require a business bearer token and X-SwiftServe-Business-Id:

| Method | Endpoint | Purpose |
|---|---|---|
| GET | /api/v1/business/providers | List linked providers and their verification state |
| GET / POST | /api/v1/business/providers/invitations | List or invite providers |
| DELETE | /api/v1/business/providers/invitations/:id | Revoke a pending provider invitation |
| GET / POST | /api/v1/business/bookings/:id/assignments | List or offer a booking assignment |
| DELETE | /api/v1/business/bookings/:id/assignments/:assignmentId | Cancel an active assignment |

Provider invitation delivery is not automated. The API returns the invitation token once to the authorized business user; share it privately with the invited provider. Verification approval is a protected manual review operation. Configure SWIFTSERVE_ADMIN_API_KEY as a secret environment variable before using these endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| GET | /api/v1/admin/providers/pending | List providers awaiting review |
| PATCH | /api/v1/admin/providers/:userId/verification | Approve or reject a provider |

The admin key must never be committed to GitHub or placed in Android/mobile code. Provider identity-document file uploads and storage are not implemented in this phase; approval is an operational review flag, not automated identity verification.

### Payments, refunds and provider payouts

Online payment collection is implemented through a server-side Paystack adapter. No gateway keys are included in the repository. Configure these secrets in the API runtime before enabling payments:

| Variable | Purpose |
|---|---|
| DATABASE_URL | PostgreSQL connection |
| PAYSTACK_SECRET_KEY | Server-side Paystack secret key |
| PAYSTACK_WEBHOOK_SECRET | Paystack webhook HMAC secret (or PAYSTACK_WEBHOOK_SECRETS for rotated keys) |
| PAYSTACK_CALLBACK_URL | Optional checkout return URL |
| SWIFTSERVE_ADMIN_API_KEY | Protected manual provider-review, payout and dispute administration |
| SWIFTSERVE_PLATFORM_FEE_BPS | Platform fee in basis points; defaults to 0 and is capped at 5,000 (50%) |

Never add gateway or admin secrets to Android, frontend code, GitHub source files, screenshots or client responses. Start with Paystack test credentials and a test account. The API accepts payment success only after its server verifies the transaction reference, amount and currency with Paystack. A browser return or unsigned webhook cannot mark a payment successful.

The configured webhook URL is:

    https://YOUR_API_HOST/api/v1/webhooks/paystack

Configure that URL in Paystack and enable the relevant charge, refund and transfer events. The webhook handler validates the signature against the raw request body, applies a five-minute timestamp window for the versioned signature format, and rejects unsigned/invalid requests. Event IDs are stored to ignore duplicate deliveries.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | /api/v1/customer/bookings/:id/payments | Initialize checkout for a confirmed booking |
| GET | /api/v1/customer/bookings/:id/payments | List payment attempts for the customer-owned booking |
| POST | /api/v1/customer/payments/:paymentId/verify | Verify the transaction with Paystack |
| GET | /api/v1/business/bookings/:id/payments | View payment records (owner/admin/manager) |
| GET / POST | /api/v1/business/bookings/:id/refunds | View or request a full/partial refund |
| POST | /api/v1/webhooks/paystack | Receive signed Paystack payment/refund/transfer events |

Payment initialization requires an Idempotency-Key header. The amount is taken from the booking's confirmed price snapshot; when a customer accepts a quote, the accepted quote amount becomes the payable booking price. Prices are stored in currency subunits (for example, kobo for NGN). The current Paystack currency/country allowlist is intentionally limited and is not a claim that every SwiftServe market is enabled.

A refund request is recorded before the gateway operation. Refund status is updated from gateway responses/events, and processed refund amounts reduce the amount available for provider payout. An admin decision in the dispute workflow does not automatically create a refund; an authorized business user must submit the refund request separately.

### Provider payout records

Providers can register a payout recipient through Paystack and view their payout history:

| Method | Endpoint | Purpose |
|---|---|---|
| GET / POST / PUT | /api/v1/provider/payout-account | View or register a provider payout recipient |
| GET | /api/v1/provider/payouts | View provider payout ledger entries |
| GET | /api/v1/admin/payouts/pending | List payout entries awaiting transfer (admin key required) |
| POST | /api/v1/admin/payouts/:id/process | Initiate a provider transfer (admin key required) |

The current payout-account registration supports Nigerian Naira (NGN) NUBAN bank accounts only. The full bank account number is sent to Paystack over HTTPS and is not stored by SwiftServe; the database retains the provider recipient code and masked account details. Payouts are created from completed provider assignments and verified booking payments. The platform fee defaults to zero until an agreed business rate is configured. Payout processing is manually initiated by an authorized administrator; transfer webhooks update the payout status.

### Reviews and disputes

| Method | Endpoint | Purpose |
|---|---|---|
| POST | /api/v1/customer/bookings/:id/review | Submit one 1–5 star review for a completed booking |
| GET | /api/v1/business/reviews | List published reviews for a business |
| GET | /api/v1/provider/reviews | List published reviews for a provider |
| GET / POST | /api/v1/customer/bookings/:id/disputes | View or open a dispute on an eligible booking |
| GET / POST | /api/v1/customer/disputes/:id/messages | View or add a customer dispute message |
| GET | /api/v1/business/disputes | List business disputes |
| GET / POST | /api/v1/business/bookings/:id/dispute | View or open a business-side dispute |
| GET / POST | /api/v1/business/disputes/:id/messages | View or respond to a dispute |
| GET | /api/v1/admin/disputes/pending | List open/in-review disputes (admin key required) |
| PATCH | /api/v1/admin/disputes/:id | Move a dispute to review or record a resolution (admin key required) |

Reviews require a completed booking and are limited to one review per booking. Dispute messages are scoped to the booking's customer or business. The current dispute workflow records status and resolution decisions; it does not automatically issue a refund, adjudicate uploaded evidence, or provide a complete support case-management interface.

### Finance and trust limitations

Phase 6 has been designed and tested against a local mock Paystack server in CI. That verifies the API workflow, not a live Paystack merchant account, live settlement, bank transfers or a deployed webhook. No production gateway secret has been added. Before accepting real money, apply migration 006 to the intended development database, configure Paystack test credentials and webhooks, complete a real sandbox payment/refund/transfer test, reconcile gateway statements, and review the supported countries/currencies and payout compliance for the launch market.

### Health checks

- /health reports process liveness.
- /readyz checks database readiness and reports the storage mode.

The simple authentication throttle is process-local. Before horizontal scaling or a large public launch, move rate limiting to a trusted API gateway or shared store and review proxy/IP handling.

## CI

The SwiftServe API CI workflow starts a temporary PostgreSQL 16 service, applies migrations 001–006, runs API HTTP/unit regression tests and runs PostgreSQL integration tests for identity, business isolation, customer locations, service bookings, provider operations, Paystack payment verification, partial refunds, provider transfers, reviews and disputes. The finance integration test uses a local mock gateway and does not contact Paystack. The Android APK workflow builds and uploads a debug APK when Android source or build configuration changes.

## Development roadmap

1. Verify the stabilised API deployment and PostgreSQL integration.
2. Complete identity and business isolation, including migration/integration tests, session lifecycle and operational hardening.
3. Complete business operations, including staff invitation delivery, multiple-business switching and full operational reporting.
4. Complete customer discovery, booking, quote handling and notifications, then connect the Android customer experience.
5. Complete provider documents/storage, customer/provider Android experiences, payment collection, refunds, reviews and dispute workflows.
6. Prepare one launch market at a time with appropriate country, privacy, tax and payment configuration.

## Security and data use

This is development software. Do not store real customer data or use the API as a public production service until PostgreSQL migrations and persistence are verified, access control is reviewed, rate limiting is moved to an appropriate shared layer, database backups and restore are tested, session policies are reviewed, and privacy, retention, audit and incident-response practices are in place. Do not store payment card data directly.
