import pg from 'pg';

const { Pool } = pg;
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 8000,
      max: 5
    })
  : null;

if (!pool && process.env.NODE_ENV === 'production') {
  throw new Error('DATABASE_URL is required in production. Refusing to start with volatile in-memory storage.');
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
    const items = [...memoryStore.values()].filter(job => !status || job.status === status);
    return items;
  }
  const result = status
    ? await pool.query('SELECT * FROM service_requests WHERE status = $1 ORDER BY created_at DESC', [status])
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

export async function updateJob(id, patch) {
  if (!pool) {
    const current = memoryStore.get(id);
    if (!current) return null;
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
    'UPDATE service_requests SET service=$1, description=$2, area=$3, status=$4, updated_at=now() WHERE id=$5 RETURNING *',
    [updated.service, updated.description, updated.area, updated.status, id]
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
