import { randomUUID } from 'node:crypto';
import { listBusinessMembers, queryDatabase, withDatabaseTransaction } from './repository.js';
import { getBusinessBooking, notifyUser } from './marketplace_resources.js';

const profiles = new Map();
const categories = new Map();
const areas = new Map();
const availability = new Map();
const assignments = new Map();
const assignmentEvents = new Map();

function mapProfile(row) {
  return {
    userId:row.user_id, displayName:row.display_name, phoneE164:row.phone_e164,
    bio:row.bio, countryCode:row.country_code, timeZone:row.time_zone,
    yearsExperience:row.years_experience, languages:row.languages||['en'],
    status:row.status, reviewNote:row.review_note,
    submittedAt:row.submitted_at?new Date(row.submitted_at).toISOString():null,
    reviewedAt:row.reviewed_at?new Date(row.reviewed_at).toISOString():null,
    reviewedByUserId:row.reviewed_by_user_id,
    createdAt:row.created_at?new Date(row.created_at).toISOString():null,
    updatedAt:row.updated_at?new Date(row.updated_at).toISOString():null
  };
}

function mapArea(row) {
  return {id:row.id,countryCode:row.country_code??row.countryCode,
    region:row.region??null,city:row.city??null,
    postalCodePrefix:row.postal_code_prefix??row.postalCodePrefix??null,
    isActive:row.is_active??row.isActive??true};
}

function mapWindow(row) {
  const time=value=>typeof value==='string'?value.slice(0,5):value;
  return {id:row.id,dayOfWeek:row.day_of_week??row.dayOfWeek,
    startsAt:time(row.starts_at??row.startsAt),endsAt:time(row.ends_at??row.endsAt)};
}

function mapAssignment(row) {
  return {
    id:row.assignment_id??row.id,businessId:row.business_id??row.businessId,
    bookingId:row.booking_id??row.bookingId,providerUserId:row.provider_user_id??row.providerUserId,
    assignedByUserId:row.assigned_by_user_id??row.assignedByUserId,
    status:row.assignment_status??row.status,
    scheduledStartAt:new Date(row.scheduled_start_at??row.scheduledStartAt).toISOString(),
    scheduledEndAt:new Date(row.scheduled_end_at??row.scheduledEndAt).toISOString(),
    offeredAt:row.offered_at?new Date(row.offered_at).toISOString():row.offeredAt??null,
    respondedAt:row.responded_at?new Date(row.responded_at).toISOString():row.respondedAt??null,
    startedAt:row.started_at?new Date(row.started_at).toISOString():row.startedAt??null,
    completedAt:row.completed_at?new Date(row.completed_at).toISOString():row.completedAt??null,
    booking:row.service_name_snapshot?{
      reference:row.public_reference,serviceName:row.service_name_snapshot,
      serviceCategory:row.service_category_snapshot,currencyCode:row.currency_code,
      serviceAddress:{
        recipientName:row.service_address_recipient,phoneE164:row.service_address_phone,
        countryCode:row.service_country_code,addressLine1:row.service_address_line1,
        addressLine2:row.service_address_line2,city:row.service_city,
        region:row.service_region,postalCode:row.service_postal_code
      },customerNotes:row.customer_notes
    }:row.booking??undefined
  };
}

function localScheduleParts(value,timeZone) {
  const parts=new Intl.DateTimeFormat('en-GB',{
    timeZone,year:'numeric',month:'2-digit',day:'2-digit',
    weekday:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
  }).formatToParts(new Date(value));
  const v=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  const days={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
  return {date:v.year+'-'+v.month+'-'+v.day,dayOfWeek:days[v.weekday],time:v.hour+':'+v.minute+':'+v.second};
}

function covered(address,list) {
  return list.some(area=>{
    if (!area.isActive||area.countryCode!==address.countryCode) return false;
    if (area.city&&area.city.toLowerCase()!==String(address.city||'').toLowerCase()) return false;
    if (area.region&&area.region.toLowerCase()!==String(address.region||'').toLowerCase()) return false;
    if (area.postalCodePrefix&&!String(address.postalCode||'').toLowerCase().startsWith(area.postalCodePrefix.toLowerCase())) return false;
    return Boolean(area.city||area.region||area.postalCodePrefix);
  });
}

export async function getProviderProfile(userId) {
  const result=await queryDatabase('SELECT * FROM provider_profiles WHERE user_id=$1 LIMIT 1',[userId]);
  if (result) {
    if (!result.rows[0]) return null;
    const profile=mapProfile(result.rows[0]);
    const [skills,serviceAreas,windows]=await Promise.all([
      queryDatabase('SELECT category FROM provider_service_categories WHERE provider_user_id=$1 ORDER BY category',[userId]),
      queryDatabase('SELECT * FROM provider_service_areas WHERE provider_user_id=$1 ORDER BY country_code,city,region',[userId]),
      queryDatabase('SELECT * FROM provider_availability WHERE provider_user_id=$1 ORDER BY day_of_week,starts_at',[userId])
    ]);
    return {...profile,
      serviceCategories:skills?.rows.map(row=>row.category)||[],
      serviceAreas:serviceAreas?.rows.map(mapArea)||[],
      availability:windows?.rows.map(mapWindow)||[]};
  }
  const profile=profiles.get(userId);
  if (!profile) return null;
  return {...profile,serviceCategories:categories.get(userId)||[],
    serviceAreas:areas.get(userId)||[],availability:availability.get(userId)||[]};
}

export async function saveProviderProfile(userId,input) {
  const current=await getProviderProfile(userId);
  const merged={...(current||{}),...input,userId};
  const result=await queryDatabase(
    "INSERT INTO provider_profiles (user_id,display_name,phone_e164,bio,country_code,time_zone,years_experience,languages,status) " +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) " +
    "ON CONFLICT (user_id) DO UPDATE SET display_name=EXCLUDED.display_name,phone_e164=EXCLUDED.phone_e164,bio=EXCLUDED.bio,country_code=EXCLUDED.country_code,time_zone=EXCLUDED.time_zone,years_experience=EXCLUDED.years_experience,languages=EXCLUDED.languages,updated_at=now() RETURNING *",
    [userId,merged.displayName,merged.phoneE164??null,merged.bio??null,merged.countryCode,
      merged.timeZone,merged.yearsExperience??0,merged.languages??['en'],current?.status||'draft']
  );
  if (result) return mapProfile(result.rows[0]);
  const saved={...merged,phoneE164:merged.phoneE164??null,bio:merged.bio??null,
    yearsExperience:merged.yearsExperience??0,languages:merged.languages??['en'],
    status:current?.status||'draft',updatedAt:new Date().toISOString()};
  profiles.set(userId,saved);
  return saved;
}

export async function saveProviderCategories(userId,items) {
  const result=await withDatabaseTransaction(async client=>{
    await client.query('DELETE FROM provider_service_categories WHERE provider_user_id=$1',[userId]);
    for (const category of items) {
      await client.query('INSERT INTO provider_service_categories (provider_user_id,category) VALUES ($1,$2)',[userId,category]);
    }
    return true;
  });
  if (result!==null) return items;
  categories.set(userId,[...new Set(items)]);
  return categories.get(userId);
}

export async function saveProviderAreas(userId,items) {
  const result=await withDatabaseTransaction(async client=>{
    await client.query('DELETE FROM provider_service_areas WHERE provider_user_id=$1',[userId]);
    const saved=[];
    for (const area of items) {
      const row=await client.query(
        'INSERT INTO provider_service_areas (provider_user_id,country_code,region,city,postal_code_prefix,is_active) VALUES ($1,$2,$3,$4,$5,true) RETURNING *',
        [userId,area.countryCode,area.region??null,area.city??null,area.postalCodePrefix??null]
      );
      saved.push(mapArea(row.rows[0]));
    }
    return saved;
  });
  if (result!==null) return result;
  const saved=items.map(item=>({id:randomUUID(),...item,isActive:true}));
  areas.set(userId,saved);
  return saved;
}

export async function saveProviderAvailability(userId,windows) {
  const result=await withDatabaseTransaction(async client=>{
    await client.query('DELETE FROM provider_availability WHERE provider_user_id=$1',[userId]);
    const saved=[];
    for (const item of windows) {
      const row=await client.query(
        'INSERT INTO provider_availability (provider_user_id,day_of_week,starts_at,ends_at) VALUES ($1,$2,$3,$4) RETURNING *',
        [userId,item.dayOfWeek,item.startsAt,item.endsAt]
      );
      saved.push(mapWindow(row.rows[0]));
    }
    return saved;
  });
  if (result!==null) return result;
  const saved=windows.map(item=>({id:randomUUID(),...item}));
  availability.set(userId,saved);
  return saved;
}

export async function submitProviderForReview(userId) {
  const current=await getProviderProfile(userId);
  if (!current) return {error:'Create and complete your provider profile first.'};
  if (!current.displayName||!current.phoneE164||!current.countryCode||!current.timeZone||
      !current.serviceCategories.length||!current.serviceAreas.length||!current.availability.length) {
    return {error:'Add contact details, at least one service category, one coverage area and weekly availability first.'};
  }
  if (!['draft','rejected'].includes(current.status)) return {error:'This profile cannot be submitted in its current status.'};
  const result=await queryDatabase(
    "UPDATE provider_profiles SET status='pending_review',submitted_at=now(),reviewed_at=NULL,reviewed_by_user_id=NULL,review_note=NULL,updated_at=now() WHERE user_id=$1 AND status IN ('draft','rejected') RETURNING *",
    [userId]
  );
  if (result) return result.rows[0]?mapProfile(result.rows[0]):{error:'This profile cannot be submitted now.'};
  current.status='pending_review';current.submittedAt=new Date().toISOString();current.reviewNote=null;
  profiles.set(userId,current);
  return current;
}

export async function reviewProviderProfile(userId,reviewerId,status,note=null) {
  const result=await queryDatabase(
    "UPDATE provider_profiles SET status=$3,reviewed_at=now(),reviewed_by_user_id=$2,review_note=$4,updated_at=now() WHERE user_id=$1 AND status='pending_review' RETURNING *",
    [userId,reviewerId,status,note]
  );
  if (result) {
    if (!result.rows[0]) return null;
    const profile=mapProfile(result.rows[0]);
    await queryDatabase(
      "INSERT INTO notifications (user_id,notification_type,title,body,resource_type,resource_id) VALUES ($1,'provider_review','Provider profile reviewed',$2,'provider',NULL)",
      [userId,status==='approved'?'Your provider profile has been approved.':'Your provider profile review is complete. '+(note||'')]
    );
    return profile;
  }
  const profile=profiles.get(userId);
  if (!profile||profile.status!=='pending_review') return null;
  profile.status=status;profile.reviewedAt=new Date().toISOString();
  profile.reviewedByUserId=reviewerId;profile.reviewNote=note;profiles.set(userId,profile);
  await notifyUser(userId,'provider_review','Provider profile reviewed',
    status==='approved'?'Your provider profile has been approved.':'Your provider profile review is complete. '+(note||''),null);
  return profile;
}

export async function listBusinessProviders(businessId) {
  const result=await queryDatabase(
    "SELECT p.user_id,p.display_name,p.phone_e164,p.bio,p.country_code,p.time_zone,p.years_experience,p.languages,"+
    "COALESCE(array_agg(DISTINCT c.category) FILTER (WHERE c.category IS NOT NULL),'{}') AS service_categories "+
    "FROM business_memberships bm JOIN provider_profiles p ON p.user_id=bm.user_id AND p.status='approved' "+
    "LEFT JOIN provider_service_categories c ON c.provider_user_id=p.user_id "+
    "WHERE bm.business_id=$1 AND bm.status='active' GROUP BY p.user_id ORDER BY p.display_name",
    [businessId]
  );
  if (result) return result.rows.map(row=>({
    userId:row.user_id,displayName:row.display_name,phoneE164:row.phone_e164,
    bio:row.bio,countryCode:row.country_code,timeZone:row.time_zone,
    yearsExperience:row.years_experience,languages:row.languages,
    serviceCategories:row.service_categories
  }));
  const members=await listBusinessMembers(businessId);
  return members.filter(member=>profiles.get(member.userId)?.status==='approved').map(member=>{
    const p=profiles.get(member.userId);
    return {userId:member.userId,displayName:p.displayName,phoneE164:p.phoneE164,
      bio:p.bio,countryCode:p.countryCode,timeZone:p.timeZone,yearsExperience:p.yearsExperience,
      languages:p.languages,serviceCategories:categories.get(member.userId)||[]};
  });
}

export async function listProviderAssignments(providerUserId,status=null) {
  const result=await queryDatabase(
    "SELECT a.*,p.display_name,b.public_reference,b.service_name_snapshot,b.service_category_snapshot,b.currency_code,"+
    "b.service_address_recipient,b.service_address_phone,b.service_country_code,b.service_address_line1,"+
    "b.service_address_line2,b.service_city,b.service_region,b.service_postal_code,b.customer_notes "+
    "FROM booking_assignments a JOIN provider_profiles p ON p.user_id=a.provider_user_id "+
    "JOIN bookings b ON b.id=a.booking_id AND b.business_id=a.business_id "+
    "WHERE a.provider_user_id=$1 AND ($2::text IS NULL OR a.status=$2) ORDER BY a.scheduled_start_at DESC",
    [providerUserId,status]
  );
  if (result) return result.rows.map(row=>({...mapAssignment(row),providerDisplayName:row.display_name}));
  return [...assignments.values()].filter(item=>item.providerUserId===providerUserId&&(!status||item.status===status));
}

export async function listBusinessProviderAssignments(businessId,bookingId) {
  const result=await queryDatabase(
    "SELECT a.*,p.display_name,b.public_reference,b.service_name_snapshot,b.service_category_snapshot,b.currency_code,"+
    "b.service_address_recipient,b.service_address_phone,b.service_country_code,b.service_address_line1,"+
    "b.service_address_line2,b.service_city,b.service_region,b.service_postal_code,b.customer_notes "+
    "FROM booking_assignments a JOIN provider_profiles p ON p.user_id=a.provider_user_id "+
    "JOIN bookings b ON b.id=a.booking_id AND b.business_id=a.business_id "+
    "WHERE a.business_id=$1 AND a.booking_id=$2 ORDER BY a.created_at DESC",
    [businessId,bookingId]
  );
  if (result) return result.rows.map(row=>({...mapAssignment(row),providerDisplayName:row.display_name}));
  return [...assignments.values()].filter(item=>item.businessId===businessId&&item.bookingId===bookingId);
}

export async function assignProviderToBooking(businessId,bookingId,providerUserId,actorId) {
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query(
      "SELECT b.status,b.service_category_snapshot,b.service_country_code,b.service_city,b.service_region,b.service_postal_code,"+
      "b.requested_start_at,COALESCE(b.requested_end_at,b.requested_start_at + (b.service_duration_minutes_snapshot * interval '1 minute')) AS scheduled_end_at "+
      "FROM bookings b WHERE b.id=$1 AND b.business_id=$2 FOR UPDATE",
      [bookingId,businessId]
    );
    const booking=selected.rows[0];
    if (!booking||booking.status!=='confirmed') return {error:'Only confirmed bookings can be assigned.'};
    if (!booking.scheduled_end_at) return {error:'This booking needs an end time or service duration before assignment.'};

    const provider=await client.query('SELECT status,time_zone FROM provider_profiles WHERE user_id=$1 FOR UPDATE',[providerUserId]);
    const profile=provider.rows[0];
    if (!profile||profile.status!=='approved') return {error:'Only approved providers can be assigned.'};

    const membership=await client.query(
      "SELECT 1 FROM business_memberships WHERE business_id=$1 AND user_id=$2 AND status='active'",
      [businessId,providerUserId]
    );
    if (!membership.rows[0]) return {error:'The provider must first accept an invitation to this business.'};

    const skill=await client.query(
      'SELECT 1 FROM provider_service_categories WHERE provider_user_id=$1 AND category=$2',
      [providerUserId,booking.service_category_snapshot]
    );
    if (!skill.rows[0]) return {error:'The provider is not listed for this service category.'};

    const area=await client.query(
      "SELECT 1 FROM provider_service_areas WHERE provider_user_id=$1 AND is_active=true AND country_code=$2 "+
      "AND (city IS NULL OR lower(city)=lower($3)) AND (region IS NULL OR lower(region)=lower(COALESCE($4,''))) "+
      "AND (postal_code_prefix IS NULL OR lower(COALESCE($5,'')) LIKE lower(postal_code_prefix)||'%') LIMIT 1",
      [providerUserId,booking.service_country_code,booking.service_city,booking.service_region,booking.service_postal_code]
    );
    if (!area.rows[0]) return {error:'The provider does not cover this service address.'};

    const start=new Date(booking.requested_start_at).toISOString();
    const end=new Date(booking.scheduled_end_at).toISOString();
    const localStart=localScheduleParts(start,profile.time_zone);
    const localEnd=localScheduleParts(end,profile.time_zone);
    if (localStart.date!==localEnd.date) return {error:'This assignment crosses local midnight and is not supported by the current weekly schedule.'};
    const windows=await client.query(
      'SELECT starts_at::text AS starts_at,ends_at::text AS ends_at FROM provider_availability WHERE provider_user_id=$1 AND day_of_week=$2',
      [providerUserId,localStart.dayOfWeek]
    );
    const available=windows.rows.some(row=>
      String(row.starts_at).slice(0,8)<=localStart.time&&String(row.ends_at).slice(0,8)>=localEnd.time
    );
    if (!available) return {error:'The booking falls outside the provider weekly availability.'};

    const conflict=await client.query(
      "SELECT 1 FROM booking_assignments WHERE provider_user_id=$1 AND status IN ('offered','accepted','in_progress') "+
      "AND tstzrange(scheduled_start_at,scheduled_end_at,'[)') && tstzrange($2::timestamptz,$3::timestamptz,'[)') LIMIT 1",
      [providerUserId,start,end]
    );
    if (conflict.rows.length) return {error:'The provider already has a booking during this time.'};

    const inserted=await client.query(
      "INSERT INTO booking_assignments (business_id,booking_id,provider_user_id,assigned_by_user_id,status,scheduled_start_at,scheduled_end_at) "+
      "VALUES ($1,$2,$3,$4,'offered',$5,$6) RETURNING *",
      [businessId,bookingId,providerUserId,actorId,start,end]
    );
    await client.query("UPDATE bookings SET status='assigned',updated_at=now() WHERE id=$1 AND business_id=$2",[bookingId,businessId]);
    await client.query(
      "INSERT INTO booking_status_events (business_id,booking_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,'confirmed','assigned',$3,'A provider assignment was offered.')",
      [businessId,bookingId,actorId]
    );
    await client.query(
      "INSERT INTO booking_assignment_events (business_id,assignment_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,NULL,'offered',$3,'Business offered this booking to the provider.')",
      [businessId,inserted.rows[0].id,actorId]
    );
    await client.query(
      "INSERT INTO notifications (user_id,notification_type,title,body,resource_type,resource_id) VALUES ($1,'provider_assignment','New job offered','A business has offered you a household-service booking.','booking',$2)",
      [providerUserId,bookingId]
    );
    return {assignment:inserted.rows[0]};
  });
  if (result) return result.error?result:mapAssignment(result.assignment);

  const booking=await getBusinessBooking(businessId,bookingId);
  const profile=profiles.get(providerUserId);
  if (!booking||booking.businessId!==businessId||booking.status!=='confirmed') return {error:'Only confirmed bookings can be assigned.'};
  if (!profile||profile.status!=='approved') return {error:'Only approved providers can be assigned.'};
  const members=await listBusinessMembers(businessId);
  if (!members.some(item=>item.userId===providerUserId)) return {error:'The provider must first accept an invitation to this business.'};
  if (!(categories.get(providerUserId)||[]).includes(booking.serviceCategory)) return {error:'The provider is not listed for this service category.'};
  const serviceAddress=booking.serviceAddress||{};
  if (!covered(serviceAddress,areas.get(providerUserId)||[])) return {error:'The provider does not cover this service address.'};
  if (!booking.requestedEndAt&&!booking.serviceDurationMinutes) return {error:'This booking needs an end time or service duration before assignment.'};
  const start=booking.requestedStartAt;
  const end=booking.requestedEndAt||new Date(Date.parse(start)+booking.serviceDurationMinutes*60000).toISOString();
  if (!checkMemoryAvailability(providerUserId,profile.timeZone,start,end)) return {error:'The booking falls outside the provider weekly availability.'};
  const clash=[...assignments.values()].some(item=>item.providerUserId===providerUserId&&['offered','accepted','in_progress'].includes(item.status)&&Date.parse(item.scheduledStartAt)<Date.parse(end)&&Date.parse(item.scheduledEndAt)>Date.parse(start));
  if (clash) return {error:'The provider already has a booking during this time.'};
  const assignment={id:randomUUID(),businessId,bookingId,providerUserId,assignedByUserId:actorId,
    status:'offered',scheduledStartAt:start,scheduledEndAt:end,offeredAt:new Date().toISOString()};
  assignments.set(assignment.id,assignment);
  booking.status='assigned';
  assignmentEvents.set(assignment.id,[{fromStatus:null,toStatus:'offered',actorUserId:actorId}]);
  await notifyUser(providerUserId,'provider_assignment','New job offered','A business has offered you a household-service booking.',bookingId);
  return assignment;
}

export async function updateProviderAssignment(providerUserId,assignmentId,action,note=null) {
  const transitions={accept:['offered','accepted'],decline:['offered','declined'],
    start:['accepted','in_progress'],complete:['in_progress','completed']};
  const pair=transitions[action];
  if (!pair) return null;
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query(
      "SELECT a.business_id,a.booking_id,a.status,b.status AS booking_status FROM booking_assignments a "+
      "JOIN bookings b ON b.id=a.booking_id AND b.business_id=a.business_id "+
      "WHERE a.id=$1 AND a.provider_user_id=$2 FOR UPDATE OF a,b",
      [assignmentId,providerUserId]
    );
    const row=selected.rows[0];
    if (!row||row.status!==pair[0]) return {missing:true};
    const updated=await client.query(
      "UPDATE booking_assignments SET status=$3,"+
      "responded_at=CASE WHEN $3 IN ('accepted','declined') THEN now() ELSE responded_at END,"+
      "started_at=CASE WHEN $3='in_progress' THEN now() ELSE started_at END,"+
      "completed_at=CASE WHEN $3='completed' THEN now() ELSE completed_at END,updated_at=now() "+
      "WHERE id=$1 AND provider_user_id=$2 RETURNING *",
      [assignmentId,providerUserId,pair[1]]
    );
    await client.query(
      "INSERT INTO booking_assignment_events (business_id,assignment_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,$3,$4,$5,$6)",
      [row.business_id,assignmentId,row.status,pair[1],providerUserId,note]
    );
    let nextBooking=row.booking_status;
    if (action==='decline') nextBooking='confirmed';
    if (action==='start') nextBooking='in_progress';
    if (action==='complete') nextBooking='completed';
    if (nextBooking!==row.booking_status) {
      await client.query('UPDATE bookings SET status=$3,updated_at=now() WHERE id=$1 AND business_id=$2',[row.booking_id,row.business_id,nextBooking]);
      await client.query(
        'INSERT INTO booking_status_events (business_id,booking_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,$3,$4,$5,$6)',
        [row.business_id,row.booking_id,row.booking_status,nextBooking,providerUserId,note]
      );
    }
    const recipients=action==='decline'
      ? await client.query("SELECT user_id FROM business_memberships WHERE business_id=$1 AND status='active'",[row.business_id])
      : await client.query('SELECT customer_user_id AS user_id FROM bookings WHERE id=$1 AND business_id=$2',[row.booking_id,row.business_id]);
    for (const recipient of recipients.rows) {
      await client.query(
        'INSERT INTO notifications (user_id,notification_type,title,body,resource_type,resource_id) VALUES ($1,$2,$3,$4,$5,$6)',
        [recipient.user_id,'provider_assignment_'+action,
          action==='decline'?'Provider declined assignment':'Provider job update',
          action==='decline'?'The provider declined the booking.':'The assigned provider updated the booking to '+pair[1]+'.',
          'booking',row.booking_id]
      );
    }
    return {assignment:updated.rows[0]};
  });
  if (result) return result.missing?null:mapAssignment(result.assignment);

  const item=assignments.get(assignmentId);
  if (!item||item.providerUserId!==providerUserId||item.status!==pair[0]) return null;
  item.status=pair[1];item.respondedAt=new Date().toISOString();assignments.set(assignmentId,item);
  const history=assignmentEvents.get(assignmentId)||[];
  history.push({fromStatus:pair[0],toStatus:pair[1],actorUserId:providerUserId,note});
  assignmentEvents.set(assignmentId,history);
  const booking=await getBusinessBooking(item.businessId,item.bookingId);
  if (booking) {
    const next=action==='decline'?'confirmed':action==='start'?'in_progress':action==='complete'?'completed':booking.status;
    if (next!==booking.status) booking.status=next;
  }
  const message=action==='decline'?'The provider declined the booking.':'The provider updated booking progress to '+pair[1]+'.';
  if (action==='decline') {
    for (const member of await listBusinessMembers(item.businessId)) await notifyUser(member.userId,'provider_assignment_decline','Provider declined assignment',message,item.bookingId);
  } else if (booking?.customerUserId) {
    await notifyUser(booking.customerUserId,'provider_assignment_'+action,'Provider job update',message,item.bookingId);
  }
  return item;
}

export async function cancelBusinessAssignment(businessId,bookingId,assignmentId,actorId,note=null) {
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query(
      'SELECT id,status,provider_user_id FROM booking_assignments WHERE id=$1 AND business_id=$2 AND booking_id=$3 FOR UPDATE',
      [assignmentId,businessId,bookingId]
    );
    const row=selected.rows[0];
    if (!row||!['offered','accepted'].includes(row.status)) return null;
    const updated=await client.query(
      "UPDATE booking_assignments SET status='cancelled',cancellation_note=$4,updated_at=now() WHERE id=$1 AND business_id=$2 AND booking_id=$3 RETURNING *",
      [assignmentId,businessId,bookingId,note]
    );
    await client.query("UPDATE bookings SET status='confirmed',updated_at=now() WHERE id=$1 AND business_id=$2 AND status='assigned'",[bookingId,businessId]);
    await client.query(
      "INSERT INTO booking_assignment_events (business_id,assignment_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,$3,'cancelled',$4,$5)",
      [businessId,assignmentId,row.status,actorId,note]
    );
    await client.query(
      "INSERT INTO booking_status_events (business_id,booking_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,'assigned','confirmed',$3,$4)",
      [businessId,bookingId,actorId,'The business cancelled the provider assignment.']
    );
    await client.query(
      "INSERT INTO notifications (user_id,notification_type,title,body,resource_type,resource_id) VALUES ($1,'provider_assignment_cancelled','Assignment cancelled','The business cancelled your job offer.','booking',$2)",
      [row.provider_user_id,bookingId]
    );
    return updated.rows[0];
  });
  if (result!==null) return result?mapAssignment(result):null;
  const item=assignments.get(assignmentId);
  if (!item||item.businessId!==businessId||item.bookingId!==bookingId||!['offered','accepted'].includes(item.status)) return null;
  item.status='cancelled';item.cancellationNote=note;assignments.set(assignmentId,item);
  const booking=await getBusinessBooking(businessId,bookingId);
  if (booking&&booking.status==='assigned') booking.status='confirmed';
  await notifyUser(item.providerUserId,'provider_assignment_cancelled','Assignment cancelled','The business cancelled your job offer.',bookingId);
  return item;
}
