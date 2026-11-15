# SwiftServe International

**Smart living starts here.**

SwiftServe is being built as a business-first local-services platform. The first goal is to help service businesses manage customer requests and bookings, then add a customer marketplace once the workflow has been validated.

> **Development status:** early MVP foundation. Not production-ready. The API currently stores data in memory; records disappear when the server stops. Authentication, persistent storage, payments, and provider verification are not implemented.

## Repository structure

```text
app/                 # Android business MVP
apps/api/            # Node.js service-request API
docs/
  ARCHITECTURE.md
  ROADMAP.md
```

## Android MVP

The Android app lets a business create requests, review its request list, accept or complete a job, and delete a request. It starts in **on-device mode**, saving requests on the phone. To use the API, enter its HTTPS base address in the app and tap **Save API address**. The app then uses the existing `/api/v1/jobs` endpoints.

The API does not yet provide sign-in or durable storage. Use this MVP only with test data and a trusted development API.

A debug APK is built by the **Android APK** GitHub Actions workflow. Open the workflow run and download the `SwiftServe-debug-apk` artifact.

## API requirements and commands

- Node.js 20 or later
- npm

From the repository root:

```bash
npm install
npm test
npm run dev
```

The API defaults to `http://127.0.0.1:3000`. You can override the port with the `PORT` environment variable.

## Current endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/v1/jobs` | Create a service request |
| GET | `/api/v1/jobs` | List requests |
| GET | `/api/v1/jobs/:id` | Retrieve a request |
| PATCH | `/api/v1/jobs/:id` | Update a request |
| DELETE | `/api/v1/jobs/:id` | Delete a request |

## CI

GitHub Actions runs the API tests when code is pushed to `main` or a pull request targets `main`. The **Android APK** workflow builds and uploads the debug APK.

## Planned next steps

1. Replace in-memory storage with a persistent database.
2. Add authentication and business-scoped authorization.
3. Build business profiles, service listings, and customer booking workflows.
4. Pilot with a small number of businesses before expanding to additional countries.

## Security

Do not commit passwords, access tokens, API keys, private keys, database credentials, or real customer data. Keep secrets out of source control. This development API should not be exposed for production use until persistence, authentication, authorization, and deployment security are implemented.
