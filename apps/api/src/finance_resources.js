import { randomUUID } from 'node:crypto';
import { queryDatabase, withDatabaseTransaction } from './repository.js';

const payments=new Map();
const refunds=new Map();
const payoutAccounts=new Map();
const payouts=new Map();
const reviews=new Map();
const disputes=new Map();
const disputeMessages=new Map();
const webhookEvents=new Map();

function mapPayment(row){
  return {
    id:row.id,businessId:row.business_id,bookingId:row.booking_id,
    customerUserId:row.customer_user_id,provider:row.provider,
    reference:row.provider_reference,providerTransactionId:row.provider_transaction_id,
    amountMinor:Number(row.amount_minor),currencyCode:row.currency_code,
    status:row.status,authorizationUrl:row.authorization_url,
    paidAt:row.paid_at?new Date(row.paid_at).toISOString():null,
    createdAt:row.created_at?new Date(row.created_at).toISOString():null
  };
}

function mapRefund(row){
  return {
    id:row.id,bookingId:row.booking_id,paymentIntentId:row.payment_intent_id,
    reference:row.provider_reference,amountMinor:Number(row.amount_minor),
    currencyCode:row.currency_code,status:row.status,
    customerNote:row.customer_note,merchantNote:row.merchant_note,
    failureReason:row.failure_reason,
    processedAt:row.processed_at?new Date(row.processed_at).toISOString():null,
    createdAt:row.created_at?new Date(row.created_at).toISOString():null
  };
}

function mapPayout(row){
  return {
    id:row.id,businessId:row.business_id,bookingId:row.booking_id,
    bookingAssignmentId:row.booking_assignment_id,providerUserId:row.provider_user_id,
    paymentIntentId:row.payment_intent_id,currencyCode:row.currency_code,
    grossAmountMinor:Number(row.gross_amount_minor),
    platformFeeMinor:Number(row.platform_fee_minor),
    netAmountMinor:Number(row.net_amount_minor),status:row.status,
    transferReference:row.transfer_reference,
    failureReason:row.failure_reason,
    initiatedAt:row.initiated_at?new Date(row.initiated_at).toISOString():null,
    paidAt:row.paid_at?new Date(row.paid_at).toISOString():null,
    createdAt:row.created_at?new Date(row.created_at).toISOString():null,
    providerDisplayName:row.provider_display_name,
    accountName:row.account_name,
    bankName:row.bank_name,
    bankCode:row.bank_code
  };
}

function mapReview(row){
  return {
    id:row.id,bookingId:row.booking_id,businessId:row.business_id,
    customerUserId:row.customer_user_id,providerUserId:row.provider_user_id,
    customerName:row.customer_name,rating:row.rating,comment:row.comment,
    status:row.status,createdAt:row.created_at?new Date(row.created_at).toISOString():null
  };
}

function mapDispute(row){
  return {
    id:row.id,businessId:row.business_id,bookingId:row.booking_id,
    openedByUserId:row.opened_by_user_id,openedByRole:row.opened_by_role,
    category:row.category,description:row.description,
    requestedResolution:row.requested_resolution,status:row.status,
    resolution:row.resolution,resolutionNote:row.resolution_note,
    resolvedAt:row.resolved_at?new Date(row.resolved_at).toISOString():null,
    createdAt:row.created_at?new Date(row.created_at).toISOString():null,
    publicReference:row.public_reference
  };
}

export async function createPaymentIntentRecord(input){
  const result=await withDatabaseTransaction(async client=>{
    const existing=await client.query(
      'SELECT * FROM payment_intents WHERE customer_user_id=$1 AND idempotency_key=$2 LIMIT 1',
      [input.customerUserId,input.idempotencyKey]
    );
    if(existing.rows[0])return {existing:mapPayment(existing.rows[0])};
    const active=await client.query(
      "SELECT id FROM payment_intents WHERE business_id=$1 AND booking_id=$2 AND status IN ('pending','succeeded','partially_refunded','refunded') LIMIT 1",
      [input.businessId,input.bookingId]
    );
    if(active.rows[0])return {conflict:true};
    const inserted=await client.query(
      "INSERT INTO payment_intents (id,business_id,booking_id,customer_user_id,provider,provider_reference,idempotency_key,amount_minor,currency_code,status) VALUES ($1,$2,$3,$4,'paystack',$5,$6,$7,$8,'pending') RETURNING *",
      [input.id,input.businessId,input.bookingId,input.customerUserId,input.reference,input.idempotencyKey,input.amountMinor,input.currencyCode]
    );
    return {payment:mapPayment(inserted.rows[0])};
  });
  if(result){
    if(result.existing)return {payment:result.existing,existing:true};
    if(result.conflict)return {conflict:true};
    return {payment:result.payment,existing:false};
  }

  const prior=[...payments.values()].find(item=>item.customerUserId===input.customerUserId&&item.idempotencyKey===input.idempotencyKey);
  if(prior)return {payment:prior,existing:true};
  const active=[...payments.values()].find(item=>item.businessId===input.businessId&&item.bookingId===input.bookingId&&['pending','succeeded','partially_refunded','refunded'].includes(item.status));
  if(active)return {conflict:true};
  const payment={
    id:input.id,businessId:input.businessId,bookingId:input.bookingId,
    customerUserId:input.customerUserId,provider:'paystack',
    reference:input.reference,providerTransactionId:null,
    idempotencyKey:input.idempotencyKey,amountMinor:input.amountMinor,
    currencyCode:input.currencyCode,status:'pending',
    authorizationUrl:null,paidAt:null,createdAt:new Date().toISOString()
  };
  payments.set(payment.id,payment);
  return {payment,existing:false};
}

export async function updatePaymentAuthorization(id,authorizationUrl){
  const result=await queryDatabase(
    "UPDATE payment_intents SET authorization_url=$2,updated_at=now() WHERE id=$1 AND status='pending' RETURNING *",
    [id,authorizationUrl]
  );
  if(result)return result.rows[0]?mapPayment(result.rows[0]):null;
  const item=payments.get(id);
  if(!item||item.status!=='pending')return null;
  item.authorizationUrl=authorizationUrl;
  payments.set(id,item);
  return item;
}

export async function failPaymentInitialization(id,message){
  const safe=String(message||'Gateway initialization failed.').slice(0,500);
  const result=await queryDatabase(
    "UPDATE payment_intents SET status='failed',gateway_message=$2,updated_at=now() WHERE id=$1 AND status='pending' RETURNING *",
    [id,safe]
  );
  if(result)return result.rows[0]?mapPayment(result.rows[0]):null;
  const item=payments.get(id);
  if(!item||item.status!=='pending')return null;
  item.status='failed';
  item.gatewayMessage=safe;
  payments.set(id,item);
  return item;
}

export async function getCustomerPayment(userId,id){
  const result=await queryDatabase('SELECT * FROM payment_intents WHERE id=$1 AND customer_user_id=$2',[id,userId]);
  if(result)return result.rows[0]?mapPayment(result.rows[0]):null;
  const item=payments.get(id);
  return item&&item.customerUserId===userId?item:null;
}

export async function getPaymentByReference(reference){
  const result=await queryDatabase('SELECT * FROM payment_intents WHERE provider_reference=$1 LIMIT 1',[reference]);
  if(result)return result.rows[0]?mapPayment(result.rows[0]):null;
  return [...payments.values()].find(item=>item.reference===reference)||null;
}

export async function listCustomerPayments(userId,bookingId){
  const result=await queryDatabase(
    'SELECT * FROM payment_intents WHERE customer_user_id=$1 AND booking_id=$2 ORDER BY created_at DESC',
    [userId,bookingId]
  );
  if(result)return result.rows.map(mapPayment);
  return [...payments.values()].filter(item=>item.customerUserId===userId&&item.bookingId===bookingId);
}

export async function markPaymentSucceeded(reference,providerData,eventKey,eventType,payloadHash){
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query(
      'SELECT * FROM payment_intents WHERE provider_reference=$1 FOR UPDATE',
      [reference]
    );
    const row=selected.rows[0];
    if(!row)return {missing:true};
    if(Number(providerData.amount)!==Number(row.amount_minor)||
       String(providerData.currency).toUpperCase()!==row.currency_code||
       String(providerData.reference)!==row.provider_reference||
       providerData.status!=='success')return {mismatch:true};
    await client.query(
      'INSERT INTO payment_events (payment_intent_id,provider,provider_event_key,event_type,provider_status,payload_hash) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (provider,provider_event_key) DO NOTHING',
      [row.id,'paystack',eventKey,eventType,'success',payloadHash]
    );
    if(row.status==='pending'){
      const updated=await client.query(
        "UPDATE payment_intents SET status='succeeded',provider_transaction_id=$2,paid_at=COALESCE($3::timestamptz,now()),gateway_message=NULL,updated_at=now() WHERE id=$1 RETURNING *",
        [row.id,providerData.id?String(providerData.id):null,providerData.paid_at||null]
      );
      return {payment:mapPayment(updated.rows[0]),changed:true};
    }
    return {payment:mapPayment(row),changed:false};
  });
  if(result){
    if(result.missing||result.mismatch)return result;
    if(result.changed)await createOrRefreshPayoutForCompletedAssignment(result.payment.bookingId);
    return result;
  }
  const item=[...payments.values()].find(payment=>payment.reference===reference);
  if(!item)return {missing:true};
  if(Number(providerData.amount)!==Number(item.amountMinor)||
     String(providerData.currency).toUpperCase()!==item.currencyCode||
     String(providerData.reference)!==item.reference||providerData.status!=='success')return {mismatch:true};
  if(item.status==='pending'){
    item.status='succeeded';
    item.providerTransactionId=providerData.id?String(providerData.id):null;
    item.paidAt=providerData.paid_at||new Date().toISOString();
    payments.set(item.id,item);
    return {payment:item,changed:true};
  }
  return {payment:item,changed:false};
}

export async function markPaymentFailed(reference,message,eventKey,eventType,payloadHash){
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query('SELECT * FROM payment_intents WHERE provider_reference=$1 FOR UPDATE',[reference]);
    const row=selected.rows[0];
    if(!row)return null;
    await client.query(
      'INSERT INTO payment_events (payment_intent_id,provider,provider_event_key,event_type,provider_status,payload_hash) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (provider,provider_event_key) DO NOTHING',
      [row.id,'paystack',eventKey,eventType,'failed',payloadHash]
    );
    if(row.status!=='pending')return mapPayment(row);
    const updated=await client.query(
      "UPDATE payment_intents SET status='failed',gateway_message=$2,updated_at=now() WHERE id=$1 RETURNING *",
      [row.id,String(message||'Payment was not successful.').slice(0,500)]
    );
    return mapPayment(updated.rows[0]);
  });
  if(result!==null)return result;
  const item=[...payments.values()].find(payment=>payment.reference===reference);
  if(!item)return null;
  if(item.status==='pending'){
    item.status='failed';item.gatewayMessage=String(message||'Payment was not successful.').slice(0,500);
    payments.set(item.id,item);
  }
  return item;
}

export async function createRefundRecord(input){
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query(
      "SELECT * FROM payment_intents WHERE id=$1 AND business_id=$2 AND booking_id=$3 AND status IN ('succeeded','partially_refunded') FOR UPDATE",
      [input.paymentIntentId,input.businessId,input.bookingId]
    );
    const payment=selected.rows[0];
    if(!payment)return {error:'A successful payment for this booking was not found.'};
    const totals=await client.query(
      "SELECT COALESCE(SUM(amount_minor),0)::bigint AS amount FROM refunds WHERE payment_intent_id=$1 AND status IN ('pending','processing','processed')",
      [payment.id]
    );
    const remaining=Number(payment.amount_minor)-Number(totals.rows[0].amount);
    const amount=input.amountMinor??remaining;
    if(!Number.isSafeInteger(amount)||amount<=0||amount>remaining)return {error:'Refund amount exceeds the remaining refundable payment balance.'};
    const row=await client.query(
      "INSERT INTO refunds (id,business_id,booking_id,payment_intent_id,customer_user_id,requested_by_user_id,provider,provider_reference,amount_minor,currency_code,status,customer_note,merchant_note) VALUES ($1,$2,$3,$4,$5,$6,'paystack',$7,$8,$9,'pending',$10,$11) RETURNING *",
      [input.id,input.businessId,input.bookingId,payment.id,payment.customer_user_id,input.requestedByUserId,input.reference,amount,payment.currency_code,input.customerNote??null,input.merchantNote??null]
    );
    return {refund:mapRefund(row.rows[0]),payment:mapPayment(payment)};
  });
  if(result)return result;
  const payment=payments.get(input.paymentIntentId);
  if(!payment||payment.businessId!==input.businessId||payment.bookingId!==input.bookingId||!['succeeded','partially_refunded'].includes(payment.status))
    return {error:'A successful payment for this booking was not found.'};
  const used=[...refunds.values()].filter(item=>item.paymentIntentId===payment.id&&['pending','processing','processed'].includes(item.status)).reduce((sum,item)=>sum+item.amountMinor,0);
  const amount=input.amountMinor??(payment.amountMinor-used);
  if(!Number.isSafeInteger(amount)||amount<=0||amount>payment.amountMinor-used)return {error:'Refund amount exceeds the remaining refundable payment balance.'};
  const refund={id:input.id,businessId:input.businessId,bookingId:input.bookingId,paymentIntentId:payment.id,
    customerUserId:payment.customerUserId,requestedByUserId:input.requestedByUserId,
    provider:'paystack',reference:input.reference,amountMinor:amount,currencyCode:payment.currencyCode,
    status:'pending',customerNote:input.customerNote??null,merchantNote:input.merchantNote??null,
    createdAt:new Date().toISOString()};
  refunds.set(refund.id,refund);
  return {refund,payment};
}

export async function updateRefundStatus(reference,status,providerRefundId=null,failureReason=null){
  const allowed=new Set(['pending','processing','processed','failed']);
  if(!allowed.has(status))return null;
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query('SELECT * FROM refunds WHERE provider_reference=$1 OR provider_refund_id=$1 FOR UPDATE',[reference]);
    const row=selected.rows[0];
    if(!row)return null;
    const transitions={pending:new Set(['pending','processing','processed','failed']),
      processing:new Set(['processing','processed','failed']),
      processed:new Set(['processed']),
      failed:new Set(['failed'])};
    if(!transitions[row.status]?.has(status))return mapRefund(row);
    const updated=await client.query(
      "UPDATE refunds SET status=$2,provider_refund_id=COALESCE($3,provider_refund_id),failure_reason=$4,processed_at=CASE WHEN $2='processed' THEN COALESCE(processed_at,now()) ELSE processed_at END,updated_at=now() WHERE id=$1 RETURNING *",
      [row.id,status,providerRefundId,failureReason]
    );
    const totals=await client.query(
      "SELECT COALESCE(SUM(amount_minor),0)::bigint AS amount,COUNT(*) FILTER (WHERE status IN ('pending','processing'))::int AS open_count FROM refunds WHERE payment_intent_id=$1 AND status='processed'",
      [row.payment_intent_id]
    );
    const payment=await client.query('SELECT amount_minor,status FROM payment_intents WHERE id=$1 FOR UPDATE',[row.payment_intent_id]);
    const refunded=Number(totals.rows[0].amount);
    const target=refunded>=Number(payment.rows[0].amount_minor)?'refunded':refunded>0?'partially_refunded':'succeeded';
    if(['succeeded','partially_refunded','refunded'].includes(payment.rows[0].status))
      await client.query('UPDATE payment_intents SET status=$2,updated_at=now() WHERE id=$1',[row.payment_intent_id,target]);
    return mapRefund(updated.rows[0]);
  });
  if(result!==null){
    if(result?.bookingId)await createOrRefreshPayoutForCompletedAssignment(result.bookingId);
    return result;
  }
  const item=[...refunds.values()].find(refund=>refund.reference===reference||refund.providerRefundId===reference);
  if(!item)return null;
  const transitions={pending:new Set(['pending','processing','processed','failed']),
    processing:new Set(['processing','processed','failed']),
    processed:new Set(['processed']),
    failed:new Set(['failed'])};
  if(!transitions[item.status]?.has(status))return item;
  item.status=status;
  if(providerRefundId)item.providerRefundId=providerRefundId;
  item.failureReason=failureReason;
  if(status==='processed')item.processedAt=new Date().toISOString();
  refunds.set(item.id,item);
  const payment=payments.get(item.paymentIntentId);
  if(payment){
    const completed=[...refunds.values()].filter(refund=>refund.paymentIntentId===payment.id&&refund.status==='processed').reduce((sum,refund)=>sum+refund.amountMinor,0);
    payment.status=completed>=payment.amountMinor?'refunded':completed>0?'partially_refunded':'succeeded';
    payments.set(payment.id,payment);
  }
  return item;
}

export async function listBookingRefunds(businessId,bookingId){
  const result=await queryDatabase('SELECT * FROM refunds WHERE business_id=$1 AND booking_id=$2 ORDER BY created_at DESC',[businessId,bookingId]);
  if(result)return result.rows.map(mapRefund);
  return [...refunds.values()].filter(item=>item.businessId===businessId&&item.bookingId===bookingId);
}

export async function createProviderPayoutAccount(input){
  const result=await queryDatabase(
    "INSERT INTO provider_payout_accounts (provider_user_id,provider,recipient_code,recipient_type,currency_code,account_name,bank_code,bank_name,last_four,status) VALUES ($1,'paystack',$2,'nuban',$3,$4,$5,$6,$7,'active') ON CONFLICT (provider_user_id) DO UPDATE SET provider='paystack',recipient_code=EXCLUDED.recipient_code,recipient_type='nuban',currency_code=EXCLUDED.currency_code,account_name=EXCLUDED.account_name,bank_code=EXCLUDED.bank_code,bank_name=EXCLUDED.bank_name,last_four=EXCLUDED.last_four,status='active',updated_at=now() RETURNING *",
    [input.providerUserId,input.recipientCode,input.currencyCode,input.accountName,input.bankCode,input.bankName,input.lastFour]
  );
  if(result)return {
    providerUserId:result.rows[0].provider_user_id,provider:result.rows[0].provider,
    currencyCode:result.rows[0].currency_code,accountName:result.rows[0].account_name,
    bankName:result.rows[0].bank_name,bankCode:result.rows[0].bank_code,
    lastFour:result.rows[0].last_four,status:result.rows[0].status
  };
  const safe={providerUserId:input.providerUserId,provider:'paystack',recipientCode:input.recipientCode,
    currencyCode:input.currencyCode,accountName:input.accountName,bankCode:input.bankCode,
    bankName:input.bankName,lastFour:input.lastFour,status:'active'};
  payoutAccounts.set(input.providerUserId,safe);
  return safe;
}

export async function getProviderPayoutAccount(userId){
  const result=await queryDatabase('SELECT * FROM provider_payout_accounts WHERE provider_user_id=$1',[userId]);
  if(result){
    const row=result.rows[0];
    return row?{
      providerUserId:row.provider_user_id,provider:row.provider,currencyCode:row.currency_code,
      accountName:row.account_name,bankName:row.bank_name,bankCode:row.bank_code,
      lastFour:row.last_four,status:row.status
    }:null;
  }
  const item=payoutAccounts.get(userId);
  if(!item)return null;
  const {recipientCode,...safe}=item;
  return safe;
}

export async function createOrRefreshPayoutForCompletedAssignment(bookingId,memoryAssignment=null){
  const configuredFee=Number(process.env.SWIFTSERVE_PLATFORM_FEE_BPS||0);
  const feeBps=Number.isInteger(configuredFee)&&configuredFee>=0&&configuredFee<=5000?configuredFee:0;
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query(
      "SELECT a.id AS assignment_id,a.business_id,a.booking_id,a.provider_user_id,b.currency_code,b.status AS booking_status,p.id AS payment_id,p.amount_minor,p.status AS payment_status FROM booking_assignments a JOIN bookings b ON b.id=a.booking_id AND b.business_id=a.business_id LEFT JOIN LATERAL (SELECT id,amount_minor,status FROM payment_intents WHERE booking_id=b.id AND business_id=b.business_id AND status IN ('succeeded','partially_refunded','refunded') ORDER BY paid_at DESC NULLS LAST LIMIT 1) p ON true WHERE a.booking_id=$1 AND a.status='completed' ORDER BY a.completed_at DESC NULLS LAST LIMIT 1 FOR UPDATE OF a,b",
      [bookingId]
    );
    const row=selected.rows[0];
    if(!row)return null;
    const existing=await client.query('SELECT * FROM provider_payouts WHERE booking_assignment_id=$1 FOR UPDATE',[row.assignment_id]);
    const payout=existing.rows[0];
    if(payout&&['processing','paid'].includes(payout.status))return mapPayout(payout);
    if(!row.payment_id||!['succeeded','partially_refunded'].includes(row.payment_status)){
      const blockedStatus=row.payment_status==='refunded'?'on_hold':'awaiting_payment';
      if(payout){
        const updated=await client.query("UPDATE provider_payouts SET status=$2,updated_at=now() WHERE id=$1 RETURNING *",[payout.id,blockedStatus]);
        return mapPayout(updated.rows[0]);
      }
      const inserted=await client.query(
        "INSERT INTO provider_payouts (id,business_id,booking_id,booking_assignment_id,provider_user_id,currency_code,gross_amount_minor,platform_fee_minor,net_amount_minor,status) VALUES ($1,$2,$3,$4,$5,$6,0,0,0,$7) RETURNING *",
        [randomUUID(),row.business_id,row.booking_id,row.assignment_id,row.provider_user_id,row.currency_code,blockedStatus]
      );
      return mapPayout(inserted.rows[0]);
    }
    const refundTotals=await client.query(
      "SELECT COALESCE(SUM(amount_minor),0)::bigint AS amount FROM refunds WHERE payment_intent_id=$1 AND status IN ('pending','processing','processed')",
      [row.payment_id]
    );
    const gross=Math.max(0,Number(row.amount_minor)-Number(refundTotals.rows[0].amount));
    const fee=Math.floor((gross*feeBps)/10000);
    const net=gross-fee;
    const values=[row.business_id,row.booking_id,row.assignment_id,row.provider_user_id,row.payment_id,row.currency_code,gross,fee,net];
    if(payout){
      const updated=await client.query(
        "UPDATE provider_payouts SET payment_intent_id=$2,currency_code=$3,gross_amount_minor=$4,platform_fee_minor=$5,net_amount_minor=$6,status='pending',updated_at=now() WHERE id=$1 RETURNING *",
        [payout.id,...values.slice(4)]
      );
      return mapPayout(updated.rows[0]);
    }
    const inserted=await client.query(
      "INSERT INTO provider_payouts (id,business_id,booking_id,booking_assignment_id,provider_user_id,payment_intent_id,currency_code,gross_amount_minor,platform_fee_minor,net_amount_minor,status) VALUES ($10,$1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') RETURNING *",
      [...values,randomUUID()]
    );
    return mapPayout(inserted.rows[0]);
  });
  if(result!==null)return result;

  const assignment=memoryAssignment;
  if(!assignment)return null;
  const current=[...payouts.values()].find(item=>item.bookingAssignmentId===assignment.id);
  if(current&&['processing','paid','on_hold'].includes(current.status))return current;
  const payment=[...payments.values()].find(item=>item.bookingId===bookingId&&['succeeded','partially_refunded'].includes(item.status));
  const refunded=[...refunds.values()].filter(item=>payment&&item.paymentIntentId===payment.id&&['pending','processing','processed'].includes(item.status)).reduce((sum,item)=>sum+item.amountMinor,0);
  const gross=payment?Math.max(0,payment.amountMinor-refunded):0;
  const fee=Math.floor((gross*feeBps)/10000);
  const payout={
    id:current?.id??randomUUID(),businessId:assignment.businessId,bookingId,
    bookingAssignmentId:assignment.id,providerUserId:assignment.providerUserId,
    paymentIntentId:payment?.id??null,currencyCode:assignment.currencyCode??payment?.currencyCode??'NGN',
    grossAmountMinor:gross,platformFeeMinor:fee,netAmountMinor:gross-fee,
    status:payment?'pending':'awaiting_payment',transferReference:null,
    createdAt:current?.createdAt??new Date().toISOString()
  };
  payouts.set(payout.id,payout);
  return payout;
}

export async function listAdminPayouts(status='pending'){
  const result=await queryDatabase(
    'SELECT p.*,pp.display_name AS provider_display_name,pa.account_name,pa.bank_name,pa.bank_code FROM provider_payouts p JOIN provider_profiles pp ON pp.user_id=p.provider_user_id LEFT JOIN provider_payout_accounts pa ON pa.provider_user_id=p.provider_user_id WHERE ($1::text IS NULL OR p.status=$1) ORDER BY p.created_at',
    [status]
  );
  if(result)return result.rows.map(mapPayout);
  return [...payouts.values()].filter(item=>!status||item.status===status);
}

export async function getPayoutForProcessing(id){
  const result=await queryDatabase(
    'SELECT p.*,pa.recipient_code,pa.currency_code AS account_currency,pa.status AS account_status,pa.account_name,pa.bank_name,pp.display_name AS provider_display_name FROM provider_payouts p JOIN provider_payout_accounts pa ON pa.provider_user_id=p.provider_user_id JOIN provider_profiles pp ON pp.user_id=p.provider_user_id WHERE p.id=$1',
    [id]
  );
  if(result)return result.rows[0]?{payout:mapPayout(result.rows[0]),recipientCode:result.rows[0].recipient_code,accountCurrency:result.rows[0].account_currency,accountStatus:result.rows[0].account_status}:null;
  const payout=payouts.get(id),account=payout?payoutAccounts.get(payout.providerUserId):null;
  if(!payout||!account)return null;
  return {payout,recipientCode:account.recipientCode,accountCurrency:account.currencyCode,accountStatus:account.status};
}

export async function updatePayoutTransfer(id,status,reference,providerTransferId=null,failureReason=null,actorUserId=null){
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query('SELECT status FROM provider_payouts WHERE id=$1 FOR UPDATE',[id]);
    if(!selected.rows[0])return null;
    const transitions={pending:new Set(['pending','processing','failed']),
      failed:new Set(['failed','processing']),
      processing:new Set(['processing','paid','failed']),
      paid:new Set(['paid']),
      awaiting_payment:new Set(['awaiting_payment','pending','on_hold']),
      on_hold:new Set(['on_hold','pending'])};
    if(!transitions[selected.rows[0].status]?.has(status)){
      const existing=await client.query('SELECT * FROM provider_payouts WHERE id=$1',[id]);
      return mapPayout(existing.rows[0]);
    }
    const updated=await client.query(
      "UPDATE provider_payouts SET status=$2,transfer_reference=COALESCE($3,transfer_reference),provider_transfer_id=COALESCE($4,provider_transfer_id),failure_reason=$5,initiated_at=CASE WHEN $2 IN ('processing','paid') THEN COALESCE(initiated_at,now()) ELSE initiated_at END,paid_at=CASE WHEN $2='paid' THEN COALESCE(paid_at,now()) ELSE paid_at END,updated_at=now() WHERE id=$1 RETURNING *",
      [id,status,reference,providerTransferId,failureReason]
    );
    await client.query(
      'INSERT INTO provider_payout_events (payout_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,$3,$4,$5)',
      [id,selected.rows[0].status,status,actorUserId,failureReason]
    );
    return mapPayout(updated.rows[0]);
  });
  if(result!==null)return result;
  const item=payouts.get(id);
  if(!item)return null;
  const transitions={pending:new Set(['pending','processing','failed']),
    failed:new Set(['failed','processing']),
    processing:new Set(['processing','paid','failed']),
    paid:new Set(['paid']),
    awaiting_payment:new Set(['awaiting_payment','pending','on_hold']),
    on_hold:new Set(['on_hold','pending'])};
  if(!transitions[item.status]?.has(status))return item;
  item.status=status;
  if(reference)item.transferReference=reference;
  if(providerTransferId)item.providerTransferId=providerTransferId;
  item.failureReason=failureReason;
  if(status==='paid')item.paidAt=new Date().toISOString();
  payouts.set(id,item);
  return item;
}

export async function updatePayoutByTransferReference(reference,status,transferId=null){
  const result=await queryDatabase('SELECT id FROM provider_payouts WHERE transfer_reference=$1 LIMIT 1',[reference]);
  if(result)return result.rows[0]?updatePayoutTransfer(result.rows[0].id,status,reference,transferId,status==='failed'?'Paystack transfer failed.':null):null;
  const item=[...payouts.values()].find(payout=>payout.transferReference===reference);
  return item?updatePayoutTransfer(item.id,status,reference,transferId,status==='failed'?'Paystack transfer failed.':null):null;
}

export async function listProviderPayouts(providerUserId){
  const result=await queryDatabase('SELECT * FROM provider_payouts WHERE provider_user_id=$1 ORDER BY created_at DESC LIMIT 100',[providerUserId]);
  if(result)return result.rows.map(mapPayout);
  return [...payouts.values()].filter(item=>item.providerUserId===providerUserId);
}

export async function createBookingReview(input){
  const result=await withDatabaseTransaction(async client=>{
    const booking=await client.query(
      "SELECT b.business_id,b.status,a.provider_user_id FROM bookings b LEFT JOIN booking_assignments a ON a.business_id=b.business_id AND a.booking_id=b.id AND a.status='completed' WHERE b.id=$1 AND b.customer_user_id=$2 ORDER BY a.completed_at DESC NULLS LAST LIMIT 1 FOR UPDATE OF b",
      [input.bookingId,input.customerUserId]
    );
    const row=booking.rows[0];
    if(!row||row.status!=='completed')return {error:'Only completed bookings can be reviewed.'};
    const review=await client.query(
      'INSERT INTO booking_reviews (id,business_id,booking_id,customer_user_id,provider_user_id,rating,comment) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [input.id,row.business_id,input.bookingId,input.customerUserId,row.provider_user_id,input.rating,input.comment??null]
    );
    return {review:review.rows[0]};
  });
  if(result){
    if(result.error)return result;
    return {review:mapReview(result.review)};
  }
  if(!input.booking||input.booking.status!=='completed')return {error:'Only completed bookings can be reviewed.'};
  if([...reviews.values()].some(item=>item.bookingId===input.bookingId))return {error:'A review has already been submitted for this booking.'};
  const review={id:input.id,businessId:input.booking.businessId,bookingId:input.bookingId,
    customerUserId:input.customerUserId,providerUserId:input.providerUserId??null,
    rating:input.rating,comment:input.comment??null,status:'published',createdAt:new Date().toISOString()};
  reviews.set(review.id,review);
  return {review};
}

export async function listBusinessReviews(businessId){
  const result=await queryDatabase(
    "SELECT r.*,u.full_name AS customer_name FROM booking_reviews r JOIN users u ON u.id=r.customer_user_id WHERE r.business_id=$1 AND r.status='published' ORDER BY r.created_at DESC LIMIT 100",
    [businessId]
  );
  if(result)return result.rows.map(mapReview);
  return [...reviews.values()].filter(item=>item.businessId===businessId&&item.status==='published');
}

export async function listProviderReviews(providerUserId){
  const result=await queryDatabase(
    "SELECT r.*,u.full_name AS customer_name FROM booking_reviews r JOIN users u ON u.id=r.customer_user_id WHERE r.provider_user_id=$1 AND r.status='published' ORDER BY r.created_at DESC LIMIT 100",
    [providerUserId]
  );
  if(result)return result.rows.map(mapReview);
  return [...reviews.values()].filter(item=>item.providerUserId===providerUserId&&item.status==='published');
}

export async function createDispute(input){
  const result=await withDatabaseTransaction(async client=>{
    const booking=await client.query(
      'SELECT business_id,status,customer_user_id FROM bookings WHERE id=$1 FOR UPDATE',
      [input.bookingId]
    );
    const row=booking.rows[0];
    if(!row||row.business_id!==input.businessId)return {error:'Booking not found.'};
    if(!['confirmed','assigned','in_progress','completed','cancelled','declined'].includes(row.status))
      return {error:'A dispute cannot be opened for this booking status.'};
    const inserted=await client.query(
      'INSERT INTO disputes (id,business_id,booking_id,opened_by_user_id,opened_by_role,category,description,requested_resolution) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [input.id,input.businessId,input.bookingId,input.userId,input.role,input.category,input.description,input.requestedResolution]
    );
    await client.query(
      "INSERT INTO dispute_events (dispute_id,from_status,to_status,actor_user_id,note) VALUES ($1,NULL,'open',$2,'Dispute opened.')",
      [input.id,input.userId]
    );
    await client.query(
      'INSERT INTO dispute_messages (dispute_id,author_user_id,author_role,message) VALUES ($1,$2,$3,$4)',
      [input.id,input.userId,input.role,input.description]
    );
    return {dispute:inserted.rows[0]};
  });
  if(result){
    if(result.error)return result;
    return {dispute:mapDispute(result.dispute)};
  }
  if(!input.booking||input.booking.status==='requested'||input.booking.status==='quoted')return {error:'A dispute cannot be opened for this booking status.'};
  if([...disputes.values()].some(item=>item.bookingId===input.bookingId))return {error:'A dispute already exists for this booking.'};
  const item={id:input.id,businessId:input.businessId,bookingId:input.bookingId,
    openedByUserId:input.userId,customerUserId:input.booking?.customerUserId??null,
    openedByRole:input.role,category:input.category,
    description:input.description,requestedResolution:input.requestedResolution,
    status:'open',resolution:null,resolutionNote:null,createdAt:new Date().toISOString()};
  disputes.set(item.id,item);
  disputeMessages.set(item.id,[{id:randomUUID(),authorUserId:input.userId,authorRole:input.role,message:input.description,createdAt:item.createdAt}]);
  return {dispute:item};
}

export async function getBookingFinancialSummary(businessId,bookingId){
  const result=await queryDatabase(
    'SELECT id,business_id,booking_id,provider_reference,amount_minor,currency_code,status,paid_at,created_at FROM payment_intents WHERE business_id=$1 AND booking_id=$2 ORDER BY created_at DESC',
    [businessId,bookingId]
  );
  if(result)return result.rows.map(row=>({
    id:row.id,businessId:row.business_id,bookingId:row.booking_id,
    reference:row.provider_reference,amountMinor:Number(row.amount_minor),
    currencyCode:row.currency_code,status:row.status,
    paidAt:row.paid_at?new Date(row.paid_at).toISOString():null,
    createdAt:new Date(row.created_at).toISOString()
  }));
  return [...payments.values()].filter(item=>item.businessId===businessId&&item.bookingId===bookingId);
}

export async function listBusinessDisputes(businessId){
  const result=await queryDatabase(
    'SELECT d.*,b.public_reference FROM disputes d JOIN bookings b ON b.id=d.booking_id AND b.business_id=d.business_id WHERE d.business_id=$1 ORDER BY d.created_at DESC LIMIT 100',
    [businessId]
  );
  if(result)return result.rows.map(mapDispute);
  return [...disputes.values()].filter(item=>item.businessId===businessId);
}

export async function hasProviderWebhookEvent(provider,eventKey){
  const result=await queryDatabase(
    'SELECT 1 FROM provider_webhook_events WHERE provider=$1 AND event_key=$2 LIMIT 1',
    [provider,eventKey]
  );
  if(result)return Boolean(result.rows[0]);
  return webhookEvents.has(provider+':'+eventKey);
}

export async function recordProviderWebhookEvent(provider,eventKey,eventType,payloadHash){
  const result=await queryDatabase(
    'INSERT INTO provider_webhook_events (provider,event_key,event_type,payload_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (provider,event_key) DO NOTHING RETURNING event_key',
    [provider,eventKey,eventType,payloadHash]
  );
  if(result)return result.rowCount>0;
  const key=provider+':'+eventKey;
  if(webhookEvents.has(key))return false;
  webhookEvents.set(key,{provider,eventKey,eventType,payloadHash});
  return true;
}

export async function deleteProviderWebhookEvent(provider,eventKey){
  const result=await queryDatabase(
    'DELETE FROM provider_webhook_events WHERE provider=$1 AND event_key=$2 RETURNING event_key',
    [provider,eventKey]
  );
  if(result)return result.rowCount>0;
  return webhookEvents.delete(provider+':'+eventKey);
}

export async function getCustomerDisputeById(userId,id){
  const result=await queryDatabase(
    'SELECT d.* FROM disputes d JOIN bookings b ON b.id=d.booking_id AND b.business_id=d.business_id WHERE b.customer_user_id=$1 AND d.id=$2',
    [userId,id]
  );
  if(result)return result.rows[0]?mapDispute(result.rows[0]):null;
  const item=disputes.get(id);
  if(!item||item.customerUserId!==userId)return null;
  return item;
}

export async function getCustomerDispute(userId,bookingId){
  const result=await queryDatabase(
    'SELECT d.* FROM disputes d JOIN bookings b ON b.id=d.booking_id AND b.business_id=d.business_id WHERE b.customer_user_id=$1 AND d.booking_id=$2',
    [userId,bookingId]
  );
  if(result)return result.rows[0]?mapDispute(result.rows[0]):null;
  const item=[...disputes.values()].find(row=>row.bookingId===bookingId);
  return item&&item.customerUserId===userId?item:null;
}

export async function getBusinessDispute(businessId,bookingId){
  const result=await queryDatabase('SELECT * FROM disputes WHERE business_id=$1 AND booking_id=$2',[businessId,bookingId]);
  if(result)return result.rows[0]?mapDispute(result.rows[0]):null;
  return [...disputes.values()].find(item=>item.businessId===businessId&&item.bookingId===bookingId)||null;
}

export async function addDisputeMessage(input){
  const result=await withDatabaseTransaction(async client=>{
    const dispute=await client.query(
      'SELECT d.*,b.customer_user_id FROM disputes d JOIN bookings b ON b.id=d.booking_id AND b.business_id=d.business_id WHERE d.id=$1 AND d.business_id=$2 FOR UPDATE OF d',
      [input.disputeId,input.businessId]
    );
    const row=dispute.rows[0];
    if(!row||['resolved','rejected'].includes(row.status))return null;
    if(input.role==='customer'&&row.customer_user_id!==input.userId)return null;
    const inserted=await client.query(
      'INSERT INTO dispute_messages (dispute_id,author_user_id,author_role,message) VALUES ($1,$2,$3,$4) RETURNING *',
      [input.disputeId,input.userId,input.role,input.message]
    );
    if(row.status==='open'&&input.role==='business'){
      await client.query("UPDATE disputes SET status='in_review',updated_at=now() WHERE id=$1",[input.disputeId]);
      await client.query("INSERT INTO dispute_events (dispute_id,from_status,to_status,actor_user_id,note) VALUES ($1,'open','in_review',$2,'Business responded to the dispute.')",[input.disputeId,input.userId]);
    }
    return inserted.rows[0];
  });
  if(result!==null)return {
    id:result.id,authorUserId:result.author_user_id,authorRole:result.author_role,
    message:result.message,createdAt:new Date(result.created_at).toISOString()
  };
  const dispute=disputes.get(input.disputeId);
  if(!dispute||dispute.businessId!==input.businessId||['resolved','rejected'].includes(dispute.status))return null;
  if(input.role==='customer'&&dispute.customerUserId!==input.userId)return null;
  const message={id:randomUUID(),authorUserId:input.userId,authorRole:input.role,message:input.message,createdAt:new Date().toISOString()};
  const list=disputeMessages.get(dispute.id)||[];list.push(message);disputeMessages.set(dispute.id,list);
  if(dispute.status==='open'&&input.role==='business')dispute.status='in_review';
  return message;
}

export async function listDisputeMessages(input){
  const result=await queryDatabase(
    'SELECT m.* FROM dispute_messages m JOIN disputes d ON d.id=m.dispute_id WHERE m.dispute_id=$1 AND d.business_id=$2 ORDER BY m.created_at',
    [input.disputeId,input.businessId]
  );
  if(result)return result.rows.map(row=>({
    id:row.id,authorUserId:row.author_user_id,authorRole:row.author_role,
    message:row.message,createdAt:new Date(row.created_at).toISOString()
  }));
  return disputeMessages.get(input.disputeId)||[];
}

export async function listAdminDisputes(status='active'){
  const result=await queryDatabase(
    "SELECT d.*,b.public_reference FROM disputes d JOIN bookings b ON b.id=d.booking_id AND b.business_id=d.business_id WHERE ($1::text IS NULL OR ($1='active' AND d.status IN ('open','in_review')) OR d.status=$1) ORDER BY d.created_at",
    [status]
  );
  if(result)return result.rows.map(mapDispute);
  return [...disputes.values()].filter(item=>!status||(status==='active'?['open','in_review'].includes(item.status):item.status===status));
}

export async function resolveDispute(id,status,resolution,note,adminUserId=null){
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query('SELECT status FROM disputes WHERE id=$1 FOR UPDATE',[id]);
    if(!selected.rows[0]||['resolved','rejected'].includes(selected.rows[0].status))return null;
    const updated=await client.query(
      "UPDATE disputes SET status=$2,resolution=$3,resolution_note=$4,resolved_by_user_id=$5,resolved_at=CASE WHEN $2 IN ('resolved','rejected') THEN now() ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING *",
      [id,status,resolution,note,adminUserId]
    );
    await client.query(
      'INSERT INTO dispute_events (dispute_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,$3,$4,$5)',
      [id,selected.rows[0].status,status,adminUserId,note]
    );
    return updated.rows[0];
  });
  if(result!==null)return result?mapDispute(result):null;
  const item=disputes.get(id);
  if(!item||['resolved','rejected'].includes(item.status))return null;
  item.status=status;item.resolution=resolution;item.resolutionNote=note;
  item.resolvedAt=new Date().toISOString();
  disputes.set(id,item);
  return item;
}
