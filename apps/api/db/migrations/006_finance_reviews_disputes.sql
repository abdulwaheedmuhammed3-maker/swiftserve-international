-- Payments, refunds, provider payouts, customer reviews and disputes.
-- Apply after migrations 001–005. Never store card numbers or security codes.

CREATE TABLE IF NOT EXISTS payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  booking_id UUID NOT NULL,
  customer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('paystack')),
  provider_reference VARCHAR(100) NOT NULL UNIQUE,
  provider_transaction_id VARCHAR(100),
  idempotency_key VARCHAR(120) NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency_code CHAR(3) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','succeeded','failed','cancelled','partially_refunded','refunded')),
  authorization_url TEXT,
  paid_at TIMESTAMPTZ,
  gateway_message VARCHAR(500),
  gateway_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_intents_booking_scope_fk
    FOREIGN KEY (business_id, booking_id)
    REFERENCES bookings (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT payment_intents_idempotency_check
    CHECK (length(trim(idempotency_key)) BETWEEN 8 AND 120),
  CONSTRAINT payment_intents_currency_check
    CHECK (length(currency_code) = 3 AND currency_code = upper(currency_code)),
  UNIQUE (customer_user_id, idempotency_key),
  UNIQUE (business_id, booking_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_one_open_per_booking_idx
  ON payment_intents (business_id, booking_id)
  WHERE status IN ('pending','succeeded','partially_refunded','refunded');

CREATE INDEX IF NOT EXISTS payment_intents_customer_created_idx
  ON payment_intents (customer_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS payment_intents_business_status_idx
  ON payment_intents (business_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS provider_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  event_key CHAR(64) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, event_key)
);

CREATE INDEX IF NOT EXISTS provider_webhook_events_received_idx
  ON provider_webhook_events (received_at DESC);

CREATE TABLE IF NOT EXISTS payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id UUID NOT NULL REFERENCES payment_intents(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_event_key CHAR(64) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  provider_status VARCHAR(60),
  payload_hash CHAR(64) NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_key)
);

CREATE INDEX IF NOT EXISTS payment_events_intent_idx
  ON payment_events (payment_intent_id, processed_at DESC);

CREATE TABLE IF NOT EXISTS refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  booking_id UUID NOT NULL,
  payment_intent_id UUID NOT NULL,
  customer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('paystack')),
  provider_reference VARCHAR(100) NOT NULL UNIQUE,
  provider_refund_id VARCHAR(100),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency_code CHAR(3) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','processed','failed')),
  customer_note VARCHAR(1000),
  merchant_note VARCHAR(1000),
  failure_reason VARCHAR(500),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT refunds_payment_scope_fk
    FOREIGN KEY (business_id, booking_id, payment_intent_id)
    REFERENCES payment_intents (business_id, booking_id, id) ON DELETE RESTRICT,
  CONSTRAINT refunds_currency_check
    CHECK (length(currency_code) = 3 AND currency_code = upper(currency_code))
);

CREATE INDEX IF NOT EXISTS refunds_payment_status_idx
  ON refunds (payment_intent_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS refunds_business_created_idx
  ON refunds (business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS provider_payout_accounts (
  provider_user_id UUID PRIMARY KEY REFERENCES provider_profiles(user_id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('paystack')),
  recipient_code VARCHAR(100) NOT NULL UNIQUE,
  recipient_type VARCHAR(40) NOT NULL CHECK (recipient_type IN ('nuban')),
  currency_code CHAR(3) NOT NULL,
  account_name VARCHAR(140),
  bank_code VARCHAR(32),
  bank_name VARCHAR(140),
  last_four CHAR(4),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT provider_payout_accounts_currency_check
    CHECK (length(currency_code) = 3 AND currency_code = upper(currency_code))
);

CREATE TABLE IF NOT EXISTS provider_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  booking_id UUID NOT NULL,
  booking_assignment_id UUID NOT NULL,
  provider_user_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE RESTRICT,
  payment_intent_id UUID REFERENCES payment_intents(id) ON DELETE RESTRICT,
  currency_code CHAR(3) NOT NULL,
  gross_amount_minor BIGINT NOT NULL CHECK (gross_amount_minor >= 0),
  platform_fee_minor BIGINT NOT NULL DEFAULT 0 CHECK (platform_fee_minor >= 0),
  net_amount_minor BIGINT NOT NULL CHECK (net_amount_minor >= 0),
  status TEXT NOT NULL DEFAULT 'awaiting_payment'
    CHECK (status IN ('awaiting_payment','pending','processing','paid','failed','on_hold')),
  transfer_reference VARCHAR(100) UNIQUE,
  provider_transfer_id VARCHAR(100),
  failure_reason VARCHAR(500),
  approved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  initiated_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT provider_payouts_assignment_scope_fk
    FOREIGN KEY (business_id, booking_id)
    REFERENCES bookings (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT provider_payouts_assignment_fk
    FOREIGN KEY (business_id, booking_assignment_id)
    REFERENCES booking_assignments (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT provider_payouts_amount_check
    CHECK (net_amount_minor = gross_amount_minor - platform_fee_minor),
  CONSTRAINT provider_payouts_currency_check
    CHECK (length(currency_code) = 3 AND currency_code = upper(currency_code)),
  UNIQUE (booking_assignment_id)
);

CREATE INDEX IF NOT EXISTS provider_payouts_provider_status_idx
  ON provider_payouts (provider_user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS provider_payouts_business_status_idx
  ON provider_payouts (business_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS provider_payout_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id UUID NOT NULL REFERENCES provider_payouts(id) ON DELETE RESTRICT,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  note VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provider_payout_events_payout_idx
  ON provider_payout_events (payout_id, created_at);

CREATE TABLE IF NOT EXISTS booking_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  booking_id UUID NOT NULL,
  customer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_user_id UUID REFERENCES provider_profiles(user_id) ON DELETE SET NULL,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment VARCHAR(2000),
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','hidden')),
  moderated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  moderation_note VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT booking_reviews_booking_scope_fk
    FOREIGN KEY (business_id, booking_id)
    REFERENCES bookings (business_id, id) ON DELETE RESTRICT,
  UNIQUE (booking_id, customer_user_id)
);

CREATE INDEX IF NOT EXISTS booking_reviews_business_created_idx
  ON booking_reviews (business_id, created_at DESC)
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS booking_reviews_provider_created_idx
  ON booking_reviews (provider_user_id, created_at DESC)
  WHERE status = 'published';

CREATE TABLE IF NOT EXISTS disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  booking_id UUID NOT NULL,
  opened_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  opened_by_role TEXT NOT NULL CHECK (opened_by_role IN ('customer','business')),
  category TEXT NOT NULL CHECK (category IN (
    'service_quality','incomplete_work','no_show','damage','safety','payment','other'
  )),
  description VARCHAR(3000) NOT NULL CHECK (char_length(trim(description)) BETWEEN 10 AND 3000),
  requested_resolution TEXT NOT NULL CHECK (requested_resolution IN (
    'refund_full','refund_partial','rework','review','other'
  )),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_review','resolved','rejected')),
  resolution TEXT CHECK (resolution IS NULL OR resolution IN (
    'refund_full','refund_partial','rework','no_refund','dismissed'
  )),
  resolution_note VARCHAR(2000),
  resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT disputes_booking_scope_fk
    FOREIGN KEY (business_id, booking_id)
    REFERENCES bookings (business_id, id) ON DELETE RESTRICT,
  UNIQUE (booking_id)
);

CREATE INDEX IF NOT EXISTS disputes_business_status_idx
  ON disputes (business_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS disputes_status_created_idx
  ON disputes (status, created_at DESC);

CREATE TABLE IF NOT EXISTS dispute_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  author_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  author_role TEXT NOT NULL CHECK (author_role IN ('customer','business','admin')),
  message VARCHAR(3000) NOT NULL CHECK (char_length(trim(message)) BETWEEN 1 AND 3000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dispute_messages_dispute_idx
  ON dispute_messages (dispute_id, created_at);

CREATE TABLE IF NOT EXISTS dispute_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL REFERENCES disputes(id) ON DELETE RESTRICT,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  note VARCHAR(2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dispute_events_dispute_idx
  ON dispute_events (dispute_id, created_at);
