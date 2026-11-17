-- Payments, provider settlement records, refunds, service reviews and disputes.
-- No card data or wallet balances are stored by SwiftServe.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'not_required'
    CHECK (payment_status IN ('not_required','pending','paid','failed','partially_refunded','refunded'));

CREATE TABLE IF NOT EXISTS payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  booking_id UUID NOT NULL,
  customer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_code TEXT NOT NULL CHECK (provider_code IN ('paystack','flutterwave')),
  provider_reference VARCHAR(120) NOT NULL UNIQUE,
  provider_transaction_ref VARCHAR(120),
  idempotency_key VARCHAR(120) NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency_code CHAR(3) NOT NULL,
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created','pending','succeeded','failed','cancelled','expired','partially_refunded','refunded')),
  checkout_url TEXT,
  expires_at TIMESTAMPTZ,
  failure_code VARCHAR(80),
  failure_message VARCHAR(500),
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id,booking_id)
    REFERENCES bookings (business_id,id) ON DELETE RESTRICT,
  CONSTRAINT payment_intents_currency_check CHECK (
    length(currency_code)=3 AND currency_code=upper(currency_code)
  ),
  UNIQUE (customer_user_id,idempotency_key),
  UNIQUE (provider_code,provider_transaction_ref)
);

CREATE INDEX IF NOT EXISTS payment_intents_booking_status_idx
  ON payment_intents (business_id,booking_id,status,created_at DESC);

CREATE INDEX IF NOT EXISTS payment_intents_customer_idx
  ON payment_intents (customer_user_id,created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_one_active_per_booking_idx
  ON payment_intents (business_id,booking_id)
  WHERE status IN ('created','pending');

CREATE TABLE IF NOT EXISTS payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id UUID NOT NULL REFERENCES payment_intents(id) ON DELETE RESTRICT,
  provider_code TEXT NOT NULL CHECK (provider_code IN ('paystack','flutterwave')),
  provider_transaction_ref VARCHAR(120) NOT NULL,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('charge','refund','adjustment')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency_code CHAR(3) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed','reversed')),
  provider_event_id VARCHAR(160),
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_transactions_currency_check CHECK (
    length(currency_code)=3 AND currency_code=upper(currency_code)
  ),
  UNIQUE (provider_code,provider_transaction_ref,transaction_type),
  UNIQUE (provider_code,provider_event_id)
);

CREATE INDEX IF NOT EXISTS payment_transactions_intent_idx
  ON payment_transactions (payment_intent_id,created_at DESC);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id UUID NOT NULL REFERENCES payment_intents(id) ON DELETE RESTRICT,
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('platform','business','provider')),
  business_id UUID REFERENCES businesses(id) ON DELETE RESTRICT,
  provider_user_id UUID REFERENCES provider_profiles(user_id) ON DELETE RESTRICT,
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency_code CHAR(3) NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','submitted','settled','failed','reversed')),
  external_account_ref VARCHAR(160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_allocations_recipient_check CHECK (
    (recipient_type='platform' AND business_id IS NULL AND provider_user_id IS NULL)
    OR (recipient_type='business' AND business_id IS NOT NULL AND provider_user_id IS NULL)
    OR (recipient_type='provider' AND business_id IS NULL AND provider_user_id IS NOT NULL)
  ),
  CONSTRAINT payment_allocations_currency_check CHECK (
    length(currency_code)=3 AND currency_code=upper(currency_code)
  )
);

CREATE INDEX IF NOT EXISTS payment_allocations_intent_idx
  ON payment_allocations (payment_intent_id,status);

CREATE TABLE IF NOT EXISTS refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id UUID NOT NULL REFERENCES payment_intents(id) ON DELETE RESTRICT,
  provider_code TEXT NOT NULL CHECK (provider_code IN ('paystack','flutterwave')),
  provider_reference VARCHAR(120) NOT NULL UNIQUE,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency_code CHAR(3) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','pending','succeeded','failed','cancelled')),
  requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  provider_refund_ref VARCHAR(120),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT refunds_currency_check CHECK (
    length(currency_code)=3 AND currency_code=upper(currency_code)
  )
);

CREATE INDEX IF NOT EXISTS refunds_intent_status_idx
  ON refunds (payment_intent_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code TEXT NOT NULL CHECK (provider_code IN ('paystack','flutterwave')),
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('business','provider')),
  business_id UUID REFERENCES businesses(id) ON DELETE RESTRICT,
  provider_user_id UUID REFERENCES provider_profiles(user_id) ON DELETE RESTRICT,
  provider_reference VARCHAR(120) NOT NULL UNIQUE,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency_code CHAR(3) NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','pending','succeeded','failed','reversed','cancelled')),
  external_account_ref VARCHAR(160) NOT NULL,
  failure_code VARCHAR(80),
  failure_message VARCHAR(500),
  requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payouts_recipient_check CHECK (
    (recipient_type='business' AND business_id IS NOT NULL AND provider_user_id IS NULL)
    OR (recipient_type='provider' AND provider_user_id IS NOT NULL AND business_id IS NULL)
  ),
  CONSTRAINT payouts_currency_check CHECK (
    length(currency_code)=3 AND currency_code=upper(currency_code)
  )
);

CREATE INDEX IF NOT EXISTS payouts_recipient_status_idx
  ON payouts (recipient_type,business_id,provider_user_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code TEXT NOT NULL CHECK (provider_code IN ('paystack','flutterwave')),
  provider_event_id VARCHAR(160) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  signature_verified BOOLEAN NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'received'
    CHECK (processing_status IN ('received','processing','processed','ignored','failed')),
  processing_error VARCHAR(500),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  CONSTRAINT payment_webhook_hash_check CHECK (
    length(payload_sha256)=64 AND payload_sha256=lower(payload_sha256)
  ),
  UNIQUE (provider_code,provider_event_id)
);

CREATE INDEX IF NOT EXISTS payment_webhook_events_status_idx
  ON payment_webhook_events (processing_status,received_at);

CREATE TABLE IF NOT EXISTS service_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  booking_id UUID NOT NULL,
  customer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_user_id UUID REFERENCES provider_profiles(user_id) ON DELETE SET NULL,
  business_rating SMALLINT NOT NULL CHECK (business_rating BETWEEN 1 AND 5),
  provider_rating SMALLINT CHECK (provider_rating IS NULL OR provider_rating BETWEEN 1 AND 5),
  review_text VARCHAR(2000),
  status TEXT NOT NULL DEFAULT 'published'
    CHECK (status IN ('published','hidden','removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id,booking_id)
    REFERENCES bookings (business_id,id) ON DELETE RESTRICT,
  UNIQUE (business_id,booking_id,customer_user_id)
);

CREATE INDEX IF NOT EXISTS service_reviews_business_idx
  ON service_reviews (business_id,status,created_at DESC);

CREATE INDEX IF NOT EXISTS service_reviews_provider_idx
  ON service_reviews (provider_user_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS service_review_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL UNIQUE REFERENCES service_reviews(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  responder_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  response_text VARCHAR(1500) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS service_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  booking_id UUID NOT NULL,
  opened_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  dispute_category TEXT NOT NULL CHECK (dispute_category IN (
    'service_not_completed','quality_issue','late_arrival','pricing_issue',
    'provider_conduct','property_damage','other'
  )),
  description VARCHAR(3000) NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','awaiting_customer','awaiting_business','under_review','resolved_customer','resolved_business','closed')),
  resolution_note VARCHAR(2000),
  assigned_admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id,booking_id)
    REFERENCES bookings (business_id,id) ON DELETE RESTRICT,
  UNIQUE (business_id,booking_id)
);

CREATE INDEX IF NOT EXISTS service_disputes_business_status_idx
  ON service_disputes (business_id,status,created_at DESC);

CREATE INDEX IF NOT EXISTS service_disputes_opened_by_idx
  ON service_disputes (opened_by_user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS service_dispute_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL REFERENCES service_disputes(id) ON DELETE CASCADE,
  sender_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  message VARCHAR(3000) NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'participants'
    CHECK (visibility IN ('participants','admin_only')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS service_dispute_messages_dispute_idx
  ON service_dispute_messages (dispute_id,created_at);
