import {
  createPaymentIntentForBooking,
  getCustomerPaymentIntent,
  listCustomerBookingPayments,
  listPaymentIntentsForBusiness,
  handlePaymentWebhook
} from './payments_resources.js';
import { getCustomerBooking, getBusinessBooking } from './marketplace_resources.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{3}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function result(status,body,noContent=false){return {status,body,noContent};}
function ok(data,status=200){return result(status,{data});}
function fail(status,code,message,details=[]){return result(status,{error:{code,message,details}});}
function method(methods){return fail(405,'METHOD_NOT_ALLOWED','HTTP method is not supported for this route.',['Allowed methods: '+methods.join(', ')+'.']);}
function validId(value){return typeof value==='string'&&UUID.test(value);}
async function rawBody(req,limit=1024*1024){
  const chunks=[];let size=0;
  for await(const chunk of req){
    size+=chunk.length;
    if(size>limit){const error=new Error('Webhook body is too large.');error.code='BODY_TOO_LARGE';throw error;}
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req){
  const type=req.headers['content-type']||'';
  if(!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(type)){
    const error=new Error('Content-Type must be application/json.');error.code='UNSUPPORTED_MEDIA_TYPE';throw error;
  }
  const raw=await rawBody(req);
  try{return raw.length?JSON.parse(raw.toString('utf8')):{};}
  catch{const error=new Error('Malformed JSON body.');error.code='INVALID_JSON';throw error;}
}

export async function handlePaymentApi(req,url,user=null,business=null){
  try{
    const webhook=url.pathname.match(/^\/api\/v1\/webhooks\/payments\/([^/]+)$/);
    if(webhook){
      if(req.method!=='POST')return method(['POST']);
      const raw=await rawBody(req);
      const handled=await handlePaymentWebhook(webhook[1],raw,req.headers);
      return result(handled.status,handled.body);
    }

    if(url.pathname.startsWith('/api/v1/customer/')){
      if(!user)return fail(401,'UNAUTHENTICATED','A valid bearer access token is required.');
      if(user.accountType!=='customer')return fail(403,'CUSTOMER_ACCOUNT_REQUIRED','This route requires a customer account.');

      const bookingPayments=url.pathname.match(/^\/api\/v1\/customer\/bookings\/([^/]+)\/payment-intents$/);
      if(bookingPayments){
        if(!validId(bookingPayments[1]))return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
        if(req.method==='GET'){
          const payments=await listCustomerBookingPayments(user.id,bookingPayments[1]);
          return payments===null?fail(404,'BOOKING_NOT_FOUND','Booking not found.'):ok(payments);
        }
        if(req.method==='POST'){
          const booking=await getCustomerBooking(user.id,bookingPayments[1]);
          if(!booking)return fail(404,'BOOKING_NOT_FOUND','Booking not found.');
          const key=req.headers['idempotency-key'];
          if(typeof key!=='string')return fail(400,'IDEMPOTENCY_KEY_REQUIRED','Provide an Idempotency-Key header.');
          const created=await createPaymentIntentForBooking({user,booking,idempotencyKey:key});
          if(created.error){
            const disabled=created.error.includes('disabled')||created.error.includes('configured');
            return fail(disabled?503:422,disabled?'PAYMENTS_DISABLED':'PAYMENT_NOT_AVAILABLE',created.error);
          }
          if(created.conflict)return fail(409,'PAYMENT_ALREADY_PENDING','A payment attempt is already active for this booking.',[created.intent]);
          return ok(created.intent,created.reused?200:201);
        }
        return method(['GET','POST']);
      }

      const intentPath=url.pathname.match(/^\/api\/v1\/customer\/payment-intents\/([^/]+)$/);
      if(intentPath){
        if(!validId(intentPath[1]))return fail(400,'INVALID_ID','Payment intent ID must be a valid UUID.');
        if(req.method!=='GET')return method(['GET']);
        const intent=await getCustomerPaymentIntent(user.id,intentPath[1]);
        return intent?ok(intent):fail(404,'PAYMENT_INTENT_NOT_FOUND','Payment intent not found.');
      }
      return fail(404,'NOT_FOUND','Customer payment route not found.');
    }

    const businessPayment=url.pathname.match(/^\/api\/v1\/business\/bookings\/([^/]+)\/payments$/);
    if(businessPayment){
      if(!user)return fail(401,'UNAUTHENTICATED','A valid bearer access token is required.');
      if(!business?.businessId||!business?.membership)return fail(403,'BUSINESS_CONTEXT_REQUIRED','A valid business context is required.');
      if(!['owner','admin','manager'].includes(business.membership.role))return fail(403,'INSUFFICIENT_ROLE','Your business role cannot view payment records.');
      if(!validId(businessPayment[1]))return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
      if(req.method!=='GET')return method(['GET']);
      const booking=await getBusinessBooking(business.businessId,businessPayment[1]);
      if(!booking)return fail(404,'BOOKING_NOT_FOUND','Booking not found.');
      return ok(await listPaymentIntentsForBusiness(business.businessId,businessPayment[1]));
    }

    return fail(404,'NOT_FOUND','Payment route not found.');
  }catch(error){
    if(error?.code==='INVALID_JSON')return fail(400,'INVALID_JSON',error.message);
    if(error?.code==='UNSUPPORTED_MEDIA_TYPE')return fail(415,'UNSUPPORTED_MEDIA_TYPE',error.message);
    if(error?.code==='BODY_TOO_LARGE')return fail(413,'BODY_TOO_LARGE',error.message);
    if(error?.code==='23503')return fail(422,'INVALID_REFERENCE','The referenced booking or recipient is not available.');
    if(error?.code==='23505')return fail(409,'DUPLICATE_RESOURCE','A conflicting payment record already exists.');
    console.error(JSON.stringify({event:'payment_api_request_failed',code:typeof error?.code==='string'?error.code:'NO_CODE',name:typeof error?.name==='string'?error.name:'UNKNOWN_ERROR'}));
    return fail(500,'INTERNAL_ERROR','An unexpected payment API error occurred.');
  }
}
