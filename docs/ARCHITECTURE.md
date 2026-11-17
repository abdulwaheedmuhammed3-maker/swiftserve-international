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
- Checksum-verified migrations 001–007 and PostgreSQL 16 CI integration tests.
- Paystack payment initialization, server-side transaction verification and signed webhook handling.
- Full/partial refund records and gateway-state updates.
- Provider payout-recipient registration, completed-job payout ledger, platform-fee calculation and administrator-triggered transfers.
- Customer reviews for completed bookings and customer/business disputes with conversation and admin resolution records.
- Persistent administrator audit events with credential-key labels and bounded metadata.
- Paystack reconciliation runs for pending payments and unresolved payout transfers, with stored item-level outcomes and sanitized provider snapshots.
- Explicit reversed provider-payout state and reconciliation timestamps.
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
- Payments use a Paystack adapter but no live Paystack merchant account or production webhook has been configured or verified; CI uses a local mock gateway.
- Provider payout recipient registration currently supports Nigerian NGN NUBAN accounts only. Payout transfers are administrator-triggered, not scheduled automatically.
- Dispute resolution records an administrative outcome but does not automatically execute a refund; refunds are a separate business action.
- Refund settlement is received through signed Paystack refund webhooks. The reconciliation runner flags pending refunds for manual review rather than polling them or creating another refund.
- The admin API still uses one shared API key. Audit records use a non-secret credential label and do not prove which individual administrator performed an action.
- Provider and business invitation tokens are returned once for private out-of-band sharing; no email delivery provider is configured.
- Assignment checks provider schedule overlaps, but there is no full business slot-capacity/booking conflict engine or rescheduling flow.
- Customer/admin payment and trust endpoints do not yet have a corresponding complete customer/provider Android experience.

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

## Finance and trust model

Payment intents are created only for confirmed bookings and use the price stored in the confirmed booking snapshot. Accepting a quote replaces the catalogue estimate with the accepted quote amount. The API initializes Paystack checkout with an idempotency key and marks a payment successful only after server-side transaction verification confirms the reference, amount, currency and success status.

Paystack webhooks are verified against the raw request body using HMAC SHA-512. The current handler supports a timestamped signature with a five-minute tolerance and the legacy signature header. Provider webhook event keys are retained to ignore duplicate deliveries. Payment, refund and transfer status updates are guarded against regressing terminal financial states.

Refund records are tied to a booking and successful payment. Full and partial refund amounts are expressed in the same smallest-currency unit as the payment. Processed refunds reduce the gross available to a provider payout.

When a provider completes an assigned booking, SwiftServe creates or refreshes a payout ledger record if a successful/partially-refunded payment exists. The configured platform fee is measured in basis points, defaults to zero and is capped at 50%. An administrator explicitly initiates the Paystack transfer; a signed transfer webhook records the final transfer status. The initial payout-recipient flow supports Nigerian NGN NUBAN accounts. SwiftServe stores the Paystack recipient code and masked account details, not the full bank account number.

Customers can review a completed booking once. Customers and businesses can open disputes and exchange messages within the booking's ownership boundary. Administrators can record review/resolution outcomes. Dispute closure does not automatically create a refund or transfer funds.

No live gateway credentials are stored in the repository. CI uses a local mock Paystack-compatible HTTP server to exercise initialization, verification, refund, transfer, webhook signature and payout workflows. The mock verifies integration behaviour; it is not evidence of live Paystack settlement or production deployment.

## Platform administration and reconciliation model

Migration 007 adds admin_audit_logs, finance_reconciliation_runs and finance_reconciliation_items. Protected administrator routes expose recent audit events, a finance operations summary, reconciliation run history and individual run details. Audit rows store a non-secret admin-key label rather than the key itself, the action and target, an outcome, limited metadata and a timestamp.

A reconciliation run is bounded to 1–50 records. It verifies pending payment intents and processing/failed provider transfers using the Paystack transaction/transfer verification endpoints. A conclusive result can update the local payment or payout state; a reversal is retained as a separate payout state. Non-terminal statuses remain pending. Amount, currency and reference mismatches are surfaced for review rather than silently overwritten. Each result is stored with a sanitized gateway snapshot.

Pending refunds are flagged for manual review because refund settlement is currently driven by signed Paystack refund webhooks. The reconciliation process never initiates a refund or submits a second payout transfer. A local transfer that is processing or failed is verified before an administrator can attempt any further transfer action.

The audit model is intentionally limited while the platform uses a shared admin API key. SWIFTSERVE_ADMIN_ACTOR_ID labels the credential, defaults to shared-admin-key and is not a human identity. Individual administrator accounts, roles, MFA and human-attributable audit trails remain future work.


## Provider operations model

Provider accounts use the provider account type and have a provider_profiles record. Providers maintain service skills, coverage areas and weekly availability. A provider must complete those sections and submit their profile for review before the manual verification state can be approved.

The current manual review API is protected by the SWIFTSERVE_ADMIN_API_KEY runtime secret. The key is supplied through an admin header and is never stored in the repository or mobile apps. Administrative decisions are written to admin_audit_logs using a configured non-secret key label, but this is not a full platform-admin identity/role system and does not identify the individual human using a shared key. Provider identity documents are not uploaded or stored in this phase, so the verified status is an explicit operational review decision rather than automated KYC.

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
