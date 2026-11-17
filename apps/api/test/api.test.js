import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Always use isolated in-memory storage, even when a developer has DATABASE_URL in .env.
process.env.NODE_ENV = 'test';
const { requestHandler, resetStore } = await import('../src/app.js');

function startTestServer() {
  return new Promise(resolve => {
    const server = http.createServer(requestHandler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function stopTestServer(server) {
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function request(base, path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null
  };
}

function validJob(overrides = {}) {
  return {
    service: 'electrical',
    description: 'Ceiling light needs repair',
    area: 'Tanke, Ilorin',
    ...overrides
  };
}

test.beforeEach(() => resetStore());

test('POST creates a service request', async () => {
  const server = await startTestServer();
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const response = await request(base, '/api/v1/jobs', {
      method: 'POST',
      body: JSON.stringify(validJob())
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.service, 'electrical');
    assert.equal(response.body.data.status, 'pending');
    assert.ok(response.body.data.id);
  } finally {
    await stopTestServer(server);
  }
});

test('GET lists and retrieves service requests', async () => {
  const server = await startTestServer();
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const created = await request(base, '/api/v1/jobs', {
      method: 'POST',
      body: JSON.stringify(validJob({ service: 'plumbing', area: 'GRA, Ilorin' }))
    });
    const list = await request(base, '/api/v1/jobs');
    const item = await request(base, '/api/v1/jobs/' + created.body.data.id);

    assert.equal(list.status, 200);
    assert.equal(list.body.count, 1);
    assert.equal(item.status, 200);
    assert.equal(item.body.data.id, created.body.data.id);
  } finally {
    await stopTestServer(server);
  }
});

test('PATCH updates and DELETE removes a request', async () => {
  const server = await startTestServer();
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const created = await request(base, '/api/v1/jobs', {
      method: 'POST',
      body: JSON.stringify(validJob({ service: 'laundry', description: 'Weekly clothes washing service', area: 'Fate, Ilorin' }))
    });
    const id = created.body.data.id;
    const updated = await request(base, '/api/v1/jobs/' + id, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'accepted' })
    });

    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.status, 'accepted');
    assert.equal((await request(base, '/api/v1/jobs/' + id, { method: 'DELETE' })).status, 204);
    assert.equal((await request(base, '/api/v1/jobs/' + id)).status, 404);
  } finally {
    await stopTestServer(server);
  }
});

test('invalid create input returns a validation error', async () => {
  const server = await startTestServer();
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const response = await request(base, '/api/v1/jobs', {
      method: 'POST',
      body: JSON.stringify({ service: 'rocket-launch', description: 'x', area: '' })
    });

    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  } finally {
    await stopTestServer(server);
  }
});

test('malformed JSON returns 400', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/v1/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json'
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'INVALID_JSON');
  } finally {
    await stopTestServer(server);
  }
});

test('unsupported method returns 405 and Allow header', async () => {
  const server = await startTestServer();
  try {
    const response = await request('http://127.0.0.1:' + server.address().port, '/api/v1/jobs', {
      method: 'PUT',
      body: JSON.stringify({})
    });

    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, POST');
  } finally {
    await stopTestServer(server);
  }
});

test('health is a liveness check and includes security headers', async () => {
  const server = await startTestServer();
  try {
    const response = await request('http://127.0.0.1:' + server.address().port, '/health');

    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'ok');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally {
    await stopTestServer(server);
  }
});

test('readiness reports development memory storage explicitly', async () => {
  const server = await startTestServer();
  try {
    const response = await request('http://127.0.0.1:' + server.address().port, '/readyz');

    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'ready');
    assert.equal(response.body.storage, 'memory');
    assert.equal(response.body.database, 'not_configured');
  } finally {
    await stopTestServer(server);
  }
});

test('invalid UUIDs return 400 instead of reaching the database', async () => {
  const server = await startTestServer();
  try {
    const response = await request('http://127.0.0.1:' + server.address().port, '/api/v1/jobs/not-a-uuid');

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INVALID_ID');
  } finally {
    await stopTestServer(server);
  }
});

test('write requests require an application/json content type', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/v1/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(validJob())
    });
    const body = await response.json();

    assert.equal(response.status, 415);
    assert.equal(body.error.code, 'UNSUPPORTED_MEDIA_TYPE');
  } finally {
    await stopTestServer(server);
  }
});

test('request bodies larger than 1 MB return 413', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/v1/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'x'.repeat(1024 * 1024 + 1)
    });
    const body = await response.json();

    assert.equal(response.status, 413);
    assert.equal(body.error.code, 'BODY_TOO_LARGE');
  } finally {
    await stopTestServer(server);
  }
});

test('job status transitions follow the supported lifecycle', async () => {
  const server = await startTestServer();
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const created = await request(base, '/api/v1/jobs', {
      method: 'POST',
      body: JSON.stringify(validJob())
    });
    const id = created.body.data.id;

    const skip = await request(base, '/api/v1/jobs/' + id, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' })
    });
    assert.equal(skip.status, 409);
    assert.equal(skip.body.error.code, 'INVALID_STATUS_TRANSITION');

    const accepted = await request(base, '/api/v1/jobs/' + id, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'accepted' })
    });
    assert.equal(accepted.status, 200);

    const completed = await request(base, '/api/v1/jobs/' + id, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' })
    });
    assert.equal(completed.status, 200);

    const reopen = await request(base, '/api/v1/jobs/' + id, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'pending' })
    });
    assert.equal(reopen.status, 409);
  } finally {
    await stopTestServer(server);
  }
});

test('empty patches and unknown patch fields are rejected', async () => {
  const server = await startTestServer();
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const created = await request(base, '/api/v1/jobs', {
      method: 'POST',
      body: JSON.stringify(validJob())
    });
    const id = created.body.data.id;

    const empty = await request(base, '/api/v1/jobs/' + id, {
      method: 'PATCH',
      body: JSON.stringify({})
    });
    const unknown = await request(base, '/api/v1/jobs/' + id, {
      method: 'PATCH',
      body: JSON.stringify({ businessId: 'another-business' })
    });

    assert.equal(empty.status, 422);
    assert.equal(unknown.status, 422);
    assert.equal(unknown.body.error.code, 'VALIDATION_ERROR');
  } finally {
    await stopTestServer(server);
  }
});

test('invalid status filters return 400', async () => {
  const server = await startTestServer();
  try {
    const response = await request('http://127.0.0.1:' + server.address().port, '/api/v1/jobs?status=unknown');

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INVALID_QUERY');
  } finally {
    await stopTestServer(server);
  }
});
