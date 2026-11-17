# SwiftServe Architecture

## Product direction

SwiftServe is an international household-services platform with three connected experiences:

- **Customer experience:** discover services, request quotes or bookings, track fulfilment, communicate with providers and pay through supported local methods.
- **Business workspace:** manage a business profile, service catalogue, service areas, schedules, incoming bookings, team members and operational performance.
- **Provider experience:** manage availability, assigned work, verification status, job progress, earnings and customer feedback.

A platform administration workspace will support onboarding, disputes, market configuration, compliance and operational oversight.

## Architecture strategy

Start with a modular monolith: one deployable API with clearly separated domain modules and a managed PostgreSQL database. This is easier to operate and more economical for an early product than introducing distributed services. Extract services only when actual workload, team boundaries or reliability needs justify it.

The Android application is currently a limited business request-management MVP. The backend is a Node.js HTTP REST API. PostgreSQL is used when DATABASE_URL is configured; development without a database uses temporary in-memory storage. Production refuses to start without DATABASE_URL.

## Current implementation

- Versioned REST routes for basic service-request create, list, retrieve, update and delete operations.
- Server-side input validation and a 1 MB request-body limit.
- UUID validation for request identifiers.
- A limited job-status lifecycle with concurrent-update protection.
- PostgreSQL repository adapter using parameterized queries.
- Process liveness at /health and dependency readiness at /readyz.
- Android business MVP with local storage or API connection.
- API tests and GitHub Actions workflows for API CI and debug APK builds.

Current limitations:

- No authentication, sessions or role management.
- No business ownership or business-level access isolation.
- No customer application or provider application.
- No business profiles, service catalogue or booking scheduler.
- No provider verification, payments, notifications, reviews or disputes.
- No database integration tests, formal migration runner, backup automation or production deployment validation.

## Proposed domain modules

1. **Identity and access:** users, authentication, sessions, roles, business memberships and permissions.
2. **Market configuration:** countries, currencies, time zones, locales, supported payment methods and service availability.
3. **Business management:** business profiles, branches, team members, operating hours, service areas and service catalogues.
4. **Customer accounts:** profiles, contact preferences, saved locations and consent records.
5. **Provider operations:** provider profiles, onboarding, verification workflow, availability and service coverage.
6. **Bookings:** quote requests, booking confirmation, scheduling, assignment, cancellation, status history and completion evidence.
7. **Communications:** email, SMS and push notifications behind provider adapters.
8. **Payments and finance:** payment intents, provider payouts, refunds, fees, settlement and reconciliation through country-specific adapters.
9. **Trust and safety:** reviews, reports, disputes, moderation, audit events and support workflows.
10. **Administration and analytics:** market operations, platform configuration, service quality, revenue and operational reporting.

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
- Rate limits, request-size limits, safe error handling and structured logs.
- Secret management and rotation; no credentials in source control or mobile builds.
- Audit trails for sensitive administrative and financial actions.
- Minimize personal data and define consent, retention, export and deletion processes.
- Keep payment card data with a compliant payment provider; do not store card numbers or security codes.

## International readiness

Treat currency, time zone, language, phone formatting, service taxonomy, taxes, consumer protection, data protection, accessibility, payment methods, provider screening and support hours as market configuration. Do not enable a country until its legal, tax, payment and operational requirements are reviewed. Launch one market at a time.
