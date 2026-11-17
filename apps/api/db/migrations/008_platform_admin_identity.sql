-- Individual platform administrator identities, sessions and accountable audit attribution.
-- This is separate from customer/provider/business identities and sessions.

CREATE TABLE IF NOT EXISTS platform_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  full_name VARCHAR(100) NOT NULL CHECK (char_length(trim(full_name)) BETWEEN 2 AND 100),
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin','finance_admin','support_admin','provider_reviewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT platform_admins_email_normalized_check CHECK (email = lower(trim(email)))
);

CREATE INDEX IF NOT EXISTS platform_admins_role_status_idx
  ON platform_admins (role, status);

CREATE TABLE IF NOT EXISTS platform_admin_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_admin_sessions_admin_expiry_idx
  ON platform_admin_sessions (admin_id, expires_at DESC);

ALTER TABLE admin_audit_logs
  ADD COLUMN IF NOT EXISTS actor_admin_id UUID REFERENCES platform_admins(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS admin_audit_logs_actor_admin_created_idx
  ON admin_audit_logs (actor_admin_id, created_at DESC);

ALTER TABLE finance_reconciliation_runs
  ADD COLUMN IF NOT EXISTS actor_admin_id UUID REFERENCES platform_admins(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS finance_reconciliation_runs_actor_admin_idx
  ON finance_reconciliation_runs (actor_admin_id, started_at DESC);
