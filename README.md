# SwiftServe International

**Smart living starts here.**

SwiftServe is being built as a business-first local-services platform. The first goal is to help service businesses manage customer requests and bookings, then add a customer marketplace once the workflow has been validated.

> **Development status:** early MVP foundation. Not production-ready. The API currently stores data in memory; records disappear when the server stops. Authentication, persistent storage, payments, and provider verification are not implemented.

## Repository structure

```text
apps/api/
  src/app.js          # API routes and validation
  src/server.js       # HTTP server
  test/api.test.js    # automated API tests
  openapi.yaml        # API specification
docs/
  ARCHITECTURE.md
  ROADMAP.md
```

## Requirements

- Node.js 20 or later
- npm

## Run and test

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

## Phone-friendly test run

GitHub Actions is configured to run the API tests whenever code is pushed to `main` or a pull request targets `main`. Open the **Actions** tab in this repository and select **SwiftServe API CI** to see the latest result.

## Planned next steps

1. Confirm automated tests pass.
2. Replace in-memory storage with a persistent database.
3. Add authentication and business-scoped authorization.
4. Build business profiles, service listings, and booking workflows.
5. Pilot with a small number of businesses before expanding to additional countries.

## Security

Do not commit passwords, access tokens, API keys, private keys, database credentials, or real customer data. Keep secrets out of source control. This development API should not be exposed for production use until persistence, authentication, authorization, and deployment security are implemented.
