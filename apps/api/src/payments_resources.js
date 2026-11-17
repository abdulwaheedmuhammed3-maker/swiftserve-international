import { createHash, randomUUID } from 'node:crypto';
import { queryDatabase, withDatabaseTransaction } from './repository.js';
import { getCustomerBooking, listBookingQuotes } from './marketplace_resources.js';
import {
  getPaymentGateway,
  parsePaymentWebhook,
  verifyPaymentWebhookSignature
} from './payment_gateways.js';

const intents=new Map();

function mapIntent(row){
  return {
    id:row.id,businessId:row.business_id,bookingId:row.booking_id,
    customerUserId:row.customer_user_id,providerCode:row.provider_code,
    providerReference:row.provider_reference,
    providerTransactionRef:row.provider_transaction_ref,
    amountMinor:Number(row.amount_minor),currencyCode:row.currency_code,
    status:row.status,checkoutUrl:row.checkout_url,
    expiresAt:row.expires_at?new Date(row.expires_at).toISOString():null,
    failureCode:row.failure_code,failureMessage:row.failure_message,
    verifiedAt:row.verified_at?new Date(row.verified_at).toISOString():null,
    createdAt:row.created_at?new Date(row.created_at).toISOString():null,
    updatedAt:row.updated_at?new Date(row.updated_at).toISOString():null
  };
}

function publicIntent(item){
  return {
    id:item.id,bookingId:item.bookingId,providerCode:item.providerCode,
    providerReference:item.providerReference,amountMinor:item.amountMinor,
    currencyCode:item.currencyCode,status:item.status,checkoutUrl:item.checkoutUrl,
    expiresAt:item.expiresAt,createdAt:item.createdAt
  };
}

async function expectedBookingAmount(userId,booking){
  if(booking.status!=='confirmed'&&booking.status!=='assigned'){
    return {error:'Payment can only be initiated for a confirmed or assigned booking.'};
  }
  if(booking.pricingModel==='quote'){
    const quotes=await listBookingQuotes(userId,booking.id,'customer');
    const accepted=(quotes||[]).find(item=>item.id===booking.latestQuoteId&&item.status==='accepted');
    if(!accepted)return {error:'A customer-accepted quote is required before payment.'};
    return {amountMinor:accepted.amountMinor,currencyCode:accepted.currencyCode};
  }
  const unitPrice=Number(booking.servicePriceMinor);
  if(!Number.isSafeInteger(unitPrice)||unitPrice<=0){
    return {error:'This booking does not have a payable service price. Ask the business for a quote.'};
  }
  if(booking.pricingModel==='hourly'){
    const start=booking.confirmedStartAt||booking.requestedStartAt;
    const end=booking.confirmedEndAt||booking.requestedEndAt;
    if(!start||!end||Date.parse(end)<=Date.parse(start))return {error:'An hourly booking needs a confirmed start and end time.'};
    const minutes=(Date.parse(end)-Date.parse(start))/60000;
    return {amountMinor:Math.ceil(unitPrice*minutes/60),currencyCode:booking.currencyCode};
  }
  return {amountMinor:unitPrice,currencyCode:booking.currencyCode};
}

async function findIntentByIdempotency(userId,key){
  const result=await queryDatabase(
    'SELECT * FROM payment_intents WHERE customer_user_id=$1 AND idempotency_key=$2 LIMIT 1',
    [userId,key]
  );
  if(result)return result.rows[0]?mapIntent(result.rows[0]):null;
  return [...intents.values()].find(item=>item.customerUserId===userId&&item.idempotencyKey===key)||null;
}

export async function createPaymentIntentForBooking(input){
  const {user,booking,idempotencyKey}=input;
  if(!/^[A-Za-z0-9._:-]{8,120}$/.test(idempotencyKey||'')){
    return {error:'An Idempotency-Key header between 8 and 120 safe characters is required.'};
  }
  const existing=await findIntentByIdempotency(user.id,idempotencyKey);
  if(existing){
    if(existing.bookingId!==booking.id)return {error:'That idempotency key has already been used for another booking.'};
    return {intent:publicIntent(existing),reused:true};
  }

  const amount=await expectedBookingAmount(user.id,booking);
  if(amount.error)return amount;
  const currencyCode=amount.currencyCode.toUpperCase();
  const gateway=getPaymentGateway();
  if(!gateway)return {error:'No payment gateway is configured. Payment collection is currently disabled.'};
  if(!gateway.supportsCurrency(currencyCode)){
    return {error:'The configured payment gateway is not enabled for '+currencyCode+' in this environment.'};
  }

  const activeResult=await queryDatabase(
    "SELECT * FROM payment_intents WHERE business_id=$1 AND booking_id=$2 AND status IN ('created','pending') ORDER BY created_at DESC LIMIT 1",
    [booking.businessId,booking.id]
  );
  let active=activeResult?activeResult.rows[0]?mapIntent(activeResult.rows[0]):null:
    [...intents.values()].find(item=>item.businessId===booking.businessId&&item.bookingId===booking.id&&['created','pending'].includes(item.status));
  if(active)return {conflict:true,intent:publicIntent(active)};

  const id=randomUUID();
  const providerReference='SSPAY'+randomUUID().replaceAll('-','').toUpperCase();
  const now=new Date().toISOString();
  const expiresAt=new Date(Date.now()+30*60*1000).toISOString();
  const intent={
    id,businessId:booking.businessId,bookingId:booking.id,customerUserId:user.id,
    providerCode:gateway.code,providerReference,providerTransactionRef:null,
    idempotencyKey,amountMinor:amount.amountMinor,currencyCode,status:'created',
    checkoutUrl:null,expiresAt,failureCode:null,failureMessage:null,
    createdAt:now,updatedAt:now
  };

  const inserted=await queryDatabase(
    "INSERT INTO payment_intents (id,business_id,booking_id,customer_user_id,provider_code,provider_reference,idempotency_key,amount_minor,currency_code,status,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'created',$10) RETURNING *",
    [id,booking.businessId,booking.id,user.id,gateway.code,providerReference,idempotencyKey,
      amount.amountMinor,currencyCode,expiresAt]
  );
  if(inserted)Object.assign(intent,mapIntent(inserted.rows[0]));
  else intents.set(id,intent);

  try{
    const checkout=await gateway.initialize({
      paymentIntentId:id,providerReference,bookingId:booking.id,
      businessId:booking.businessId,bookingReference:booking.reference,
      amountMinor:amount.amountMinor,currencyCode,
      customerEmail:user.email,customerName:user.fullName,
      customerPhone:booking.serviceAddress?.phoneE164
    });
    const updated=await queryDatabase(
      "UPDATE payment_intents SET status='pending',checkout_url=$2,provider_reference=$3,updated_at=now() WHERE id=$1 RETURNING *",
      [id,checkout.checkoutUrl,checkout.providerReference]
    );
    intent.status='pending';
    intent.checkoutUrl=checkout.checkoutUrl;
    intent.providerReference=checkout.providerReference;
    intent.updatedAt=new Date().toISOString();
    if(updated)Object.assign(intent,mapIntent(updated.rows[0]));
    else intents.set(id,intent);
    await queryDatabase("UPDATE bookings SET payment_status='pending',updated_at=now() WHERE id=$1 AND business_id=$2",[booking.id,booking.businessId]);
    return {intent:publicIntent(intent),reused:false};
  }catch(error){
    const code=typeof error.code==='string'?error.code:'PAYMENT_INITIALIZATION_FAILED';
    const message=typeof error.message==='string'?error.message.slice(0,500):'Payment initialization failed.';
    const updated=await queryDatabase(
      "UPDATE payment_intents SET status='failed',failure_code=$2,failure_message=$3,updated_at=now() WHERE id=$1 RETURNING *",
      [id,code,message]
    );
    intent.status='failed';intent.failureCode=code;intent.failureMessage=message;
    if(updated)Object.assign(intent,mapIntent(updated.rows[0]));
    else intents.set(id,intent);
    return {error:'Payment provider could not initialize checkout: '+message};
  }
}

export async function getCustomerPaymentIntent(userId,intentId){
  const result=await queryDatabase(
    'SELECT * FROM payment_intents WHERE id=$1 AND customer_user_id=$2 LIMIT 1',
    [intentId,userId]
  );
  if(result)return result.rows[0]?publicIntent(mapIntent(result.rows[0])):null;
  const item=intents.get(intentId);
  return item&&item.customerUserId===userId?publicIntent(item):null;
}

export async function listCustomerBookingPayments(userId,bookingId){
  const booking=await getCustomerBooking(userId,bookingId);
  if(!booking)return null;
  const result=await queryDatabase(
    'SELECT * FROM payment_intents WHERE booking_id=$1 AND customer_user_id=$2 ORDER BY created_at DESC',
    [bookingId,userId]
  );
  if(result)return result.rows.map(row=>publicIntent(mapIntent(row)));
  return [...intents.values()].filter(item=>item.bookingId===bookingId&&item.customerUserId===userId)
    .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(publicIntent);
}

async function markWebhookEvent(providerCode,eventId,eventType,payloadHash){
  const result=await queryDatabase(
    "INSERT INTO payment_webhook_events (id,provider_code,provider_event_id,event_type,payload_sha256,signature_verified,processing_status) VALUES ($1,$2,$3,$4,$5,true,'received') ON CONFLICT (provider_code,provider_event_id) DO NOTHING RETURNING id",
    [randomUUID(),providerCode,eventId,eventType,payloadHash]
  );
  if(result)return result.rowCount>0;
  const key=providerCode+':'+eventId;
  if(intents.has('__webhook__:'+key))return false;
  intents.set('__webhook__:'+key,{id:key});
  return true;
}

async function finishWebhook(providerCode,eventId,status,error=null){
  await queryDatabase(
    'UPDATE payment_webhook_events SET processing_status=$3,processing_error=$4,processed_at=now() WHERE provider_code=$1 AND provider_event_id=$2',
    [providerCode,eventId,status,error]
  );
}

async function applyVerifiedPayment(providerCode,event,intent,verified){
  const valid=verified.success&&verified.reference===intent.providerReference&&
    verified.amountMinor===Number(intent.amountMinor)&&
    verified.currencyCode===intent.currencyCode;
  if(!valid){
    await finishWebhook(providerCode,event.eventId,'failed','Verified provider amount, currency, reference or status did not match the payment intent.');
    return {accepted:false,reason:'Provider verification did not match the payment intent.'};
  }

  const result=await withDatabaseTransaction(async client=>{
    const current=await client.query('SELECT * FROM payment_intents WHERE id=$1 FOR UPDATE',[intent.id]);
    const row=current.rows[0];
    if(!row)return {missing:true};
    if(row.status==='succeeded')return {alreadyPaid:true};
    if(['cancelled','expired','refunded'].includes(row.status))return {invalidState:true};

    await client.query(
      "UPDATE payment_intents SET status='succeeded',provider_transaction_ref=$2,verified_at=now(),failure_code=NULL,failure_message=NULL,updated_at=now() WHERE id=$1",
      [intent.id,verified.transactionReference]
    );
    await client.query(
      "UPDATE bookings SET payment_status='paid',updated_at=now() WHERE id=$1 AND business_id=$2",
      [row.booking_id,row.business_id]
    );
    await client.query(
      "INSERT INTO payment_transactions (id,payment_intent_id,provider_code,provider_transaction_ref,transaction_type,amount_minor,currency_code,status,provider_event_id,verified_at) VALUES ($1,$2,$3,$4,'charge',$5,$6,'succeeded',$7,now()) ON CONFLICT (provider_code,provider_transaction_ref,transaction_type) DO NOTHING",
      [randomUUID(),intent.id,providerCode,verified.transactionReference,
        Number(intent.amountMinor),intent.currencyCode,event.eventId]
    );
    await client.query(
      "INSERT INTO notifications (user_id,notification_type,title,body,resource_type,resource_id) VALUES ($1,'payment_success','Payment received','Your payment for booking '+$2+' has been confirmed.','booking',$3)",
      [row.customer_user_id,row.booking_id,row.booking_id]
    );
    await client.query(
      "INSERT INTO notifications (user_id,notification_type,title,body,resource_type,resource_id) SELECT bm.user_id,'booking_payment','Customer payment received','A customer payment has been verified for a booking.','booking',$1 FROM business_memberships bm WHERE bm.business_id=$2 AND bm.status='active'",
      [row.booking_id,row.business_id]
    );
    return {paid:true};
  });

  if(result===null){
    const item=intents.get(intent.id);
    if(item){
      item.status='succeeded';
      item.providerTransactionRef=verified.transactionReference;
      item.verifiedAt=new Date().toISOString();
      intents.set(item.id,item);
    }
    return {accepted:true,paid:true};
  }
  if(result.missing||result.invalidState){
    await finishWebhook(providerCode,event.eventId,'failed','Payment intent was not available for settlement.');
    return {accepted:false,reason:'Payment intent is not in a payable state.'};
  }
  if(!result.alreadyPaid&&!result.paid){
    await finishWebhook(providerCode,event.eventId,'failed','Payment settlement failed.');
    return {accepted:false,reason:'Payment settlement failed.'};
  }
  await finishWebhook(providerCode,event.eventId,'processed');
  return {accepted:true,paid:true,alreadyPaid:Boolean(result.alreadyPaid)};
}

export async function handlePaymentWebhook(providerCode,rawBody,headers){
  const code=String(providerCode||'').toLowerCase();
  if(!['paystack','flutterwave'].includes(code))return {status:404,body:{error:{code:'PAYMENT_PROVIDER_NOT_FOUND',message:'Unsupported payment provider.'}}};
  if(!verifyPaymentWebhookSignature(code,rawBody,headers)){
    return {status:401,body:{error:{code:'INVALID_WEBHOOK_SIGNATURE',message:'Webhook signature is invalid.'}}};
  }
  let payload;
  try{payload=JSON.parse(rawBody.toString('utf8'));}
  catch{return {status:400,body:{error:{code:'INVALID_WEBHOOK_BODY',message:'Webhook body must be valid JSON.'}}};}
  const event=parsePaymentWebhook(code,payload);
  if(!event||!event.eventId||!event.providerReference){
    return {status:200,body:{data:{received:true,ignored:true}}};
  }
  const payloadHash=createHash('sha256').update(rawBody).digest('hex');
  const firstDelivery=await markWebhookEvent(code,event.eventId,event.eventType,payloadHash);
  if(!firstDelivery)return {status:200,body:{data:{received:true,duplicate:true}}};
  if(!event.success){
    await finishWebhook(code,event.eventId,'ignored');
    return {status:200,body:{data:{received:true,ignored:true}}};
  }

  const result=await queryDatabase(
    'SELECT * FROM payment_intents WHERE provider_code=$1 AND provider_reference=$2 LIMIT 1',
    [code,event.providerReference]
  );
  const intent=result?result.rows[0]?mapIntent(result.rows[0]):null:
    [...intents.values()].find(item=>item.providerCode===code&&item.providerReference===event.providerReference);
  if(!intent){
    await finishWebhook(code,event.eventId,'ignored','No matching payment intent.');
    return {status:200,body:{data:{received:true,ignored:true}}};
  }

  try{
    const gateway=getPaymentGateway(code);
    if(!gateway)throw new Error('The payment gateway is not configured.');
    const verified=await gateway.verifyTransaction({
      providerReference:event.providerReference,
      transactionReference:event.transactionReference
    });
    const applied=await applyVerifiedPayment(code,event,intent,verified);
    return {
      status:200,
      body:{data:{received:true,paid:applied.paid===true,accepted:applied.accepted===true}}
    };
  }catch(error){
    await finishWebhook(code,event.eventId,'failed',String(error.message||'Payment verification failed.').slice(0,500));
    return {status:200,body:{data:{received:true,verificationPending:true}}};
  }
}

export async function listPaymentIntentsForBusiness(businessId,bookingId){
  const result=await queryDatabase(
    'SELECT * FROM payment_intents WHERE business_id=$1 AND booking_id=$2 ORDER BY created_at DESC',
    [businessId,bookingId]
  );
  if(result)return result.rows.map(row=>publicIntent(mapIntent(row)));
  return [...intents.values()].filter(item=>item.businessId===businessId&&item.bookingId===bookingId).map(publicIntent);
}
