# SwiftServe International

**Smart living starts here.**

SwiftServe is being developed as an international household-services platform, starting with a business-first workflow. The product direction is to help service businesses manage requests and bookings, then connect customers with suitable service providers through a marketplace.

> **Development status:** foundation MVP. This repository is not production-ready. The API has a PostgreSQL adapter and a development-only in-memory mode, but authentication, business-scoped authorization, customer booking flows, provider verification, payments, and marketplace operations are not yet implemented.

## Repository structure

    app/                 Android business MVP
    apps/api/            Node.js REST API
    docs/                Architecture, database, setup and roadmap

## Android business MVP

The Android app currently supports creating service requests, viewing requests, advancing a request from pending to accepted to completed, and deleting requests. It can store test requests locally on the device or call the API using a configured HTTPS base address.

The app is a development MVP. It does not yet include sign-in, business accounts, multi-user access, offline synchronization, or customer/provider experiences. Do not use it to manage real customer information.

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

The API defaults to http://127.0.0.1:3000 in the documented local setup. The server binds to 0.0.0.0 by default and uses the PORT environment variable when supplied.

### Configuration

Copy apps/api/.env.example to apps/api/.env for local development and set DATABASE_URL only when connecting to a development PostgreSQL database.

Never commit .env files or real credentials. In production, DATABASE_URL is required and the API refuses to start without it. The server checks the configured database before listening. Without DATABASE_URL in development, the API uses temporary in-memory storage; those records disappear when the process stops.

### Current endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | /health | Process liveness |
| GET | /readyz | Dependency readiness |
| POST | /api/v1/jobs | Create a service request |
| GET | /api/v1/jobs | List requests |
| GET | /api/v1/jobs/:id | Retrieve a request |
| PATCH | /api/v1/jobs/:id | Update request details or supported status |
| DELETE | /api/v1/jobs/:id | Delete a request |

The current status lifecycle is pending → accepted → completed, with cancellation allowed from pending or accepted. Completed and cancelled requests are terminal in this MVP.

## CI

The SwiftServe API CI workflow installs dependencies and runs the automated API tests on pushes to main and pull requests targeting main. The Android APK workflow builds and uploads a debug APK when Android source or build configuration changes.

## Development roadmap

1. Stabilise the API, storage, tests, documentation and deployment configuration.
2. Implement authentication, roles, business memberships and resource-level authorization.
3. Build business profiles, service catalogues, operating hours and team management.
4. Build customer discovery, booking, provider assignment and notifications.
5. Add provider verification, payments, refunds, reviews and dispute workflows.
6. Prepare one launch market at a time with appropriate country, privacy, tax and payment configuration.

## Security and data use

This is development software. Do not expose it as a public production service or store real customer data until authentication, business-level authorization, database backups, rate limiting, audit logging, privacy and retention processes, and deployment security are in place. Do not store payment card data directly.
