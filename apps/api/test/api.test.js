import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Tests always use isolated in-memory repositories, regardless of local .env settings.
process.env.NODE_ENV = 'test';
process.env.AUTH_RATE_LIMIT_MAX = '1000';
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

async function registerCustomer(base,email='customer@example.com',fullName='Test Customer') {
  const response=await request(base,'/api/v1/auth/register',{
    method:'POST',
    body:JSON.stringify({
      email,
      password:'StrongPass#12345',
      fullName,
      accountType:'customer'
    })
  });
  assert.equal(response.status,201);
  return {
    user:response.body.data.user,
    accessToken:response.body.data.accessToken,
    headers:{Authorization:'Bearer '+response.body.data.accessToken}
  };
}

async function registerProvider(base,email='provider@example.com',fullName='Test Provider') {
  const response=await request(base,'/api/v1/auth/register',{
    method:'POST',
    body:JSON.stringify({
      email,
      password:'StrongPass#12345',
      fullName,
      accountType:'provider',
      countryCode:'NG'
    })
  });
  assert.equal(response.status,201);
  return {
    user:response.body.data.user,
    accessToken:response.body.data.accessToken,
    headers:{Authorization:'Bearer '+response.body.data.accessToken}
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


test('business profile can be read and edited only by authorized members', async () => {
  const server = await startTestServer();
  try {
    const base='http://127.0.0.1:'+server.address().port;
    const account=await registerBusiness(base);
    const profile=await request(base,'/api/v1/business/profile',{headers:account.headers});
    assert.equal(profile.status,200);
    assert.equal(profile.body.data.name,'Test Home Services');

    const updated=await request(base,'/api/v1/business/profile',{
      method:'PATCH',
      headers:account.headers,
      body:JSON.stringify({
        name:'SwiftServe Ilorin Services',
        phoneE164:'+2348012345678',
        countryCode:'ng',
        currencyCode:'ngn',
        timeZone:'Africa/Lagos'
      })
    });
    assert.equal(updated.status,200);
    assert.equal(updated.body.data.name,'SwiftServe Ilorin Services');
    assert.equal(updated.body.data.countryCode,'NG');
    assert.equal(updated.body.data.currencyCode,'NGN');
  } finally {
    await stopTestServer(server);
  }
});

test('business service catalogue supports create, list, update and delete', async () => {
  const server=await startTestServer();
  try {
    const base='http://127.0.0.1:'+server.address().port;
    const account=await registerBusiness(base);
    const created=await request(base,'/api/v1/business/services',{
      method:'POST',
      headers:account.headers,
      body:JSON.stringify({
        category:'cleaning',
        name:'Apartment deep clean',
        slug:'apartment-deep-clean',
        description:'A detailed cleaning service for apartments and homes.',
        pricingModel:'fixed',
        currencyCode:'NGN',
        priceMinor:450000,
        durationMinutes:180
      })
    });
    assert.equal(created.status,201);
    const id=created.body.data.id;
    const list=await request(base,'/api/v1/business/services',{headers:account.headers});
    assert.equal(list.status,200);
    assert.equal(list.body.data.length,1);

    const updated=await request(base,'/api/v1/business/services/'+id,{
      method:'PATCH',
      headers:account.headers,
      body:JSON.stringify({priceMinor:500000,isActive:false})
    });
    assert.equal(updated.status,200);
    assert.equal(updated.body.data.priceMinor,500000);
    assert.equal(updated.body.data.isActive,false);

    const deleted=await request(base,'/api/v1/business/services/'+id,{
      method:'DELETE',headers:account.headers
    });
    assert.equal(deleted.status,204);

    const repeatedDelete=await request(base,'/api/v1/business/services/'+id,{
      method:'DELETE',headers:account.headers
    });
    assert.equal(repeatedDelete.status,204);

    const missing=await request(base,'/api/v1/business/services/'+id,{headers:account.headers});
    assert.equal(missing.status,404);
  } finally {
    await stopTestServer(server);
  }
});

test('business branches, opening hours and service areas remain tenant-scoped', async () => {
  const server=await startTestServer();
  try {
    const base='http://127.0.0.1:'+server.address().port;
    const account=await registerBusiness(base);
    const branchResponse=await request(base,'/api/v1/business/branches',{
      method:'POST',
      headers:account.headers,
      body:JSON.stringify({
        name:'Tanke Branch',
        countryCode:'NG',
        addressLine1:'12 University Road',
        city:'Ilorin',
        region:'Kwara',
        isPrimary:true
      })
    });
    assert.equal(branchResponse.status,201);
    const branchId=branchResponse.body.data.id;

    const hours=await request(base,'/api/v1/business/hours',{
      method:'PUT',
      headers:account.headers,
      body:JSON.stringify({
        branchId,
        dayOfWeek:1,
        opensAt:'08:00',
        closesAt:'17:00',
        isClosed:false
      })
    });
    assert.equal(hours.status,200);
    assert.equal(hours.body.data.branchId,branchId);

    const area=await request(base,'/api/v1/business/service-areas',{
      method:'POST',
      headers:account.headers,
      body:JSON.stringify({
        branchId,
        countryCode:'NG',
        region:'Kwara',
        city:'Ilorin'
      })
    });
    assert.equal(area.status,201);
    assert.equal(area.body.data.branchId,branchId);

    const list=await request(base,'/api/v1/business/branches',{headers:account.headers});
    assert.equal(list.body.data.length,1);
    assert.equal(list.body.data[0].id,branchId);
  } finally {
    await stopTestServer(server);
  }
});

test('team invitations add only the invited email to the selected business', async () => {
  const server=await startTestServer();
  try {
    const base='http://127.0.0.1:'+server.address().port;
    const owner=await registerBusiness(base,'owner-team@example.com','Team Test Business');
    const invited=await request(base,'/api/v1/auth/register',{
      method:'POST',
      body:JSON.stringify({
        email:'staff-member@example.com',
        password:'StrongPass#12345',
        fullName:'Invited Staff',
        accountType:'customer'
      })
    });
    assert.equal(invited.status,201);

    const created=await request(base,'/api/v1/business/team/invitations',{
      method:'POST',
      headers:owner.headers,
      body:JSON.stringify({email:'staff-member@example.com',role:'staff'})
    });
    assert.equal(created.status,201);
    assert.equal(created.body.data.invitation.email,'staff-member@example.com');
    assert.equal(created.body.data.delivery,'pending');

    const accepted=await request(base,'/api/v1/auth/invitations/accept',{
      method:'POST',
      headers:{Authorization:'Bearer '+invited.body.data.accessToken},
      body:JSON.stringify({invitationToken:created.body.data.invitationToken})
    });
    assert.equal(accepted.status,200);
    assert.equal(accepted.body.data.businessId,owner.businessId);

    const members=await request(base,'/api/v1/business/team/members',{headers:owner.headers});
    assert.equal(members.status,200);
    assert.equal(members.body.data.length,2);
    assert.ok(members.body.data.some(item=>item.email==='staff-member@example.com' && item.role==='staff'));

    const staffHeaders={
      Authorization:'Bearer '+invited.body.data.accessToken,
      'X-SwiftServe-Business-Id':owner.businessId
    };
    const forbidden=await request(base,'/api/v1/business/profile',{
      method:'PATCH',headers:staffHeaders,body:JSON.stringify({name:'Unauthorized Edit'})
    });
    assert.equal(forbidden.status,403);
    assert.equal(forbidden.body.error.code,'INSUFFICIENT_ROLE');
  } finally {
    await stopTestServer(server);
  }
});

test('business resources cannot be accessed by another business', async () => {
  const server=await startTestServer();
  try {
    const base='http://127.0.0.1:'+server.address().port;
    const first=await registerBusiness(base,'business-one@example.com','Business One');
    const second=await registerBusiness(base,'business-two@example.com','Business Two');
    const forbidden=await request(base,'/api/v1/business/profile',{
      headers:{
        Authorization:'Bearer '+second.accessToken,
        'X-SwiftServe-Business-Id':first.businessId
      }
    });
    assert.equal(forbidden.status,403);
    assert.equal(forbidden.body.error.code,'BUSINESS_ACCESS_DENIED');
  } finally {
    await stopTestServer(server);
  }
});


test('customer profile updates preserve omitted fields and saved locations remain private', async () => {
  const server=await startTestServer();
  try {
    const base='http://127.0.0.1:'+server.address().port;
    const customer=await registerCustomer(base,'profile-customer@example.com');
    const other=await registerCustomer(base,'other-customer@example.com','Other Customer');

    const firstPatch=await request(base,'/api/v1/customer/profile',{
      method:'PATCH',
      headers:customer.headers,
      body:JSON.stringify({phoneE164:'+2348012345678',preferredLanguage:'en'})
    });
    assert.equal(firstPatch.status,200);
    const secondPatch=await request(base,'/api/v1/customer/profile',{
      method:'PATCH',
      headers:customer.headers,
      body:JSON.stringify({locale:'en-NG'})
    });
    assert.equal(secondPatch.status,200);
    assert.equal(secondPatch.body.data.phoneE164,'+2348012345678');
    assert.equal(secondPatch.body.data.preferredLanguage,'en');
    assert.equal(secondPatch.body.data.locale,'en-NG');

    const saved=await request(base,'/api/v1/customer/locations',{
      method:'POST',
      headers:customer.headers,
      body:JSON.stringify({
        label:'Home',
        recipientName:'Test Customer',
        phoneE164:'+2348012345678',
        countryCode:'NG',
        addressLine1:'12 Unity Road',
        city:'Ilorin',
        region:'Kwara',
        isDefault:true
      })
    });
    assert.equal(saved.status,201);
    assert.equal(saved.body.data.isDefault,true);

    const inaccessible=await request(base,'/api/v1/customer/locations/'+saved.body.data.id,{
      headers:other.headers
    });
    assert.equal(inaccessible.status,404);

    const updated=await request(base,'/api/v1/customer/locations/'+saved.body.data.id,{
      method:'PATCH',
      headers:customer.headers,
      body:JSON.stringify({label:'Primary Home'})
    });
    assert.equal(updated.status,200);
    assert.equal(updated.body.data.label,'Primary Home');
    assert.equal(updated.body.data.city,'Ilorin');

    const list=await request(base,'/api/v1/customer/locations',{headers:customer.headers});
    assert.equal(list.status,200);
    assert.equal(list.body.data.length,1);
  } finally {
    await stopTestServer(server);
  }
});

test('customers can discover services, request bookings, receive quotes and follow status history', async () => {
  const server=await startTestServer();
  try {
    const base='http://127.0.0.1:'+server.address().port;
    const owner=await registerBusiness(base,'marketplace-owner@example.com','Ilorin Home Care');

    const branch=await request(base,'/api/v1/business/branches',{
      method:'POST',
      headers:owner.headers,
      body:JSON.stringify({
        name:'Ilorin Central',
        countryCode:'NG',
        addressLine1:'10 Unity Road',
        city:'Ilorin',
        region:'Kwara',
        isPrimary:true
      })
    });
    assert.equal(branch.status,201);

    const service=await request(base,'/api/v1/business/services',{
      method:'POST',
      headers:owner.headers,
      body:JSON.stringify({
        category:'cleaning',
        name:'Apartment Deep Cleaning',
        slug:'apartment-deep-cleaning',
        description:'Detailed deep cleaning for residential apartments.',
        pricingModel:'fixed',
        currencyCode:'NGN',
        priceMinor:150000,
        durationMinutes:180
      })
    });
    assert.equal(service.status,201);

    const area=await request(base,'/api/v1/business/service-areas',{
      method:'POST',
      headers:owner.headers,
      body:JSON.stringify({
        branchId:branch.body.data.id,
        countryCode:'NG',
        region:'Kwara',
        city:'Ilorin'
      })
    });
    assert.equal(area.status,201);

    const discovery=await request(base,'/api/v1/market/services?countryCode=NG&city=Ilorin&category=cleaning');
    assert.equal(discovery.status,200);
    assert.ok(discovery.body.data.some(item=>item.id===service.body.data.id));
    assert.equal(discovery.body.data.find(item=>item.id===service.body.data.id).business.name,'Ilorin Home Care');

    const customer=await registerCustomer(base,'booking-customer@example.com');
    const saved=await request(base,'/api/v1/customer/locations',{
      method:'POST',
      headers:customer.headers,
      body:JSON.stringify({
        label:'Home',
        recipientName:'Booking Customer',
        phoneE164:'+2348012345678',
        countryCode:'NG',
        addressLine1:'25 Tanke Road',
        city:'Ilorin',
        region:'Kwara',
        isDefault:true
      })
    });
    assert.equal(saved.status,201);

    const requestedStartAt=new Date(Date.now()+48*60*60*1000).toISOString();
    const booking=await request(base,'/api/v1/customer/bookings',{
      method:'POST',
      headers:customer.headers,
      body:JSON.stringify({
        serviceId:service.body.data.id,
        locationId:saved.body.data.id,
        requestedStartAt,
        customerNotes:'Please call before arrival.'
      })
    });
    assert.equal(booking.status,201);
    assert.equal(booking.body.data.status,'requested');
    assert.equal(booking.body.data.businessId,owner.businessId);
    assert.equal(booking.body.data.customerLocationId,saved.body.data.id);
    assert.equal(booking.body.data.servicePriceMinor,150000);

    const businessList=await request(base,'/api/v1/business/bookings',{
      headers:owner.headers
    });
    assert.equal(businessList.status,200);
    assert.ok(businessList.body.data.some(item=>item.id===booking.body.data.id));

    const quote=await request(base,'/api/v1/business/bookings/'+booking.body.data.id+'/quotes',{
      method:'POST',
      headers:owner.headers,
      body:JSON.stringify({amountMinor:180000,message:'Includes materials and labour.'})
    });
    assert.equal(quote.status,201);
    assert.equal(quote.body.data.currencyCode,'NGN');
    assert.equal(quote.body.data.status,'pending');

    const quotes=await request(base,'/api/v1/customer/bookings/'+booking.body.data.id+'/quotes',{
      headers:customer.headers
    });
    assert.equal(quotes.status,200);
    assert.equal(quotes.body.data.length,1);

    const accepted=await request(base,'/api/v1/customer/bookings/'+booking.body.data.id+'/quotes/'+quote.body.data.id+'/response',{
      method:'POST',
      headers:customer.headers,
      body:JSON.stringify({action:'accept'})
    });
    assert.equal(accepted.status,200);
    assert.equal(accepted.body.data.status,'confirmed');

    const current=await request(base,'/api/v1/customer/bookings/'+booking.body.data.id,{
      headers:customer.headers
    });
    assert.equal(current.status,200);
    assert.equal(current.body.data.status,'confirmed');

    const events=await request(base,'/api/v1/customer/bookings/'+booking.body.data.id+'/events',{
      headers:customer.headers
    });
    assert.equal(events.status,200);
    assert.ok(events.body.data.some(item=>item.toStatus==='requested'));
    assert.ok(events.body.data.some(item=>item.toStatus==='quoted'));
    assert.ok(events.body.data.some(item=>item.toStatus==='confirmed'));

    const customerNotifications=await request(base,'/api/v1/notifications',{headers:customer.headers});
    assert.equal(customerNotifications.status,200);
    const quoteNotification=customerNotifications.body.data.find(item=>item.type==='booking_quote');
    assert.ok(quoteNotification);

    const marked=await request(base,'/api/v1/notifications/'+quoteNotification.id+'/read',{
      method:'PATCH',
      headers:customer.headers
    });
    assert.equal(marked.status,200);
    assert.equal(marked.body.data.read,true);

    const otherCustomer=await registerCustomer(base,'booking-other@example.com','Other Customer');
    const hidden=await request(base,'/api/v1/customer/bookings/'+booking.body.data.id,{
      headers:otherCustomer.headers
    });
    assert.equal(hidden.status,404);

    const cancelled=await request(base,'/api/v1/customer/bookings/'+booking.body.data.id+'/cancel',{
      method:'POST',
      headers:customer.headers,
      body:JSON.stringify({note:'Customer changed plans.'})
    });
    assert.equal(cancelled.status,200);
    assert.equal(cancelled.body.data.status,'cancelled');
  } finally {
    await stopTestServer(server);
  }
});

test('booking requests reject expired times and service areas outside a business coverage region', async () => {
  const server=await startTestServer();
  try {
    const base='http://127.0.0.1:'+server.address().port;
    const owner=await registerBusiness(base,'coverage-owner@example.com','Coverage Test Business');
    const service=await request(base,'/api/v1/business/services',{
      method:'POST',
      headers:owner.headers,
      body:JSON.stringify({
        category:'plumbing',
        name:'Kitchen Pipe Repair',
        slug:'kitchen-pipe-repair',
        description:'Repair leaking kitchen pipes and taps.',
        pricingModel:'quote',
        currencyCode:'NGN',
        priceMinor:null
      })
    });
    assert.equal(service.status,201);
    const customer=await registerCustomer(base,'coverage-customer@example.com');
    const expired=await request(base,'/api/v1/customer/bookings',{
      method:'POST',
      headers:customer.headers,
      body:JSON.stringify({
        serviceId:service.body.data.id,
        serviceAddress:{
          recipientName:'Customer',
          countryCode:'NG',
          addressLine1:'5 Test Street',
          city:'Ilorin',
          region:'Kwara'
        },
        requestedStartAt:new Date(Date.now()-3600000).toISOString()
      })
    });
    assert.equal(expired.status,422);

    const future=await request(base,'/api/v1/customer/bookings',{
      method:'POST',
      headers:customer.headers,
      body:JSON.stringify({
        serviceId:service.body.data.id,
        serviceAddress:{
          recipientName:'Customer',
          countryCode:'NG',
          addressLine1:'5 Test Street',
          city:'Ibadan',
          region:'Oyo'
        },
        requestedStartAt:new Date(Date.now()+86400000).toISOString()
      })
    });
    assert.equal(future.status,422);
    assert.equal(future.body.error.code,'SERVICE_OUT_OF_AREA');
  } finally {
    await stopTestServer(server);
  }
});


test('provider onboarding, verification, invitation, assignment and job completion work end to end', async () => {
  const previousAdminKey=process.env.SWIFTSERVE_ADMIN_API_KEY;
  process.env.SWIFTSERVE_ADMIN_API_KEY='swiftserve-test-admin-key';
  const server=await startTestServer();
  try {
    const base='http://127.0.0.1:'+server.address().port;
    const owner=await registerBusiness(base,'provider-business@example.com','Provider Test Business');

    const branch=await request(base,'/api/v1/business/branches',{
      method:'POST',
      headers:owner.headers,
      body:JSON.stringify({
        name:'Ilorin Branch',
        countryCode:'NG',
        addressLine1:'15 Unity Road',
        city:'Ilorin',
        region:'Kwara',
        isPrimary:true
      })
    });
    assert.equal(branch.status,201);

    const service=await request(base,'/api/v1/business/services',{
      method:'POST',
      headers:owner.headers,
      body:JSON.stringify({
        category:'plumbing',
        name:'Kitchen Pipe Repair',
        slug:'provider-kitchen-pipe-repair',
        description:'Repair leaking kitchen pipes and taps in homes.',
        pricingModel:'quote',
        currencyCode:'NGN',
        priceMinor:null
      })
    });
    assert.equal(service.status,201);

    const area=await request(base,'/api/v1/business/service-areas',{
      method:'POST',
      headers:owner.headers,
      body:JSON.stringify({
        branchId:branch.body.data.id,
        countryCode:'NG',
        city:'Ilorin',
        region:'Kwara'
      })
    });
    assert.equal(area.status,201);

    const customer=await registerCustomer(base,'provider-booking-customer@example.com','Booking Customer');
    const location=await request(base,'/api/v1/customer/locations',{
      method:'POST',
      headers:customer.headers,
      body:JSON.stringify({
        label:'Home',
        recipientName:'Booking Customer',
        phoneE164:'+2348012345678',
        countryCode:'NG',
        addressLine1:'22 Tanke Road',
        city:'Ilorin',
        region:'Kwara',
        isDefault:true
      })
    });
    assert.equal(location.status,201);

    const startAt=new Date(Date.now()+72*60*60*1000);
    const endAt=new Date(startAt.getTime()+2*60*60*1000);
    const booking=await request(base,'/api/v1/customer/bookings',{
      method:'POST',
      headers:customer.headers,
      body:JSON.stringify({
        serviceId:service.body.data.id,
        locationId:location.body.data.id,
        requestedStartAt:startAt.toISOString(),
        requestedEndAt:endAt.toISOString()
      })
    });
    assert.equal(booking.status,201);

    const quote=await request(base,'/api/v1/business/bookings/'+booking.body.data.id+'/quotes',{
      method:'POST',
      headers:owner.headers,
      body:JSON.stringify({amountMinor:225000})
    });
    assert.equal(quote.status,201);
    const acceptedQuote=await request(base,'/api/v1/customer/bookings/'+booking.body.data.id+'/quotes/'+quote.body.data.id+'/response',{
      method:'POST',
      headers:customer.headers,
      body:JSON.stringify({action:'accept'})
    });
    assert.equal(acceptedQuote.status,200);
    assert.equal(acceptedQuote.body.data.status,'confirmed');

    const provider=await registerProvider(base,'verified-provider@example.com','Verified Provider');
    const profile=await request(base,'/api/v1/provider/profile',{headers:provider.headers});
    assert.equal(profile.status,200);
    assert.equal(profile.body.data.verificationStatus,'unverified');

    const profileUpdate=await request(base,'/api/v1/provider/profile',{
      method:'PATCH',
      headers:provider.headers,
      body:JSON.stringify({
        displayName:'Verified Home Technician',
        phoneE164:'+2348098765432',
        bio:'Residential plumbing and basic household maintenance.',
        timeZone:'Africa/Lagos'
      })
    });
    assert.equal(profileUpdate.status,200);

    const providerSkills=await request(base,'/api/v1/provider/skills',{
      method:'PUT',
      headers:provider.headers,
      body:JSON.stringify({items:[{category:'plumbing',yearsExperience:5}]})
    });
    assert.equal(providerSkills.status,200);
    assert.equal(providerSkills.body.data[0].category,'plumbing');

    const providerArea=await request(base,'/api/v1/provider/service-areas',{
      method:'POST',
      headers:provider.headers,
      body:JSON.stringify({countryCode:'NG',city:'Ilorin',region:'Kwara'})
    });
    assert.equal(providerArea.status,201);

    const days=Array.from({length:7},(_,dayOfWeek)=>({
      dayOfWeek,isAvailable:true,opensAt:'00:00',closesAt:'23:59'
    }));
    const providerAvailability=await request(base,'/api/v1/provider/availability',{
      method:'PUT',
      headers:provider.headers,
      body:JSON.stringify({days})
    });
    assert.equal(providerAvailability.status,200);
    assert.equal(providerAvailability.body.data.length,7);

    const verificationRequest=await request(base,'/api/v1/provider/verification/request',{
      method:'POST',headers:provider.headers
    });
    assert.equal(verificationRequest.status,200);
    assert.equal(verificationRequest.body.data.verificationStatus,'pending_review');

    const review=await request(base,'/api/v1/admin/providers/'+provider.user.id+'/verification',{
      method:'PATCH',
      headers:{'X-SwiftServe-Admin-Key':'swiftserve-test-admin-key'},
      body:JSON.stringify({status:'verified',note:'Provider identity and credentials reviewed.'})
    });
    assert.equal(review.status,200);
    assert.equal(review.body.data.verificationStatus,'verified');
    assert.equal(review.body.data.onboardingStatus,'active');

    const invitation=await request(base,'/api/v1/business/providers/invitations',{
      method:'POST',
      headers:owner.headers,
      body:JSON.stringify({email:'verified-provider@example.com'})
    });
    assert.equal(invitation.status,201);
    assert.equal(invitation.body.data.delivery,'pending');

    const acceptedInvitation=await request(base,'/api/v1/provider/invitations/accept',{
      method:'POST',
      headers:provider.headers,
      body:JSON.stringify({invitationToken:invitation.body.data.invitationToken})
    });
    assert.equal(acceptedInvitation.status,200);
    assert.equal(acceptedInvitation.body.data.businessId,owner.businessId);

    const businessProviders=await request(base,'/api/v1/business/providers',{headers:owner.headers});
    assert.equal(businessProviders.status,200);
    assert.ok(businessProviders.body.data.some(item=>item.userId===provider.user.id&&item.verificationStatus==='verified'));

    const assignment=await request(base,'/api/v1/business/bookings/'+booking.body.data.id+'/assignments',{
      method:'POST',
      headers:owner.headers,
      body:JSON.stringify({
        providerUserId:provider.user.id,
        scheduledStartAt:startAt.toISOString(),
        scheduledEndAt:endAt.toISOString(),
        providerNote:'Call the customer before leaving.'
      })
    });
    assert.equal(assignment.status,201);
    assert.equal(assignment.body.data.status,'offered');

    const businessCannotCompleteUnacceptedWork=await request(base,'/api/v1/business/bookings/'+booking.body.data.id+'/status',{
      method:'PATCH',
      headers:owner.headers,
      body:JSON.stringify({status:'in_progress'})
    });
    assert.equal(businessCannotCompleteUnacceptedWork.status,422);

    const providerBookings=await request(base,'/api/v1/provider/bookings',{headers:provider.headers});
    assert.equal(providerBookings.status,200);
    assert.ok(providerBookings.body.data.some(item=>item.bookingId===booking.body.data.id));

    const acceptedAssignment=await request(base,'/api/v1/provider/bookings/'+booking.body.data.id+'/respond',{
      method:'POST',
      headers:provider.headers,
      body:JSON.stringify({action:'accept'})
    });
    assert.equal(acceptedAssignment.status,200);
    assert.equal(acceptedAssignment.body.data.status,'accepted');

    const started=await request(base,'/api/v1/provider/bookings/'+booking.body.data.id+'/status',{
      method:'PATCH',
      headers:provider.headers,
      body:JSON.stringify({status:'in_progress'})
    });
    assert.equal(started.status,200);
    assert.equal(started.body.data.status,'in_progress');

    const completed=await request(base,'/api/v1/provider/bookings/'+booking.body.data.id+'/status',{
      method:'PATCH',
      headers:provider.headers,
      body:JSON.stringify({status:'completed',note:'Work completed and checked with the customer.'})
    });
    assert.equal(completed.status,200);
    assert.equal(completed.body.data.status,'completed');

    const finalBooking=await request(base,'/api/v1/customer/bookings/'+booking.body.data.id,{
      headers:customer.headers
    });
    assert.equal(finalBooking.status,200);
    assert.equal(finalBooking.body.data.status,'completed');
  } finally {
    await stopTestServer(server);
    if(previousAdminKey===undefined)delete process.env.SWIFTSERVE_ADMIN_API_KEY;
    else process.env.SWIFTSERVE_ADMIN_API_KEY=previousAdminKey;
  }
});


test('payment endpoints fail closed without gateway configuration and reject unsigned webhooks', async () => {
  const previousSecret=process.env.PAYSTACK_SECRET_KEY;
  delete process.env.PAYSTACK_SECRET_KEY;
  const server=await startTestServer();
  try {
    const base='http://127.0.0.1:'+server.address().port;
    const customer=await registerCustomer(base,'payment-disabled-customer@example.com','Payment Test Customer');

    const payment=await request(base,'/api/v1/customer/bookings/123e4567-e89b-42d3-a456-426614174000/payments',{
      method:'POST',
      headers:customer.headers,
      body:JSON.stringify({})
    });
    assert.equal(payment.status,503);
    assert.equal(payment.body.error.code,'PAYMENT_GATEWAY_NOT_CONFIGURED');

    const webhook=await request(base,'/api/v1/webhooks/paystack',{
      method:'POST',
      body:JSON.stringify({event:'charge.success',data:{reference:'untrusted'}})
    });
    assert.equal(webhook.status,401);
    assert.equal(webhook.body.error,'Invalid Paystack signature.');
  } finally {
    await stopTestServer(server);
    if(previousSecret===undefined)delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY=previousSecret;
  }
});
