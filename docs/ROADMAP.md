# SwiftServe International Roadmap

SwiftServe is being developed as an international household-services platform. The sequence prioritizes a secure business workflow before adding marketplace breadth or entering additional countries.

## Stage 0 — Stabilise the existing foundation

- [x] Keep the international repository and Android/API workspace layout.
- [x] Add a production guard against volatile storage.
- [x] Add local environment loading without overriding host-provided environment variables.
- [x] Add startup database checks, liveness/readiness endpoints and graceful shutdown.
- [x] Harden request parsing, identifiers, API responses and job-status transitions.
- [x] Expand API regression tests and verify the API CI workflow.
- [x] Align the Android MVP with HTTPS API connections and terminal job statuses.
- [x] Correct architecture, database and setup documentation.
- [x] Verify GitHub Actions API tests and Android APK build on the stabilisation pull request.
- [ ] Apply database migrations to the development database.
- [x] Add a checksum-verified migration runner and PostgreSQL 16 integration tests in CI.
- [ ] Apply migrations 001–005 to the actual development database and verify data survives API restarts.
- [ ] Verify the deployed API configuration and readiness behaviour.

**Exit condition:** the actual development database is migrated, automated checks pass, PostgreSQL persistence is verified, and deployment does not use volatile storage.

## Stage 1 — Identity and business isolation

- [x] Add account registration and login for customer and business account types.
- [x] Add scrypt password hashing.
- [x] Add opaque bearer sessions with seven-day expiry and logout revocation.
- [x] Add business registration, business ownership and membership records.
- [x] Require authentication and explicit business context for service-request endpoints.
- [x] Scope service-request reads and writes to the selected active business membership.
- [x] Restrict request deletion to business owners and administrators.
- [x] Add Android business registration, sign-in and sign-out.
- [x] Encrypt the Android bearer token with Android Keystore.
- [x] Add process-local throttling for registration and login attempts.
- [x] Add tests for account lifecycle, authentication and cross-business access.
- [x] Add PostgreSQL integration coverage for account persistence, session revocation and cross-business isolation in CI.
- [ ] Apply migrations 002–005 to the actual development database and verify the deployed service.
- [ ] Add email verification, password reset, account recovery and administrative session revocation.
- [ ] Move rate limiting to a shared gateway/store before horizontal scaling.
- [ ] Review security, privacy and session policies for the first pilot.

**Exit condition:** users can securely sign in, and a business cannot read or change another business's data in the real PostgreSQL environment.

## Stage 2 — Business operations

- [x] Add business profile read/update endpoints.
- [x] Add service catalogue create/list/read/update/delete endpoints with pricing validation.
- [x] Add business branches with a primary-branch limit.
- [x] Add weekly business/branch opening-hours endpoints.
- [x] Add service coverage areas with business-owned branch references.
- [x] Add team member listing, role changes and member removal.
- [x] Add expiring team invitations, revocation and authenticated acceptance.
- [x] Restrict workspace actions by business membership role.
- [x] Add API regression tests for business profile, catalogue, branches, hours, coverage and invitations.
- [x] Add PostgreSQL integration coverage for business resources and team invites.
- [ ] Connect an email provider for invitation delivery.
- [ ] Add business settings and multiple-business switching in Android.
- [ ] Add catalogue search, pagination and operational analytics.
- [x] Add booking status history and customer/business status views.
- [ ] Add booking capacity, slot-conflict checks and provider job assignment.

**Exit condition:** a pilot business can onboard, publish its services and manage work without developer intervention.

## Stage 3 — Customer and provider experiences

- [x] Add customer account profile and locale/contact preferences.
- [x] Add private saved service locations with ownership checks and default-address handling.
- [x] Add public service discovery by country, city, category and search text.
- [x] Add booking requests with branch/service-area validation and immutable service/address snapshots.
- [x] Add business quotes with expiry, customer acceptance/decline and quote history.
- [x] Add customer cancellation and business booking-status transitions.
- [x] Add booking status history for customer and business views.
- [x] Add in-app notifications for booking and quote events.
- [x] Add API regression and PostgreSQL integration coverage for the customer booking lifecycle.
- [ ] Add booking rescheduling and slot-capacity/conflict checks.
- [x] Add provider account registration and provider profile creation.
- [x] Add provider profile, supported skills, service areas and weekly availability endpoints.
- [x] Add provider onboarding submission and protected manual verification review.
- [x] Add business-provider invitations and authenticated provider acceptance.
- [x] Add provider assignment offers with skill, coverage, verification, availability and overlapping-schedule checks.
- [x] Add provider accept/decline, in-progress and completion workflows with booking history and in-app notifications.
- [x] Add API regression and PostgreSQL integration coverage for provider onboarding and assignment lifecycle.
- [ ] Add provider identity-document upload, secure document storage and stronger operational KYC review.
- [ ] Connect email, SMS and push notification delivery.
- [ ] Add a complete slot-capacity/travel-buffer engine and booking rescheduling.
- [ ] Build customer and provider mobile experiences with accessible, low-bandwidth UX.
- [ ] Add end-to-end mobile workflow tests.

**Exit condition:** a customer can find a service, book it, and follow its fulfilment through completion.

## Stage 4 — Trust, payments and support

- [x] Add a protected manual provider verification review workflow.
- [ ] Add provider identity evidence/document storage and stronger KYC review controls.
- [ ] Integrate country-appropriate payment providers.
- [ ] Add payment intents, transaction records, refunds and reconciliation.
- [ ] Add reviews, ratings, reports and dispute handling.
- [ ] Add support tools, audit trails and operational monitoring.
- [ ] Test payment failures, retries, refunds and webhook idempotency.

**Exit condition:** the platform can safely support a real pilot with clear financial and dispute records.

## Stage 5 — Pilot, pricing and market expansion

- [ ] Interview at least 15 local service-business owners.
- [ ] Recruit 3 pilot businesses and agree on measurable trial outcomes.
- [ ] Track activation, repeat usage, booking completion, response time and retention.
- [ ] Test subscription or per-business pricing.
- [ ] Select one additional launch market using demand, competition, payment access, legal obligations and support capacity.
- [ ] Review privacy, tax, consumer protection, provider screening and payment requirements for each market.
- [ ] Localize currency, time zone, formats, service categories and support workflows.
- [ ] Expand one market at a time based on measured performance.

**Exit condition:** repeat usage and willingness to pay are demonstrated, operations are sustainable, and the next market has been reviewed.

## Explicitly deferred

- Launching in every target country simultaneously.
- Complex AI matching and dynamic pricing before sufficient operational data exists.
- Wallets, stored-value balances or holding customer funds.
- Building custom payment rails.
- Large enterprise features before pilot businesses demonstrate demand.
