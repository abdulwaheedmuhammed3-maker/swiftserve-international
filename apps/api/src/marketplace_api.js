import {
  listMarketplaceServices, getMarketplaceService,
  getCustomerProfile, updateCustomerProfile,
  listCustomerLocations, getCustomerLocation, createCustomerLocation,
  updateCustomerLocation, deleteCustomerLocation,
  createCustomerBooking, listCustomerBookings, getCustomerBooking,
  listBusinessBookings, getBusinessBooking, createBookingQuote,
  listBookingQuotes, respondToBookingQuote, updateBusinessBookingStatus,
  cancelCustomerBooking, listBookingEvents,
  listNotifications, markNotificationRead
} from './marketplace_resources.js';
import { getBranch, listAreas, listBranches } from './business_resources.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHONE=/^\+[1-9]\d{7,14}$/;
const ISO_DATE=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const CATEGORIES=new Set(['cleaning','laundry','electrical','plumbing','ac-repair','appliance-repair','errand']);
const BOOKING_STATUSES=new Set(['requested','quoted','confirmed','assigned','in_progress','completed','cancelled','declined']);

function result(status,body,noContent=false){return {status,body,noContent};}
function ok(data,status=200){return result(status,{data});}
function fail(status,code,message,details=[]){return result(status,{error:{code,message,details}});}
function isObject(value){return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}
function fields(body,allowed){
  if(!isObject(body))return ['Request body must be a JSON object.'];
  return Object.keys(body).filter(key=>!allowed.includes(key)).map(key=>'Unknown field: '+key+'.');
}
function validId(id){return typeof id==='string'&&UUID.test(id);}
function dateValue(value){
  if(typeof value!=='string'||!ISO_DATE.test(value))return null;
  const date=new Date(value);
  return Number.isNaN(date.getTime())?null:date;
}
function customerAccount(user){
  return user?.accountType==='customer'?null:fail(403,'CUSTOMER_ACCOUNT_REQUIRED','This route requires a customer account.');
}
function managerRole(membership){
  return ['owner','admin','manager'].includes(membership?.role);
}
function methodNotAllowed(methods){
  return fail(405,'METHOD_NOT_ALLOWED','HTTP method is not supported for this route.',['Allowed methods: '+methods.join(', ')+'.']);
}
async function readJson(req){
  const type=req.headers['content-type']||'';
  if(!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(type)){
    const error=new Error('Content-Type must be application/json.');error.code='UNSUPPORTED_MEDIA_TYPE';throw error;
  }
  const chunks=[];let size=0;
  for await(const chunk of req){
    size+=chunk.length;
    if(size>1024*1024){const error=new Error('Request body exceeds 1 MB.');error.code='BODY_TOO_LARGE';throw error;}
    chunks.push(chunk);
  }
  const raw=Buffer.concat(chunks).toString('utf8');
  if(!raw.trim())return {};
  try{return JSON.parse(raw);}catch{const error=new Error('Malformed JSON body.');error.code='INVALID_JSON';throw error;}
}
function validateProfile(body){
  const errors=fields(body,['phoneE164','preferredLanguage','locale']);
  if(!isObject(body))return errors;
  if(!Object.keys(body).length)errors.push('At least one field is required.');
  if('phoneE164'in body&&body.phoneE164!==null&&(typeof body.phoneE164!=='string'||!PHONE.test(body.phoneE164)))errors.push('phoneE164 must use E.164 format or null.');
  if('preferredLanguage'in body&&(typeof body.preferredLanguage!=='string'||!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(body.preferredLanguage)))errors.push('preferredLanguage must be a valid language tag.');
  if('locale'in body&&(typeof body.locale!=='string'||body.locale.length>16||!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(body.locale)))errors.push('locale must be a valid locale tag.');
  return errors;
}
function validateLocation(body,partial=false){
  const errors=fields(body,['label','recipientName','phoneE164','countryCode','addressLine1','addressLine2','city','region','postalCode','deliveryInstructions','isDefault']);
  if(!isObject(body))return errors;
  for(const key of ['label','recipientName','countryCode','addressLine1','city']){
    if((!partial||key in body)&&typeof body[key]!=='string')errors.push(key+' is required.');
  }
  if('label'in body&&(typeof body.label!=='string'||body.label.trim().length<2||body.label.trim().length>60))errors.push('label must be 2 to 60 characters.');
  if('recipientName'in body&&(typeof body.recipientName!=='string'||body.recipientName.trim().length<2||body.recipientName.trim().length>100))errors.push('recipientName must be 2 to 100 characters.');
  if('phoneE164'in body&&body.phoneE164!==null&&(typeof body.phoneE164!=='string'||!PHONE.test(body.phoneE164)))errors.push('phoneE164 must use E.164 format.');
  if('countryCode'in body&&(typeof body.countryCode!=='string'||!/^[A-Za-z]{2}$/.test(body.countryCode)))errors.push('countryCode must be a two-letter code.');
  if('addressLine1'in body&&(typeof body.addressLine1!=='string'||body.addressLine1.trim().length<3||body.addressLine1.trim().length>160))errors.push('addressLine1 must be 3 to 160 characters.');
  if('addressLine2'in body&&body.addressLine2!==null&&(typeof body.addressLine2!=='string'||body.addressLine2.length>160))errors.push('addressLine2 must not exceed 160 characters.');
  if('city'in body&&(typeof body.city!=='string'||body.city.trim().length<2||body.city.trim().length>100))errors.push('city must be 2 to 100 characters.');
  if('region'in body&&body.region!==null&&(typeof body.region!=='string'||body.region.length>100))errors.push('region must not exceed 100 characters.');
  if('postalCode'in body&&body.postalCode!==null&&(typeof body.postalCode!=='string'||body.postalCode.length>24))errors.push('postalCode must not exceed 24 characters.');
  if('deliveryInstructions'in body&&body.deliveryInstructions!==null&&(typeof body.deliveryInstructions!=='string'||body.deliveryInstructions.length>500))errors.push('deliveryInstructions must not exceed 500 characters.');
  if('isDefault'in body&&typeof body.isDefault!=='boolean')errors.push('isDefault must be boolean.');
  if(partial&&!Object.keys(body).length)errors.push('At least one field is required.');
  return errors;
}
function validateInlineAddress(address){
  if(!isObject(address))return ['serviceAddress must be an object.'];
  const errors=fields(address,['recipientName','phoneE164','countryCode','addressLine1','addressLine2','city','region','postalCode']);
  for(const key of ['recipientName','countryCode','addressLine1','city'])if(typeof address[key]!=='string'||address[key].trim().length<2)errors.push(key+' is required.');
  if(address.phoneE164!==undefined&&address.phoneE164!==null&&(typeof address.phoneE164!=='string'||!PHONE.test(address.phoneE164)))errors.push('phoneE164 must use E.164 format.');
  if(typeof address.countryCode==='string'&&!/^[A-Za-z]{2}$/.test(address.countryCode))errors.push('countryCode must be a two-letter code.');
  if(typeof address.addressLine1==='string'&&address.addressLine1.length>160)errors.push('addressLine1 must not exceed 160 characters.');
  if(typeof address.city==='string'&&address.city.length>100)errors.push('city must not exceed 100 characters.');
  if(address.region!==undefined&&address.region!==null&&(typeof address.region!=='string'||address.region.length>100))errors.push('region must not exceed 100 characters.');
  if(address.postalCode!==undefined&&address.postalCode!==null&&(typeof address.postalCode!=='string'||address.postalCode.length>24))errors.push('postalCode must not exceed 24 characters.');
  return errors;
}
function validateBooking(body){
  const errors=fields(body,['serviceId','branchId','locationId','serviceAddress','requestedStartAt','requestedEndAt','customerNotes']);
  if(!isObject(body))return errors;
  if(!validId(body.serviceId))errors.push('serviceId must be a valid UUID.');
  if(body.branchId!==undefined&&body.branchId!==null&&!validId(body.branchId))errors.push('branchId must be a valid UUID.');
  if(body.locationId!==undefined&&body.locationId!==null&&!validId(body.locationId))errors.push('locationId must be a valid UUID.');
  if(Boolean(body.locationId)===Boolean(body.serviceAddress))errors.push('Provide exactly one of locationId or serviceAddress.');
  if(body.serviceAddress!==undefined)errors.push(...validateInlineAddress(body.serviceAddress));
  const start=dateValue(body.requestedStartAt);
  if(!start||start.getTime()<=Date.now())errors.push('requestedStartAt must be a future ISO-8601 timestamp with timezone.');
  if(body.requestedEndAt!==undefined&&body.requestedEndAt!==null){
    const end=dateValue(body.requestedEndAt);
    if(!end)errors.push('requestedEndAt must be an ISO-8601 timestamp with timezone.');
    else if(start&&end<=start)errors.push('requestedEndAt must be later than requestedStartAt.');
  }
  if(body.customerNotes!==undefined&&body.customerNotes!==null&&(typeof body.customerNotes!=='string'||body.customerNotes.length>1500))errors.push('customerNotes must not exceed 1,500 characters.');
  return errors;
}
function validateQuote(body){
  const errors=fields(body,['amountMinor','message','expiresAt']);
  if(!isObject(body))return errors;
  if(!Number.isSafeInteger(body.amountMinor)||body.amountMinor<0)errors.push('amountMinor must be a non-negative safe integer in the smallest currency unit.');
  if(body.message!==undefined&&body.message!==null&&(typeof body.message!=='string'||body.message.length>1000))errors.push('message must not exceed 1,000 characters.');
  if(body.expiresAt!==undefined){
    const expiry=dateValue(body.expiresAt);
    if(!expiry||expiry.getTime()<=Date.now()||expiry.getTime()>Date.now()+30*24*60*60*1000)errors.push('expiresAt must be a future ISO timestamp no more than 30 days away.');
  }
  return errors;
}
function normalizeLocation(value){
  const out={...value};
  for(const key of ['label','recipientName','addressLine1','city'])if(typeof out[key]==='string')out[key]=out[key].trim();
  if(typeof out.countryCode==='string')out.countryCode=out.countryCode.toUpperCase();
  return out;
}
function areaCovers(address,area,branchId){
  if(area.isActive===false||area.countryCode!==address.countryCode)return false;
  if(area.branchId&&area.branchId!==branchId)return false;
  if(area.city&&area.city.toLowerCase()!==String(address.city).toLowerCase())return false;
  if(area.region&&(!address.region||area.region.toLowerCase()!==String(address.region).toLowerCase()))return false;
  if(area.postalCodePrefix&&(!address.postalCode||!String(address.postalCode).toLowerCase().startsWith(area.postalCodePrefix.toLowerCase())))return false;
  return Boolean(area.city||area.region||area.postalCodePrefix);
}
async function verifyCoverage(businessId,address,branchId){
  const branches=await listBranches(businessId);
  let branch=null;
  if(branchId){
    branch=await getBranch(businessId,branchId);
    if(!branch||branch.status!=='active')return {error:'The selected branch is unavailable.'};
    if(branch.countryCode!==address.countryCode)return {error:'The selected branch is in a different country.'};
  }
  const areas=await listAreas(businessId);
  const coveredByArea=areas.some(area=>areaCovers(address,area,branchId));
  const candidates=branch?[branch]:branches.filter(item=>item.status==='active');
  const coveredByBranch=candidates.some(item=>
    item.countryCode===address.countryCode&&
    (!item.city||item.city.toLowerCase()===String(address.city).toLowerCase())&&
    (!item.region||!address.region||item.region.toLowerCase()===String(address.region).toLowerCase())
  );
  if(!coveredByArea&&!coveredByBranch)return {error:'This business has not listed service coverage for the selected address.'};
  return {ok:true};
}
async function handleError(error){
  if(error?.code==='INVALID_JSON')return fail(400,'INVALID_JSON',error.message);
  if(error?.code==='UNSUPPORTED_MEDIA_TYPE')return fail(415,'UNSUPPORTED_MEDIA_TYPE',error.message);
  if(error?.code==='BODY_TOO_LARGE')return fail(413,'BODY_TOO_LARGE',error.message);
  if(error?.code==='23503')return fail(422,'INVALID_REFERENCE','A referenced record does not belong to this customer or business.');
  if(error?.code==='23505')return fail(409,'DUPLICATE_RESOURCE','A conflicting record already exists.');
  console.error(JSON.stringify({event:'marketplace_api_request_failed',code:typeof error?.code==='string'?error.code:'NO_CODE',name:typeof error?.name==='string'?error.name:'UNKNOWN_ERROR'}));
  return fail(500,'INTERNAL_ERROR','An unexpected server error occurred.');
}

async function customerApi(req,url,user){
  const denied=customerAccount(user);if(denied)return denied;
  const path=url.pathname.slice('/api/v1/customer'.length)||'/';
  const method=req.method;
  if(path==='/profile'){
    if(method==='GET')return ok(await getCustomerProfile(user));
    if(method==='PATCH'){
      const body=await readJson(req);const errors=validateProfile(body);
      if(errors.length)return fail(422,'VALIDATION_ERROR','Customer profile validation failed.',errors);
      return ok(await updateCustomerProfile(user.id,body));
    }
    return methodNotAllowed(['GET','PATCH']);
  }
  if(path==='/locations'){
    if(method==='GET')return ok(await listCustomerLocations(user.id));
    if(method==='POST'){
      const body=normalizeLocation(await readJson(req));const errors=validateLocation(body);
      if(errors.length)return fail(422,'VALIDATION_ERROR','Customer address validation failed.',errors);
      return ok(await createCustomerLocation(user.id,body),201);
    }
    return methodNotAllowed(['GET','POST']);
  }
  const locationPath=path.match(/^\/locations\/([^/]+)$/);
  if(locationPath){
    const id=locationPath[1];if(!validId(id))return fail(400,'INVALID_ID','Location ID must be a valid UUID.');
    if(method==='GET'){
      const item=await getCustomerLocation(user.id,id);
      return item?ok(item):fail(404,'LOCATION_NOT_FOUND','Saved address not found.');
    }
    if(method==='PATCH'){
      const body=normalizeLocation(await readJson(req));const errors=validateLocation(body,true);
      if(errors.length)return fail(422,'VALIDATION_ERROR','Customer address update validation failed.',errors);
      const item=await updateCustomerLocation(user.id,id,body);
      return item?ok(item):fail(404,'LOCATION_NOT_FOUND','Saved address not found.');
    }
    if(method==='DELETE')return await deleteCustomerLocation(user.id,id)?result(204,undefined,true):fail(404,'LOCATION_NOT_FOUND','Saved address not found.');
    return methodNotAllowed(['GET','PATCH','DELETE']);
  }
  if(path==='/bookings'){
    if(method==='GET')return ok(await listCustomerBookings(user.id));
    if(method==='POST'){
      const body=await readJson(req);const errors=validateBooking(body);
      if(errors.length)return fail(422,'VALIDATION_ERROR','Booking request validation failed.',errors);
      const service=await getMarketplaceService(body.serviceId);
      if(!service)return fail(404,'SERVICE_NOT_FOUND','The selected service is not currently available.');
      const location=body.locationId?await getCustomerLocation(user.id,body.locationId):null;
      if(body.locationId&&!location)return fail(404,'LOCATION_NOT_FOUND','The selected saved address was not found.');
      const address=location||normalizeLocation(body.serviceAddress);
      const branchId=body.branchId||service.branch?.id||null;
      const coverage=await verifyCoverage(service.business.id,address,branchId);
      if(coverage.error)return fail(422,'SERVICE_OUT_OF_AREA','The business does not serve the selected address.',[coverage.error]);
      const created=await createCustomerBooking(user.id,{
        businessId:service.business.id,
        branchId,
        requestedStartAt:new Date(body.requestedStartAt).toISOString(),
        requestedEndAt:body.requestedEndAt?new Date(body.requestedEndAt).toISOString():null,
        customerNotes:body.customerNotes?.trim()||null
      },service,location||address);
      return ok(created,201);
    }
    return methodNotAllowed(['GET','POST']);
  }
  const bookingEvents=path.match(/^\/bookings\/([^/]+)\/events$/);
  if(bookingEvents){
    if(method!=='GET')return methodNotAllowed(['GET']);
    if(!validId(bookingEvents[1]))return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
    const history=await listBookingEvents(user.id,bookingEvents[1],'customer');
    return history===null?fail(404,'BOOKING_NOT_FOUND','Booking not found.'):ok(history);
  }
  const quoteResponse=path.match(/^\/bookings\/([^/]+)\/quotes\/([^/]+)\/response$/);
  if(quoteResponse){
    if(method!=='POST')return methodNotAllowed(['POST']);
    if(!validId(quoteResponse[1])||!validId(quoteResponse[2]))return fail(400,'INVALID_ID','Booking and quote IDs must be valid UUIDs.');
    const body=await readJson(req);const errors=fields(body,['action']);
    if(!isObject(body)||!['accept','decline'].includes(body.action))errors.push('action must be accept or decline.');
    if(errors.length)return fail(422,'VALIDATION_ERROR','Quote response validation failed.',errors);
    const saved=await respondToBookingQuote(user.id,quoteResponse[1],quoteResponse[2],body.action);
    return saved?ok(saved):fail(409,'QUOTE_NOT_AVAILABLE','This quote is no longer pending or does not belong to your booking.');
  }
  const quotesPath=path.match(/^\/bookings\/([^/]+)\/quotes$/);
  if(quotesPath){
    if(method!=='GET')return methodNotAllowed(['GET']);
    if(!validId(quotesPath[1]))return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
    const quotes=await listBookingQuotes(user.id,quotesPath[1],'customer');
    return quotes===null?fail(404,'BOOKING_NOT_FOUND','Booking not found.'):ok(quotes);
  }
  const cancelPath=path.match(/^\/bookings\/([^/]+)\/cancel$/);
  if(cancelPath){
    if(method!=='POST')return methodNotAllowed(['POST']);
    if(!validId(cancelPath[1]))return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
    const body=await readJson(req);const errors=fields(body,['note']);
    if(!isObject(body))return fail(422,'VALIDATION_ERROR','Cancellation body must be a JSON object.',errors);
    if(body.note!==undefined&&body.note!==null&&(typeof body.note!=='string'||body.note.length>1000))errors.push('note must not exceed 1,000 characters.');
    if(errors.length)return fail(422,'VALIDATION_ERROR','Cancellation validation failed.',errors);
    const saved=await cancelCustomerBooking(user.id,cancelPath[1],body.note??'Cancelled by customer.');
    return saved?ok(saved):fail(409,'BOOKING_NOT_CANCELLABLE','This booking cannot be cancelled in its current state.');
  }
  const bookingPath=path.match(/^\/bookings\/([^/]+)$/);
  if(bookingPath){
    if(method!=='GET')return methodNotAllowed(['GET']);
    if(!validId(bookingPath[1]))return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
    const booking=await getCustomerBooking(user.id,bookingPath[1]);
    if(!booking)return fail(404,'BOOKING_NOT_FOUND','Booking not found.');
    const [quotes,history]=await Promise.all([
      listBookingQuotes(user.id,bookingPath[1],'customer'),
      listBookingEvents(user.id,bookingPath[1],'customer')
    ]);
    return ok({...booking,quotes,history});
  }
  return fail(404,'NOT_FOUND','Customer route not found.');
}

async function businessBookingsApi(req,url,user,business){
  const path=url.pathname.slice('/api/v1/business/bookings'.length)||'/';
  const method=req.method;
  if(!business?.businessId||!business?.membership)return fail(400,'BUSINESS_CONTEXT_REQUIRED','A valid business context is required.');
  const role=business.membership.role;
  const canManage=managerRole(business.membership);
  const canRead=['owner','admin','manager','staff'].includes(role);
  if(!canRead)return fail(403,'BUSINESS_ACCESS_DENIED','You do not have access to this business.');
  if(path==='/'){
    if(method!=='GET')return methodNotAllowed(['GET']);
    const status=url.searchParams.get('status');
    if(status&&!BOOKING_STATUSES.has(status))return fail(400,'INVALID_QUERY','Unknown booking status.');
    return ok(await listBusinessBookings(business.businessId,status));
  }
  const eventsPath=path.match(/^\/([^/]+)\/events$/);
  if(eventsPath){
    if(method!=='GET')return methodNotAllowed(['GET']);
    if(!validId(eventsPath[1]))return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
    const list=await listBookingEvents(business.businessId,eventsPath[1],'business');
    return list===null?fail(404,'BOOKING_NOT_FOUND','Booking not found.'):ok(list);
  }
  const quotesPath=path.match(/^\/([^/]+)\/quotes$/);
  if(quotesPath){
    const bookingId=quotesPath[1];if(!validId(bookingId))return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
    if(method==='GET'){
      const list=await listBookingQuotes(business.businessId,bookingId,'business');
      return list===null?fail(404,'BOOKING_NOT_FOUND','Booking not found.'):ok(list);
    }
    if(method==='POST'){
      if(!canManage)return fail(403,'INSUFFICIENT_ROLE','Only owners, admins and managers can issue quotes.');
      const body=await readJson(req);const errors=validateQuote(body);
      if(errors.length)return fail(422,'VALIDATION_ERROR','Quote validation failed.',errors);
      const expiresAt=body.expiresAt?new Date(body.expiresAt).toISOString():new Date(Date.now()+72*60*60*1000).toISOString();
      const created=await createBookingQuote(business.businessId,bookingId,user.id,{
        amountMinor:body.amountMinor,message:body.message?.trim()||null,expiresAt
      });
      if(!created)return fail(404,'BOOKING_NOT_QUOTABLE','Booking not found or cannot receive a quote.');
      if(created.conflict)return fail(409,'PENDING_QUOTE_EXISTS','A pending quote already exists.');
      return ok(created.quote,201);
    }
    return methodNotAllowed(['GET','POST']);
  }
  const statusPath=path.match(/^\/([^/]+)\/status$/);
  if(statusPath){
    if(method!=='PATCH')return methodNotAllowed(['PATCH']);
    if(!validId(statusPath[1]))return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
    if(!canManage)return fail(403,'INSUFFICIENT_ROLE','Only owners, admins and managers can change booking status.');
    const body=await readJson(req);const errors=fields(body,['status','note']);
    if(!isObject(body)||!['confirmed','declined','cancelled'].includes(body.status))errors.push('status must be confirmed, declined or cancelled; providers control work progress and completion.');
    if(body.note!==undefined&&body.note!==null&&(typeof body.note!=='string'||body.note.length>1000))errors.push('note must not exceed 1,000 characters.');
    if(errors.length)return fail(422,'VALIDATION_ERROR','Booking status validation failed.',errors);
    const saved=await updateBusinessBookingStatus(business.businessId,statusPath[1],user.id,body.status,body.note??null);
    return saved?ok(saved):fail(409,'INVALID_BOOKING_TRANSITION','This booking cannot move to the requested status.');
  }
  const bookingPath=path.match(/^\/([^/]+)$/);
  if(bookingPath){
    if(method!=='GET')return methodNotAllowed(['GET']);
    if(!validId(bookingPath[1]))return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
    const booking=await getBusinessBooking(business.businessId,bookingPath[1]);
    if(!booking)return fail(404,'BOOKING_NOT_FOUND','Booking not found.');
    const [quotes,history]=await Promise.all([
      listBookingQuotes(business.businessId,bookingPath[1],'business'),
      listBookingEvents(business.businessId,bookingPath[1],'business')
    ]);
    return ok({...booking,quotes,history});
  }
  return fail(404,'NOT_FOUND','Business booking route not found.');
}

async function marketplaceApi(req,url){
  const path=url.pathname;
  if(path!=='/api/v1/market/services')return fail(404,'NOT_FOUND','Marketplace route not found.');
  if(req.method!=='GET')return methodNotAllowed(['GET']);
  const country=url.searchParams.get('countryCode');
  const city=url.searchParams.get('city');
  const category=url.searchParams.get('category');
  const search=url.searchParams.get('search');
  const limitRaw=url.searchParams.get('limit');
  const offsetRaw=url.searchParams.get('offset');
  if(country&&!/^[A-Za-z]{2}$/.test(country))return fail(400,'INVALID_QUERY','countryCode must be a two-letter country code.');
  if(category&&!CATEGORIES.has(category))return fail(400,'INVALID_QUERY','Unsupported service category.');
  if(city&&city.length>100)return fail(400,'INVALID_QUERY','city must not exceed 100 characters.');
  if(search&&search.length>120)return fail(400,'INVALID_QUERY','search must not exceed 120 characters.');
  const limit=limitRaw===null?20:Number(limitRaw),offset=offsetRaw===null?0:Number(offsetRaw);
  if(!Number.isInteger(limit)||limit<1||limit>50||!Number.isInteger(offset)||offset<0||offset>1000000)return fail(400,'INVALID_QUERY','limit must be 1–50 and offset must be 0–1,000,000.');
  return ok(await listMarketplaceServices({countryCode:country?country.toUpperCase():null,city,category,search,limit,offset}));
}

async function handle(req,url,user,business){
  if(url.pathname==='/api/v1/market/services')return marketplaceApi(req,url);
  if(url.pathname==='/api/v1/customer'||url.pathname.startsWith('/api/v1/customer/')){
    if(!user)return fail(401,'UNAUTHENTICATED','A valid bearer access token is required.');
    return customerApi(req,url,user);
  }
  if(url.pathname==='/api/v1/business/bookings'||url.pathname.startsWith('/api/v1/business/bookings/')){
    if(!user)return fail(401,'UNAUTHENTICATED','A valid bearer access token is required.');
    return businessBookingsApi(req,url,user,business);
  }
  return fail(404,'NOT_FOUND','Marketplace route not found.');
}

export async function handleMarketplaceApi(req,url,user=null,business=null){
  try{return await handle(req,url,user,business);}
  catch(error){
    if(error?.code==='INVALID_JSON')return fail(400,'INVALID_JSON',error.message);
    if(error?.code==='UNSUPPORTED_MEDIA_TYPE')return fail(415,'UNSUPPORTED_MEDIA_TYPE',error.message);
    if(error?.code==='BODY_TOO_LARGE')return fail(413,'BODY_TOO_LARGE',error.message);
    if(error?.code==='23503')return fail(422,'INVALID_REFERENCE','The referenced record is not available to this account.');
    if(error?.code==='23505')return fail(409,'DUPLICATE_RESOURCE','A conflicting record already exists.');
    console.error(JSON.stringify({event:'marketplace_api_request_failed',code:typeof error?.code==='string'?error.code:'NO_CODE',name:typeof error?.name==='string'?error.name:'UNKNOWN_ERROR'}));
    return fail(500,'INTERNAL_ERROR','An unexpected server error occurred.');
  }
}

export async function handleNotificationApi(req,url,user){
  if(!user)return fail(401,'UNAUTHENTICATED','A valid bearer access token is required.');
  const path=url.pathname;
  if(path==='/api/v1/notifications'){
    if(req.method!=='GET')return methodNotAllowed(['GET']);
    return ok(await listNotifications(user.id));
  }
  const match=path.match(/^\/api\/v1\/notifications\/([^/]+)\/read$/);
  if(match){
    if(!['PATCH','POST'].includes(req.method))return methodNotAllowed(['PATCH','POST']);
    if(!validId(match[1]))return fail(400,'INVALID_ID','Notification ID must be a valid UUID.');
    return await markNotificationRead(user.id,match[1])?ok({read:true}):fail(404,'NOTIFICATION_NOT_FOUND','Unread notification not found.');
  }
  return fail(404,'NOT_FOUND','Notification route not found.');
}
