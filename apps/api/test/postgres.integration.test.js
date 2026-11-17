import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const hasTestDatabase = typeof testDatabaseUrl === 'string' && testDatabaseUrl.length > 0;

test('PostgreSQL persists accounts and isolates businesses', { skip: !hasTestDatabase }, async () => {
  process.env.NODE_ENV = 'integration';
  process.env.DATABASE_URL = testDatabaseUrl;

  const { requestHandler } = await import('../src/app.js');
  const { closeDatabase } = await import('../src/repository.js');
  const pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 2 });
  const server = http.createServer(requestHandler);
  const userIds = [];
  const businessIds = [];

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  async function call(path, options = {}) {
    const response = await fetch(base + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    const raw = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: raw ? JSON.parse(raw) : null
    };
  }

  async function registerBusiness(label) {
    const email = 'integration-' + randomUUID() + '@example.test';
    const response = await call('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: 'Integration-Strong#12345',
        fullName: 'Integration Owner',
        accountType: 'business',
        businessName: 'Integration ' + label,
        countryCode: 'NG'
      })
    });

    assert.equal(response.status, 201);
    const user = response.body.data.user;
    const business = response.body.data.businesses[0];
    userIds.push(user.id);
    businessIds.push(business.id);
    assert.equal(business.role, 'owner');

    return {
      user,
      business,
      accessToken: response.body.data.accessToken,
      headers: {
        Authorization: 'Bearer ' + response.body.data.accessToken,
        'X-SwiftServe-Business-Id': business.id
      },
      email
    };
  }

  try {
    const first = await registerBusiness('One');
    const second = await registerBusiness('Two');

    const login = await call('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: first.email,
        password: 'Integration-Strong#12345'
      })
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.data.user.id, first.user.id);

    const created = await call('/api/v1/jobs', {
      method: 'POST',
      headers: first.headers,
      body: JSON.stringify({
        service: 'plumbing',
        description: 'PostgreSQL integration test service request',
        area: 'Tanke, Ilorin'
      })
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.businessId, first.business.id);

    const firstList = await call('/api/v1/jobs', { headers: first.headers });
    const secondList = await call('/api/v1/jobs', { headers: second.headers });
    const secondRead = await call('/api/v1/jobs/' + created.body.data.id, {
      headers: second.headers
    });

    const service = await call('/api/v1/business/services', {
      method: 'POST',
      headers: first.headers,
      body: JSON.stringify({
        category: 'cleaning',
        name: 'PostgreSQL Test Cleaning',
        slug: 'postgresql-test-cleaning',
        description: 'A realistic service listing used for PostgreSQL integration checks.',
        pricingModel: 'fixed',
        currencyCode: 'NGN',
        priceMinor: 250000,
        durationMinutes: 120
      })
    });
    assert.equal(service.status, 201);
    const serviceList = await call('/api/v1/business/services', { headers: first.headers });
    assert.equal(serviceList.status, 200);
    assert.equal(serviceList.body.data.length, 1);

    const branch = await call('/api/v1/business/branches', {
      method: 'POST',
      headers: first.headers,
      body: JSON.stringify({
        name: 'Integration Branch',
        countryCode: 'NG',
        addressLine1: '12 Integration Road',
        city: 'Ilorin',
        isPrimary: true
      })
    });
    assert.equal(branch.status, 201);

    const hours = await call('/api/v1/business/hours', {
      method: 'PUT',
      headers: first.headers,
      body: JSON.stringify({
        branchId: branch.body.data.id,
        dayOfWeek: 1,
        opensAt: '08:00',
        closesAt: '17:00',
        isClosed: false
      })
    });
    assert.equal(hours.status, 200);

    const area = await call('/api/v1/business/service-areas', {
      method: 'POST',
      headers: first.headers,
      body: JSON.stringify({
        branchId: branch.body.data.id,
        countryCode: 'NG',
        region: 'Kwara',
        city: 'Ilorin'
      })
    });
    assert.equal(area.status, 201);

    const invitation = await call('/api/v1/business/team/invitations', {
      method: 'POST',
      headers: first.headers,
      body: JSON.stringify({ email: second.email, role: 'staff' })
    });
    assert.equal(invitation.status, 201);
    assert.equal('tokenHash' in invitation.body.data.invitation, false);

    const acceptedInvitation = await call('/api/v1/auth/invitations/accept', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + second.accessToken },
      body: JSON.stringify({ invitationToken: invitation.body.data.invitationToken })
    });
    assert.equal(acceptedInvitation.status, 200);
    assert.equal(acceptedInvitation.body.data.businessId, first.business.id);

    const invitedMemberProfile = await call('/api/v1/business/profile', {
      headers: {
        Authorization: 'Bearer ' + second.accessToken,
        'X-SwiftServe-Business-Id': first.business.id
      }
    });
    assert.equal(invitedMemberProfile.status, 200);

    assert.equal(firstList.status, 200);
    assert.equal(firstList.body.count, 1);
    assert.equal(secondList.status, 200);
    assert.equal(secondList.body.count, 0);
    assert.equal(secondRead.status, 404);

    const loggedOut = await call('/api/v1/auth/logout', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + login.body.data.accessToken }
    });
    assert.equal(loggedOut.status, 200);

    const afterLogout = await call('/api/v1/auth/me', {
      headers: { Authorization: 'Bearer ' + login.body.data.accessToken }
    });
    assert.equal(afterLogout.status, 401);

    const persisted = await pool.query(
      'SELECT COUNT(*)::int AS count FROM service_requests WHERE id = $1 AND business_id = $2',
      [created.body.data.id, first.business.id]
    );
    assert.equal(persisted.rows[0].count, 1);
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    if (businessIds.length) {
      await pool.query('DELETE FROM service_requests WHERE business_id = ANY($1::uuid[])', [businessIds]);
      await pool.query('DELETE FROM businesses WHERE id = ANY($1::uuid[])', [businessIds]);
    }
    if (userIds.length) {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    }
    await pool.end();
    await closeDatabase();
  }
});
