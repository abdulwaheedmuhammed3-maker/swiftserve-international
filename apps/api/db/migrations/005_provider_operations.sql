-- Provider onboarding, availability and controlled booking assignment.
-- Apply after 004_customer_bookings.sql.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS service_duration_minutes_snapshot INTEGER
  CHECK (service_duration_minutes_snapshot IS NULL OR service_duration_minutes_snapshot BETWEEN 1 AND 1440);

UPDATE bookings booking
SET service_duration_minutes_snapshot = service.duration_minutes
FROM business_services service
WHERE booking.business_id = service.business_id
  AND booking.service_id = service.id
  AND booking.service_duration_minutes_snapshot IS NULL;

CREATE TABLE IF NOT EXISTS provider_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name VARCHAR(100) NOT NULL CHECK (char_length(trim(display_name)) BETWEEN 2 AND 100),
  phone_e164 VARCHAR(20),
  bio VARCHAR(1200),
  country_code CHAR(2) NOT NULL,
  time_zone VARCHAR(64) NOT NULL,
  years_experience SMALLINT NOT NULL DEFAULT 0 CHECK (years_experience BETWEEN 0 AND 60),
  languages TEXT[] NOT NULL DEFAULT ARRAY['en']::TEXT[],
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_review','approved','rejected','suspended')),
  review_note VARCHAR(1000),
  submitted_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT provider_profiles_country_check CHECK (
    country_code = upper(country_code) AND country_code ~ '^[A-Z]{2}$'
  ),
  CONSTRAINT provider_profiles_phone_check CHECK (
    phone_e164 IS NULL OR phone_e164 ~ '^\\+[1-9][0-9]{7,14}$'
  )
);

CREATE INDEX IF NOT EXISTS provider_profiles_status_country_idx
  ON provider_profiles (status, country_code, display_name);

CREATE TABLE IF NOT EXISTS provider_service_categories (
  provider_user_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN (
    'cleaning','laundry','electrical','plumbing','ac-repair','appliance-repair','errand'
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
  CONSTRAINT provider_areas_country_check CHECK (
    country_code = upper(country_code) AND country_code ~ '^[A-Z]{2}$'
  ),
  CONSTRAINT provider_areas_location_check CHECK (
    city IS NOT NULL OR region IS NOT NULL OR postal_code_prefix IS NOT NULL
  ),
  UNIQUE (provider_user_id, country_code, region, city, postal_code_prefix)
);

CREATE INDEX IF NOT EXISTS provider_service_areas_lookup_idx
  ON provider_service_areas (country_code, city, region)
  WHERE is_active = true;

CREATE TABLE IF NOT EXISTS provider_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_user_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  starts_at TIME NOT NULL,
  ends_at TIME NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT provider_availability_window_check CHECK (ends_at > starts_at),
  UNIQUE (provider_user_id, day_of_week, starts_at, ends_at)
);

CREATE INDEX IF NOT EXISTS provider_availability_provider_day_idx
  ON provider_availability (provider_user_id, day_of_week, starts_at);

CREATE TABLE IF NOT EXISTS booking_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  booking_id UUID NOT NULL,
  provider_user_id UUID NOT NULL,
  assigned_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'offered'
    CHECK (status IN ('offered','accepted','declined','in_progress','completed','cancelled')),
  scheduled_start_at TIMESTAMPTZ NOT NULL,
  scheduled_end_at TIMESTAMPTZ NOT NULL,
  offered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancellation_note VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT booking_assignments_window_check CHECK (scheduled_end_at > scheduled_start_at),
  FOREIGN KEY (business_id, booking_id)
    REFERENCES bookings (business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, provider_user_id)
    REFERENCES business_memberships (business_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_user_id)
    REFERENCES provider_profiles (user_id) ON DELETE RESTRICT,
  UNIQUE (business_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS booking_assignments_one_active_booking_idx
  ON booking_assignments (booking_id)
  WHERE status IN ('offered','accepted','in_progress');

CREATE INDEX IF NOT EXISTS booking_assignments_provider_schedule_idx
  ON booking_assignments (provider_user_id, scheduled_start_at, scheduled_end_at)
  WHERE status IN ('offered','accepted','in_progress');

CREATE INDEX IF NOT EXISTS booking_assignments_business_status_idx
  ON booking_assignments (business_id, status, scheduled_start_at);

CREATE TABLE IF NOT EXISTS booking_assignment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  assignment_id UUID NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  note VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, assignment_id)
    REFERENCES booking_assignments (business_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS booking_assignment_events_history_idx
  ON booking_assignment_events (business_id, assignment_id, created_at);
