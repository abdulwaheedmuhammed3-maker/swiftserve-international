-- Provider onboarding, review, availability and booking assignment foundation.
-- Apply after 004_customer_bookings.sql.

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_account_type_check;

ALTER TABLE users
  ADD CONSTRAINT users_account_type_check
  CHECK (account_type IN ('customer', 'business', 'provider'));

CREATE TABLE IF NOT EXISTS platform_admins (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  granted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  display_name VARCHAR(100) NOT NULL CHECK (char_length(trim(display_name)) BETWEEN 2 AND 100),
  professional_title VARCHAR(100),
  bio VARCHAR(2000),
  phone_e164 VARCHAR(20) NOT NULL,
  country_code CHAR(2) NOT NULL,
  time_zone VARCHAR(64) NOT NULL,
  years_experience SMALLINT CHECK (years_experience IS NULL OR years_experience BETWEEN 0 AND 60),
  profile_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (profile_status IN ('draft', 'submitted', 'active', 'rejected', 'suspended')),
  verification_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (verification_status IN ('not_started', 'pending', 'verified', 'rejected')),
  is_accepting_bookings BOOLEAN NOT NULL DEFAULT false,
  reviewed_by_user_id UUID REFERENCES platform_admins(user_id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_note VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT provider_profiles_phone_check CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}'),
  CONSTRAINT provider_profiles_country_check CHECK (
    length(country_code) = 2 AND country_code = upper(country_code)
  ),
  CONSTRAINT provider_profiles_verified_state_check CHECK (
    verification_status <> 'verified' OR profile_status = 'active'
  )
);

CREATE INDEX IF NOT EXISTS provider_profiles_review_queue_idx
  ON provider_profiles (profile_status, verification_status, created_at DESC);

CREATE INDEX IF NOT EXISTS provider_profiles_available_idx
  ON provider_profiles (country_code, is_accepting_bookings)
  WHERE profile_status = 'active' AND verification_status = 'verified';

CREATE TABLE IF NOT EXISTS provider_service_categories (
  provider_user_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN (
    'cleaning', 'laundry', 'electrical', 'plumbing',
    'ac-repair', 'appliance-repair', 'errand'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
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
  ),
  UNIQUE (provider_user_id, id)
);

CREATE INDEX IF NOT EXISTS provider_service_areas_lookup_idx
  ON provider_service_areas (country_code, city, region)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS provider_service_areas_provider_idx
  ON provider_service_areas (provider_user_id, is_active);

CREATE TABLE IF NOT EXISTS provider_availability_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_user_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  starts_at TIME NOT NULL,
  ends_at TIME NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT provider_availability_window_check CHECK (starts_at < ends_at),
  UNIQUE (provider_user_id, id),
  UNIQUE (provider_user_id, day_of_week, starts_at, ends_at)
);

CREATE INDEX IF NOT EXISTS provider_availability_weekly_idx
  ON provider_availability_windows (provider_user_id, day_of_week, starts_at);

CREATE TABLE IF NOT EXISTS booking_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  booking_id UUID NOT NULL,
  provider_user_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE RESTRICT,
  assigned_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'offered'
    CHECK (status IN ('offered', 'accepted', 'declined', 'cancelled', 'in_progress', 'completed')),
  offered_start_at TIMESTAMPTZ,
  offered_end_at TIMESTAMPTZ,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  note VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT booking_assignments_booking_scope_fk
    FOREIGN KEY (business_id, booking_id)
    REFERENCES bookings (business_id, id) ON DELETE CASCADE,
  CONSTRAINT booking_assignments_window_check CHECK (
    offered_end_at IS NULL OR
    (offered_start_at IS NOT NULL AND offered_end_at > offered_start_at)
  ),
  UNIQUE (business_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS booking_assignments_one_active_per_booking_idx
  ON booking_assignments (business_id, booking_id)
  WHERE status IN ('offered', 'accepted', 'in_progress');

CREATE INDEX IF NOT EXISTS booking_assignments_provider_status_idx
  ON booking_assignments (provider_user_id, status, assigned_at DESC);

CREATE INDEX IF NOT EXISTS booking_assignments_business_booking_idx
  ON booking_assignments (business_id, booking_id, assigned_at DESC);

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS current_assignment_id UUID;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_current_assignment_scope_fk
  FOREIGN KEY (business_id, current_assignment_id)
  REFERENCES booking_assignments (business_id, id) ON DELETE NO ACTION;

CREATE TABLE IF NOT EXISTS booking_assignment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  booking_id UUID NOT NULL,
  assignment_id UUID NOT NULL,
  provider_user_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE RESTRICT,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  note VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT booking_assignment_events_booking_scope_fk
    FOREIGN KEY (business_id, booking_id)
    REFERENCES bookings (business_id, id) ON DELETE CASCADE,
  CONSTRAINT booking_assignment_events_assignment_scope_fk
    FOREIGN KEY (business_id, assignment_id)
    REFERENCES booking_assignments (business_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS booking_assignment_events_booking_idx
  ON booking_assignment_events (business_id, booking_id, created_at ASC);
