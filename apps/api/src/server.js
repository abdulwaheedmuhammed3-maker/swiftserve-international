import http from 'node:http';
import {
  checkDatabase,
  closeDatabase,
  isDatabaseConfigured
} from './repository.js';
import { requestHandler } from './app.js';

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

if (isDatabaseConfigured()) {
  try {
    await checkDatabase();
    console.info(JSON.stringify({ event: 'database_connected' }));
  } catch (error) {
    console.error(JSON.stringify({
      event: 'database_startup_check_failed',
      code: typeof error?.code === 'string' ? error.code : 'NO_CODE',
      name: typeof error?.name === 'string' ? error.name : 'UNKNOWN_ERROR'
    }));
    await closeDatabase().catch(() => {});
    process.exit(1);
  }
} else {
  console.warn(JSON.stringify({
    event: 'development_memory_storage',
    message: 'DATABASE_URL is not configured; data will not persist across restarts.'
  }));
}

const server = http.createServer(requestHandler);
server.requestTimeout = 30000;
server.headersTimeout = 35000;
server.keepAliveTimeout = 5000;

server.on('error', error => {
  console.error(JSON.stringify({
    event: 'http_server_error',
    code: typeof error?.code === 'string' ? error.code : 'NO_CODE',
    name: typeof error?.name === 'string' ? error.name : 'UNKNOWN_ERROR'
  }));
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.info(JSON.stringify({ event: 'server_listening', host, port }));
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.info(JSON.stringify({ event: 'server_shutdown_started', signal }));
  server.close(async error => {
    if (error) {
      console.error(JSON.stringify({
        event: 'server_shutdown_error',
        code: typeof error.code === 'string' ? error.code : 'NO_CODE'
      }));
      process.exitCode = 1;
    }
    try {
      await closeDatabase();
    } catch (databaseError) {
      console.error(JSON.stringify({
        event: 'database_shutdown_error',
        code: typeof databaseError?.code === 'string' ? databaseError.code : 'NO_CODE',
        name: typeof databaseError?.name === 'string' ? databaseError.name : 'UNKNOWN_ERROR'
      }));
      process.exitCode = 1;
    }
  });
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
