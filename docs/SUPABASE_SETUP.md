# Supabase Setup (Phone-Friendly)

Supabase provides a managed PostgreSQL database. You can create and manage the project in a mobile browser.

## 1. Create the project

1. Open https://supabase.com/dashboard in your phone browser.
2. Sign in or create an account.
3. Choose **New project**.
4. Name it `swiftserve-dev`.
5. Choose a strong database password and store it in a password manager. Do not send it in chat or commit it to GitHub.
6. Select a region close to the first pilot users and wait for the database to finish provisioning.

Use this as a development database only. Keep the GitHub repository private.

## 2. Apply the schema

1. Open your project in Supabase.
2. Open **SQL Editor** and create a new query.
3. Open this repository file in another tab and copy its contents:
   `apps/api/db/migrations/001_initial_schema.sql`
4. Paste the SQL into the SQL Editor and run it.
5. Confirm the `service_requests` table appears in **Table Editor**.

Do not put a database password or connection string in the SQL migration.

## 3. Get the connection string safely

1. In Supabase, open **Project Settings → Database**.
2. Find **Connection string** and select the URI format. Prefer the transaction/session pooler connection details recommended by Supabase for your environment.
3. Treat the full connection string as a password. Do not paste it into this public documentation, a GitHub file, screenshot, issue, or chat.
4. It will be added to the runtime environment as `DATABASE_URL` when the API database adapter is ready.

## Current implementation status

The repository includes the initial SQL schema and PostgreSQL client dependency. The existing API still uses in-memory storage until the database adapter is connected and integration tests pass. Creating a Supabase project alone will not make the API persistent.

## Before real use

- Use a least-privilege database role and TLS.
- Keep credentials in the hosting provider's secret settings.
- Do not expose the database connection string to frontend code.
- Do not store real customer information until authentication, authorization, backups, privacy and retention practices are implemented.
- Rotate the database password immediately if it is accidentally exposed.
