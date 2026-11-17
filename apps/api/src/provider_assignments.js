import { randomUUID } from 'node:crypto';
import { queryDatabase, withDatabaseTransaction } from './repository.js';
import { getProviderAssignmentReadiness } from './provider_resources.js';

const assignments=new Map();

function mapAssignment(row){
  return {
    id:row.id,businessId:row.business_id,bookingId:row.booking_id,
    providerUserId:row.provider_user_id,assignedByUserId:row.assigned_by_user_id,
    status:row.status,scheduledStartAt:new Date(row.scheduled_start_at).toISOString(),
    scheduledEndAt:new Date(row.scheduled_end_at).toISOString(),
    providerNote:row.provider_note,responseNote:row.response_note,
    respondedAt:row.responded_at?new Date(row.responded_at).toISOString():null,
    startedAt:row.started_at?new Date(row.started_at).toISOString():null,
    completedAt:row.completed_at?new Date(row.completed_at).toISOString():null,
    createdAt:row.created_at?new Date(row.created_at).toISOString():null,
    booking:row.public_reference?{
      reference:row.public_reference,serviceName:row.service_name_snapshot,
      serviceCategory:row.service_category_snapshot,customerName:row.customer_name,
      serviceAddress:{
        recipientName:row.service_address_recipient,phoneE164:row.service_address_phone,
        countryCode:row.service_country_code,addressLine1:row.service_address_line1,
        addressLine2:row.service_address_line2,city:row.service_city,
        region:row.service_region,postalCode:row.service_postal_code
      },
      customerNotes:row.customer_notes,status:row.booking_status
    }:undefined
  };
}

function publicMemoryAssignment(item){
  const {bookingRef,...safe}=item;
  return safe;
}

function localTime(timestamp,timeZone){
  const parts=new Intl.DateTimeFormat('en-GB',{
    timeZone,weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23'
  }).formatToParts(new Date(timestamp));
  const item=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  const days={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
  return {
    day:days[item.weekday],
    date:item.year+'-'+item.month+'-'+item.day,
    time:item.hour+':'+item.minute
  };
}

export async function assignBookingToProvider(input){
  const {businessId,booking,providerUserId,assignedByUserId,scheduledStartAt,scheduledEndAt,providerNote}=input;
  const id=randomUUID();
  const result=await withDatabaseTransaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[providerUserId]);
    const selected=await client.query(
      'SELECT status,service_category_snapshot,service_country_code,service_city,service_region,service_postal_code FROM bookings WHERE id=$1 AND business_id=$2 FOR UPDATE',
      [booking.id,businessId]
    );
    const row=selected.rows[0];
    if(!row||row.status!=='confirmed')return {error:'Only confirmed bookings can be assigned.'};

    const provider=await client.query(
      "SELECT p.time_zone,p.verification_status,p.onboarding_status,bp.id AS membership_id FROM provider_profiles p JOIN business_provider_memberships bp ON bp.provider_user_id=p.user_id WHERE p.user_id=$1 AND bp.business_id=$2 AND bp.status='active' FOR UPDATE OF p,bp",
      [providerUserId,businessId]
    );
    const profile=provider.rows[0];
    if(!profile)return {error:'This provider is not an active member of this business.'};
    if(profile.verification_status!=='verified'||profile.onboarding_status!=='active')
      return {error:'Only verified and active providers can receive assignments.'};

    const skill=await client.query(
      'SELECT 1 FROM provider_skills WHERE provider_user_id=$1 AND category=$2 AND is_active=true LIMIT 1',
      [providerUserId,row.service_category_snapshot]
    );
    if(!skill.rows[0])return {error:'The provider does not list the required service skill.'};

    const area=await client.query(
      "SELECT 1 FROM provider_service_areas WHERE provider_user_id=$1 AND is_active=true AND country_code=$2 AND (city IS NULL OR lower(city)=lower($3)) AND (region IS NULL OR lower(region)=lower(coalesce($4,''))) AND (postal_code_prefix IS NULL OR left(lower(coalesce($5,'')),length(postal_code_prefix))=lower(postal_code_prefix)) LIMIT 1",
      [providerUserId,row.service_country_code,row.service_city,row.service_region,row.service_postal_code||'']
    );
    if(!area.rows[0])return {error:'The provider does not cover the booking address.'};

    const slot=await client.query(
      "SELECT av.opens_at::text AS opens_at,av.closes_at::text AS closes_at,to_char($2::timestamptz AT TIME ZONE p.time_zone,'YYYY-MM-DD') AS start_date,to_char($3::timestamptz AT TIME ZONE p.time_zone,'YYYY-MM-DD') AS end_date,to_char($2::timestamptz AT TIME ZONE p.time_zone,'HH24:MI') AS start_time,to_char($3::timestamptz AT TIME ZONE p.time_zone,'HH24:MI') AS end_time FROM provider_availability av JOIN provider_profiles p ON p.user_id=av.provider_user_id WHERE av.provider_user_id=$1 AND av.is_available=true AND av.day_of_week=EXTRACT(DOW FROM ($2::timestamptz AT TIME ZONE p.time_zone))::int LIMIT 1",
      [providerUserId,scheduledStartAt,scheduledEndAt]
    );
    const window=slot.rows[0];
    if(!window||window.start_date!==window.end_date||window.start_time<window.opens_at.slice(0,5)||window.end_time>window.closes_at.slice(0,5))
      return {error:'The assignment is outside the provider availability window.'};

    const conflict=await client.query(
      "SELECT 1 FROM booking_assignments WHERE provider_user_id=$1 AND status IN ('offered','accepted') AND scheduled_start_at<$3 AND scheduled_end_at>$2 LIMIT 1",
      [providerUserId,scheduledStartAt,scheduledEndAt]
    );
    if(conflict.rows[0])return {error:'The provider already has an assignment during this time.'};

    const inserted=await client.query(
      "INSERT INTO booking_assignments (id,business_id,booking_id,provider_user_id,membership_id,assigned_by_user_id,status,scheduled_start_at,scheduled_end_at,provider_note) VALUES ($1,$2,$3,$4,$5,$6,'offered',$7,$8,$9) RETURNING *",
      [id,businessId,booking.id,providerUserId,profile.membership_id,assignedByUserId,scheduledStartAt,scheduledEndAt,providerNote??null]
    );
    await client.query(
      "UPDATE bookings SET status='assigned',confirmed_start_at=$3,confirmed_end_at=$4,updated_at=now() WHERE id=$1 AND business_id=$2",
      [booking.id,businessId,scheduledStartAt,scheduledEndAt]
    );
    await client.query(
      "INSERT INTO booking_status_events (business_id,booking_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,'confirmed','assigned',$3,'Business offered the booking to a provider.')",
      [businessId,booking.id,assignedByUserId]
    );
    await client.query(
      "INSERT INTO notifications (user_id,notification_type,title,body,resource_type,resource_id) VALUES ($1,'provider_assignment','New job assignment','A business has offered you a household-service job.','booking',$2)",
      [providerUserId,booking.id]
    );
    return {row:inserted.rows[0]};
  });
  if(result){
    if(result.error)return {error:result.error};
    return {assignment:mapAssignment(result.row)};
  }

  if(!booking||booking.status!=='confirmed')return {error:'Only confirmed bookings can be assigned.'};
  const readiness=await getProviderAssignmentReadiness(providerUserId,businessId,booking.serviceCategory,booking.serviceAddress);
  if(readiness.error)return {error:readiness.error};
  let start,end;
  try{
    start=localTime(scheduledStartAt,readiness.timeZone||'UTC');
    end=localTime(scheduledEndAt,readiness.timeZone||'UTC');
  }catch{
    return {error:'Provider time zone is invalid.'};
  }
  const schedule=readiness.availability.find(item=>item.dayOfWeek===start.day&&item.isAvailable);
  if(!schedule||start.date!==end.date||start.time<String(schedule.opensAt).slice(0,5)||end.time>String(schedule.closesAt).slice(0,5))
    return {error:'The assignment is outside the provider availability window.'};
  const conflict=[...assignments.values()].some(item=>
    item.providerUserId===providerUserId&&['offered','accepted'].includes(item.status)&&
    new Date(item.scheduledStartAt)<new Date(scheduledEndAt)&&new Date(item.scheduledEndAt)>new Date(scheduledStartAt)
  );
  if(conflict)return {error:'The provider already has an assignment during this time.'};
  const assignment={
    id,businessId,bookingId:booking.id,providerUserId,assignedByUserId,status:'offered',
    scheduledStartAt,scheduledEndAt,providerNote:providerNote??null,
    createdAt:new Date().toISOString(),bookingRef:booking
  };
  assignments.set(id,assignment);
  booking.status='assigned';
  booking.confirmedStartAt=scheduledStartAt;
  booking.confirmedEndAt=scheduledEndAt;
  return {assignment:publicMemoryAssignment(assignment)};
}

const assignmentSelect=
  'SELECT a.*,b.public_reference,b.service_name_snapshot,b.service_category_snapshot,b.service_address_recipient,b.service_address_phone,b.service_country_code,b.service_address_line1,b.service_address_line2,b.service_city,b.service_region,b.service_postal_code,b.customer_notes,b.status AS booking_status,u.full_name AS customer_name '+
  'FROM booking_assignments a JOIN bookings b ON b.id=a.booking_id AND b.business_id=a.business_id JOIN users u ON u.id=b.customer_user_id ';

export async function listBusinessAssignments(businessId,bookingId){
  const result=await queryDatabase(assignmentSelect+'WHERE a.business_id=$1 AND a.booking_id=$2 ORDER BY a.created_at DESC',[businessId,bookingId]);
  if(result)return result.rows.map(mapAssignment);
  return [...assignments.values()].filter(item=>item.businessId===businessId&&item.bookingId===bookingId).map(publicMemoryAssignment);
}

export async function listProviderAssignments(providerUserId){
  const result=await queryDatabase(assignmentSelect+'WHERE a.provider_user_id=$1 ORDER BY a.scheduled_start_at DESC',[providerUserId]);
  if(result)return result.rows.map(mapAssignment);
  return [...assignments.values()].filter(item=>item.providerUserId===providerUserId).map(publicMemoryAssignment);
}

export async function getProviderAssignment(providerUserId,bookingId){
  const result=await queryDatabase(assignmentSelect+"WHERE a.provider_user_id=$1 AND a.booking_id=$2 AND a.status IN ('offered','accepted') ORDER BY a.created_at DESC LIMIT 1",[providerUserId,bookingId]);
  if(result)return result.rows[0]?mapAssignment(result.rows[0]):null;
  const item=[...assignments.values()].find(row=>row.providerUserId===providerUserId&&row.bookingId===bookingId&&['offered','accepted'].includes(row.status));
  return item?publicMemoryAssignment(item):null;
}

export async function respondProviderAssignment(providerUserId,bookingId,action,note=null){
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query(
      "SELECT a.id,a.business_id FROM booking_assignments a WHERE a.provider_user_id=$1 AND a.booking_id=$2 AND a.status='offered' FOR UPDATE",
      [providerUserId,bookingId]
    );
    const row=selected.rows[0];
    if(!row)return null;
    const next=action==='accept'?'accepted':'declined';
    await client.query(
      'UPDATE booking_assignments SET status=$2,response_note=$3,responded_at=now(),updated_at=now() WHERE id=$1',
      [row.id,next,note]
    );
    if(action==='decline'){
      await client.query("UPDATE bookings SET status='confirmed',updated_at=now() WHERE id=$1 AND business_id=$2 AND status='assigned'",[bookingId,row.business_id]);
      await client.query("INSERT INTO booking_status_events (business_id,booking_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,'assigned','confirmed',$3,'Provider declined the assignment.')",[row.business_id,bookingId,providerUserId]);
    }
    await client.query(
      "INSERT INTO notifications (user_id,notification_type,title,body,resource_type,resource_id) SELECT bm.user_id,'provider_assignment_response','Provider response','A provider has responded to a booking assignment.','booking',$1 FROM business_memberships bm WHERE bm.business_id=$2 AND bm.status='active'",
      [bookingId,row.business_id]
    );
    return {status:next};
  });
  if(result!==null)return result;
  const item=[...assignments.values()].find(row=>row.providerUserId===providerUserId&&row.bookingId===bookingId&&row.status==='offered');
  if(!item)return null;
  item.status=action==='accept'?'accepted':'declined';
  item.responseNote=note;
  item.respondedAt=new Date().toISOString();
  if(action==='decline'&&item.bookingRef)item.bookingRef.status='confirmed';
  assignments.set(item.id,item);
  return {status:item.status};
}

export async function updateProviderBookingStatus(providerUserId,bookingId,nextStatus,note=null){
  if(!['in_progress','completed'].includes(nextStatus))return null;
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query(
      "SELECT a.id,a.business_id,b.status AS booking_status FROM booking_assignments a JOIN bookings b ON b.id=a.booking_id AND b.business_id=a.business_id WHERE a.provider_user_id=$1 AND a.booking_id=$2 AND a.status='accepted' FOR UPDATE OF a,b",
      [providerUserId,bookingId]
    );
    const row=selected.rows[0];
    if(!row)return null;
    if(nextStatus==='in_progress'&&row.booking_status!=='assigned')return {invalid:true};
    if(nextStatus==='completed'&&row.booking_status!=='in_progress')return {invalid:true};
    if(nextStatus==='in_progress'){
      await client.query("UPDATE bookings SET status='in_progress',updated_at=now() WHERE id=$1 AND business_id=$2",[bookingId,row.business_id]);
      await client.query("UPDATE booking_assignments SET started_at=now(),updated_at=now() WHERE id=$1",[row.id]);
    }else{
      await client.query("UPDATE bookings SET status='completed',updated_at=now() WHERE id=$1 AND business_id=$2",[bookingId,row.business_id]);
      await client.query("UPDATE booking_assignments SET status='completed',completed_at=now(),response_note=$2,updated_at=now() WHERE id=$1",[row.id,note]);
    }
    await client.query('INSERT INTO booking_status_events (business_id,booking_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,$3,$4,$5,$6)',[row.business_id,bookingId,row.booking_status,nextStatus,providerUserId,note]);
    await client.query("INSERT INTO notifications (user_id,notification_type,title,body,resource_type,resource_id) SELECT customer_user_id,'provider_booking_update','Service progress update','Your service booking is now ' || $3 || '.','booking',id FROM bookings WHERE id=$1 AND business_id=$2",[bookingId,row.business_id,nextStatus]);
    return {status:nextStatus};
  });
  if(result!==null)return result.invalid?null:result;
  const item=[...assignments.values()].find(row=>row.providerUserId===providerUserId&&row.bookingId===bookingId&&row.status==='accepted');
  if(!item||!item.bookingRef)return null;
  const booking=item.bookingRef;
  if(nextStatus==='in_progress'&&booking.status==='assigned'){
    booking.status='in_progress';item.startedAt=new Date().toISOString();
  }else if(nextStatus==='completed'&&booking.status==='in_progress'){
    booking.status='completed';item.status='completed';item.completedAt=new Date().toISOString();item.responseNote=note;
  }else return null;
  assignments.set(item.id,item);
  return {status:nextStatus};
}

export async function cancelBookingAssignment(businessId,bookingId,assignmentId){
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query("SELECT id,status FROM booking_assignments WHERE id=$1 AND business_id=$2 AND booking_id=$3 AND status IN ('offered','accepted') FOR UPDATE",[assignmentId,businessId,bookingId]);
    const row=selected.rows[0];
    if(!row)return false;
    await client.query("UPDATE booking_assignments SET status='cancelled',updated_at=now() WHERE id=$1",[assignmentId]);
    await client.query("UPDATE bookings SET status='confirmed',updated_at=now() WHERE id=$1 AND business_id=$2 AND status='assigned'",[bookingId,businessId]);
    await client.query("INSERT INTO booking_status_events (business_id,booking_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,'assigned','confirmed',NULL,'Business cancelled provider assignment.')",[businessId,bookingId]);
    return true;
  });
  if(result!==null)return result;
  const item=assignments.get(assignmentId);
  if(!item||item.businessId!==businessId||item.bookingId!==bookingId||!['offered','accepted'].includes(item.status))return false;
  item.status='cancelled';
  if(item.bookingRef)item.bookingRef.status='confirmed';
  assignments.set(assignmentId,item);
  return true;
}
