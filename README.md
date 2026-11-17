# SwiftServe International

**Smart living starts here.**

SwiftServe is an international household-services platform, starting with a business-first workflow. It is designed to connect customers with service businesses and providers while giving businesses a workspace to manage requests and bookings.

> **Development status:** identity and business-isolation foundation is implemented on the Phase 2 development branch. The platform is not production-ready. The business API now requires a bearer session and a business membership, but customer discovery and booking, provider operations, verification, payments and notifications are still under development. PostgreSQL migration 002 must be applied before using the identity routes with a database.

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

Apply the SQL migrations in order:

1. apps/api/db/migrations/001_initial_schema.sql
2. apps/api/db/migrations/002_identity_business_scope.sql

The current project does not yet include a migration runner. Apply both files using a trusted PostgreSQL client or your managed database SQL editor, and record which migration versions have been applied.

Never commit .env files or real credentials. In production, DATABASE_URL is required and the API refuses to start without it. The server checks the configured database and required core tables before listening. A missing migration makes database readiness fail. Without DATABASE_URL in development, the API uses temporary in-memory storage; those records disappear when the process stops.

Migration 002 adds user accounts, businesses, memberships, sessions and nullable ownership columns on service_requests. Existing requests from before this migration have no business owner and are not visible through the authenticated business API. Review and associate any retained records deliberately; do not assign them to an arbitrary business.

### Authentication endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| POST | /api/v1/auth/register | Create a customer or business account |
| POST | /api/v1/auth/login | Start a 7-day bearer session |
| POST | /api/v1/auth/logout | Revoke the current session |
| GET | /api/v1/auth/me | Retrieve the signed-in profile and business memberships |

Business registration creates a business and an owner membership. Passwords are hashed with scrypt. Opaque session tokens are returned once to the client; only SHA-256 token hashes are stored by the API.

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

### Health checks

- /health reports process liveness.
- /readyz checks database readiness and reports the storage mode.

The simple authentication throttle is process-local. Before horizontal scaling or a large public launch, move rate limiting to a trusted API gateway or shared store and review proxy/IP handling.

## CI

The SwiftServe API CI workflow installs dependencies and runs the automated API tests on pushes to main and pull requests targeting main. The Android APK workflow builds and uploads a debug APK when Android source or build configuration changes.

## Development roadmap

1. Verify the stabilised API deployment and PostgreSQL integration.
2. Complete identity and business isolation, including migration/integration tests, session lifecycle and operational hardening.
3. Build business profiles, service catalogues, operating hours, branches and team management.
4. Build customer discovery, booking, provider assignment and notifications.
5. Add provider verification, payments, refunds, reviews and dispute workflows.
6. Prepare one launch market at a time with appropriate country, privacy, tax and payment configuration.

## Security and data use

This is development software. Do not store real customer data or use the API as a public production service until PostgreSQL migrations and persistence are verified, access control is reviewed, rate limiting is moved to an appropriate shared layer, database backups and restore are tested, session policies are reviewed, and privacy, retention, audit and incident-response practices are in place. Do not store payment card data directly.
