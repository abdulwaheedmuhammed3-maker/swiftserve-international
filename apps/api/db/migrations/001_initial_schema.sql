-- SwiftServe initial schema (PostgreSQL)
-- Apply to a development database only after reviewing the database setup guide.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS service_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service TEXT NOT NULL CHECK (service IN (
    'cleaning', 'laundry', 'electrical', 'plumbing',
    'ac-repair', 'appliance-repair', 'errand'
  )),
  description TEXT NOT NULL CHECK (char_length(trim(description)) BETWEEN 10 AND 500),
  area TEXT NOT NULL CHECK (char_length(trim(area)) BETWEEN 2 AND 80),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS service_requests_status_created_idx
  ON service_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS service_requests_service_created_idx
  ON service_requests (service, created_at DESC);
