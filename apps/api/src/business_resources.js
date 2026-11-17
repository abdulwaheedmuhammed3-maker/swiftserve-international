import { randomUUID, createHash } from 'node:crypto';
import { addBusinessMember, queryDatabase } from './repository.js';

const services = new Map();
const branches = new Map();
const hours = new Map();
const areas = new Map();
const invitations = new Map();

function scoped(map, businessId) {
  return [...map.values()].filter(item => item.businessId === businessId);
}

function mapService(row) {
  return {
    id: row.id, businessId: row.business_id, category: row.category,
    name: row.name, slug: row.slug, description: row.description,
    pricingModel: row.pricing_model, currencyCode: row.currency_code,
    priceMinor: row.price_minor === null ? null : Number(row.price_minor),
    durationMinutes: row.duration_minutes, isActive: row.is_active,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

function mapBranch(row) {
  return {
    id: row.id, businessId: row.business_id, name: row.name,
    countryCode: row.country_code, addressLine1: row.address_line1,
    addressLine2: row.address_line2, city: row.city, region: row.region,
    postalCode: row.postal_code, phoneE164: row.phone_e164,
    timeZone: row.time_zone, isPrimary: row.is_primary, status: row.status,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

function mapHour(row) {
  return {
    id: row.id, businessId: row.business_id, branchId: row.branch_id,
    dayOfWeek: row.day_of_week, opensAt: row.opens_at,
    closesAt: row.closes_at, isClosed: row.is_closed
  };
}

function mapArea(row) {
  return {
    id: row.id, businessId: row.business_id, branchId: row.branch_id,
    countryCode: row.country_code, region: row.region, city: row.city,
    postalCodePrefix: row.postal_code_prefix, isActive: row.is_active
  };
}

function mapInvitation(row) {
  return {
    id: row.id, businessId: row.business_id, email: row.email,
    role: row.role, invitedByUserId: row.invited_by_user_id,
    acceptedByUserId: row.accepted_by_user_id, status: row.status,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    acceptedAt: row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null
  };
}

export async function listServices(businessId, includeInactive = true) {
  const result = await queryDatabase(
    'SELECT * FROM business_services WHERE business_id=$1 ' +
    (includeInactive ? '' : 'AND is_active=true ') + 'ORDER BY name',
    [businessId]
  );
  if (result) return result.rows.map(mapService);
  return scoped(services, businessId).filter(item => includeInactive || item.isActive);
}

export async function createService(businessId, input) {
  const item = { id: randomUUID(), businessId, ...input, isActive: true };
  const result = await queryDatabase(
    'INSERT INTO business_services (id,business_id,category,name,slug,description,pricing_model,currency_code,price_minor,duration_minutes,is_active) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true) RETURNING *',
    [item.id,businessId,item.category,item.name,item.slug,item.description,item.pricingModel,
      item.currencyCode,item.priceMinor,item.durationMinutes]
  );
  if (result) return mapService(result.rows[0]);
  services.set(item.id, item);
  return item;
}

export async function getService(businessId, id) {
  const result = await queryDatabase(
    'SELECT * FROM business_services WHERE id=$1 AND business_id=$2 LIMIT 1',
    [id,businessId]
  );
  if (result) return result.rows[0] ? mapService(result.rows[0]) : null;
  const item = services.get(id);
  return item && item.businessId === businessId ? item : null;
}

export async function updateService(businessId, id, patch) {
  const columns = {
    category:'category', name:'name', slug:'slug', description:'description',
    pricingModel:'pricing_model', currencyCode:'currency_code',
    priceMinor:'price_minor', durationMinutes:'duration_minutes', isActive:'is_active'
  };
  const entries = Object.entries(patch).filter(([key]) => Object.prototype.hasOwnProperty.call(columns,key));
  if (!entries.length) return getService(businessId,id);
  const assignments = entries.map(([key],index) => columns[key] + '=$' + (index+3));
  const result = await queryDatabase(
    'UPDATE business_services SET ' + assignments.join(',') + ',updated_at=now() WHERE id=$1 AND business_id=$2 RETURNING *',
    [id,businessId,...entries.map(([,value])=>value)]
  );
  if (result) return result.rows[0] ? mapService(result.rows[0]) : null;
  const current = await getService(businessId,id);
  if (!current) return null;
  const updated = { ...current, ...patch, updatedAt:new Date().toISOString() };
  services.set(id,updated);
  return updated;
}

export async function deleteService(businessId,id) {
  const result = await queryDatabase('DELETE FROM business_services WHERE id=$1 AND business_id=$2',[id,businessId]);
  if (result) return result.rowCount > 0;
  const item=services.get(id);
  return Boolean(item && item.businessId===businessId && services.delete(id));
}

export async function listBranches(businessId) {
  const result=await queryDatabase('SELECT * FROM business_branches WHERE business_id=$1 ORDER BY is_primary DESC,name',[businessId]);
  if (result) return result.rows.map(mapBranch);
  return scoped(branches,businessId).sort((a,b)=>Number(b.isPrimary)-Number(a.isPrimary));
}

export async function getBranch(businessId,id) {
  const result=await queryDatabase('SELECT * FROM business_branches WHERE id=$1 AND business_id=$2 LIMIT 1',[id,businessId]);
  if (result) return result.rows[0] ? mapBranch(result.rows[0]) : null;
  const item=branches.get(id);
  return item && item.businessId===businessId ? item : null;
}

export async function createBranch(businessId,input) {
  const item={id:randomUUID(),businessId,...input,status:'active'};
  if (item.isPrimary) {
    await queryDatabase('UPDATE business_branches SET is_primary=false,updated_at=now() WHERE business_id=$1',[businessId]);
  }
  const result=await queryDatabase(
    'INSERT INTO business_branches (id,business_id,name,country_code,address_line1,address_line2,city,region,postal_code,phone_e164,time_zone,is_primary,status) '+
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
    [item.id,businessId,item.name,item.countryCode,item.addressLine1,item.addressLine2??null,item.city,
      item.region??null,item.postalCode??null,item.phoneE164??null,item.timeZone??null,Boolean(item.isPrimary),'active']
  );
  if (result) return mapBranch(result.rows[0]);
  if (item.isPrimary) for (const old of scoped(branches,businessId)) old.isPrimary=false;
  branches.set(item.id,item);
  return item;
}

export async function updateBranch(businessId,id,patch) {
  const columns={name:'name',countryCode:'country_code',addressLine1:'address_line1',
    addressLine2:'address_line2',city:'city',region:'region',postalCode:'postal_code',
    phoneE164:'phone_e164',timeZone:'time_zone',isPrimary:'is_primary',status:'status'};
  const entries=Object.entries(patch).filter(([key])=>Object.prototype.hasOwnProperty.call(columns,key));
  if (!entries.length) return getBranch(businessId,id);
  const clientResult = await queryDatabase('SELECT id FROM business_branches WHERE id=$1 AND business_id=$2',[id,businessId]);
  if (clientResult) {
    if (!clientResult.rowCount) return null;
    if (patch.isPrimary===true) {
      await queryDatabase('UPDATE business_branches SET is_primary=false,updated_at=now() WHERE business_id=$1',[businessId]);
    }
    const assignments=entries.map(([key,index])=>columns[key]+'=$'+(index+3));
    const updated=await queryDatabase(
      'UPDATE business_branches SET '+assignments.join(',')+',updated_at=now() WHERE id=$1 AND business_id=$2 RETURNING *',
      [id,businessId,...entries.map(([,value])=>value)]
    );
    return updated.rows[0] ? mapBranch(updated.rows[0]) : null;
  }
  const current=await getBranch(businessId,id);
  if (!current) return null;
  if (patch.isPrimary===true) for (const old of scoped(branches,businessId)) old.isPrimary=false;
  const updated={...current,...patch,updatedAt:new Date().toISOString()};
  branches.set(id,updated);
  return updated;
}

export async function deleteBranch(businessId,id) {
  const result=await queryDatabase('DELETE FROM business_branches WHERE id=$1 AND business_id=$2',[id,businessId]);
  if (result) return result.rowCount>0;
  const item=branches.get(id);
  if (!item || item.businessId!==businessId) return false;
  branches.delete(id);
  for (const [key,hour] of hours) if (hour.branchId===id) hours.delete(key);
  for (const [key,area] of areas) if (area.branchId===id) areas.delete(key);
  return true;
}

export async function listHours(businessId,branchId=null) {
  const result=await queryDatabase(
    'SELECT * FROM business_hours WHERE business_id=$1 AND (($2::uuid IS NULL AND branch_id IS NULL) OR branch_id=$2) ORDER BY day_of_week',
    [businessId,branchId]
  );
  if (result) return result.rows.map(mapHour);
  return scoped(hours,businessId).filter(item=>(item.branchId??null)===(branchId??null)).sort((a,b)=>a.dayOfWeek-b.dayOfWeek);
}

export async function setHours(businessId,input) {
  const result=await queryDatabase(
    'INSERT INTO business_hours (id,business_id,branch_id,day_of_week,opens_at,closes_at,is_closed) VALUES ($1,$2,$3,$4,$5,$6,$7) '+
    'ON CONFLICT (business_id,day_of_week) WHERE branch_id IS NULL DO UPDATE SET opens_at=EXCLUDED.opens_at,closes_at=EXCLUDED.closes_at,is_closed=EXCLUDED.is_closed,updated_at=now() '+
    'RETURNING *',
    [randomUUID(),businessId,null,input.dayOfWeek,input.opensAt??null,input.closesAt??null,Boolean(input.isClosed)]
  );
  if (result) return mapHour(result.rows[0]);
  const old=[...hours.values()].find(item=>item.businessId===businessId && item.branchId==null && item.dayOfWeek===input.dayOfWeek);
  const item={id:old?.id??randomUUID(),businessId,branchId:null,...input};
  hours.set(item.id,item);
  return item;
}

export async function setBranchHours(businessId,branchId,input) {
  const branch=await getBranch(businessId,branchId);
  if (!branch) return null;
  const existing=await queryDatabase(
    'SELECT id FROM business_hours WHERE business_id=$1 AND branch_id=$2 AND day_of_week=$3',
    [businessId,branchId,input.dayOfWeek]
  );
  if (existing) {
    if (existing.rows[0]) {
      const updated=await queryDatabase(
        'UPDATE business_hours SET opens_at=$4,closes_at=$5,is_closed=$6,updated_at=now() WHERE business_id=$1 AND branch_id=$2 AND day_of_week=$3 RETURNING *',
        [businessId,branchId,input.dayOfWeek,input.opensAt??null,input.closesAt??null,Boolean(input.isClosed)]
      );
      return mapHour(updated.rows[0]);
    }
    const created=await queryDatabase(
      'INSERT INTO business_hours (id,business_id,branch_id,day_of_week,opens_at,closes_at,is_closed) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [randomUUID(),businessId,branchId,input.dayOfWeek,input.opensAt??null,input.closesAt??null,Boolean(input.isClosed)]
    );
    return mapHour(created.rows[0]);
  }
  const old=[...hours.values()].find(item=>item.businessId===businessId && item.branchId===branchId && item.dayOfWeek===input.dayOfWeek);
  const item={id:old?.id??randomUUID(),businessId,branchId,...input};
  hours.set(item.id,item);
  return item;
}

export async function listAreas(businessId) {
  const result=await queryDatabase('SELECT * FROM business_service_areas WHERE business_id=$1 ORDER BY country_code,city,region',[businessId]);
  if (result) return result.rows.map(mapArea);
  return scoped(areas,businessId);
}

export async function createArea(businessId,input) {
  if (input.branchId && !(await getBranch(businessId,input.branchId))) return null;
  const result=await queryDatabase(
    'INSERT INTO business_service_areas (id,business_id,branch_id,country_code,region,city,postal_code_prefix,is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING *',
    [randomUUID(),businessId,input.branchId??null,input.countryCode,input.region??null,input.city??null,input.postalCodePrefix??null]
  );
  if (result) return mapArea(result.rows[0]);
  const item={id:randomUUID(),businessId,...input,isActive:true};
  areas.set(item.id,item);
  return item;
}

export async function updateArea(businessId,id,patch) {
  const columns={countryCode:'country_code',region:'region',city:'city',postalCodePrefix:'postal_code_prefix',isActive:'is_active'};
  const entries=Object.entries(patch).filter(([key])=>Object.prototype.hasOwnProperty.call(columns,key));
  if (!entries.length) {
    const all=await listAreas(businessId);
    return all.find(item=>item.id===id)??null;
  }
  const result=await queryDatabase(
    'UPDATE business_service_areas SET '+entries.map(([key],index)=>columns[key]+'=$'+(index+3)).join(',')+
    ',updated_at=now() WHERE id=$1 AND business_id=$2 RETURNING *',
    [id,businessId,...entries.map(([,value])=>value)]
  );
  if (result) return result.rows[0] ? mapArea(result.rows[0]) : null;
  const current=areas.get(id);
  if (!current || current.businessId!==businessId) return null;
  const updated={...current,...patch};
  areas.set(id,updated);
  return updated;
}

export async function deleteArea(businessId,id) {
  const result=await queryDatabase('DELETE FROM business_service_areas WHERE id=$1 AND business_id=$2',[id,businessId]);
  if (result) return result.rowCount>0;
  const current=areas.get(id);
  if (!current || current.businessId!==businessId) return false;
  return areas.delete(id);
}

export async function createInvitation(businessId,input,inviterId) {
  const token=randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
  const tokenHash=createHash('sha256').update(token).digest('hex');
  const expiresAt=new Date(Date.now()+7*24*60*60*1000).toISOString();
  const result=await queryDatabase(
    'INSERT INTO business_invitations (id,business_id,email,role,token_hash,invited_by_user_id,status,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) '+
    "ON CONFLICT (business_id,email) DO UPDATE SET role=EXCLUDED.role,token_hash=EXCLUDED.token_hash,invited_by_user_id=EXCLUDED.invited_by_user_id,status='pending',expires_at=EXCLUDED.expires_at,accepted_by_user_id=NULL,accepted_at=NULL,created_at=now() RETURNING id,business_id,email,role,status,expires_at",
    [randomUUID(),businessId,input.email,input.role,tokenHash,inviterId,'pending',expiresAt]
  );
  let invite;
  if (result) {
    const row=result.rows[0];
    invite={id:row.id,businessId:row.business_id,email:row.email,role:row.role,status:row.status,expiresAt:new Date(row.expires_at).toISOString()};
  } else {
    const prior=[...invitations.values()].find(item=>item.businessId===businessId && item.email===input.email);
    invite={id:prior?.id??randomUUID(),businessId,email:input.email,role:input.role,status:'pending',expiresAt,tokenHash};
    invitations.set(invite.id,invite);
  }
  return { invitation:invite, invitationToken:token };
}

export async function listInvitations(businessId) {
  const result=await queryDatabase('SELECT id,business_id,email,role,status,expires_at,created_at FROM business_invitations WHERE business_id=$1 ORDER BY created_at DESC',[businessId]);
  if (result) return result.rows.map(row=>({
    id:row.id,businessId:row.business_id,email:row.email,role:row.role,status:row.status,
    expiresAt:new Date(row.expires_at).toISOString(),createdAt:new Date(row.created_at).toISOString()
  }));
  return scoped(invitations,businessId).map(({tokenHash,...item})=>item);
}

export async function revokeInvitation(businessId,id) {
  const result=await queryDatabase("UPDATE business_invitations SET status='revoked' WHERE id=$1 AND business_id=$2 AND status='pending' RETURNING id",[id,businessId]);
  if (result) return result.rowCount>0;
  const item=invitations.get(id);
  if (!item || item.businessId!==businessId || item.status!=='pending') return false;
  item.status='revoked';
  return true;
}

export async function acceptInvitation(token,userId,email) {
  const hash=createHash('sha256').update(token).digest('hex');
  const selected=await queryDatabase(
    "SELECT business_id,role FROM business_invitations WHERE token_hash=$1 AND email=$2 AND status='pending' AND expires_at>now() LIMIT 1",
    [hash,email]
  );
  if (selected) {
    const invitation=selected.rows[0];
    if (!invitation) return null;
    const membership=await addBusinessMember(invitation.business_id,userId,invitation.role);
    if (!membership) return null;
    const accepted=await queryDatabase(
      "UPDATE business_invitations SET status='accepted',accepted_by_user_id=$2,accepted_at=now() WHERE token_hash=$1 AND email=$3 AND status='pending' AND expires_at>now() RETURNING business_id,role",
      [hash,userId,email]
    );
    if (!accepted.rows[0]) return null;
    return {businessId:accepted.rows[0].business_id,role:accepted.rows[0].role};
  }
  const item=[...invitations.values()].find(invite=>invite.tokenHash===hash);
  if (!item || item.email!==email || item.status!=='pending' || new Date(item.expiresAt)<=new Date()) return null;
  const membership=await addBusinessMember(item.businessId,userId,item.role);
  if (!membership) return null;
  invitations.set(item.id,{...item,status:'accepted',acceptedByUserId:userId});
  return {businessId:item.businessId,role:item.role};
}
