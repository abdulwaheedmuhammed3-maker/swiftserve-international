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
- API regression tests and GitHub Actions workflows for API CI and debug APK builds.

## Known limitations

- No email verification, password reset, MFA or account recovery.
- Session refresh and administrative session revocation are not implemented; bearer sessions expire after seven days.
- The current registration route allows public business and customer account creation; abuse controls must be reviewed before public launch.
- Authentication throttling is process-local and should move to a shared gateway/store before horizontal scaling.
- There is not yet an automatic database migration runner or PostgreSQL integration test suite.
- Legacy service requests created before business ownership was added are intentionally unassigned and hidden from business-scoped routes until a reviewed backfill is performed.
- The Android app selects the first returned business; multi-business switching, team invitations and role-based screens are not implemented.
- No customer app, provider app, business profile/catalogue, booking schedule, provider verification, payment, notification, reviews or dispute workflows yet.

## Identity and authorization model

- A user authenticates with email and password.
- A password is stored as a scrypt hash; plaintext passwords are never persisted.
- A successful registration/login creates a random opaque bearer token with a seven-day expiry.
- The API stores only the SHA-256 token hash in sessions; logout revokes the stored session.
- A business registration creates a business and an owner membership.
- A request to a business-owned endpoint must include a bearer token and X-SwiftServe-Business-Id.
- The API checks active business membership server-side before reading or changing requests.
- All service-request reads and writes include business_id in the repository query.
- Owners/admins can delete requests; members with other active roles can work with requests according to the current MVP routes.

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
