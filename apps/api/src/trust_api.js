import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServiceReview, getReviewByBooking, listBusinessReviews,
  createBusinessReviewResponse, createServiceDispute,
  getCustomerDispute, getBusinessDispute, getServiceDispute,
  listCustomerDisputes, listBusinessDisputes, listDisputeMessages,
  addDisputeMessage, resolveServiceDispute
} from './trust_resources.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATEGORIES=new Set([
  'service_not_completed','quality_issue','late_arrival','pricing_issue',
  'provider_conduct','property_damage','other'
]);

function result(status,body,noContent=false){return {status,body,noContent};}
function ok(data,status=200){return result(status,{data});}
function fail(status,code,message,details=[]){return result(status,{error:{code,message,details}});}
function object(value){return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}
function validId(value){return typeof value==='string'&&UUID.test(value);}
function fields(body,allowed){
  if(!object(body))return ['Request body must be a JSON object.'];
  return Object.keys(body).filter(key=>!allowed.includes(key)).map(key=>'Unknown field: '+key+'.');
}
function method(methods){return fail(405,'METHOD_NOT_ALLOWED','HTTP method is not supported for this route.',['Allowed methods: '+methods.join(', ')+'.']);}
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
function adminAuthorized(req){
  const expected=process.env.SWIFTSERVE_ADMIN_API_KEY||'';
  const supplied=req.headers['x-swiftserve-admin-key'];
  if(!expected||typeof supplied!=='string')return false;
  const a=createHash('sha256').update(expected).digest();
  const b=createHash('sha256').update(supplied).digest();
  return a.length===b.length&&timingSafeEqual(a,b);
}
function businessManager(business){
  return Boolean(business?.businessId&&['owner','admin','manager'].includes(business?.membership?.role));
}
function validateReview(body){
  const errors=fields(body,['businessRating','providerRating','reviewText']);
  if(!object(body))return errors;
  if(!Number.isInteger(body.businessRating)||body.businessRating<1||body.businessRating>5)errors.push('businessRating must be an integer from 1 to 5.');
  if(body.providerRating!==undefined&&body.providerRating!==null&&(!Number.isInteger(body.providerRating)||body.providerRating<1||body.providerRating>5))errors.push('providerRating must be an integer from 1 to 5.');
  if(body.reviewText!==undefined&&body.reviewText!==null&&(typeof body.reviewText!=='string'||body.reviewText.length>2000))errors.push('reviewText must not exceed 2,000 characters.');
  return errors;
}
function validateDispute(body){
  const errors=fields(body,['category','description']);
  if(!object(body))return errors;
  if(!CATEGORIES.has(body.category))errors.push('category must be a supported service-dispute category.');
  if(typeof body.description!=='string'||body.description.trim().length<10||body.description.length>3000)errors.push('description must be 10 to 3,000 characters.');
  return errors;
}
function validateMessage(body,allowVisibility=false){
  const allowed=allowVisibility?['message','visibility']:['message'];
  const errors=fields(body,allowed);
  if(!object(body))return errors;
  if(typeof body.message!=='string'||body.message.trim().length<1||body.message.length>3000)errors.push('message must be 1 to 3,000 characters.');
  if(allowVisibility&&body.visibility!==undefined&&!['participants','admin_only'].includes(body.visibility))errors.push('visibility must be participants or admin_only.');
  return errors;
}

async function customerTrust(req,url,user){
  const base='/api/v1/customer';
  const path=url.pathname.slice(base.length)||'/';
  if(path==='/disputes'){
    if(req.method!=='GET')return method(['GET']);
    return ok(await listCustomerDisputes(user.id));
  }
  const review=path.match(/^\/bookings\/([^/]+)\/review$/);
  if(review){
    if(!validId(review[1]))return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
    if(req.method==='GET'){
      const item=await getReviewByBooking(user.id,review[1]);
      return item?ok(item):fail(404,'REVIEW_NOT_FOUND','Review not found.');
    }
    if(req.method==='POST'){
      const body=await readJson(req);const errors=validateReview(body);
      if(errors.length)return fail(422,'VALIDATION_ERROR','Review validation failed.',errors);
      const saved=await createServiceReview(user.id,review[1],{
        businessRating:body.businessRating,
        providerRating:body.providerRating??null,
        reviewText:body.reviewText?.trim()||null
      });
      return saved.error
        ?fail(saved.error.includes('completed')?409:404,'REVIEW_NOT_AVAILABLE',saved.error)
        :ok(saved.review,201);
    }
    return method(['GET','POST']);
  }
  const openDispute=path.match(/^\/bookings\/([^/]+)\/disputes$/);
  if(openDispute){
    if(!validId(openDispute[1]))return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
    if(req.method!=='POST')return method(['POST']);
    const body=await readJson(req);const errors=validateDispute(body);
    if(errors.length)return fail(422,'VALIDATION_ERROR','Dispute validation failed.',errors);
    const created=await createServiceDispute(user.id,openDispute[1],{
      category:body.category,description:body.description.trim()
    });
    if(created.error){
      const duplicate=created.error.includes('already exists');
      return fail(duplicate?409:404,duplicate?'DISPUTE_ALREADY_EXISTS':'DISPUTE_NOT_AVAILABLE',created.error);
    }
    return ok(created.dispute,201);
  }
  const dispute=path.match(/^\/disputes\/([^/]+)$/);
  if(dispute){
    if(!validId(dispute[1]))return fail(400,'INVALID_ID','Dispute ID must be a valid UUID.');
    if(req.method==='GET'){
      const item=await getCustomerDispute(user.id,dispute[1]);
      if(!item)return fail(404,'DISPUTE_NOT_FOUND','Dispute not found.');
      return ok({...item,messages:await listDisputeMessages(dispute[1],false)});
    }
    return method(['GET']);
  }
  const messages=path.match(/^\/disputes\/([^/]+)\/messages$/);
  if(messages){
    if(!validId(messages[1]))return fail(400,'INVALID_ID','Dispute ID must be a valid UUID.');
    if(req.method!=='POST')return method(['POST']);
    const dispute=await getCustomerDispute(user.id,messages[1]);
    if(!dispute)return fail(404,'DISPUTE_NOT_FOUND','Dispute not found.');
    const body=await readJson(req);const errors=validateMessage(body);
    if(errors.length)return fail(422,'VALIDATION_ERROR','Dispute message validation failed.',errors);
    const saved=await addDisputeMessage(user.id,messages[1],body.message.trim(),'participants','awaiting_business');
    return saved?.error?fail(409,'DISPUTE_CLOSED',saved.error):saved?ok(saved,201):fail(404,'DISPUTE_NOT_FOUND','Dispute not found.');
  }
  return fail(404,'NOT_FOUND','Customer trust route not found.');
}

async function businessTrust(req,url,user,business){
  if(!businessManager(business))return fail(403,'INSUFFICIENT_ROLE','Only business owners, admins and managers can access these trust routes.');
  const base='/api/v1/business';
  const path=url.pathname.slice(base.length)||'/';
  if(path==='/reviews'){
    if(req.method!=='GET')return method(['GET']);
    return ok(await listBusinessReviews(business.businessId));
  }
  const reviewResponse=path.match(/^\/reviews\/([^/]+)\/response$/);
  if(reviewResponse){
    if(!validId(reviewResponse[1]))return fail(400,'INVALID_ID','Review ID must be a valid UUID.');
    if(req.method!=='POST')return method(['POST']);
    const body=await readJson(req);const errors=fields(body,['responseText']);
    if(!object(body)||typeof body.responseText!=='string'||body.responseText.trim().length<1||body.responseText.length>1500)errors.push('responseText must be 1 to 1,500 characters.');
    if(errors.length)return fail(422,'VALIDATION_ERROR','Review response validation failed.',errors);
    const saved=await createBusinessReviewResponse(user.id,business.businessId,reviewResponse[1],body.responseText.trim());
    return saved?ok(saved,201):fail(404,'REVIEW_NOT_FOUND','Published business review not found.');
  }
  if(path==='/disputes'){
    if(req.method!=='GET')return method(['GET']);
    return ok(await listBusinessDisputes(business.businessId));
  }
  const dispute=path.match(/^\/disputes\/([^/]+)$/);
  if(dispute){
    if(!validId(dispute[1]))return fail(400,'INVALID_ID','Dispute ID must be a valid UUID.');
    if(req.method!=='GET')return method(['GET']);
    const item=await getBusinessDispute(business.businessId,dispute[1]);
    if(!item)return fail(404,'DISPUTE_NOT_FOUND','Dispute not found.');
    return ok({...item,messages:await listDisputeMessages(dispute[1],false)});
  }
  const messages=path.match(/^\/disputes\/([^/]+)\/messages$/);
  if(messages){
    if(!validId(messages[1]))return fail(400,'INVALID_ID','Dispute ID must be a valid UUID.');
    if(req.method!=='POST')return method(['POST']);
    const item=await getBusinessDispute(business.businessId,messages[1]);
    if(!item)return fail(404,'DISPUTE_NOT_FOUND','Dispute not found.');
    const body=await readJson(req);const errors=validateMessage(body);
    if(errors.length)return fail(422,'VALIDATION_ERROR','Dispute message validation failed.',errors);
    const saved=await addDisputeMessage(user.id,messages[1],body.message.trim(),'participants','awaiting_customer');
    return saved?.error?fail(409,'DISPUTE_CLOSED',saved.error):saved?ok(saved,201):fail(404,'DISPUTE_NOT_FOUND','Dispute not found.');
  }
  return fail(404,'NOT_FOUND','Business trust route not found.');
}

async function adminTrust(req,url){
  if(!adminAuthorized(req))return fail(401,'ADMIN_UNAUTHORIZED','A valid platform admin API key is required.');
  if(url.pathname==='/api/v1/admin/disputes'){
    if(req.method!=='GET')return method(['GET']);
    const result=await queryDatabase(
      'SELECT d.*,u.full_name AS opened_by_name FROM service_disputes d JOIN users u ON u.id=d.opened_by_user_id ORDER BY d.created_at DESC LIMIT 200'
    );
    if(result)return ok(result.rows.map(row=>({
      id:row.id,businessId:row.business_id,bookingId:row.booking_id,
      openedByUserId:row.opened_by_user_id,openedByName:row.opened_by_name,
      disputeCategory:row.dispute_category,description:row.description,status:row.status,
      resolutionNote:row.resolution_note,createdAt:new Date(row.created_at).toISOString()
    })));
    return ok([]);
  }
  const dispute=url.pathname.match(/^\/api\/v1\/admin\/disputes\/([^/]+)$/);
  if(dispute){
    if(!validId(dispute[1]))return fail(400,'INVALID_ID','Dispute ID must be a valid UUID.');
    if(req.method==='GET'){
      const item=await getServiceDispute(dispute[1]);
      if(!item)return fail(404,'DISPUTE_NOT_FOUND','Dispute not found.');
      return ok({...item,messages:await listDisputeMessages(dispute[1],true)});
    }
    if(req.method==='PATCH'){
      const body=await readJson(req);const errors=fields(body,['status','resolutionNote']);
      if(!object(body)||!['under_review','resolved_customer','resolved_business','closed'].includes(body.status))errors.push('status must be under_review, resolved_customer, resolved_business or closed.');
      if(body.resolutionNote!==undefined&&body.resolutionNote!==null&&(typeof body.resolutionNote!=='string'||body.resolutionNote.length>2000))errors.push('resolutionNote must not exceed 2,000 characters.');
      if(errors.length)return fail(422,'VALIDATION_ERROR','Dispute resolution validation failed.',errors);
      const updated=await resolveServiceDispute(dispute[1],body.status,body.resolutionNote??null);
      return updated?.error?fail(409,'DISPUTE_CLOSED',updated.error):updated?ok(updated):fail(404,'DISPUTE_NOT_FOUND','Dispute not found.');
    }
    return method(['GET','PATCH']);
  }
  const messages=url.pathname.match(/^\/api\/v1\/admin\/disputes\/([^/]+)\/messages$/);
  if(messages){
    if(!validId(messages[1]))return fail(400,'INVALID_ID','Dispute ID must be a valid UUID.');
    if(req.method!=='POST')return method(['POST']);
    const item=await getServiceDispute(messages[1]);
    if(!item)return fail(404,'DISPUTE_NOT_FOUND','Dispute not found.');
    const body=await readJson(req);const errors=validateMessage(body,true);
    if(errors.length)return fail(422,'VALIDATION_ERROR','Admin dispute message validation failed.',errors);
    const saved=await addDisputeMessage(
      item.openedByUserId,messages[1],body.message.trim(),body.visibility??'admin_only'
    );
    return saved?.error?fail(409,'DISPUTE_CLOSED',saved.error):saved?ok(saved,201):fail(404,'DISPUTE_NOT_FOUND','Dispute not found.');
  }
  return fail(404,'NOT_FOUND','Admin trust route not found.');
}

export async function handleTrustApi(req,url,user=null,business=null){
  try{
    if(url.pathname.startsWith('/api/v1/admin/disputes'))return await adminTrust(req,url);
    if(url.pathname.startsWith('/api/v1/customer/')){
      if(!user)return fail(401,'UNAUTHENTICATED','A valid bearer access token is required.');
      if(user.accountType!=='customer')return fail(403,'CUSTOMER_ACCOUNT_REQUIRED','This route requires a customer account.');
      return await customerTrust(req,url,user);
    }
    if(url.pathname.startsWith('/api/v1/business/reviews')||url.pathname.startsWith('/api/v1/business/disputes')){
      if(!user)return fail(401,'UNAUTHENTICATED','A valid bearer access token is required.');
      if(!business?.businessId||!business?.membership)return fail(400,'BUSINESS_CONTEXT_REQUIRED','A valid business context is required.');
      return await businessTrust(req,url,user,business);
    }
    return fail(404,'NOT_FOUND','Trust route not found.');
  }catch(error){
    if(error?.code==='INVALID_JSON')return fail(400,'INVALID_JSON',error.message);
    if(error?.code==='UNSUPPORTED_MEDIA_TYPE')return fail(415,'UNSUPPORTED_MEDIA_TYPE',error.message);
    if(error?.code==='BODY_TOO_LARGE')return fail(413,'BODY_TOO_LARGE',error.message);
    if(error?.code==='23505')return fail(409,'DUPLICATE_RESOURCE','A review or dispute already exists for this booking.');
    if(error?.code==='23503')return fail(422,'INVALID_REFERENCE','The referenced review, booking or participant is not available.');
    console.error(JSON.stringify({event:'trust_api_failed',code:typeof error?.code==='string'?error.code:'NO_CODE',name:typeof error?.name==='string'?error.name:'UNKNOWN_ERROR'}));
    return fail(500,'INTERNAL_ERROR','An unexpected trust API error occurred.');
  }
}
