import {
  SERVICE_CATEGORIES,
  getProviderProfile, upsertProviderProfile, submitProviderProfile,
  listProviderCategories, replaceProviderCategories,
  listProviderAreas, createProviderArea, deleteProviderArea,
  listProviderAvailability, replaceProviderAvailability,
  setProviderAcceptingBookings,
  listProvidersForReview, reviewProvider, isCurrentPlatformAdmin,
  assignProviderToBooking, listProviderAssignments, getProviderAssignment,
  respondToProviderAssignment, listProviderAssignmentEvents,
  listBusinessAssignments, listBusinessAssignmentEvents, cancelBusinessAssignment
} from './provider_resources.js';
import { getBusinessBooking } from './marketplace_resources.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHONE=/^\+[1-9]\d{7,14}$/;
const TIME=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function reply(status,body,noContent=false){return {status,body,noContent};}
function ok(data,status=200){return reply(status,{data});}
function fail(status,code,message,details=[]){return reply(status,{error:{code,message,details}});}
function isObject(value){return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}
function fields(body,allowed){
  if(!isObject(body))return ['Request body must be a JSON object.'];
  return Object.keys(body).filter(key=>!allowed.includes(key)).map(key=>'Unknown field: '+key+'.');
}
function methodNotAllowed(methods){return fail(405,'METHOD_NOT_ALLOWED','HTTP method is not supported for this route.',['Allowed methods: '+methods.join(', ')+'.']);}
function validId(id){return typeof id==='string'&&UUID.test(id);}
function parseDate(value){
  if(typeof value!=='string'||!ISO.test(value))return null;
  const date=new Date(value);
  return Number.isNaN(date.getTime())?null:date;
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
function requireProvider(user){
  return user?.accountType==='provider'?null:fail(403,'PROVIDER_ACCOUNT_REQUIRED','This route requires a provider account.');
}
function requireBusinessManager(context){
  if(!context?.businessId||!context?.membership)return fail(401,'BUSINESS_CONTEXT_REQUIRED','A valid business context is required.');
  return ['owner','admin','manager'].includes(context.membership.role)
    ? null
    : fail(403,'INSUFFICIENT_ROLE','Only business owners, administrators and managers can assign providers.');
}
function validateProfile(body){
  const errors=fields(body,['displayName','professionalTitle','bio','phoneE164','countryCode','timeZone','yearsExperience']);
  if(!isObject(body))return errors;
  if(typeof body.displayName!=='string'||body.displayName.trim().length<2||body.displayName.trim().length>100)errors.push('displayName must be 2 to 100 characters.');
  if(body.professionalTitle!==undefined&&body.professionalTitle!==null&&(typeof body.professionalTitle!=='string'||body.professionalTitle.trim().length>100))errors.push('professionalTitle must not exceed 100 characters.');
  if(body.bio!==undefined&&body.bio!==null&&(typeof body.bio!=='string'||body.bio.length>2000))errors.push('bio must not exceed 2,000 characters.');
  if(typeof body.phoneE164!=='string'||!PHONE.test(body.phoneE164))errors.push('phoneE164 must use international E.164 format.');
  if(typeof body.countryCode!=='string'||!/^[A-Za-z]{2}$/.test(body.countryCode))errors.push('countryCode must be a two-letter code.');
  if(typeof body.timeZone!=='string')errors.push('timeZone is required.');
  else {
    try{new Intl.DateTimeFormat('en',{timeZone:body.timeZone});}
    catch{errors.push('timeZone must be a valid IANA time-zone identifier.');}
  }
  if(body.yearsExperience!==undefined&&body.yearsExperience!==null&&(!Number.isInteger(body.yearsExperience)||body.yearsExperience<0||body.yearsExperience>60))errors.push('yearsExperience must be an integer from 0 to 60.');
  return errors;
}
function validateCategories(body){
  const errors=fields(body,['categories']);
  if(!isObject(body))return errors;
  if(!Array.isArray(body.categories)||body.categories.length<1||body.categories.length>7)errors.push('categories must contain 1 to 7 supported service categories.');
  else{
    if(new Set(body.categories).size!==body.categories.length)errors.push('categories must not contain duplicates.');
    if(body.categories.some(value=>typeof value!=='string'||!SERVICE_CATEGORIES.has(value)))errors.push('categories contains an unsupported service category.');
  }
  return errors;
}
function validateArea(body){
  const errors=fields(body,['countryCode','region','city','postalCodePrefix']);
  if(!isObject(body))return errors;
  if(typeof body.countryCode!=='string'||!/^[A-Za-z]{2}$/.test(body.countryCode))errors.push('countryCode must be a two-letter code.');
  if(![body.region,body.city,body.postalCodePrefix].some(value=>typeof value==='string'&&value.trim().length))errors.push('Provide at least one of region, city or postalCodePrefix.');
  if(body.region!==undefined&&body.region!==null&&(typeof body.region!=='string'||body.region.trim().length>100))errors.push('region must not exceed 100 characters.');
  if(body.city!==undefined&&body.city!==null&&(typeof body.city!=='string'||body.city.trim().length>100))errors.push('city must not exceed 100 characters.');
  if(body.postalCodePrefix!==undefined&&body.postalCodePrefix!==null&&(typeof body.postalCodePrefix!=='string'||body.postalCodePrefix.trim().length>24))errors.push('postalCodePrefix must not exceed 24 characters.');
  return errors;
}
function validateAvailability(body){
  const errors=fields(body,['windows']);
  if(!isObject(body))return errors;
  if(!Array.isArray(body.windows)||body.windows.length<1||body.windows.length>21)errors.push('windows must contain 1 to 21 weekly availability windows.');
  else{
    const normalized=[];
    for(let index=0;index<body.windows.length;index++){
      const item=body.windows[index];
      if(!isObject(item)){errors.push('Each availability window must be an object.');continue;}
      const extra=Object.keys(item).filter(key=>!['dayOfWeek','startsAt','endsAt'].includes(key));
      if(extra.length)errors.push('Availability window contains unknown fields: '+extra.join(', ')+'.');
      if(!Number.isInteger(item.dayOfWeek)||item.dayOfWeek<0||item.dayOfWeek>6)errors.push('dayOfWeek must be 0 (Sunday) to 6 (Saturday).');
      if(!TIME.test(item.startsAt||'')||!TIME.test(item.endsAt||''))errors.push('startsAt and endsAt must use 24-hour HH:MM format.');
      else if(item.startsAt>=item.endsAt)errors.push('endsAt must be later than startsAt.');
      if(Number.isInteger(item.dayOfWeek)&&TIME.test(item.startsAt||'')&&TIME.test(item.endsAt||'')&&item.startsAt<item.endsAt){
        normalized.push({dayOfWeek:item.dayOfWeek,startsAt:item.startsAt,endsAt:item.endsAt});
      }
    }
    for(let i=0;i<normalized.length;i++){
      for(let j=i+1;j<normalized.length;j++){
        const a=normalized[i],b=normalized[j];
        if(a.dayOfWeek===b.dayOfWeek&&a.startsAt<b.endsAt&&b.startsAt<a.endsAt)errors.push('Availability windows on the same day must not overlap.');
      }
    }
  }
  return errors;
}
function validateAssignment(body){
  const errors=fields(body,['providerUserId','offeredStartAt','offeredEndAt','note']);
  if(!isObject(body))return errors;
  if(!validId(body.providerUserId))errors.push('providerUserId must be a valid UUID.');
  const start=body.offeredStartAt===undefined?null:parseDate(body.offeredStartAt);
  const end=body.offeredEndAt===undefined?null:parseDate(body.offeredEndAt);
  if(body.offeredStartAt!==undefined&&!start)errors.push('offeredStartAt must be an ISO-8601 timestamp with timezone.');
  if(body.offeredEndAt!==undefined&&!end)errors.push('offeredEndAt must be an ISO-8601 timestamp with timezone.');
  if((body.offeredStartAt===undefined)!==(body.offeredEndAt===undefined))errors.push('Provide both offeredStartAt and offeredEndAt, or omit both to use the confirmed booking window/service duration.');
  if(start&&end&&end<=start)errors.push('offeredEndAt must be later than offeredStartAt.');
  if(start&&start.getTime()<=Date.now())errors.push('offeredStartAt must be in the future.');
  if(body.note!==undefined&&body.note!==null&&(typeof body.note!=='string'||body.note.length>1000))errors.push('note must not exceed 1,000 characters.');
  return errors;
}
function operationError(error){
  const status={
    PROVIDER_ACCOUNT_REQUIRED:403,
    PROVIDER_PROFILE_REQUIRED:409,
    PROVIDER_PROFILE_INCOMPLETE:409,
    BOOKING_NOT_FOUND:404,
    ASSIGNMENT_NOT_FOUND:404,
    PROVIDER_NOT_VERIFIED:409,
    PROVIDER_SKILL_MISMATCH:422,
    PROVIDER_OUT_OF_AREA:422,
    PROVIDER_NOT_AVAILABLE:422,
    PROVIDER_TIME_CONFLICT:409,
    BOOKING_WINDOW_REQUIRED:422,
    BOOKING_NOT_ASSIGNABLE:409,
    INVALID_ASSIGNMENT_TRANSITION:409,
    ASSIGNMENT_NOT_CANCELLABLE:409
  }[error?.error]||500;
  return fail(status,error?.error||'INTERNAL_ERROR',error?.message||'The requested provider operation could not be completed.');
}
async function handleProvider(req,url,user,business){
  const path=url.pathname;
  const method=req.method;

  if(path==='/api/v1/provider'||path.startsWith('/api/v1/provider/')){
    const denied=requireProvider(user);if(denied)return denied;
    const providerPath=path.slice('/api/v1/provider'.length)||'/';
    if(providerPath==='/profile'){
      if(method==='GET')return ok(await getProviderProfile(user.id));
      if(method==='PUT'){
        const body=await readJson(req);const errors=validateProfile(body);
        if(errors.length)return fail(422,'VALIDATION_ERROR','Provider profile validation failed.',errors);
        const saved=await upsertProviderProfile(user.id,{
          ...body,displayName:body.displayName.trim(),
          professionalTitle:body.professionalTitle?.trim()||null,
          bio:body.bio?.trim()||null,
          phoneE164:body.phoneE164,
          countryCode:body.countryCode.toUpperCase()
        });
        if(saved?.error)return operationError(saved);
        return ok(await getProviderProfile(user.id));
      }
      return methodNotAllowed(['GET','PUT']);
    }
    if(providerPath==='/profile/submit'){
      if(method!=='POST')return methodNotAllowed(['POST']);
      const submitted=await submitProviderProfile(user.id);
      if(submitted?.error)return operationError(submitted);
      return ok(await getProviderProfile(user.id));
    }
    if(providerPath==='/services'){
      if(method==='GET')return ok(await listProviderCategories(user.id));
      if(method==='PUT'){
        const body=await readJson(req);const errors=validateCategories(body);
        if(errors.length)return fail(422,'VALIDATION_ERROR','Provider service categories validation failed.',errors);
        const saved=await replaceProviderCategories(user.id,body.categories);
        if(saved?.error)return operationError(saved);
        return ok(saved);
      }
      return methodNotAllowed(['GET','PUT']);
    }
    if(providerPath==='/service-areas'){
      if(method==='GET')return ok(await listProviderAreas(user.id));
      if(method==='POST'){
        const body=await readJson(req);const errors=validateArea(body);
        if(errors.length)return fail(422,'VALIDATION_ERROR','Provider service area validation failed.',errors);
        const saved=await createProviderArea(user.id,{
          countryCode:body.countryCode.toUpperCase(),
          region:body.region?.trim()||null,city:body.city?.trim()||null,
          postalCodePrefix:body.postalCodePrefix?.trim()||null
        });
        return ok(saved,201);
      }
      return methodNotAllowed(['GET','POST']);
    }
    const areaPath=providerPath.match(/^\/service-areas\/([^/]+)$/);
    if(areaPath){
      if(method!=='DELETE')return methodNotAllowed(['DELETE']);
      if(!validId(areaPath[1]))return fail(400,'INVALID_ID','Service area ID must be a valid UUID.');
      return await deleteProviderArea(user.id,areaPath[1])
        ? reply(204,undefined,true)
        : fail(404,'PROVIDER_AREA_NOT_FOUND','Provider service area not found.');
    }
    if(providerPath==='/availability'){
      if(method==='GET')return ok(await listProviderAvailability(user.id));
      if(method==='PUT'){
        const body=await readJson(req);const errors=validateAvailability(body);
        if(errors.length)return fail(422,'VALIDATION_ERROR','Provider availability validation failed.',errors);
        const saved=await replaceProviderAvailability(user.id,body.windows);
        if(saved?.error)return operationError(saved);
        return ok(saved);
      }
      return methodNotAllowed(['GET','PUT']);
    }
    if(providerPath==='/availability/accepting'){
      if(method!=='PATCH')return methodNotAllowed(['PATCH']);
      const body=await readJson(req);const errors=fields(body,['isAcceptingBookings']);
      if(!isObject(body)||typeof body.isAcceptingBookings!=='boolean')errors.push('isAcceptingBookings must be boolean.');
      if(errors.length)return fail(422,'VALIDATION_ERROR','Provider availability status validation failed.',errors);
      const saved=await setProviderAcceptingBookings(user.id,body.isAcceptingBookings);
      return saved?ok(saved):fail(409,'PROVIDER_NOT_VERIFIED','Only active, verified providers can enable booking availability.');
    }
    if(providerPath==='/bookings'){
      if(method!=='GET')return methodNotAllowed(['GET']);
      const status=url.searchParams.get('status');
      const allowed=['offered','accepted','declined','cancelled','in_progress','completed'];
      if(status&&!allowed.includes(status))return fail(400,'INVALID_QUERY','Unknown provider assignment status.');
      return ok(await listProviderAssignments(user.id,status));
    }
    const providerEvents=providerPath.match(/^\/bookings\/([^/]+)\/events$/);
    if(providerEvents){
      if(method!=='GET')return methodNotAllowed(['GET']);
      if(!validId(providerEvents[1]))return fail(400,'INVALID_ID','Assignment ID must be a valid UUID.');
      const assignment=await getProviderAssignment(user.id,providerEvents[1]);
      if(!assignment)return fail(404,'ASSIGNMENT_NOT_FOUND','Provider assignment not found.');
      return ok(await listProviderAssignmentEvents(user.id,providerEvents[1]));
    }
    const providerStatus=providerPath.match(/^\/bookings\/([^/]+)\/status$/);
    if(providerStatus){
      if(method!=='PATCH')return methodNotAllowed(['PATCH']);
      if(!validId(providerStatus[1]))return fail(400,'INVALID_ID','Assignment ID must be a valid UUID.');
      const body=await readJson(req);const errors=fields(body,['action','note']);
      const actions=['accept','decline','in_progress','completed','cancelled'];
      if(!isObject(body)||!actions.includes(body.action))errors.push('action must be accept, decline, in_progress, completed or cancelled.');
      if(body.note!==undefined&&body.note!==null&&(typeof body.note!=='string'||body.note.length>1000))errors.push('note must not exceed 1,000 characters.');
      if(errors.length)return fail(422,'VALIDATION_ERROR','Provider assignment response validation failed.',errors);
      const saved=await respondToProviderAssignment(user.id,providerStatus[1],body.action,body.note?.trim()||null);
      return saved?.error?operationError(saved):ok(saved);
    }
    const providerBooking=providerPath.match(/^\/bookings\/([^/]+)$/);
    if(providerBooking){
      if(method!=='GET')return methodNotAllowed(['GET']);
      if(!validId(providerBooking[1]))return fail(400,'INVALID_ID','Assignment ID must be a valid UUID.');
      const assignment=await getProviderAssignment(user.id,providerBooking[1]);
      return assignment?ok(assignment):fail(404,'ASSIGNMENT_NOT_FOUND','Provider assignment not found.');
    }
    return fail(404,'NOT_FOUND','Provider route not found.');
  }

  if(path==='/api/v1/admin/providers'||path.startsWith('/api/v1/admin/providers/')){
    if(!user)return fail(401,'UNAUTHENTICATED','A valid bearer access token is required.');
    if(!await isCurrentPlatformAdmin(user.id))return fail(403,'PLATFORM_ADMIN_REQUIRED','Only platform administrators can review provider verification.');
    if(path==='/api/v1/admin/providers'){
      if(method!=='GET')return methodNotAllowed(['GET']);
      const status=url.searchParams.get('status')||'submitted';
      if(!['submitted','active','rejected','suspended'].includes(status))return fail(400,'INVALID_QUERY','Unknown provider profile status.');
      return ok(await listProvidersForReview(status));
    }
    const reviewPath=path.match(/^\/api\/v1\/admin\/providers\/([^/]+)\/verification$/);
    if(reviewPath){
      if(method!=='PATCH')return methodNotAllowed(['PATCH']);
      if(!validId(reviewPath[1]))return fail(400,'INVALID_ID','Provider user ID must be a valid UUID.');
      const body=await readJson(req);const errors=fields(body,['verificationStatus','note']);
      if(!isObject(body)||!['verified','rejected'].includes(body.verificationStatus))errors.push('verificationStatus must be verified or rejected.');
      if(body.note!==undefined&&body.note!==null&&(typeof body.note!=='string'||body.note.length>1000))errors.push('note must not exceed 1,000 characters.');
      if(errors.length)return fail(422,'VALIDATION_ERROR','Provider review validation failed.',errors);
      const saved=await reviewProvider(reviewPath[1],user.id,body.verificationStatus,body.note?.trim()||null);
      return saved?ok(saved):fail(409,'PROVIDER_NOT_REVIEWABLE','Provider is not awaiting a verification decision.');
    }
    return fail(404,'NOT_FOUND','Provider admin route not found.');
  }

  if(path.startsWith('/api/v1/business/bookings/')){
    if(!user)return fail(401,'UNAUTHENTICATED','A valid bearer access token is required.');
    if(!business?.businessId||!business?.membership)return fail(400,'BUSINESS_CONTEXT_REQUIRED','A valid business context is required.');
    const businessPath=path.slice('/api/v1/business/bookings/'.length);
    const match=businessPath.match(/^([^/]+)\/assignments(?:\/([^/]+)(?:\/events)?)?$/);
    if(!match)return fail(404,'NOT_FOUND','Business provider assignment route not found.');
    const bookingId=match[1],assignmentId=match[2]||null;
    if(!validId(bookingId)||assignmentId&&!validId(assignmentId))return fail(400,'INVALID_ID','Booking and assignment IDs must be valid UUIDs.');
    const role=business.membership.role;
    const manager=['owner','admin','manager'].includes(role);
    const reader=['owner','admin','manager','staff'].includes(role);
    if(!reader)return fail(403,'BUSINESS_ACCESS_DENIED','You do not have access to this business.');
    if(assignmentId&&businessPath.endsWith('/events')){
      if(method!=='GET')return methodNotAllowed(['GET']);
      const assignment= (await listBusinessAssignments(business.businessId,bookingId)).find(item=>item.id===assignmentId);
      if(!assignment)return fail(404,'ASSIGNMENT_NOT_FOUND','Assignment not found.');
      return ok(await listBusinessAssignmentEvents(business.businessId,assignmentId));
    }
    if(assignmentId){
      if(method!=='DELETE')return methodNotAllowed(['DELETE']);
      if(!manager)return fail(403,'INSUFFICIENT_ROLE','Only business owners, administrators and managers can cancel assignments.');
      const cancelled=await cancelBusinessAssignment(business.businessId,bookingId,assignmentId,user.id,'Cancelled by business.');
      return cancelled?.error?operationError(cancelled):ok(cancelled);
    }
    if(method==='GET'){
      const booking=await getBusinessBooking(business.businessId,bookingId);
      if(!booking)return fail(404,'BOOKING_NOT_FOUND','Booking not found.');
      return ok(await listBusinessAssignments(business.businessId,bookingId));
    }
    if(method==='POST'){
      if(!manager)return fail(403,'INSUFFICIENT_ROLE','Only business owners, administrators and managers can assign providers.');
      const body=await readJson(req);const errors=validateAssignment(body);
      if(errors.length)return fail(422,'VALIDATION_ERROR','Provider assignment validation failed.',errors);
      const assigned=await assignProviderToBooking(business.businessId,bookingId,body.providerUserId,user.id,{
        offeredStartAt:body.offeredStartAt?new Date(body.offeredStartAt).toISOString():undefined,
        offeredEndAt:body.offeredEndAt?new Date(body.offeredEndAt).toISOString():undefined,
        note:body.note?.trim()||null
      });
      return assigned?.error?operationError(assigned):ok(assigned,201);
    }
    return methodNotAllowed(['GET','POST']);
  }
  return fail(404,'NOT_FOUND','Provider route not found.');
}

export async function handleProviderApi(req,url,user=null,business=null){
  try{return await handleProvider(req,url,user,business);}
  catch(error){
    if(error?.code==='INVALID_JSON')return fail(400,'INVALID_JSON',error.message);
    if(error?.code==='UNSUPPORTED_MEDIA_TYPE')return fail(415,'UNSUPPORTED_MEDIA_TYPE',error.message);
    if(error?.code==='BODY_TOO_LARGE')return fail(413,'BODY_TOO_LARGE',error.message);
    if(error?.code==='23505')return fail(409,'DUPLICATE_RESOURCE','A conflicting provider record already exists.');
    if(error?.code==='23503')return fail(422,'INVALID_REFERENCE','A referenced provider or booking record is invalid.');
    console.error(JSON.stringify({event:'provider_api_request_failed',code:typeof error?.code==='string'?error.code:'NO_CODE',name:typeof error?.name==='string'?error.name:'UNKNOWN_ERROR'}));
    return fail(500,'INTERNAL_ERROR','An unexpected server error occurred.');
  }
}
