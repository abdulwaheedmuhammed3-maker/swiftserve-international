import { createHash, randomUUID } from 'node:crypto';
import { queryDatabase, withDatabaseTransaction } from './repository.js';

const profiles = new Map();
const skills = new Map();
const areas = new Map();
const availability = new Map();
const businessProviders = new Map();
const invitations = new Map();

const categories = new Set(['cleaning','laundry','electrical','plumbing','ac-repair','appliance-repair','errand']);

function mapProfile(row) {
  if (!row) return null;
  return {
    userId: row.user_id, displayName: row.display_name, phoneE164: row.phone_e164,
    bio: row.bio, countryCode: row.country_code, timeZone: row.time_zone,
    onboardingStatus: row.onboarding_status, verificationStatus: row.verification_status,
    verificationNote: row.verification_note,
    verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null
  };
}

function areaMatches(address,area) {
  if(!area||area.isActive===false||area.countryCode!==address.countryCode)return false;
  if(area.city&&area.city.toLowerCase()!==String(address.city||'').toLowerCase())return false;
  if(area.region&&area.region.toLowerCase()!==String(address.region||'').toLowerCase())return false;
  if(area.postalCodePrefix&&!String(address.postalCode||'').toLowerCase().startsWith(area.postalCodePrefix.toLowerCase()))return false;
  return Boolean(area.city||area.region||area.postalCodePrefix);
}

function mapArea(row) {
  return {
    id: row.id, providerUserId: row.provider_user_id, countryCode: row.country_code,
    region: row.region, city: row.city, postalCodePrefix: row.postal_code_prefix,
    isActive: row.is_active
  };
}

export async function initializeProviderProfile(user, countryCode) {
  const result = await queryDatabase(
    "INSERT INTO provider_profiles (user_id,display_name,country_code,time_zone) VALUES ($1,$2,$3,'UTC') ON CONFLICT (user_id) DO NOTHING",
    [user.id,user.fullName,countryCode.toUpperCase()]
  );
  if (result) {
    const found = await queryDatabase('SELECT * FROM provider_profiles WHERE user_id=$1 LIMIT 1',[user.id]);
    return mapProfile(found.rows[0]);
  }
  const current = profiles.get(user.id);
  if (current) return current;
  const profile = {
    userId:user.id,displayName:user.fullName,phoneE164:null,bio:null,
    countryCode:countryCode.toUpperCase(),timeZone:'UTC',
    onboardingStatus:'incomplete',verificationStatus:'unverified',
    verificationNote:null,verifiedAt:null
  };
  profiles.set(user.id,profile);
  return profile;
}

export async function getProviderProfile(user) {
  const result = await queryDatabase('SELECT * FROM provider_profiles WHERE user_id=$1 LIMIT 1',[user.id]);
  if (result) {
    if (result.rows[0]) return mapProfile(result.rows[0]);
    return null;
  }
  return profiles.get(user.id) || null;
}

export async function updateProviderProfile(userId,patch) {
  const columns={displayName:'display_name',phoneE164:'phone_e164',bio:'bio',countryCode:'country_code',timeZone:'time_zone'};
  const entries=Object.entries(patch).filter(([key])=>Object.prototype.hasOwnProperty.call(columns,key));
  if(!entries.length)return getProviderProfile({id:userId});
  const result=await queryDatabase(
    'UPDATE provider_profiles SET '+entries.map(([key],i)=>columns[key]+'=$'+(i+2)).join(',')+
    ',updated_at=now() WHERE user_id=$1 RETURNING *',
    [userId,...entries.map(([,value])=>value)]
  );
  if(result)return mapProfile(result.rows[0]);
  const current=profiles.get(userId);
  if(!current)return null;
  const updated={...current,...patch};
  profiles.set(userId,updated);
  return updated;
}

export async function listProviderSkills(userId) {
  const result=await queryDatabase('SELECT category,years_experience,is_active FROM provider_skills WHERE provider_user_id=$1 ORDER BY category',[userId]);
  if(result)return result.rows.map(row=>({category:row.category,yearsExperience:row.years_experience,isActive:row.is_active}));
  return skills.get(userId)||[];
}

export async function replaceProviderSkills(userId,items) {
  const result=await withDatabaseTransaction(async client=>{
    await client.query('DELETE FROM provider_skills WHERE provider_user_id=$1',[userId]);
    for(const item of items)await client.query(
      'INSERT INTO provider_skills (provider_user_id,category,years_experience,is_active) VALUES ($1,$2,$3,true)',
      [userId,item.category,item.yearsExperience]
    );
    return true;
  });
  if(result!==null)return items;
  skills.set(userId,items);
  return items;
}

export async function listProviderAreas(userId) {
  const result=await queryDatabase('SELECT * FROM provider_service_areas WHERE provider_user_id=$1 ORDER BY country_code,city,region',[userId]);
  if(result)return result.rows.map(mapArea);
  return [...areas.values()].filter(item=>item.providerUserId===userId);
}

export async function createProviderArea(userId,input) {
  const result=await queryDatabase(
    'INSERT INTO provider_service_areas (id,provider_user_id,country_code,region,city,postal_code_prefix,is_active) VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING *',
    [randomUUID(),userId,input.countryCode,input.region??null,input.city??null,input.postalCodePrefix??null]
  );
  if(result)return mapArea(result.rows[0]);
  const item={id:randomUUID(),providerUserId:userId,...input,isActive:true};
  areas.set(item.id,item);
  return item;
}

export async function deleteProviderArea(userId,id) {
  const result=await queryDatabase('DELETE FROM provider_service_areas WHERE id=$1 AND provider_user_id=$2',[id,userId]);
  if(result)return result.rowCount>0;
  const item=areas.get(id);
  if(!item||item.providerUserId!==userId)return false;
  return areas.delete(id);
}

export async function listProviderAvailability(userId) {
  const result=await queryDatabase('SELECT day_of_week,opens_at,closes_at,is_available FROM provider_availability WHERE provider_user_id=$1 ORDER BY day_of_week',[userId]);
  if(result)return result.rows.map(row=>({
    dayOfWeek:row.day_of_week,opensAt:row.opens_at,closesAt:row.closes_at,isAvailable:row.is_available
  }));
  return availability.get(userId)||[];
}

export async function replaceProviderAvailability(userId,items) {
  const result=await withDatabaseTransaction(async client=>{
    await client.query('DELETE FROM provider_availability WHERE provider_user_id=$1',[userId]);
    for(const item of items)await client.query(
      'INSERT INTO provider_availability (id,provider_user_id,day_of_week,opens_at,closes_at,is_available) VALUES ($1,$2,$3,$4,$5,$6)',
      [randomUUID(),userId,item.dayOfWeek,item.opensAt??null,item.closesAt??null,item.isAvailable]
    );
    return true;
  });
  if(result!==null)return items;
  availability.set(userId,items);
  return items;
}

export async function requestProviderVerification(userId) {
  const result=await withDatabaseTransaction(async client=>{
    const check=await client.query(
      'SELECT EXISTS(SELECT 1 FROM provider_skills WHERE provider_user_id=$1 AND is_active=true) AS skills, EXISTS(SELECT 1 FROM provider_service_areas WHERE provider_user_id=$1 AND is_active=true) AS areas, EXISTS(SELECT 1 FROM provider_availability WHERE provider_user_id=$1 AND is_available=true) AS availability',
      [userId]
    );
    const row=check.rows[0];
    if(!row.skills||!row.areas||!row.availability)return {incomplete:true};
    const updated=await client.query(
      "UPDATE provider_profiles SET onboarding_status='submitted',verification_status='pending_review',verification_note=NULL,updated_at=now() WHERE user_id=$1 RETURNING *",
      [userId]
    );
    return {profile:updated.rows[0]};
  });
  if(result!==null)return result.incomplete
    ? {error:'Complete at least one skill, service area and availability day before submitting.'}
    : {profile:mapProfile(result.profile)};
  const profile=profiles.get(userId);
  const hasSkills=(skills.get(userId)||[]).length>0;
  const hasAreas=[...areas.values()].some(item=>item.providerUserId===userId);
  const hasAvailability=(availability.get(userId)||[]).some(item=>item.isAvailable);
  if(!profile||!hasSkills||!hasAreas||!hasAvailability)return {error:'Complete at least one skill, service area and availability day before submitting.'};
  const updated={...profile,onboardingStatus:'submitted',verificationStatus:'pending_review',verificationNote:null};
  profiles.set(userId,updated);
  return {profile:updated};
}

export async function reviewProviderVerification(userId,status,note) {
  const result=await withDatabaseTransaction(async client=>{
    const current=await client.query('SELECT verification_status FROM provider_profiles WHERE user_id=$1 FOR UPDATE',[userId]);
    if(!current.rows[0])return null;
    const updated=await client.query(
      "UPDATE provider_profiles SET verification_status=$2,onboarding_status=CASE WHEN $2='verified' THEN 'active' ELSE 'submitted' END,verification_note=$3,verified_at=CASE WHEN $2='verified' THEN now() ELSE NULL END,verified_by_user_id=NULL,updated_at=now() WHERE user_id=$1 RETURNING *",
      [userId,status,note??null]
    );
    await client.query(
      'INSERT INTO provider_status_events (provider_user_id,from_status,to_status,actor_user_id,note) VALUES ($1,$2,$3,NULL,$4)',
      [userId,current.rows[0].verification_status,status,note??null]
    );
    return updated.rows[0];
  });
  if(result!==null)return result?mapProfile(result):null;
  const profile=profiles.get(userId);
  if(!profile)return null;
  const updated={...profile,verificationStatus:status,onboardingStatus:status==='verified'?'active':'submitted',
    verificationNote:note??null,verifiedAt:status==='verified'?new Date().toISOString():null};
  profiles.set(userId,updated);
  return updated;
}

export async function listBusinessProviders(businessId) {
  const result=await queryDatabase(
    'SELECT bp.provider_user_id,bp.status,bp.created_at,u.email,u.full_name,p.display_name,p.country_code,p.time_zone,p.onboarding_status,p.verification_status FROM business_provider_memberships bp JOIN users u ON u.id=bp.provider_user_id JOIN provider_profiles p ON p.user_id=bp.provider_user_id WHERE bp.business_id=$1 ORDER BY bp.created_at DESC',
    [businessId]
  );
  if(result)return result.rows.map(row=>({
    userId:row.provider_user_id,email:row.email,fullName:row.full_name,displayName:row.display_name,
    countryCode:row.country_code,timeZone:row.time_zone,membershipStatus:row.status,
    onboardingStatus:row.onboarding_status,verificationStatus:row.verification_status,
    createdAt:new Date(row.created_at).toISOString()
  }));
  return [...businessProviders.values()].filter(item=>item.businessId===businessId);
}

export async function createProviderInvitation(businessId,email,invitedByUserId) {
  const token=randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
  const tokenHash=createHash('sha256').update(token).digest('hex');
  const expiresAt=new Date(Date.now()+7*24*60*60*1000).toISOString();
  const result=await queryDatabase(
    "INSERT INTO provider_invitations (id,business_id,email,token_hash,invited_by_user_id,status,expires_at) VALUES ($1,$2,$3,$4,$5,'pending',$6) ON CONFLICT (business_id,email) DO UPDATE SET token_hash=EXCLUDED.token_hash,invited_by_user_id=EXCLUDED.invited_by_user_id,status='pending',expires_at=EXCLUDED.expires_at,accepted_by_user_id=NULL,accepted_at=NULL,created_at=now() RETURNING id,business_id,email,status,expires_at",
    [randomUUID(),businessId,email,tokenHash,invitedByUserId,expiresAt]
  );
  let invitation;
  if(result){
    const row=result.rows[0];
    invitation={id:row.id,businessId:row.business_id,email:row.email,status:row.status,expiresAt:new Date(row.expires_at).toISOString()};
  }else{
    const prior=[...invitations.values()].find(item=>item.businessId===businessId&&item.email===email);
    invitation={id:prior?.id??randomUUID(),businessId,email,status:'pending',expiresAt};
    invitations.set(invitation.id,{...invitation,tokenHash});
  }
  return {invitation,invitationToken:token};
}

export async function listProviderInvitations(businessId) {
  const result=await queryDatabase('SELECT id,business_id,email,status,expires_at,created_at FROM provider_invitations WHERE business_id=$1 ORDER BY created_at DESC',[businessId]);
  if(result)return result.rows.map(row=>({
    id:row.id,businessId:row.business_id,email:row.email,status:row.status,
    expiresAt:new Date(row.expires_at).toISOString(),createdAt:new Date(row.created_at).toISOString()
  }));
  return [...invitations.values()].filter(item=>item.businessId===businessId).map(({tokenHash,...item})=>item);
}

export async function revokeProviderInvitation(businessId,id) {
  const result=await queryDatabase("UPDATE provider_invitations SET status='revoked' WHERE id=$1 AND business_id=$2 AND status='pending' RETURNING id",[id,businessId]);
  if(result)return result.rowCount>0;
  const item=invitations.get(id);
  if(!item||item.businessId!==businessId||item.status!=='pending')return false;
  item.status='revoked';
  return true;
}

export async function acceptProviderInvitation(token,user) {
  const tokenHash=createHash('sha256').update(token).digest('hex');
  const result=await withDatabaseTransaction(async client=>{
    const selected=await client.query(
      "SELECT id,business_id FROM provider_invitations WHERE token_hash=$1 AND email=$2 AND status='pending' AND expires_at>now() FOR UPDATE",
      [tokenHash,user.email]
    );
    const invite=selected.rows[0];
    if(!invite)return null;
    const profile=await client.query('SELECT user_id FROM provider_profiles WHERE user_id=$1',[user.id]);
    if(!profile.rows[0])return {missingProfile:true};
    await client.query(
      "INSERT INTO business_provider_memberships (id,business_id,provider_user_id,invited_by_user_id,status) VALUES ($1,$2,$3,NULL,'active') ON CONFLICT (business_id,provider_user_id) DO UPDATE SET status='active',updated_at=now()",
      [randomUUID(),invite.business_id,user.id]
    );
    await client.query("UPDATE provider_invitations SET status='accepted',accepted_by_user_id=$2,accepted_at=now() WHERE id=$1",[invite.id,user.id]);
    return {businessId:invite.business_id};
  });
  if(result!==null)return result?.missingProfile?null:result;
  const invite=[...invitations.values()].find(item=>item.tokenHash===tokenHash&&item.email===user.email&&item.status==='pending'&&new Date(item.expiresAt)>new Date());
  if(!invite||!profiles.has(user.id))return null;
  const member={businessId:invite.businessId,providerUserId:user.id,status:'active'};
  businessProviders.set(invite.businessId+':'+user.id,member);
  invitations.set(invite.id,{...invite,status:'accepted'});
  return {businessId:invite.businessId};
}

export async function getProviderAssignmentReadiness(providerUserId,businessId,category,address) {
  const result=await queryDatabase(
    "SELECT p.time_zone,p.verification_status,p.onboarding_status,bp.id AS membership_id " +
    "FROM provider_profiles p JOIN business_provider_memberships bp ON bp.provider_user_id=p.user_id " +
    "WHERE p.user_id=$1 AND bp.business_id=$2 AND bp.status='active' LIMIT 1",
    [providerUserId,businessId]
  );
  if(result){
    const provider=result.rows[0];
    if(!provider)return {error:'This provider is not an active member of this business.'};
    if(provider.verification_status!=='verified'||provider.onboarding_status!=='active')
      return {error:'Only verified and active providers can receive assignments.'};
    const skill=await queryDatabase(
      'SELECT 1 FROM provider_skills WHERE provider_user_id=$1 AND category=$2 AND is_active=true LIMIT 1',
      [providerUserId,category]
    );
    if(!skill.rows[0])return {error:'The provider does not list the required service skill.'};
    const area=await queryDatabase(
      "SELECT 1 FROM provider_service_areas WHERE provider_user_id=$1 AND is_active=true AND country_code=$2 AND (city IS NULL OR lower(city)=lower($3)) AND (region IS NULL OR lower(region)=lower(coalesce($4,''))) AND (postal_code_prefix IS NULL OR left(lower(coalesce($5,'')),length(postal_code_prefix))=lower(postal_code_prefix)) LIMIT 1",
      [providerUserId,address.countryCode,address.city,address.region,address.postalCode]
    );
    if(!area.rows[0])return {error:'The provider does not cover the booking address.'};
    const schedule=await queryDatabase(
      "SELECT day_of_week,opens_at,closes_at FROM provider_availability WHERE provider_user_id=$1 AND is_available=true ORDER BY day_of_week",
      [providerUserId]
    );
    return {timeZone:provider.time_zone,membershipId:provider.membership_id,availability:schedule.rows};
  }

  const profile=profiles.get(providerUserId);
  const member=businessProviders.get(businessId+':'+providerUserId);
  if(!profile||!member||member.status!=='active')return {error:'This provider is not an active member of this business.'};
  if(profile.verificationStatus!=='verified'||profile.onboardingStatus!=='active')
    return {error:'Only verified and active providers can receive assignments.'};
  if(!(skills.get(providerUserId)||[]).some(item=>item.category===category&&item.isActive!==false))
    return {error:'The provider does not list the required service skill.'};
  if(![...areas.values()].some(item=>item.providerUserId===providerUserId&&areaMatches(address,item)))
    return {error:'The provider does not cover the booking address.'};
  return {timeZone:profile.timeZone||'UTC',membershipId:null,availability:availability.get(providerUserId)||[]};
}

export function isProviderCategory(category){return categories.has(category);}
