import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID, createHmac } from 'node:crypto';
import pg from 'pg';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const hasTestDatabase = typeof testDatabaseUrl === 'string' && testDatabaseUrl.length > 0;

test('PostgreSQL persists accounts and isolates businesses', { skip: !hasTestDatabase }, async () => {
  process.env.NODE_ENV = 'integration';
  process.env.DATABASE_URL = testDatabaseUrl;

  const envKeys = [
    'PAYSTACK_SECRET_KEY','PAYSTACK_WEBHOOK_SECRET','PAYSTACK_API_BASE_URL',
    'PAYSTACK_CALLBACK_URL','SWIFTSERVE_ADMIN_BOOTSTRAP_KEY','SWIFTSERVE_PLATFORM_FEE_BPS'
  ];
  const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const gatewayState = { reference: null, amount: null, currency: null, transferReference: null, transactionStatus: 'success', transferStatus: 'pending', transferCalls: 0 };
  const paystackMock = http.createServer(async (req,res) => {
    const chunks=[];
    for await (const chunk of req) chunks.push(chunk);
    const raw=Buffer.concat(chunks).toString('utf8');
    let body={};
    try { body=raw?JSON.parse(raw):{}; } catch {}
    const send=(data,statusCode=200) => {
      const payload=JSON.stringify({status:true,message:'Mock gateway response',data});
      res.writeHead(statusCode,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)});
      res.end(payload);
    };
    if(req.method==='POST'&&req.url==='/transaction/initialize'){
      gatewayState.reference=body.reference;
      gatewayState.amount=Number(body.amount);
      gatewayState.currency=body.currency;
      return send({authorization_url:'https://checkout.paystack.test/mock-session',access_code:'mock_access_code',reference:body.reference});
    }
    if(req.method==='GET'&&req.url?.startsWith('/transaction/verify/')){
      const reference=decodeURIComponent(req.url.slice('/transaction/verify/'.length));
      return send({
        id:987654321,status:gatewayState.transactionStatus,reference,
        amount:gatewayState.amount,currency:gatewayState.currency,
        paid_at:new Date().toISOString()
      });
    }
    if(req.method==='POST'&&req.url==='/transferrecipient'){
      return send({
        recipient_code:'RCP_MOCK_PROVIDER_01',name:body.name,
        details:{bank_name:'Mock Nigerian Bank',account_number:'******6789'}
      });
    }
    if(req.method==='POST'&&req.url==='/refund'){
      return send({id:7654321,status:'pending',reference:body.reference,amount:body.amount,currency:body.currency});
    }
    if(req.method==='GET'&&req.url?.startsWith('/transfer/verify/')){
      const reference=decodeURIComponent(req.url.slice('/transfer/verify/'.length));
      return send({id:123456789,transfer_code:'TRF_MOCK_PROVIDER_01',status:gatewayState.transferStatus,reference});
    }
    if(req.method==='POST'&&req.url==='/transfer'){
      gatewayState.transferReference=body.reference;
      gatewayState.transferCalls+=1;
      return send({id:123456789,transfer_code:'TRF_MOCK_PROVIDER_01',status:'pending',reference:body.reference});
    }
    return send({message:'Unexpected mock Paystack route: '+req.method+' '+req.url},404);
  });
  await new Promise(resolve => paystackMock.listen(0,'127.0.0.1',resolve));
  process.env.PAYSTACK_SECRET_KEY='sk_test_swiftserve_mock_only';
  process.env.PAYSTACK_WEBHOOK_SECRET='swiftserve_mock_webhook_secret';
  process.env.PAYSTACK_API_BASE_URL='http://127.0.0.1:'+paystackMock.address().port;
  process.env.SWIFTSERVE_ADMIN_BOOTSTRAP_KEY='swiftserve-ci-bootstrap-secret';
  process.env.SWIFTSERVE_PLATFORM_FEE_BPS='1000';

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

  const bootstrap=await call('/api/v1/admin/auth/bootstrap',{
    method:'POST',
    headers:{'X-SwiftServe-Admin-Bootstrap-Key':'swiftserve-ci-bootstrap-secret'},
    body:JSON.stringify({
      email:'integration-super-admin@example.test',
      password:'Integration-Admin#12345',
      fullName:'Integration Super Admin'
    })
  });
  assert.equal(bootstrap.status,201);
  const integrationAdmin=bootstrap.body.data.admin;
  const adminHeaders={Authorization:'Bearer '+bootstrap.body.data.accessToken};

  const financeAdminCreated=await call('/api/v1/admin/admins',{
    method:'POST',headers:adminHeaders,
    body:JSON.stringify({
      email:'integration-finance-admin@example.test',
      password:'Integration-Finance#12345',
      fullName:'Integration Finance Admin',
      role:'finance_admin'
    })
  });
  assert.equal(financeAdminCreated.status,201);
  const financeLogin=await call('/api/v1/admin/auth/login',{
    method:'POST',
    body:JSON.stringify({email:'integration-finance-admin@example.test',password:'Integration-Finance#12345'})
  });
  assert.equal(financeLogin.status,200);
  const financeHeaders={Authorization:'Bearer '+financeLogin.body.data.accessToken};
  assert.equal((await call('/api/v1/admin/finance/summary',{headers:financeHeaders})).status,200);
  assert.equal((await call('/api/v1/admin/providers/pending',{headers:financeHeaders})).status,403);

  const providerAdminCreated=await call('/api/v1/admin/admins',{
    method:'POST',headers:adminHeaders,
    body:JSON.stringify({
      email:'integration-provider-reviewer@example.test',
      password:'Integration-Provider#12345',
      fullName:'Integration Provider Reviewer',
      role:'provider_reviewer'
    })
  });
  assert.equal(providerAdminCreated.status,201);
  const providerAdminLogin=await call('/api/v1/admin/auth/login',{
    method:'POST',
    body:JSON.stringify({email:'integration-provider-reviewer@example.test',password:'Integration-Provider#12345'})
  });
  assert.equal(providerAdminLogin.status,200);
  const providerReviewerHeaders={Authorization:'Bearer '+providerAdminLogin.body.data.accessToken};
  assert.equal((await call('/api/v1/admin/providers/pending',{headers:providerReviewerHeaders})).status,200);
  assert.equal((await call('/api/v1/admin/finance/summary',{headers:providerReviewerHeaders})).status,403);

  async function sendPaystackWebhook(event) {
    const raw=Buffer.from(JSON.stringify(event));
    const timestamp=String(Math.floor(Date.now()/1000));
    const signature=createHmac('sha512',process.env.PAYSTACK_WEBHOOK_SECRET)
      .update(timestamp+'.').update(raw).digest('hex');
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/v1/webhooks/paystack',{
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Paystack-Signature':'t='+timestamp+',v1=ci:'+signature
      },
      body:raw
    });
    const text=await response.text();
    return {status:response.status,body:text?JSON.parse(text):null,raw};
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

    const agreedBooking=await call('/api/v1/customer/bookings/'+booking.body.data.id,{
      headers:customerHeaders
    });
    assert.equal(agreedBooking.status,200);
    assert.equal(agreedBooking.body.data.servicePriceMinor,275000);

    const idempotencyKey='swiftserve-payment-'+randomUUID();
    const payment=await call('/api/v1/customer/bookings/'+booking.body.data.id+'/payments',{
      method:'POST',
      headers:{...customerHeaders,'Idempotency-Key':idempotencyKey},
      body:JSON.stringify({})
    });
    assert.equal(payment.status,201);
    assert.equal(payment.body.data.status,'pending');
    assert.equal(payment.body.data.amountMinor,275000);
    assert.equal(payment.body.data.currencyCode,'NGN');
    assert.equal(payment.body.data.authorizationUrl,'https://checkout.paystack.test/mock-session');

    const paymentRetry=await call('/api/v1/customer/bookings/'+booking.body.data.id+'/payments',{
      method:'POST',
      headers:{...customerHeaders,'Idempotency-Key':idempotencyKey},
      body:JSON.stringify({})
    });
    assert.equal(paymentRetry.status,200);
    assert.equal(paymentRetry.body.data.id,payment.body.data.id);

    gatewayState.transactionStatus='pending';
    const pendingPaymentVerification=await call('/api/v1/customer/payments/'+payment.body.data.id+'/verify',{
      method:'POST',headers:customerHeaders
    });
    assert.equal(pendingPaymentVerification.status,202);
    assert.equal(pendingPaymentVerification.body.data.status,'pending');
    gatewayState.transactionStatus='success';
    const verifiedPayment=await call('/api/v1/customer/payments/'+payment.body.data.id+'/verify',{
      method:'POST',headers:customerHeaders
    });
    assert.equal(verifiedPayment.status,200);
    assert.equal(verifiedPayment.body.data.status,'succeeded');
    assert.equal(verifiedPayment.body.data.amountMinor,275000);

    const savedPaystackSecret=process.env.PAYSTACK_SECRET_KEY;
    delete process.env.PAYSTACK_SECRET_KEY;
    const paymentHistory=await call('/api/v1/customer/bookings/'+booking.body.data.id+'/payments',{
      headers:customerHeaders
    });
    process.env.PAYSTACK_SECRET_KEY=savedPaystackSecret;
    assert.equal(paymentHistory.status,200);
    assert.equal(paymentHistory.body.data.length,1);

    const businessPaymentView=await call('/api/v1/business/bookings/'+booking.body.data.id+'/payments',{
      headers:first.headers
    });
    assert.equal(businessPaymentView.status,200);
    assert.equal(businessPaymentView.body.data[0].amountMinor,275000);

    const refund=await call('/api/v1/business/bookings/'+booking.body.data.id+'/refunds',{
      method:'POST',
      headers:first.headers,
      body:JSON.stringify({
        amountMinor:25000,
        customerNote:'Partial refund requested for a material adjustment.',
        merchantNote:'Approved partial refund in integration test.'
      })
    });
    assert.equal(refund.status,201);
    assert.equal(refund.body.data.status,'pending');
    assert.equal(refund.body.data.amountMinor,25000);

    const refundEvent={
      event:'refund.processed',
      data:{
        id:7654321,
        reference:refund.body.data.reference,
        status:'processed',
        amount:25000,
        currency:'NGN'
      }
    };
    const [refundWebhook,duplicateRefundWebhook]=await Promise.all([
      sendPaystackWebhook(refundEvent),sendPaystackWebhook(refundEvent)
    ]);
    assert.equal(refundWebhook.status,200);
    assert.equal(duplicateRefundWebhook.status,200);
    assert.equal([refundWebhook,duplicateRefundWebhook].filter(item=>item.body?.received===true&&item.body?.duplicate!==true).length,1);
    assert.equal([refundWebhook,duplicateRefundWebhook].filter(item=>item.body?.duplicate===true).length,1);

    const refundList=await call('/api/v1/business/bookings/'+booking.body.data.id+'/refunds',{
      headers:first.headers
    });
    assert.equal(refundList.status,200);
    assert.equal(refundList.body.data[0].status,'processed');

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
    const providerReviewAudit=await pool.query(
      "SELECT actor_key_id,action FROM admin_audit_logs WHERE target_type='provider' AND target_id=$1",
      [providerUser.id]
    );
    assert.equal(providerReviewAudit.rows.length,1);
    assert.equal(providerReviewAudit.rows[0].actor_key_id,'swiftserve-ci-admin');
    assert.equal(providerReviewAudit.rows[0].action,'provider.verification.reviewed');

    const payoutAccount=await call('/api/v1/provider/payout-account',{
      method:'POST',
      headers:providerHeaders,
      body:JSON.stringify({
        accountName:'Integration Provider',
        accountNumber:'0123456789',
        bankCode:'058',
        currencyCode:'NGN'
      })
    });
    assert.equal(payoutAccount.status,201);
    assert.equal(payoutAccount.body.data.lastFour,'6789');
    assert.equal(Object.prototype.hasOwnProperty.call(payoutAccount.body.data,'accountNumber'),false);

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

    const adminPayouts=await call('/api/v1/admin/payouts/pending',{
      headers:adminHeaders
    });
    assert.equal(adminPayouts.status,200);
    const payout=adminPayouts.body.data.find(item=>item.bookingId===booking.body.data.id);
    assert.ok(payout);
    assert.equal(payout.grossAmountMinor,250000);
    assert.equal(payout.platformFeeMinor,25000);
    assert.equal(payout.netAmountMinor,225000);
    assert.equal(payout.status,'pending');

    const payoutStarted=await call('/api/v1/admin/payouts/'+payout.id+'/process',{
      method:'POST',
      headers:adminHeaders
    });
    assert.equal(payoutStarted.status,202);
    assert.equal(payoutStarted.body.data.status,'processing');
    assert.equal(payoutStarted.body.data.transferReference,gatewayState.transferReference);
    const payoutRetryWhilePending=await call('/api/v1/admin/payouts/'+payout.id+'/process',{
      method:'POST',headers:adminHeaders
    });
    assert.equal(payoutRetryWhilePending.status,202);
    assert.equal(payoutRetryWhilePending.body.data.status,'processing');
    assert.equal(gatewayState.transferCalls,1);

    const simulateMissedPaymentCallback=await pool.query(
      "UPDATE payment_intents SET status='pending',updated_at=now() WHERE id=$1 RETURNING id",
      [payment.body.data.id]
    );
    assert.equal(simulateMissedPaymentCallback.rowCount,1);

    gatewayState.transactionStatus='success';
    gatewayState.transferStatus='success';
    const reconciliation=await call('/api/v1/admin/finance/reconciliation',{
      method:'POST',
      headers:adminHeaders,
      body:JSON.stringify({limit:20})
    });
    assert.equal(reconciliation.status,201);
    assert.equal(reconciliation.body.data.run.status,'completed');
    assert.equal(reconciliation.body.data.run.scannedCount,2);
    assert.equal(reconciliation.body.data.run.updatedCount,2);
    assert.deepEqual(reconciliation.body.data.items.map(item=>item.entityType),['payment','payout']);
    assert.ok(reconciliation.body.data.items.every(item=>item.outcome==='updated'));

    assert.equal(reconciliation.body.data.run.actorAdminId,integrationAdmin.id);
    const reconciliationDetail=await call('/api/v1/admin/finance/reconciliation/'+reconciliation.body.data.run.id,{
      headers:adminHeaders
    });
    assert.equal(reconciliationDetail.status,200);
    assert.equal(reconciliationDetail.body.data.items.length,2);
    assert.ok(reconciliationDetail.body.data.items.every(item=>item.providerStatus==='success'));

    const financeSummary=await call('/api/v1/admin/finance/summary',{
      headers:adminHeaders
    });
    assert.equal(financeSummary.status,200);
    assert.equal(financeSummary.body.data.processing_payouts,0);

    const auditLogs=await call('/api/v1/admin/audit-logs?limit=100',{
      headers:adminHeaders
    });
    assert.equal(auditLogs.status,200);
    assert.ok(auditLogs.body.data.some(item=>item.action==='finance.payout.transfer_requested'));
    assert.ok(auditLogs.body.data.some(item=>item.action==='finance.reconciliation.completed'));
    assert.ok(auditLogs.body.data.some(item=>item.actorAdminId===integrationAdmin.id));
    assert.ok(auditLogs.body.data.every(item=>item.actorKeyId.startsWith('admin:')));

    const transferWebhook=await sendPaystackWebhook({
      event:'transfer.success',
      data:{
        id:123456789,
        reference:gatewayState.transferReference,
        status:'success',
        amount:225000,
        currency:'NGN'
      }
    });
    assert.equal(transferWebhook.status,200);
    assert.equal(transferWebhook.body.received,true);

    const duplicateTransferWebhook=await sendPaystackWebhook({
      event:'transfer.success',
      data:{
        id:123456789,
        reference:gatewayState.transferReference,
        status:'success',
        amount:225000,
        currency:'NGN'
      }
    });
    assert.equal(duplicateTransferWebhook.status,200);
    assert.equal(duplicateTransferWebhook.body.duplicate,true);

    const providerPayouts=await call('/api/v1/provider/payouts',{headers:providerHeaders});
    assert.equal(providerPayouts.status,200);
    assert.equal(providerPayouts.body.data[0].status,'paid');
    assert.equal(providerPayouts.body.data[0].netAmountMinor,225000);

    const refundAfterPayout=await call('/api/v1/business/bookings/'+booking.body.data.id+'/refunds',{
      method:'POST',
      headers:first.headers,
      body:JSON.stringify({amountMinor:10000,customerNote:'Regression test after provider payout.'})
    });
    assert.equal(refundAfterPayout.status,409);
    assert.equal(refundAfterPayout.body.error.code,'REFUND_NOT_AVAILABLE');

    const transferReversed=await sendPaystackWebhook({
      event:'transfer.reversed',
      data:{
        id:123456789,
        reference:gatewayState.transferReference,
        status:'reversed',
        amount:225000,
        currency:'NGN'
      }
    });
    assert.equal(transferReversed.status,200);
    const reversedPayouts=await call('/api/v1/provider/payouts',{headers:providerHeaders});
    assert.equal(reversedPayouts.status,200);
    assert.equal(reversedPayouts.body.data[0].status,'reversed');

    const review=await call('/api/v1/customer/bookings/'+booking.body.data.id+'/review',{
      method:'POST',
      headers:customerHeaders,
      body:JSON.stringify({rating:5,comment:'The work was completed as agreed.'})
    });
    assert.equal(review.status,201);
    assert.equal(review.body.data.rating,5);

    const businessReviews=await call('/api/v1/business/reviews',{headers:first.headers});
    assert.equal(businessReviews.status,200);
    assert.ok(businessReviews.body.data.some(item=>item.bookingId===booking.body.data.id));
    const providerReviews=await call('/api/v1/provider/reviews',{headers:providerHeaders});
    assert.equal(providerReviews.status,200);
    assert.ok(providerReviews.body.data.some(item=>item.bookingId===booking.body.data.id));

    const dispute=await call('/api/v1/customer/bookings/'+booking.body.data.id+'/disputes',{
      method:'POST',
      headers:customerHeaders,
      body:JSON.stringify({
        category:'service_quality',
        description:'The customer wants a follow-up review of one part of the finished service.',
        requestedResolution:'refund_partial'
      })
    });
    assert.equal(dispute.status,201);
    assert.equal(dispute.body.data.status,'open');

    const customerDispute=await call('/api/v1/customer/bookings/'+booking.body.data.id+'/disputes',{
      headers:customerHeaders
    });
    assert.equal(customerDispute.status,200);
    assert.equal(customerDispute.body.data.id,dispute.body.data.id);

    const customerDisputeMessages=await call('/api/v1/customer/disputes/'+dispute.body.data.id+'/messages',{
      headers:customerHeaders
    });
    assert.equal(customerDisputeMessages.status,200);
    assert.equal(customerDisputeMessages.body.data.length,1);

    const businessDisputeMessage=await call('/api/v1/business/disputes/'+dispute.body.data.id+'/messages',{
      method:'POST',
      headers:first.headers,
      body:JSON.stringify({message:'We have reviewed the service notes and will investigate.'})
    });
    assert.equal(businessDisputeMessage.status,201);

    const customerFollowup=await call('/api/v1/customer/disputes/'+dispute.body.data.id+'/messages',{
      method:'POST',
      headers:customerHeaders,
      body:JSON.stringify({message:'Thank you. Please confirm the proposed resolution.'})
    });
    assert.equal(customerFollowup.status,201);

    const adminDisputes=await call('/api/v1/admin/disputes/pending',{
      headers:adminHeaders
    });
    assert.equal(adminDisputes.status,200);
    assert.ok(adminDisputes.body.data.some(item=>item.id===dispute.body.data.id));

    const resolvedDispute=await call('/api/v1/admin/disputes/'+dispute.body.data.id,{
      method:'PATCH',
      headers:adminHeaders,
      body:JSON.stringify({
        status:'resolved',
        resolution:'refund_partial',
        note:'The partial refund has been recorded and the issue is closed.'
      })
    });
    assert.equal(resolvedDispute.status,200);
    assert.equal(resolvedDispute.body.data.status,'resolved');

    const finalBooking = await call('/api/v1/customer/bookings/' + booking.body.data.id, {
      headers: customerHeaders
    });
    assert.equal(finalBooking.status, 200);
    assert.equal(finalBooking.body.data.status, 'completed');

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
    paystackMock.closeAllConnections?.();
    await new Promise(resolve => paystackMock.close(resolve));
    await pool.query("DELETE FROM finance_reconciliation_runs WHERE actor_key_id='swiftserve-ci-admin'");
    await pool.query("DELETE FROM admin_audit_logs WHERE actor_key_id='swiftserve-ci-admin'");
    if (businessIds.length) {
      await pool.query('DELETE FROM dispute_messages WHERE dispute_id IN (SELECT id FROM disputes WHERE business_id=ANY($1::uuid[]))',[businessIds]);
      await pool.query('DELETE FROM dispute_events WHERE dispute_id IN (SELECT id FROM disputes WHERE business_id=ANY($1::uuid[]))',[businessIds]);
      await pool.query('DELETE FROM disputes WHERE business_id=ANY($1::uuid[])',[businessIds]);
      await pool.query('DELETE FROM booking_reviews WHERE business_id=ANY($1::uuid[])',[businessIds]);
      await pool.query('DELETE FROM refunds WHERE business_id=ANY($1::uuid[])',[businessIds]);
      await pool.query('DELETE FROM provider_payout_events WHERE payout_id IN (SELECT id FROM provider_payouts WHERE business_id=ANY($1::uuid[]))',[businessIds]);
      await pool.query('DELETE FROM provider_payouts WHERE business_id=ANY($1::uuid[])',[businessIds]);
      await pool.query('DELETE FROM payment_events WHERE payment_intent_id IN (SELECT id FROM payment_intents WHERE business_id=ANY($1::uuid[]))',[businessIds]);
      await pool.query('DELETE FROM payment_intents WHERE business_id=ANY($1::uuid[])',[businessIds]);
      await pool.query('DELETE FROM bookings WHERE business_id = ANY($1::uuid[])', [businessIds]);
      await pool.query('DELETE FROM service_requests WHERE business_id = ANY($1::uuid[])', [businessIds]);
      await pool.query('DELETE FROM businesses WHERE id = ANY($1::uuid[])', [businessIds]);
    }
    if (userIds.length) {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    }
    await pool.end();
    await closeDatabase();
    for(const key of envKeys){
      if(previousEnv[key]===undefined)delete process.env[key];
      else process.env[key]=previousEnv[key];
    }
  }
});
