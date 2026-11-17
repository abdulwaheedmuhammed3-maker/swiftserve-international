import { randomUUID } from 'node:crypto';
import {
  checkDatabase,
  createJob,
  deleteJob,
  getJob,
  listJobs,
  resetStore,
  updateJob
} from './repository.js';

const ALLOWED_SERVICES = new Set([
  'cleaning', 'laundry', 'electrical', 'plumbing',
  'ac-repair', 'appliance-repair', 'errand'
]);
const ALLOWED_STATUSES = new Set(['pending', 'accepted', 'completed', 'cancelled']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 1024 * 1024;
const STATUS_TRANSITIONS = {
  pending: new Set(['accepted', 'cancelled']),
  accepted: new Set(['completed', 'cancelled']),
  completed: new Set(),
  cancelled: new Set()
};

export { resetStore };

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
}

function json(res, statusCode, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

function errorResponse(code, message, details = []) {
  return { error: { code, message, details } };
}

function logSafeError(event, error) {
  console.error(JSON.stringify({
    event,
    code: typeof error?.code === 'string' ? error.code : 'NO_CODE',
    name: typeof error?.name === 'string' ? error.name : 'UNKNOWN_ERROR'
  }));
}

async function readJsonBody(req) {
  const contentType = req.headers['content-type'] || '';
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) {
    const err = new Error('Content-Type must be application/json.');
    err.code = 'UNSUPPORTED_MEDIA_TYPE';
    throw err;
  }

  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    req.resume();
    const err = new Error('Request body exceeds 1 MB.');
    err.code = 'BODY_TOO_LARGE';
    throw err;
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) {
      const err = new Error('Request body exceeds 1 MB.');
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};

  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('Malformed JSON body.');
    err.code = 'INVALID_JSON';
    throw err;
  }
}

function validateCreate(body) {
  const details = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['Request body must be a JSON object.'];
  }
  if (typeof body.service !== 'string' || !ALLOWED_SERVICES.has(body.service)) {
    details.push('service must be one of: ' + [...ALLOWED_SERVICES].join(', ') + '.');
  }
  if (typeof body.description !== 'string' || body.description.trim().length < 10 || body.description.trim().length > 500) {
    details.push('description must be a string between 10 and 500 characters.');
  }
  if (typeof body.area !== 'string' || body.area.trim().length < 2 || body.area.trim().length > 80) {
    details.push('area must be a string between 2 and 80 characters.');
  }
  return details;
}

function validatePatch(body) {
  const details = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['Request body must be a JSON object.'];
  }
  if (Object.keys(body).length === 0) details.push('At least one field is required.');

  const allowed = new Set(['service', 'description', 'area', 'status']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) details.push('Unknown field: ' + key + '.');
  }
  if ('service' in body && (typeof body.service !== 'string' || !ALLOWED_SERVICES.has(body.service))) {
    details.push('service must be one of: ' + [...ALLOWED_SERVICES].join(', ') + '.');
  }
  if ('description' in body && (typeof body.description !== 'string' || body.description.trim().length < 10 || body.description.trim().length > 500)) {
    details.push('description must be a string between 10 and 500 characters.');
  }
  if ('area' in body && (typeof body.area !== 'string' || body.area.trim().length < 2 || body.area.trim().length > 80)) {
    details.push('area must be a string between 2 and 80 characters.');
  }
  if ('status' in body && (typeof body.status !== 'string' || !ALLOWED_STATUSES.has(body.status))) {
    details.push('status must be one of: ' + [...ALLOWED_STATUSES].join(', ') + '.');
  }
  return details;
}

function parseRoute(urlPath) {
  const match = urlPath.match(/^\/api\/v1\/jobs(?:\/([^/]+))?$/);
  return match ? match[1] ?? null : undefined;
}

function isAllowedStatusTransition(currentStatus, nextStatus) {
  return currentStatus === nextStatus ||
    Boolean(STATUS_TRANSITIONS[currentStatus]?.has(nextStatus));
}

export async function requestHandler(req, res) {
  applySecurityHeaders(res);
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health') {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return json(res, 405, errorResponse('METHOD_NOT_ALLOWED', 'HTTP method is not supported for this route.'));
    }
    return json(res, 200, { status: 'ok' });
  }

  if (url.pathname === '/readyz') {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return json(res, 405, errorResponse('METHOD_NOT_ALLOWED', 'HTTP method is not supported for this route.'));
    }
    try {
      const database = await checkDatabase();
      if (!database.connected && process.env.NODE_ENV === 'production') {
        return json(res, 503, { status: 'not_ready', database: 'not_configured' });
      }
      return json(res, 200, {
        status: 'ready',
        database: database.connected ? 'connected' : 'not_configured',
        storage: database.connected ? 'postgresql' : 'memory'
      });
    } catch (error) {
      logSafeError('readiness_check_failed', error);
      return json(res, 503, { status: 'not_ready', database: 'unreachable' });
    }
  }

  const id = parseRoute(url.pathname);
  if (id === undefined) {
    return json(res, 404, errorResponse('NOT_FOUND', 'Route not found.'));
  }

  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', id === null ? 'GET, POST' : 'GET, PATCH, DELETE');
    return json(res, 405, errorResponse('METHOD_NOT_ALLOWED', 'HTTP method is not supported for this route.'));
  }

  if (id !== null && !UUID_PATTERN.test(id)) {
    return json(res, 400, errorResponse('INVALID_ID', 'The service request ID must be a valid UUID.'));
  }

  try {
    if (req.method === 'GET' && id === null) {
      const status = url.searchParams.get('status');
      if (status && !ALLOWED_STATUSES.has(status)) {
        return json(res, 400, errorResponse('INVALID_QUERY', 'Invalid status filter.', [
          'status must be one of: ' + [...ALLOWED_STATUSES].join(', ') + '.'
        ]));
      }
      const items = await listJobs(status);
      return json(res, 200, { data: items, count: items.length });
    }

    if (req.method === 'POST' && id === null) {
      const body = await readJsonBody(req);
      const details = validateCreate(body);
      if (details.length) {
        return json(res, 422, errorResponse('VALIDATION_ERROR', 'Request validation failed.', details));
      }

      const now = new Date().toISOString();
      const job = {
        id: randomUUID(),
        service: body.service,
        description: body.description.trim(),
        area: body.area.trim(),
        status: 'pending',
        createdAt: now,
        updatedAt: now
      };
      return json(res, 201, { data: await createJob(job) });
    }

    const current = await getJob(id);
    if (!current) {
      return json(res, 404, errorResponse('JOB_NOT_FOUND', 'No service request exists with that ID.'));
    }

    if (req.method === 'GET') return json(res, 200, { data: current });

    if (req.method === 'PATCH') {
      const body = await readJsonBody(req);
      const details = validatePatch(body);
      if (details.length) {
        return json(res, 422, errorResponse('VALIDATION_ERROR', 'Request validation failed.', details));
      }

      if (typeof body.status === 'string' &&
          !isAllowedStatusTransition(current.status, body.status)) {
        return json(res, 409, errorResponse(
          'INVALID_STATUS_TRANSITION',
          'This service request cannot move from ' + current.status + ' to ' + body.status + '.'
        ));
      }

      const patch = {
        ...body,
        ...(typeof body.description === 'string' ? { description: body.description.trim() } : {}),
        ...(typeof body.area === 'string' ? { area: body.area.trim() } : {})
      };
      const updated = await updateJob(id, patch, current.status);
      if (!updated) {
        const latest = await getJob(id);
        if (!latest) {
          return json(res, 404, errorResponse('JOB_NOT_FOUND', 'The service request no longer exists.'));
        }
        return json(res, 409, errorResponse(
          'CONCURRENT_MODIFICATION',
          'The service request changed while you were updating it. Reload and try again.'
        ));
      }
      return json(res, 200, { data: updated });
    }

    if (req.method === 'DELETE') {
      const deleted = await deleteJob(id);
      if (!deleted) {
        return json(res, 404, errorResponse('JOB_NOT_FOUND', 'The service request no longer exists.'));
      }
      res.statusCode = 204;
      return res.end();
    }
  } catch (error) {
    if (error?.code === 'INVALID_JSON') {
      return json(res, 400, errorResponse('INVALID_JSON', error.message));
    }
    if (error?.code === 'UNSUPPORTED_MEDIA_TYPE') {
      return json(res, 415, errorResponse('UNSUPPORTED_MEDIA_TYPE', error.message));
    }
    if (error?.code === 'BODY_TOO_LARGE') {
      return json(res, 413, errorResponse('BODY_TOO_LARGE', error.message));
    }
    logSafeError('request_failed', error);
    return json(res, 500, errorResponse('INTERNAL_ERROR', 'An unexpected server error occurred.'));
  }
}
