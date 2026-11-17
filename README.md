# SwiftServe International

**Smart living starts here.**

SwiftServe is an international household-services platform, starting with a business-first workflow. It is designed to connect customers with service businesses and providers while giving businesses a workspace to manage requests and bookings.

> **Development status:** the API now includes customer, business and provider accounts; business operations; service discovery; saved addresses; booking and quote workflows; provider onboarding/assignment; optional hosted-checkout adapters for Paystack and Flutterwave; a payment transaction ledger; reviews and dispute handling. This is still an MVP, not a production-ready international marketplace. Payment collection is disabled until gateway secrets and the return URL are configured. Automated refunds, provider/business payouts, provider document storage, email/SMS/push delivery, customer/provider Android screens and real Supabase/Render deployment verification remain outstanding.

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
6. apps/api/db/migrations/006_payments_trust.sql

For Render, the API start command can run migrations before starting the server:

    npm run migrate --workspace @swiftserve/api && npm start

The server checks that the required migration records and tables exist before it starts.

Never commit .env files or real credentials. In production, DATABASE_URL is required and the API refuses to start without it. The server checks the configured database and required core tables before listening. A missing migration makes database readiness fail. Without DATABASE_URL in development, the API uses temporary in-memory storage; those records disappear when the process stops.

Migration 002 adds user accounts, businesses, memberships, sessions and nullable ownership columns on service_requests. Migration 003 adds business profiles, branches, service catalogues, opening hours, service coverage and team invitations. Migration 004 adds customer profiles and saved locations, service bookings, quote history, booking status events and in-app notifications. Migration 005 adds provider profiles, skills, service areas, weekly availability, business-provider memberships, provider invitations and booking assignments. Migration 006 adds payment intents, provider transaction records, allocations, refund/payout ledgers, webhook receipts, reviews, business responses, disputes and dispute messages. Existing requests from before migration 002 have no business owner and are not visible through the authenticated business API. Review and associate any retained records deliberately; do not assign them to an arbitrary business.

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

### Payments and settlement

Payment routes are available, but checkout remains disabled unless the selected gateway is explicitly configured on the API server. Do not place gateway secrets in the Android app, frontend, repository or CI artifacts.

Required configuration:

- PAYMENT_PROVIDER=paystack or PAYMENT_PROVIDER=flutterwave
- PAYMENT_RETURN_URL — HTTPS URL for the hosted gateway return flow
- PAYSTACK_SECRET_KEY for Paystack
- FLUTTERWAVE_SECRET_KEY and FLUTTERWAVE_WEBHOOK_SECRET_HASH for Flutterwave
- Optional PAYSTACK_SUPPORTED_CURRENCIES and FLUTTERWAVE_SUPPORTED_CURRENCIES allowlists to restrict currencies per deployment.

The enabled currency set must be checked against the merchant account, gateway product and target market before launch. The code defaults are configuration defaults, not a promise that every account can collect every listed currency or operate in every country.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | /api/v1/customer/bookings/:id/payment-intents | Create a hosted checkout for a confirmed/assigned booking |
| GET | /api/v1/customer/bookings/:id/payment-intents | List the customer's payment attempts for a booking |
| GET | /api/v1/customer/payment-intents/:id | Read one customer-owned payment intent |
| GET | /api/v1/business/bookings/:id/payments | View payment attempts for a business booking |
| POST | /api/v1/webhooks/payments/paystack | Receive signed Paystack webhook events |
| POST | /api/v1/webhooks/payments/flutterwave | Receive signed Flutterwave webhook events |

Payment-intent creation requires an Idempotency-Key. Fixed-price services use the immutable booking price snapshot; quote-priced services require an accepted quote. The API marks a booking paid only after server-to-server verification confirms the provider reference, transaction reference, amount and currency. Webhook signatures are checked before a webhook is processed. Card details are entered on the gateway-hosted checkout page and are not stored by SwiftServe.

Migration 006 also adds transaction, payment allocation, refund, payout and webhook-event ledgers. At this stage refund and payout tables are records only: SwiftServe does not yet submit or reconcile external refund/payout transfers, calculate final business/provider/platform splits, or expose provider settlement accounts. Do not treat a recorded ledger row as money having moved.

### Reviews and service disputes

A customer can review a completed booking once. A business can publish one response to a review. Customers can open one dispute per eligible booking; the business and customer can exchange participant messages, and an admin key can move a case through review/resolution.

| Method | Endpoint | Purpose |
|---|---|---|
| GET / POST | /api/v1/customer/bookings/:id/review | Read or submit a review for a completed booking |
| GET | /api/v1/business/reviews | List published business reviews |
| POST | /api/v1/business/reviews/:reviewId/response | Respond to a review |
| POST | /api/v1/customer/bookings/:id/disputes | Open a dispute |
| GET | /api/v1/customer/disputes | List the customer's disputes |
| GET | /api/v1/customer/disputes/:id | Read a dispute and participant messages |
| POST | /api/v1/customer/disputes/:id/messages | Add a participant message |
| GET | /api/v1/business/disputes | List disputes for the selected business |
| GET | /api/v1/business/disputes/:id | Read a business-owned dispute |
| POST | /api/v1/business/disputes/:id/messages | Add a business participant message |
| GET | /api/v1/admin/disputes | List disputes using the protected admin key |
| GET / PATCH | /api/v1/admin/disputes/:id | Read or update dispute review/resolution state |

Admin dispute routes use SWIFTSERVE_ADMIN_API_KEY as an initial gate. A complete administrator account/role model and actor-attributed admin audit trail are not implemented. The admin key must be stored as a server secret.

### Health checks

- /health reports process liveness.
- /readyz checks database readiness and reports the storage mode.

The simple authentication throttle is process-local. Before horizontal scaling or a large public launch, move rate limiting to a trusted API gateway or shared store and review proxy/IP handling.

## CI

The SwiftServe API CI workflow starts a temporary PostgreSQL 16 service, applies migrations 001–006, runs API HTTP/unit regression tests and runs PostgreSQL integration tests for identity, business isolation, customer bookings, provider assignments, payment-disabled/signature checks, reviews and disputes. The Android APK workflow builds and uploads a debug APK when Android source or build configuration changes.

## Development roadmap

1. Verify the stabilised API deployment and PostgreSQL integration.
2. Complete identity and business isolation, including migration/integration tests, session lifecycle and operational hardening.
3. Complete business operations, including staff invitation delivery, multiple-business switching and full operational reporting.
4. Complete customer discovery, booking, quote handling and notifications, then connect the Android customer experience.
5. Complete provider document storage, customer/provider Android experiences, automated refund/payout settlement, admin identity/audit, and production payment configuration.
6. Prepare one launch market at a time with appropriate country, privacy, tax and payment configuration.

## Security and data use

This is development software. Do not store real customer data or use the API as a public production service until PostgreSQL migrations and persistence are verified, access control is reviewed, rate limiting is moved to an appropriate shared layer, database backups and restore are tested, session policies are reviewed, and privacy, retention, audit and incident-response practices are in place. Do not store payment card data directly.
