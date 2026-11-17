# SwiftServe International Roadmap

SwiftServe is being developed as an international household-services platform. The sequence below prioritizes a secure, useful business workflow before adding marketplace breadth or entering additional countries.

## Stage 0 — Stabilise the existing foundation

- [x] Maintain the international repository and Android/API workspace layout.
- [x] Keep the PostgreSQL adapter and add a production guard against volatile storage.
- [x] Add local environment loading without overriding host-provided environment variables.
- [x] Add startup database checks, liveness/readiness endpoints and graceful shutdown.
- [x] Harden request parsing, identifiers, API responses and current job-status transitions.
- [x] Expand API regression tests from 6 to 14 cases.
- [x] Align the Android MVP with HTTPS API connections and terminal job statuses.
- [x] Correct the current architecture and database documentation.
- [ ] Confirm GitHub Actions API and Android builds pass for the stabilisation pull request.
- [ ] Add PostgreSQL integration tests and verify records survive API restarts.
- [ ] Verify the deployed API configuration and readiness behaviour.

**Exit condition:** automated checks pass, PostgreSQL persistence is verified, and the deployment does not silently use volatile storage.

## Stage 1 — Identity and business isolation

- [ ] Add account registration, login, logout and session expiry.
- [ ] Add secure password hashing and session-token storage.
- [ ] Add user roles and business memberships.
- [ ] Add business-scoped authorization to every business-owned API operation.
- [ ] Add rate limiting and authentication abuse protection.
- [ ] Add migration and integration tests for identity and authorization.

**Exit condition:** users can securely sign in, and one business cannot read or change another business's data.

## Stage 2 — Business operations

- [ ] Add business profiles, branches and team membership management.
- [ ] Add service catalogues, descriptions, pricing and service areas.
- [ ] Add operating hours, availability and booking capacity.
- [ ] Add job assignment and a complete booking status history.
- [ ] Add search, filtering and pagination.
- [ ] Build the business dashboard and complete Android workflows.

**Exit condition:** a pilot business can onboard, publish its services and manage its work without developer intervention.

## Stage 3 — Customer and provider experiences

- [ ] Add customer profiles and saved service locations.
- [ ] Add service discovery by category and service area.
- [ ] Add quote requests, booking confirmation and rescheduling.
- [ ] Add provider onboarding, availability and assignment workflows.
- [ ] Add customer/provider notifications.
- [ ] Add accessible, low-bandwidth mobile experiences and end-to-end tests.

**Exit condition:** a customer can find a service, book it, and follow its fulfilment through completion.

## Stage 4 — Trust, payments and support

- [ ] Add provider verification workflow and review controls.
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
