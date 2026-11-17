import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL?.trim();

const pool = databaseUrl
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

if (!pool && process.env.NODE_ENV === 'production') {
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

const memoryStore = new Map();

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    service: row.service,
    description: row.description,
    area: row.area,
    status: row.status,
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
  return { configured: true, connected: true };
}

export async function listJobs(status) {
  if (!pool) {
    return [...memoryStore.values()].filter(job => !status || job.status === status);
  }

  const result = status
    ? await pool.query(
        'SELECT * FROM service_requests WHERE status = $1 ORDER BY created_at DESC',
        [status]
      )
    : await pool.query('SELECT * FROM service_requests ORDER BY created_at DESC');

  return result.rows.map(fromRow);
}

export async function getJob(id) {
  if (!pool) return memoryStore.get(id) ?? null;
  const result = await pool.query('SELECT * FROM service_requests WHERE id = $1', [id]);
  return fromRow(result.rows[0]);
}

export async function createJob(job) {
  if (!pool) {
    memoryStore.set(job.id, job);
    return job;
  }

  const result = await pool.query(
    'INSERT INTO service_requests (service, description, area, status) VALUES ($1, $2, $3, $4) RETURNING *',
    [job.service, job.description, job.area, job.status]
  );
  return fromRow(result.rows[0]);
}

export async function updateJob(id, patch, expectedStatus = null) {
  if (!pool) {
    const current = memoryStore.get(id);
    if (!current || (expectedStatus && current.status !== expectedStatus)) return null;

    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    memoryStore.set(id, updated);
    return updated;
  }

  const current = await getJob(id);
  if (!current) return null;

  const updated = {
    service: patch.service ?? current.service,
    description: patch.description ?? current.description,
    area: patch.area ?? current.area,
    status: patch.status ?? current.status
  };

  const result = await pool.query(
    'UPDATE service_requests SET service=$1, description=$2, area=$3, status=$4, updated_at=now() WHERE id=$5 AND ($6::text IS NULL OR status=$6) RETURNING *',
    [updated.service, updated.description, updated.area, updated.status, id, expectedStatus]
  );

  return fromRow(result.rows[0]);
}

export async function deleteJob(id) {
  if (!pool) return memoryStore.delete(id);
  const result = await pool.query('DELETE FROM service_requests WHERE id = $1', [id]);
  return result.rowCount > 0;
}

export function resetStore() {
  memoryStore.clear();
}

export async function closeDatabase() {
  if (pool) await pool.end();
}
