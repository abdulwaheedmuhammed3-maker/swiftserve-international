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

    const customerRegistration = await call('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: 'integration-customer-' + randomUUID() + '@example.test',
        password: 'Integration-Strong#12345',
        fullName: 'Integration Customer',
        accountType: 'customer'
      })
    });
    assert.equal(customerRegistration.status, 201);
    const customerUser = customerRegistration.body.data.user;
    userIds.push(customerUser.id);
    const customerHeaders = {
      Authorization: 'Bearer ' + customerRegistration.body.data.accessToken
    };

    const profile = await call('/api/v1/customer/profile', {
      method: 'PATCH',
      headers: customerHeaders,
      body: JSON.stringify({ phoneE164: '+2348012345678', locale: 'en-NG' })
    });
    assert.equal(profile.status, 200);
    assert.equal(profile.body.data.phoneE164, '+2348012345678');

    const savedLocation = await call('/api/v1/customer/locations', {
      method: 'POST',
      headers: customerHeaders,
      body: JSON.stringify({
        label: 'Home',
        recipientName: 'Integration Customer',
        phoneE164: '+2348012345678',
        countryCode: 'NG',
        addressLine1: '25 Integration Street',
        city: 'Ilorin',
        region: 'Kwara',
        isDefault: true
      })
    });
    assert.equal(savedLocation.status, 201);

    const booking = await call('/api/v1/customer/bookings', {
      method: 'POST',
      headers: customerHeaders,
      body: JSON.stringify({
        serviceId: service.body.data.id,
        locationId: savedLocation.body.data.id,
        requestedStartAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        customerNotes: 'Please call before arrival.'
      })
    });
    assert.equal(booking.status, 201);
    assert.equal(booking.body.data.businessId, first.business.id);
    assert.equal(booking.body.data.status, 'requested');
    assert.equal(booking.body.data.servicePriceMinor, 250000);

    const businessBookings = await call('/api/v1/business/bookings', {
      headers: first.headers
    });
    assert.equal(businessBookings.status, 200);
    assert.ok(businessBookings.body.data.some(item => item.id === booking.body.data.id));

    const quote = await call('/api/v1/business/bookings/' + booking.body.data.id + '/quotes', {
      method: 'POST',
      headers: first.headers,
      body: JSON.stringify({
        amountMinor: 275000,
        message: 'The quote covers labour and standard materials.'
      })
    });
    assert.equal(quote.status, 201);
    assert.equal(quote.body.data.currencyCode, 'NGN');

    const customerQuotes = await call('/api/v1/customer/bookings/' + booking.body.data.id + '/quotes', {
      headers: customerHeaders
    });
    assert.equal(customerQuotes.status, 200);
    assert.equal(customerQuotes.body.data.length, 1);

    const quoteAccepted = await call(
      '/api/v1/customer/bookings/' + booking.body.data.id + '/quotes/' + quote.body.data.id + '/response',
      {
        method: 'POST',
        headers: customerHeaders,
        body: JSON.stringify({ action: 'accept' })
      }
    );
    assert.equal(quoteAccepted.status, 200);
    assert.equal(quoteAccepted.body.data.status, 'confirmed');

    const paymentKeys = [
      'PAYMENT_PROVIDER','PAYMENT_RETURN_URL','PAYSTACK_SECRET_KEY',
      'PAYSTACK_WEBHOOK_SECRET','FLUTTERWAVE_SECRET_KEY','FLUTTERWAVE_WEBHOOK_SECRET_HASH'
    ];
    const previousPaymentEnv = Object.fromEntries(paymentKeys.map(key => [key, process.env[key]]));
    for (const key of paymentKeys) delete process.env[key];

    const paymentMissingKey = await call('/api/v1/customer/bookings/' + booking.body.data.id + '/payment-intents', {
      method: 'POST',
      headers: customerHeaders,
      body: JSON.stringify({})
    });
    assert.equal(paymentMissingKey.status, 400);

    const paymentDisabled = await call('/api/v1/customer/bookings/' + booking.body.data.id + '/payment-intents', {
      method: 'POST',
      headers: { ...customerHeaders, 'Idempotency-Key': 'pg-payment-intent-test-0001' },
      body: JSON.stringify({})
    });
    assert.equal(paymentDisabled.status, 503);
    assert.equal(paymentDisabled.body.error.code, 'PAYMENTS_DISABLED');

    const invalidWebhook = await call('/api/v1/webhooks/payments/paystack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-paystack-signature': '00' },
      body: JSON.stringify({ event: 'charge.success', data: { id: 100, reference: 'fake-reference' } })
    });
    assert.equal(invalidWebhook.status, 401);
    for (const key of paymentKeys) {
      if (previousPaymentEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousPaymentEnv[key];
    }

    const providerEmail = 'integration-provider-' + randomUUID() + '@example.test';
    const providerRegistration = await call('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: providerEmail,
        password: 'Integration-Strong#12345',
        fullName: 'Integration Provider',
        accountType: 'provider',
        countryCode: 'NG'
      })
    });
    assert.equal(providerRegistration.status, 201);
    const providerUser = providerRegistration.body.data.user;
    userIds.push(providerUser.id);
    const providerHeaders = {
      Authorization: 'Bearer ' + providerRegistration.body.data.accessToken
    };

    const providerProfile = await call('/api/v1/provider/profile', {
      headers: providerHeaders
    });
    assert.equal(providerProfile.status, 200);
    assert.equal(providerProfile.body.data.verificationStatus, 'unverified');

    const providerProfileUpdate = await call('/api/v1/provider/profile', {
      method: 'PATCH',
      headers: providerHeaders,
      body: JSON.stringify({
        displayName: 'Integration Home Technician',
        phoneE164: '+2348098765432',
        timeZone: 'Africa/Lagos'
      })
    });
    assert.equal(providerProfileUpdate.status, 200);

    const providerSkills = await call('/api/v1/provider/skills', {
      method: 'PUT',
      headers: providerHeaders,
      body: JSON.stringify({ items: [{ category: 'cleaning', yearsExperience: 4 }] })
    });
    assert.equal(providerSkills.status, 200);

    const providerArea = await call('/api/v1/provider/service-areas', {
      method: 'POST',
      headers: providerHeaders,
      body: JSON.stringify({ countryCode: 'NG', city: 'Ilorin', region: 'Kwara' })
    });
    assert.equal(providerArea.status, 201);

    const providerDays = Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek,
      isAvailable: true,
      opensAt: '00:00',
      closesAt: '23:59'
    }));
    const providerAvailability = await call('/api/v1/provider/availability', {
      method: 'PUT',
      headers: providerHeaders,
      body: JSON.stringify({ days: providerDays })
    });
    assert.equal(providerAvailability.status, 200);
    assert.equal(providerAvailability.body.data.length, 7);

    const verificationRequest = await call('/api/v1/provider/verification/request', {
      method: 'POST',
      headers: providerHeaders
    });
    assert.equal(verificationRequest.status, 200);
    assert.equal(verificationRequest.body.data.verificationStatus, 'pending_review');

    const previousAdminKey = process.env.SWIFTSERVE_ADMIN_API_KEY;
    process.env.SWIFTSERVE_ADMIN_API_KEY = 'swiftserve-ci-admin-key';
    const verified = await call('/api/v1/admin/providers/' + providerUser.id + '/verification', {
      method: 'PATCH',
      headers: { 'X-SwiftServe-Admin-Key': 'swiftserve-ci-admin-key' },
      body: JSON.stringify({ status: 'verified', note: 'CI provider verification review.' })
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.data.verificationStatus, 'verified');
    if (previousAdminKey === undefined) delete process.env.SWIFTSERVE_ADMIN_API_KEY;
    else process.env.SWIFTSERVE_ADMIN_API_KEY = previousAdminKey;

    const providerInvite = await call('/api/v1/business/providers/invitations', {
      method: 'POST',
      headers: first.headers,
      body: JSON.stringify({ email: providerEmail })
    });
    assert.equal(providerInvite.status, 201);

    const providerAcceptedInvite = await call('/api/v1/provider/invitations/accept', {
      method: 'POST',
      headers: providerHeaders,
      body: JSON.stringify({ invitationToken: providerInvite.body.data.invitationToken })
    });
    assert.equal(providerAcceptedInvite.status, 200);
    assert.equal(providerAcceptedInvite.body.data.businessId, first.business.id);

    const linkedProviders = await call('/api/v1/business/providers', {
      headers: first.headers
    });
    assert.equal(linkedProviders.status, 200);
    assert.ok(linkedProviders.body.data.some(item => item.userId === providerUser.id));

    const assignmentStart = new Date(Date.now() + 96 * 60 * 60 * 1000);
    const assignmentEnd = new Date(assignmentStart.getTime() + 2 * 60 * 60 * 1000);
    const assignment = await call('/api/v1/business/bookings/' + booking.body.data.id + '/assignments', {
      method: 'POST',
      headers: first.headers,
      body: JSON.stringify({
        providerUserId: providerUser.id,
        scheduledStartAt: assignmentStart.toISOString(),
        scheduledEndAt: assignmentEnd.toISOString(),
        providerNote: 'CI test assignment.'
      })
    });
    assert.equal(assignment.status, 201);
    assert.equal(assignment.body.data.status, 'offered');

    const providerBookings = await call('/api/v1/provider/bookings', {
      headers: providerHeaders
    });
    assert.equal(providerBookings.status, 200);
    assert.ok(providerBookings.body.data.some(item => item.bookingId === booking.body.data.id));

    const providerAcceptedAssignment = await call('/api/v1/provider/bookings/' + booking.body.data.id + '/respond', {
      method: 'POST',
      headers: providerHeaders,
      body: JSON.stringify({ action: 'accept' })
    });
    assert.equal(providerAcceptedAssignment.status, 200);
    assert.equal(providerAcceptedAssignment.body.data.status, 'accepted');

    const providerStarted = await call('/api/v1/provider/bookings/' + booking.body.data.id + '/status', {
      method: 'PATCH',
      headers: providerHeaders,
      body: JSON.stringify({ status: 'in_progress' })
    });
    assert.equal(providerStarted.status, 200);

    const providerCompleted = await call('/api/v1/provider/bookings/' + booking.body.data.id + '/status', {
      method: 'PATCH',
      headers: providerHeaders,
      body: JSON.stringify({ status: 'completed', note: 'CI assignment completed.' })
    });
    assert.equal(providerCompleted.status, 200);
    assert.equal(providerCompleted.body.data.status, 'completed');

    const finalBooking = await call('/api/v1/customer/bookings/' + booking.body.data.id, {
      headers: customerHeaders
    });
    assert.equal(finalBooking.status, 200);
    assert.equal(finalBooking.body.data.status, 'completed');

    const createdReview = await call('/api/v1/customer/bookings/' + booking.body.data.id + '/review', {
      method: 'POST',
      headers: customerHeaders,
      body: JSON.stringify({
        businessRating: 5,
        providerRating: 5,
        reviewText: 'The service was completed and the home was left tidy.'
      })
    });
    assert.equal(createdReview.status, 201);
    assert.equal(createdReview.body.data.businessRating, 5);

    const businessReviews = await call('/api/v1/business/reviews', { headers: first.headers });
    assert.equal(businessReviews.status, 200);
    assert.ok(businessReviews.body.data.some(item => item.id === createdReview.body.data.id));

    const reviewResponse = await call('/api/v1/business/reviews/' + createdReview.body.data.id + '/response', {
      method: 'POST',
      headers: first.headers,
      body: JSON.stringify({ responseText: 'Thank you for taking the time to leave feedback.' })
    });
    assert.equal(reviewResponse.status, 201);

    const openedDispute = await call('/api/v1/customer/bookings/' + booking.body.data.id + '/disputes', {
      method: 'POST',
      headers: customerHeaders,
      body: JSON.stringify({
        category: 'quality_issue',
        description: 'A recurring issue was found after the technician completed the service.'
      })
    });
    assert.equal(openedDispute.status, 201);
    assert.equal(openedDispute.body.data.status, 'open');

    const disputeMessage = await call('/api/v1/business/disputes/' + openedDispute.body.data.id + '/messages', {
      method: 'POST',
      headers: first.headers,
      body: JSON.stringify({ message: 'We will review the issue and contact the customer.' })
    });
    assert.equal(disputeMessage.status, 201);

    const disputeDetail = await call('/api/v1/customer/disputes/' + openedDispute.body.data.id, {
      headers: customerHeaders
    });
    assert.equal(disputeDetail.status, 200);
    assert.equal(disputeDetail.body.data.status, 'awaiting_customer');
    assert.equal(disputeDetail.body.data.messages.length, 2);

    const previousAdminKey = process.env.SWIFTSERVE_ADMIN_API_KEY;
    process.env.SWIFTSERVE_ADMIN_API_KEY = 'swiftserve-ci-admin-key';
    const disputeReview = await call('/api/v1/admin/disputes/' + openedDispute.body.data.id, {
      method: 'PATCH',
      headers: { 'X-SwiftServe-Admin-Key': 'swiftserve-ci-admin-key' },
      body: JSON.stringify({ status: 'under_review', resolutionNote: 'CI review state.' })
    });
    assert.equal(disputeReview.status, 200);
    assert.equal(disputeReview.body.data.status, 'under_review');

    const disputeResolved = await call('/api/v1/admin/disputes/' + openedDispute.body.data.id, {
      method: 'PATCH',
      headers: { 'X-SwiftServe-Admin-Key': 'swiftserve-ci-admin-key' },
      body: JSON.stringify({ status: 'resolved_customer', resolutionNote: 'The business agreed to a free return visit.' })
    });
    assert.equal(disputeResolved.status, 200);
    assert.equal(disputeResolved.body.data.status, 'resolved_customer');
    if (previousAdminKey === undefined) delete process.env.SWIFTSERVE_ADMIN_API_KEY;
    else process.env.SWIFTSERVE_ADMIN_API_KEY = previousAdminKey;

    const otherBusinessBookings = await call('/api/v1/business/bookings', {
      headers: second.headers
    });
    assert.equal(otherBusinessBookings.status, 200);
    assert.equal(otherBusinessBookings.body.data.length, 0);

    const customerNotifications = await call('/api/v1/notifications', {
      headers: customerHeaders
    });
    assert.equal(customerNotifications.status, 200);
    assert.ok(customerNotifications.body.data.some(item => item.type === 'booking_quote'));

    const bookingEvents = await call('/api/v1/customer/bookings/' + booking.body.data.id + '/events', {
      headers: customerHeaders
    });
    assert.equal(bookingEvents.status, 200);
    assert.ok(bookingEvents.body.data.some(item => item.toStatus === 'quoted'));
    assert.ok(bookingEvents.body.data.some(item => item.toStatus === 'confirmed'));

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
      await pool.query('DELETE FROM service_dispute_messages WHERE dispute_id IN (SELECT id FROM service_disputes WHERE business_id = ANY($1::uuid[]))', [businessIds]);
      await pool.query('DELETE FROM service_disputes WHERE business_id = ANY($1::uuid[])', [businessIds]);
      await pool.query('DELETE FROM service_review_responses WHERE business_id = ANY($1::uuid[])', [businessIds]);
      await pool.query('DELETE FROM service_reviews WHERE business_id = ANY($1::uuid[])', [businessIds]);
      await pool.query('DELETE FROM payment_intents WHERE business_id = ANY($1::uuid[])', [businessIds]);
      await pool.query('DELETE FROM bookings WHERE business_id = ANY($1::uuid[])', [businessIds]);
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
