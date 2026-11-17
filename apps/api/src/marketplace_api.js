import { randomUUID } from 'node:crypto';
import {
  listMarketplaceServices,
  getCustomerProfile,
  updateCustomerProfile,
  listCustomerLocations,
  getCustomerLocation,
  createCustomerLocation,
  updateCustomerLocation,
  deleteCustomerLocation,
  createCustomerBooking,
  listCustomerBookings,
  listBusinessBookings,
  getCustomerBooking,
  getBusinessBooking,
  createBookingQuote,
  listBookingQuotes,
  respondToBookingQuote,
  updateBusinessBookingStatus,
  cancelCustomerBooking
} from './marketplace_resources.js';
import { getBusinessSummary } from './repository.js';
import { getBranch, getService, listAreas } from './business_resources.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHONE = /^\+[1-9][0-9]{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const CATEGORIES = new Set(['cleaning','laundry','electrical','plumbing','ac-repair','appliance-repair','errand']);
const BOOKING_STATUSES = new Set(['requested','quoted','confirmed','assigned','in_progress','completed','cancelled','declined']);

function response(status,body,noContent=false) {
  return {status,body,noContent};
}
function ok(data,status=200) {
  return response(status,{data});
}
function fail(status,code,message,details=[]) {
  return response(status,{error:{code,message,details}});
}
function objectErrors(body,allowed) {
  if (!body || typeof body!=='object' || Array.isArray(body)) return ['Request body must be a JSON object.'];
  return Object.keys(body).filter(key=>!allowed.includes(key)).map(key=>'Unknown field: '+key+'.');
}
async function readBody(req) {
  const type=req.headers['content-type']||'';
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(type)) {
    const error=new Error('Content-Type must be application/json.');
    error.code='UNSUPPORTED_MEDIA_TYPE';
    throw error;
  }
  const chunks=[];
  let size=0;
  for await (const chunk of req) {
    size+=chunk.length;
    if (size>1024*1024) {
      const error=new Error('Request body exceeds 1 MB.');
      error.code='BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  const raw=Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); }
  catch {
    const error=new Error('Malformed JSON body.');
    error.code='INVALID_JSON';
    throw error;
  }
}
function parseTime(value) {
  if (typeof value!=='string' || !TIME.test(value)) return null;
  const date=new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function validateProfile(body) {
  const errors=objectErrors(body,['phoneE164','preferredLanguage','locale']);
  if (!body || typeof body!=='object' || Array.isArray(body)) return errors;
  if ('phoneE164' in body && body.phoneE164!==null && (typeof body.phoneE164!=='string' || !PHONE.test(body.phoneE164))) errors.push('phoneE164 must use international E.164 format.');
  if ('preferredLanguage' in body && (typeof body.preferredLanguage!=='string' || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(body.preferredLanguage))) errors.push('preferredLanguage must be a language tag such as en or en-GB.');
  if ('locale' in body && (typeof body.locale!=='string' || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(body.locale))) errors.push('locale must be a locale tag such as en or en-NG.');
  if (Object.keys(body).length===0) errors.push('At least one field is required.');
  return errors;
}
function validateLocation(body,partial=false) {
  const fields=['label','recipientName','phoneE164','countryCode','addressLine1','addressLine2','city','region','postalCode','deliveryInstructions','isDefault'];
  const errors=objectErrors(body,fields);
  if (!body || typeof body!=='object' || Array.isArray(body)) return errors;
  const required=['label','recipientName','countryCode','addressLine1','city'];
  for (const key of required) {
    if ((!partial || key in body) && (typeof body[key]!=='string' || body[key].trim().length<2)) errors.push(key+' is required.');
  }
  if ('label' in body && typeof body.label==='string' && body.label.trim().length>60) errors.push('label must not exceed 60 characters.');
  if ('recipientName' in body && typeof body.recipientName==='string' && body.recipientName.trim().length>100) errors.push('recipientName must not exceed 100 characters.');
  if ('phoneE164' in body && body.phoneE164!==null && (typeof body.phoneE164!=='string' || !PHONE.test(body.phoneE164))) errors.push('phoneE164 must use E.164 format.');
  if ('countryCode' in body && (typeof body.countryCode!=='string' || !/^[A-Za-z]{2}$/.test(body.countryCode))) errors.push('countryCode must be a two-letter code.');
  if ('addressLine1' in body && typeof body.addressLine1==='string' && body.addressLine1.trim().length>160) errors.push('addressLine1 must not exceed 160 characters.');
  if ('addressLine2' in body && body.addressLine2!==null && (typeof body.addressLine2!=='string' || body.addressLine2.length>160)) errors.push('addressLine2 must not exceed 160 characters.');
  if ('city' in body && typeof body.city==='string' && body.city.trim().length>100) errors.push('city must not exceed 100 characters.');
  if ('region' in body && body.region!==null && (typeof body.region!=='string' || body.region.length>100)) errors.push('region must not exceed 100 characters.');
  if ('postalCode' in body && body.postalCode!==null && (typeof body.postalCode!=='string' || body.postalCode.length>24)) errors.push('postalCode must not exceed 24 characters.');
  if ('deliveryInstructions' in body && body.deliveryInstructions!==null && (typeof body.deliveryInstructions!=='string' || body.deliveryInstructions.length>500)) errors.push('deliveryInstructions must not exceed 500 characters.');
  if ('isDefault' in body && typeof body.isDefault!=='boolean') errors.push('isDefault must be boolean.');
  if (partial && Object.keys(body).length===0) errors.push('At least one field is required.');
  return errors;
}
function validateBooking(body) {
  const fields=['businessId','serviceId','branchId','locationId','serviceAddress','requestedStartAt','requestedEndAt','customerNotes'];
  const errors=objectErrors(body,fields);
  if (!body || typeof body!=='object' || Array.isArray(body)) return errors;
  if (!UUID.test(body.businessId||'')) errors.push('businessId must be a valid UUID.');
  if (!UUID.test(body.serviceId||'')) errors.push('serviceId must be a valid UUID.');
  if (body.branchId!==undefined && body.branchId!==null && !UUID.test(body.branchId)) errors.push('branchId must be a valid UUID.');
  if (body.locationId!==undefined && body.locationId!==null && !UUID.test(body.locationId)) errors.push('locationId must be a valid UUID.');
  const start=parseTime(body.requestedStartAt);
  if (!start || start.getTime()<=Date.now()) errors.push('requestedStartAt must be a valid future ISO-8601 timestamp with timezone.');
  const end=body.requestedEndAt===undefined||body.requestedEndAt===null?null:parseTime(body.requestedEndAt);
  if (body.requestedEndAt!==undefined && body.requestedEndAt!==null && !end) errors.push('requestedEndAt must be a valid ISO-8601 timestamp with timezone.');
  if (start && end && end<=start) errors.push('requestedEndAt must be later than requestedStartAt.');
  if (body.customerNotes!==undefined && body.customerNotes!==null && (typeof body.customerNotes!=='string' || body.customerNotes.length>1500)) errors.push('customerNotes must not exceed 1,500 characters.');
  if (!body.locationId) {
    const address=body.serviceAddress;
    if (!address || typeof address!=='object' || Array.isArray(address)) {
      errors.push('Provide a saved locationId or a serviceAddress object.');
    } else {
      const required=['recipientName','countryCode','addressLine1','city'];
      for (const key of required) if (typeof address[key]!=='string' || address[key].trim().length<2) errors.push('serviceAddress.'+key+' is required.');
      if (address.countryCode && !/^[A-Za-z]{2}$/.test(address.countryCode)) errors.push('serviceAddress.countryCode must be a two-letter code.');
      if (address.phoneE164!==undefined && address.phoneE164!==null && (typeof address.phoneE164!=='string' || !PHONE.test(address.phoneE164))) errors.push('serviceAddress.phoneE164 must use E.164 format.');
    }
  } else if (body.serviceAddress!==undefined) {
    errors.push('Do not send serviceAddress when using a saved locationId.');
  }
  return errors;
}
function validateQuote(body) {
  const errors=objectErrors(body,['amountMinor','message','expiresAt']);
  if (!body || typeof body!=='object' || Array.isArray(body)) return errors;
  if (!Number.isSafeInteger(body.amountMinor) || body.amountMinor<0) errors.push('amountMinor must be a non-negative integer in the smallest currency unit.');
  if (body.message!==undefined && body.message!==null && (typeof body.message!=='string' || body.message.length>1000)) errors.push('message must not exceed 1,000 characters.');
  const expiry=body.expiresAt===undefined?new Date(Date.now()+72*60*60*1000):parseTime(body.expiresAt);
  if (!expiry || expiry.getTime()<=Date.now() || expiry.getTime()>Date.now()+30*24*60*60*1000) errors.push('expiresAt must be in the future and no more than 30 days away.');
  return errors;
}
function isCustomer(user) {
  return user.accountType==='customer';
}
function isManager(membership) {
  return ['owner','admin','manager'].includes(membership.role);
}
function isAdmin(membership) {
  return ['owner','admin'].includes(membership.role);
}
async function handleError(error) {
  if (error.code==='INVALID_JSON') return fail(400,'INVALID_JSON',error.message);
  if (error.code==='UNSUPPORTED_MEDIA_TYPE') return fail(415,'UNSUPPORTED_MEDIA_TYPE',error.message);
  if (error.code==='BODY_TOO_LARGE') return fail(413,'BODY_TOO_LARGE',error.message);
  if (error.code==='23503') return fail(422,'INVALID_REFERENCE','A referenced record does not belong to this user or business.');
  if (error.code==='23505') return fail(409,'DUPLICATE_RESOURCE','A record with the same identifier already exists.');
  console.error(JSON.stringify({event:'marketplace_api_request_failed',code:typeof error.code==='string'?error.code:'NO_CODE',name:typeof error.name==='string'?error.name:'UNKNOWN_ERROR'}));
  return fail(500,'INTERNAL_ERROR','An unexpected server error occurred.');
}
async function customerApi(req,url,user) {
  if (!isCustomer(user)) return fail(403,'CUSTOMER_ACCOUNT_REQUIRED','This endpoint requires a customer account.');
  const path=url.pathname.slice('/api/v1/customer'.length)||'/';
  const method=req.method;
  try {
    if (path==='/profile') {
      if (method==='GET') return ok(await getCustomerProfile(user));
      if (method==='PATCH') {
        const body=await readBody(req);
        const errors=validateProfile(body);
        if (errors.length) return fail(422,'VALIDATION_ERROR','Customer profile validation failed.',errors);
        return ok(await updateCustomerProfile(user.id,body));
      }
      return fail(405,'METHOD_NOT_ALLOWED','Method not allowed for customer profile.');
    }
    if (path==='/locations') {
      if (method==='GET') return ok(await listCustomerLocations(user.id));
      if (method==='POST') {
        const body=await readBody(req);
        const errors=validateLocation(body);
        if (errors.length) return fail(422,'VALIDATION_ERROR','Customer location validation failed.',errors);
        body.countryCode=body.countryCode.toUpperCase();
        for (const field of ['label','recipientName','addressLine1','city']) if (typeof body[field]==='string') body[field]=body[field].trim();
        const saved=await createCustomerLocation(user.id,body);
        return ok(saved,201);
      }
      return fail(405,'METHOD_NOT_ALLOWED','Method not allowed for customer locations.');
    }
    const locationMatch=path.match(/^\/locations\/([^/]+)$/);
    if (locationMatch) {
      const id=locationMatch[1];
      if (!UUID.test(id)) return fail(400,'INVALID_ID','Location ID must be a valid UUID.');
      const existing=await getCustomerLocation(user.id,id);
      if (!existing) return fail(404,'LOCATION_NOT_FOUND','Saved location not found.');
      if (method==='GET') return ok(existing);
      if (method==='PATCH') {
        const body=await readBody(req);
        const errors=validateLocation(body,true);
        if (errors.length) return fail(422,'VALIDATION_ERROR','Customer location update validation failed.',errors);
        if (body.countryCode) body.countryCode=body.countryCode.toUpperCase();
        const updated=await updateCustomerLocation(user.id,id,body);
        return updated?ok(updated):fail(404,'LOCATION_NOT_FOUND','Saved location not found.');
      }
      if (method==='DELETE') return await deleteCustomerLocation(user.id,id)?response(204,undefined,true):fail(404,'LOCATION_NOT_FOUND','Saved location not found.');
      return fail(405,'METHOD_NOT_ALLOWED','Method not allowed for saved location.');
    }
    if (path==='/bookings') {
      if (method==='GET') return ok(await listCustomerBookings(user.id));
      if (method==='POST') {
        const body=await readBody(req);
        const errors=validateBooking(body);
        if (errors.length) return fail(422,'VALIDATION_ERROR','Booking request validation failed.',errors);
        const business=await getBusinessSummary(body.businessId);
        if (!business) return fail(404,'BUSINESS_NOT_FOUND','Business not found or inactive.');
        const service=await getService(body.businessId,body.serviceId);
        if (!service || !service.isActive) return fail(404,'SERVICE_NOT_FOUND','Active service not found for this business.');
        if (body.branchId) {
          const branch=await getBranch(body.businessId,body.branchId);
          if (!branch || branch.status!=='active') return fail(404,'BRANCH_NOT_FOUND','Active branch not found for this business.');
        }
        const location=body.locationId?await getCustomerLocation(user.id,body.locationId):null;
        if (body.locationId && !location) return fail(404,'LOCATION_NOT_FOUND','Saved service location not found.');
        const address=location||{
          ...body.serviceAddress,
          countryCode:body.serviceAddress.countryCode.toUpperCase()
        };
        const areas=await listAreas(body.businessId);
        const activeAreas=areas.filter(item=>item.isActive!==false);
        if (activeAreas.length) {
          const covered=activeAreas.some(item=>
            item.countryCode===address.countryCode &&
            (!item.city || item.city.toLowerCase()===String(address.city).toLowerCase()) &&
            (!item.region || !address.region || item.region.toLowerCase()===String(address.region).toLowerCase()) &&
            (!item.branchId || item.branchId===body.branchId)
          );
          if (!covered) return fail(422,'SERVICE_AREA_UNSUPPORTED','This business has not listed coverage for the selected service address.');
        } else if (business.countryCode && business.countryCode!==address.countryCode) {
          return fail(422,'SERVICE_AREA_UNSUPPORTED','This business has not enabled service outside its registered country yet.');
        }
        const payload={...body,requestedStartAt:new Date(body.requestedStartAt).toISOString(),requestedEndAt:body.requestedEndAt?new Date(body.requestedEndAt).toISOString():null};
        const booking=await createCustomerBooking(user.id,payload,service,address);
        return ok(booking,201);
      }
      return fail(405,'METHOD_NOT_ALLOWED','Method not allowed for customer bookings.');
    }
    const bookingMatch=path.match(/^\/bookings\/([^/]+)$/);
    if (bookingMatch) {
      const bookingId=bookingMatch[1];
      if (!UUID.test(bookingId)) return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
      const booking=await getCustomerBooking(user.id,bookingId);
      if (!booking) return fail(404,'BOOKING_NOT_FOUND','Booking not found.');
      if (method==='GET') return ok(booking);
      return fail(405,'METHOD_NOT_ALLOWED','Method not allowed for customer booking.');
    }
    const quotesMatch=path.match(/^\/bookings\/([^/]+)\/quotes$/);
    if (quotesMatch) {
      const bookingId=quotesMatch[1];
      if (!UUID.test(bookingId)) return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
      if (method==='GET') {
        const quotes=await listBookingQuotes(user.id,bookingId,'customer');
        return quotes===null?fail(404,'BOOKING_NOT_FOUND','Booking not found.'):ok(quotes);
      }
      return fail(405,'METHOD_NOT_ALLOWED','Method not allowed for booking quotes.');
    }
    const respondMatch=path.match(/^\/bookings\/([^/]+)\/quotes\/([^/]+)\/respond$/);
    if (respondMatch) {
      const bookingId=respondMatch[1],quoteId=respondMatch[2];
      if (!UUID.test(bookingId)||!UUID.test(quoteId)) return fail(400,'INVALID_ID','Booking and quote IDs must be valid UUIDs.');
      if (method!=='POST') return fail(405,'METHOD_NOT_ALLOWED','Use POST to respond to a quote.');
      const body=await readBody(req);
      const errors=objectErrors(body,['action']);
      if (!body||!['accept','decline'].includes(body.action)) errors.push('action must be accept or decline.');
      if (errors.length) return fail(422,'VALIDATION_ERROR','Quote response validation failed.',errors);
      const result=await respondToBookingQuote(user.id,bookingId,quoteId,body.action);
      return result?ok(result):fail(409,'QUOTE_NOT_ACTIONABLE','The quote is no longer pending, has expired, or does not belong to your booking.');
    }
    const cancelMatch=path.match(/^\/bookings\/([^/]+)\/cancel$/);
    if (cancelMatch) {
      const bookingId=cancelMatch[1];
      if (!UUID.test(bookingId)) return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
      if (method!=='POST') return fail(405,'METHOD_NOT_ALLOWED','Use POST to cancel a booking.');
      const body=await readBody(req);
      const errors=objectErrors(body,['note']);
      if (body?.note!==undefined && body.note!==null && (typeof body.note!=='string'||body.note.length>1000)) errors.push('note must not exceed 1,000 characters.');
      if (errors.length) return fail(422,'VALIDATION_ERROR','Cancellation validation failed.',errors);
      const cancelled=await cancelCustomerBooking(user.id,bookingId,body.note??null);
      return cancelled?ok(cancelled):fail(409,'BOOKING_NOT_CANCELLABLE','This booking cannot be cancelled in its current state.');
    }
    return fail(404,'NOT_FOUND','Customer route not found.');
  } catch(error) {
    return handleError(error);
  }
}
async function businessBookingsApi(req,url,businessId,user,membership) {
  const path=url.pathname.slice('/api/v1/business/bookings'.length)||'/';
  const method=req.method;
  if (!['owner','admin','manager','staff'].includes(membership.role)) return fail(403,'BUSINESS_ACCESS_DENIED','You do not have permission to access bookings.');
  try {
    if (path==='/') {
      if (method!=='GET') return fail(405,'METHOD_NOT_ALLOWED','Use GET to list business bookings.');
      const status=url.searchParams.get('status');
      if (status && !BOOKING_STATUSES.has(status)) return fail(400,'INVALID_STATUS','Unknown booking status.');
      return ok(await listBusinessBookings(businessId,status));
    }
    const bookingMatch=path.match(/^\/([^/]+)$/);
    if (bookingMatch) {
      const bookingId=bookingMatch[1];
      if (!UUID.test(bookingId)) return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
      const booking=await getBusinessBooking(businessId,bookingId);
      return booking?ok(booking):fail(404,'BOOKING_NOT_FOUND','Booking not found for this business.');
    }
    const quoteMatch=path.match(/^\/([^/]+)\/quotes$/);
    if (quoteMatch) {
      const bookingId=quoteMatch[1];
      if (!UUID.test(bookingId)) return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
      if (method==='GET') {
        const quotes=await listBookingQuotes(businessId,bookingId,'business');
        return quotes===null?fail(404,'BOOKING_NOT_FOUND','Booking not found for this business.'):ok(quotes);
      }
      if (method==='POST') {
        if (!isManager(membership)) return fail(403,'INSUFFICIENT_ROLE','Only owners, administrators and managers can send quotes.');
        const body=await readBody(req);
        const errors=validateQuote(body);
        if (errors.length) return fail(422,'VALIDATION_ERROR','Quote validation failed.',errors);
        const expiresAt=body.expiresAt?new Date(body.expiresAt).toISOString():new Date(Date.now()+72*60*60*1000).toISOString();
        const created=await createBookingQuote(businessId,bookingId,user.id,{amountMinor:body.amountMinor,message:body.message??null,expiresAt});
        if (!created) return fail(404,'BOOKING_NOT_QUOTABLE','Booking not found or cannot be quoted in its current state.');
        if (created.conflict) return fail(409,'PENDING_QUOTE_EXISTS','A pending quote already exists for this booking.');
        return ok(created.quote,201);
      }
      return fail(405,'METHOD_NOT_ALLOWED','Method not allowed for booking quotes.');
    }
    const statusMatch=path.match(/^\/([^/]+)\/status$/);
    if (statusMatch) {
      const bookingId=statusMatch[1];
      if (!UUID.test(bookingId)) return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
      if (method!=='PATCH') return fail(405,'METHOD_NOT_ALLOWED','Use PATCH to update booking status.');
      if (!isManager(membership)) return fail(403,'INSUFFICIENT_ROLE','Only owners, administrators and managers can change booking status.');
      const body=await readBody(req);
      const errors=objectErrors(body,['status','note']);
      const allowed=new Set(['confirmed','declined','cancelled','completed']);
      if (!body||!allowed.has(body.status)) errors.push('status must be confirmed, declined, cancelled or completed.');
      if (body?.note!==undefined && body.note!==null && (typeof body.note!=='string'||body.note.length>1000)) errors.push('note must not exceed 1,000 characters.');
      if (errors.length) return fail(422,'VALIDATION_ERROR','Booking status validation failed.',errors);
      const updated=await updateBusinessBookingStatus(businessId,bookingId,user.id,body.status,body.note??null);
      return updated?ok(updated):fail(409,'INVALID_BOOKING_TRANSITION','This booking cannot move to the requested status.');
    }
    return fail(404,'NOT_FOUND','Business booking route not found.');
  } catch(error) {
    return handleError(error);
  }
}

export async function handleMarketplaceApi(req,url,user=null,business=null) {
  if (url.pathname==='/api/v1/market/services') {
    if (req.method!=='GET') return fail(405,'METHOD_NOT_ALLOWED','Use GET for marketplace service discovery.');
    const countryCode=url.searchParams.get('countryCode');
    const city=url.searchParams.get('city');
    const category=url.searchParams.get('category');
    const search=url.searchParams.get('search');
    const limit=url.searchParams.get('limit');
    const offset=url.searchParams.get('offset');
    if (countryCode && !/^[A-Za-z]{2}$/.test(countryCode)) return fail(400,'INVALID_QUERY','countryCode must be a two-letter code.');
    if (category && !CATEGORIES.has(category)) return fail(400,'INVALID_QUERY','Unknown service category.');
    if (city && city.length>100) return fail(400,'INVALID_QUERY','city must not exceed 100 characters.');
    if (search && search.length>120) return fail(400,'INVALID_QUERY','search must not exceed 120 characters.');
    if (limit!==null && (!/^\d+$/.test(limit)||Number(limit)<1||Number(limit)>50)) return fail(400,'INVALID_QUERY','limit must be between 1 and 50.');
    if (offset!==null && (!/^\d+$/.test(offset)||Number(offset)>1000000)) return fail(400,'INVALID_QUERY','offset must be between 0 and 1,000,000.');
    try {
      return ok(await listMarketplaceServices({
        countryCode:countryCode?countryCode.toUpperCase():null,
        city:city?city.trim():null,category,search:search?search.trim():null,
        limit:limit?Number(limit):20,offset:offset?Number(offset):0
      }));
    } catch(error) { return handleError(error); }
  }
  if (url.pathname==='/api/v1/customer' || url.pathname.startsWith('/api/v1/customer/')) {
    if (!user) return fail(401,'UNAUTHENTICATED','A valid bearer access token is required.');
    return customerApi(req,url,user);
  }
  if (url.pathname==='/api/v1/business/bookings' || url.pathname.startsWith('/api/v1/business/bookings/')) {
    if (!user) return fail(401,'UNAUTHENTICATED','A valid bearer access token is required.');
    if (!business) return fail(400,'BUSINESS_CONTEXT_REQUIRED','Set the X-SwiftServe-Business-Id header.');
    return businessBookingsApi(req,url,business.businessId,user,business.membership);
  }
  return fail(404,'NOT_FOUND','Marketplace route not found.');
}
