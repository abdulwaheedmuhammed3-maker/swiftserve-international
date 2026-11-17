-- Platform admin audit trail and Paystack finance reconciliation.
-- Apply after migrations 001–006. Never store API keys, card data or bank account numbers here.

ALTER TABLE provider_payouts
  DROP CONSTRAINT IF EXISTS provider_payouts_status_check;

ALTER TABLE provider_payouts
  ADD CONSTRAINT provider_payouts_status_check
  CHECK (status IN ('awaiting_payment','pending','processing','paid','failed','on_hold','reversed'));

ALTER TABLE provider_payouts
  ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_key_id VARCHAR(80) NOT NULL,
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(60) NOT NULL,
  target_id UUID,
  outcome TEXT NOT NULL DEFAULT 'succeeded'
    CHECK (outcome IN ('succeeded','failed','denied')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT admin_audit_logs_actor_check
    CHECK (char_length(trim(actor_key_id)) BETWEEN 1 AND 80),
  CONSTRAINT admin_audit_logs_action_check
    CHECK (char_length(trim(action)) BETWEEN 1 AND 100),
  CONSTRAINT admin_audit_logs_target_check
    CHECK (char_length(trim(target_type)) BETWEEN 1 AND 60)
);

CREATE INDEX IF NOT EXISTS admin_audit_logs_created_idx
  ON admin_audit_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS admin_audit_logs_action_created_idx
  ON admin_audit_logs (action, created_at DESC);

CREATE INDEX IF NOT EXISTS admin_audit_logs_target_idx
  ON admin_audit_logs (target_type, target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS finance_reconciliation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('paystack')),
  actor_key_id VARCHAR(80) NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','completed','partial','failed')),
  scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
  matched_count INTEGER NOT NULL DEFAULT 0 CHECK (matched_count >= 0),
  updated_count INTEGER NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
  pending_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
  review_count INTEGER NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  error_count INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT finance_reconciliation_runs_counts_check CHECK (
    matched_count + updated_count + pending_count + review_count + error_count <= scanned_count
  )
);

CREATE INDEX IF NOT EXISTS finance_reconciliation_runs_started_idx
  ON finance_reconciliation_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS finance_reconciliation_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES finance_reconciliation_runs(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('payment','payout','refund')),
  local_entity_id UUID NOT NULL,
  provider_reference VARCHAR(120),
  local_status VARCHAR(60),
  provider_status VARCHAR(60),
  outcome TEXT NOT NULL
    CHECK (outcome IN ('matched','updated','pending','mismatch','manual_review','error','skipped')),
  local_amount_minor BIGINT,
  provider_amount_minor BIGINT,
  currency_code CHAR(3),
  message VARCHAR(500),
  provider_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, entity_type, local_entity_id)
);

CREATE INDEX IF NOT EXISTS finance_reconciliation_items_run_idx
  ON finance_reconciliation_items (run_id, created_at);

CREATE INDEX IF NOT EXISTS finance_reconciliation_items_outcome_idx
  ON finance_reconciliation_items (outcome, created_at DESC);
