-- Business workspace schema: profiles, branches, services, opening hours,
-- service coverage and controlled team invitations.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS business_email VARCHAR(254),
  ADD COLUMN IF NOT EXISTS phone_e164 VARCHAR(20),
  ADD COLUMN IF NOT EXISTS website VARCHAR(255),
  ADD COLUMN IF NOT EXISTS currency_code CHAR(3),
  ADD COLUMN IF NOT EXISTS time_zone VARCHAR(64);

CREATE TABLE IF NOT EXISTS business_branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 100),
  country_code CHAR(2) NOT NULL,
  address_line1 VARCHAR(160) NOT NULL CHECK (char_length(trim(address_line1)) BETWEEN 3 AND 160),
  address_line2 VARCHAR(160),
  city VARCHAR(100) NOT NULL CHECK (char_length(trim(city)) BETWEEN 2 AND 100),
  region VARCHAR(100),
  postal_code VARCHAR(24),
  phone_e164 VARCHAR(20),
  time_zone VARCHAR(64),
  is_primary BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT business_branches_country_check CHECK (
    length(country_code) = 2 AND country_code = upper(country_code) AND country_code ~ '^[A-Z][A-Z]'
  ),
  UNIQUE (business_id, id)
);

CREATE INDEX IF NOT EXISTS business_branches_business_status_idx
  ON business_branches (business_id, status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS business_branches_one_primary_idx
  ON business_branches (business_id) WHERE is_primary = true;

CREATE TABLE IF NOT EXISTS business_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN (
    'cleaning', 'laundry', 'electrical', 'plumbing',
    'ac-repair', 'appliance-repair', 'errand'
  )),
  name VARCHAR(120) NOT NULL CHECK (char_length(trim(name)) BETWEEN 2 AND 120),
  slug VARCHAR(140) NOT NULL,
  description TEXT NOT NULL CHECK (char_length(trim(description)) BETWEEN 10 AND 1500),
  pricing_model TEXT NOT NULL CHECK (pricing_model IN ('fixed', 'hourly', 'quote')),
  currency_code CHAR(3) NOT NULL,
  price_minor BIGINT,
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 5 AND 1440),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT business_services_slug_check CHECK (
    slug = lower(slug) AND slug ~ '^[a-z0-9-]+' AND
    position('--' in slug) = 0 AND left(slug,1) <> '-' AND right(slug,1) <> '-'
  ),
  CONSTRAINT business_services_currency_check CHECK (
    length(currency_code) = 3 AND currency_code = upper(currency_code) AND currency_code ~ '^[A-Z][A-Z][A-Z]'
  ),
  CONSTRAINT business_services_price_check CHECK (
    (pricing_model = 'quote' AND price_minor IS NULL)
    OR
    (pricing_model IN ('fixed', 'hourly') AND price_minor IS NOT NULL AND price_minor >= 0)
  ),
  UNIQUE (business_id, slug)
);

CREATE INDEX IF NOT EXISTS business_services_active_category_idx
  ON business_services (business_id, is_active, category);

CREATE TABLE IF NOT EXISTS business_hours (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id UUID,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  opens_at TIME,
  closes_at TIME,
  is_closed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT business_hours_branch_scope_fk
    FOREIGN KEY (business_id, branch_id)
    REFERENCES business_branches (business_id, id) ON DELETE CASCADE,
  CONSTRAINT business_hours_time_check CHECK (
    (is_closed = true AND opens_at IS NULL AND closes_at IS NULL)
    OR
    (is_closed = false AND opens_at IS NOT NULL AND closes_at IS NOT NULL AND opens_at < closes_at)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS business_hours_business_day_idx
  ON business_hours (business_id, day_of_week) WHERE branch_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS business_hours_branch_day_idx
  ON business_hours (business_id, branch_id, day_of_week) WHERE branch_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS business_service_areas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id UUID,
  country_code CHAR(2) NOT NULL,
  region VARCHAR(100),
  city VARCHAR(100),
  postal_code_prefix VARCHAR(24),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT business_service_areas_branch_scope_fk
    FOREIGN KEY (business_id, branch_id)
    REFERENCES business_branches (business_id, id) ON DELETE CASCADE,
  CONSTRAINT business_service_areas_country_check CHECK (
    length(country_code) = 2 AND country_code = upper(country_code) AND country_code ~ '^[A-Z][A-Z]'
  ),
  CONSTRAINT business_service_areas_scope_check CHECK (
    region IS NOT NULL OR city IS NOT NULL OR postal_code_prefix IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS business_service_areas_lookup_idx
  ON business_service_areas (country_code, city, region) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS business_service_areas_business_idx
  ON business_service_areas (business_id, is_active);

CREATE TABLE IF NOT EXISTS business_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'staff')),
  token_hash CHAR(64) NOT NULL UNIQUE,
  invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  accepted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT business_invitations_email_normalized_check CHECK (email = lower(trim(email))),
  CONSTRAINT business_invitations_token_hash_check CHECK (
    length(token_hash) = 64 AND token_hash = lower(token_hash) AND token_hash ~ '^[0-9a-f]+'
  ),
  UNIQUE (business_id, email)
);

CREATE INDEX IF NOT EXISTS business_invitations_business_status_idx
  ON business_invitations (business_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS business_invitations_email_status_idx
  ON business_invitations (email, status, expires_at);
