import { randomUUID, randomBytes } from 'node:crypto';
import { listActiveBusinessSummaries, listBusinessMembers, queryDatabase, withDatabaseTransaction } from './repository.js';
import { getBranch, getService, listAreas, listBranches, listServices } from './business_resources.js';

const locations = new Map();
const profiles = new Map();
const bookings = new Map();
const quotes = new Map();
const events = new Map();
const notifications = new Map();

function makeReference() {
  return 'SS' + Date.now().toString(36).toUpperCase() + randomBytes(4).toString('hex').toUpperCase();
}

function mapLocation(row) {
  return {
    id:row.id, customerUserId:row.customer_user_id, label:row.label,
    recipientName:row.recipient_name, phoneE164:row.phone_e164,
    countryCode:row.country_code, addressLine1:row.address_line1,
    addressLine2:row.address_line2, city:row.city, region:row.region,
    postalCode:row.postal_code, deliveryInstructions:row.delivery_instructions,
    isDefault:row.is_default,
    createdAt:row.created_at?new Date(row.created_at).toISOString():null
  };
}

function mapBooking(row) {
  return {
    id:row.id, reference:row.public_reference, businessId:row.business_id,
    serviceId:row.service_id, branchId:row.branch_id, customerUserId:row.customer_user_id,
    customerLocationId:row.customer_location_id, serviceName:row.service_name_snapshot,
    serviceCategory:row.service_category_snapshot, pricingModel:row.pricing_model_snapshot,
    currencyCode:row.currency_code,
    servicePriceMinor:row.service_price_minor_snapshot===null?null:Number(row.service_price_minor_snapshot),
    serviceAddress:{
      recipientName:row.service_address_recipient, phoneE164:row.service_address_phone,
      countryCode:row.service_country_code, addressLine1:row.service_address_line1,
      addressLine2:row.service_address_line2, city:row.service_city,
      region:row.service_region, postalCode:row.service_postal_code
    },
    requestedStartAt:row.requested_start_at?new Date(row.requested_start_at).toISOString():null,
    requestedEndAt:row.requested_end_at?new Date(row.requested_end_at).toISOString():null,
    confirmedStartAt:row.confirmed_start_at?new Date(row.confirmed_start_at).toISOString():null,
    confirmedEndAt:row.confirmed_end_at?new Date(row.confirmed_end_at).toISOString():null,
    customerNotes:row.customer_notes, status:row.status, latestQuoteId:row.latest_quote_id,
    paymentStatus:row.payment_status??'not_required',
    createdAt:row.created_at?new Date(row.created_at).toISOString():null,
    updatedAt:row.updated_at?new Date(row.updated_at).toISOString():null
  };
}

function mapQuote(row) {
  return {
    id:row.id, businessId:row.business_id, bookingId:row.booking_id,
    version:row.version, amountMinor:Number(row.amount_minor), currencyCode:row.currency_code,
    message:row.message, expiresAt:new Date(row.expires_at).toISOString(),
    status:row.status, createdByUserId:row.created_by_user_id,
    respondedAt:row.responded_at?new Date(row.responded_at).toISOString():null,
    createdAt:row.created_at?new Date(row.created_at).toISOString():null
  };
}

function pushMemoryNotification(userId,type,title,body,resourceId) {
  const id=randomUUID();
  notifications.set(id,{
    id,userId,type,title,body,resourceType:'booking',resourceId,
    readAt:null,createdAt:new Date().toISOString()
  });
}

function areaMatches(item, countryCode, city) {
  if (countryCode && item.countryCode!==countryCode) return false;
  if (city) {
    const term=city.toLowerCase();
    if (!(item.city||'').toLowerCase().includes(term) && !(item.region||'').toLowerCase().includes(term)) return false;
  }
  return true;
}

export async function listMarketplaceServices(filters={}) {
  const countryCode=filters.countryCode||null;
  const city=filters.city||null;
  const category=filters.category||null;
  const search=filters.search||null;
  const limit=Math.min(50,Math.max(1,Number(filters.limit||20)));
  const offset=Math.max(0,Number(filters.offset||0));

  const result=await queryDatabase(
    "SELECT DISTINCT ON (bs.id) bs.id AS service_id,bs.business_id,bs.category,bs.name AS service_name,bs.slug,bs.description AS service_description,bs.pricing_model,bs.currency_code,bs.price_minor,bs.duration_minutes,b.name AS business_name,b.country_code AS business_country_code,b.currency_code AS business_currency_code,b.time_zone,br.id AS branch_id,br.name AS branch_name,br.country_code AS branch_country_code,br.address_line1,br.city AS branch_city,br.region AS branch_region " +
    "FROM business_services bs JOIN businesses b ON b.id=bs.business_id " +
    "LEFT JOIN LATERAL (SELECT branch.* FROM business_branches branch WHERE branch.business_id=b.id AND branch.status='active' ORDER BY branch.is_primary DESC,branch.created_at ASC LIMIT 1) br ON true " +
    "WHERE b.status='active' AND bs.is_active=true " +
    "AND ($1::char(2) IS NULL OR EXISTS (SELECT 1 FROM business_service_areas sa WHERE sa.business_id=bs.business_id AND sa.is_active=true AND sa.country_code=$1 AND ($2::text IS NULL OR sa.city ILIKE '%'||$2||'%' OR sa.region ILIKE '%'||$2||'%')) OR EXISTS (SELECT 1 FROM business_branches fb WHERE fb.business_id=bs.business_id AND fb.status='active' AND fb.country_code=$1 AND ($2::text IS NULL OR fb.city ILIKE '%'||$2||'%' OR fb.region ILIKE '%'||$2||'%'))) " +
    "AND ($1::char(2) IS NOT NULL OR $2::text IS NULL OR EXISTS (SELECT 1 FROM business_service_areas sa WHERE sa.business_id=bs.business_id AND sa.is_active=true AND (sa.city ILIKE '%'||$2||'%' OR sa.region ILIKE '%'||$2||'%')) OR EXISTS (SELECT 1 FROM business_branches fb WHERE fb.business_id=bs.business_id AND fb.status='active' AND (fb.city ILIKE '%'||$2||'%' OR fb.region ILIKE '%'||$2||'%'))) " +
    "AND ($3::text IS NULL OR bs.category=$3) " +
    "AND ($4::text IS NULL OR bs.name ILIKE '%'||$4||'%' OR bs.description ILIKE '%'||$4||'%' OR b.name ILIKE '%'||$4||'%') " +
    "ORDER BY bs.id,br.is_primary DESC NULLS LAST LIMIT $5 OFFSET $6",
    [countryCode,city,category,search,limit,offset]
  );
  if (result) {
    return result.rows.map(row=>({
      id:row.service_id,category:row.category,name:row.service_name,slug:row.slug,
      description:row.service_description,pricingModel:row.pricing_model,
      currencyCode:row.currency_code,priceMinor:row.price_minor===null?null:Number(row.price_minor),
      durationMinutes:row.duration_minutes,
      business:{id:row.business_id,name:row.business_name,countryCode:row.business_country_code,currencyCode:row.business_currency_code,timeZone:row.time_zone},
      branch:row.branch_id?{id:row.branch_id,name:row.branch_name,countryCode:row.branch_country_code,addressLine1:row.address_line1,city:row.branch_city,region:row.branch_region}:null
    }));
  }

  const businesses=await listActiveBusinessSummaries();
  const output=[];
  for (const business of businesses) {
    const [items,branches,areas]=await Promise.all([
      listServices(business.id,false),listBranches(business.id),listAreas(business.id)
    ]);
    const matchingAreas=areas.filter(item=>item.isActive!==false && areaMatches(item,countryCode,city));
    const matchingBranches=branches.filter(item=>item.status==='active' && areaMatches(item,countryCode,city));
    if ((countryCode||city) && !matchingAreas.length && !matchingBranches.length) continue;
    for (const service of items) {
      if (category && service.category!==category) continue;
      if (search) {
        const term=search.toLowerCase();
        if (!service.name.toLowerCase().includes(term) && !service.description.toLowerCase().includes(term) && !business.name.toLowerCase().includes(term)) continue;
      }
      const branch=matchingBranches[0]||null;
      output.push({
        id:service.id,category:service.category,name:service.name,slug:service.slug,
        description:service.description,pricingModel:service.pricingModel,
        currencyCode:service.currencyCode,priceMinor:service.priceMinor,durationMinutes:service.durationMinutes,
        business,branch:branch?{id:branch.id,name:branch.name,countryCode:branch.countryCode,addressLine1:branch.addressLine1,city:branch.city,region:branch.region}:null
      });
    }
  }
  output.sort((a,b)=>a.name.localeCompare(b.name));
  return output.slice(offset,offset+limit);
}

export async function getMarketplaceService(serviceId) {
  const result=await queryDatabase(
    "SELECT bs.id AS service_id,bs.business_id,bs.category,bs.name AS service_name,bs.slug,bs.description AS service_description,bs.pricing_model,bs.currency_code,bs.price_minor,bs.duration_minutes,b.name AS business_name,b.country_code AS business_country_code,b.currency_code AS business_currency_code,b.time_zone,br.id AS branch_id,br.name AS branch_name,br.country_code AS branch_country_code,br.address_line1,br.city AS branch_city,br.region AS branch_region FROM business_services bs JOIN businesses b ON b.id=bs.business_id LEFT JOIN LATERAL (SELECT branch.* FROM business_branches branch WHERE branch.business_id=b.id AND branch.status='active' ORDER BY branch.is_primary DESC,branch.created_at ASC LIMIT 1) br ON true WHERE bs.id=$1 AND bs.is_active=true AND b.status='active' LIMIT 1",
    [serviceId]
  );
  if (result) {
    const row=result.rows[0];
    return row?{
      id:row.service_id,category:row.category,name:row.service_name,slug:row.slug,
      description:row.service_description,pricingModel:row.pricing_model,
      currencyCode:row.currency_code,priceMinor:row.price_minor===null?null:Number(row.price_minor),
      durationMinutes:row.duration_minutes,
      business:{id:row.business_id,name:row.business_name,countryCode:row.business_country_code,currencyCode:row.business_currency_code,timeZone:row.time_zone},
      branch:row.branch_id?{id:row.branch_id,name:row.branch_name,countryCode:row.branch_country_code,addressLine1:row.address_line1,city:row.branch_city,region:row.branch_region}:null
    }:null;
  }

  const businesses=await listActiveBusinessSummaries();
  for (const business of businesses) {
    const service=await getService(business.id,serviceId);
    if (!service || !service.isActive) continue;
    const branches=(await listBranches(business.id)).filter(item=>item.status==='active');
    const branch=branches.find(item=>item.isPrimary)||branches[0]||null;
    return {
      ...service,
      business,
      branch:branch?{id:branch.id,name:branch.name,countryCode:branch.countryCode,addressLine1:branch.addressLine1,city:branch.city,region:branch.region}:null
    };
  }
  return null;
}

export async function getCustomerProfile(user) {
  const result=await queryDatabase('SELECT phone_e164,preferred_language,locale FROM customer_profiles WHERE user_id=$1 LIMIT 1',[user.id]);
  if (result) {
    const row=result.rows[0];
    return {user,profile:row?{phoneE164:row.phone_e164,preferredLanguage:row.preferred_language,locale:row.locale}:{phoneE164:null,preferredLanguage:'en',locale:'en'}};
  }
  return {user,profile:profiles.get(user.id)||{phoneE164:null,preferredLanguage:'en',locale:'en'}};
}

export async function updateCustomerProfile(userId,patch) {
  const columns = {
    phoneE164: 'phone_e164',
    preferredLanguage: 'preferred_language',
    locale: 'locale'
  };
  const entries = Object.entries(patch).filter(([key]) =>
    Object.prototype.hasOwnProperty.call(columns, key)
  );
  if (entries.length === 0) return getCustomerProfile({ id: userId });

  const insertColumns = ['user_id', ...entries.map(([key]) => columns[key])];
  const placeholders = entries.map((_, index) => '$' + (index + 2));
  const updates = entries.map(([key]) => columns[key] + '=EXCLUDED.' + columns[key]);
  const sql =
    'INSERT INTO customer_profiles (' + insertColumns.join(',') + ') ' +
    'VALUES ($1,' + placeholders.join(',') + ') ' +
    'ON CONFLICT (user_id) DO UPDATE SET ' + updates.join(',') + ',updated_at=now() ' +
    'RETURNING phone_e164,preferred_language,locale';
  const result = await queryDatabase(sql, [userId, ...entries.map(([, value]) => value)]);

  if (result) {
    const row = result.rows[0];
    return {
      phoneE164: row.phone_e164,
      preferredLanguage: row.preferred_language,
      locale: row.locale
    };
  }

  const updated = { ...(profiles.get(userId) || {}), ...patch };
  profiles.set(userId, updated);
  return {
    phoneE164: updated.phoneE164 ?? null,
    preferredLanguage: updated.preferredLanguage ?? 'en',
    locale: updated.locale ?? 'en'
  };
}

export async function listCustomerLocations(userId) {
  const result=await queryDatabase('SELECT * FROM customer_locations WHERE customer_user_id=$1 ORDER BY is_default DESC,created_at DESC',[userId]);
  if (result) return result.rows.map(mapLocation);
  return [...locations.values()].filter(item=>item.customerUserId===userId).sort((a,b)=>Number(b.isDefault)-Number(a.isDefault));
}

export async function getCustomerLocation(userId,id) {
  const result=await queryDatabase('SELECT * FROM customer_locations WHERE customer_user_id=$1 AND id=$2 LIMIT 1',[userId,id]);
  if (result) return result.rows[0]?mapLocation(result.rows[0]):null;
  const item=locations.get(id);
  return item&&item.customerUserId===userId?item:null;
}

export async function createCustomerLocation(userId,input) {
  const id=randomUUID();
  const result=await withDatabaseTransaction(async client=>{
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);
    if (input.isDefault) await client.query('UPDATE customer_locations SET is_default=false,updated_at=now() WHERE customer_user_id=$1',[userId]);
    const inserted=await client.query(
      "INSERT INTO customer_locations (id,customer_user_id,label,recipient_name,phone_e164,country_code,address_line1,address_line2,city,region,postal_code,delivery_instructions,is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *",
      [id,userId,input.label,input.recipientName,input.phoneE164??null,input.countryCode,input.addressLine1,input.addressLine2??null,input.city,input.region??null,input.postalCode??null,input.deliveryInstructions??null,Boolean(input.isDefault)]
    );
    return inserted.rows[0];
  });
  if (result) return mapLocation(result);
  if (input.isDefault) for (const item of locations.values()) if (item.customerUserId===userId) item.isDefault=false;
  const item={id,customerUserId:userId,...input,isDefault:Boolean(input.isDefault)};
  locations.set(id,item);
  return item;
}

export async function updateCustomerLocation(userId,id,patch) {
  const columns={label:'label',recipientName:'recipient_name',phoneE164:'phone_e164',countryCode:'country_code',addressLine1:'address_line1',addressLine2:'address_line2',city:'city',region:'region',postalCode:'postal_code',deliveryInstructions:'delivery_instructions',isDefault:'is_default'};
  const entries=Object.entries(patch).filter(([key])=>Object.prototype.hasOwnProperty.call(columns,key));
  if (!entries.length) return getCustomerLocation(userId,id);
  const result=await withDatabaseTransaction(async client=>{
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);
    const current=await client.query('SELECT id FROM customer_locations WHERE customer_user_id=$1 AND id=$2 FOR UPDATE',[userId,id]);
    if (!current.rows[0]) return null;
    if (patch.isDefault===true) await client.query('UPDATE customer_locations SET is_default=false,updated_at=now() WHERE customer_user_id=$1',[userId]);
    const assignments=entries.map(([key],index)=>columns[key]+'=$'+(index+3));
    const updated=await client.query('UPDATE customer_locations SET '+assignments.join(',')+',updated_at=now() WHERE customer_user_id=$1 AND id=$2 RETURNING *',[userId,id,...entries.map(([,value])=>value)]);
    return updated.rows[0];
  });
  if (result!==null) return result?mapLocation(result):null;
  const current=await getCustomerLocation(userId,id);
  if (!current) return null;
  if (patch.isDefault===true) for (const item of locations.values()) if (item.customerUserId===userId) item.isDefault=false;
  const updated={...current,...patch};
  locations.set(id,updated);
  return updated;
}

export async function deleteCustomerLocation(userId,id) {
  const result=await queryDatabase('DELETE FROM customer_locations WHERE customer_user_id=$1 AND id=$2',[userId,id]);
  if (result) return result.rowCount>0;
  const item=locations.get(id);
  if (!item||item.customerUserId!==userId) return false;
  return locations.delete(id);
}

export async function createCustomerBooking(userId,input,service,location) {
  const id=randomUUID();
  const reference=makeReference();
  const address=location||input.serviceAddress;
  const result=await withDatabaseTransaction(async client=>{
    const inserted=await client.query(
      "INSERT INTO bookings (id,public_reference,business_id,service_id,branch_id,customer_user_id,customer_location_id,service_name_snapshot,service_category_snapshot,pricing_model_snapshot,currency_code,service_price_minor_snapshot,service_address_recipient,service_address_phone,service_country_code,service_address_line1,service_address_line2,service_city,service_region,service_postal_code,requested_start_at,requested_end_at,customer_notes,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'requested') RETURNING *",
      [id,reference,input.businessId,service.id,input.branchId??null,userId,location?.id??null,service.name,service.category,service.pricingModel,service.currencyCode,service.priceMinor??null,address.recipientName,address.phoneE164??null,address.countryCode,address.addressLine1,address.addressLine2??null,address.city,address.region??null,address.postalCode??null,input.requestedStartAt,input.requestedEndAt??null,input.customerNotes??null]
    );
    await client.query("INSERT INTO booking_status_events (business_id,booking_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,$3,$4,$5,$6)",[input.businessId,id,null,'requested',userId,'Customer submitted a booking request.']);
    await client.query("INSERT INTO notifications (user_id,notification_type,title,body,resource_type,resource_id) SELECT bm.user_id,'booking_requested','New booking request','A customer has requested ' || $2 || '.','booking',$1 FROM business_memberships bm WHERE bm.business_id=$3 AND bm.status='active'",[id,service.name,input.businessId]);
    return inserted.rows[0];
  });
  if (result) return mapBooking(result);
  const booking={
    id,reference,businessId:input.businessId,serviceId:service.id,branchId:input.branchId??null,
    customerUserId:userId,customerLocationId:location?.id??null,serviceName:service.name,
    serviceCategory:service.category,pricingModel:service.pricingModel,currencyCode:service.currencyCode,
    servicePriceMinor:service.priceMinor??null,
    serviceAddress:{
      recipientName:address.recipientName,
      phoneE164:address.phoneE164??null,
      countryCode:address.countryCode,
      addressLine1:address.addressLine1,
      addressLine2:address.addressLine2??null,
      city:address.city,
      region:address.region??null,
      postalCode:address.postalCode??null
    },requestedStartAt:input.requestedStartAt,requestedEndAt:input.requestedEndAt??null,
    confirmedStartAt:null,confirmedEndAt:null,customerNotes:input.customerNotes??null,status:'requested',
    latestQuoteId:null,paymentStatus:'not_required',
    createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
  };
  bookings.set(id,booking);
  const timestamp=new Date().toISOString();
  events.set(id,[{fromStatus:null,toStatus:'requested',actorUserId:userId,note:'Customer submitted a booking request.',createdAt:timestamp}]);
  for (const member of await listBusinessMembers(input.businessId)) {
    pushMemoryNotification(member.userId,'booking_requested','New booking request','A customer has requested '+service.name+'.',id);
  }
  return booking;
}

export async function listCustomerBookings(userId) {
  const result=await queryDatabase('SELECT * FROM bookings WHERE customer_user_id=$1 ORDER BY created_at DESC',[userId]);
  if (result) return result.rows.map(mapBooking);
  return [...bookings.values()].filter(item=>item.customerUserId===userId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}

export async function listBusinessBookings(businessId,status=null) {
  const result=await queryDatabase('SELECT * FROM bookings WHERE business_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC',[businessId,status]);
  if (result) return result.rows.map(mapBooking);
  return [...bookings.values()].filter(item=>item.businessId===businessId&&(!status||item.status===status)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}

export async function getCustomerBooking(userId,id) {
  const result=await queryDatabase('SELECT * FROM bookings WHERE id=$1 AND customer_user_id=$2 LIMIT 1',[id,userId]);
  if (result) return result.rows[0]?mapBooking(result.rows[0]):null;
  const item=bookings.get(id);
  return item&&item.customerUserId===userId?item:null;
}

export async function getBusinessBooking(businessId,id) {
  const result=await queryDatabase('SELECT * FROM bookings WHERE id=$1 AND business_id=$2 LIMIT 1',[id,businessId]);
  if (result) return result.rows[0]?mapBooking(result.rows[0]):null;
  const item=bookings.get(id);
  return item&&item.businessId===businessId?item:null;
}

export async function createBookingQuote(businessId,bookingId,actorId,input) {
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query('SELECT id,status,currency_code FROM bookings WHERE id=$1 AND business_id=$2 FOR UPDATE',[bookingId,businessId]);
    const booking=selected.rows[0];
    if (!booking||!['requested','quoted'].includes(booking.status)) return {missing:true};
    await client.query("UPDATE booking_quotes SET status='expired' WHERE booking_id=$1 AND status='pending' AND expires_at<=now()",[bookingId]);
    const pending=await client.query("SELECT id FROM booking_quotes WHERE booking_id=$1 AND status='pending'",[bookingId]);
    if (pending.rows.length) return {conflict:true};
    const versions=await client.query('SELECT COALESCE(MAX(version),0)::int AS version FROM booking_quotes WHERE booking_id=$1',[bookingId]);
    const quoteId=randomUUID();
    const inserted=await client.query("INSERT INTO booking_quotes (id,business_id,booking_id,version,amount_minor,currency_code,message,expires_at,status,created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9) RETURNING *",[quoteId,businessId,bookingId,versions.rows[0].version+1,input.amountMinor,booking.currency_code,input.message??null,input.expiresAt,actorId]);
    await client.query("UPDATE bookings SET status='quoted',latest_quote_id=$3,updated_at=now() WHERE id=$1 AND business_id=$2",[bookingId,businessId,quoteId]);
    await client.query("INSERT INTO booking_status_events (business_id,booking_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,$3,'quoted',$4,$5)",[businessId,bookingId,booking.status,actorId,'Business sent a price quote.']);
    await client.query("INSERT INTO notifications (user_id,notification_type,title,body,resource_type,resource_id) SELECT customer_user_id,'booking_quote','New quote received','A service business has sent you a quote.','booking',id FROM bookings WHERE id=$1 AND business_id=$2",[bookingId,businessId]);
    return {quote:inserted.rows[0]};
  });
  if (result) {
    if (result.missing) return null;
    if (result.conflict) return {conflict:true};
    return {quote:mapQuote(result.quote),conflict:false};
  }
  const booking=await getBusinessBooking(businessId,bookingId);
  if (!booking||!['requested','quoted'].includes(booking.status)) return null;
  for (const item of quotes.values()) {
    if (item.bookingId===bookingId && item.status==='pending' && new Date(item.expiresAt)<=new Date()) {
      item.status='expired';
      quotes.set(item.id,item);
    }
  }
  const existing=[...quotes.values()].find(item=>item.bookingId===bookingId&&item.status==='pending');
  if (existing) return {conflict:true};
  const previousStatus=booking.status;
  const quote={id:randomUUID(),businessId,bookingId,version:[...quotes.values()].filter(item=>item.bookingId===bookingId).length+1,amountMinor:input.amountMinor,currencyCode:booking.currencyCode,message:input.message??null,expiresAt:input.expiresAt,status:'pending',createdByUserId:actorId,createdAt:new Date().toISOString()};
  quotes.set(quote.id,quote);
  booking.status='quoted';
  booking.latestQuoteId=quote.id;
  bookings.set(bookingId,booking);
  pushMemoryNotification(booking.customerUserId,'booking_quote','New quote received','A service business has sent you a quote.',bookingId);
  const history=events.get(bookingId)||[];
  history.push({fromStatus:previousStatus,toStatus:'quoted',actorUserId:actorId,note:'Business sent a price quote.',createdAt:new Date().toISOString()});
  events.set(bookingId,history);
  return {quote,conflict:false};
}

export async function listBookingQuotes(userId,bookingId,scope='customer') {
  const booking=scope==='customer'?await getCustomerBooking(userId,bookingId):await getBusinessBooking(userId,bookingId);
  if (!booking) return null;
  const result=await queryDatabase('SELECT * FROM booking_quotes WHERE business_id=$1 AND booking_id=$2 ORDER BY version DESC',[booking.businessId,bookingId]);
  if (result) return result.rows.map(mapQuote);
  return [...quotes.values()].filter(item=>item.bookingId===bookingId).sort((a,b)=>b.version-a.version);
}

export async function respondToBookingQuote(userId,bookingId,quoteId,action) {
  const nextQuote=action==='accept'?'accepted':'declined';
  const nextBooking=action==='accept'?'confirmed':'requested';
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query("SELECT b.business_id,b.status,q.status AS quote_status,q.expires_at FROM bookings b JOIN booking_quotes q ON q.booking_id=b.id AND q.business_id=b.business_id WHERE b.id=$1 AND b.customer_user_id=$2 AND q.id=$3 FOR UPDATE OF b,q",[bookingId,userId,quoteId]);
    const row=selected.rows[0];
    if (!row||row.status!=='quoted'||row.quote_status!=='pending'||new Date(row.expires_at)<=new Date()) return {missing:true};
    if (!['accept','decline'].includes(action)) return {missing:true};
    await client.query('UPDATE booking_quotes SET status=$3,responded_at=now() WHERE id=$1 AND business_id=$2',[quoteId,row.business_id,nextQuote]);
    await client.query("UPDATE bookings SET status=$3,confirmed_start_at=CASE WHEN $3='confirmed' THEN requested_start_at ELSE confirmed_start_at END,confirmed_end_at=CASE WHEN $3='confirmed' THEN requested_end_at ELSE confirmed_end_at END,updated_at=now() WHERE id=$1 AND business_id=$2",[bookingId,row.business_id,nextBooking]);
    await client.query('INSERT INTO booking_status_events (business_id,booking_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,$3,$4,$5,$6)',[row.business_id,bookingId,row.status,nextBooking,userId,'Customer responded to quote.']);
    await client.query("INSERT INTO notifications (user_id,notification_type,title,body,resource_type,resource_id) SELECT bm.user_id,'booking_quote_response','Quote response received','The customer has responded to the quote.','booking',$1 FROM business_memberships bm WHERE bm.business_id=$2 AND bm.status='active'",[bookingId,row.business_id]);
    return {status:nextBooking};
  });
  if (result) return result.missing?null:{status:result.status};
  const booking=await getCustomerBooking(userId,bookingId);
  const quote=quotes.get(quoteId);
  if (!booking||booking.status!=='quoted'||!quote||quote.bookingId!==bookingId||quote.status!=='pending'||new Date(quote.expiresAt)<=new Date()) return null;
  quote.status=nextQuote;
  quote.respondedAt=new Date().toISOString();
  quotes.set(quoteId,quote);
  booking.status=nextBooking;
  if (action==='accept') {
    booking.confirmedStartAt=booking.requestedStartAt;
    booking.confirmedEndAt=booking.requestedEndAt;
  }
  bookings.set(bookingId,booking);
  for (const member of await listBusinessMembers(booking.businessId)) {
    pushMemoryNotification(member.userId,'booking_quote_response','Quote response received','The customer has responded to the quote.',bookingId);
  }
  const history=events.get(bookingId)||[];
  history.push({fromStatus:nextBooking==='confirmed'?'quoted':'quoted',toStatus:nextBooking,actorUserId:userId,note:'Customer responded to quote.',createdAt:new Date().toISOString()});
  events.set(bookingId,history);
  return {status:nextBooking};
}

export async function updateBusinessBookingStatus(businessId,bookingId,actorId,nextStatus,note=null) {
  const allowed={
    requested:['confirmed','declined','cancelled'],
    quoted:['confirmed','declined','cancelled'],
    confirmed:['in_progress','cancelled'],
    assigned:['in_progress','cancelled'],
    in_progress:['completed','cancelled'],
    completed:[],cancelled:[],declined:[]
  };
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query('SELECT status FROM bookings WHERE id=$1 AND business_id=$2 FOR UPDATE',[bookingId,businessId]);
    const row=selected.rows[0];
    if (!row||!allowed[row.status]?.includes(nextStatus)) return {missing:true};
    if (row.status==='quoted' && nextStatus!=='quoted') {
      await client.query("UPDATE booking_quotes SET status='withdrawn' WHERE booking_id=$1 AND status='pending'",[bookingId]);
    }
    await client.query("UPDATE bookings SET status=$3,confirmed_start_at=CASE WHEN $3='confirmed' THEN requested_start_at ELSE confirmed_start_at END,confirmed_end_at=CASE WHEN $3='confirmed' THEN requested_end_at ELSE confirmed_end_at END,updated_at=now() WHERE id=$1 AND business_id=$2",[bookingId,businessId,nextStatus]);
    await client.query('INSERT INTO booking_status_events (business_id,booking_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,$3,$4,$5,$6)',[businessId,bookingId,row.status,nextStatus,actorId,note]);
    await client.query("INSERT INTO notifications (user_id,notification_type,title,body,resource_type,resource_id) SELECT customer_user_id,'booking_status','Booking update','Your booking status is now ' || $3 || '.','booking',id FROM bookings WHERE id=$1 AND business_id=$2",[bookingId,businessId,nextStatus]);
    const updated=await client.query('SELECT * FROM bookings WHERE id=$1 AND business_id=$2',[bookingId,businessId]);
    return {booking:updated.rows[0]};
  });
  if (result) return result.missing?null:mapBooking(result.booking);
  const booking=await getBusinessBooking(businessId,bookingId);
  if (!booking||!allowed[booking.status]?.includes(nextStatus)) return null;
  const previous=booking.status;
  if (previous==='quoted' && booking.latestQuoteId) {
    const pendingQuote=quotes.get(booking.latestQuoteId);
    if (pendingQuote && pendingQuote.status==='pending') {
      pendingQuote.status='withdrawn';
      quotes.set(pendingQuote.id,pendingQuote);
    }
  }
  booking.status=nextStatus;
  if (nextStatus==='confirmed') {
    booking.confirmedStartAt=booking.requestedStartAt;
    booking.confirmedEndAt=booking.requestedEndAt;
  }
  booking.updatedAt=new Date().toISOString();
  bookings.set(bookingId,booking);
  const list=events.get(bookingId)||[];
  list.push({fromStatus:previous,toStatus:nextStatus,actorUserId:actorId,note,createdAt:new Date().toISOString()});
  events.set(bookingId,list);
  pushMemoryNotification(booking.customerUserId,'booking_status','Booking update','Your booking status is now '+nextStatus+'.',bookingId);
  return booking;
}

export async function cancelCustomerBooking(userId,bookingId,note=null) {
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query('SELECT business_id,status,latest_quote_id FROM bookings WHERE id=$1 AND customer_user_id=$2 FOR UPDATE',[bookingId,userId]);
    const row=selected.rows[0];
    if (!row||!['requested','quoted','confirmed'].includes(row.status)) return {missing:true};
    if (row.latest_quote_id) await client.query("UPDATE booking_quotes SET status='withdrawn' WHERE id=$1 AND status='pending'",[row.latest_quote_id]);
    const updated=await client.query("UPDATE bookings SET status='cancelled',updated_at=now() WHERE id=$1 AND customer_user_id=$2 RETURNING *",[bookingId,userId]);
    await client.query("INSERT INTO booking_status_events (business_id,booking_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,$3,'cancelled',$4,$5)",[row.business_id,bookingId,row.status,userId,note]);
    await client.query("INSERT INTO notifications (user_id,notification_type,title,body,resource_type,resource_id) SELECT bm.user_id,'booking_cancelled','Booking cancelled','A customer cancelled a booking.','booking',$1 FROM business_memberships bm WHERE bm.business_id=$2 AND bm.status='active'",[bookingId,row.business_id]);
    return updated.rows[0];
  });
  if (result!==null) return result?.missing ? null : (result ? mapBooking(result) : null);
  const booking=await getCustomerBooking(userId,bookingId);
  if (!booking||!['requested','quoted','confirmed'].includes(booking.status)) return null;
  const previous=booking.status;
  if (booking.latestQuoteId) {
    const pendingQuote=quotes.get(booking.latestQuoteId);
    if (pendingQuote && pendingQuote.status==='pending') {
      pendingQuote.status='withdrawn';
      quotes.set(pendingQuote.id,pendingQuote);
    }
  }
  booking.status='cancelled';
  bookings.set(bookingId,booking);
  const list=events.get(bookingId)||[];
  list.push({fromStatus:previous,toStatus:'cancelled',actorUserId:userId,note,createdAt:new Date().toISOString()});
  events.set(bookingId,list);
  for (const member of await listBusinessMembers(booking.businessId)) {
    pushMemoryNotification(member.userId,'booking_cancelled','Booking cancelled','A customer cancelled a booking.',bookingId);
  }
  return booking;
}

export async function listBookingEvents(userId,bookingId,scope='customer') {
  const booking=scope==='customer'
    ? await getCustomerBooking(userId,bookingId)
    : await getBusinessBooking(userId,bookingId);
  if (!booking) return null;
  const result=await queryDatabase(
    'SELECT from_status,to_status,actor_user_id,note,created_at FROM booking_status_events WHERE business_id=$1 AND booking_id=$2 ORDER BY created_at ASC',
    [booking.businessId,bookingId]
  );
  if (result) return result.rows.map(row=>({
    fromStatus:row.from_status,toStatus:row.to_status,actorUserId:row.actor_user_id,
    note:row.note,createdAt:new Date(row.created_at).toISOString()
  }));
  return events.get(bookingId)||[];
}

export async function listNotifications(userId) {
  const result=await queryDatabase(
    'SELECT id,notification_type,title,body,resource_type,resource_id,read_at,created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',
    [userId]
  );
  if (result) return result.rows.map(row=>({
    id:row.id,type:row.notification_type,title:row.title,body:row.body,
    resourceType:row.resource_type,resourceId:row.resource_id,
    readAt:row.read_at?new Date(row.read_at).toISOString():null,
    createdAt:new Date(row.created_at).toISOString()
  }));
  return [...notifications.values()].filter(item=>item.userId===userId)
    .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,100);
}

export async function markNotificationRead(userId,id) {
  const result=await queryDatabase(
    'UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2 AND read_at IS NULL RETURNING id',
    [id,userId]
  );
  if (result) return result.rowCount>0;
  const item=notifications.get(id);
  if (!item || item.userId!==userId || item.readAt) return false;
  item.readAt=new Date().toISOString();
  notifications.set(id,item);
  return true;
}
