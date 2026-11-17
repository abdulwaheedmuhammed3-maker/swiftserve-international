import { randomUUID } from 'node:crypto';
import {
  getBusinessSummary,
  updateBusinessSummary,
  listBusinessMembers,
  updateBusinessMemberRole,
  removeBusinessMember
} from './repository.js';
import {
  listServices, createService, getService, updateService, deleteService,
  listBranches, createBranch, getBranch, updateBranch, deleteBranch,
  listHours, setHours, setBranchHours,
  listAreas, createArea, updateArea, deleteArea,
  createInvitation, listInvitations, revokeInvitation
} from './business_resources.js';

const SERVICES = new Set([
  'cleaning','laundry','electrical','plumbing','ac-repair','appliance-repair','errand'
]);
const ROLES = new Set(['admin','manager','staff']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function result(status, body, noContent = false) {
  return { status, body, noContent };
}

function fail(status, code, message, details = []) {
  return result(status, { error: { code, message, details } });
}

function ok(data, status = 200) {
  return result(status, { data });
}

async function bodyJson(req) {
  const type = req.headers['content-type'] || '';
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(type)) {
    const error = new Error('Content-Type must be application/json.');
    error.code = 'UNSUPPORTED_MEDIA_TYPE';
    throw error;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      const error = new Error('Request body exceeds 1 MB.');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Malformed JSON body.');
    error.code = 'INVALID_JSON';
    throw error;
  }
}

function validateObject(body, allowedKeys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['Request body must be a JSON object.'];
  return Object.keys(body).filter(key => !allowedKeys.includes(key)).map(key => 'Unknown field: ' + key + '.');
}

function validateProfile(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['Request body must be a JSON object.'];
  const allowed = ['name','description','businessEmail','phoneE164','website','countryCode','currencyCode','timeZone'];
  const errors = validateObject(body, allowed);
  if (!errors.length && Object.keys(body).length === 0) errors.push('At least one field is required.');
  if ('name' in body && (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.trim().length > 120)) errors.push('name must be 2 to 120 characters.');
  if ('description' in body && body.description !== null && (typeof body.description !== 'string' || body.description.trim().length > 2000)) errors.push('description must not exceed 2,000 characters.');
  if ('businessEmail' in body && body.businessEmail !== null && (typeof body.businessEmail !== 'string' || body.businessEmail.length > 254 || !EMAIL.test(body.businessEmail.trim()))) errors.push('businessEmail must be a valid email address.');
  if ('phoneE164' in body && body.phoneE164 !== null && (typeof body.phoneE164 !== 'string' || !/^\+[1-9]\d{7,14}$/.test(body.phoneE164))) errors.push('phoneE164 must use international E.164 format.');
  if ('website' in body && body.website !== null) {
    try {
      const url = new URL(body.website);
      if (url.protocol !== 'https:' || url.username || url.password) errors.push('website must be an HTTPS URL.');
    } catch { errors.push('website must be a valid HTTPS URL.'); }
  }
  if ('countryCode' in body && body.countryCode !== null && (typeof body.countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(body.countryCode))) errors.push('countryCode must be a two-letter code.');
  if ('currencyCode' in body && body.currencyCode !== null && (typeof body.currencyCode !== 'string' || !/^[A-Za-z]{3}$/.test(body.currencyCode))) errors.push('currencyCode must be a three-letter code.');
  if ('timeZone' in body && body.timeZone !== null) {
    try { new Intl.DateTimeFormat('en', { timeZone: body.timeZone }); }
    catch { errors.push('timeZone must be a valid IANA time-zone identifier.'); }
  }
  return errors;
}

function validateService(body, partial = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['Request body must be a JSON object.'];
  const allowed = ['category','name','slug','description','pricingModel','currencyCode','priceMinor','durationMinutes','isActive'];
  const errors = validateObject(body, allowed);
  if (!partial || 'category' in body) if (typeof body.category !== 'string' || !SERVICES.has(body.category)) errors.push('category is not a supported service category.');
  if (!partial || 'name' in body) if (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.trim().length > 120) errors.push('name must be 2 to 120 characters.');
  if (!partial || 'slug' in body) if (typeof body.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.slug)) errors.push('slug must use lowercase letters, numbers and hyphens.');
  if (!partial || 'description' in body) if (typeof body.description !== 'string' || body.description.trim().length < 10 || body.description.trim().length > 1500) errors.push('description must be 10 to 1,500 characters.');
  if (!partial || 'pricingModel' in body) if (!['fixed','hourly','quote'].includes(body.pricingModel)) errors.push('pricingModel must be fixed, hourly or quote.');
  if (!partial || 'currencyCode' in body) if (typeof body.currencyCode !== 'string' || !/^[A-Za-z]{3}$/.test(body.currencyCode)) errors.push('currencyCode must be a three-letter code.');
  const pricing = body.pricingModel;
  if (pricing === 'quote') {
    if ('priceMinor' in body && body.priceMinor !== null) errors.push('Quote pricing must not include priceMinor.');
    if (!partial && body.priceMinor !== undefined && body.priceMinor !== null) errors.push('Quote pricing must not include priceMinor.');
  } else if (!partial || 'priceMinor' in body) {
    if (!Number.isSafeInteger(body.priceMinor) || body.priceMinor < 0) errors.push('priceMinor must be a non-negative integer in the smallest currency unit.');
  }
  if ('durationMinutes' in body && body.durationMinutes !== null && (!Number.isInteger(body.durationMinutes) || body.durationMinutes < 5 || body.durationMinutes > 1440)) errors.push('durationMinutes must be between 5 and 1,440.');
  if ('isActive' in body && typeof body.isActive !== 'boolean') errors.push('isActive must be boolean.');
  return errors;
}

function validateBranch(body, partial = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['Request body must be a JSON object.'];
  const allowed = ['name','countryCode','addressLine1','addressLine2','city','region','postalCode','phoneE164','timeZone','isPrimary','status'];
  const errors = validateObject(body, allowed);
  const required = ['name','countryCode','addressLine1','city'];
  for (const key of required) {
    const minimum = key === 'addressLine1' ? 3 : 2;
    if ((!partial || key in body) &&
        (typeof body[key] !== 'string' || body[key].trim().length < minimum)) {
      errors.push(key + ' is required and must contain at least ' + minimum + ' characters.');
    }
  }
  if ('name' in body && typeof body.name === 'string' && body.name.trim().length > 100) errors.push('name must not exceed 100 characters.');
  if ('countryCode' in body && (typeof body.countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(body.countryCode))) errors.push('countryCode must be a two-letter code.');
  if ('addressLine1' in body && typeof body.addressLine1 === 'string' && body.addressLine1.trim().length > 160) errors.push('addressLine1 must not exceed 160 characters.');
  if ('addressLine2' in body && body.addressLine2 !== null && (typeof body.addressLine2 !== 'string' || body.addressLine2.length > 160)) errors.push('addressLine2 must not exceed 160 characters.');
  if ('city' in body && typeof body.city === 'string' && body.city.trim().length > 100) errors.push('city must not exceed 100 characters.');
  if ('region' in body && body.region !== null && (typeof body.region !== 'string' || body.region.length > 100)) errors.push('region must not exceed 100 characters.');
  if ('postalCode' in body && body.postalCode !== null && (typeof body.postalCode !== 'string' || body.postalCode.length > 24)) errors.push('postalCode must not exceed 24 characters.');
  if ('phoneE164' in body && body.phoneE164 !== null && (typeof body.phoneE164 !== 'string' || !/^\+[1-9]\d{7,14}$/.test(body.phoneE164))) errors.push('phoneE164 must use E.164 format.');
  if ('timeZone' in body && body.timeZone !== null) {
    try { new Intl.DateTimeFormat('en', { timeZone: body.timeZone }); }
    catch { errors.push('timeZone must be a valid IANA time-zone identifier.'); }
  }
  if ('isPrimary' in body && typeof body.isPrimary !== 'boolean') errors.push('isPrimary must be boolean.');
  if ('status' in body && !['active','inactive'].includes(body.status)) errors.push('status must be active or inactive.');
  if (partial && Object.keys(body).length === 0) errors.push('At least one field is required.');
  return errors;
}

function validateArea(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['Request body must be a JSON object.'];
  const errors = validateObject(body, ['branchId','countryCode','region','city','postalCodePrefix']);
  if (!/^[A-Za-z]{2}$/.test(body.countryCode || '')) errors.push('countryCode must be a two-letter code.');
  if (![body.region,body.city,body.postalCodePrefix].some(value => typeof value === 'string' && value.trim().length)) errors.push('Provide at least one of region, city or postalCodePrefix.');
  if (body.branchId !== undefined && body.branchId !== null && (typeof body.branchId !== 'string' || !UUID.test(body.branchId))) errors.push('branchId must be a valid UUID.');
  if (body.region !== undefined && body.region !== null && (typeof body.region !== 'string' || body.region.length > 100)) errors.push('region must not exceed 100 characters.');
  if (body.city !== undefined && body.city !== null && (typeof body.city !== 'string' || body.city.length > 100)) errors.push('city must not exceed 100 characters.');
  if (body.postalCodePrefix !== undefined && body.postalCodePrefix !== null && (typeof body.postalCodePrefix !== 'string' || body.postalCodePrefix.length > 24)) errors.push('postalCodePrefix must not exceed 24 characters.');
  return errors;
}

function validateHours(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['Request body must be a JSON object.'];
  const errors = validateObject(body, ['branchId','dayOfWeek','opensAt','closesAt','isClosed']);
  if (!Number.isInteger(body.dayOfWeek) || body.dayOfWeek < 0 || body.dayOfWeek > 6) errors.push('dayOfWeek must be an integer from 0 (Sunday) to 6 (Saturday).');
  if (typeof body.isClosed !== 'boolean') errors.push('isClosed must be boolean.');
  if (body.isClosed === false) {
    if (!TIME.test(body.opensAt || '') || !TIME.test(body.closesAt || '')) errors.push('opensAt and closesAt must use 24-hour HH:MM format.');
    else if (body.opensAt >= body.closesAt) errors.push('closesAt must be later than opensAt; overnight schedules are not yet supported.');
  } else if (body.isClosed === true && (body.opensAt != null || body.closesAt != null)) {
    errors.push('Closed days must not include opensAt or closesAt.');
  }
  if (body.branchId !== undefined && body.branchId !== null && (typeof body.branchId !== 'string' || !UUID.test(body.branchId))) errors.push('branchId must be a valid UUID.');
  return errors;
}

function validBusinessId(id) {
  return typeof id === 'string' && UUID.test(id);
}

export async function handleBusinessApi(req, url, businessId, user, membership) {
  const prefix = '/api/v1/business';
  const path = url.pathname.slice(prefix.length) || '/';
  const method = req.method;
  const canManage = ['owner','admin','manager'].includes(membership.role);
  const canAdmin = ['owner','admin'].includes(membership.role);

  try {
    if (path === '/profile') {
      if (method === 'GET') {
        const profile = await getBusinessSummary(businessId);
        return profile ? ok(profile) : fail(404,'BUSINESS_NOT_FOUND','Business not found.');
      }
      if (method === 'PATCH') {
        if (!canAdmin) return fail(403,'INSUFFICIENT_ROLE','Only business owners and administrators can edit the business profile.');
        const body = await bodyJson(req);
        const errors = validateProfile(body);
        if (errors.length) return fail(422,'VALIDATION_ERROR','Business profile validation failed.',errors);
        const patch = { ...body };
        if (typeof patch.name === 'string') patch.name = patch.name.trim();
        if (typeof patch.businessEmail === 'string') patch.businessEmail = patch.businessEmail.trim().toLowerCase();
        if (typeof patch.countryCode === 'string') patch.countryCode = patch.countryCode.toUpperCase();
        if (typeof patch.currencyCode === 'string') patch.currencyCode = patch.currencyCode.toUpperCase();
        const profile = await updateBusinessSummary(businessId,patch);
        return profile ? ok(profile) : fail(404,'BUSINESS_NOT_FOUND','Business not found.');
      }
      return fail(405,'METHOD_NOT_ALLOWED','Method not allowed for business profile.');
    }

    if (path === '/services') {
      if (method === 'GET') return ok(await listServices(businessId));
      if (method === 'POST') {
        if (!canManage) return fail(403,'INSUFFICIENT_ROLE','Your role cannot manage the service catalogue.');
        const body = await bodyJson(req);
        const errors = validateService(body);
        if (errors.length) return fail(422,'VALIDATION_ERROR','Service validation failed.',errors);
        body.name = body.name.trim();
        body.slug = body.slug.trim();
        body.description = body.description.trim();
        body.currencyCode = body.currencyCode.toUpperCase();
        const service = await createService(businessId,body);
        return ok(service,201);
      }
      return fail(405,'METHOD_NOT_ALLOWED','Method not allowed for service collection.');
    }

    const serviceMatch = path.match(/^\/services\/([^/]+)$/);
    if (serviceMatch) {
      const id = serviceMatch[1];
      if (!validBusinessId(id)) return fail(400,'INVALID_ID','Service ID must be a valid UUID.');
      const existing = await getService(businessId,id);
      if (!existing) return fail(404,'SERVICE_NOT_FOUND','Service not found.');
      if (method === 'GET') return ok(existing);
      if (method === 'PATCH') {
        if (!canManage) return fail(403,'INSUFFICIENT_ROLE','Your role cannot manage the service catalogue.');
        const body = await bodyJson(req);
        const errors = validateService(body,true);
        if (errors.length) return fail(422,'VALIDATION_ERROR','Service update validation failed.',errors);
        if ('name' in body) body.name=body.name.trim();
        if ('slug' in body) body.slug=body.slug.trim();
        if ('description' in body) body.description=body.description.trim();
        if ('currencyCode' in body) body.currencyCode=body.currencyCode.toUpperCase();
        if ('pricingModel' in body && !('priceMinor' in body)) {
          if (body.pricingModel === 'quote') body.priceMinor=null;
          else if (existing.priceMinor === null) return fail(422,'VALIDATION_ERROR','Provide priceMinor when switching from quote pricing.');
        }
        const updated=await updateService(businessId,id,body);
        return updated ? ok(updated) : fail(404,'SERVICE_NOT_FOUND','Service not found.');
      }
      if (method === 'DELETE') {
        if (!canAdmin) return fail(403,'INSUFFICIENT_ROLE','Only business owners and administrators can delete services.');
        return await deleteService(businessId,id) ? result(204,undefined,true) : fail(404,'SERVICE_NOT_FOUND','Service not found.');
      }
      return fail(405,'METHOD_NOT_ALLOWED','Method not allowed for service.');
    }

    if (path === '/branches') {
      if (method === 'GET') return ok(await listBranches(businessId));
      if (method === 'POST') {
        if (!canManage) return fail(403,'INSUFFICIENT_ROLE','Your role cannot manage branches.');
        const body=await bodyJson(req);
        const errors=validateBranch(body,false);
        if (errors.length) return fail(422,'VALIDATION_ERROR','Branch validation failed.',errors);
        body.name=body.name.trim();
        body.countryCode=body.countryCode.toUpperCase();
        body.addressLine1=body.addressLine1.trim();
        body.city=body.city.trim();
        const branch=await createBranch(businessId,body);
        return ok(branch,201);
      }
      return fail(405,'METHOD_NOT_ALLOWED','Method not allowed for branch collection.');
    }

    const branchMatch=path.match(/^\/branches\/([^/]+)$/);
    if (branchMatch) {
      const id=branchMatch[1];
      if (!validBusinessId(id)) return fail(400,'INVALID_ID','Branch ID must be a valid UUID.');
      const existing=await getBranch(businessId,id);
      if (!existing) return fail(404,'BRANCH_NOT_FOUND','Branch not found.');
      if (method==='GET') return ok(existing);
      if (method==='PATCH') {
        if (!canManage) return fail(403,'INSUFFICIENT_ROLE','Your role cannot manage branches.');
        const body=await bodyJson(req);
        const errors=validateBranch(body,true);
        if (errors.length) return fail(422,'VALIDATION_ERROR','Branch update validation failed.',errors);
        if (body.countryCode) body.countryCode=body.countryCode.toUpperCase();
        const updated=await updateBranch(businessId,id,body);
        return updated ? ok(updated) : fail(404,'BRANCH_NOT_FOUND','Branch not found.');
      }
      if (method==='DELETE') {
        if (!canAdmin) return fail(403,'INSUFFICIENT_ROLE','Only owners and admins can delete branches.');
        return await deleteBranch(businessId,id) ? result(204,undefined,true) : fail(404,'BRANCH_NOT_FOUND','Branch not found.');
      }
      return fail(405,'METHOD_NOT_ALLOWED','Method not allowed for branch.');
    }

    if (path === '/hours') {
      if (method==='GET') {
        const branchId=url.searchParams.get('branchId');
        if (branchId && !validBusinessId(branchId)) return fail(400,'INVALID_ID','branchId must be a valid UUID.');
        return ok(await listHours(businessId,branchId||null));
      }
      if (method==='PUT') {
        if (!canManage) return fail(403,'INSUFFICIENT_ROLE','Your role cannot manage opening hours.');
        const body=await bodyJson(req);
        const errors=validateHours(body);
        if (errors.length) return fail(422,'VALIDATION_ERROR','Opening-hours validation failed.',errors);
        const saved=body.branchId
          ? await setBranchHours(businessId,body.branchId,body)
          : await setHours(businessId,body);
        return saved ? ok(saved) : fail(404,'BRANCH_NOT_FOUND','The selected branch does not belong to this business.');
      }
      return fail(405,'METHOD_NOT_ALLOWED','Method not allowed for opening hours.');
    }

    if (path === '/service-areas') {
      if (method==='GET') return ok(await listAreas(businessId));
      if (method==='POST') {
        if (!canManage) return fail(403,'INSUFFICIENT_ROLE','Your role cannot manage service areas.');
        const body=await bodyJson(req);
        const errors=validateArea(body);
        if (errors.length) return fail(422,'VALIDATION_ERROR','Service-area validation failed.',errors);
        body.countryCode=body.countryCode.toUpperCase();
        const area=await createArea(businessId,body);
        return area ? ok(area,201) : fail(404,'BRANCH_NOT_FOUND','The selected branch does not belong to this business.');
      }
      return fail(405,'METHOD_NOT_ALLOWED','Method not allowed for service areas.');
    }

    const areaMatch=path.match(/^\/service-areas\/([^/]+)$/);
    if (areaMatch) {
      const id=areaMatch[1];
      if (!validBusinessId(id)) return fail(400,'INVALID_ID','Service-area ID must be a valid UUID.');
      if (method==='PATCH') {
        if (!canManage) return fail(403,'INSUFFICIENT_ROLE','Your role cannot manage service areas.');
        const body=await bodyJson(req);
        const errors=validateObject(body,['countryCode','region','city','postalCodePrefix','isActive']);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(422,'VALIDATION_ERROR','Service-area update validation failed.',errors);
        if (!('countryCode' in body || 'region' in body || 'city' in body || 'postalCodePrefix' in body || 'isActive' in body)) errors.push('At least one field is required.');
        if ('countryCode' in body && !/^[A-Za-z]{2}$/.test(body.countryCode)) errors.push('countryCode must be a two-letter code.');
        if ('isActive' in body && typeof body.isActive!=='boolean') errors.push('isActive must be boolean.');
        if (errors.length) return fail(422,'VALIDATION_ERROR','Service-area update validation failed.',errors);
        if (body.countryCode) body.countryCode=body.countryCode.toUpperCase();
        const updated=await updateArea(businessId,id,body);
        return updated ? ok(updated) : fail(404,'AREA_NOT_FOUND','Service area not found.');
      }
      if (method==='DELETE') {
        if (!canAdmin) return fail(403,'INSUFFICIENT_ROLE','Only owners and admins can delete service areas.');
        return await deleteArea(businessId,id) ? result(204,undefined,true) : fail(404,'AREA_NOT_FOUND','Service area not found.');
      }
      return fail(405,'METHOD_NOT_ALLOWED','Method not allowed for service area.');
    }

    if (path === '/team/members') {
      if (method==='GET') return ok(await listBusinessMembers(businessId));
      return fail(405,'METHOD_NOT_ALLOWED','Method not allowed for team members.');
    }

    const memberMatch=path.match(/^\/team\/members\/([^/]+)$/);
    if (memberMatch) {
      const userId=memberMatch[1];
      if (!validBusinessId(userId)) return fail(400,'INVALID_ID','User ID must be a valid UUID.');
      if (!canAdmin) return fail(403,'INSUFFICIENT_ROLE','Only owners and administrators can manage team members.');
      if (userId===user.id) return fail(409,'SELF_MEMBERSHIP_CHANGE','Use a different business administrator to change your own membership.');
      if (method==='PATCH') {
        const body=await bodyJson(req);
        const errors=validateObject(body,['role']);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(422,'VALIDATION_ERROR','Team role validation failed.',errors);
        if (!ROLES.has(body.role)) errors.push('role must be admin, manager or staff.');
        if (errors.length) return fail(422,'VALIDATION_ERROR','Team role validation failed.',errors);
        const updated=await updateBusinessMemberRole(businessId,userId,body.role);
        return updated ? ok(updated) : fail(404,'MEMBERSHIP_NOT_FOUND','Membership not found or cannot be changed.');
      }
      if (method==='DELETE') {
        return await removeBusinessMember(businessId,userId) ? result(204,undefined,true) : fail(404,'MEMBERSHIP_NOT_FOUND','Membership not found or cannot be removed.');
      }
      return fail(405,'METHOD_NOT_ALLOWED','Method not allowed for team member.');
    }

    if (path === '/team/invitations') {
      if (method==='GET') {
        if (!canAdmin) return fail(403,'INSUFFICIENT_ROLE','Only owners and administrators can view invitations.');
        return ok(await listInvitations(businessId));
      }
      if (method==='POST') {
        if (!canAdmin) return fail(403,'INSUFFICIENT_ROLE','Only owners and administrators can invite team members.');
        const body=await bodyJson(req);
        const errors=validateObject(body,['email','role']);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(422,'VALIDATION_ERROR','Invitation validation failed.',errors);
        if (typeof body.email!=='string' || body.email.length>254 || !EMAIL.test(body.email.trim())) errors.push('email must be valid.');
        if (!ROLES.has(body.role)) errors.push('role must be admin, manager or staff.');
        if (errors.length) return fail(422,'VALIDATION_ERROR','Invitation validation failed.',errors);
        const data=await createInvitation(businessId,{email:body.email.trim().toLowerCase(),role:body.role},user.id);
        return ok({
          invitation:data.invitation,
          invitationToken:data.invitationToken,
          delivery:'pending',
          notice:'The token is returned once because no email delivery provider is configured yet. Share it privately with the invitee.'
        },201);
      }
      return fail(405,'METHOD_NOT_ALLOWED','Method not allowed for invitations.');
    }

    const invitationMatch=path.match(/^\/team\/invitations\/([^/]+)$/);
    if (invitationMatch) {
      const id=invitationMatch[1];
      if (!validBusinessId(id)) return fail(400,'INVALID_ID','Invitation ID must be a valid UUID.');
      if (method==='DELETE') {
        if (!canAdmin) return fail(403,'INSUFFICIENT_ROLE','Only owners and administrators can revoke invitations.');
        return await revokeInvitation(businessId,id) ? result(204,undefined,true) : fail(404,'INVITATION_NOT_FOUND','Pending invitation not found.');
      }
      return fail(405,'METHOD_NOT_ALLOWED','Method not allowed for invitation.');
    }

    return fail(404,'NOT_FOUND','Business route not found.');
  } catch (error) {
    if (error.code==='INVALID_JSON') return fail(400,'INVALID_JSON',error.message);
    if (error.code==='UNSUPPORTED_MEDIA_TYPE') return fail(415,'UNSUPPORTED_MEDIA_TYPE',error.message);
    if (error.code==='BODY_TOO_LARGE') return fail(413,'BODY_TOO_LARGE',error.message);
    if (error.code==='23505') return fail(409,'DUPLICATE_RESOURCE','A resource with the same business identifier already exists.');
    if (error.code==='23503') return fail(422,'INVALID_REFERENCE','A referenced record does not belong to this business or no longer exists.');
    console.error(JSON.stringify({
      event:'business_api_request_failed',
      code:typeof error.code==='string'?error.code:'NO_CODE',
      name:typeof error.name==='string'?error.name:'UNKNOWN_ERROR'
    }));
    return fail(500,'INTERNAL_ERROR','An unexpected server error occurred.');
  }
}
