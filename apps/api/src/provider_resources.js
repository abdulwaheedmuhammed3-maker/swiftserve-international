import { randomUUID } from 'node:crypto';
import { isPlatformAdmin, listBusinessMembers, queryDatabase, withDatabaseTransaction } from './repository.js';
import { createMemoryNotification, getBusinessBooking, updateBusinessBookingStatus } from './marketplace_resources.js';

export const SERVICE_CATEGORIES = new Set([
  'cleaning','laundry','electrical','plumbing','ac-repair','appliance-repair','errand'
]);

const profiles = new Map();
const categories = new Map();
const areas = new Map();
const windows = new Map();
const assignments = new Map();
const assignmentEvents = new Map();

function mapProfile(row) {
  if (!row) return null;
  return {
    userId:row.user_id,displayName:row.display_name,professionalTitle:row.professional_title,
    bio:row.bio,phoneE164:row.phone_e164,countryCode:row.country_code,timeZone:row.time_zone,
    yearsExperience:row.years_experience,profileStatus:row.profile_status,
    verificationStatus:row.verification_status,isAcceptingBookings:row.is_accepting_bookings,
    reviewedByUserId:row.reviewed_by_user_id,
    reviewedAt:row.reviewed_at?new Date(row.reviewed_at).toISOString():null,
    reviewNote:row.review_note,
    createdAt:row.created_at?new Date(row.created_at).toISOString():null,
    updatedAt:row.updated_at?new Date(row.updated_at).toISOString():null
  };
}
function mapArea(row) {
  return {
    id:row.id,providerUserId:row.provider_user_id,countryCode:row.country_code,
    region:row.region,city:row.city,postalCodePrefix:row.postal_code_prefix,isActive:row.is_active
  };
}
function mapWindow(row) {
  return {
    id:row.id,providerUserId:row.provider_user_id,dayOfWeek:row.day_of_week,
    startsAt:row.starts_at,endsAt:row.ends_at
  };
}
function mapAssignment(row) {
  return {
    id:row.id,businessId:row.business_id,bookingId:row.booking_id,
    providerUserId:row.provider_user_id,assignedByUserId:row.assigned_by_user_id,
    status:row.status,offeredStartAt:row.offered_start_at?new Date(row.offered_start_at).toISOString():null,
    offeredEndAt:row.offered_end_at?new Date(row.offered_end_at).toISOString():null,
    assignedAt:row.assigned_at?new Date(row.assigned_at).toISOString():null,
    respondedAt:row.responded_at?new Date(row.responded_at).toISOString():null,
    completedAt:row.completed_at?new Date(row.completed_at).toISOString():null,
    note:row.note,createdAt:row.created_at?new Date(row.created_at).toISOString():null,
    updatedAt:row.updated_at?new Date(row.updated_at).toISOString():null
  };
}
function mapAssignmentRow(row) {
  return {
    ...mapAssignment(row),
    booking:{
      id:row.booking_id,reference:row.public_reference,businessId:row.business_id,
      serviceName:row.service_name_snapshot,serviceCategory:row.service_category_snapshot,
      currencyCode:row.currency_code,
      servicePriceMinor:row.service_price_minor_snapshot===null?null:Number(row.service_price_minor_snapshot),
      serviceAddress:{
        recipientName:row.service_address_recipient,phoneE164:row.service_address_phone,
        countryCode:row.service_country_code,addressLine1:row.service_address_line1,
        addressLine2:row.service_address_line2,city:row.service_city,
        region:row.service_region,postalCode:row.service_postal_code
      },
      requestedStartAt:row.requested_start_at?new Date(row.requested_start_at).toISOString():null,
      requestedEndAt:row.requested_end_at?new Date(row.requested_end_at).toISOString():null,
      status:row.booking_status
    }
  };
}
function pushNotification(userId,type,title,body,bookingId) {
  createMemoryNotification(userId,type,title,body,bookingId);
}
function addAssignmentEvent(item,fromStatus,toStatus,actorUserId,note) {
  const list=assignmentEvents.get(item.id)||[];
  list.push({
    id:randomUUID(),businessId:item.businessId,bookingId:item.bookingId,
    assignmentId:item.id,providerUserId:item.providerUserId,fromStatus,toStatus,
    actorUserId,note,createdAt:new Date().toISOString()
  });
  assignmentEvents.set(item.id,list);
}
function localTime(timestamp,timeZone) {
  const date=new Date(timestamp);
  if(Number.isNaN(date.getTime()))return null;
  try {
    const parts=new Intl.DateTimeFormat('en-US',{
      timeZone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'
    }).formatToParts(date);
    const values=Object.fromEntries(parts.map(p=>[p.type,p.value]));
    const dayMap={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
    if(!(values.weekday in dayMap))return null;
    return {dayOfWeek:dayMap[values.weekday],minutes:Number(values.hour)*60+Number(values.minute)};
  } catch { return null; }
}
function areaCovers(address,area) {
  if(area.isActive===false||area.countryCode!==String(address.countryCode||'').toUpperCase())return false;
  const city=String(address.city||'').trim().toLowerCase();
  const region=String(address.region||'').trim().toLowerCase();
  const postal=String(address.postalCode||'').trim().toLowerCase();
  if(area.city&&area.city.toLowerCase()!==city)return false;
  if(area.region&&(!region||area.region.toLowerCase()!==region))return false;
  if(area.postalCodePrefix&&(!postal||!postal.startsWith(area.postalCodePrefix.toLowerCase())))return false;
  return Boolean(area.city||area.region||area.postalCodePrefix);
}
function timeWindowCovers(profile,available,startAt,endAt) {
  const start=localTime(startAt,profile.timeZone);
  const end=localTime(endAt,profile.timeZone);
  if(!start||!end||start.dayOfWeek!==end.dayOfWeek||end.minutes<=start.minutes)return false;
  return available.some(item=>{
    if(item.dayOfWeek!==start.dayOfWeek)return false;
    const open=Number(String(item.startsAt).slice(0,2))*60+Number(String(item.startsAt).slice(3,5));
    const close=Number(String(item.endsAt).slice(0,2))*60+Number(String(item.endsAt).slice(3,5));
    return open<=start.minutes&&close>=end.minutes;
  });
}
function offeredWindow(booking,input,durationMinutes=null) {
  const start=new Date(input.offeredStartAt||booking.confirmedStartAt||booking.confirmed_start_at||booking.requestedStartAt||booking.requested_start_at);
  let endValue=input.offeredEndAt||booking.confirmedEndAt||booking.confirmed_end_at||booking.requestedEndAt||booking.requested_end_at;
  if(!endValue&&Number.isInteger(durationMinutes)&&durationMinutes>0)endValue=new Date(start.getTime()+durationMinutes*60000);
  const end=endValue?new Date(endValue):null;
  if(Number.isNaN(start.getTime())||!end||Number.isNaN(end.getTime())||end<=start)return null;
  return {start,end};
}
async function checkEligibility(client,booking,providerUserId,window) {
  const profileResult=await client.query(
    "SELECT * FROM provider_profiles WHERE user_id=$1 AND profile_status='active' AND verification_status='verified' AND is_accepting_bookings=true FOR UPDATE",
    [providerUserId]
  );
  const profileRow=profileResult.rows[0];
  if(!profileRow)return {error:'PROVIDER_NOT_VERIFIED',message:'Provider must be active, verified and accepting bookings.'};
  const profile=mapProfile(profileRow);
  const skill=await client.query(
    'SELECT 1 FROM provider_service_categories WHERE provider_user_id=$1 AND category=$2 LIMIT 1',
    [providerUserId,booking.service_category_snapshot]
  );
  if(!skill.rowCount)return {error:'PROVIDER_SKILL_MISMATCH',message:'Provider has not listed the service category.'};
  const areaRows=await client.query(
    'SELECT * FROM provider_service_areas WHERE provider_user_id=$1 AND is_active=true',
    [providerUserId]
  );
  const address={
    countryCode:booking.service_country_code,city:booking.service_city,
    region:booking.service_region,postalCode:booking.service_postal_code
  };
  if(!areaRows.rows.some(row=>areaCovers(address,mapArea(row))))return {error:'PROVIDER_OUT_OF_AREA',message:'Provider has not listed coverage for this service address.'};
  const availability=await client.query(
    'SELECT * FROM provider_availability_windows WHERE provider_user_id=$1',
    [providerUserId]
  );
  if(!timeWindowCovers(profile,availability.rows.map(mapWindow),window.start,window.end))return {error:'PROVIDER_NOT_AVAILABLE',message:'The offered time is outside provider weekly availability.'};
  const conflict=await client.query(
    "SELECT 1 FROM booking_assignments WHERE provider_user_id=$1 AND status IN ('offered','accepted','in_progress') AND offered_start_at < $3 AND offered_end_at > $2 LIMIT 1",
    [providerUserId,window.start.toISOString(),window.end.toISOString()]
  );
  if(conflict.rowCount)return {error:'PROVIDER_TIME_CONFLICT',message:'Provider already has an active assignment during this time.'};
  return {profile};
}

export async function getProviderProfile(userId) {
  const result=await queryDatabase('SELECT * FROM provider_profiles WHERE user_id=$1 LIMIT 1',[userId]);
  if(result) {
    const profile=result.rows[0]?mapProfile(result.rows[0]):null;
    return profile?{...profile,serviceCategories:await listProviderCategories(userId)}:null;
  }
  const profile=profiles.get(userId);
  return profile?{...profile,serviceCategories:[...(categories.get(userId)||[])]}:null;
}

export async function upsertProviderProfile(userId,input) {
  const result=await withDatabaseTransaction(async client=>{
    const account=await client.query(
      "SELECT id FROM users WHERE id=$1 AND account_type='provider' AND status='active' FOR UPDATE",[userId]
    );
    if(!account.rows[0])return {error:'PROVIDER_ACCOUNT_REQUIRED'};
    const currentResult=await client.query('SELECT * FROM provider_profiles WHERE user_id=$1 FOR UPDATE',[userId]);
    const current=currentResult.rows[0];
    const changed=Boolean(current&&(current.phone_e164!==input.phoneE164||current.country_code!==input.countryCode||current.time_zone!==input.timeZone));
    const saved=await client.query(
      "INSERT INTO provider_profiles (user_id,display_name,professional_title,bio,phone_e164,country_code,time_zone,years_experience) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id) DO UPDATE SET display_name=EXCLUDED.display_name,professional_title=EXCLUDED.professional_title,bio=EXCLUDED.bio,phone_e164=EXCLUDED.phone_e164,country_code=EXCLUDED.country_code,time_zone=EXCLUDED.time_zone,years_experience=EXCLUDED.years_experience,profile_status=CASE WHEN $9 THEN 'submitted' ELSE provider_profiles.profile_status END,verification_status=CASE WHEN $9 THEN 'pending' ELSE provider_profiles.verification_status END,is_accepting_bookings=CASE WHEN $9 THEN false ELSE provider_profiles.is_accepting_bookings END,reviewed_by_user_id=CASE WHEN $9 THEN NULL ELSE provider_profiles.reviewed_by_user_id END,reviewed_at=CASE WHEN $9 THEN NULL ELSE provider_profiles.reviewed_at END,review_note=CASE WHEN $9 THEN NULL ELSE provider_profiles.review_note END,updated_at=now() RETURNING *",
      [userId,input.displayName,input.professionalTitle??null,input.bio??null,input.phoneE164,input.countryCode,input.timeZone,input.yearsExperience??null,changed]
    );
    return {profile:saved.rows[0]};
  });
  if(result) {
    if(result.error)return result;
    return mapProfile(result.profile);
  }
  const old=profiles.get(userId);
  const changed=Boolean(old&&(old.phoneE164!==input.phoneE164||old.countryCode!==input.countryCode||old.timeZone!==input.timeZone));
  const profile={
    userId,...input,profileStatus:changed?'submitted':old?.profileStatus||'draft',
    verificationStatus:changed?'pending':old?.verificationStatus||'not_started',
    isAcceptingBookings:changed?false:old?.isAcceptingBookings||false,
    reviewedByUserId:changed?null:old?.reviewedByUserId||null,
    reviewedAt:changed?null:old?.reviewedAt||null,reviewNote:changed?null:old?.reviewNote||null,
    createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()
  };
  profiles.set(userId,profile);
  return profile;
}

export async function listProviderCategories(userId) {
  const result=await queryDatabase('SELECT category FROM provider_service_categories WHERE provider_user_id=$1 ORDER BY category',[userId]);
  if(result)return result.rows.map(row=>row.category);
  return [...(categories.get(userId)||[])].sort();
}

export async function replaceProviderCategories(userId,items) {
  const result=await withDatabaseTransaction(async client=>{
    const profile=await client.query('SELECT user_id FROM provider_profiles WHERE user_id=$1 FOR UPDATE',[userId]);
    if(!profile.rows[0])return {error:'PROVIDER_PROFILE_REQUIRED'};
    await client.query('DELETE FROM provider_service_categories WHERE provider_user_id=$1',[userId]);
    for(const category of items)await client.query('INSERT INTO provider_service_categories (provider_user_id,category) VALUES ($1,$2)',[userId,category]);
    return {items};
  });
  if(result)return result.error?result:result.items;
  categories.set(userId,new Set(items));
  return items;
}

export async function listProviderAreas(userId) {
  const result=await queryDatabase('SELECT * FROM provider_service_areas WHERE provider_user_id=$1 ORDER BY country_code,city,region',[userId]);
  if(result)return result.rows.map(mapArea);
  return (areas.get(userId)||[]).map(item=>({...item}));
}

export async function createProviderArea(userId,input) {
  const result=await queryDatabase(
    'INSERT INTO provider_service_areas (id,provider_user_id,country_code,region,city,postal_code_prefix,is_active) VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING *',
    [randomUUID(),userId,input.countryCode,input.region??null,input.city??null,input.postalCodePrefix??null]
  );
  if(result)return mapArea(result.rows[0]);
  const item={id:randomUUID(),providerUserId:userId,...input,isActive:true};
  const list=areas.get(userId)||[];list.push(item);areas.set(userId,list);
  return item;
}

export async function deleteProviderArea(userId,id) {
  const result=await queryDatabase('DELETE FROM provider_service_areas WHERE id=$1 AND provider_user_id=$2',[id,userId]);
  if(result)return result.rowCount>0;
  const list=areas.get(userId)||[],next=list.filter(item=>item.id!==id);
  if(next.length===list.length)return false;
  areas.set(userId,next);return true;
}

export async function listProviderAvailability(userId) {
  const result=await queryDatabase('SELECT * FROM provider_availability_windows WHERE provider_user_id=$1 ORDER BY day_of_week,starts_at',[userId]);
  if(result)return result.rows.map(mapWindow);
  return (windows.get(userId)||[]).map(item=>({...item}));
}

export async function replaceProviderAvailability(userId,items) {
  const result=await withDatabaseTransaction(async client=>{
    const profile=await client.query('SELECT user_id FROM provider_profiles WHERE user_id=$1 FOR UPDATE',[userId]);
    if(!profile.rows[0])return {error:'PROVIDER_PROFILE_REQUIRED'};
    await client.query('DELETE FROM provider_availability_windows WHERE provider_user_id=$1',[userId]);
    const saved=[];
    for(const item of items) {
      const row=await client.query(
        'INSERT INTO provider_availability_windows (id,provider_user_id,day_of_week,starts_at,ends_at) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [randomUUID(),userId,item.dayOfWeek,item.startsAt,item.endsAt]
      );
      saved.push(mapWindow(row.rows[0]));
    }
    return {items:saved};
  });
  if(result)return result.error?result:result.items;
  const saved=items.map(item=>({id:randomUUID(),providerUserId:userId,...item}));
  windows.set(userId,saved);return saved;
}

export async function submitProviderProfile(userId) {
  const result=await withDatabaseTransaction(async client=>{
    const profile=await client.query('SELECT * FROM provider_profiles WHERE user_id=$1 FOR UPDATE',[userId]);
    if(!profile.rows[0])return {error:'PROVIDER_PROFILE_REQUIRED'};
    const skill=await client.query('SELECT 1 FROM provider_service_categories WHERE provider_user_id=$1 LIMIT 1',[userId]);
    const area=await client.query('SELECT 1 FROM provider_service_areas WHERE provider_user_id=$1 AND is_active=true LIMIT 1',[userId]);
    const schedule=await client.query('SELECT 1 FROM provider_availability_windows WHERE provider_user_id=$1 LIMIT 1',[userId]);
    if(!skill.rowCount||!area.rowCount||!schedule.rowCount)return {error:'PROVIDER_PROFILE_INCOMPLETE'};
    const updated=await client.query(
      "UPDATE provider_profiles SET profile_status='submitted',verification_status='pending',is_accepting_bookings=false,reviewed_by_user_id=NULL,reviewed_at=NULL,review_note=NULL,updated_at=now() WHERE user_id=$1 RETURNING *",[userId]
    );
    return {profile:updated.rows[0]};
  });
  if(result)return result.error?result:mapProfile(result.profile);
  const profile=profiles.get(userId);
  if(!profile)return {error:'PROVIDER_PROFILE_REQUIRED'};
  if(!(categories.get(userId)?.size)||!(areas.get(userId)?.length)||!(windows.get(userId)?.length))return {error:'PROVIDER_PROFILE_INCOMPLETE'};
  profile.profileStatus='submitted';profile.verificationStatus='pending';profile.isAcceptingBookings=false;
  profiles.set(userId,profile);return profile;
}

export async function listProvidersForReview(status='submitted') {
  const result=await queryDatabase(
    'SELECT p.*,u.email,u.full_name FROM provider_profiles p JOIN users u ON u.id=p.user_id WHERE p.profile_status=$1 ORDER BY p.created_at ASC',[status]
  );
  if(result)return result.rows.map(row=>({...mapProfile(row),email:row.email,accountFullName:row.full_name}));
  return [...profiles.values()].filter(item=>item.profileStatus===status).map(item=>({...item,email:null,accountFullName:null}));
}

export async function reviewProvider(userId,adminUserId,verificationStatus,note=null) {
  const result=await queryDatabase(
    "UPDATE provider_profiles SET verification_status=$2,profile_status=CASE WHEN $2='verified' THEN 'active' ELSE 'rejected' END,is_accepting_bookings=false,reviewed_by_user_id=$3,reviewed_at=now(),review_note=$4,updated_at=now() WHERE user_id=$1 AND profile_status='submitted' AND verification_status='pending' RETURNING *",
    [userId,verificationStatus,adminUserId,note]
  );
  if(result)return result.rows[0]?mapProfile(result.rows[0]):null;
  const profile=profiles.get(userId);
  if(!profile||profile.profileStatus!=='submitted'||profile.verificationStatus!=='pending')return null;
  profile.verificationStatus=verificationStatus;profile.profileStatus=verificationStatus==='verified'?'active':'rejected';
  profile.isAcceptingBookings=false;profile.reviewedByUserId=adminUserId;profile.reviewedAt=new Date().toISOString();profile.reviewNote=note;
  profiles.set(userId,profile);return profile;
}

export async function setProviderAcceptingBookings(userId,enabled) {
  const result=await queryDatabase(
    "UPDATE provider_profiles SET is_accepting_bookings=$2,updated_at=now() WHERE user_id=$1 AND profile_status='active' AND verification_status='verified' RETURNING *",[userId,enabled]
  );
  if(result)return result.rows[0]?mapProfile(result.rows[0]):null;
  const profile=profiles.get(userId);
  if(!profile||profile.profileStatus!=='active'||profile.verificationStatus!=='verified')return null;
  profile.isAcceptingBookings=enabled;profiles.set(userId,profile);return profile;
}

export async function assignProviderToBooking(businessId,bookingId,providerUserId,assignedByUserId,input) {
  const result=await withDatabaseTransaction(async client=>{
    const bookingResult=await client.query(
      'SELECT b.*,bs.duration_minutes FROM bookings b LEFT JOIN business_services bs ON bs.id=b.service_id AND bs.business_id=b.business_id WHERE b.business_id=$1 AND b.id=$2 FOR UPDATE OF b',
      [businessId,bookingId]
    );
    const booking=bookingResult.rows[0];
    if(!booking)return {error:'BOOKING_NOT_FOUND'};
    if(booking.status!=='confirmed'||booking.current_assignment_id)return {error:'BOOKING_NOT_ASSIGNABLE'};
    const start=new Date(input.offeredStartAt||booking.confirmed_start_at||booking.requested_start_at);
    let endValue=input.offeredEndAt||booking.confirmed_end_at||booking.requested_end_at;
    if(!endValue&&Number.isInteger(booking.duration_minutes)&&booking.duration_minutes>0)endValue=new Date(start.getTime()+booking.duration_minutes*60000);
    const end=endValue?new Date(endValue):null;
    if(Number.isNaN(start.getTime())||!end||Number.isNaN(end.getTime())||end<=start)return {error:'BOOKING_WINDOW_REQUIRED'};
    const eligibility=await checkEligibility(client,booking,providerUserId,{start,end});
    if(eligibility.error)return eligibility;
    const id=randomUUID();
    const inserted=await client.query(
      "INSERT INTO booking_assignments (id,business_id,booking_id,provider_user_id,assigned_by_user_id,status,offered_start_at,offered_end_at,note) VALUES ($1,$2,$3,$4,$5,'offered',$6,$7,$8) RETURNING *",
      [id,businessId,bookingId,providerUserId,assignedByUserId,start.toISOString(),end.toISOString(),input.note??null]
    );
    await client.query("UPDATE bookings SET status='assigned',current_assignment_id=$3,updated_at=now() WHERE business_id=$1 AND id=$2",[businessId,bookingId,id]);
    await client.query("INSERT INTO booking_status_events (business_id,booking_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,'confirmed','assigned',$3,$4)",[businessId,bookingId,assignedByUserId,'Provider assignment offered.']);
    await client.query("INSERT INTO booking_assignment_events (business_id,booking_id,assignment_id,provider_user_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,$3,$4,NULL,'offered',$5,$6)",[businessId,bookingId,id,providerUserId,assignedByUserId,input.note??null]);
    await client.query("INSERT INTO notifications (user_id,notification_type,title,body,resource_type,resource_id) VALUES ($1,'provider_assignment','New work assignment','A business has offered you a service booking.','booking',$2)",[providerUserId,bookingId]);
    return {assignment:inserted.rows[0]};
  });
  if(result)return result.error?result:mapAssignment(result.assignment);

  const booking=await getBusinessBooking(businessId,bookingId);
  if(!booking)return {error:'BOOKING_NOT_FOUND'};
  if(booking.status!=='confirmed'||booking.currentAssignmentId)return {error:'BOOKING_NOT_ASSIGNABLE'};
  const profile=profiles.get(providerUserId);
  if(!profile||profile.profileStatus!=='active'||profile.verificationStatus!=='verified'||!profile.isAcceptingBookings)return {error:'PROVIDER_NOT_VERIFIED',message:'Provider must be active, verified and accepting bookings.'};
  if(!(categories.get(providerUserId)||new Set()).has(booking.serviceCategory))return {error:'PROVIDER_SKILL_MISMATCH',message:'Provider has not listed the service category.'};
  if(!(areas.get(providerUserId)||[]).some(area=>areaCovers(booking.serviceAddress,area)))return {error:'PROVIDER_OUT_OF_AREA',message:'Provider has not listed coverage for this service address.'};
  const start=new Date(input.offeredStartAt||booking.confirmedStartAt||booking.requestedStartAt);
  const endValue=input.offeredEndAt||booking.confirmedEndAt||booking.requestedEndAt;
  const end=endValue?new Date(endValue):null;
  if(!end||!timeWindowCovers(profile,windows.get(providerUserId)||[],start,end))return {error:'PROVIDER_NOT_AVAILABLE',message:'The offered time is outside availability or has no defined end time.'};
  for(const item of assignments.values())if(item.providerUserId===providerUserId&&['offered','accepted','in_progress'].includes(item.status)&&new Date(item.offeredStartAt)<end&&new Date(item.offeredEndAt)>start)return {error:'PROVIDER_TIME_CONFLICT',message:'Provider already has an active assignment during this time.'};
  const changed=await updateBusinessBookingStatus(businessId,bookingId,assignedByUserId,'assigned','Provider assignment offered.');
  if(!changed)return {error:'BOOKING_NOT_ASSIGNABLE'};
  const assignment={id:randomUUID(),businessId,bookingId,providerUserId,assignedByUserId,status:'offered',offeredStartAt:start.toISOString(),offeredEndAt:end.toISOString(),assignedAt:new Date().toISOString(),respondedAt:null,completedAt:null,note:input.note??null};
  assignments.set(assignment.id,assignment);changed.currentAssignmentId=assignment.id;
  addAssignmentEvent(assignment,null,'offered',assignedByUserId,input.note??null);
  pushNotification(providerUserId,'provider_assignment','New work assignment','A business has offered you a service booking.',bookingId);
  return assignment;
}

export async function listProviderAssignments(providerUserId,status=null) {
  const result=await queryDatabase(
    "SELECT a.*,b.public_reference,b.service_name_snapshot,b.service_category_snapshot,b.currency_code,b.service_price_minor_snapshot,b.service_address_recipient,b.service_address_phone,b.service_country_code,b.service_address_line1,b.service_address_line2,b.service_city,b.service_region,b.service_postal_code,b.requested_start_at,b.requested_end_at,b.status AS booking_status FROM booking_assignments a JOIN bookings b ON b.id=a.booking_id AND b.business_id=a.business_id WHERE a.provider_user_id=$1 AND ($2::text IS NULL OR a.status=$2) ORDER BY a.assigned_at DESC",
    [providerUserId,status]
  );
  if(result)return result.rows.map(mapAssignmentRow);
  const list=[...assignments.values()].filter(item=>item.providerUserId===providerUserId&&(!status||item.status===status)).sort((a,b)=>b.assignedAt.localeCompare(a.assignedAt));
  const output=[];
  for(const item of list){
    const booking=await getBusinessBooking(item.businessId,item.bookingId);
    output.push({...item,booking});
  }
  return output;
}

export async function getProviderAssignment(providerUserId,assignmentId) {
  const result=await queryDatabase(
    "SELECT a.*,b.public_reference,b.service_name_snapshot,b.service_category_snapshot,b.currency_code,b.service_price_minor_snapshot,b.service_address_recipient,b.service_address_phone,b.service_country_code,b.service_address_line1,b.service_address_line2,b.service_city,b.service_region,b.service_postal_code,b.requested_start_at,b.requested_end_at,b.status AS booking_status FROM booking_assignments a JOIN bookings b ON b.id=a.booking_id AND b.business_id=a.business_id WHERE a.id=$1 AND a.provider_user_id=$2 LIMIT 1",
    [assignmentId,providerUserId]
  );
  if(result)return result.rows[0]?mapAssignmentRow(result.rows[0]):null;
  const item=assignments.get(assignmentId);
  if(!item||item.providerUserId!==providerUserId)return null;
  const booking=await getBusinessBooking(item.businessId,item.bookingId);
  return {...item,booking};
}

export async function respondToProviderAssignment(providerUserId,assignmentId,action,note=null) {
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query(
      'SELECT a.*,b.status AS booking_status,b.current_assignment_id FROM booking_assignments a JOIN bookings b ON b.id=a.booking_id AND b.business_id=a.business_id WHERE a.id=$1 AND a.provider_user_id=$2 FOR UPDATE OF a,b',
      [assignmentId,providerUserId]
    );
    const row=selected.rows[0];
    if(!row)return {error:'ASSIGNMENT_NOT_FOUND'};
    let nextAssignment,nextBooking=row.booking_status;
    if(action==='accept'&&row.status==='offered'&&row.current_assignment_id===assignmentId)nextAssignment='accepted';
    else if(action==='decline'&&row.status==='offered'&&row.current_assignment_id===assignmentId){nextAssignment='declined';nextBooking='confirmed';}
    else if(action==='in_progress'&&row.status==='accepted'&&row.current_assignment_id===assignmentId&&row.booking_status==='assigned'){nextAssignment='in_progress';nextBooking='in_progress';}
    else if(action==='completed'&&row.status==='in_progress'&&row.current_assignment_id===assignmentId&&row.booking_status==='in_progress'){nextAssignment='completed';nextBooking='completed';}
    else if(action==='cancelled'&&['offered','accepted'].includes(row.status)&&row.current_assignment_id===assignmentId){nextAssignment='cancelled';nextBooking='confirmed';}
    else return {error:'INVALID_ASSIGNMENT_TRANSITION'};

    const updated=await client.query(
      "UPDATE booking_assignments SET status=$2,responded_at=CASE WHEN $2 IN ('accepted','declined') THEN now() ELSE responded_at END,completed_at=CASE WHEN $2='completed' THEN now() ELSE completed_at END,note=COALESCE($3,note),updated_at=now() WHERE id=$1 RETURNING *",
      [assignmentId,nextAssignment,note]
    );
    if(nextBooking!==row.booking_status||nextBooking==='confirmed'){
      await client.query('UPDATE bookings SET status=$3,current_assignment_id=$4,updated_at=now() WHERE business_id=$1 AND id=$2',[row.business_id,row.booking_id,nextBooking,nextBooking==='confirmed'?null:assignmentId]);
      await client.query('INSERT INTO booking_status_events (business_id,booking_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,$3,$4,$5,$6)',[row.business_id,row.booking_id,row.booking_status,nextBooking,providerUserId,note||('Provider '+action+' the assignment.')]);
    }
    await client.query('INSERT INTO booking_assignment_events (business_id,booking_id,assignment_id,provider_user_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[row.business_id,row.booking_id,assignmentId,providerUserId,row.status,nextAssignment,providerUserId,note]);
    if(action==='in_progress'||action==='completed'){
      await client.query("INSERT INTO notifications (user_id,notification_type,title,body,resource_type,resource_id) SELECT customer_user_id,'booking_status','Booking update',$3,'booking',id FROM bookings WHERE id=$1 AND business_id=$2",[row.booking_id,row.business_id,action==='completed'?'Your service has been completed.':'Your provider has started work.']);
    }else{
      await client.query("INSERT INTO notifications (user_id,notification_type,title,body,resource_type,resource_id) SELECT bm.user_id,'provider_assignment_response','Provider assignment update',$3,'booking',$1 FROM business_memberships bm WHERE bm.business_id=$2 AND bm.status='active'",[row.booking_id,row.business_id,'The provider has '+action+' the assignment.']);
    }
    return {assignment:updated.rows[0],bookingStatus:nextBooking};
  });
  if(result)return result.error?result:{assignment:mapAssignment(result.assignment),bookingStatus:result.bookingStatus};

  const assignment=assignments.get(assignmentId);
  if(!assignment||assignment.providerUserId!==providerUserId)return {error:'ASSIGNMENT_NOT_FOUND'};
  const booking=await getBusinessBooking(assignment.businessId,assignment.bookingId);
  if(!booking||booking.currentAssignmentId!==assignmentId)return {error:'INVALID_ASSIGNMENT_TRANSITION'};
  let nextAssignment,nextBooking=booking.status;
  if(action==='accept'&&assignment.status==='offered')nextAssignment='accepted';
  else if(action==='decline'&&assignment.status==='offered'){nextAssignment='declined';nextBooking='confirmed';}
  else if(action==='in_progress'&&assignment.status==='accepted'&&booking.status==='assigned'){nextAssignment='in_progress';nextBooking='in_progress';}
  else if(action==='completed'&&assignment.status==='in_progress'&&booking.status==='in_progress'){nextAssignment='completed';nextBooking='completed';}
  else if(action==='cancelled'&&['offered','accepted'].includes(assignment.status)){nextAssignment='cancelled';nextBooking='confirmed';}
  else return {error:'INVALID_ASSIGNMENT_TRANSITION'};
  const previous=assignment.status;
  assignment.status=nextAssignment;assignment.respondedAt=['accepted','declined'].includes(nextAssignment)?new Date().toISOString():assignment.respondedAt;
  assignment.completedAt=nextAssignment==='completed'?new Date().toISOString():assignment.completedAt;
  assignment.note=note||assignment.note;assignment.updatedAt=new Date().toISOString();assignments.set(assignmentId,assignment);
  if(nextBooking!==booking.status||nextBooking==='confirmed'){
    await updateBusinessBookingStatus(assignment.businessId,assignment.bookingId,providerUserId,nextBooking,note||('Provider '+action+' the assignment.'));
    const refreshed=await getBusinessBooking(assignment.businessId,assignment.bookingId);
    if(refreshed)refreshed.currentAssignmentId=nextBooking==='confirmed'?null:assignmentId;
  }
  addAssignmentEvent(assignment,previous,nextAssignment,providerUserId,note);
  if(action==='in_progress'||action==='completed')pushNotification(booking.customerUserId,'booking_status','Booking update',action==='completed'?'Your service has been completed.':'Your provider has started work.',booking.id);
  else for(const member of await listBusinessMembers(assignment.businessId))pushNotification(member.userId,'provider_assignment_response','Provider assignment update','The provider has '+action+' the assignment.',booking.id);
  return {assignment,bookingStatus:nextBooking};
}

export async function cancelBusinessAssignment(businessId,bookingId,assignmentId,actorUserId,note=null) {
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query(
      'SELECT a.*,b.status AS booking_status,b.current_assignment_id FROM booking_assignments a JOIN bookings b ON b.id=a.booking_id AND b.business_id=a.business_id WHERE a.id=$1 AND a.business_id=$2 AND a.booking_id=$3 FOR UPDATE OF a,b',
      [assignmentId,businessId,bookingId]
    );
    const row=selected.rows[0];
    if(!row)return {error:'ASSIGNMENT_NOT_FOUND'};
    if(!['offered','accepted'].includes(row.status)||row.current_assignment_id!==assignmentId)return {error:'ASSIGNMENT_NOT_CANCELLABLE'};
    const updated=await client.query(
      "UPDATE booking_assignments SET status='cancelled',note=COALESCE($2,note),updated_at=now() WHERE id=$1 RETURNING *",
      [assignmentId,note]
    );
    await client.query(
      "UPDATE bookings SET status='confirmed',current_assignment_id=NULL,updated_at=now() WHERE business_id=$1 AND id=$2",
      [businessId,bookingId]
    );
    await client.query(
      "INSERT INTO booking_status_events (business_id,booking_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,'assigned','confirmed',$3,$4)",
      [businessId,bookingId,actorUserId,note||'Business cancelled provider assignment.']
    );
    await client.query(
      "INSERT INTO booking_assignment_events (business_id,booking_id,assignment_id,provider_user_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,$3,$4,$5,'cancelled',$6,$7)",
      [businessId,bookingId,assignmentId,row.provider_user_id,row.status,actorUserId,note]
    );
    await client.query(
      "INSERT INTO notifications (user_id,notification_type,title,body,resource_type,resource_id) VALUES ($1,'provider_assignment_cancelled','Assignment cancelled','The business has cancelled your booking assignment.','booking',$2)",
      [row.provider_user_id,bookingId]
    );
    return {assignment:updated.rows[0]};
  });
  if(result)return result.error?result:mapAssignment(result.assignment);

  const assignment=assignments.get(assignmentId);
  if(!assignment||assignment.businessId!==businessId||assignment.bookingId!==bookingId)return {error:'ASSIGNMENT_NOT_FOUND'};
  if(!['offered','accepted'].includes(assignment.status))return {error:'ASSIGNMENT_NOT_CANCELLABLE'};
  const booking=await getBusinessBooking(businessId,bookingId);
  if(!booking||booking.currentAssignmentId!==assignmentId)return {error:'ASSIGNMENT_NOT_CANCELLABLE'};
  const previous=assignment.status;
  assignment.status='cancelled';
  assignment.note=note||assignment.note;
  assignment.updatedAt=new Date().toISOString();
  assignments.set(assignmentId,assignment);
  await updateBusinessBookingStatus(businessId,bookingId,actorUserId,'confirmed',note||'Business cancelled provider assignment.');
  const refreshed=await getBusinessBooking(businessId,bookingId);
  if(refreshed)refreshed.currentAssignmentId=null;
  addAssignmentEvent(assignment,previous,'cancelled',actorUserId,note);
  pushNotification(assignment.providerUserId,'provider_assignment_cancelled','Assignment cancelled','The business has cancelled your booking assignment.',bookingId);
  return assignment;
}

export async function listBusinessAssignments(businessId,bookingId) {
  const result=await queryDatabase(
    'SELECT a.*,b.public_reference,b.service_name_snapshot,b.service_category_snapshot,b.currency_code,b.service_price_minor_snapshot,b.service_address_recipient,b.service_address_phone,b.service_country_code,b.service_address_line1,b.service_address_line2,b.service_city,b.service_region,b.service_postal_code,b.requested_start_at,b.requested_end_at,b.status AS booking_status,p.display_name AS provider_display_name FROM booking_assignments a JOIN bookings b ON b.id=a.booking_id AND b.business_id=a.business_id JOIN provider_profiles p ON p.user_id=a.provider_user_id WHERE a.business_id=$1 AND a.booking_id=$2 ORDER BY a.assigned_at DESC',
    [businessId,bookingId]
  );
  if(result)return result.rows.map(row=>({...mapAssignmentRow(row),providerDisplayName:row.provider_display_name}));
  return [...assignments.values()].filter(item=>item.businessId===businessId&&item.bookingId===bookingId).map(item=>({...item,providerDisplayName:profiles.get(item.providerUserId)?.displayName||null}));
}

export async function listProviderAssignmentEvents(providerUserId,assignmentId) {
  const result=await queryDatabase(
    'SELECT e.* FROM booking_assignment_events e JOIN booking_assignments a ON a.id=e.assignment_id AND a.business_id=e.business_id WHERE e.assignment_id=$1 AND a.provider_user_id=$2 ORDER BY e.created_at ASC',
    [assignmentId,providerUserId]
  );
  if(result)return result.rows.map(row=>({
    id:row.id,businessId:row.business_id,bookingId:row.booking_id,assignmentId:row.assignment_id,
    providerUserId:row.provider_user_id,fromStatus:row.from_status,toStatus:row.to_status,
    actorUserId:row.actor_user_id,note:row.note,createdAt:new Date(row.created_at).toISOString()
  }));
  return assignmentEvents.get(assignmentId)||[];
}

export async function listBusinessAssignmentEvents(businessId,assignmentId) {
  const result=await queryDatabase(
    'SELECT * FROM booking_assignment_events WHERE business_id=$1 AND assignment_id=$2 ORDER BY created_at ASC',
    [businessId,assignmentId]
  );
  if(result)return result.rows.map(row=>({
    id:row.id,businessId:row.business_id,bookingId:row.booking_id,assignmentId:row.assignment_id,
    providerUserId:row.provider_user_id,fromStatus:row.from_status,toStatus:row.to_status,
    actorUserId:row.actor_user_id,note:row.note,createdAt:new Date(row.created_at).toISOString()
  }));
  return assignmentEvents.get(assignmentId)||[];
}

export async function isCurrentPlatformAdmin(userId) {
  return isPlatformAdmin(userId);
}
