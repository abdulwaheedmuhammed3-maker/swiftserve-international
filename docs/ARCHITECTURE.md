# Initial Architecture

## Product shape

SwiftServe is intended to serve two sides of a local-services market:

- **Business workspace:** receive and manage requests, update job status, maintain service offerings, and later manage schedules and team members.
- **Customer experience:** discover services, submit a request, understand status, and later communicate with the assigned provider and pay through supported local methods.

The first validation milestone is the business workflow, not a multi-country marketplace launch.

## Current implementation

The API is a small Node.js HTTP service with a versioned JSON REST interface. The current `jobs` resource supports create, list, read, update, and delete operations. Input validation and a basic automated test suite are included.

Current storage is an in-memory Map. This is suitable only for a development exercise and must be replaced before pilot use with real customer information.

## Proposed target modules

1. **Identity and access:** users, sessions, roles, business membership, and authorization.
2. **Business profiles:** business details, service areas, opening hours, and service catalogue.
3. **Service requests/bookings:** request lifecycle, scheduling, assignment, cancellation, and audit history.
4. **Provider operations:** provider profiles, verification state, availability, and service coverage.
5. **Notifications:** email/SMS/push integrations behind provider interfaces.
6. **Payments:** country-specific payment adapter, transaction state, refunds, and reconciliation.
7. **Platform administration:** support tools, abuse reports, and operational audit logs.

Implement modules only when validated by customer needs and operational requirements.

## Data model direction

A later persistent schema will likely include:

- `users`
- `businesses`
- `business_memberships`
- `service_categories`
- `business_services`
- `service_areas`
- `service_requests`
- `bookings`
- `provider_profiles`
- `provider_verification_checks`
- `payments` and `refunds`
- `audit_events`

The final schema should be driven by the confirmed booking lifecycle. Avoid collecting identity documents, exact addresses, or payment details until there is a clear purpose and a secure handling process.

## API conventions

- Prefix routes with `/api/v1`.
- Use JSON request and response bodies.
- Validate all input on the server.
- Use consistent error envelopes.
- Add pagination before collection endpoints grow.
- Enforce authorization at the resource level once accounts are introduced.
- Document endpoints in OpenAPI and test success, validation, authorization, and failure paths.

## Country readiness

Treat currency, time zone, language, phone formatting, tax, consumer rights, data protection, payment methods, and provider screening as configurable market concerns. Do not enable a country until the legal and operational checklist is reviewed for that market.

## Security baseline before a pilot

- Persistent database with backups and migrations.
- Authentication, authorization, and session/token lifecycle.
- HTTPS at the deployed edge.
- Request-size limits, rate limits, and safe error handling.
- Secret management and rotation process.
- Data minimization, retention/deletion process, and privacy notice.
- Audit logging for sensitive business actions.
- Dependency updates and automated tests in CI.
