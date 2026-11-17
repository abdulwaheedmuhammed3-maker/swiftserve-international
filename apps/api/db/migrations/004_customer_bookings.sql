-- Customer marketplace and booking foundation.
-- Apply after 003_business_operations.sql.

CREATE TABLE IF NOT EXISTS customer_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  phone_e164 VARCHAR(20),
  preferred_language VARCHAR(12) NOT NULL DEFAULT 'en',
  locale VARCHAR(16) NOT NULL DEFAULT 'en',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT customer_profiles_phone_check CHECK (
    phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}'
  )
);

CREATE TABLE IF NOT EXISTS customer_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label VARCHAR(60) NOT NULL CHECK (char_length(trim(label)) BETWEEN 2 AND 60),
  recipient_name VARCHAR(100) NOT NULL CHECK (char_length(trim(recipient_name)) BETWEEN 2 AND 100),
  phone_e164 VARCHAR(20),
  country_code CHAR(2) NOT NULL,
  address_line1 VARCHAR(160) NOT NULL CHECK (char_length(trim(address_line1)) BETWEEN 3 AND 160),
  address_line2 VARCHAR(160),
  city VARCHAR(100) NOT NULL CHECK (char_length(trim(city)) BETWEEN 2 AND 100),
  region VARCHAR(100),
  postal_code VARCHAR(24),
  delivery_instructions VARCHAR(500),
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT customer_locations_country_check CHECK (
    length(country_code) = 2 AND country_code = upper(country_code) AND country_code ~ '^[A-Z][A-Z]'
  ),
  CONSTRAINT customer_locations_phone_check CHECK (
    phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}'
  ),
  UNIQUE (customer_user_id, id)
);

CREATE INDEX IF NOT EXISTS customer_locations_user_idx
  ON customer_locations (customer_user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS customer_locations_default_idx
  ON customer_locations (customer_user_id) WHERE is_default = true;

CREATE UNIQUE INDEX IF NOT EXISTS business_services_business_id_idx
  ON business_services (business_id, id);

CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_reference VARCHAR(24) NOT NULL UNIQUE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  service_id UUID,
  branch_id UUID,
  customer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  customer_location_id UUID,
  service_name_snapshot VARCHAR(120) NOT NULL,
  service_category_snapshot TEXT NOT NULL,
  pricing_model_snapshot TEXT NOT NULL CHECK (pricing_model_snapshot IN ('fixed', 'hourly', 'quote')),
  currency_code CHAR(3) NOT NULL,
  service_address_recipient VARCHAR(100) NOT NULL,
  service_address_phone VARCHAR(20),
  service_country_code CHAR(2) NOT NULL,
  service_address_line1 VARCHAR(160) NOT NULL,
  service_address_line2 VARCHAR(160),
  service_city VARCHAR(100) NOT NULL,
  service_region VARCHAR(100),
  service_postal_code VARCHAR(24),
  requested_start_at TIMESTAMPTZ NOT NULL,
  requested_end_at TIMESTAMPTZ,
  confirmed_start_at TIMESTAMPTZ,
  confirmed_end_at TIMESTAMPTZ,
  customer_notes VARCHAR(1500),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN (
    'requested', 'quoted', 'confirmed', 'assigned', 'in_progress',
    'completed', 'cancelled', 'declined'
  )),
  latest_quote_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bookings_service_scope_fk
    FOREIGN KEY (business_id, service_id)
    REFERENCES business_services (business_id, id) ON DELETE SET NULL,
  CONSTRAINT bookings_branch_scope_fk
    FOREIGN KEY (business_id, branch_id)
    REFERENCES business_branches (business_id, id) ON DELETE SET NULL,
  CONSTRAINT bookings_customer_location_scope_fk
    FOREIGN KEY (customer_user_id, customer_location_id)
    REFERENCES customer_locations (customer_user_id, id) ON DELETE SET NULL,
  CONSTRAINT bookings_requested_window_check CHECK (
    requested_end_at IS NULL OR requested_end_at > requested_start_at
  ),
  CONSTRAINT bookings_confirmed_window_check CHECK (
    confirmed_end_at IS NULL OR (confirmed_start_at IS NOT NULL AND confirmed_end_at > confirmed_start_at)
  ),
  CONSTRAINT bookings_currency_check CHECK (
    length(currency_code) = 3 AND currency_code = upper(currency_code)
  ),
  CONSTRAINT bookings_country_check CHECK (
    length(service_country_code) = 2 AND service_country_code = upper(service_country_code)
  ),
  UNIQUE (business_id, id)
);

CREATE INDEX IF NOT EXISTS bookings_business_created_idx
  ON bookings (business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS bookings_business_status_idx
  ON bookings (business_id, status, requested_start_at);

CREATE INDEX IF NOT EXISTS bookings_customer_created_idx
  ON bookings (customer_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS booking_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  booking_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency_code CHAR(3) NOT NULL,
  message VARCHAR(1000),
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'withdrawn')),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT booking_quotes_currency_check CHECK (
    length(currency_code) = 3 AND currency_code = upper(currency_code)
  ),
  FOREIGN KEY (business_id, booking_id)
    REFERENCES bookings (business_id, id) ON DELETE CASCADE,
  UNIQUE (booking_id, version),
  UNIQUE (business_id, id)
);

CREATE INDEX IF NOT EXISTS booking_quotes_booking_idx
  ON booking_quotes (business_id, booking_id, version DESC);

CREATE UNIQUE INDEX IF NOT EXISTS booking_quotes_one_pending_idx
  ON booking_quotes (booking_id) WHERE status = 'pending';

ALTER TABLE bookings
  ADD CONSTRAINT bookings_latest_quote_scope_fk
  FOREIGN KEY (business_id, latest_quote_id)
  REFERENCES booking_quotes (business_id, id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS booking_status_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  booking_id UUID NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  note VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, booking_id)
    REFERENCES bookings (business_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS booking_status_events_booking_idx
  ON booking_status_events (business_id, booking_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type VARCHAR(60) NOT NULL,
  title VARCHAR(140) NOT NULL,
  body VARCHAR(1000) NOT NULL,
  resource_type VARCHAR(60),
  resource_id UUID,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
