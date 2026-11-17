import './config.js';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL?.trim();

const pool = databaseUrl && process.env.NODE_ENV !== 'test'
  ? new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 30000,
      query_timeout: 15000,
      statement_timeout: 15000,
      max: 5,
      application_name: 'swiftserve-api'
    })
  : null;

if (!databaseUrl && process.env.NODE_ENV === 'production') {
  throw new Error('DATABASE_URL is required in production. Refusing to start with volatile in-memory storage.');
}

if (pool) {
  pool.on('error', error => {
    console.error(JSON.stringify({
      event: 'database_pool_error',
      code: typeof error?.code === 'string' ? error.code : 'NO_CODE',
      name: typeof error?.name === 'string' ? error.name : 'UNKNOWN_ERROR'
    }));
  });
}

const memoryJobs = new Map();
const memoryUsers = new Map();
const memoryUsersByEmail = new Map();
const memoryBusinesses = new Map();
const memoryMemberships = new Map();
const memorySessions = new Map();

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    accountType: user.accountType,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    service: row.service,
    description: row.description,
    area: row.area,
    status: row.status,
    businessId: row.business_id,
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export function isDatabaseConfigured() {
  return Boolean(pool);
}

export async function checkDatabase() {
  if (!pool) return { configured: false, connected: false };

  await pool.query('SELECT 1');
  const schema = await pool.query(
    "SELECT to_regclass('public.service_requests') AS service_requests, " +
    "to_regclass('public.users') AS users, " +
    "to_regclass('public.businesses') AS businesses, " +
    "to_regclass('public.business_memberships') AS business_memberships, " +
    "to_regclass('public.sessions') AS sessions, " +
    "to_regclass('public.business_branches') AS business_branches, " +
    "to_regclass('public.business_services') AS business_services, " +
    "to_regclass('public.business_hours') AS business_hours, " +
    "to_regclass('public.business_service_areas') AS business_service_areas, " +
    "to_regclass('public.business_invitations') AS business_invitations"
  );

  const row = schema.rows[0] || {};
  const requiredTables = ['service_requests', 'users', 'businesses', 'business_memberships', 'sessions',
    'business_branches', 'business_services', 'business_hours', 'business_service_areas', 'business_invitations'];
  const missingTables = requiredTables.filter(name => !row[name]);

  if (missingTables.length) {
    const error = new Error('Required database tables are missing: ' + missingTables.join(', '));
    error.code = 'DATABASE_SCHEMA_INCOMPLETE';
    throw error;
  }

  const migrations = await pool.query('SELECT version FROM schema_migrations');
  const applied = new Set(migrations.rows.map(item => item.version));
  const requiredMigrations = [
    '001_initial_schema.sql',
    '002_identity_business_scope.sql',
    '003_business_operations.sql'
  ];
  const missingMigrations = requiredMigrations.filter(version => !applied.has(version));

  if (missingMigrations.length) {
    const error = new Error('Required migrations have not been recorded: ' + missingMigrations.join(', '));
    error.code = 'DATABASE_MIGRATIONS_INCOMPLETE';
    throw error;
  }

  return { configured: true, connected: true, schemaReady: true };
}

export async function createAccount({ user, business, session }) {
  if (!pool) {
    if (memoryUsersByEmail.has(user.email)) {
      const error = new Error('An account with this email already exists.');
      error.code = 'EMAIL_ALREADY_REGISTERED';
      throw error;
    }

    const storedUser = { ...user };
    memoryUsers.set(user.id, storedUser);
    memoryUsersByEmail.set(user.email, user.id);

    const businesses = [];
    if (business) {
      memoryBusinesses.set(business.id, { ...business, status: 'active' });
      memoryMemberships.set(business.id + ':' + user.id, {
        businessId: business.id,
        userId: user.id,
        role: 'owner',
        status: 'active'
      });
      businesses.push({
        id: business.id,
        name: business.name,
        countryCode: business.countryCode ?? null,
        role: 'owner'
      });
    }

    memorySessions.set(session.tokenHash, {
      userId: user.id,
      expiresAt: session.expiresAt,
      revokedAt: null
    });

    return { user: publicUser(storedUser), businesses };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insertedUser = await client.query(
      'INSERT INTO users (id, email, full_name, account_type, password_hash, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, full_name, account_type, status, created_at, updated_at',
      [user.id, user.email, user.fullName, user.accountType, user.passwordHash, 'active']
    );

    const businesses = [];
    if (business) {
      await client.query(
        'INSERT INTO businesses (id, name, country_code, status) VALUES ($1, $2, $3, $4)',
        [business.id, business.name, business.countryCode ?? null, 'active']
      );
      await client.query(
        'INSERT INTO business_memberships (business_id, user_id, role, status) VALUES ($1, $2, $3, $4)',
        [business.id, user.id, 'owner', 'active']
      );
      businesses.push({
        id: business.id,
        name: business.name,
        countryCode: business.countryCode ?? null,
        role: 'owner'
      });
    }

    await client.query(
      'INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
      [session.id, user.id, session.tokenHash, session.expiresAt]
    );
    await client.query('COMMIT');

    const row = insertedUser.rows[0];
    return {
      user: {
        id: row.id,
        email: row.email,
        fullName: row.full_name,
        accountType: row.account_type,
        status: row.status,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
      },
      businesses
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error?.code === '23505' && error?.constraint === 'users_email_unique') {
      const duplicate = new Error('An account with this email already exists.');
      duplicate.code = 'EMAIL_ALREADY_REGISTERED';
      throw duplicate;
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function findUserByEmail(email) {
  if (!pool) {
    const id = memoryUsersByEmail.get(email);
    const user = id ? memoryUsers.get(id) : null;
    return user ? { ...user } : null;
  }

  const result = await pool.query(
    'SELECT id, email, full_name, account_type, password_hash, status, created_at, updated_at FROM users WHERE email = $1 LIMIT 1',
    [email]
  );
  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    accountType: row.account_type,
    passwordHash: row.password_hash,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export async function createSession({ id, userId, tokenHash, expiresAt }) {
  if (!pool) {
    memorySessions.set(tokenHash, { userId, expiresAt, revokedAt: null });
    return;
  }
  await pool.query(
    'INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
    [id, userId, tokenHash, expiresAt]
  );
}

export async function getSessionUser(tokenHash) {
  if (!pool) {
    const session = memorySessions.get(tokenHash);
    if (!session || session.revokedAt || new Date(session.expiresAt).getTime() <= Date.now()) return null;
    const user = memoryUsers.get(session.userId);
    if (!user || user.status !== 'active') return null;
    return publicUser(user);
  }

  const result = await pool.query(
    "SELECT u.id, u.email, u.full_name, u.account_type, u.status, u.created_at, u.updated_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active' LIMIT 1",
    [tokenHash]
  );

  const row = result.rows[0];
  if (!row) return null;

  await pool.query('UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1', [tokenHash]);
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    accountType: row.account_type,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export async function revokeSession(tokenHash) {
  if (!pool) {
    const session = memorySessions.get(tokenHash);
    if (!session || session.revokedAt) return false;
    session.revokedAt = new Date().toISOString();
    memorySessions.set(tokenHash, session);
    return true;
  }

  const result = await pool.query(
    'UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [tokenHash]
  );
  return result.rowCount > 0;
}

export async function listUserBusinesses(userId) {
  if (!pool) {
    const businesses = [];
    for (const membership of memoryMemberships.values()) {
      if (membership.userId !== userId || membership.status !== 'active') continue;
      const business = memoryBusinesses.get(membership.businessId);
      if (business && business.status === 'active') {
        businesses.push({
          id: business.id,
          name: business.name,
          countryCode: business.countryCode ?? null,
          role: membership.role
        });
      }
    }
    return businesses;
  }

  const result = await pool.query(
    "SELECT b.id, b.name, b.country_code, bm.role FROM business_memberships bm JOIN businesses b ON b.id = bm.business_id WHERE bm.user_id = $1 AND bm.status = 'active' AND b.status = 'active' ORDER BY b.created_at ASC",
    [userId]
  );
  return result.rows.map(row => ({
    id: row.id,
    name: row.name,
    countryCode: row.country_code,
    role: row.role
  }));
}

export async function getBusinessMembership(userId, businessId) {
  if (!pool) {
    const membership = memoryMemberships.get(businessId + ':' + userId);
    const business = memoryBusinesses.get(businessId);
    if (!membership || membership.status !== 'active' || !business || business.status !== 'active') return null;
    return { businessId, userId, role: membership.role };
  }

  const result = await pool.query(
    "SELECT bm.business_id, bm.user_id, bm.role FROM business_memberships bm JOIN businesses b ON b.id = bm.business_id WHERE bm.user_id = $1 AND bm.business_id = $2 AND bm.status = 'active' AND b.status = 'active' LIMIT 1",
    [userId, businessId]
  );
  const row = result.rows[0];
  return row ? { businessId: row.business_id, userId: row.user_id, role: row.role } : null;
}

export async function listJobs(status, businessId) {
  if (!pool) {
    return [...memoryJobs.values()].filter(job =>
      job.businessId === businessId && (!status || job.status === status)
    );
  }

  const result = status
    ? await pool.query(
        'SELECT * FROM service_requests WHERE business_id = $1 AND status = $2 ORDER BY created_at DESC',
        [businessId, status]
      )
    : await pool.query(
        'SELECT * FROM service_requests WHERE business_id = $1 ORDER BY created_at DESC',
        [businessId]
      );

  return result.rows.map(fromRow);
}

export async function getJob(id, businessId) {
  if (!pool) {
    const job = memoryJobs.get(id);
    return job && job.businessId === businessId ? job : null;
  }

  const result = await pool.query(
    'SELECT * FROM service_requests WHERE id = $1 AND business_id = $2',
    [id, businessId]
  );
  return fromRow(result.rows[0]);
}

export async function createJob(job, businessId, createdByUserId) {
  if (!pool) {
    const stored = { ...job, businessId, createdByUserId };
    memoryJobs.set(job.id, stored);
    return stored;
  }

  const result = await pool.query(
    'INSERT INTO service_requests (business_id, created_by_user_id, service, description, area, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [businessId, createdByUserId, job.service, job.description, job.area, job.status]
  );
  return fromRow(result.rows[0]);
}

export async function updateJob(id, patch, expectedStatus, businessId) {
  const current = await getJob(id, businessId);
  if (!current || (expectedStatus && current.status !== expectedStatus)) return null;

  const updated = {
    service: patch.service ?? current.service,
    description: patch.description ?? current.description,
    area: patch.area ?? current.area,
    status: patch.status ?? current.status
  };

  if (!pool) {
    const stored = { ...current, ...updated, updatedAt: new Date().toISOString() };
    memoryJobs.set(id, stored);
    return stored;
  }

  const result = await pool.query(
    'UPDATE service_requests SET service=$1, description=$2, area=$3, status=$4, updated_at=now() WHERE id=$5 AND business_id=$6 AND status=$7 RETURNING *',
    [updated.service, updated.description, updated.area, updated.status, id, businessId, current.status]
  );
  return fromRow(result.rows[0]);
}

export async function deleteJob(id, businessId) {
  if (!pool) {
    const current = memoryJobs.get(id);
    if (!current || current.businessId !== businessId) return false;
    return memoryJobs.delete(id);
  }

  const result = await pool.query(
    'DELETE FROM service_requests WHERE id = $1 AND business_id = $2',
    [id, businessId]
  );
  return result.rowCount > 0;
}

export function resetStore() {
  memoryJobs.clear();
  memoryUsers.clear();
  memoryUsersByEmail.clear();
  memoryBusinesses.clear();
  memoryMemberships.clear();
  memorySessions.clear();
}

export async function queryDatabase(text, values = []) {
  if (!pool) return null;
  return pool.query(text, values);
}

export async function getBusinessSummary(businessId) {
  if (!pool) {
    const business = memoryBusinesses.get(businessId);
    if (!business || business.status !== 'active') return null;
    return {
      id: business.id,
      name: business.name,
      description: business.description ?? null,
      businessEmail: business.businessEmail ?? null,
      phoneE164: business.phoneE164 ?? null,
      website: business.website ?? null,
      countryCode: business.countryCode ?? null,
      currencyCode: business.currencyCode ?? null,
      timeZone: business.timeZone ?? null,
      status: business.status
    };
  }
  const result = await pool.query(
    "SELECT id, name, description, business_email, phone_e164, website, country_code, currency_code, time_zone, status FROM businesses WHERE id=$1 AND status='active' LIMIT 1",
    [businessId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    businessEmail: row.business_email,
    phoneE164: row.phone_e164,
    website: row.website,
    countryCode: row.country_code,
    currencyCode: row.currency_code,
    timeZone: row.time_zone,
    status: row.status
  };
}

export async function updateBusinessSummary(businessId, patch) {
  const columns = {
    name: 'name',
    description: 'description',
    businessEmail: 'business_email',
    phoneE164: 'phone_e164',
    website: 'website',
    countryCode: 'country_code',
    currencyCode: 'currency_code',
    timeZone: 'time_zone'
  };
  const entries = Object.entries(patch).filter(([key]) => Object.prototype.hasOwnProperty.call(columns, key));
  if (!pool) {
    const current = memoryBusinesses.get(businessId);
    if (!current || current.status !== 'active') return null;
    for (const [key, value] of entries) current[key] = value;
    memoryBusinesses.set(businessId, current);
    return getBusinessSummary(businessId);
  }
  if (entries.length === 0) return getBusinessSummary(businessId);
  const setParts = entries.map(([key], index) => columns[key] + "=$" + (index + 2));
  const values = entries.map(([, value]) => value);
  const result = await pool.query(
    "UPDATE businesses SET " + setParts.join(", ") + ", updated_at=now() WHERE id=$1 AND status='active' RETURNING id,name,description,business_email,phone_e164,website,country_code,currency_code,time_zone,status",
    [businessId, ...values]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id, name: row.name, description: row.description,
    businessEmail: row.business_email, phoneE164: row.phone_e164,
    website: row.website, countryCode: row.country_code,
    currencyCode: row.currency_code, timeZone: row.time_zone, status: row.status
  };
}

export async function listBusinessMembers(businessId) {
  if (!pool) {
    const members = [];
    for (const membership of memoryMemberships.values()) {
      if (membership.businessId !== businessId || membership.status !== 'active') continue;
      const user = memoryUsers.get(membership.userId);
      if (user) members.push({
        userId: user.id, email: user.email, fullName: user.fullName,
        role: membership.role, joinedAt: membership.createdAt ?? null
      });
    }
    return members;
  }
  const result = await pool.query(
    "SELECT u.id AS user_id,u.email,u.full_name,bm.role,bm.created_at AS joined_at FROM business_memberships bm JOIN users u ON u.id=bm.user_id WHERE bm.business_id=$1 AND bm.status='active' ORDER BY CASE bm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END,u.full_name",
    [businessId]
  );
  return result.rows.map(row => ({
    userId: row.user_id, email: row.email, fullName: row.full_name,
    role: row.role, joinedAt: row.joined_at ? new Date(row.joined_at).toISOString() : null
  }));
}

export async function updateBusinessMemberRole(businessId, userId, role) {
  if (!pool) {
    const key = businessId + ':' + userId;
    const membership = memoryMemberships.get(key);
    if (!membership || membership.role === 'owner' || membership.status !== 'active') return null;
    membership.role = role;
    memoryMemberships.set(key, membership);
    return { businessId, userId, role };
  }
  const result = await pool.query(
    "UPDATE business_memberships SET role=$3 WHERE business_id=$1 AND user_id=$2 AND status='active' AND role<>'owner' RETURNING business_id,user_id,role",
    [businessId, userId, role]
  );
  const row = result.rows[0];
  return row ? { businessId: row.business_id, userId: row.user_id, role: row.role } : null;
}

export async function addBusinessMember(businessId, userId, role) {
  if (!pool) {
    const business = memoryBusinesses.get(businessId);
    const user = memoryUsers.get(userId);
    if (!business || !user || business.status !== 'active' || user.status !== 'active') return null;
    const key = businessId + ':' + userId;
    memoryMemberships.set(key, {
      businessId, userId, role, status: 'active',
      createdAt: new Date().toISOString()
    });
    return { businessId, userId, role };
  }
  const result = await pool.query(
    "INSERT INTO business_memberships (business_id,user_id,role,status) VALUES ($1,$2,$3,'active') ON CONFLICT (business_id,user_id) DO UPDATE SET role=EXCLUDED.role,status='active' RETURNING business_id,user_id,role",
    [businessId,userId,role]
  );
  const row = result.rows[0];
  return row ? { businessId: row.business_id, userId: row.user_id, role: row.role } : null;
}

export async function removeBusinessMember(businessId, userId) {
  if (!pool) {
    const key = businessId + ':' + userId;
    const membership = memoryMemberships.get(key);
    if (!membership || membership.role === 'owner') return false;
    return memoryMemberships.delete(key);
  }
  const result = await pool.query(
    "DELETE FROM business_memberships WHERE business_id=$1 AND user_id=$2 AND role<>'owner'",
    [businessId, userId]
  );
  return result.rowCount > 0;
}

export async function closeDatabase() {
  if (pool) await pool.end();
}
