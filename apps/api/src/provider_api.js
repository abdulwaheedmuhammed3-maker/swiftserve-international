import {
  initializeProviderProfile, getProviderProfile, updateProviderProfile,
  listProviderSkills, replaceProviderSkills, listProviderAreas,
  createProviderArea, deleteProviderArea, listProviderAvailability,
  replaceProviderAvailability, requestProviderVerification, reviewProviderVerification,
  listBusinessProviders, createProviderInvitation, listProviderInvitations,
  revokeProviderInvitation, acceptProviderInvitation
} from './provider_resources.js';
import {
  assignBookingToProvider, listBusinessAssignments, listProviderAssignments,
  getProviderAssignment, respondProviderAssignment, updateProviderBookingStatus,
  cancelBookingAssignment
} from './provider_assignments.js';
import { getBusinessBooking } from './marketplace_resources.js';
import { queryDatabase } from './repository.js';
import { writeAdminAuditEvent } from './admin_resources.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE=/^\+[1-9]\d{7,14}$/;
const TIME=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const CATEGORIES=new Set(['cleaning','laundry','electrical','plumbing','ac-repair','appliance-repair','errand']);

function response(status,body,noContent=false){return {status,body,noContent};}
function ok(data,status=200){return response(status,{data});}
function fail(status,code,message,details=[]){return response(status,{error:{code,message,details}});}
function object(value){return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}
function validId(value){return typeof value==='string'&&UUID.test(value);}
function allowed(body,keys){
  if(!object(body))return ['Request body must be a JSON object.'];
  return Object.keys(body).filter(key=>!keys.includes(key)).map(key=>'Unknown field: '+key+'.');
}
function method(methods){return fail(405,'METHOD_NOT_ALLOWED','HTTP method is not supported for this route.',['Allowed methods: '+methods.join(', ')+'.']);}
function isIsoFuture(value){
  return typeof value==='string'&&ISO.test(value)&&Number.isFinite(Date.parse(value))&&Date.parse(value)>Date.now();
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
function manager(membership){return ['owner','admin','manager'].includes(membership?.role);}
function providerOnly(user){
  return user?.accountType==='provider'?null:fail(403,'PROVIDER_ACCOUNT_REQUIRED','This endpoint requires a provider account.');
}
function businessOnly(business){
  return business?.businessId&&business?.membership?null:fail(400,'BUSINESS_CONTEXT_REQUIRED','A valid business context is required.');
}
function validateProfile(body){
  const errors=allowed(body,['displayName','phoneE164','bio','countryCode','timeZone']);
  if(!object(body))return errors;
  if(!Object.keys(body).length)errors.push('At least one field is required.');
  if('displayName'in body&&(typeof body.displayName!=='string'||body.displayName.trim().length<2||body.displayName.trim().length>100))errors.push('displayName must be 2 to 100 characters.');
  if('phoneE164'in body&&body.phoneE164!==null&&(typeof body.phoneE164!=='string'||!PHONE.test(body.phoneE164)))errors.push('phoneE164 must use E.164 format or null.');
  if('bio'in body&&body.bio!==null&&(typeof body.bio!=='string'||body.bio.length>1500))errors.push('bio must not exceed 1,500 characters.');
  if('countryCode'in body&&(typeof body.countryCode!=='string'||!/^[A-Za-z]{2}$/.test(body.countryCode)))errors.push('countryCode must be a two-letter code.');
  if('timeZone'in body){
    try{new Intl.DateTimeFormat('en',{timeZone:body.timeZone});}
    catch{errors.push('timeZone must be a valid IANA time-zone identifier.');}
  }
  return errors;
}
function validateSkills(body){
  const errors=allowed(body,['items']);
  if(!object(body))return errors;
  if(!Array.isArray(body.items)||body.items.length<1||body.items.length>CATEGORIES.size)errors.push('items must contain between 1 and 7 skills.');
  if(Array.isArray(body.items)){
    const seen=new Set();
    for(const item of body.items){
      if(!object(item)){errors.push('Each skill must be an object.');continue;}
      for(const key of Object.keys(item))if(!['category','yearsExperience'].includes(key))errors.push('Unknown skill field: '+key+'.');
      if(!CATEGORIES.has(item.category))errors.push('Each skill must use a supported service category.');
      if(seen.has(item.category))errors.push('Skill categories must be unique.');
      seen.add(item.category);
      if(!Number.isInteger(item.yearsExperience)||item.yearsExperience<0||item.yearsExperience>50)errors.push('yearsExperience must be an integer from 0 to 50.');
    }
  }
  return errors;
}
function validateArea(body){
  const errors=allowed(body,['countryCode','region','city','postalCodePrefix']);
  if(!object(body))return errors;
  if(typeof body.countryCode!=='string'||!/^[A-Za-z]{2}$/.test(body.countryCode))errors.push('countryCode must be a two-letter code.');
  if(![body.region,body.city,body.postalCodePrefix].some(item=>typeof item==='string'&&item.trim()))errors.push('Provide a city, region or postalCodePrefix.');
  if(body.region!==undefined&&(typeof body.region!=='string'||body.region.length>100))errors.push('region must not exceed 100 characters.');
  if(body.city!==undefined&&(typeof body.city!=='string'||body.city.length>100))errors.push('city must not exceed 100 characters.');
  if(body.postalCodePrefix!==undefined&&(typeof body.postalCodePrefix!=='string'||body.postalCodePrefix.length>24))errors.push('postalCodePrefix must not exceed 24 characters.');
  return errors;
}
function validateAvailability(body){
  const errors=allowed(body,['days']);
  if(!object(body))return errors;
  if(!Array.isArray(body.days)||body.days.length<1||body.days.length>7)errors.push('days must contain between 1 and 7 entries.');
  if(Array.isArray(body.days)){
    const seen=new Set();
    for(const item of body.days){
      if(!object(item)){errors.push('Each day must be an object.');continue;}
      for(const key of Object.keys(item))if(!['dayOfWeek','isAvailable','opensAt','closesAt'].includes(key))errors.push('Unknown availability field: '+key+'.');
      if(!Number.isInteger(item.dayOfWeek)||item.dayOfWeek<0||item.dayOfWeek>6)errors.push('dayOfWeek must be an integer from 0 to 6.');
      if(seen.has(item.dayOfWeek))errors.push('Availability days must be unique.');
      seen.add(item.dayOfWeek);
      if(typeof item.isAvailable!=='boolean')errors.push('isAvailable must be boolean.');
      if(item.isAvailable){
        if(!TIME.test(item.opensAt||'')||!TIME.test(item.closesAt||''))errors.push('Available days require opensAt and closesAt in HH:MM format.');
        else if(item.opensAt>=item.closesAt)errors.push('closesAt must be later than opensAt.');
      }else if(item.opensAt!=null||item.closesAt!=null)errors.push('Unavailable days must not have opening times.');
    }
  }
  return errors;
}
function validateAssignment(body){
  const errors=allowed(body,['providerUserId','scheduledStartAt','scheduledEndAt','providerNote']);
  if(!object(body))return errors;
  if(!validId(body.providerUserId))errors.push('providerUserId must be a valid UUID.');
  if(!isIsoFuture(body.scheduledStartAt))errors.push('scheduledStartAt must be a future ISO-8601 timestamp with timezone.');
  if(typeof body.scheduledEndAt!=='string'||!ISO.test(body.scheduledEndAt)||!Number.isFinite(Date.parse(body.scheduledEndAt)))errors.push('scheduledEndAt must be an ISO-8601 timestamp with timezone.');
  else if(Date.parse(body.scheduledStartAt)>=Date.parse(body.scheduledEndAt))errors.push('scheduledEndAt must be later than scheduledStartAt.');
  if(body.providerNote!==undefined&&body.providerNote!==null&&(typeof body.providerNote!=='string'||body.providerNote.length>1000))errors.push('providerNote must not exceed 1,000 characters.');
  return errors;
}

async function handleProvider(req,url,user){
  const denied=providerOnly(user);if(denied)return denied;
  const path=url.pathname.slice('/api/v1/provider'.length)||'/';
  const methodName=req.method;

  if(path==='/profile'){
    if(methodName==='GET'){
      const profile=await getProviderProfile(user);
      return profile?ok(profile):fail(404,'PROVIDER_PROFILE_NOT_FOUND','Provider profile not found.');
    }
    if(methodName==='PATCH'){
      const body=await readJson(req);const errors=validateProfile(body);
      if(errors.length)return fail(422,'VALIDATION_ERROR','Provider profile validation failed.',errors);
      const patch={...body};
      if(typeof patch.displayName==='string')patch.displayName=patch.displayName.trim();
      if(typeof patch.countryCode==='string')patch.countryCode=patch.countryCode.toUpperCase();
      const profile=await updateProviderProfile(user.id,patch);
      return profile?ok(profile):fail(404,'PROVIDER_PROFILE_NOT_FOUND','Provider profile not found.');
    }
    return method(['GET','PATCH']);
  }

  if(path==='/skills'){
    if(methodName==='GET')return ok(await listProviderSkills(user.id));
    if(methodName==='PUT'){
      const body=await readJson(req);const errors=validateSkills(body);
      if(errors.length)return fail(422,'VALIDATION_ERROR','Provider skills validation failed.',errors);
      const items=body.items.map(item=>({category:item.category,yearsExperience:item.yearsExperience}));
      return ok(await replaceProviderSkills(user.id,items));
    }
    return method(['GET','PUT']);
  }

  if(path==='/service-areas'){
    if(methodName==='GET')return ok(await listProviderAreas(user.id));
    if(methodName==='POST'){
      const body=await readJson(req);const errors=validateArea(body);
      if(errors.length)return fail(422,'VALIDATION_ERROR','Provider service-area validation failed.',errors);
      body.countryCode=body.countryCode.toUpperCase();
      if(typeof body.city==='string')body.city=body.city.trim();
      if(typeof body.region==='string')body.region=body.region.trim();
      return ok(await createProviderArea(user.id,body),201);
    }
    return method(['GET','POST']);
  }

  const area=path.match(/^\/service-areas\/([^/]+)$/);
  if(area){
    if(!validId(area[1]))return fail(400,'INVALID_ID','Service-area ID must be a valid UUID.');
    if(methodName!=='DELETE')return method(['DELETE']);
    return await deleteProviderArea(user.id,area[1])
      ?response(204,undefined,true):fail(404,'SERVICE_AREA_NOT_FOUND','Provider service area not found.');
  }

  if(path==='/availability'){
    if(methodName==='GET')return ok(await listProviderAvailability(user.id));
    if(methodName==='PUT'){
      const body=await readJson(req);const errors=validateAvailability(body);
      if(errors.length)return fail(422,'VALIDATION_ERROR','Provider availability validation failed.',errors);
      return ok(await replaceProviderAvailability(user.id,body.days));
    }
    return method(['GET','PUT']);
  }

  if(path==='/verification/request'){
    if(methodName!=='POST')return method(['POST']);
    const result=await requestProviderVerification(user.id);
    return result.error?fail(409,'ONBOARDING_INCOMPLETE',result.error):ok(result.profile);
  }

  if(path==='/invitations/accept'){
    if(methodName!=='POST')return method(['POST']);
    const body=await readJson(req);const errors=allowed(body,['invitationToken']);
    if(!object(body)||typeof body.invitationToken!=='string'||!/^[a-f0-9]{64}$/i.test(body.invitationToken))errors.push('invitationToken must be a 64-character token.');
    if(errors.length)return fail(422,'VALIDATION_ERROR','Provider invitation acceptance validation failed.',errors);
    const accepted=await acceptProviderInvitation(body.invitationToken,user);
    return accepted?ok(accepted):fail(404,'PROVIDER_INVITATION_NOT_FOUND','The invitation is invalid, expired, or addressed to another account.');
  }

  if(path==='/bookings'){
    if(methodName!=='GET')return method(['GET']);
    return ok(await listProviderAssignments(user.id));
  }

  const booking=path.match(/^\/bookings\/([^/]+)$/);
  if(booking){
    if(!validId(booking[1]))return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
    if(methodName!=='GET')return method(['GET']);
    const item=await getProviderAssignment(user.id,booking[1]);
    return item?ok(item):fail(404,'PROVIDER_BOOKING_NOT_FOUND','No active assignment exists for this booking.');
  }

  const responsePath=path.match(/^\/bookings\/([^/]+)\/respond$/);
  if(responsePath){
    if(!validId(responsePath[1]))return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
    if(methodName!=='POST')return method(['POST']);
    const body=await readJson(req);const errors=allowed(body,['action','note']);
    if(!object(body)||!['accept','decline'].includes(body.action))errors.push('action must be accept or decline.');
    if(body.note!==undefined&&body.note!==null&&(typeof body.note!=='string'||body.note.length>1000))errors.push('note must not exceed 1,000 characters.');
    if(errors.length)return fail(422,'VALIDATION_ERROR','Assignment response validation failed.',errors);
    const updated=await respondProviderAssignment(user.id,responsePath[1],body.action,body.note??null);
    return updated?ok(updated):fail(409,'ASSIGNMENT_NOT_AVAILABLE','The assignment is no longer awaiting a response.');
  }

  const statusPath=path.match(/^\/bookings\/([^/]+)\/status$/);
  if(statusPath){
    if(!validId(statusPath[1]))return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
    if(methodName!=='PATCH')return method(['PATCH']);
    const body=await readJson(req);const errors=allowed(body,['status','note']);
    if(!object(body)||!['in_progress','completed'].includes(body.status))errors.push('status must be in_progress or completed.');
    if(body.note!==undefined&&body.note!==null&&(typeof body.note!=='string'||body.note.length>1000))errors.push('note must not exceed 1,000 characters.');
    if(errors.length)return fail(422,'VALIDATION_ERROR','Provider booking status validation failed.',errors);
    const updated=await updateProviderBookingStatus(user.id,statusPath[1],body.status,body.note??null);
    return updated?ok(updated):fail(409,'INVALID_PROVIDER_BOOKING_TRANSITION','The assignment cannot make the requested status transition.');
  }

  return fail(404,'NOT_FOUND','Provider route not found.');
}

async function handleBusinessProviders(req,url,user,business){
  const invalid=businessOnly(business);if(invalid)return invalid;
  if(!manager(business.membership))return fail(403,'INSUFFICIENT_ROLE','Only business owners, admins and managers can manage providers.');
  const path=url.pathname;
  if(path==='/api/v1/business/providers'){
    if(req.method!=='GET')return method(['GET']);
    return ok(await listBusinessProviders(business.businessId));
  }
  if(path==='/api/v1/business/providers/invitations'){
    if(req.method==='GET')return ok(await listProviderInvitations(business.businessId));
    if(req.method==='POST'){
      const body=await readJson(req);const errors=allowed(body,['email']);
      if(!object(body)||typeof body.email!=='string'||body.email.length>254||!EMAIL.test(body.email.trim()))errors.push('email must be a valid address.');
      if(errors.length)return fail(422,'VALIDATION_ERROR','Provider invitation validation failed.',errors);
      const invitation=await createProviderInvitation(business.businessId,body.email.trim().toLowerCase(),user.id);
      return ok({
        invitation:invitation.invitation,
        invitationToken:invitation.invitationToken,
        delivery:'pending',
        notice:'No email delivery provider is connected. Share this token privately with the invited provider.'
      },201);
    }
    return method(['GET','POST']);
  }
  const invitation=path.match(/^\/api\/v1\/business\/providers\/invitations\/([^/]+)$/);
  if(invitation){
    if(!validId(invitation[1]))return fail(400,'INVALID_ID','Invitation ID must be a valid UUID.');
    if(req.method!=='DELETE')return method(['DELETE']);
    return await revokeProviderInvitation(business.businessId,invitation[1])
      ?response(204,undefined,true):fail(404,'PROVIDER_INVITATION_NOT_FOUND','Pending invitation not found.');
  }

  const assignment=path.match(/^\/api\/v1\/business\/bookings\/([^/]+)\/assignments(?:\/([^/]+))?$/);
  if(assignment){
    if(!validId(assignment[1]))return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
    if(assignment[2]&&!validId(assignment[2]))return fail(400,'INVALID_ID','Assignment ID must be a valid UUID.');
    if(!assignment[2]&&req.method==='GET'){
      const booking=await getBusinessBooking(business.businessId,assignment[1]);
      if(!booking)return fail(404,'BOOKING_NOT_FOUND','Booking not found.');
      return ok(await listBusinessAssignments(business.businessId,assignment[1]));
    }
    if(!assignment[2]&&req.method==='POST'){
      const body=await readJson(req);const errors=validateAssignment(body);
      if(errors.length)return fail(422,'VALIDATION_ERROR','Booking assignment validation failed.',errors);
      const booking=await getBusinessBooking(business.businessId,assignment[1]);
      if(!booking)return fail(404,'BOOKING_NOT_FOUND','Booking not found.');
      const assigned=await assignBookingToProvider({
        businessId:business.businessId,booking,providerUserId:body.providerUserId,
        assignedByUserId:user.id,scheduledStartAt:new Date(body.scheduledStartAt).toISOString(),
        scheduledEndAt:new Date(body.scheduledEndAt).toISOString(),providerNote:body.providerNote??null
      });
      return assigned.error?fail(409,'PROVIDER_NOT_ASSIGNABLE',assigned.error):ok(assigned.assignment,201);
    }
    if(assignment[2]&&req.method==='DELETE'){
      return await cancelBookingAssignment(business.businessId,assignment[1],assignment[2])
        ?ok({cancelled:true}):fail(404,'ASSIGNMENT_NOT_FOUND','Active assignment not found.');
    }
    return method(assignment[2]?['DELETE']:['GET','POST']);
  }

  return fail(404,'NOT_FOUND','Business provider route not found.');
}

export async function handleProviderApi(req,url,user,business=null){
  try{
    if(url.pathname.startsWith('/api/v1/provider/'))return await handleProvider(req,url,user);
    if(url.pathname.startsWith('/api/v1/business/providers')||
       /^\/api\/v1\/business\/bookings\/[^/]+\/assignments/.test(url.pathname)){
      return await handleBusinessProviders(req,url,user,business);
    }
    return fail(404,'NOT_FOUND','Provider route not found.');
  }catch(error){
    if(error?.code==='INVALID_JSON')return fail(400,'INVALID_JSON',error.message);
    if(error?.code==='UNSUPPORTED_MEDIA_TYPE')return fail(415,'UNSUPPORTED_MEDIA_TYPE',error.message);
    if(error?.code==='BODY_TOO_LARGE')return fail(413,'BODY_TOO_LARGE',error.message);
    if(error?.code==='23503')return fail(422,'INVALID_REFERENCE','The referenced provider or booking is not available.');
    if(error?.code==='23505')return fail(409,'DUPLICATE_RESOURCE','A conflicting provider operation already exists.');
    console.error(JSON.stringify({event:'provider_api_failed',code:typeof error?.code==='string'?error.code:'NO_CODE',name:typeof error?.name==='string'?error.name:'UNKNOWN_ERROR'}));
    return fail(500,'INTERNAL_ERROR','An unexpected provider API error occurred.');
  }
}

export async function handleAdminProviderApi(req,url){
  const path=url.pathname;
  if(path==='/api/v1/admin/providers/pending'){
    if(req.method!=='GET')return method(['GET']);
    const result=await queryDatabase(
      "SELECT p.user_id,p.display_name,p.country_code,p.time_zone,p.onboarding_status,p.verification_status,p.created_at,u.email,u.full_name FROM provider_profiles p JOIN users u ON u.id=p.user_id WHERE p.verification_status='pending_review' ORDER BY p.created_at ASC"
    );
    return result
      ?ok(result.rows.map(row=>({userId:row.user_id,email:row.email,fullName:row.full_name,displayName:row.display_name,countryCode:row.country_code,timeZone:row.time_zone,onboardingStatus:row.onboarding_status,verificationStatus:row.verification_status,createdAt:new Date(row.created_at).toISOString()})))
      :ok([]);
  }
  const match=path.match(/^\/api\/v1\/admin\/providers\/([^/]+)\/verification$/);
  if(match){
    if(!validId(match[1]))return fail(400,'INVALID_ID','Provider user ID must be a valid UUID.');
    if(req.method!=='PATCH')return method(['PATCH']);
    const body=await readJson(req);const errors=allowed(body,['status','note']);
    if(!object(body)||!['verified','rejected'].includes(body.status))errors.push('status must be verified or rejected.');
    if(body.note!==undefined&&body.note!==null&&(typeof body.note!=='string'||body.note.length>1000))errors.push('note must not exceed 1,000 characters.');
    if(errors.length)return fail(422,'VALIDATION_ERROR','Provider verification review validation failed.',errors);
    const profile=await reviewProviderVerification(match[1],body.status,body.note??null);
    if(profile)await writeAdminAuditEvent({
      action:'provider.verification.reviewed',targetType:'provider',targetId:match[1],
      details:{verificationStatus:body.status,noteProvided:Boolean(body.note)}
    });
    return profile?ok(profile):fail(404,'PROVIDER_NOT_FOUND','Provider profile not found.');
  }
  return fail(404,'NOT_FOUND','Admin provider route not found.');
}
