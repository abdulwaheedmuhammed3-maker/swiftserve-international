import { randomUUID } from 'node:crypto';
import { queryDatabase, withDatabaseTransaction } from './repository.js';
import { getCustomerBooking, getBusinessBooking } from './marketplace_resources.js';

const reviews=new Map();
const reviewResponses=new Map();
const disputes=new Map();
const disputeMessages=new Map();

function mapReview(row){
  return {
    id:row.id,businessId:row.business_id,bookingId:row.booking_id,
    customerUserId:row.customer_user_id,customerName:row.customer_name,
    providerUserId:row.provider_user_id,businessRating:row.business_rating,
    providerRating:row.provider_rating,reviewText:row.review_text,
    status:row.status,createdAt:row.created_at?new Date(row.created_at).toISOString():null,
    updatedAt:row.updated_at?new Date(row.updated_at).toISOString():null,
    response:row.response_id?{
      id:row.response_id,text:row.response_text,
      responderUserId:row.responder_user_id,
      createdAt:new Date(row.response_created_at).toISOString()
    }:null
  };
}

function mapDispute(row){
  return {
    id:row.id,businessId:row.business_id,bookingId:row.booking_id,
    openedByUserId:row.opened_by_user_id,openedByName:row.opened_by_name,
    disputeCategory:row.dispute_category,description:row.description,
    status:row.status,resolutionNote:row.resolution_note,
    assignedAdminId:row.assigned_admin_id,resolvedByUserId:row.resolved_by_user_id,
    resolvedAt:row.resolved_at?new Date(row.resolved_at).toISOString():null,
    createdAt:row.created_at?new Date(row.created_at).toISOString():null,
    updatedAt:row.updated_at?new Date(row.updated_at).toISOString():null
  };
}

function mapMessage(row){
  return {
    id:row.id,disputeId:row.dispute_id,senderUserId:row.sender_user_id,
    senderName:row.sender_name,message:row.message,visibility:row.visibility,
    createdAt:row.created_at?new Date(row.created_at).toISOString():null
  };
}

export async function createServiceReview(userId,bookingId,input){
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query(
      "SELECT b.business_id,b.status,(SELECT a.provider_user_id FROM booking_assignments a WHERE a.booking_id=b.id AND a.business_id=b.business_id AND a.status='completed' ORDER BY a.completed_at DESC LIMIT 1) AS provider_user_id FROM bookings b WHERE b.id=$1 AND b.customer_user_id=$2 FOR UPDATE",
      [bookingId,userId]
    );
    const booking=selected.rows[0];
    if(!booking)return {missing:true};
    if(booking.status!=='completed')return {notCompleted:true};
    const inserted=await client.query(
      "INSERT INTO service_reviews (id,business_id,booking_id,customer_user_id,provider_user_id,business_rating,provider_rating,review_text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [randomUUID(),booking.business_id,bookingId,userId,booking.provider_user_id,input.businessRating,input.providerRating??null,input.reviewText??null]
    );
    return {review:inserted.rows[0]};
  });
  if(result!==null){
    if(result.missing)return {error:'Booking not found.'};
    if(result.notCompleted)return {error:'A review can only be submitted after a booking is completed.'};
    const item=await getReviewByBooking(userId,bookingId);
    return {review:item};
  }
  const booking=await getCustomerBooking(userId,bookingId);
  if(!booking)return {error:'Booking not found.'};
  if(booking.status!=='completed')return {error:'A review can only be submitted after a booking is completed.'};
  const id=randomUUID();
  const review={
    id,businessId:booking.businessId,bookingId,customerUserId:userId,
    customerName:null,providerUserId:null,businessRating:input.businessRating,
    providerRating:input.providerRating??null,reviewText:input.reviewText??null,
    status:'published',createdAt:new Date().toISOString()
  };
  reviews.set(id,review);
  return {review};
}

export async function getReviewByBooking(userId,bookingId){
  const result=await queryDatabase(
    "SELECT r.*,u.full_name AS customer_name,rr.id AS response_id,rr.response_text,rr.responder_user_id,rr.created_at AS response_created_at FROM service_reviews r JOIN users u ON u.id=r.customer_user_id LEFT JOIN service_review_responses rr ON rr.review_id=r.id WHERE r.booking_id=$1 AND r.customer_user_id=$2 LIMIT 1",
    [bookingId,userId]
  );
  if(result)return result.rows[0]?mapReview(result.rows[0]):null;
  return [...reviews.values()].find(item=>item.bookingId===bookingId&&item.customerUserId===userId)||null;
}

export async function listBusinessReviews(businessId){
  const result=await queryDatabase(
    "SELECT r.*,u.full_name AS customer_name,rr.id AS response_id,rr.response_text,rr.responder_user_id,rr.created_at AS response_created_at FROM service_reviews r JOIN users u ON u.id=r.customer_user_id LEFT JOIN service_review_responses rr ON rr.review_id=r.id WHERE r.business_id=$1 AND r.status='published' ORDER BY r.created_at DESC",
    [businessId]
  );
  if(result)return result.rows.map(mapReview);
  return [...reviews.values()].filter(item=>item.businessId===businessId&&item.status==='published');
}

export async function createBusinessReviewResponse(userId,businessId,reviewId,responseText){
  const result=await queryDatabase(
    "INSERT INTO service_review_responses (id,review_id,business_id,responder_user_id,response_text) SELECT $1,r.id,r.business_id,$2,$4 FROM service_reviews r WHERE r.id=$3 AND r.business_id=$5 AND r.status='published' ON CONFLICT (review_id) DO UPDATE SET responder_user_id=EXCLUDED.responder_user_id,response_text=EXCLUDED.response_text,updated_at=now() RETURNING *",
    [randomUUID(),userId,reviewId,responseText,businessId]
  );
  if(result)return result.rows[0]?{
    id:result.rows[0].id,reviewId:result.rows[0].review_id,text:result.rows[0].response_text,
    responderUserId:result.rows[0].responder_user_id
  }:null;
  const review=reviews.get(reviewId);
  if(!review||review.businessId!==businessId||review.status!=='published')return null;
  const existing=reviewResponses.get(reviewId);
  const response={id:existing?.id??randomUUID(),reviewId,businessId,responderUserId:userId,
    text:responseText,createdAt:new Date().toISOString()};
  reviewResponses.set(reviewId,response);
  review.response=response;
  return response;
}

export async function createServiceDispute(userId,bookingId,input){
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query(
      "SELECT business_id,status FROM bookings WHERE id=$1 AND customer_user_id=$2 FOR UPDATE",
      [bookingId,userId]
    );
    const booking=selected.rows[0];
    if(!booking)return {missing:true};
    if(!['confirmed','assigned','in_progress','completed'].includes(booking.status))return {ineligible:true};
    const inserted=await client.query(
      "INSERT INTO service_disputes (id,business_id,booking_id,opened_by_user_id,dispute_category,description) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [randomUUID(),booking.business_id,bookingId,userId,input.category,input.description]
    );
    await client.query(
      "INSERT INTO service_dispute_messages (id,dispute_id,sender_user_id,message,visibility) VALUES ($1,$2,$3,$4,'participants')",
      [randomUUID(),inserted.rows[0].id,userId,input.description]
    );
    await client.query(
      "INSERT INTO notifications (user_id,notification_type,title,body,resource_type,resource_id) SELECT bm.user_id,'service_dispute','New service dispute','A customer opened a dispute for a booking.','dispute',$1 FROM business_memberships bm WHERE bm.business_id=$2 AND bm.status='active'",
      [inserted.rows[0].id,booking.business_id]
    );
    return {id:inserted.rows[0].id};
  });
  if(result!==null){
    if(result.missing)return {error:'Booking not found.'};
    if(result.ineligible)return {error:'A dispute can only be opened for a confirmed, assigned, in-progress or completed booking.'};
    return {dispute:await getServiceDispute(result.id)};
  }
  const booking=await getCustomerBooking(userId,bookingId);
  if(!booking)return {error:'Booking not found.'};
  if(!['confirmed','assigned','in_progress','completed'].includes(booking.status))
    return {error:'A dispute can only be opened for a confirmed, assigned, in-progress or completed booking.'};
  if([...disputes.values()].some(item=>item.bookingId===bookingId))return {error:'A dispute already exists for this booking.'};
  const id=randomUUID();
  const dispute={
    id,businessId:booking.businessId,bookingId,openedByUserId:userId,
    disputeCategory:input.category,description:input.description,status:'open',
    createdAt:new Date().toISOString()
  };
  disputes.set(id,dispute);
  disputeMessages.set(id,[{
    id:randomUUID(),disputeId:id,senderUserId:userId,
    message:input.description,visibility:'participants',createdAt:new Date().toISOString()
  }]);
  return {dispute};
}

export async function getCustomerDispute(userId,disputeId){
  const result=await queryDatabase(
    "SELECT d.*,u.full_name AS opened_by_name FROM service_disputes d JOIN users u ON u.id=d.opened_by_user_id WHERE d.id=$1 AND d.opened_by_user_id=$2 LIMIT 1",
    [disputeId,userId]
  );
  if(result)return result.rows[0]?mapDispute(result.rows[0]):null;
  const item=disputes.get(disputeId);
  return item&&item.openedByUserId===userId?item:null;
}

export async function getBusinessDispute(businessId,disputeId){
  const result=await queryDatabase(
    "SELECT d.*,u.full_name AS opened_by_name FROM service_disputes d JOIN users u ON u.id=d.opened_by_user_id WHERE d.id=$1 AND d.business_id=$2 LIMIT 1",
    [disputeId,businessId]
  );
  if(result)return result.rows[0]?mapDispute(result.rows[0]):null;
  const item=disputes.get(disputeId);
  return item&&item.businessId===businessId?item:null;
}

export async function getServiceDispute(disputeId){
  const result=await queryDatabase(
    'SELECT d.*,u.full_name AS opened_by_name FROM service_disputes d JOIN users u ON u.id=d.opened_by_user_id WHERE d.id=$1 LIMIT 1',
    [disputeId]
  );
  if(result)return result.rows[0]?mapDispute(result.rows[0]):null;
  return disputes.get(disputeId)||null;
}

export async function listCustomerDisputes(userId){
  const result=await queryDatabase(
    'SELECT d.*,u.full_name AS opened_by_name FROM service_disputes d JOIN users u ON u.id=d.opened_by_user_id WHERE d.opened_by_user_id=$1 ORDER BY d.created_at DESC',
    [userId]
  );
  if(result)return result.rows.map(mapDispute);
  return [...disputes.values()].filter(item=>item.openedByUserId===userId);
}

export async function listBusinessDisputes(businessId){
  const result=await queryDatabase(
    'SELECT d.*,u.full_name AS opened_by_name FROM service_disputes d JOIN users u ON u.id=d.opened_by_user_id WHERE d.business_id=$1 ORDER BY d.created_at DESC',
    [businessId]
  );
  if(result)return result.rows.map(mapDispute);
  return [...disputes.values()].filter(item=>item.businessId===businessId);
}

export async function listDisputeMessages(disputeId,includeAdmin=false){
  const result=await queryDatabase(
    "SELECT m.*,u.full_name AS sender_name FROM service_dispute_messages m JOIN users u ON u.id=m.sender_user_id WHERE m.dispute_id=$1 AND ($2::boolean=true OR m.visibility='participants') ORDER BY m.created_at ASC",
    [disputeId,includeAdmin]
  );
  if(result)return result.rows.map(mapMessage);
  return (disputeMessages.get(disputeId)||[]).filter(item=>includeAdmin||item.visibility==='participants');
}

export async function addDisputeMessage(userId,disputeId,message,visibility='participants',newStatus=null){
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query(
      'SELECT id,status FROM service_disputes WHERE id=$1 FOR UPDATE',
      [disputeId]
    );
    const dispute=selected.rows[0];
    if(!dispute)return null;
    if(['resolved_customer','resolved_business','closed'].includes(dispute.status))return {closed:true};
    const inserted=await client.query(
      'INSERT INTO service_dispute_messages (id,dispute_id,sender_user_id,message,visibility) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [randomUUID(),disputeId,userId,message,visibility]
    );
    const nextStatus=newStatus||dispute.status;
    if(nextStatus!==dispute.status){
      await client.query('UPDATE service_disputes SET status=$2,updated_at=now() WHERE id=$1',[disputeId,nextStatus]);
    }
    await client.query(
      "INSERT INTO notifications (user_id,notification_type,title,body,resource_type,resource_id) SELECT CASE WHEN $2::uuid=d.opened_by_user_id THEN u.id ELSE d.opened_by_user_id END,'service_dispute_message','Dispute update','A new message was added to your service dispute.','dispute',$1 FROM service_disputes d JOIN business_memberships bm ON bm.business_id=d.business_id JOIN users u ON u.id=bm.user_id WHERE d.id=$1 AND bm.status='active' LIMIT 1",
      [disputeId,userId]
    );
    return {message:inserted.rows[0]};
  });
  if(result!==null){
    if(result.closed)return {error:'This dispute is already closed.'};
    if(!result.message)return null;
    return {id:result.message.id,disputeId:result.message.dispute_id,senderUserId:result.message.sender_user_id,
      message:result.message.message,visibility:result.message.visibility,
      createdAt:new Date(result.message.created_at).toISOString()};
  }
  const dispute=disputes.get(disputeId);
  if(!dispute)return null;
  if(['resolved_customer','resolved_business','closed'].includes(dispute.status))return {error:'This dispute is already closed.'};
  const item={id:randomUUID(),disputeId,senderUserId:userId,message,visibility,createdAt:new Date().toISOString()};
  const messages=disputeMessages.get(disputeId)||[];
  messages.push(item);
  disputeMessages.set(disputeId,messages);
  if(newStatus)dispute.status=newStatus;
  disputes.set(disputeId,dispute);
  return item;
}

export async function resolveServiceDispute(disputeId,status,note,adminUserId=null){
  const result=await withDatabaseTransaction(async client=>{
    const current=await client.query('SELECT id,status FROM service_disputes WHERE id=$1 FOR UPDATE',[disputeId]);
    if(!current.rows[0])return null;
    if(['resolved_customer','resolved_business','closed'].includes(current.rows[0].status))return {closed:true};
    const updated=await client.query(
      'UPDATE service_disputes SET status=$2,resolution_note=$3,assigned_admin_id=$4,resolved_by_user_id=$4,resolved_at=now(),updated_at=now() WHERE id=$1 RETURNING *',
      [disputeId,status,note??null,adminUserId]
    );
    return {row:updated.rows[0]};
  });
  if(result!==null)return result.closed?{error:'Dispute is already resolved.'}:result.row?mapDispute(result.row):null;
  const dispute=disputes.get(disputeId);
  if(!dispute)return null;
  if(['resolved_customer','resolved_business','closed'].includes(dispute.status))return {error:'Dispute is already resolved.'};
  const updated={...dispute,status,resolutionNote:note??null,resolvedByUserId:adminUserId,resolvedAt:new Date().toISOString()};
  disputes.set(disputeId,updated);
  return updated;
}
