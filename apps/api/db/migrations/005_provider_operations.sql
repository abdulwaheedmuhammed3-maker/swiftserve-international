-- Provider onboarding, verification status, provider schedules and booking assignment.
-- Apply after migrations 001–004.

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_account_type_check;

ALTER TABLE users
  ADD CONSTRAINT users_account_type_check
  CHECK (account_type IN ('customer', 'business', 'provider'));

CREATE INDEX IF NOT EXISTS users_account_type_status_idx
  ON users (account_type, status);

CREATE TABLE IF NOT EXISTS provider_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name VARCHAR(100) NOT NULL CHECK (char_length(trim(display_name)) BETWEEN 2 AND 100),
  phone_e164 VARCHAR(20),
  bio VARCHAR(1500),
  country_code CHAR(2) NOT NULL,
  time_zone VARCHAR(64) NOT NULL,
  onboarding_status TEXT NOT NULL DEFAULT 'incomplete'
    CHECK (onboarding_status IN ('incomplete', 'submitted', 'active', 'suspended')),
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'pending_review', 'verified', 'rejected')),
  verification_note VARCHAR(1000),
  verified_at TIMESTAMPTZ,
  verified_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT provider_profiles_phone_check CHECK (
    phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}'
  ),
  CONSTRAINT provider_profiles_country_check CHECK (
    length(country_code) = 2 AND country_code = upper(country_code)
  )
);

CREATE INDEX IF NOT EXISTS provider_profiles_review_queue_idx
  ON provider_profiles (verification_status, created_at)
  WHERE verification_status IN ('pending_review', 'rejected');

CREATE TABLE IF NOT EXISTS provider_skills (
  provider_user_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN (
    'cleaning', 'laundry', 'electrical', 'plumbing',
    'ac-repair', 'appliance-repair', 'errand'
  )),
  years_experience SMALLINT NOT NULL DEFAULT 0 CHECK (years_experience BETWEEN 0 AND 50),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_user_id, category)
);

CREATE TABLE IF NOT EXISTS provider_service_areas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_user_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE CASCADE,
  country_code CHAR(2) NOT NULL,
  region VARCHAR(100),
  city VARCHAR(100),
  postal_code_prefix VARCHAR(24),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT provider_service_areas_country_check CHECK (
    length(country_code) = 2 AND country_code = upper(country_code)
  ),
  CONSTRAINT provider_service_areas_scope_check CHECK (
    region IS NOT NULL OR city IS NOT NULL OR postal_code_prefix IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS provider_service_areas_lookup_idx
  ON provider_service_areas (country_code, city, region)
  WHERE is_active = true;

CREATE TABLE IF NOT EXISTS provider_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_user_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  opens_at TIME,
  closes_at TIME,
  is_available BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT provider_availability_window_check CHECK (
    (is_available = false AND opens_at IS NULL AND closes_at IS NULL)
    OR
    (is_available = true AND opens_at IS NOT NULL AND closes_at IS NOT NULL AND opens_at < closes_at)
  ),
  UNIQUE (provider_user_id, day_of_week)
);

CREATE TABLE IF NOT EXISTS business_provider_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider_user_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE CASCADE,
  invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, provider_user_id),
  UNIQUE (business_id, provider_user_id, id)
);

CREATE INDEX IF NOT EXISTS business_provider_memberships_provider_idx
  ON business_provider_memberships (provider_user_id, status);

CREATE INDEX IF NOT EXISTS business_provider_memberships_business_idx
  ON business_provider_memberships (business_id, status);

CREATE TABLE IF NOT EXISTS provider_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  accepted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT provider_invitations_email_normalized_check CHECK (email = lower(trim(email))),
  CONSTRAINT provider_invitations_token_hash_check CHECK (
    length(token_hash) = 64 AND token_hash = lower(token_hash)
  ),
  UNIQUE (business_id, email)
);

CREATE INDEX IF NOT EXISTS provider_invitations_business_status_idx
  ON provider_invitations (business_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS booking_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  booking_id UUID NOT NULL,
  provider_user_id UUID NOT NULL,
  membership_id UUID NOT NULL,
  assigned_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'offered'
    CHECK (status IN ('offered', 'accepted', 'declined', 'cancelled', 'completed')),
  scheduled_start_at TIMESTAMPTZ NOT NULL,
  scheduled_end_at TIMESTAMPTZ NOT NULL,
  provider_note VARCHAR(1000),
  response_note VARCHAR(1000),
  responded_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT booking_assignments_window_check CHECK (scheduled_end_at > scheduled_start_at),
  CONSTRAINT booking_assignments_booking_scope_fk
    FOREIGN KEY (business_id, booking_id)
    REFERENCES bookings (business_id, id) ON DELETE CASCADE,
  CONSTRAINT booking_assignments_provider_membership_fk
    FOREIGN KEY (business_id, provider_user_id, membership_id)
    REFERENCES business_provider_memberships (business_id, provider_user_id, id)
    ON DELETE RESTRICT,
  UNIQUE (business_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS booking_assignments_one_active_per_booking_idx
  ON booking_assignments (business_id, booking_id)
  WHERE status IN ('offered', 'accepted');

CREATE INDEX IF NOT EXISTS booking_assignments_provider_schedule_idx
  ON booking_assignments (provider_user_id, scheduled_start_at, scheduled_end_at)
  WHERE status IN ('offered', 'accepted');

CREATE INDEX IF NOT EXISTS booking_assignments_business_status_idx
  ON booking_assignments (business_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS provider_status_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_user_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  note VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provider_status_events_provider_idx
  ON provider_status_events (provider_user_id, created_at DESC);
