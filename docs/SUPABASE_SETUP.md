# Supabase Setup (Phone-Friendly)

Supabase provides managed PostgreSQL. Use a separate development project first. Do not store real customer information in the development database.

## 1. Create a development project

1. Open https://supabase.com/dashboard.
2. Sign in and choose New project.
3. Name it swiftserve-dev.
4. Choose a strong database password and store it in a password manager.
5. Select a region suitable for your first development and pilot environment.
6. Wait for the database to finish provisioning.

Do not send the database password or connection string in chat, screenshots, GitHub issues or source files.

## 2. Apply the current schema

1. Open the Supabase project.
2. Open SQL Editor and create a new query.
3. Open apps/api/db/migrations/001_initial_schema.sql in this repository.
4. Copy the SQL into the SQL Editor and run it.
5. Confirm that service_requests appears in Table Editor.

This migration creates only the initial service-request table. It does not provide user accounts, business ownership, provider records or customer bookings yet.

## 3. Configure the API connection

1. In Supabase, open Project Settings → Database.
2. Find Connection string and select URI.
3. Choose the connection method appropriate for the host. Use the Supabase pooler option when required by the hosting environment.
4. Copy the connection string privately.
5. Add it as DATABASE_URL in the API runtime environment. For Render, use the service's Environment settings and mark the value as secret.
6. Never add DATABASE_URL to the Android app, frontend code, repository, or public documentation.

The API uses PostgreSQL when DATABASE_URL is configured. In local development without DATABASE_URL it uses volatile in-memory storage. In production it refuses to start without DATABASE_URL and checks the database connection before listening.

## 4. Verify persistence

After deploying or starting the API:

1. Open /health to confirm that the process responds.
2. Open /readyz to confirm the API's storage dependency is ready.
3. Create a test service request.
4. Restart the API.
5. Retrieve the request and confirm it still exists.

A successful /health response alone does not prove that PostgreSQL is available. Use /readyz to check database readiness.

## 5. Important limitations

The current service_requests schema is not yet safe for a multi-business production platform. Authentication and business-scoped authorization must be implemented before real customer or provider information is stored.

Before a pilot, also configure a least-privilege database role, TLS, separate development and production environments, automated backups, restore testing, privacy and retention procedures. Rotate the database password immediately if it is accidentally exposed.
