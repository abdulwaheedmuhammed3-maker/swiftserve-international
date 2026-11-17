import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { hashPassword, verifyPassword } from './auth.js';
import { getCurrentAdmin } from './admin_context.js';
import { writeAdminAuditEvent } from './admin_resources.js';
import { isDatabaseConfigured, queryDatabase } from './repository.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = new Set(['super_admin', 'finance_admin', 'support_admin', 'provider_reviewer']);
const STATUSES = new Set(['active', 'suspended', 'disabled']);
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DUMMY_PASSWORD_HASH =
  'scrypt$16384$8$1$00000000000000000000000000000000

function response(status, body) {
  return { status, body };
}

function ok(data, status = 200) {
  return response(status, { data });
}

function fail(status, code, message, details = []) {
  return response(status, { error: { code, message, details } });
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function publicAdmin(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function validBootstrapSecret(supplied) {
  const expected = process.env.SWIFTSERVE_ADMIN_BOOTSTRAP_KEY || '';
  if (!expected || typeof supplied !== 'string') return false;
  const expectedHash = createHash('sha256').update(expected).digest();
  const suppliedHash = createHash('sha256').update(supplied).digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

async function readJson(req) {
  const contentType = req.headers['content-type'] || '';
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) {
    const error = new Error('Content-Type must be application/json.');
    error.code = 'UNSUPPORTED_MEDIA_TYPE';
    throw error;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1024 * 1024) {
      const error = new Error('Request body exceeds 1 MB.');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Malformed JSON body.');
    error.code = 'INVALID_JSON';
    throw error;
  }
}

function validateAdminCredentials(body, includeRole = false) {
  if (!isObject(body)) return ['Request body must be a JSON object.'];
  const allowed = includeRole
    ? ['email', 'fullName', 'password', 'role']
    : ['email', 'fullName', 'password'];
  const errors = Object.keys(body)
    .filter(key => !allowed.includes(key))
    .map(key => 'Unknown field: ' + key + '.');
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !EMAIL.test(email)) errors.push('email must be a valid email address.');
  if (typeof body.fullName !== 'string' || body.fullName.trim().length < 2 || body.fullName.trim().length > 100) {
    errors.push('fullName must be between 2 and 100 characters.');
  }
  if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) {
    errors.push('password must contain between 12 and 128 characters.');
  }
  if (includeRole && !ROLES.has(body.role)) errors.push('role must be one of: ' + [...ROLES].join(', ') + '.');
  return errors;
}

async function issueSession(admin) {
  const accessToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const tokenHash = hashToken(accessToken);
  if (isDatabaseConfigured()) {
    await queryDatabase(
      'INSERT INTO platform_admin_sessions (id,admin_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)',
      [randomUUID(), admin.id, tokenHash, expiresAt]
    );
  } else {
    memorySessions.set(tokenHash, {
      adminId: admin.id, expiresAt, revokedAt: null, lastSeenAt: new Date().toISOString()
    });
  }
  return { accessToken, tokenType: 'Bearer', expiresAt, admin: publicAdmin(admin) };
}

async function findAdminByEmail(email) {
  if (!isDatabaseConfigured()) {
    const id = memoryAdminsByEmail.get(email);
    return id ? memoryAdmins.get(id) || null : null;
  }
  const result = await queryDatabase(
    'SELECT id,email,full_name,password_hash,role,status,created_at,updated_at FROM platform_admins WHERE email=$1 LIMIT 1',
    [email]
  );
  return result?.rows[0] || null;
}

export async function authenticateAdminAccessToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const tokenHash = hashToken(token);
  if (!isDatabaseConfigured()) {
    const session = memorySessions.get(tokenHash);
    const admin = session ? memoryAdmins.get(session.adminId) : null;
    if (!session || !admin || session.revokedAt || Date.parse(session.expiresAt) <= Date.now() || admin.status !== 'active') return null;
    session.lastSeenAt = new Date().toISOString();
    return { tokenHash, expiresAt: session.expiresAt, admin: publicAdmin(admin) };
  }
  const result = await queryDatabase(
    "UPDATE platform_admin_sessions s SET last_seen_at=now() FROM platform_admins a WHERE s.admin_id=a.id AND s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND a.status='active' RETURNING a.id,a.email,a.full_name,a.role,a.status,a.created_at,a.updated_at,s.expires_at",
    [tokenHash]
  );
  const row = result?.rows[0];
  if (!row) return null;
  return {
    tokenHash,
    expiresAt: new Date(row.expires_at).toISOString(),
    admin: publicAdmin(row)
  };
}

function bearerToken(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  return match ? match[1] : null;
}

export async function handleAdminAuthApi(req, url, authenticated = null) {
  const path = url.pathname;

  if (path === '/api/v1/admin/auth/bootstrap') {
    if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'HTTP method is not supported for this route.', ['Allowed methods: POST.']);
    if (!validBootstrapSecret(req.headers['x-swiftserve-admin-bootstrap-key'])) {
      return fail(401, 'ADMIN_BOOTSTRAP_UNAUTHORIZED', 'A valid one-time bootstrap secret is required.');
    }
    if (!isDatabaseConfigured()) return fail(503, 'DATABASE_REQUIRED', 'Administrator setup requires PostgreSQL.');
    const body = await readJson(req);
    const errors = validateAdminCredentials(body, false);
    if (errors.length) return fail(422, 'VALIDATION_ERROR', 'Administrator bootstrap validation failed.', errors);
    const email = body.email.trim().toLowerCase();
    const passwordHash = await hashPassword(body.password);
    let admin = null;
    if (!isDatabaseConfigured() && process.env.NODE_ENV === 'production') {
      return fail(503, 'DATABASE_REQUIRED', 'Administrator setup requires PostgreSQL.');
    }
    const created = isDatabaseConfigured() ? await queryDatabase(
      `WITH guard AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(817264, 1)
       ),
       inserted AS (
         INSERT INTO platform_admins (email,full_name,password_hash,role,status)
         SELECT $1,$2,$3,'super_admin','active' FROM guard
         WHERE NOT EXISTS (SELECT 1 FROM platform_admins)
         RETURNING id,email,full_name,password_hash,role,status,created_at,updated_at
       )
       SELECT * FROM inserted`,
      [email, body.fullName.trim(), passwordHash]
    ) : null;
    if (isDatabaseConfigured()) {
      admin = created?.rows[0] || null;
    } else {
      if (memoryAdmins.size > 0) return fail(409, 'ADMIN_BOOTSTRAP_CLOSED', 'An administrator already exists. Bootstrap can only be used once.');
      admin = makeMemoryAdmin({ email, fullName: body.fullName.trim(), passwordHash });
      memoryAdmins.set(admin.id, admin);
      memoryAdminsByEmail.set(email, admin.id);
    }
    if (!admin) return fail(409, 'ADMIN_BOOTSTRAP_CLOSED', 'An administrator already exists. Bootstrap can only be used once.');
    const session = await issueSession(admin);
    await writeAdminAuditEvent({
      actorAdminId: admin.id,
      action: 'admin.bootstrap.completed',
      targetType: 'platform_admin',
      targetId: admin.id,
      details: { role: 'super_admin' }
    });
    return ok(session, 201);
  }

  if (path === '/api/v1/admin/auth/login') {
    if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'HTTP method is not supported for this route.', ['Allowed methods: POST.']);
    if (!isDatabaseConfigured()) return fail(503, 'DATABASE_REQUIRED', 'Administrator sign-in requires PostgreSQL.');
    const body = await readJson(req);
    const errors = isObject(body)
      ? Object.keys(body).filter(key => !['email', 'password'].includes(key)).map(key => 'Unknown field: ' + key + '.')
      : ['Request body must be a JSON object.'];
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email || email.length > 254 || !EMAIL.test(email)) errors.push('email must be a valid email address.');
    if (typeof body?.password !== 'string' || body.password.length < 1 || body.password.length > 128) {
      errors.push('password is required and must not exceed 128 characters.');
    }
    if (errors.length) return fail(422, 'VALIDATION_ERROR', 'Administrator sign-in validation failed.', errors);
    const admin = await findAdminByEmail(email);
    const valid = await verifyPassword(body.password, admin?.password_hash || DUMMY_PASSWORD_HASH);
    if (!admin || admin.status !== 'active' || !valid) {
      return fail(401, 'ADMIN_INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }
    return ok(await issueSession(admin));
  }

  if (path === '/api/v1/admin/auth/logout') {
    if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'HTTP method is not supported for this route.', ['Allowed methods: POST.']);
    if (!authenticated) return fail(401, 'ADMIN_UNAUTHORIZED', 'A valid administrator bearer token is required.');
    if (isDatabaseConfigured()) {
      await queryDatabase(
        'UPDATE platform_admin_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL',
        [authenticated.tokenHash]
      );
    } else {
      const session = memorySessions.get(authenticated.tokenHash);
      if (session) session.revokedAt = new Date().toISOString();
    }
    return ok({ loggedOut: true });
  }

  if (path === '/api/v1/admin/auth/me') {
    if (req.method !== 'GET') return fail(405, 'METHOD_NOT_ALLOWED', 'HTTP method is not supported for this route.', ['Allowed methods: GET.']);
    if (!authenticated) return fail(401, 'ADMIN_UNAUTHORIZED', 'A valid administrator bearer token is required.');
    return ok({ admin: authenticated.admin, expiresAt: authenticated.expiresAt });
  }

  return fail(404, 'NOT_FOUND', 'Administrator authentication route not found.');
}

export async function handleAdminAccountsApi(req, url, admin) {
  if (!admin || admin.role !== 'super_admin') {
    return fail(403, 'ADMIN_FORBIDDEN', 'Only a super administrator can manage platform administrator accounts.');
  }
  const path = url.pathname;

  if (path === '/api/v1/admin/admins') {
    if (req.method === 'GET') {
      if (!isDatabaseConfigured()) return ok([...memoryAdmins.values()].map(publicAdmin));
      const result = await queryDatabase(
        'SELECT id,email,full_name,role,status,created_at,updated_at FROM platform_admins ORDER BY created_at ASC'
      );
      return ok((result?.rows || []).map(publicAdmin));
    }
    if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'HTTP method is not supported for this route.', ['Allowed methods: GET, POST.']);
    const body = await readJson(req);
    const errors = validateAdminCredentials(body, true);
    if (errors.length) return fail(422, 'VALIDATION_ERROR', 'Administrator creation validation failed.', errors);
    try {
      const result = await queryDatabase(
        'INSERT INTO platform_admins (email,full_name,password_hash,role,status) VALUES ($1,$2,$3,$4,\'active\') RETURNING id,email,full_name,role,status,created_at,updated_at',
        [body.email.trim().toLowerCase(), body.fullName.trim(), await hashPassword(body.password), body.role]
      );
      const created = result?.rows[0];
      if (!created) return fail(503, 'DATABASE_REQUIRED', 'Administrator creation requires PostgreSQL.');
      await writeAdminAuditEvent({
        action: 'admin.account.created',
        targetType: 'platform_admin',
        targetId: created.id,
        details: { role: created.role }
      });
      return ok(publicAdmin(created), 201);
    } catch (error) {
      if (error?.code === '23505') return fail(409, 'ADMIN_EMAIL_EXISTS', 'An administrator account already uses this email address.');
      throw error;
    }
  }

  const match = path.match(/^\/api\/v1\/admin\/admins\/([^/]+)$/);
  if (match) {
    if (!UUID.test(match[1])) return fail(400, 'INVALID_ID', 'Administrator ID must be a valid UUID.');
    if (req.method !== 'PATCH') return fail(405, 'METHOD_NOT_ALLOWED', 'HTTP method is not supported for this route.', ['Allowed methods: PATCH.']);
    if (match[1] === admin.id) return fail(409, 'ADMIN_SELF_CHANGE_BLOCKED', 'An administrator cannot change their own role or status.');
    const body = await readJson(req);
    if (!isObject(body)) return fail(422, 'VALIDATION_ERROR', 'Administrator update validation failed.', ['Request body must be a JSON object.']);
    const errors = Object.keys(body).filter(key => !['role', 'status'].includes(key)).map(key => 'Unknown field: ' + key + '.');
    if (Object.keys(body).length === 0) errors.push('At least one field is required.');
    if (body.role !== undefined && !ROLES.has(body.role)) errors.push('role must be one of: ' + [...ROLES].join(', ') + '.');
    if (body.status !== undefined && !STATUSES.has(body.status)) errors.push('status must be one of: ' + [...STATUSES].join(', ') + '.');
    if (errors.length) return fail(422, 'VALIDATION_ERROR', 'Administrator update validation failed.', errors);

    const currentResult = isDatabaseConfigured() ? await queryDatabase(
      'SELECT id,email,full_name,role,status,created_at,updated_at FROM platform_admins WHERE id=$1',
      [match[1]]
    ) : null;
    const current = isDatabaseConfigured() ? currentResult?.rows[0] : memoryAdmins.get(match[1]);
    if (!current) return fail(404, 'ADMIN_NOT_FOUND', 'Administrator account was not found.');
    const willRemainSuper = (body.role ?? current.role) === 'super_admin' &&
      (body.status ?? current.status) === 'active';
    if (!willRemainSuper && current.role === 'super_admin' && current.status === 'active') {
      const count = isDatabaseConfigured()
        ? await queryDatabase(
          "SELECT COUNT(*)::int AS count FROM platform_admins WHERE role='super_admin' AND status='active' AND id<>$1",
          [match[1]]
        )
        : { rows: [[...memoryAdmins.values()].filter(item => item.id !== match[1] && item.role === 'super_admin' && item.status === 'active').length].map(count => ({ count })) };
      if (Number(count?.rows[0]?.count || 0) < 1) {
        return fail(409, 'LAST_SUPER_ADMIN', 'At least one active super administrator must remain.');
      }
    }
    let saved = null;
    if (isDatabaseConfigured()) {
      const updated = await queryDatabase(
        'UPDATE platform_admins SET role=COALESCE($2,role),status=COALESCE($3,status),updated_at=now() WHERE id=$1 RETURNING id,email,full_name,role,status,created_at,updated_at',
        [match[1], body.role ?? null, body.status ?? null]
      );
      saved = updated?.rows[0] || null;
    } else {
      Object.assign(current, { role: body.role ?? current.role, status: body.status ?? current.status, updated_at: new Date().toISOString() });
      saved = current;
    }
    if (!saved) return fail(404, 'ADMIN_NOT_FOUND', 'Administrator account was not found.');
    await writeAdminAuditEvent({
      action: 'admin.account.updated',
      targetType: 'platform_admin',
      targetId: saved.id,
      details: { role: saved.role, status: saved.status }
    });
    return ok(publicAdmin(saved));
  }

  return fail(404, 'NOT_FOUND', 'Administrator account route not found.');
}

export async function handleAdminAccountRoute(req, url, admin) {
  try {
    return await handleAdminAccountsApi(req, url, admin);
  } catch (error) {
    if (error?.code === 'INVALID_JSON') return fail(400, 'INVALID_JSON', error.message);
    if (error?.code === 'UNSUPPORTED_MEDIA_TYPE') return fail(415, 'UNSUPPORTED_MEDIA_TYPE', error.message);
    if (error?.code === 'BODY_TOO_LARGE') return fail(413, 'BODY_TOO_LARGE', error.message);
    if (error?.code === '23505') return fail(409, 'ADMIN_EMAIL_EXISTS', 'An administrator account already uses this email address.');
    throw error;
  }
}

export function getAdminActorId() {
  return getCurrentAdmin()?.id || null;
}
 + '0'.repeat(128);
const memoryAdmins = new Map();
const memoryAdminsByEmail = new Map();
const memorySessions = new Map();

function makeMemoryAdmin({ email, fullName, passwordHash, role = 'super_admin' }) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), email, full_name: fullName, password_hash: passwordHash,
    role, status: 'active', created_at: now, updated_at: now
  };
}

function response(status, body) {
  return { status, body };
}

function ok(data, status = 200) {
  return response(status, { data });
}

function fail(status, code, message, details = []) {
  return response(status, { error: { code, message, details } });
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function publicAdmin(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function validBootstrapSecret(supplied) {
  const expected = process.env.SWIFTSERVE_ADMIN_BOOTSTRAP_KEY || '';
  if (!expected || typeof supplied !== 'string') return false;
  const expectedHash = createHash('sha256').update(expected).digest();
  const suppliedHash = createHash('sha256').update(supplied).digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

async function readJson(req) {
  const contentType = req.headers['content-type'] || '';
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) {
    const error = new Error('Content-Type must be application/json.');
    error.code = 'UNSUPPORTED_MEDIA_TYPE';
    throw error;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1024 * 1024) {
      const error = new Error('Request body exceeds 1 MB.');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Malformed JSON body.');
    error.code = 'INVALID_JSON';
    throw error;
  }
}

function validateAdminCredentials(body, includeRole = false) {
  if (!isObject(body)) return ['Request body must be a JSON object.'];
  const allowed = includeRole
    ? ['email', 'fullName', 'password', 'role']
    : ['email', 'fullName', 'password'];
  const errors = Object.keys(body)
    .filter(key => !allowed.includes(key))
    .map(key => 'Unknown field: ' + key + '.');
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !EMAIL.test(email)) errors.push('email must be a valid email address.');
  if (typeof body.fullName !== 'string' || body.fullName.trim().length < 2 || body.fullName.trim().length > 100) {
    errors.push('fullName must be between 2 and 100 characters.');
  }
  if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) {
    errors.push('password must contain between 12 and 128 characters.');
  }
  if (includeRole && !ROLES.has(body.role)) errors.push('role must be one of: ' + [...ROLES].join(', ') + '.');
  return errors;
}

async function issueSession(admin) {
  const accessToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const tokenHash = hashToken(accessToken);
  await queryDatabase(
    'INSERT INTO platform_admin_sessions (id,admin_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)',
    [randomUUID(), admin.id, tokenHash, expiresAt]
  );
  return { accessToken, tokenType: 'Bearer', expiresAt, admin: publicAdmin(admin) };
}

async function findAdminByEmail(email) {
  const result = await queryDatabase(
    'SELECT id,email,full_name,password_hash,role,status,created_at,updated_at FROM platform_admins WHERE email=$1 LIMIT 1',
    [email]
  );
  return result?.rows[0] || null;
}

export async function authenticateAdminAccessToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  if (!isDatabaseConfigured()) return null;
  const tokenHash = hashToken(token);
  const result = await queryDatabase(
    "UPDATE platform_admin_sessions s SET last_seen_at=now() FROM platform_admins a WHERE s.admin_id=a.id AND s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND a.status='active' RETURNING a.id,a.email,a.full_name,a.role,a.status,a.created_at,a.updated_at,s.expires_at",
    [tokenHash]
  );
  const row = result?.rows[0];
  if (!row) return null;
  return {
    tokenHash,
    expiresAt: new Date(row.expires_at).toISOString(),
    admin: publicAdmin(row)
  };
}

function bearerToken(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  return match ? match[1] : null;
}

export async function handleAdminAuthApi(req, url, authenticated = null) {
  const path = url.pathname;

  if (path === '/api/v1/admin/auth/bootstrap') {
    if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'HTTP method is not supported for this route.', ['Allowed methods: POST.']);
    if (!validBootstrapSecret(req.headers['x-swiftserve-admin-bootstrap-key'])) {
      return fail(401, 'ADMIN_BOOTSTRAP_UNAUTHORIZED', 'A valid one-time bootstrap secret is required.');
    }
    if (!isDatabaseConfigured()) return fail(503, 'DATABASE_REQUIRED', 'Administrator setup requires PostgreSQL.');
    const body = await readJson(req);
    const errors = validateAdminCredentials(body, false);
    if (errors.length) return fail(422, 'VALIDATION_ERROR', 'Administrator bootstrap validation failed.', errors);
    const email = body.email.trim().toLowerCase();
    const passwordHash = await hashPassword(body.password);
    const created = await queryDatabase(
      `WITH guard AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(817264, 1)
       ),
       inserted AS (
         INSERT INTO platform_admins (email,full_name,password_hash,role,status)
         SELECT $1,$2,$3,'super_admin','active' FROM guard
         WHERE NOT EXISTS (SELECT 1 FROM platform_admins)
         RETURNING id,email,full_name,password_hash,role,status,created_at,updated_at
       )
       SELECT * FROM inserted`,
      [email, body.fullName.trim(), passwordHash]
    );
    const admin = created?.rows[0];
    if (!admin) return fail(409, 'ADMIN_BOOTSTRAP_CLOSED', 'An administrator already exists. Bootstrap can only be used once.');
    const session = await issueSession(admin);
    await writeAdminAuditEvent({
      actorAdminId: admin.id,
      action: 'admin.bootstrap.completed',
      targetType: 'platform_admin',
      targetId: admin.id,
      details: { role: 'super_admin' }
    });
    return ok(session, 201);
  }

  if (path === '/api/v1/admin/auth/login') {
    if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'HTTP method is not supported for this route.', ['Allowed methods: POST.']);
    if (!isDatabaseConfigured()) return fail(503, 'DATABASE_REQUIRED', 'Administrator sign-in requires PostgreSQL.');
    const body = await readJson(req);
    const errors = isObject(body)
      ? Object.keys(body).filter(key => !['email', 'password'].includes(key)).map(key => 'Unknown field: ' + key + '.')
      : ['Request body must be a JSON object.'];
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email || email.length > 254 || !EMAIL.test(email)) errors.push('email must be a valid email address.');
    if (typeof body?.password !== 'string' || body.password.length < 1 || body.password.length > 128) {
      errors.push('password is required and must not exceed 128 characters.');
    }
    if (errors.length) return fail(422, 'VALIDATION_ERROR', 'Administrator sign-in validation failed.', errors);
    const admin = await findAdminByEmail(email);
    const valid = await verifyPassword(body.password, admin?.password_hash || DUMMY_PASSWORD_HASH);
    if (!admin || admin.status !== 'active' || !valid) {
      return fail(401, 'ADMIN_INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }
    return ok(await issueSession(admin));
  }

  if (path === '/api/v1/admin/auth/logout') {
    if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'HTTP method is not supported for this route.', ['Allowed methods: POST.']);
    if (!authenticated) return fail(401, 'ADMIN_UNAUTHORIZED', 'A valid administrator bearer token is required.');
    await queryDatabase(
      'UPDATE platform_admin_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL',
      [authenticated.tokenHash]
    );
    return ok({ loggedOut: true });
  }

  if (path === '/api/v1/admin/auth/me') {
    if (req.method !== 'GET') return fail(405, 'METHOD_NOT_ALLOWED', 'HTTP method is not supported for this route.', ['Allowed methods: GET.']);
    if (!authenticated) return fail(401, 'ADMIN_UNAUTHORIZED', 'A valid administrator bearer token is required.');
    return ok({ admin: authenticated.admin, expiresAt: authenticated.expiresAt });
  }

  return fail(404, 'NOT_FOUND', 'Administrator authentication route not found.');
}

export async function handleAdminAccountsApi(req, url, admin) {
  if (!admin || admin.role !== 'super_admin') {
    return fail(403, 'ADMIN_FORBIDDEN', 'Only a super administrator can manage platform administrator accounts.');
  }
  const path = url.pathname;

  if (path === '/api/v1/admin/admins') {
    if (req.method === 'GET') {
      const result = await queryDatabase(
        'SELECT id,email,full_name,role,status,created_at,updated_at FROM platform_admins ORDER BY created_at ASC'
      );
      return ok((result?.rows || []).map(publicAdmin));
    }
    if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'HTTP method is not supported for this route.', ['Allowed methods: GET, POST.']);
    const body = await readJson(req);
    const errors = validateAdminCredentials(body, true);
    if (errors.length) return fail(422, 'VALIDATION_ERROR', 'Administrator creation validation failed.', errors);
    try {
      const result = await queryDatabase(
        'INSERT INTO platform_admins (email,full_name,password_hash,role,status) VALUES ($1,$2,$3,$4,\'active\') RETURNING id,email,full_name,role,status,created_at,updated_at',
        [body.email.trim().toLowerCase(), body.fullName.trim(), await hashPassword(body.password), body.role]
      );
      const created = result?.rows[0];
      if (!created) return fail(503, 'DATABASE_REQUIRED', 'Administrator creation requires PostgreSQL.');
      await writeAdminAuditEvent({
        action: 'admin.account.created',
        targetType: 'platform_admin',
        targetId: created.id,
        details: { role: created.role }
      });
      return ok(publicAdmin(created), 201);
    } catch (error) {
      if (error?.code === '23505') return fail(409, 'ADMIN_EMAIL_EXISTS', 'An administrator account already uses this email address.');
      throw error;
    }
  }

  const match = path.match(/^\/api\/v1\/admin\/admins\/([^/]+)$/);
  if (match) {
    if (!UUID.test(match[1])) return fail(400, 'INVALID_ID', 'Administrator ID must be a valid UUID.');
    if (req.method !== 'PATCH') return fail(405, 'METHOD_NOT_ALLOWED', 'HTTP method is not supported for this route.', ['Allowed methods: PATCH.']);
    if (match[1] === admin.id) return fail(409, 'ADMIN_SELF_CHANGE_BLOCKED', 'An administrator cannot change their own role or status.');
    const body = await readJson(req);
    if (!isObject(body)) return fail(422, 'VALIDATION_ERROR', 'Administrator update validation failed.', ['Request body must be a JSON object.']);
    const errors = Object.keys(body).filter(key => !['role', 'status'].includes(key)).map(key => 'Unknown field: ' + key + '.');
    if (Object.keys(body).length === 0) errors.push('At least one field is required.');
    if (body.role !== undefined && !ROLES.has(body.role)) errors.push('role must be one of: ' + [...ROLES].join(', ') + '.');
    if (body.status !== undefined && !STATUSES.has(body.status)) errors.push('status must be one of: ' + [...STATUSES].join(', ') + '.');
    if (errors.length) return fail(422, 'VALIDATION_ERROR', 'Administrator update validation failed.', errors);

    const currentResult = await queryDatabase(
      'SELECT id,email,full_name,role,status,created_at,updated_at FROM platform_admins WHERE id=$1',
      [match[1]]
    );
    const current = currentResult?.rows[0];
    if (!current) return fail(404, 'ADMIN_NOT_FOUND', 'Administrator account was not found.');
    const willRemainSuper = (body.role ?? current.role) === 'super_admin' &&
      (body.status ?? current.status) === 'active';
    if (!willRemainSuper && current.role === 'super_admin' && current.status === 'active') {
      const count = await queryDatabase(
        "SELECT COUNT(*)::int AS count FROM platform_admins WHERE role='super_admin' AND status='active' AND id<>$1",
        [match[1]]
      );
      if (Number(count?.rows[0]?.count || 0) < 1) {
        return fail(409, 'LAST_SUPER_ADMIN', 'At least one active super administrator must remain.');
      }
    }
    const updated = await queryDatabase(
      'UPDATE platform_admins SET role=COALESCE($2,role),status=COALESCE($3,status),updated_at=now() WHERE id=$1 RETURNING id,email,full_name,role,status,created_at,updated_at',
      [match[1], body.role ?? null, body.status ?? null]
    );
    const saved = updated?.rows[0];
    if (!saved) return fail(404, 'ADMIN_NOT_FOUND', 'Administrator account was not found.');
    await writeAdminAuditEvent({
      action: 'admin.account.updated',
      targetType: 'platform_admin',
      targetId: saved.id,
      details: { role: saved.role, status: saved.status }
    });
    return ok(publicAdmin(saved));
  }

  return fail(404, 'NOT_FOUND', 'Administrator account route not found.');
}

export async function handleAdminAccountRoute(req, url, admin) {
  try {
    return await handleAdminAccountsApi(req, url, admin);
  } catch (error) {
    if (error?.code === 'INVALID_JSON') return fail(400, 'INVALID_JSON', error.message);
    if (error?.code === 'UNSUPPORTED_MEDIA_TYPE') return fail(415, 'UNSUPPORTED_MEDIA_TYPE', error.message);
    if (error?.code === 'BODY_TOO_LARGE') return fail(413, 'BODY_TOO_LARGE', error.message);
    if (error?.code === '23505') return fail(409, 'ADMIN_EMAIL_EXISTS', 'An administrator account already uses this email address.');
    throw error;
  }
}

export function getAdminActorId() {
  return getCurrentAdmin()?.id || null;
}
