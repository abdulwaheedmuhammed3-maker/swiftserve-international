import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Tests always use isolated in-memory repositories, regardless of local .env settings.
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

async function registerBusiness(base, email = 'owner@example.com', businessName = 'Test Home Services') {
  const response = await request(base, '/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password: 'StrongPass#12345',
      fullName: 'Test Business Owner',
      accountType: 'business',
      businessName,
      countryCode: 'NG'
    })
  });
  assert.equal(response.status, 201);
  const data = response.body.data;
  return {
    accessToken: data.accessToken,
    businessId: data.businesses[0].id,
    user: data.user,
    headers: {
      Authorization: 'Bearer ' + data.accessToken,
      'X-SwiftServe-Business-Id': data.businesses[0].id
    }
  };
}

test.beforeEach(() => resetStore());

test('business registration creates an owner membership and returns a bearer session', async () => {
  const server = await startTestServer();
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const response = await request(base, '/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: 'OWNER@EXAMPLE.COM',
        password: 'StrongPass#12345',
        fullName: 'Bright Owner',
        accountType: 'business',
        businessName: 'SwiftServe Test Business',
        countryCode: 'NG'
      })
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.user.email, 'owner@example.com');
    assert.equal(response.body.data.user.accountType, 'business');
    assert.equal(response.body.data.businesses.length, 1);
    assert.equal(response.body.data.businesses[0].role, 'owner');
    assert.equal(response.body.data.tokenType, 'Bearer');
    assert.equal(response.body.data.accessToken.length, 43);
    assert.equal('passwordHash' in response.body.data.user, false);
  } finally {
    await stopTestServer(server);
  }
});

test('login returns a new session and logout revokes it', async () => {
  const server = await startTestServer();
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    await registerBusiness(base);

    const login = await request(base, '/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'OWNER@example.com', password: 'StrongPass#12345' })
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.data.user.email, 'owner@example.com');

    const headers = { Authorization: 'Bearer ' + login.body.data.accessToken };
    const profile = await request(base, '/api/v1/auth/me', { headers });
    assert.equal(profile.status, 200);
    assert.equal(profile.body.data.businesses.length, 1);

    const logout = await request(base, '/api/v1/auth/logout', { method: 'POST', headers });
    assert.equal(logout.status, 200);
    assert.equal(logout.body.data.loggedOut, true);

    const afterLogout = await request(base, '/api/v1/auth/me', { headers });
    assert.equal(afterLogout.status, 401);
  } finally {
    await stopTestServer(server);
  }
});

test('duplicate email registration is rejected case-insensitively', async () => {
  const server = await startTestServer();
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    await registerBusiness(base, 'owner@example.com');

    const duplicate = await request(base, '/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: 'OWNER@example.com',
        password: 'AnotherPass#12345',
        fullName: 'Another Owner',
        accountType: 'business',
        businessName: 'Another Business'
      })
    });

    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'EMAIL_ALREADY_REGISTERED');
  } finally {
    await stopTestServer(server);
  }
});

test('invalid registration fields are rejected', async () => {
  const server = await startTestServer();
  try {
    const response = await request('http://127.0.0.1:' + server.address().port, '/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: 'not-an-email',
        password: 'weak',
        fullName: 'A',
        accountType: 'admin'
      })
    });

    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  } finally {
    await stopTestServer(server);
  }
});

test('incorrect login credentials return a generic authentication error', async () => {
  const server = await startTestServer();
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    await registerBusiness(base);

    const response = await request(base, '/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'owner@example.com', password: 'WrongPassword#123' })
    });

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'INVALID_CREDENTIALS');
    assert.equal(response.body.error.message, 'Email or password is incorrect.');
  } finally {
    await stopTestServer(server);
  }
});

test('business job endpoints require authentication', async () => {
  const server = await startTestServer();
  try {
    const response = await request('http://127.0.0.1:' + server.address().port, '/api/v1/jobs');

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'UNAUTHENTICATED');
  } finally {
    await stopTestServer(server);
  }
});

test('business job endpoints require an explicit business context', async () => {
  const server = await startTestServer();
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const account = await registerBusiness(base);
    const response = await request(base, '/api/v1/jobs', {
      headers: { Authorization: 'Bearer ' + account.accessToken }
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BUSINESS_CONTEXT_REQUIRED');
  } finally {
    await stopTestServer(server);
  }
});

test('POST creates a request scoped to the authenticated business', async () => {
  const server = await startTestServer();
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const account = await registerBusiness(base);
    const response = await request(base, '/api/v1/jobs', {
      method: 'POST',
      headers: account.headers,
      body: JSON.stringify(validJob())
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.data.service, 'electrical');
    assert.equal(response.body.data.status, 'pending');
    assert.equal(response.body.data.businessId, account.businessId);
    assert.equal(response.body.data.createdByUserId, account.user.id);
  } finally {
    await stopTestServer(server);
  }
});

test('GET lists and retrieves only the selected business requests', async () => {
  const server = await startTestServer();
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const account = await registerBusiness(base);
    const created = await request(base, '/api/v1/jobs', {
      method: 'POST',
      headers: account.headers,
      body: JSON.stringify(validJob({ service: 'plumbing', area: 'GRA, Ilorin' }))
    });
    const list = await request(base, '/api/v1/jobs', { headers: account.headers });
    const item = await request(base, '/api/v1/jobs/' + created.body.data.id, { headers: account.headers });

    assert.equal(list.status, 200);
    assert.equal(list.body.count, 1);
    assert.equal(item.status, 200);
    assert.equal(item.body.data.id, created.body.data.id);
    assert.equal(item.body.data.businessId, account.businessId);
  } finally {
    await stopTestServer(server);
  }
});

test('a business cannot read or change another business requests', async () => {
  const server = await startTestServer();
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const first = await registerBusiness(base, 'first@example.com', 'First Business');
    const second = await registerBusiness(base, 'second@example.com', 'Second Business');
    const created = await request(base, '/api/v1/jobs', {
      method: 'POST',
      headers: first.headers,
      body: JSON.stringify(validJob())
    });
    const jobId = created.body.data.id;

    const secondList = await request(base, '/api/v1/jobs', { headers: second.headers });
    const secondRead = await request(base, '/api/v1/jobs/' + jobId, { headers: second.headers });
    const secondUpdate = await request(base, '/api/v1/jobs/' + jobId, {
      method: 'PATCH',
      headers: second.headers,
      body: JSON.stringify({ area: 'Another place' })
    });
    const secondDelete = await request(base, '/api/v1/jobs/' + jobId, {
      method: 'DELETE',
      headers: second.headers
    });

    assert.equal(secondList.status, 200);
    assert.equal(secondList.body.count, 0);
    assert.equal(secondRead.status, 404);
    assert.equal(secondUpdate.status, 404);
    assert.equal(secondDelete.status, 404);

    const firstRead = await request(base, '/api/v1/jobs/' + jobId, { headers: first.headers });
    assert.equal(firstRead.status, 200);
    assert.equal(firstRead.body.data.area, 'Tanke, Ilorin');
  } finally {
    await stopTestServer(server);
  }
});

test('customer accounts cannot access business requests', async () => {
  const server = await startTestServer();
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const customer = await request(base, '/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: 'customer@example.com',
        password: 'StrongPass#12345',
        fullName: 'Test Customer',
        accountType: 'customer'
      })
    });
    assert.equal(customer.status, 201);

    const response = await request(base, '/api/v1/jobs', {
      headers: {
        Authorization: 'Bearer ' + customer.body.data.accessToken,
        'X-SwiftServe-Business-Id': '00000000-0000-4000-8000-000000000001'
      }
    });

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'BUSINESS_ACCESS_DENIED');
  } finally {
    await stopTestServer(server);
  }
});

test('PATCH updates and DELETE removes a request for the owning business', async () => {
  const server = await startTestServer();
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const account = await registerBusiness(base);
    const created = await request(base, '/api/v1/jobs', {
      method: 'POST',
      headers: account.headers,
      body: JSON.stringify(validJob({ service: 'laundry', description: 'Weekly clothes washing service', area: 'Fate, Ilorin' }))
    });
    const id = created.body.data.id;
    const updated = await request(base, '/api/v1/jobs/' + id, {
      method: 'PATCH',
      headers: account.headers,
      body: JSON.stringify({ status: 'accepted' })
    });

    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.status, 'accepted');
    assert.equal((await request(base, '/api/v1/jobs/' + id, { method: 'DELETE', headers: account.headers })).status, 204);
    assert.equal((await request(base, '/api/v1/jobs/' + id, { headers: account.headers })).status, 404);
  } finally {
    await stopTestServer(server);
  }
});

test('invalid job input returns a validation error', async () => {
  const server = await startTestServer();
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const account = await registerBusiness(base);
    const response = await request(base, '/api/v1/jobs', {
      method: 'POST',
      headers: account.headers,
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
    const base = 'http://127.0.0.1:' + server.address().port;
    const account = await registerBusiness(base);
    const response = await fetch(base + '/api/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...account.headers
      },
      body: '{not-json'
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'INVALID_JSON');
  } finally {
    await stopTestServer(server);
  }
});

test('unsupported job method returns 405 and Allow header', async () => {
  const server = await startTestServer();
  try {
    const account = await registerBusiness('http://127.0.0.1:' + server.address().port);
    const response = await request('http://127.0.0.1:' + server.address().port, '/api/v1/jobs', {
      method: 'PUT',
      headers: account.headers,
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
    const base = 'http://127.0.0.1:' + server.address().port;
    const account = await registerBusiness(base);
    const response = await fetch(base + '/api/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        ...account.headers
      },
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
    const base = 'http://127.0.0.1:' + server.address().port;
    const account = await registerBusiness(base);
    const response = await fetch(base + '/api/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...account.headers
      },
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
    const account = await registerBusiness(base);
    const created = await request(base, '/api/v1/jobs', {
      method: 'POST',
      headers: account.headers,
      body: JSON.stringify(validJob())
    });
    const id = created.body.data.id;

    const skip = await request(base, '/api/v1/jobs/' + id, {
      method: 'PATCH',
      headers: account.headers,
      body: JSON.stringify({ status: 'completed' })
    });
    assert.equal(skip.status, 409);
    assert.equal(skip.body.error.code, 'INVALID_STATUS_TRANSITION');

    const accepted = await request(base, '/api/v1/jobs/' + id, {
      method: 'PATCH',
      headers: account.headers,
      body: JSON.stringify({ status: 'accepted' })
    });
    assert.equal(accepted.status, 200);

    const completed = await request(base, '/api/v1/jobs/' + id, {
      method: 'PATCH',
      headers: account.headers,
      body: JSON.stringify({ status: 'completed' })
    });
    assert.equal(completed.status, 200);

    const reopen = await request(base, '/api/v1/jobs/' + id, {
      method: 'PATCH',
      headers: account.headers,
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
    const account = await registerBusiness(base);
    const created = await request(base, '/api/v1/jobs', {
      method: 'POST',
      headers: account.headers,
      body: JSON.stringify(validJob())
    });
    const id = created.body.data.id;

    const empty = await request(base, '/api/v1/jobs/' + id, {
      method: 'PATCH',
      headers: account.headers,
      body: JSON.stringify({})
    });
    const unknown = await request(base, '/api/v1/jobs/' + id, {
      method: 'PATCH',
      headers: account.headers,
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
    const base = 'http://127.0.0.1:' + server.address().port;
    const account = await registerBusiness(base);
    const response = await request(base, '/api/v1/jobs?status=unknown', { headers: account.headers });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INVALID_QUERY');
  } finally {
    await stopTestServer(server);
  }
});
