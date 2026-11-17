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
    "to_regclass('public.sessions') AS sessions"
  );

  const row = schema.rows[0] || {};
  const requiredTables = ['service_requests', 'users', 'businesses', 'business_memberships', 'sessions'];
  const missingTables = requiredTables.filter(name => !row[name]);

  if (missingTables.length) {
    const error = new Error('Required database migrations are missing: ' + missingTables.join(', '));
    error.code = 'DATABASE_SCHEMA_INCOMPLETE';
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

export async function closeDatabase() {
  if (pool) await pool.end();
}
