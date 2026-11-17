# SwiftServe Architecture

## Product direction

SwiftServe is an international household-services platform with three connected experiences:

- **Customer experience:** discover services, request quotes or bookings, track fulfilment, communicate with providers and pay through supported local methods.
- **Business workspace:** manage a business profile, service catalogue, service areas, schedules, incoming bookings, team members and operational performance.
- **Provider experience:** manage availability, assigned work, verification status, job progress, earnings and customer feedback.

A platform administration workspace will support onboarding, disputes, market configuration, compliance and operational oversight.

## Architecture strategy

Start with a modular monolith: one deployable API with clearly separated domain modules and a managed PostgreSQL database. This is easier to operate and more economical for an early product than introducing distributed services. Extract services only when actual workload, team boundaries or reliability needs justify it.

The Android application is currently a limited business workspace. The backend is a Node.js HTTP REST API. PostgreSQL is used when DATABASE_URL is configured; development without a database uses temporary in-memory storage. Production refuses to start without DATABASE_URL.

## Current implementation

- Versioned REST API for service request create, list, retrieve, update and delete.
- Server-side input validation, JSON content-type checks and a 1 MB body limit.
- UUID validation and a limited job-status lifecycle with concurrent-update protection.
- PostgreSQL repository adapter with parameterized queries.
- Users, businesses, business memberships and bearer sessions.
- Password hashing with scrypt and opaque bearer tokens with SHA-256 hashes stored in the database.
- Registration, login, logout and current-profile endpoints.
- Business membership checks for every service-request API operation.
- Business-scoped request reads, updates and deletes.
- Process liveness at /health and dependency readiness at /readyz.
- Process-local throttling for registration and login attempts.
- Android business app with registration, login, logout and encrypted session-token storage using Android Keystore.
- Business profile, branches, service catalogue, weekly hours, service coverage and team invitation API modules.
- Public service discovery filtered by country, city, category and search term.
- Customer profiles and private saved service locations.
- Tenant-scoped booking requests, immutable address/price snapshots, quote history and status events.
- In-app notifications for new bookings, quotes, quote responses, status changes and cancellations.
- Checksum-verified migrations 001–006 and PostgreSQL 16 CI integration tests.
- Hosted checkout adapters for Paystack and Flutterwave with server-side credentials, payment idempotency, webhook signature checks and server-to-server transaction verification.
- Payment intent, transaction, allocation, refund, payout and webhook-event ledger tables; no card data or customer wallet balances are stored.
- Customer reviews, business review responses, customer/business dispute threads and protected admin dispute resolution.
- Provider account registration and provider profiles with service skills, service areas and weekly availability.
- Manual provider verification request/review workflow protected by a server-side admin API key.
- Business-provider invitation and membership workflow.
- Booking assignment offers with provider acceptance/decline, availability and overlap checks, and provider progress/completion updates.
- API regression tests and GitHub Actions workflows for API CI and debug APK builds.

## Known limitations

- No email verification, password reset, MFA or account recovery.
- Session refresh and administrative session revocation are not implemented; bearer sessions expire after seven days.
- Public registration supports customer, business and provider account types; registration abuse controls must be reviewed before public launch.
- Provider verification is a manual review flag; identity-document upload, storage and automated checks are not implemented.
- Authentication throttling is process-local and should move to a shared gateway/store before horizontal scaling.
- Legacy service requests created before business ownership was added are intentionally unassigned and hidden from business-scoped routes until a reviewed backfill is performed.
- The Android app selects the first returned business; multi-business switching, team invitations and role-based screens are not implemented.
- The Android app still provides the business service-request MVP; customer marketplace and booking screens are not implemented.
- Provider onboarding and assignment exist in the API, but there is no dedicated provider or customer mobile app.
- Provider and business invitation tokens are returned once for private out-of-band sharing; no email delivery provider is configured.
- Assignment checks provider schedule overlaps, but there is no full business slot-capacity/booking conflict engine or rescheduling flow.
- Payment collection is disabled until an operator configures a supported gateway, return URL, server secrets and currency allowlist. CI uses mocked gateway calls only; no real transaction has been processed.
- Refund and payout tables currently record intended/externally processed activity; SwiftServe does not yet initiate or reconcile actual refund/payout transfers, create provider settlement accounts, or calculate final platform/business/provider splits.
- The admin dispute endpoint uses a shared API key, not an authenticated administrator account; dispute resolutions are not yet attributable to a specific admin user.

## Identity and authorization model

- A user authenticates with email and password.
- A password is stored as a scrypt hash; plaintext passwords are never persisted.
- A successful registration/login creates a random opaque bearer token with a seven-day expiry.
- The API stores only the SHA-256 token hash in sessions; logout revokes the stored session.
- A business registration creates a business and an owner membership.
- A request to a business-owned endpoint must include a bearer token and X-SwiftServe-Business-Id.
- The API checks active business membership server-side before reading or changing requests.
- All service-request and business-booking reads and writes are scoped to business_id in server-side queries.
- Customer profile and location queries are scoped to the authenticated customer user ID.
- Owners/admins/managers can issue quotes and change booking status; active staff can view bookings but cannot manage quote or status actions.

The business identifier supplied by the client is only a selection hint. It is not authority by itself. The membership check and scoped SQL query are the security boundary.

## Proposed domain modules

1. **Identity and access:** users, authentication, sessions, roles, business memberships, permissions, recovery and MFA.
2. **Market configuration:** countries, currencies, time zones, locales, supported payment methods and service availability.
3. **Business management:** business profiles, branches, team members, operating hours, service areas and service catalogues.
4. **Customer accounts:** profiles, contact preferences, saved locations and consent records.
5. **Provider operations:** provider profiles, onboarding, verification workflow, availability and service coverage.
6. **Bookings:** quote requests, booking confirmation, scheduling, assignment, cancellation, status history and completion evidence.
7. **Communications:** email, SMS and push notifications behind provider adapters.
8. **Payments and finance:** payment intents, provider payouts, refunds, fees, settlement and reconciliation through country-specific adapters.
9. **Trust and safety:** reviews, reports, disputes, moderation, audit events and support workflows.
10. **Administration and analytics:** market operations, platform configuration, service quality, revenue and operational reporting.

## Payments, refunds and settlement model

The booking payment flow is provider-agnostic and currently has Paystack and Flutterwave hosted-checkout adapters. The customer receives a gateway-hosted checkout URL; SwiftServe does not collect or store card numbers, security codes or wallet balances.

A payment intent is tied to one customer-owned booking and is created with an Idempotency-Key. Fixed-price bookings use the immutable booking price snapshot; quote-based bookings require the latest customer-accepted quote. The API marks a booking paid only after a signed webhook has been accepted and a server-to-server verification call matches the stored provider reference, transaction reference, amount and currency. Webhook event IDs are stored for replay protection, and transient verification failures can be retried.

Currency allowlists and gateway credentials are runtime configuration. A supported currency in code does not prove that a merchant account has collection/payout access in that market. Before enabling a country, verify the specific gateway product, merchant onboarding, settlement currency, payout corridor, fees, chargeback/refund rules and applicable regulation. Payment remains disabled when the gateway is not configured.

Migration 006 introduces ledgers for payment intents, provider transactions, allocations, refund requests, payouts and webhook receipts. Refund and payout transfers are not executed by the current API; these tables do not prove that funds have moved. Final allocation rules, reconciliation, settlement accounts and actual refund/payout provider integration remain to be implemented.

## Reviews and disputes model

A customer can create one review for a completed booking. The business may publish a response. One dispute can be opened for an eligible booking; customer and business participants can add messages while the case is open. The initial admin review/resolution endpoint uses SWIFTSERVE_ADMIN_API_KEY as a temporary gate. It does not identify the acting administrator in the database. A proper admin account/role, actor-attributed audit trail, evidence attachments and case service-level workflow are future work.

## Provider operations model

Provider accounts use the provider account type and have a provider_profiles record. Providers maintain service skills, coverage areas and weekly availability. A provider must complete those sections and submit their profile for review before the manual verification state can be approved.

The current manual review API is protected by the SWIFTSERVE_ADMIN_API_KEY runtime secret. The key is supplied through an admin header and is never stored in the repository or mobile apps. This is an initial admin gate, not a full platform-admin identity/role system. Provider identity documents are not uploaded or stored in this phase, so the verified status is an explicit operational review decision rather than automated KYC.

Businesses can invite provider accounts by email. The invitation token is stored as a hash and is returned once to the authorized business user because automated email delivery is not configured. The invited provider must accept while signed in with the invited email. Acceptance creates a business-provider membership.

A booking can be offered to a provider only when its business membership is active, the provider is verified and active, the required service skill matches, the booking address is covered, and the scheduled period fits the provider's weekly availability in their configured time zone. Overlapping offered/accepted assignments are rejected. The provider can accept or decline an offer and, after accepting, move the booking to in_progress and completed. Business users can cancel an active assignment.

Provider and booking status transitions are recorded in booking_status_events, provider_status_events and assignment records. Notifications are stored in-app; push, SMS and email delivery adapters are not connected yet.

## Customer marketplace and booking model

Public marketplace discovery returns active business services and can filter by country, city, category and text search. Customer routes require a customer account. Saved locations are owned by a customer user and are never selected by an arbitrary client-supplied owner ID.

A booking stores a snapshot of the service name, category, pricing model, currency, service price, service address and requested schedule. This prevents future edits to a business catalogue item or customer saved address from silently changing an existing booking. Composite foreign keys scope service, branch, customer location, quote and status-event references.

The current lifecycle is requested → quoted → confirmed, followed later by provider assignment and work progress. A customer can accept or decline a pending quote or cancel a booking while it is requested, quoted or confirmed. The business can confirm, decline or cancel a request, and move a confirmed booking into work progress and completion. Invalid transitions are rejected.

Quote amounts are recorded in the smallest unit of the booking currency. This phase does not collect payment or reserve provider capacity. Opening hours and service coverage are stored, and the booking API checks the configured branch/coverage area, but slot conflict/capacity checks are still a future requirement.

In-app notifications are stored for booking and quote events. Email, SMS and push delivery providers are not connected yet.

## Business operations model

Business profile metadata lives on businesses. Multiple addresses and operating locations are stored as business_branches. Catalogue items use business_services with pricing model, currency and duration. business_hours supports a weekly schedule for the overall business or a specific branch. business_service_areas describe the supported country, region, city or postal-code prefix. Team invitations use expiring token hashes and create a business_membership only after an authenticated account with the invited email accepts.

Branch references in hours and service areas are constrained by composite foreign keys on both business_id and branch_id. This ensures that valid UUIDs alone cannot be used to attach a different business's branch.

The current invitation route returns the raw invite token once to the authorized inviter because no outbound email provider is connected. Do not treat invitation creation as delivery. The inviter must share the token privately until an email provider is integrated.

## Data model direction

The schema should evolve through reviewed, ordered migrations. Expected entities include:

- countries, currencies and supported markets
- users, sessions, roles and permissions
- businesses, branches and business_memberships
- customer_profiles and provider_profiles
- service_categories, business_services and service_areas
- availability_windows and operating_hours
- service_requests, quotes, bookings and booking_status_events
- provider_assignments and verification_checks
- payment_intents, payments, payouts and refunds
- reviews, disputes, notifications and audit_events

Every business-owned record must have an explicit ownership path. Authorization must be enforced server-side in every read and write query; hiding records in the client is not security.

## API conventions

- Keep versioned routes under /api/v1.
- Validate request bodies and query parameters at the API boundary.
- Use consistent JSON error envelopes and appropriate HTTP status codes.
- Use parameterized database queries.
- Add pagination, filtering and sorting to collection endpoints.
- Enforce authentication and resource-level authorization for protected routes.
- Use idempotency for payment and booking operations where retries can create duplicate effects.
- Document endpoints with an OpenAPI specification.
- Test success, validation, authorization, concurrency and failure paths.

## Security and privacy baseline

- Authentication with secure session or token lifecycle and revocation.
- Business-scoped authorization and least privilege.
- Persistent database, reviewed migrations, backups and tested restores.
- HTTPS at the deployment edge and TLS to managed services where supported.
- Rate limits at a shared gateway/store for public deployment.
- Safe error handling, structured logs and audit trails.
- Secret management and rotation; no credentials in source control or mobile builds.
- Minimize personal data and define consent, retention, export and deletion processes.
- Protect mobile tokens with platform secure storage.
- Keep payment card data with a compliant payment provider; do not store card numbers or security codes.

## International readiness

Treat currency, time zone, language, phone formatting, service taxonomy, taxes, consumer protection, data protection, accessibility, payment methods, provider screening and support hours as market configuration. Do not enable a country until its legal, tax, payment and operational requirements are reviewed. Launch one market at a time.
