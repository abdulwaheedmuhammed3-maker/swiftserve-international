# SwiftServe MVP Roadmap

This is a validation-first roadmap. Dates and feature scope should be adjusted after reviewing the existing code and speaking with prospective customers.

## Stage 0 — Foundation
- [x] Create the international repository.
- [x] Move the existing service-request API into a clear workspace layout.
- [x] Add project overview, architecture notes, and this roadmap.
- [ ] Run tests locally and record the result.
- [ ] Review security, edge cases, and API consistency.

**Exit condition:** the API runs locally, tests pass, and limitations are documented.

## Stage 1 — Validate the business problem
- [ ] Interview at least 15 local service-business owners.
- [ ] Identify how they currently receive, schedule, assign, and track jobs.
- [ ] Ask what causes lost bookings, missed appointments, and payment disputes.
- [ ] Test pricing and willingness to pay; do not assume demand.
- [ ] Recruit 3 pilot businesses and agree on a measurable trial.

**Exit condition:** a repeated, costly workflow problem and a credible first customer segment are identified.

## Stage 2 — Business workflow MVP
- [ ] Add a persistent database and migrations.
- [ ] Add authentication and business-scoped authorization.
- [ ] Add business profiles and service catalogue management.
- [ ] Add request/booking lifecycle and status history.
- [ ] Add basic search, filtering, and pagination.
- [ ] Add structured logging, validation, and CI tests.

**Exit condition:** a pilot business can safely manage requests without relying on a developer to edit data.

## Stage 3 — Customer booking flow
- [ ] Create service discovery by category and service area.
- [ ] Add request submission and booking confirmation.
- [ ] Add clear cancellation and rescheduling rules.
- [ ] Add notification adapters.
- [ ] Test accessibility and low-bandwidth mobile usage.

**Exit condition:** customers can submit and track a request, and the business can fulfil it.

## Stage 4 — Pilot and monetization
- [ ] Run a time-limited pilot with agreed success metrics.
- [ ] Track activation, repeat usage, booking completion, response time, and retention.
- [ ] Test a simple subscription or per-business pricing hypothesis.
- [ ] Document support issues and operational costs.
- [ ] Fix reliability and usability problems before adding more features.

**Exit condition:** evidence of repeated usage and willingness to pay, with a path to positive unit economics.

## Stage 5 — Market expansion
- [ ] Select the next market using demand, competition, payment access, legal obligations, and support capacity.
- [ ] Review privacy, tax, consumer protection, provider screening, and payment requirements.
- [ ] Localize currency, time zone, formats, service categories, and customer support.
- [ ] Expand one market at a time based on measured performance.

## Not in the first MVP

- Launching in all proposed countries at once.
- Complex AI matching or dynamic pricing.
- Wallets, stored-value balances, or holding customer funds.
- Building custom payment rails.
- Large multi-role enterprise features before pilot demand is proven.
