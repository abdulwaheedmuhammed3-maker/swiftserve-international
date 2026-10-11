import { randomUUID } from 'node:crypto';
import { checkDatabase, createJob, deleteJob, getJob, listJobs, resetStore, updateJob } from './repository.js';

const ALLOWED_SERVICES = new Set([
  'cleaning', 'laundry', 'electrical', 'plumbing',
  'ac-repair', 'appliance-repair', 'errand'
]);
const ALLOWED_STATUSES = new Set(['pending', 'accepted', 'completed', 'cancelled']);

export { resetStore };

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

async function readJsonBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1024 * 1024) {
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
    details.push(`service must be one of: ${[...ALLOWED_SERVICES].join(', ')}.`);
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
    if (!allowed.has(key)) details.push(`Unknown field: ${key}.`);
  }
  if ('service' in body && (typeof body.service !== 'string' || !ALLOWED_SERVICES.has(body.service))) {
    details.push(`service must be one of: ${[...ALLOWED_SERVICES].join(', ')}.`);
  }
  if ('description' in body && (typeof body.description !== 'string' || body.description.trim().length < 10 || body.description.trim().length > 500)) {
    details.push('description must be a string between 10 and 500 characters.');
  }
  if ('area' in body && (typeof body.area !== 'string' || body.area.trim().length < 2 || body.area.trim().length > 80)) {
    details.push('area must be a string between 2 and 80 characters.');
  }
  if ('status' in body && (typeof body.status !== 'string' || !ALLOWED_STATUSES.has(body.status))) {
    details.push(`status must be one of: ${[...ALLOWED_STATUSES].join(', ')}.`);
  }
  return details;
}

function parseRoute(urlPath) {
  const match = urlPath.match(/^\\/api\\/v1\\/jobs(?:\\/([^/]+))?$/);
  return match ? match[1] ?? null : undefined;
}

export async function requestHandler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health' && req.method === 'GET') {
    try {
      const database = await checkDatabase();
      return json(res, 200, {
        status: 'ok',
        database: database.connected ? 'connected' : 'not_configured'
      });
    } catch (err) {
      // Log only a safe error identifier. Do not log connection strings or raw driver messages.
      console.error('Database health check failed:', err?.code ?? err?.name ?? 'UNKNOWN_DATABASE_ERROR');
      return json(res, 200, { status: 'ok', database: 'unreachable' });
    }
  }

  const id = parseRoute(url.pathname);
  if (id === undefined) return json(res, 404, errorResponse('NOT_FOUND', 'Route not found.'));
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', id === null ? 'GET, POST' : 'GET, PATCH, DELETE');
    return json(res, 405, errorResponse('METHOD_NOT_ALLOWED', 'HTTP method is not supported for this route.'));
  }

  try {
    if (req.method === 'GET' && id === null) {
      const status = url.searchParams.get('status');
      if (status && !ALLOWED_STATUSES.has(status)) {
        return json(res, 400, errorResponse('INVALID_QUERY', 'Invalid status filter.', [
          `status must be one of: ${[...ALLOWED_STATUSES].join(', ')}.`
        ]));
      }
      const items = await listJobs(status);
      return json(res, 200, { data: items, count: items.length });
    }

    if (req.method === 'POST' && id === null) {
      const body = await readJsonBody(req);
      const details = validateCreate(body);
      if (details.length) return json(res, 422, errorResponse('VALIDATION_ERROR', 'Request validation failed.', details));
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
    if (!current) return json(res, 404, errorResponse('JOB_NOT_FOUND', `No service request exists with id '${id}'.`));
    if (req.method === 'GET') return json(res, 200, { data: current });

    if (req.method === 'PATCH') {
      const body = await readJsonBody(req);
      const details = validatePatch(body);
      if (details.length) return json(res, 422, errorResponse('VALIDATION_ERROR', 'Request validation failed.', details));
      const patch = {
        ...body,
        ...(typeof body.description === 'string' ? { description: body.description.trim() } : {}),
        ...(typeof body.area === 'string' ? { area: body.area.trim() } : {})
      };
      return json(res, 200, { data: await updateJob(id, patch) });
    }

    if (req.method === 'DELETE') {
      await deleteJob(id);
      res.statusCode = 204;
      return res.end();
    }
  } catch (err) {
    if (err?.code === 'INVALID_JSON') return json(res, 400, errorResponse('INVALID_JSON', err.message));
    if (err?.code === 'BODY_TOO_LARGE') return json(res, 413, errorResponse('BODY_TOO_LARGE', err.message));
    console.error('Request failed:', err?.message);
    return json(res, 500, errorResponse('INTERNAL_ERROR', 'An unexpected server error occurred.'));
  }
}
