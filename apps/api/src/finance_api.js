import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createPaymentIntentRecord, updatePaymentAuthorization, failPaymentInitialization,
  getCustomerPayment, getPaymentByReference, listCustomerPayments, markPaymentSucceeded,
  markPaymentFailed, createRefundRecord, updateRefundStatus, listBookingRefunds,
  createProviderPayoutAccount, getProviderPayoutAccount, listProviderPayouts,
  createOrRefreshPayoutForCompletedAssignment, listAdminPayouts,
  getPayoutForProcessing, updatePayoutTransfer, updatePayoutByTransferReference,
  createBookingReview, listBusinessReviews, listProviderReviews,
  createDispute, getCustomerDispute, getCustomerDisputeById, getBusinessDispute, addDisputeMessage,
  listDisputeMessages, listAdminDisputes, listBusinessDisputes, resolveDispute,
  getBookingFinancialSummary, recordProviderWebhookEvent, deleteProviderWebhookEvent
} from './finance_resources.js';
import { getCustomerBooking, getBusinessBooking } from './marketplace_resources.js';
import { getCompletedAssignmentForBooking } from './provider_assignments.js';
import {
  writeAdminAuditEvent,getFinanceOperationsSummary,listAdminAuditEvents,
  createFinanceReconciliationRun,listFinanceReconciliationCandidates,
  recordFinanceReconciliationItem,finishFinanceReconciliationRun,
  listFinanceReconciliationRuns,getFinanceReconciliationRun,markPayoutReconciled
} from './admin_resources.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PAYSTACK_CURRENCIES={
  NGN:{countries:['NG'],minimum:5000},
  USD:{countries:['NG','KE'],minimum:200},
  GHS:{countries:['GH'],minimum:10},
  ZAR:{countries:['ZA'],minimum:100},
  KES:{countries:['KE'],minimum:300},
  XOF:{countries:['CI'],minimum:100}
};

function response(status,body,noContent=false){return {status,body,noContent};}
function ok(data,status=200){return response(status,{data});}
function fail(status,code,message,details=[]){return response(status,{error:{code,message,details}});}
function isObject(value){return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}
function validId(value){return typeof value==='string'&&UUID.test(value);}
function fields(body,allowed){
  if(!isObject(body))return ['Request body must be a JSON object.'];
  return Object.keys(body).filter(key=>!allowed.includes(key)).map(key=>'Unknown field: '+key+'.');
}
function method(methods){return fail(405,'METHOD_NOT_ALLOWED','HTTP method is not supported for this route.',['Allowed methods: '+methods.join(', ')+'.']);}
function isAdmin(req){
  const expected=process.env.SWIFTSERVE_ADMIN_API_KEY||'';
  const supplied=req.headers['x-swiftserve-admin-key'];
  if(!expected||typeof supplied!=='string')return false;
  const a=createHash('sha256').update(expected).digest();
  const b=createHash('sha256').update(supplied).digest();
  return timingSafeEqual(a,b);
}
async function readJson(req){
  const type=req.headers['content-type']||'';
  if(!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(type)){
    const error=new Error('Content-Type must be application/json.');error.code='UNSUPPORTED_MEDIA_TYPE';throw error;
  }
  const chunks=[];let length=0;
  for await(const chunk of req){
    length+=chunk.length;
    if(length>1024*1024){const error=new Error('Request body exceeds 1 MB.');error.code='BODY_TOO_LARGE';throw error;}
    chunks.push(chunk);
  }
  const raw=Buffer.concat(chunks).toString('utf8');
  if(!raw.trim())return {};
  try{return JSON.parse(raw);}catch{const error=new Error('Malformed JSON body.');error.code='INVALID_JSON';throw error;}
}
function paystackBaseUrl(){
  const raw=process.env.PAYSTACK_API_BASE_URL||'https://api.paystack.co';
  const parsed=new URL(raw);
  const localTest=process.env.NODE_ENV==='integration'&&
    ['127.0.0.1','localhost','::1'].includes(parsed.hostname);
  if(parsed.protocol!=='https:'&&!localTest)throw new Error('PAYSTACK_API_BASE_URL must use HTTPS.');
  if(parsed.protocol==='https:'&&parsed.hostname!=='api.paystack.co')throw new Error('Only the official Paystack API host is supported.');
  return raw.replace(/\/+$/,'');
}
async function paystackRequest(path,body=null,methodName='POST'){
  const secret=process.env.PAYSTACK_SECRET_KEY;
  if(!secret)return {configured:false};
  let result;
  try{
    result=await fetch(paystackBaseUrl()+path,{
      method:methodName,
      headers:{
        Authorization:'Bearer '+secret,
        'Content-Type':'application/json',
        Accept:'application/json'
      },
      ...(body===null?{}:{body:JSON.stringify(body)}),
      signal:AbortSignal.timeout(15000)
    });
  }catch(error){
    return {configured:true,ok:false,networkError:true,message:error?.name==='TimeoutError'?'Payment provider request timed out.':'Payment provider could not be reached.'};
  }
  let payload;
  try{payload=await result.json();}catch{return {configured:true,ok:false,message:'Payment provider returned an unreadable response.'};}
  if(!result.ok||payload?.status!==true){
    return {configured:true,ok:false,message:typeof payload?.message==='string'?payload.message.slice(0,300):'Payment provider rejected the request.'};
  }
  return {configured:true,ok:true,data:payload.data};
}
function paystackCurrencyAllowed(currencyCode,countryCode,amountMinor){
  const rule=PAYSTACK_CURRENCIES[currencyCode];
  return Boolean(rule&&rule.countries.includes(String(countryCode||'').toUpperCase())&&
    Number.isSafeInteger(amountMinor)&&amountMinor>=rule.minimum);
}
function parsePaystackAmount(value){
  const n=Number(value);
  return Number.isSafeInteger(n)&&n>0?n:null;
}
function validateDispute(body){
  const errors=fields(body,['category','description','requestedResolution']);
  if(!isObject(body))return errors;
  if(!['service_quality','incomplete_work','no_show','damage','safety','payment','other'].includes(body.category))errors.push('category is not supported.');
  if(typeof body.description!=='string'||body.description.trim().length<10||body.description.length>3000)errors.push('description must be 10–3,000 characters.');
  if(!['refund_full','refund_partial','rework','review','other'].includes(body.requestedResolution))errors.push('requestedResolution is not supported.');
  return errors;
}
function verifyPaystackSignature(rawBody,headers){
  const modern=headers['paystack-signature'];
  const legacy=headers['x-paystack-signature'];
  const secrets=(process.env.PAYSTACK_WEBHOOK_SECRETS||process.env.PAYSTACK_WEBHOOK_SECRET||'')
    .split(',').map(item=>item.trim()).filter(Boolean);
  if(typeof modern==='string'&&secrets.length){
    let timestamp=null;const signatures=[];
    for(const part of modern.split(',')){
      const i=part.indexOf('=');
      if(i<0)continue;
      const key=part.slice(0,i).trim();
      const value=part.slice(i+1).trim();
      if(key==='t'){
        if(timestamp!==null||!/^\d+$/.test(value))return false;
        timestamp=Number(value);
      }else if(key==='v1'){
        const sep=value.indexOf(':');
        if(sep>0)signatures.push(value.slice(sep+1));
      }
    }
    if(timestamp===null||Math.abs(Math.floor(Date.now()/1000)-timestamp)>300||!signatures.length)return false;
    for(const secret of secrets){
      const expected=createHmac('sha512',secret).update(String(timestamp)+'.').update(rawBody).digest();
      for(const signature of signatures){
        if(!/^[0-9a-f]{128}$/i.test(signature))continue;
        const supplied=Buffer.from(signature,'hex');
        if(supplied.length===expected.length&&timingSafeEqual(expected,supplied))return true;
      }
    }
    return false;
  }
  const secret=process.env.PAYSTACK_SECRET_KEY;
  if(typeof legacy==='string'&&secret&&/^[0-9a-f]{128}$/i.test(legacy)){
    const expected=createHmac('sha512',secret).update(rawBody).digest();
    const supplied=Buffer.from(legacy,'hex');
    return supplied.length===expected.length&&timingSafeEqual(expected,supplied);
  }
  return false;
}

async function startCustomerPayment(req,url,user){
  const match=url.pathname.match(/^\/api\/v1\/customer\/bookings\/([^/]+)\/payments$/);
  if(!match||!validId(match[1]))return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
  if(req.method==='GET'){
    const booking=await getCustomerBooking(user.id,match[1]);
    if(!booking)return fail(404,'BOOKING_NOT_FOUND','Booking not found.');
    return ok(await listCustomerPayments(user.id,booking.id));
  }
  if(req.method!=='POST')return method(['GET','POST']);
  if(!process.env.PAYSTACK_SECRET_KEY)return fail(503,'PAYMENT_GATEWAY_NOT_CONFIGURED','Online payments are not enabled. Configure PAYSTACK_SECRET_KEY on the server first.');
  const idempotencyKey=req.headers['idempotency-key'];
  if(typeof idempotencyKey!=='string'||idempotencyKey.trim().length<8||idempotencyKey.length>120)
    return fail(400,'IDEMPOTENCY_KEY_REQUIRED','Provide an Idempotency-Key header containing 8–120 characters.');
  const booking=await getCustomerBooking(user.id,match[1]);
  if(!booking)return fail(404,'BOOKING_NOT_FOUND','Booking not found.');
  if(booking.status!=='confirmed')return fail(409,'BOOKING_NOT_PAYABLE','Only a confirmed booking can be paid.');
  const amount=parsePaystackAmount(booking.servicePriceMinor);
  const currency=String(booking.currencyCode||'').toUpperCase();
  const country=String(booking.serviceAddress?.countryCode||'').toUpperCase();
  if(!amount||!paystackCurrencyAllowed(currency,country,amount))
    return fail(422,'UNSUPPORTED_PAYMENT_CURRENCY','This amount, currency or service country is not currently supported by the configured Paystack integration.');
  const id=randomUUID();
  const reference='SS'+id.replaceAll('-','').toUpperCase();
  const created=await createPaymentIntentRecord({
    id,businessId:booking.businessId,bookingId:booking.id,customerUserId:user.id,
    reference,idempotencyKey:idempotencyKey.trim(),amountMinor:amount,currencyCode:currency
  });
  if(created.conflict)return fail(409,'PAYMENT_ALREADY_STARTED','A payment attempt already exists for this booking.');
  if(created.existing)return ok(created.payment,200);
  const gateway=await paystackRequest('/transaction/initialize',{
    amount:String(amount),
    email:user.email,
    currency,
    reference,
    ...(process.env.PAYSTACK_CALLBACK_URL?{callback_url:process.env.PAYSTACK_CALLBACK_URL}:{}),
    metadata:JSON.stringify({bookingId:booking.id,paymentIntentId:id})
  });
  if(!gateway.ok){
    await failPaymentInitialization(id,gateway.message||'Payment initialization failed.');
    return fail(gateway.networkError?503:502,'PAYMENT_INITIALIZATION_FAILED',gateway.message||'Payment provider could not initialize checkout.');
  }
  if(!gateway.data?.authorization_url||gateway.data.reference!==reference){
    await failPaymentInitialization(id,'Payment provider returned an invalid checkout response.');
    return fail(502,'PAYMENT_INITIALIZATION_FAILED','Payment provider returned an invalid checkout response.');
  }
  const updated=await updatePaymentAuthorization(id,gateway.data.authorization_url);
  return ok(updated,201);
}

async function verifyCustomerPayment(req,url,user){
  const match=url.pathname.match(/^\/api\/v1\/customer\/payments\/([^/]+)\/verify$/);
  if(!match||!validId(match[1]))return fail(400,'INVALID_ID','Payment ID must be a valid UUID.');
  if(req.method!=='POST')return method(['POST']);
  const payment=await getCustomerPayment(user.id,match[1]);
  if(!payment)return fail(404,'PAYMENT_NOT_FOUND','Payment not found.');
  if(payment.status==='succeeded'||payment.status==='partially_refunded'||payment.status==='refunded')return ok(payment);
  if(payment.status!=='pending')return fail(409,'PAYMENT_NOT_PENDING','This payment is not pending verification.');
  const gateway=await paystackRequest('/transaction/verify/'+encodeURIComponent(payment.reference),null,'GET');
  if(!gateway.ok)return fail(gateway.networkError?503:502,'PAYMENT_VERIFICATION_FAILED',gateway.message||'Payment verification failed.');
  const data=gateway.data||{};
  if(data.status==='success'){
    const eventKey=createHash('sha256').update('verify|'+payment.reference+'|'+String(data.id||'')).digest('hex');
    const payloadHash=createHash('sha256').update(JSON.stringify(data)).digest('hex');
    const verified=await markPaymentSucceeded(payment.reference,data,eventKey,'transaction.verify',payloadHash);
    if(verified.missing)return fail(404,'PAYMENT_NOT_FOUND','Payment not found.');
    if(verified.mismatch)return fail(409,'PAYMENT_MISMATCH','The gateway amount, currency or reference does not match the booking.');
    const assignment=await getCompletedAssignmentForBooking(payment.bookingId);
    if(assignment)await createOrRefreshPayoutForCompletedAssignment(payment.bookingId,assignment);
    return ok(verified.payment);
  }
  const gatewayStatus=String(data.status||'').toLowerCase();
  if(!['failed','abandoned'].includes(gatewayStatus))return ok(payment,202);
  const eventKey=createHash('sha256').update('verify|'+payment.reference+'|'+gatewayStatus).digest('hex');
  const payloadHash=createHash('sha256').update(JSON.stringify(data)).digest('hex');
  const failed=await markPaymentFailed(payment.reference,data.gateway_response||gatewayStatus||'Payment was not successful.',eventKey,'transaction.verify',payloadHash);
  return fail(409,'PAYMENT_NOT_SUCCESSFUL',data.gateway_response||'The payment was not successful.',failed);
}

async function startBusinessRefund(req,url,user,business){
  const denied=!business?.businessId||!business?.membership
    ?fail(400,'BUSINESS_CONTEXT_REQUIRED','A valid business context is required.')
    :!['owner','admin','manager'].includes(business.membership.role)
      ?fail(403,'INSUFFICIENT_ROLE','Only owners, admins and managers can request refunds.')
      :null;
  if(denied)return denied;
  const match=url.pathname.match(/^\/api\/v1\/business\/bookings\/([^/]+)\/refunds$/);
  if(!match||!validId(match[1]))return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
  if(req.method==='GET')return ok(await listBookingRefunds(business.businessId,match[1]));
  if(req.method!=='POST')return method(['GET','POST']);
  if(!process.env.PAYSTACK_SECRET_KEY)return fail(503,'PAYMENT_GATEWAY_NOT_CONFIGURED','Refund processing is not enabled. Configure PAYSTACK_SECRET_KEY on the server first.');
  const body=await readJson(req);const errors=fields(body,['amountMinor','customerNote','merchantNote']);
  if(!isObject(body))return fail(422,'VALIDATION_ERROR','Refund request validation failed.',errors);
  if(body.amountMinor!==undefined&&(!Number.isSafeInteger(body.amountMinor)||body.amountMinor<=0))errors.push('amountMinor must be a positive integer in the currency subunit.');
  if(body.customerNote!==undefined&&body.customerNote!==null&&(typeof body.customerNote!=='string'||body.customerNote.length>1000))errors.push('customerNote must not exceed 1,000 characters.');
  if(body.merchantNote!==undefined&&body.merchantNote!==null&&(typeof body.merchantNote!=='string'||body.merchantNote.length>1000))errors.push('merchantNote must not exceed 1,000 characters.');
  if(errors.length)return fail(422,'VALIDATION_ERROR','Refund request validation failed.',errors);
  const booking=await getBusinessBooking(business.businessId,match[1]);
  if(!booking)return fail(404,'BOOKING_NOT_FOUND','Booking not found.');
  const payments=await getBookingFinancialSummary(business.businessId,booking.id);
  const payment=payments.find(item=>['succeeded','partially_refunded'].includes(item.status));
  if(!payment)return fail(409,'PAYMENT_NOT_REFUNDABLE','No refundable payment exists for this booking.');
  const id=randomUUID();
  const reference='SSRF'+id.replaceAll('-','').toUpperCase();
  const created=await createRefundRecord({
    id,reference,businessId:business.businessId,bookingId:booking.id,
    paymentIntentId:payment.id,requestedByUserId:user.id,
    amountMinor:body.amountMinor,customerNote:body.customerNote??null,
    merchantNote:body.merchantNote??null
  });
  if(created.error)return fail(409,'REFUND_NOT_AVAILABLE',created.error);
  const completedAssignment=await getCompletedAssignmentForBooking(booking.id);
  if(completedAssignment)await createOrRefreshPayoutForCompletedAssignment(booking.id,completedAssignment);
  const gateway=await paystackRequest('/refund',{
    transaction:created.payment.reference,
    amount:created.refund.amountMinor,
    currency:created.refund.currencyCode,
    reference,
    customer_note:created.refund.customerNote||'SwiftServe booking refund',
    merchant_note:created.refund.merchantNote||'SwiftServe refund request'
  });
  if(!gateway.ok){
    if(gateway.networkError){
      return fail(503,'REFUND_STATUS_UNCERTAIN','The refund request timed out or the payment provider could not be reached. The refund remains pending and is reserved against the refundable balance. Do not submit another refund until its status is reconciled.');
    }
    await updateRefundStatus(reference,'failed',null,gateway.message||'Gateway refund request failed.');
    return fail(502,'REFUND_INITIALIZATION_FAILED',gateway.message||'The refund request was rejected by the payment provider.');
  }
  const status=['pending','processing','processed','failed'].includes(gateway.data?.status)?gateway.data.status:'pending';
  const updated=await updateRefundStatus(reference,status,gateway.data?.id?String(gateway.data.id):null,null);
  return ok(updated,201);
}

async function handleProviderPayoutAccount(req,url,user){
  if(user?.accountType!=='provider')return fail(403,'PROVIDER_ACCOUNT_REQUIRED','This endpoint requires a provider account.');
  if(url.pathname==='/api/v1/provider/payouts'){
    if(req.method!=='GET')return method(['GET']);
    return ok(await listProviderPayouts(user.id));
  }
  if(url.pathname==='/api/v1/provider/reviews'){
    if(req.method!=='GET')return method(['GET']);
    return ok(await listProviderReviews(user.id));
  }
  if(url.pathname==='/api/v1/provider/payout-account'){
    if(req.method==='GET')return ok(await getProviderPayoutAccount(user.id));
    if(req.method!=='POST'&&req.method!=='PUT')return method(['GET','POST','PUT']);
    if(!process.env.PAYSTACK_SECRET_KEY)return fail(503,'PAYOUT_GATEWAY_NOT_CONFIGURED','Provider payout setup is not enabled. Configure PAYSTACK_SECRET_KEY on the server.');
    const body=await readJson(req);const errors=fields(body,['accountName','accountNumber','bankCode','currencyCode']);
    if(!isObject(body))return fail(422,'VALIDATION_ERROR','Payout account validation failed.',errors);
    if(typeof body.accountName!=='string'||body.accountName.trim().length<2||body.accountName.trim().length>140)errors.push('accountName must be 2–140 characters.');
    if(typeof body.accountNumber!=='string'||!/^\d{10}$/.test(body.accountNumber))errors.push('accountNumber must contain exactly 10 digits.');
    if(typeof body.bankCode!=='string'||!/^\d{2,10}$/.test(body.bankCode))errors.push('bankCode must contain 2–10 digits.');
    if(body.currencyCode!=='NGN')errors.push('The current Paystack bank payout integration supports Nigerian Naira (NGN) NUBAN accounts only.');
    if(errors.length)return fail(422,'VALIDATION_ERROR','Payout account validation failed.',errors);
    const created=await paystackRequest('/transferrecipient',{
      type:'nuban',name:body.accountName.trim(),account_number:body.accountNumber,
      bank_code:body.bankCode,currency:'NGN'
    });
    if(!created.ok)return fail(created.networkError?503:502,'PAYOUT_RECIPIENT_FAILED',created.message||'The payout account could not be registered.');
    if(!created.data?.recipient_code)return fail(502,'PAYOUT_RECIPIENT_FAILED','The payment provider did not return a recipient code.');
    const safe=await createProviderPayoutAccount({
      providerUserId:user.id,recipientCode:created.data.recipient_code,
      currencyCode:'NGN',accountName:created.data.name||body.accountName.trim(),
      bankCode:body.bankCode,bankName:created.data.details?.bank_name||null,
      lastFour:body.accountNumber.slice(-4)
    });
    return ok(safe,201);
  }
  return fail(404,'NOT_FOUND','Provider finance route not found.');
}

async function handleCustomerTrustRoutes(req,url,user){
  const review=url.pathname.match(/^\/api\/v1\/customer\/bookings\/([^/]+)\/review$/);
  if(review){
    if(!validId(review[1]))return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
    if(req.method!=='POST')return method(['POST']);
    const body=await readJson(req);const errors=fields(body,['rating','comment']);
    if(!isObject(body))return fail(422,'VALIDATION_ERROR','Review validation failed.',errors);
    if(!Number.isInteger(body.rating)||body.rating<1||body.rating>5)errors.push('rating must be an integer from 1 to 5.');
    if(body.comment!==undefined&&body.comment!==null&&(typeof body.comment!=='string'||body.comment.length>2000))errors.push('comment must not exceed 2,000 characters.');
    if(errors.length)return fail(422,'VALIDATION_ERROR','Review validation failed.',errors);
    const booking=await getCustomerBooking(user.id,review[1]);
    if(!booking)return fail(404,'BOOKING_NOT_FOUND','Booking not found.');
    if(booking.status!=='completed')return fail(409,'BOOKING_NOT_REVIEWABLE','Only completed bookings can be reviewed.');
    const assignment=await getCompletedAssignmentForBooking(booking.id);
    const created=await createBookingReview({
      id:randomUUID(),bookingId:booking.id,customerUserId:user.id,
      booking,providerUserId:assignment?.providerUserId??null,
      rating:body.rating,comment:body.comment?.trim()||null
    });
    return created.error?fail(409,'REVIEW_NOT_AVAILABLE',created.error):ok(created.review,201);
  }

  const dispute=url.pathname.match(/^\/api\/v1\/customer\/bookings\/([^/]+)\/disputes$/);
  if(dispute){
    if(!validId(dispute[1]))return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
    if(req.method==='GET'){
      const existing=await getCustomerDispute(user.id,dispute[1]);
      return ok(existing);
    }
    if(req.method!=='POST')return method(['GET','POST']);
    const booking=await getCustomerBooking(user.id,dispute[1]);
    if(!booking)return fail(404,'BOOKING_NOT_FOUND','Booking not found.');
    const body=await readJson(req);const errors=validateDispute(body);
    if(errors.length)return fail(422,'VALIDATION_ERROR','Dispute validation failed.',errors);
    const created=await createDispute({
      id:randomUUID(),bookingId:booking.id,businessId:booking.businessId,
      userId:user.id,role:'customer',category:body.category,
      description:body.description.trim(),requestedResolution:body.requestedResolution,
      booking
    });
    return created.error?fail(409,'DISPUTE_NOT_AVAILABLE',created.error):ok(created.dispute,201);
  }

  const messages=url.pathname.match(/^\/api\/v1\/customer\/disputes\/([^/]+)\/messages$/);
  if(messages){
    if(!validId(messages[1]))return fail(400,'INVALID_ID','Dispute ID must be a valid UUID.');
    const disputeItem=await getCustomerDisputeById(user.id,messages[1]);
    if(!disputeItem)return fail(404,'DISPUTE_NOT_FOUND','Dispute not found.');
    if(req.method==='GET')return ok(await listDisputeMessages({disputeId:disputeItem.id,businessId:disputeItem.businessId}));
    if(req.method!=='POST')return method(['GET','POST']);
    const body=await readJson(req);const errors=fields(body,['message']);
    if(!isObject(body)||typeof body.message!=='string'||body.message.trim().length<1||body.message.length>3000)errors.push('message must be 1–3,000 characters.');
    if(errors.length)return fail(422,'VALIDATION_ERROR','Dispute message validation failed.',errors);
    const message=await addDisputeMessage({disputeId:disputeItem.id,businessId:disputeItem.businessId,userId:user.id,role:'customer',message:body.message.trim()});
    return message?ok(message,201):fail(409,'DISPUTE_CLOSED','This dispute is closed.');
  }
  return null;
}

async function handleBusinessTrustRoutes(req,url,user,business){
  if(!business?.businessId||!business?.membership)return fail(400,'BUSINESS_CONTEXT_REQUIRED','A valid business context is required.');
  const role=business.membership.role;
  const canManage=['owner','admin','manager'].includes(role);
  const paymentMatch=url.pathname.match(/^\/api\/v1\/business\/bookings\/([^/]+)\/payments$/);
  if(paymentMatch){
    if(!validId(paymentMatch[1]))return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
    if(req.method!=='GET')return method(['GET']);
    const booking=await getBusinessBooking(business.businessId,paymentMatch[1]);
    if(!booking)return fail(404,'BOOKING_NOT_FOUND','Booking not found.');
    if(!['owner','admin','manager'].includes(role))return fail(403,'INSUFFICIENT_ROLE','Only owners, admins and managers can view payment details.');
    return ok(await getBookingFinancialSummary(business.businessId,booking.id));
  }

  if(url.pathname==='/api/v1/business/reviews'){
    if(req.method!=='GET')return method(['GET']);
    if(!['owner','admin','manager','staff'].includes(role))return fail(403,'BUSINESS_ACCESS_DENIED','You do not have access to this business.');
    return ok(await listBusinessReviews(business.businessId));
  }
  if(url.pathname==='/api/v1/business/disputes'){
    if(req.method!=='GET')return method(['GET']);
    if(!['owner','admin','manager','staff'].includes(role))return fail(403,'BUSINESS_ACCESS_DENIED','You do not have access to this business.');
    return ok(await listBusinessDisputes(business.businessId));
  }
  const refundMatch=url.pathname.match(/^\/api\/v1\/business\/bookings\/([^/]+)\/refunds$/);
  if(refundMatch)return startBusinessRefund(req,url,user,business);
  const disputeMatch=url.pathname.match(/^\/api\/v1\/business\/bookings\/([^/]+)\/dispute$/);
  if(disputeMatch){
    if(!validId(disputeMatch[1]))return fail(400,'INVALID_ID','Booking ID must be a valid UUID.');
    if(req.method==='GET'){
      const item=await getBusinessDispute(business.businessId,disputeMatch[1]);
      return ok(item);
    }
    if(req.method!=='POST')return method(['GET','POST']);
    if(!canManage)return fail(403,'INSUFFICIENT_ROLE','Only owners, admins and managers can open disputes for a business.');
    const booking=await getBusinessBooking(business.businessId,disputeMatch[1]);
    if(!booking)return fail(404,'BOOKING_NOT_FOUND','Booking not found.');
    const body=await readJson(req);const errors=validateDispute(body);
    if(errors.length)return fail(422,'VALIDATION_ERROR','Dispute validation failed.',errors);
    const created=await createDispute({
      id:randomUUID(),bookingId:booking.id,businessId:booking.businessId,
      userId:user.id,role:'business',category:body.category,
      description:body.description.trim(),requestedResolution:body.requestedResolution,
      booking
    });
    return created.error?fail(409,'DISPUTE_NOT_AVAILABLE',created.error):ok(created.dispute,201);
  }
  const messages=url.pathname.match(/^\/api\/v1\/business\/disputes\/([^/]+)\/messages$/);
  if(messages){
    if(!validId(messages[1]))return fail(400,'INVALID_ID','Dispute ID must be a valid UUID.');
    const items=await listBusinessDisputes(business.businessId);
    const disputeItem=items.find(item=>item.id===messages[1]);
    if(!disputeItem)return fail(404,'DISPUTE_NOT_FOUND','Dispute not found.');
    if(req.method==='GET')return ok(await listDisputeMessages({disputeId:disputeItem.id,businessId:business.businessId}));
    if(req.method!=='POST')return method(['GET','POST']);
    if(!canManage)return fail(403,'INSUFFICIENT_ROLE','Only owners, admins and managers can respond to disputes.');
    const body=await readJson(req);const errors=fields(body,['message']);
    if(!isObject(body)||typeof body.message!=='string'||body.message.trim().length<1||body.message.length>3000)errors.push('message must be 1–3,000 characters.');
    if(errors.length)return fail(422,'VALIDATION_ERROR','Dispute message validation failed.',errors);
    const message=await addDisputeMessage({disputeId:disputeItem.id,businessId:business.businessId,userId:user.id,role:'business',message:body.message.trim()});
    return message?ok(message,201):fail(409,'DISPUTE_CLOSED','This dispute is closed.');
  }
  return null;
}

function safeGatewaySnapshot(data){
  const snapshot={};
  for(const key of ['id','status','reference','currency','transfer_code','paid_at','created_at','gateway_response']){
    const value=data?.[key];
    if(value===undefined||value===null)continue;
    snapshot[key]=typeof value==='string'?value.slice(0,300):value;
  }
  if(Number.isSafeInteger(Number(data?.amount)))snapshot.amount=Number(data.amount);
  return snapshot;
}

async function reconcilePaystackCandidate(run,candidate){
  const base={
    entityType:candidate.entityType,localEntityId:candidate.id,
    providerReference:candidate.providerReference,localStatus:candidate.localStatus,
    localAmountMinor:candidate.amountMinor,currencyCode:candidate.currencyCode
  };
  if(candidate.entityType==='refund'){
    return {
      ...base,outcome:'manual_review',providerStatus:'webhook_required',
      message:'Pending refunds are reconciled from signed Paystack refund webhooks or reviewed manually. This run does not create or repeat a refund.',
      providerSnapshot:{source:'webhook_or_manual_review'}
    };
  }

  const isPayment=candidate.entityType==='payment';
  const endpoint=isPayment
    ?'/transaction/verify/'+encodeURIComponent(candidate.providerReference)
    :'/transfer/verify/'+encodeURIComponent(candidate.providerReference);
  const gateway=await paystackRequest(endpoint,null,'GET');
  if(!gateway.ok){
    return {
      ...base,outcome:'error',providerStatus:null,
      message:gateway.message||'Paystack verification was unavailable.',
      providerSnapshot:{verification:'unavailable'}
    };
  }
  const data=gateway.data||{};
  const providerStatus=String(data.status||'unknown').toLowerCase();
  const providerAmount=Number.isSafeInteger(Number(data.amount))?Number(data.amount):null;
  const snapshot=safeGatewaySnapshot(data);

  if(isPayment){
    if(providerStatus==='success'){
      const eventKey=createHash('sha256')
        .update('reconciliation|'+run.id+'|payment|'+candidate.id+'|'+String(data.id||candidate.providerReference))
        .digest('hex');
      const payloadHash=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
      const verified=await markPaymentSucceeded(
        candidate.providerReference,data,eventKey,'reconciliation.transaction.verify',payloadHash
      );
      if(verified.mismatch){
        return {...base,providerStatus,outcome:'mismatch',providerAmountMinor:providerAmount,
          message:'Paystack reports success but the amount, currency, reference or status does not match SwiftServe.',
          providerSnapshot:snapshot};
      }
      if(verified.missing){
        return {...base,providerStatus,outcome:'skipped',providerAmountMinor:providerAmount,
          message:'The local payment record no longer exists.',
          providerSnapshot:snapshot};
      }
      return {...base,providerStatus,outcome:verified.changed?'updated':'matched',
        providerAmountMinor:providerAmount,
        message:verified.changed?'Payment status updated from verified Paystack evidence.':'Local payment matches the verified Paystack transaction.',
        providerSnapshot:snapshot};
    }
    if(['pending','processing','ongoing','queued'].includes(providerStatus)){
      return {...base,providerStatus,outcome:'pending',providerAmountMinor:providerAmount,
        message:'Paystack has not reached a terminal transaction status.',
        providerSnapshot:snapshot};
    }
    if(['failed','abandoned'].includes(providerStatus)){
      const eventKey=createHash('sha256')
        .update('reconciliation|'+run.id+'|payment|'+candidate.id+'|'+providerStatus)
        .digest('hex');
      const payloadHash=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
      await markPaymentFailed(candidate.providerReference,data.gateway_response||providerStatus,
        eventKey,'reconciliation.transaction.verify',payloadHash);
      return {...base,providerStatus,outcome:'updated',providerAmountMinor:providerAmount,
        message:'Payment marked failed after Paystack returned a terminal non-success status.',
        providerSnapshot:snapshot};
    }
    return {...base,providerStatus,outcome:'manual_review',
      message:'Paystack returned an unrecognised transaction status. No local status was changed.',
      providerSnapshot:snapshot};
  }

  if(providerStatus==='success'){
    const updated=await updatePayoutTransfer(
      candidate.id,'paid',candidate.providerReference,
      data.transfer_code?String(data.transfer_code):null,null
    );
    await markPayoutReconciled(candidate.id);
    return {...base,providerStatus,outcome:candidate.localStatus==='paid'?'matched':'updated',
      providerAmountMinor:providerAmount,
      message:candidate.localStatus==='paid'?'Payout remains paid according to Paystack.':'Payout marked paid after Paystack transfer verification.',
      providerSnapshot:snapshot,localStatus:updated?.status||candidate.localStatus};
  }
  if(['failed','blocked','rejected','abandoned'].includes(providerStatus)){
    const updated=await updatePayoutTransfer(
      candidate.id,'failed',candidate.providerReference,
      data.transfer_code?String(data.transfer_code):null,'Paystack transfer status: '+providerStatus
    );
    await markPayoutReconciled(candidate.id);
    return {...base,providerStatus,outcome:candidate.localStatus==='failed'?'matched':'updated',
      providerAmountMinor:providerAmount,
      message:'Payout status reconciled to failed. Review the gateway response before retrying.',
      providerSnapshot:snapshot,localStatus:updated?.status||candidate.localStatus};
  }
  if(['reversed','reversal'].includes(providerStatus)){
    const updated=await updatePayoutTransfer(
      candidate.id,'reversed',candidate.providerReference,
      data.transfer_code?String(data.transfer_code):null,'Paystack transfer was reversed.'
    );
    await markPayoutReconciled(candidate.id);
    return {...base,providerStatus,outcome:candidate.localStatus==='reversed'?'matched':'updated',
      providerAmountMinor:providerAmount,
      message:'Paystack reports a transfer reversal. The payout is marked reversed and requires finance review.',
      providerSnapshot:snapshot,localStatus:updated?.status||candidate.localStatus};
  }
  await markPayoutReconciled(candidate.id);
  return {...base,providerStatus,outcome:'pending',providerAmountMinor:providerAmount,
    message:'Transfer remains non-terminal at Paystack. SwiftServe did not initiate another transfer.',
    providerSnapshot:snapshot};
}

async function runPaystackReconciliation(limit=50){
  if(!process.env.PAYSTACK_SECRET_KEY)return fail(503,'PAYMENT_GATEWAY_NOT_CONFIGURED','Configure PAYSTACK_SECRET_KEY before running live reconciliation.');
  const run=await createFinanceReconciliationRun();
  const items=[];
  try{
    const candidates=await listFinanceReconciliationCandidates(limit);
    for(const candidate of candidates){
      let item;
      try{
        item=await reconcilePaystackCandidate(run,candidate);
      }catch(error){
        item={
          entityType:candidate.entityType,localEntityId:candidate.id,
          providerReference:candidate.providerReference,localStatus:candidate.localStatus,
          localAmountMinor:candidate.amountMinor,currencyCode:candidate.currencyCode,
          outcome:'error',providerStatus:null,
          message:'Reconciliation item failed safely: '+String(error?.message||'Unexpected error').slice(0,350),
          providerSnapshot:{verification:'error'}
        };
      }
      await recordFinanceReconciliationItem(run.id,item);
      items.push(item);
    }
    const completed=await finishFinanceReconciliationRun(run.id,items);
    await writeAdminAuditEvent({
      action:'finance.reconciliation.completed',targetType:'reconciliation_run',targetId:run.id,
      outcome:completed?.status==='completed'?'succeeded':'failed',
      details:{scannedCount:items.length,matchedCount:completed?.matchedCount||0,
        updatedCount:completed?.updatedCount||0,pendingCount:completed?.pendingCount||0,
        reviewCount:completed?.reviewCount||0,errorCount:completed?.errorCount||0,
        status:completed?.status||'unknown'}
    });
    return ok({run:completed,items},201);
  }catch(error){
    const completed=await finishFinanceReconciliationRun(run.id,items,'failed').catch(()=>null);
    await writeAdminAuditEvent({
      action:'finance.reconciliation.failed',targetType:'reconciliation_run',targetId:run.id,
      outcome:'failed',details:{scannedCount:items.length,status:completed?.status||'failed'}
    }).catch(()=>null);
    throw error;
  }
}

async function handleAdminFinanceRoutes(req,url){
  if(!isAdmin(req))return fail(401,'ADMIN_UNAUTHORIZED','A valid platform admin API key is required.');
  if(url.pathname==='/api/v1/admin/payouts/pending'){
    if(req.method!=='GET')return method(['GET']);
    return ok(await listAdminPayouts('pending'));
  }
  const payout=url.pathname.match(/^\/api\/v1\/admin\/payouts\/([^/]+)\/process$/);
  if(payout){
    if(!validId(payout[1]))return fail(400,'INVALID_ID','Payout ID must be a valid UUID.');
    if(req.method!=='POST')return method(['POST']);
    if(!process.env.PAYSTACK_SECRET_KEY)return fail(503,'PAYOUT_GATEWAY_NOT_CONFIGURED','Payout transfers are not enabled. Configure PAYSTACK_SECRET_KEY.');
    const record=await getPayoutForProcessing(payout[1]);
    if(!record)return fail(404,'PAYOUT_NOT_FOUND','Payout or verified provider bank recipient was not found.');
    if(record.payout.status==='paid')return ok(record.payout);
    if(!['pending','failed','processing'].includes(record.payout.status))return fail(409,'PAYOUT_NOT_READY','This payout is not ready for transfer.');
    if(record.accountStatus!=='active'||record.accountCurrency!==record.payout.currencyCode)return fail(409,'PAYOUT_ACCOUNT_MISMATCH','The provider payout account is inactive or uses a different currency.');
    if(record.payout.netAmountMinor<=0)return fail(409,'PAYOUT_AMOUNT_INVALID','The net payout amount must be positive.');
    const transferReference=record.payout.transferReference||'sspayout_'+payout[1].replaceAll('-','');
    if(record.payout.status==='processing'){
      if(!record.payout.transferReference)return fail(409,'PAYOUT_REFERENCE_MISSING','The processing payout has no transfer reference; manual reconciliation is required.');
      const verification=await paystackRequest('/transfer/verify/'+encodeURIComponent(transferReference),null,'GET');
      if(!verification.ok)return fail(503,'PAYOUT_STATUS_UNAVAILABLE','The existing transfer status could not be verified. No second transfer was created.');
      const transferStatus=String(verification.data?.status||'').toLowerCase();
      if(transferStatus==='success'){
        const settled=await updatePayoutTransfer(payout[1],'paid',transferReference,verification.data?.transfer_code?String(verification.data.transfer_code):null,null);
        return ok(settled);
      }
      if(['failed','reversed','abandoned','blocked','rejected'].includes(transferStatus)){
        const failed=await updatePayoutTransfer(payout[1],'failed',transferReference,verification.data?.transfer_code?String(verification.data.transfer_code):null,'Paystack transfer status: '+transferStatus);
        return fail(409,'PAYOUT_TRANSFER_TERMINAL','The previous transfer reached a conclusive '+transferStatus+' status. Review it before retrying.',failed);
      }
      return ok(record.payout,202);
    }
    const pending=await updatePayoutTransfer(payout[1],'processing',transferReference,null,null);
    const gateway=await paystackRequest('/transfer',{
      source:'balance',amount:record.payout.netAmountMinor,
      recipient:record.recipientCode,reference:transferReference,
      reason:'SwiftServe provider payout for booking '+record.payout.bookingId
    });
    if(!gateway.ok){
      await updatePayoutTransfer(payout[1],gateway.networkError?'processing':'failed',transferReference,null,gateway.message||'Transfer could not be initiated.');
      return fail(gateway.networkError?503:502,'PAYOUT_TRANSFER_FAILED',gateway.message||'Payout transfer failed.');
    }
    const providerStatus=String(gateway.data?.status||'pending').toLowerCase();
    const next=providerStatus==='success'?'paid':'processing';
    const updated=await updatePayoutTransfer(payout[1],next,transferReference,gateway.data?.transfer_code?String(gateway.data.transfer_code):null,null);
    return ok(updated,202);
  }
  if(url.pathname==='/api/v1/admin/disputes/pending'){
    if(req.method!=='GET')return method(['GET']);
    return ok(await listAdminDisputes('active'));
  }
  const dispute=url.pathname.match(/^\/api\/v1\/admin\/disputes\/([^/]+)$/);
  if(dispute){
    if(!validId(dispute[1]))return fail(400,'INVALID_ID','Dispute ID must be a valid UUID.');
    if(req.method!=='PATCH')return method(['PATCH']);
    const body=await readJson(req);const errors=fields(body,['status','resolution','note']);
    if(!isObject(body)||!['in_review','resolved','rejected'].includes(body.status))errors.push('status must be in_review, resolved or rejected.');
    if(['resolved','rejected'].includes(body.status)&&!['refund_full','refund_partial','rework','no_refund','dismissed'].includes(body.resolution))errors.push('A valid resolution is required for a closed dispute.');
    if(body.note!==undefined&&body.note!==null&&(typeof body.note!=='string'||body.note.length>2000))errors.push('note must not exceed 2,000 characters.');
    if(errors.length)return fail(422,'VALIDATION_ERROR','Dispute review validation failed.',errors);
    const updated=await resolveDispute(dispute[1],body.status,body.resolution??null,body.note??null);
    return updated?ok(updated):fail(409,'DISPUTE_ALREADY_CLOSED','Dispute not found or already closed.');
  }
  return fail(404,'NOT_FOUND','Admin finance route not found.');
}

export async function handleCustomerFinanceApi(req,url,user){
  if(user?.accountType!=='customer')return fail(403,'CUSTOMER_ACCOUNT_REQUIRED','This endpoint requires a customer account.');
  try{
    if(/^\/api\/v1\/customer\/bookings\/[^/]+\/payments$/.test(url.pathname))return await startCustomerPayment(req,url,user);
    if(/^\/api\/v1\/customer\/payments\/[^/]+\/verify$/.test(url.pathname))return await verifyCustomerPayment(req,url,user);
    if(/^\/api\/v1\/customer\/bookings\/[^/]+\/review$/.test(url.pathname)||
       /^\/api\/v1\/customer\/bookings\/[^/]+\/disputes$/.test(url.pathname)||
       /^\/api\/v1\/customer\/disputes\/[^/]+\/messages$/.test(url.pathname))
      return await handleCustomerTrustRoutes(req,url,user);
    return fail(404,'NOT_FOUND','Customer finance route not found.');
  }catch(error){
    if(error?.code==='INVALID_JSON')return fail(400,'INVALID_JSON',error.message);
    if(error?.code==='UNSUPPORTED_MEDIA_TYPE')return fail(415,'UNSUPPORTED_MEDIA_TYPE',error.message);
    if(error?.code==='BODY_TOO_LARGE')return fail(413,'BODY_TOO_LARGE',error.message);
    console.error(JSON.stringify({event:'customer_finance_route_failed',code:typeof error?.code==='string'?error.code:'NO_CODE',name:typeof error?.name==='string'?error.name:'UNKNOWN_ERROR'}));
    return fail(500,'INTERNAL_ERROR','An unexpected finance request error occurred.');
  }
}

export async function handleBusinessFinanceApi(req,url,user,business){
  try{return await handleBusinessTrustRoutes(req,url,user,business);}
  catch(error){
    if(error?.code==='INVALID_JSON')return fail(400,'INVALID_JSON',error.message);
    if(error?.code==='UNSUPPORTED_MEDIA_TYPE')return fail(415,'UNSUPPORTED_MEDIA_TYPE',error.message);
    if(error?.code==='BODY_TOO_LARGE')return fail(413,'BODY_TOO_LARGE',error.message);
    console.error(JSON.stringify({event:'business_finance_route_failed',code:typeof error?.code==='string'?error.code:'NO_CODE',name:typeof error?.name==='string'?error.name:'UNKNOWN_ERROR'}));
    return fail(500,'INTERNAL_ERROR','An unexpected finance request error occurred.');
  }
}

export async function handleProviderFinanceApi(req,url,user){
  try{return await handleProviderPayoutAccount(req,url,user);}
  catch(error){
    if(error?.code==='INVALID_JSON')return fail(400,'INVALID_JSON',error.message);
    if(error?.code==='UNSUPPORTED_MEDIA_TYPE')return fail(415,'UNSUPPORTED_MEDIA_TYPE',error.message);
    if(error?.code==='BODY_TOO_LARGE')return fail(413,'BODY_TOO_LARGE',error.message);
    console.error(JSON.stringify({event:'provider_finance_route_failed',code:typeof error?.code==='string'?error.code:'NO_CODE',name:typeof error?.name==='string'?error.name:'UNKNOWN_ERROR'}));
    return fail(500,'INTERNAL_ERROR','An unexpected finance request error occurred.');
  }
}

export async function handleAdminFinanceApi(req,url){
  try{return await handleAdminFinanceRoutes(req,url);}
  catch(error){
    if(error?.code==='INVALID_JSON')return fail(400,'INVALID_JSON',error.message);
    if(error?.code==='UNSUPPORTED_MEDIA_TYPE')return fail(415,'UNSUPPORTED_MEDIA_TYPE',error.message);
    if(error?.code==='BODY_TOO_LARGE')return fail(413,'BODY_TOO_LARGE',error.message);
    console.error(JSON.stringify({event:'admin_finance_route_failed',code:typeof error?.code==='string'?error.code:'NO_CODE',name:typeof error?.name==='string'?error.name:'UNKNOWN_ERROR'}));
    return fail(500,'INTERNAL_ERROR','An unexpected finance request error occurred.');
  }
}

export async function handlePaystackWebhook(rawBody,headers){
  if(!Buffer.isBuffer(rawBody)||rawBody.length>1024*1024)return {status:413,body:{error:'Webhook body is too large.'}};
  if(!verifyPaystackSignature(rawBody,headers))return {status:401,body:{error:'Invalid Paystack signature.'}};
  let event;
  try{event=JSON.parse(rawBody.toString('utf8'));}catch{return {status:400,body:{error:'Malformed JSON webhook body.'}};}
  if(!event||typeof event.event!=='string'||!isObject(event.data))return {status:400,body:{error:'Invalid Paystack event.'}};
  const eventType=event.event;
  const data=event.data;
  const payloadHash=createHash('sha256').update(rawBody).digest('hex');
  const eventKey=createHash('sha256').update(eventType+'|'+String(data.reference||data.id||'')+'|'+payloadHash).digest('hex');
  const claimed=await recordProviderWebhookEvent('paystack',eventKey,eventType,payloadHash);
  if(!claimed)return {status:200,body:{received:true,duplicate:true}};

  try{
  if(eventType==='charge.success'){
    if(!process.env.PAYSTACK_SECRET_KEY){
      await deleteProviderWebhookEvent('paystack',eventKey);
      return {status:503,body:{error:'Payment verification is temporarily unavailable.'}};
    }
    const reference=String(data.reference||'');
    const payment=await getPaymentByReference(reference);
    if(payment){
      const gateway=await paystackRequest('/transaction/verify/'+encodeURIComponent(reference),null,'GET');
      if(!gateway.ok){
        await deleteProviderWebhookEvent('paystack',eventKey);
        return {status:503,body:{error:'Payment verification is temporarily unavailable.'}};
      }
      const verified=gateway.data||{};
      const outcome=await markPaymentSucceeded(reference,verified,eventKey,eventType,payloadHash);
      if(outcome.mismatch){
        await deleteProviderWebhookEvent('paystack',eventKey);
        return {status:409,body:{error:'Payment verification values do not match.'}};
      }
      if(outcome.missing)return {status:200,body:{received:true,ignored:true}};
      const assignment=await getCompletedAssignmentForBooking(outcome.payment.bookingId);
      if(assignment)await createOrRefreshPayoutForCompletedAssignment(outcome.payment.bookingId,assignment);
    }
  }else if(eventType==='charge.failed'){
    const reference=String(data.reference||'');
    if(reference)await markPaymentFailed(reference,data.gateway_response||'Payment failed.',eventKey,eventType,payloadHash);
  }else if(['refund.pending','refund.processing','refund.processed','refund.failed'].includes(eventType)){
    const status=eventType.split('.')[1];
    const reference=String(data.reference||data.refund_reference||'');
    if(reference){
      const refund=await updateRefundStatus(reference,status,data.id?String(data.id):null,data.message||null);
      if(refund?.bookingId){
        const assignment=await getCompletedAssignmentForBooking(refund.bookingId);
        if(assignment)await createOrRefreshPayoutForCompletedAssignment(refund.bookingId,assignment);
      }
    }
  }else if(['transfer.success','transfer.failed','transfer.reversed'].includes(eventType)){
    const reference=String(data.reference||'');
    if(reference)await updatePayoutByTransferReference(reference,eventType==='transfer.success'?'paid':'failed',data.id?String(data.id):null);
  }
  return {status:200,body:{received:true}};
  }catch(error){
    await deleteProviderWebhookEvent('paystack',eventKey);
    throw error;
  }
}
