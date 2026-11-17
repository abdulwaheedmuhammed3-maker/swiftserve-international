import {
  getProviderProfile, saveProviderProfile, saveProviderCategories,
  saveProviderAreas, saveProviderAvailability, submitProviderForReview,
  reviewProviderProfile, listBusinessProviders,
  listProviderAssignments, listBusinessProviderAssignments,
  assignProviderToBooking, updateProviderAssignment,
  cancelBusinessAssignment
} from './provider_resources.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHONE=/^\+[1-9]\d{7,14}$/;
const TIME=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
const CATEGORIES=new Set(['cleaning','laundry','electrical','plumbing','ac-repair','appliance-repair','errand']);

function response(status,body,noContent=false){return {status,body,noContent};}
function ok(data,status=200){return response(status,{data});}
function fail(status,code,message,details=[]){return response(status,{error:{code,message,details}});}
function object(value){return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}
function validateFields(body,allowed){
  if(!object(body))return ['Request body must be a JSON object.'];
  return Object.keys(body).filter(key=>!allowed.includes(key)).map(key=>'Unknown field: '+key+'.');
}
function methodNotAllowed(methods){return fail(405,'METHOD_NOT_ALLOWED','HTTP method is not supported for this route.',['Allowed methods: '+methods.join(', ')+'.']);}
function validId(value){return typeof value==='string'&&UUID.test(value);}
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
function validTimeZone(value){
  if(typeof value!=='string'||value.length>64)return false;
  try{new Intl.DateTimeFormat('en-US',{timeZone:value}).format(new Date());return true;}
  catch{return false;}
}
function validateProfile(body,partial=false){
  const allowed=['displayName','phoneE164','bio','countryCode','timeZone','yearsExperience','languages'];
  const errors=validateFields(body,allowed);
  if(!object(body))return errors;
  for(const key of ['displayName','phoneE164','countryCode','timeZone']){
    if((!partial||key in body)&&typeof body[key]!=='string')errors.push(key+' is required.');
  }
  if('displayName'in body&&(typeof body.displayName!=='string'||body.displayName.trim().length<2||body.displayName.trim().length>100))errors.push('displayName must be 2 to 100 characters.');
  if('phoneE164'in body&&(typeof body.phoneE164!=='string'||!PHONE.test(body.phoneE164)))errors.push('phoneE164 must use international E.164 format.');
  if('bio'in body&&body.bio!==null&&(typeof body.bio!=='string'||body.bio.length>1200))errors.push('bio must not exceed 1,200 characters.');
  if('countryCode'in body&&(typeof body.countryCode!=='string'||!/^[A-Za-z]{2}$/.test(body.countryCode)))errors.push('countryCode must be a two-letter country code.');
  if('timeZone'in body&&!validTimeZone(body.timeZone))errors.push('timeZone must be a valid IANA time-zone name.');
  if('yearsExperience'in body&&(!Number.isInteger(body.yearsExperience)||body.yearsExperience<0||body.yearsExperience>60))errors.push('yearsExperience must be an integer from 0 to 60.');
  if('languages'in body&&(!Array.isArray(body.languages)||body.languages.length<1||body.languages.length>8||body.languages.some(item=>typeof item!=='string'||!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(item))))errors.push('languages must contain 1 to 8 valid language tags.');
  if(partial&&Object.keys(body).length===0)errors.push('At least one field is required.');
  return errors;
}
function validateCategories(body){
  const errors=validateFields(body,['categories']);
  if(!object(body))return errors;
  if(!Array.isArray(body.categories)||body.categories.length>7)errors.push('categories must be an array of up to 7 supported service categories.');
  else{
    if(new Set(body.categories).size!==body.categories.length)errors.push('categories cannot contain duplicates.');
    for(const item of body.categories)if(!CATEGORIES.has(item))errors.push('Unsupported service category: '+String(item)+'.');
  }
  return errors;
}
function validateAreas(body){
  const errors=validateFields(body,['areas']);
  if(!object(body))return errors;
  if(!Array.isArray(body.areas)||body.areas.length>100)errors.push('areas must be an array of up to 100 coverage areas.');
  else{
    for(const [index,item] of body.areas.entries()){
      if(!object(item)){errors.push('areas['+index+'] must be an object.');continue;}
      for(const key of Object.keys(item))if(!['countryCode','region','city','postalCodePrefix'].includes(key))errors.push('Unknown areas['+index+'] field: '+key+'.');
      if(typeof item.countryCode!=='string'||!/^[A-Za-z]{2}$/.test(item.countryCode))errors.push('areas['+index+'].countryCode must be a two-letter code.');
      if(!item.city&&!item.region&&!item.postalCodePrefix)errors.push('areas['+index+'] must include city, region or postalCodePrefix.');
      for(const key of ['region','city','postalCodePrefix'])if(item[key]!==undefined&&(typeof item[key]!=='string'||item[key].trim().length>100))errors.push('areas['+index+'].'+key+' must be a string no longer than 100 characters.');
    }
  }
  return errors;
}
function validateAvailability(body){
  const errors=validateFields(body,['windows']);
  if(!object(body))return errors;
  if(!Array.isArray(body.windows)||body.windows.length>70)errors.push('windows must be an array of up to 70 weekly windows.');
  else{
    const byDay=new Map();
    for(const [index,item] of body.windows.entries()){
      if(!object(item)){errors.push('windows['+index+'] must be an object.');continue;}
      for(const key of Object.keys(item))if(!['dayOfWeek','startsAt','endsAt'].includes(key))errors.push('Unknown windows['+index+'] field: '+key+'.');
      if(!Number.isInteger(item.dayOfWeek)||item.dayOfWeek<0||item.dayOfWeek>6)errors.push('windows['+index+'].dayOfWeek must be 0 (Sunday) through 6 (Saturday).');
      if(typeof item.startsAt!=='string'||!TIME.test(item.startsAt))errors.push('windows['+index+'].startsAt must use HH:MM.');
      if(typeof item.endsAt!=='string'||!TIME.test(item.endsAt))errors.push('windows['+index+'].endsAt must use HH:MM.');
      if(TIME.test(item.startsAt||'')&&TIME.test(item.endsAt||'')&&item.endsAt<=item.startsAt)errors.push('windows['+index+'] must end after it starts and cannot cross midnight.');
      if(Number.isInteger(item.dayOfWeek)&&TIME.test(item.startsAt||'')&&TIME.test(item.endsAt||'')){
        const list=byDay.get(item.dayOfWeek)||[];
        list.push({start:item.startsAt,end:item.endsAt,index});
        byDay.set(item.dayOfWeek,list);
      }
    }
    for(const [day,list] of byDay){
      list.sort((a,b)=>a.start.localeCompare(b.start));
      for(let i=1;i<list.length;i++)if(list[i].start<list[i-1].end)errors.push('Availability windows overlap on weekday '+day+'.');
    }
  }
  return errors;
}
async function handleError(error){
  if(error?.code==='INVALID_JSON')return fail(400,'INVALID_JSON',error.message);
  if(error?.code==='UNSUPPORTED_MEDIA_TYPE')return fail(415,'UNSUPPORTED_MEDIA_TYPE',error.message);
  if(error?.code==='BODY_TOO_LARGE')return fail(413,'BODY_TOO_LARGE',error.message);
  if(error?.code==='23503')return fail(422,'INVALID_REFERENCE','The referenced user, business or booking does not exist.');
  if(error?.code==='23505')return fail(409,'DUPLICATE_RESOURCE','The requested record conflicts with an existing record.');
  console.error(JSON.stringify({event:'provider_api_failed',code:typeof error?.code==='string'?error.code:'NO_CODE',name:typeof error?.name==='string'?error.name:'UNKNOWN_ERROR'}));
  return fail(500,'INTERNAL_ERROR','An unexpected server error occurred.');
}

async function providerApi(req,url,user){
  const path=url.pathname.slice('/api/v1/provider'.length)||'/';
  const method=req.method;
  try{
    if(path==='/profile'){
      if(method==='GET'){
        const profile=await getProviderProfile(user.id);
        return profile?ok(profile):fail(404,'PROVIDER_PROFILE_NOT_FOUND','Create your provider profile to continue.');
      }
      if(method==='POST'||method==='PATCH'){
        const body=await readJson(req);
        const current=await getProviderProfile(user.id);
        const errors=validateProfile(body,method==='PATCH'&&Boolean(current));
        if(errors.length)return fail(422,'VALIDATION_ERROR','Provider profile validation failed.',errors);
        if(!current&&method==='PATCH')return fail(404,'PROVIDER_PROFILE_NOT_FOUND','Create your provider profile first.');
        if(current&&['pending_review','approved','suspended'].includes(current.status))return fail(409,'PROFILE_LOCKED','Your profile cannot be edited while it is '+current.status+'.');
        const input={...body};
        if(typeof input.displayName==='string')input.displayName=input.displayName.trim();
        if(typeof input.countryCode==='string')input.countryCode=input.countryCode.toUpperCase();
        return ok(await saveProviderProfile(user.id,input),current?200:201);
      }
      return methodNotAllowed(['GET','POST','PATCH']);
    }
    const skillsPath=path==='/services';
    if(skillsPath){
      if(method!=='PUT')return methodNotAllowed(['PUT']);
      const current=await getProviderProfile(user.id);
      if(!current)return fail(404,'PROVIDER_PROFILE_NOT_FOUND','Create your provider profile first.');
      if(['pending_review','approved','suspended'].includes(current.status))return fail(409,'PROFILE_LOCKED','Your profile cannot be edited while it is '+current.status+'.');
      const body=await readJson(req);const errors=validateCategories(body);
      if(errors.length)return fail(422,'VALIDATION_ERROR','Provider service-category validation failed.',errors);
      return ok(await saveProviderCategories(user.id,body.categories));
    }
    if(path==='/coverage-areas'){
      if(method!=='PUT')return methodNotAllowed(['PUT']);
      const current=await getProviderProfile(user.id);
      if(!current)return fail(404,'PROVIDER_PROFILE_NOT_FOUND','Create your provider profile first.');
      if(['pending_review','approved','suspended'].includes(current.status))return fail(409,'PROFILE_LOCKED','Your profile cannot be edited while it is '+current.status+'.');
      const body=await readJson(req);const errors=validateAreas(body);
      if(errors.length)return fail(422,'VALIDATION_ERROR','Provider coverage validation failed.',errors);
      const items=body.areas.map(item=>({
        countryCode:item.countryCode.toUpperCase(),
        region:item.region?.trim()||null,city:item.city?.trim()||null,
        postalCodePrefix:item.postalCodePrefix?.trim()||null
      }));
      return ok(await saveProviderAreas(user.id,items));
    }
    if(path==='/availability'){
      if(method!=='PUT')return methodNotAllowed(['PUT']);
      const current=await getProviderProfile(user.id);
      if(!current)return fail(404,'PROVIDER_PROFILE_NOT_FOUND','Create your provider profile first.');
      if(['pending_review','approved','suspended'].includes(current.status))return fail(409,'PROFILE_LOCKED','Your profile cannot be edited while it is '+current.status+'.');
      const body=await readJson(req);const errors=validateAvailability(body);
      if(errors.length)return fail(422,'VALIDATION_ERROR','Provider availability validation failed.',errors);
      return ok(await saveProviderAvailability(user.id,body.windows));
    }
    if(path==='/submit'){
      if(method!=='POST')return methodNotAllowed(['POST']);
      const profile=await submitProviderForReview(user.id);
      return profile.error?fail(409,'PROFILE_INCOMPLETE',profile.error):ok(profile);
    }
    if(path==='/assignments'){
      if(method!=='GET')return methodNotAllowed(['GET']);
      const status=url.searchParams.get('status');
      const allowed=new Set(['offered','accepted','declined','in_progress','completed','cancelled']);
      if(status&&!allowed.has(status))return fail(400,'INVALID_STATUS','Unknown provider assignment status.');
      const profile=await getProviderProfile(user.id);
      if(!profile||profile.status!=='approved')return fail(403,'PROVIDER_NOT_APPROVED','Only approved providers can view job assignments.');
      return ok(await listProviderAssignments(user.id,status));
    }
    const assignment=path.match(/^\/assignments\/([^/]+)$/);
    if(assignment){
      if(method!=='GET')return methodNotAllowed(['GET']);
      if(!validId(assignment[1]))return fail(400,'INVALID_ID','Assignment ID must be a valid UUID.');
      const profile=await getProviderProfile(user.id);
      if(!profile||profile.status!=='approved')return fail(403,'PROVIDER_NOT_APPROVED','Only approved providers can view assignments.');
      const list=await listProviderAssignments(user.id);
      const item=list.find(entry=>entry.id===assignment[1]);
      return item?ok(item):fail(404,'ASSIGNMENT_NOT_FOUND','Assignment not found.');
    }
    const respond=path.match(/^\/assignments\/([^/]+)\/respond$/);
    if(respond){
      if(method!=='POST')return methodNotAllowed(['POST']);
      if(!validId(respond[1]))return fail(400,'INVALID_ID','Assignment ID must be a valid UUID.');
      const profile=await getProviderProfile(user.id);
      if(!profile||profile.status!=='approved')return fail(403,'PROVIDER_NOT_APPROVED','Only approved providers can respond to offers.');
      const body=await readJson(req);const errors=validateFields(body,['action','note']);
      if(!object(body)||!['accept','decline'].includes(body.action))errors.push('action must be accept or decline.');
      if(body.note!==undefined&&body.note!==null&&(typeof body.note!=='string'||body.note.length>1000))errors.push('note must not exceed 1,000 characters.');
      if(errors.length)return fail(422,'VALIDATION_ERROR','Assignment response validation failed.',errors);
      const saved=await updateProviderAssignment(user.id,respond[1],body.action,body.note??null);
      return saved?ok(saved):fail(409,'ASSIGNMENT_NOT_ACTIONABLE','This assignment is no longer awaiting a provider response.');
    }
    const progress=path.match(/^\/assignments\/([^/]+)\/progress$/);
    if(progress){
      if(method!=='PATCH')return methodNotAllowed(['PATCH']);
      if(!validId(progress[1]))return fail(400,'INVALID_ID','Assignment ID must be a valid UUID.');
      const profile=await getProviderProfile(user.id);
      if(!profile||profile.status!=='approved')return fail(403,'PROVIDER_NOT_APPROVED','Only approved providers can update job progress.');
      const body=await readJson(req);const errors=validateFields(body,['action','note']);
      if(!object(body)||!['start','complete'].includes(body.action))errors.push('action must be start or complete.');
      if(body.note!==undefined&&body.note!==null&&(typeof body.note!=='string'||body.note.length>1000))errors.push('note must not exceed 1,000 characters.');
      if(errors.length)return fail(422,'VALIDATION_ERROR','Assignment progress validation failed.',errors);
      const saved=await updateProviderAssignment(user.id,progress[1],body.action,body.note??null);
      return saved?ok(saved):fail(409,'ASSIGNMENT_NOT_ACTIONABLE','This assignment cannot move to the requested state.');
    }
    return fail(404,'NOT_FOUND','Provider route not found.');
  }catch(error){return handleError(error);}
}

function platformAdmin(user){
  const allowed=(process.env.PLATFORM_ADMIN_EMAILS||'').split(',').map(value=>value.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(String(user.email||'').toLowerCase());
}

async function adminProviderApi(req,url,user){
  if(!process.env.PLATFORM_ADMIN_EMAILS?.trim())return fail(503,'PLATFORM_ADMIN_NOT_CONFIGURED','Set PLATFORM_ADMIN_EMAILS before using provider review routes.');
  if(!platformAdmin(user))return fail(403,'PLATFORM_ADMIN_REQUIRED','This action is restricted to configured platform administrators.');
  const match=url.pathname.match(/^\/api\/v1\/admin\/providers\/([^/]+)\/review$/);
  if(!match)return fail(404,'NOT_FOUND','Admin provider route not found.');
  if(!validId(match[1]))return fail(400,'INVALID_ID','Provider user ID must be a valid UUID.');
  if(req.method!=='PATCH')return methodNotAllowed(['PATCH']);
  try{
    const body=await readJson(req);const errors=validateFields(body,['status','note']);
    if(!object(body)||!['approved','rejected','suspended'].includes(body.status))errors.push('status must be approved, rejected or suspended.');
    if(body.note!==undefined&&body.note!==null&&(typeof body.note!=='string'||body.note.length>1000))errors.push('note must not exceed 1,000 characters.');
    if(errors.length)return fail(422,'VALIDATION_ERROR','Provider review validation failed.',errors);
    if(body.status==='rejected'&&!body.note?.trim())return fail(422,'REVIEW_NOTE_REQUIRED','Provide a reason when rejecting a provider.');
    const saved=await reviewProviderProfile(match[1],user.id,body.status,body.note?.trim()||null);
    return saved?ok(saved):fail(409,'PROVIDER_NOT_AWAITING_REVIEW','Only profiles awaiting review can be reviewed.');
  }catch(error){return handleError(error);}
}

async function businessProviderApi(req,url,user,business){
  if(!['owner','admin','manager'].includes(business?.membership?.role))return fail(403,'INSUFFICIENT_ROLE','Only business owners, administrators and managers can manage provider assignments.');
  const path=url.pathname;
  try{
    if(path==='/api/v1/business/providers'){
      if(req.method!=='GET')return methodNotAllowed(['GET']);
      return ok(await listBusinessProviders(business.businessId));
    }
    const match=path.match(/^\/api\/v1\/business\/bookings\/([^/]+)\/assignments(?:\/([^/]+))?$/);
    if(!match)return fail(404,'NOT_FOUND','Business provider route not found.');
    const bookingId=match[1],assignmentId=match[2];
    if(!validId(bookingId)|| (assignmentId&&!validId(assignmentId)))return fail(400,'INVALID_ID','Booking and assignment IDs must be valid UUIDs.');
    if(!assignmentId&&req.method==='GET'){
      const list=await listBusinessProviderAssignments(business.businessId,bookingId);
      return ok(list);
    }
    if(!assignmentId&&req.method==='POST'){
      const body=await readJson(req);const errors=validateFields(body,['providerUserId']);
      if(!object(body)||!validId(body.providerUserId))errors.push('providerUserId must be a valid UUID.');
      if(errors.length)return fail(422,'VALIDATION_ERROR','Provider assignment validation failed.',errors);
      const assigned=await assignProviderToBooking(business.businessId,bookingId,body.providerUserId,user.id);
      return assigned.error?fail(409,'PROVIDER_NOT_ELIGIBLE',assigned.error):ok(assigned,201);
    }
    if(assignmentId&&req.method==='DELETE'){
      const body=await readJson(req);const errors=validateFields(body,['note']);
      if(!object(body))return fail(422,'VALIDATION_ERROR','Cancellation body must be an object.',errors);
      if(body.note!==undefined&&body.note!==null&&(typeof body.note!=='string'||body.note.length>1000))errors.push('note must not exceed 1,000 characters.');
      if(errors.length)return fail(422,'VALIDATION_ERROR','Assignment cancellation validation failed.',errors);
      const cancelled=await cancelBusinessAssignment(business.businessId,bookingId,assignmentId,user.id,body.note??null);
      return cancelled?ok(cancelled):fail(409,'ASSIGNMENT_NOT_CANCELLABLE','Only offered or accepted assignments can be cancelled.');
    }
    return methodNotAllowed(assignmentId?['DELETE']:['GET','POST']);
  }catch(error){return handleError(error);}
}

export async function handleProviderApi(req,url,user){
  if(!user)return fail(401,'UNAUTHENTICATED','A valid bearer session is required.');
  return providerApi(req,url,user);
}

export async function handleProviderAdminApi(req,url,user){
  if(!user)return fail(401,'UNAUTHENTICATED','A valid bearer session is required.');
  return adminProviderApi(req,url,user);
}

export async function handleProviderBusinessApi(req,url,user,business){
  if(!user)return fail(401,'UNAUTHENTICATED','A valid bearer session is required.');
  return businessProviderApi(req,url,user,business);
}
