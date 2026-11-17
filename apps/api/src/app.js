import { randomUUID } from 'node:crypto';
import { handleBusinessApi } from './business_api.js';
import { handleMarketplaceApi, handleNotificationApi } from './marketplace_api.js';
import { acceptInvitation } from './business_resources.js';
import { initializeProviderProfile } from './provider_resources.js';
import { handleAdminProviderApi, handleProviderApi } from './provider_api.js';
import {
  handleAdminFinanceApi, handleBusinessFinanceApi, handleCustomerFinanceApi,
  handlePaystackWebhook, handleProviderFinanceApi
} from './finance_api.js';
import {
  authenticateAccessToken,
  getAccountProfile,
  loginAccount,
  logoutAccessToken,
  registerAccount
} from './auth.js';
import {
  checkDatabase,
  createJob,
  deleteJob,
  getBusinessMembership,
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
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_BODY_BYTES = 1024 * 1024;
const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX = Math.max(1, Number(process.env.AUTH_RATE_LIMIT_MAX || 10));
const authAttempts = new Map();
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

function checkAuthRateLimit(req, res) {
  const key = req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let record = authAttempts.get(key);

  if (!record || record.resetAt <= now) {
    record = { count: 0, resetAt: now + AUTH_RATE_LIMIT_WINDOW_MS };
  }

  if (record.count >= AUTH_RATE_LIMIT_MAX) {
    const retryAfter = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.setHeader('Cache-Control', 'no-store');
    return false;
  }

  record.count += 1;
  authAttempts.set(key, record);

  if (authAttempts.size > 10000) {
    for (const [address, item] of authAttempts) {
      if (item.resetAt <= now) authAttempts.delete(address);
    }
  }
  return true;
}

function logSafeError(event, error) {
  console.error(JSON.stringify({
    event,
    code: typeof error?.code === 'string' ? error.code : 'NO_CODE',
    name: typeof error?.name === 'string' ? error.name : 'UNKNOWN_ERROR'
  }));
}

async function readRawBody(req) {
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
  return Buffer.concat(chunks);
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

function validateRegistration(body) {
  const details = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['Request body must be a JSON object.'];
  }

  const allowed = new Set(['email', 'password', 'fullName', 'accountType', 'businessName', 'countryCode']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) details.push('Unknown field: ' + key + '.');
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    details.push('email must be a valid email address no longer than 254 characters.');
  }
  if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) {
    details.push('password must contain between 12 and 128 characters.');
  }
  if (typeof body.fullName !== 'string' || body.fullName.trim().length < 2 || body.fullName.trim().length > 100) {
    details.push('fullName must be between 2 and 100 characters.');
  }

  const accountType = body.accountType ?? 'customer';
  if (!['customer', 'business', 'provider'].includes(accountType)) {
    details.push('accountType must be customer, business or provider.');
  }

  if (accountType === 'business' &&
      (typeof body.businessName !== 'string' ||
       body.businessName.trim().length < 2 ||
       body.businessName.trim().length > 120)) {
    details.push('businessName must be between 2 and 120 characters for a business account.');
  }
  if (accountType !== 'business' && body.businessName !== undefined) {
    details.push('businessName can only be supplied for a business account.');
  }
  if (accountType === 'provider' &&
      (typeof body.countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(body.countryCode))) {
    details.push('countryCode is required for a provider account.');
  }
  if (body.countryCode !== undefined &&
      (typeof body.countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(body.countryCode))) {
    details.push('countryCode must be a two-letter country code.');
  }

  return details;
}

function validateLogin(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['Request body must be a JSON object.'];
  }
  const details = [];
  for (const key of Object.keys(body)) {
    if (!['email', 'password'].includes(key)) details.push('Unknown field: ' + key + '.');
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    details.push('email must be a valid email address.');
  }
  if (typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 128) {
    details.push('password is required and must not exceed 128 characters.');
  }
  return details;
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

function parseJobRoute(urlPath) {
  const match = urlPath.match(/^\/api\/v1\/jobs(?:\/([^/]+))?$/);
  return match ? match[1] ?? null : undefined;
}

function parseAuthRoute(urlPath) {
  const match = urlPath.match(/^\/api\/v1\/auth\/(register|login|logout|me)$/);
  return match ? match[1] : null;
}

function isAllowedStatusTransition(currentStatus, nextStatus) {
  return currentStatus === nextStatus ||
    Boolean(STATUS_TRANSITIONS[currentStatus]?.has(nextStatus));
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  return match ? match[1] : null;
}

async function authenticateRequest(req) {
  const token = getBearerToken(req);
  if (!token) return null;
  return authenticateAccessToken(token);
}

async function resolveBusinessContext(req, user) {
  const businessId = req.headers['x-swiftserve-business-id'];
  if (!businessId) {
    return { error: errorResponse('BUSINESS_CONTEXT_REQUIRED', 'Set the X-SwiftServe-Business-Id header to an active business you belong to.'), status: 400 };
  }
  if (typeof businessId !== 'string' || !UUID_PATTERN.test(businessId)) {
    return { error: errorResponse('INVALID_BUSINESS_ID', 'The business ID must be a valid UUID.'), status: 400 };
  }

  const membership = await getBusinessMembership(user.id, businessId);
  if (!membership) {
    return { error: errorResponse('BUSINESS_ACCESS_DENIED', 'You do not have active access to this business.'), status: 403 };
  }
  return { businessId, membership };
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

  const authRoute = parseAuthRoute(url.pathname);
  if (authRoute) {
    if (['register', 'login'].includes(authRoute) && req.method === 'POST' &&
        !checkAuthRateLimit(req, res)) {
      return json(res, 429, errorResponse(
        'AUTH_RATE_LIMITED',
        'Too many sign-in or registration attempts. Try again later.'
      ));
    }

    try {
      if (authRoute === 'register') {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          return json(res, 405, errorResponse('METHOD_NOT_ALLOWED', 'HTTP method is not supported for this route.'));
        }
        const body = await readJsonBody(req);
        const details = validateRegistration(body);
        if (details.length) return json(res, 422, errorResponse('VALIDATION_ERROR', 'Registration validation failed.', details));

        const data = await registerAccount({
          email: body.email.trim().toLowerCase(),
          password: body.password,
          fullName: body.fullName.trim(),
          accountType: body.accountType ?? 'customer',
          businessName: typeof body.businessName === 'string' ? body.businessName.trim() : undefined,
          countryCode: typeof body.countryCode === 'string' ? body.countryCode.toUpperCase() : undefined
        });
        if (data.user.accountType === 'provider') {
          await initializeProviderProfile(data.user, body.countryCode.toUpperCase());
        }
        return json(res, 201, { data });
      }

      if (authRoute === 'login') {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          return json(res, 405, errorResponse('METHOD_NOT_ALLOWED', 'HTTP method is not supported for this route.'));
        }
        const body = await readJsonBody(req);
        const details = validateLogin(body);
        if (details.length) return json(res, 422, errorResponse('VALIDATION_ERROR', 'Login validation failed.', details));

        const data = await loginAccount(body.email.trim().toLowerCase(), body.password);
        if (!data) return json(res, 401, errorResponse('INVALID_CREDENTIALS', 'Email or password is incorrect.'));
        return json(res, 200, { data });
      }

      const authenticated = await authenticateRequest(req);
      if (!authenticated) {
        return json(res, 401, errorResponse('UNAUTHENTICATED', 'A valid bearer access token is required.'));
      }

      if (authRoute === 'logout') {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          return json(res, 405, errorResponse('METHOD_NOT_ALLOWED', 'HTTP method is not supported for this route.'));
        }
        await logoutAccessToken(authenticated.tokenHash);
        return json(res, 200, { data: { loggedOut: true } });
      }

      if (authRoute === 'me') {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          return json(res, 405, errorResponse('METHOD_NOT_ALLOWED', 'HTTP method is not supported for this route.'));
        }
        return json(res, 200, { data: await getAccountProfile(authenticated.user) });
      }
    } catch (error) {
      if (error?.code === 'INVALID_JSON') return json(res, 400, errorResponse('INVALID_JSON', error.message));
      if (error?.code === 'UNSUPPORTED_MEDIA_TYPE') return json(res, 415, errorResponse('UNSUPPORTED_MEDIA_TYPE', error.message));
      if (error?.code === 'BODY_TOO_LARGE') return json(res, 413, errorResponse('BODY_TOO_LARGE', error.message));
      if (error?.code === 'EMAIL_ALREADY_REGISTERED') return json(res, 409, errorResponse('EMAIL_ALREADY_REGISTERED', error.message));
      logSafeError('authentication_request_failed', error);
      return json(res, 500, errorResponse('INTERNAL_ERROR', 'An unexpected server error occurred.'));
    }
  }

  if (url.pathname === '/api/v1/auth/invitations/accept') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return json(res, 405, errorResponse('METHOD_NOT_ALLOWED', 'HTTP method is not supported for this route.'));
    }
    try {
      const authenticated = await authenticateRequest(req);
      if (!authenticated) return json(res, 401, errorResponse('UNAUTHENTICATED', 'A valid bearer access token is required.'));
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object' || typeof body.invitationToken !== 'string' ||
          !/^[a-f0-9]{64}$/i.test(body.invitationToken)) {
        return json(res, 422, errorResponse('VALIDATION_ERROR', 'Invitation acceptance requires a valid invitationToken.'));
      }
      const accepted = await acceptInvitation(
        body.invitationToken,
        authenticated.user.id,
        authenticated.user.email
      );
      if (!accepted) return json(res, 404, errorResponse('INVITATION_NOT_FOUND', 'Invitation is invalid, expired, revoked or addressed to another email.'));
      return json(res, 200, { data: accepted });
    } catch (error) {
      if (error?.code === 'INVALID_JSON') return json(res, 400, errorResponse('INVALID_JSON', error.message));
      if (error?.code === 'UNSUPPORTED_MEDIA_TYPE') return json(res, 415, errorResponse('UNSUPPORTED_MEDIA_TYPE', error.message));
      if (error?.code === 'BODY_TOO_LARGE') return json(res, 413, errorResponse('BODY_TOO_LARGE', error.message));
      logSafeError('invitation_acceptance_failed', error);
      return json(res, 500, errorResponse('INTERNAL_ERROR', 'An unexpected server error occurred.'));
    }
  }

  if (url.pathname === '/api/v1/webhooks/paystack') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return json(res, 405, errorResponse('METHOD_NOT_ALLOWED', 'HTTP method is not supported for this route.'));
    }
    try {
      const rawBody = await readRawBody(req);
      const outcome = await handlePaystackWebhook(rawBody, req.headers);
      return json(res, outcome.status, outcome.body);
    } catch (error) {
      if (error?.code === 'BODY_TOO_LARGE') return json(res, 413, errorResponse('BODY_TOO_LARGE', error.message));
      logSafeError('paystack_webhook_failed', error);
      return json(res, 500, errorResponse('INTERNAL_ERROR', 'Webhook processing failed.'));
    }
  }

  if (/^\/api\/v1\/admin\/(?:payouts|disputes)(?:\/|$)/.test(url.pathname)) {
    try {
      const outcome = await handleAdminFinanceApi(req, url);
      if (outcome.noContent) {
        res.statusCode = outcome.status;
        return res.end();
      }
      return json(res, outcome.status, outcome.body);
    } catch (error) {
      logSafeError('admin_finance_route_failed', error);
      return json(res, 500, errorResponse('INTERNAL_ERROR', 'An unexpected server error occurred.'));
    }
  }

  if (url.pathname === '/api/v1/admin/providers/pending' ||
      /^\/api\/v1\/admin\/providers\/[^/]+\/verification$/.test(url.pathname)) {
    try {
      const response = await handleAdminProviderApi(req, url);
      if (response.noContent) {
        res.statusCode = response.status;
        return res.end();
      }
      return json(res, response.status, response.body);
    } catch (error) {
      logSafeError('admin_provider_route_failed', error);
      return json(res, 500, errorResponse('INTERNAL_ERROR', 'An unexpected server error occurred.'));
    }
  }

  if (url.pathname === '/api/v1/provider/payout-account' ||
      url.pathname === '/api/v1/provider/payouts' ||
      url.pathname === '/api/v1/provider/reviews') {
    try {
      const authenticated = await authenticateRequest(req);
      if (!authenticated) return json(res, 401, errorResponse('UNAUTHENTICATED', 'A valid bearer access token is required.'));
      const outcome = await handleProviderFinanceApi(req, url, authenticated.user);
      if (outcome.noContent) {
        res.statusCode = outcome.status;
        return res.end();
      }
      return json(res, outcome.status, outcome.body);
    } catch (error) {
      logSafeError('provider_finance_route_failed', error);
      return json(res, 500, errorResponse('INTERNAL_ERROR', 'An unexpected server error occurred.'));
    }
  }

  if (url.pathname === '/api/v1/provider' || url.pathname.startsWith('/api/v1/provider/')) {
    try {
      const authenticated = await authenticateRequest(req);
      if (!authenticated) return json(res, 401, errorResponse('UNAUTHENTICATED', 'A valid bearer access token is required.'));
      const response = await handleProviderApi(req, url, authenticated.user);
      if (response.noContent) {
        res.statusCode = response.status;
        return res.end();
      }
      return json(res, response.status, response.body);
    } catch (error) {
      logSafeError('provider_route_failed', error);
      return json(res, 500, errorResponse('INTERNAL_ERROR', 'An unexpected server error occurred.'));
    }
  }

  if (url.pathname === '/api/v1/market/services') {
    const response = await handleMarketplaceApi(req, url);
    return json(res, response.status, response.body);
  }

  if (/^\/api\/v1\/customer\/(?:bookings\/[^/]+\/(?:payments|review|disputes)|payments\/[^/]+\/verify|disputes\/[^/]+\/messages)$/.test(url.pathname)) {
    try {
      const authenticated = await authenticateRequest(req);
      if (!authenticated) return json(res, 401, errorResponse('UNAUTHENTICATED', 'A valid bearer access token is required.'));
      const outcome = await handleCustomerFinanceApi(req, url, authenticated.user);
      if (outcome.noContent) {
        res.statusCode = outcome.status;
        return res.end();
      }
      return json(res, outcome.status, outcome.body);
    } catch (error) {
      logSafeError('customer_finance_route_failed', error);
      return json(res, 500, errorResponse('INTERNAL_ERROR', 'An unexpected server error occurred.'));
    }
  }

  if (url.pathname === '/api/v1/customer' || url.pathname.startsWith('/api/v1/customer/')) {
    try {
      const authenticated = await authenticateRequest(req);
      if (!authenticated) return json(res, 401, errorResponse('UNAUTHENTICATED', 'A valid bearer access token is required.'));
      const response = await handleMarketplaceApi(req, url, authenticated.user);
      if (response.noContent) {
        res.statusCode = response.status;
        return res.end();
      }
      return json(res, response.status, response.body);
    } catch (error) {
      logSafeError('customer_route_failed', error);
      return json(res, 500, errorResponse('INTERNAL_ERROR', 'An unexpected server error occurred.'));
    }
  }

  if (url.pathname === '/api/v1/notifications' || url.pathname.startsWith('/api/v1/notifications/')) {
    try {
      const authenticated = await authenticateRequest(req);
      if (!authenticated) return json(res, 401, errorResponse('UNAUTHENTICATED', 'A valid bearer access token is required.'));
      const response = await handleNotificationApi(req, url, authenticated.user);
      if (response.noContent) {
        res.statusCode = response.status;
        return res.end();
      }
      return json(res, response.status, response.body);
    } catch (error) {
      logSafeError('notification_route_failed', error);
      return json(res, 500, errorResponse('INTERNAL_ERROR', 'An unexpected server error occurred.'));
    }
  }

  if (url.pathname === '/api/v1/business/providers' ||
      url.pathname.startsWith('/api/v1/business/providers/') ||
      /^\/api\/v1\/business\/bookings\/[^/]+\/assignments(?:\/[^/]+)?$/.test(url.pathname)) {
    try {
      const authenticated = await authenticateRequest(req);
      if (!authenticated) return json(res, 401, errorResponse('UNAUTHENTICATED', 'A valid bearer access token is required.'));
      const business = await resolveBusinessContext(req, authenticated.user);
      if (business.error) return json(res, business.status, business.error);
      const response = await handleProviderApi(req, url, authenticated.user, business);
      if (response.noContent) {
        res.statusCode = response.status;
        return res.end();
      }
      return json(res, response.status, response.body);
    } catch (error) {
      logSafeError('business_provider_route_failed', error);
      return json(res, 500, errorResponse('INTERNAL_ERROR', 'An unexpected server error occurred.'));
    }
  }

  if (url.pathname === '/api/v1/business/reviews' ||
      url.pathname === '/api/v1/business/disputes' ||
      /^\/api\/v1\/business\/bookings\/[^/]+\/(?:refunds|dispute)$/.test(url.pathname) ||
      /^\/api\/v1\/business\/disputes\/[^/]+\/messages$/.test(url.pathname)) {
    try {
      const authenticated = await authenticateRequest(req);
      if (!authenticated) return json(res, 401, errorResponse('UNAUTHENTICATED', 'A valid bearer access token is required.'));
      const business = await resolveBusinessContext(req, authenticated.user);
      if (business.error) return json(res, business.status, business.error);
      const outcome = await handleBusinessFinanceApi(req, url, authenticated.user, business);
      if (outcome.noContent) {
        res.statusCode = outcome.status;
        return res.end();
      }
      return json(res, outcome.status, outcome.body);
    } catch (error) {
      logSafeError('business_finance_route_failed', error);
      return json(res, 500, errorResponse('INTERNAL_ERROR', 'An unexpected server error occurred.'));
    }
  }

  if (url.pathname === '/api/v1/business/bookings' || url.pathname.startsWith('/api/v1/business/bookings/')) {
    try {
      const authenticated = await authenticateRequest(req);
      if (!authenticated) return json(res, 401, errorResponse('UNAUTHENTICATED', 'A valid bearer access token is required.'));
      const business = await resolveBusinessContext(req, authenticated.user);
      if (business.error) return json(res, business.status, business.error);
      const response = await handleMarketplaceApi(req, url, authenticated.user, business);
      if (response.noContent) {
        res.statusCode = response.status;
        return res.end();
      }
      return json(res, response.status, response.body);
    } catch (error) {
      logSafeError('business_bookings_route_failed', error);
      return json(res, 500, errorResponse('INTERNAL_ERROR', 'An unexpected server error occurred.'));
    }
  }

  if (url.pathname === '/api/v1/business' || url.pathname.startsWith('/api/v1/business/')) {
    try {
      const authenticated = await authenticateRequest(req);
      if (!authenticated) return json(res, 401, errorResponse('UNAUTHENTICATED', 'A valid bearer access token is required.'));
      const business = await resolveBusinessContext(req, authenticated.user);
      if (business.error) return json(res, business.status, business.error);
      const response = await handleBusinessApi(
        req, url, business.businessId, authenticated.user, business.membership
      );
      if (response.noContent) {
        res.statusCode = response.status;
        return res.end();
      }
      return json(res, response.status, response.body);
    } catch (error) {
      logSafeError('business_route_failed', error);
      return json(res, 500, errorResponse('INTERNAL_ERROR', 'An unexpected server error occurred.'));
    }
  }

  const id = parseJobRoute(url.pathname);
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
    const authenticated = await authenticateRequest(req);
    if (!authenticated) {
      return json(res, 401, errorResponse('UNAUTHENTICATED', 'A valid bearer access token is required.'));
    }

    const business = await resolveBusinessContext(req, authenticated.user);
    if (business.error) return json(res, business.status, business.error);

    if (req.method === 'DELETE' && !['owner', 'admin'].includes(business.membership.role)) {
      return json(res, 403, errorResponse('INSUFFICIENT_ROLE', 'Only business owners and administrators can delete service requests.'));
    }

    if (req.method === 'GET' && id === null) {
      const status = url.searchParams.get('status');
      if (status && !ALLOWED_STATUSES.has(status)) {
        return json(res, 400, errorResponse('INVALID_QUERY', 'Invalid status filter.', [
          'status must be one of: ' + [...ALLOWED_STATUSES].join(', ') + '.'
        ]));
      }
      const items = await listJobs(status, business.businessId);
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
      return json(res, 201, {
        data: await createJob(job, business.businessId, authenticated.user.id)
      });
    }

    const current = await getJob(id, business.businessId);
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
      const updated = await updateJob(id, patch, current.status, business.businessId);
      if (!updated) {
        const latest = await getJob(id, business.businessId);
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
      const deleted = await deleteJob(id, business.businessId);
      if (!deleted) {
        return json(res, 404, errorResponse('JOB_NOT_FOUND', 'The service request no longer exists.'));
      }
      res.statusCode = 204;
      return res.end();
    }
  } catch (error) {
    if (error?.code === 'INVALID_JSON') return json(res, 400, errorResponse('INVALID_JSON', error.message));
    if (error?.code === 'UNSUPPORTED_MEDIA_TYPE') return json(res, 415, errorResponse('UNSUPPORTED_MEDIA_TYPE', error.message));
    if (error?.code === 'BODY_TOO_LARGE') return json(res, 413, errorResponse('BODY_TOO_LARGE', error.message));
    logSafeError('request_failed', error);
    return json(res, 500, errorResponse('INTERNAL_ERROR', 'An unexpected server error occurred.'));
  }
}
