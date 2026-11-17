import './config.js';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL?.trim();

if (!connectionString) {
  throw new Error('DATABASE_URL is required to run database migrations.');
}

const pool = new Pool({
  connectionString,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 10000,
  max: 1,
  application_name: 'swiftserve-migrations'
});

const migrationsDirectory = fileURLToPath(new URL('../db/migrations/', import.meta.url));

async function run() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
  );

  const files = readdirSync(migrationsDirectory)
    .filter(file => /^\d{3}_[a-z0-9_]+\.sql$/i.test(file))
    .sort();

  if (files.length === 0) {
    throw new Error('No SQL migration files were found.');
  }

  for (const file of files) {
    const sql = readFileSync(migrationsDirectory + file, 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await pool.query(
      'SELECT checksum FROM schema_migrations WHERE version = $1',
      [file]
    );

    if (existing.rows.length > 0) {
      if (existing.rows[0].checksum.trim() !== checksum) {
        throw new Error('Applied migration was modified: ' + file + '. Create a new migration instead.');
      }
      console.info(JSON.stringify({ event: 'migration_already_applied', version: file }));
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
        [file, checksum]
      );
      await client.query('COMMIT');
      console.info(JSON.stringify({ event: 'migration_applied', version: file }));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(JSON.stringify({
        event: 'migration_failed',
        version: file,
        code: typeof error?.code === 'string' ? error.code : 'NO_CODE',
        name: typeof error?.name === 'string' ? error.name : 'UNKNOWN_ERROR'
      }));
      throw error;
    } finally {
      client.release();
    }
  }
}

try {
  await run();
} finally {
  await pool.end();
}
