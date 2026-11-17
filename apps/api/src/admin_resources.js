import { randomUUID } from 'node:crypto';
import { queryDatabase, withDatabaseTransaction } from './repository.js';

const auditMemory=[];
const runMemory=new Map();
const itemMemory=new Map();

export function getAdminActorKeyId(){
  const value=String(process.env.SWIFTSERVE_ADMIN_ACTOR_ID||'shared-admin-key').trim();
  return /^[A-Za-z0-9._:-]{1,80}$/.test(value)?value:'shared-admin-key';
}

export async function writeAdminAuditEvent({action,targetType,targetId=null,outcome='succeeded',details={}}){
  const actorKeyId=getAdminActorKeyId();
  const safeDetails=details&&typeof details==='object'&&!Array.isArray(details)?details:{};
  const result=await queryDatabase(
    'INSERT INTO admin_audit_logs (actor_key_id,action,target_type,target_id,outcome,details) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *',
    [actorKeyId,String(action).slice(0,100),String(targetType).slice(0,60),targetId,outcome,JSON.stringify(safeDetails)]
  );
  if(result){
    const row=result.rows[0];
    return {
      id:row.id,actorKeyId:row.actor_key_id,action:row.action,targetType:row.target_type,
      targetId:row.target_id,outcome:row.outcome,details:row.details,
      createdAt:new Date(row.created_at).toISOString()
    };
  }
  const item={
    id:randomUUID(),actorKeyId,action:String(action).slice(0,100),
    targetType:String(targetType).slice(0,60),targetId,outcome,details:safeDetails,
    createdAt:new Date().toISOString()
  };
  auditMemory.unshift(item);
  if(auditMemory.length>1000)auditMemory.length=1000;
  return item;
}

export async function listAdminAuditEvents(limit=50){
  const safeLimit=Math.max(1,Math.min(100,Number(limit)||50));
  const result=await queryDatabase(
    'SELECT * FROM admin_audit_logs ORDER BY created_at DESC LIMIT $1',[safeLimit]
  );
  if(result)return result.rows.map(row=>({
    id:row.id,actorKeyId:row.actor_key_id,action:row.action,targetType:row.target_type,
    targetId:row.target_id,outcome:row.outcome,details:row.details,
    createdAt:new Date(row.created_at).toISOString()
  }));
  return auditMemory.slice(0,safeLimit);
}

export async function getFinanceOperationsSummary(){
  const result=await queryDatabase(
    "SELECT (SELECT COUNT(*)::int FROM payment_intents WHERE status='pending') AS pending_payments, " +
    "(SELECT COUNT(*)::int FROM payment_intents WHERE status IN ('succeeded','partially_refunded','refunded')) AS successful_payments, " +
    "(SELECT COUNT(*)::int FROM refunds WHERE status IN ('pending','processing')) AS pending_refunds, " +
    "(SELECT COUNT(*)::int FROM provider_payouts WHERE status='pending') AS pending_payouts, " +
    "(SELECT COUNT(*)::int FROM provider_payouts WHERE status='processing') AS processing_payouts, " +
    "(SELECT COUNT(*)::int FROM provider_payouts WHERE status='failed') AS failed_payouts, " +
    "(SELECT COUNT(*)::int FROM provider_payouts WHERE status='reversed') AS reversed_payouts, " +
    "(SELECT COUNT(*)::int FROM disputes WHERE status IN ('open','in_review')) AS open_disputes, " +
    "(SELECT COUNT(*)::int FROM finance_reconciliation_runs) AS reconciliation_runs"
  );
  if(result){
    const row=result.rows[0]||{};
    return Object.fromEntries(Object.entries(row).map(([key,value])=>[key,Number(value||0)]));
  }
  return {
    pending_payments:0,successful_payments:0,pending_refunds:0,pending_payouts:0,
    processing_payouts:0,failed_payouts:0,reversed_payouts:0,open_disputes:0,
    reconciliation_runs:runMemory.size
  };
}

export async function createFinanceReconciliationRun(){
  const id=randomUUID();
  const actorKeyId=getAdminActorKeyId();
  const result=await queryDatabase(
    "INSERT INTO finance_reconciliation_runs (id,provider,actor_key_id,status) VALUES ($1,'paystack',$2,'running') RETURNING *",
    [id,actorKeyId]
  );
  const item={
    id,provider:'paystack',actorKeyId,status:'running',scannedCount:0,matchedCount:0,
    updatedCount:0,pendingCount:0,reviewCount:0,errorCount:0,summary:{},
    startedAt:new Date().toISOString(),finishedAt:null
  };
  if(result){
    const row=result.rows[0];
    return {...item,startedAt:new Date(row.started_at).toISOString()};
  }
  runMemory.set(id,item);
  return item;
}

export async function listFinanceReconciliationCandidates(limit=50){
  const safeLimit=Math.max(1,Math.min(50,Number(limit)||50));
  const result=await queryDatabase(
    "SELECT entity_type,id,provider_reference,local_status,amount_minor,currency_code,created_at FROM ("+
    "SELECT 'payment'::text AS entity_type,id,provider_reference,status AS local_status,amount_minor,currency_code,created_at FROM payment_intents WHERE status='pending' "+
    "UNION ALL "+
    "SELECT 'payout'::text AS entity_type,id,transfer_reference AS provider_reference,status AS local_status,net_amount_minor AS amount_minor,currency_code,created_at FROM provider_payouts WHERE status IN ('processing','failed') AND transfer_reference IS NOT NULL "+
    "UNION ALL "+
    "SELECT 'refund'::text AS entity_type,id,provider_reference,status AS local_status,amount_minor,currency_code,created_at FROM refunds WHERE status IN ('pending','processing')"+
    ") candidates ORDER BY created_at ASC LIMIT $1",
    [safeLimit]
  );
  if(result)return result.rows.map(row=>({
    entityType:row.entity_type,id:row.id,providerReference:row.provider_reference,
    localStatus:row.local_status,amountMinor:Number(row.amount_minor),
    currencyCode:row.currency_code,createdAt:new Date(row.created_at).toISOString()
  }));
  return [];
}

export async function recordFinanceReconciliationItem(runId,item){
  const safeSnapshot=item.providerSnapshot&&typeof item.providerSnapshot==='object'&&!Array.isArray(item.providerSnapshot)
    ?item.providerSnapshot:{};
  const result=await queryDatabase(
    'INSERT INTO finance_reconciliation_items (run_id,entity_type,local_entity_id,provider_reference,local_status,provider_status,outcome,local_amount_minor,provider_amount_minor,currency_code,message,provider_snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING *',
    [runId,item.entityType,item.localEntityId,item.providerReference??null,item.localStatus??null,
      item.providerStatus??null,item.outcome,item.localAmountMinor??null,item.providerAmountMinor??null,
      item.currencyCode??null,item.message??null,JSON.stringify(safeSnapshot)]
  );
  if(result){
    const row=result.rows[0];
    return {id:row.id,runId:row.run_id,entityType:row.entity_type,localEntityId:row.local_entity_id,
      providerReference:row.provider_reference,localStatus:row.local_status,providerStatus:row.provider_status,
      outcome:row.outcome,localAmountMinor:row.local_amount_minor===null?null:Number(row.local_amount_minor),
      providerAmountMinor:row.provider_amount_minor===null?null:Number(row.provider_amount_minor),
      currencyCode:row.currency_code,message:row.message,providerSnapshot:row.provider_snapshot,
      createdAt:new Date(row.created_at).toISOString()};
  }
  const saved={id:randomUUID(),runId,...item,providerSnapshot:safeSnapshot,createdAt:new Date().toISOString()};
  const list=itemMemory.get(runId)||[];
  list.push(saved);itemMemory.set(runId,list);
  return saved;
}

export async function finishFinanceReconciliationRun(runId,items,status='completed'){
  const counts={
    scannedCount:items.length,
    matchedCount:items.filter(item=>item.outcome==='matched').length,
    updatedCount:items.filter(item=>item.outcome==='updated').length,
    pendingCount:items.filter(item=>item.outcome==='pending').length,
    reviewCount:items.filter(item=>['mismatch','manual_review','skipped'].includes(item.outcome)).length,
    errorCount:items.filter(item=>item.outcome==='error').length
  };
  const finalStatus=status==='failed'?'failed':(counts.errorCount||counts.reviewCount?'partial':'completed');
  const summary={...counts,status:finalStatus};
  const result=await queryDatabase(
    'UPDATE finance_reconciliation_runs SET status=$2,scanned_count=$3,matched_count=$4,updated_count=$5,pending_count=$6,review_count=$7,error_count=$8,summary=$9::jsonb,finished_at=now() WHERE id=$1 RETURNING *',
    [runId,finalStatus,counts.scannedCount,counts.matchedCount,counts.updatedCount,
      counts.pendingCount,counts.reviewCount,counts.errorCount,JSON.stringify(summary)]
  );
  if(result){
    const row=result.rows[0];
    return row?{
      id:row.id,provider:row.provider,actorKeyId:row.actor_key_id,status:row.status,
      scannedCount:row.scanned_count,matchedCount:row.matched_count,updatedCount:row.updated_count,
      pendingCount:row.pending_count,reviewCount:row.review_count,errorCount:row.error_count,
      summary:row.summary,startedAt:new Date(row.started_at).toISOString(),
      finishedAt:row.finished_at?new Date(row.finished_at).toISOString():null
    }:null;
  }
  const item=runMemory.get(runId);
  if(!item)return null;
  Object.assign(item,counts,{status:finalStatus,summary,finishedAt:new Date().toISOString()});
  runMemory.set(runId,item);
  return item;
}

export async function listFinanceReconciliationRuns(limit=20){
  const safeLimit=Math.max(1,Math.min(100,Number(limit)||20));
  const result=await queryDatabase(
    'SELECT * FROM finance_reconciliation_runs ORDER BY started_at DESC LIMIT $1',[safeLimit]
  );
  if(result)return result.rows.map(row=>({
    id:row.id,provider:row.provider,actorKeyId:row.actor_key_id,status:row.status,
    scannedCount:row.scanned_count,matchedCount:row.matched_count,updatedCount:row.updated_count,
    pendingCount:row.pending_count,reviewCount:row.review_count,errorCount:row.error_count,
    summary:row.summary,startedAt:new Date(row.started_at).toISOString(),
    finishedAt:row.finished_at?new Date(row.finished_at).toISOString():null
  }));
  return [...runMemory.values()].sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).slice(0,safeLimit);
}

export async function getFinanceReconciliationRun(id){
  const result=await queryDatabase('SELECT * FROM finance_reconciliation_runs WHERE id=$1',[id]);
  if(result){
    const row=result.rows[0];
    if(!row)return null;
    const items=await queryDatabase(
      'SELECT * FROM finance_reconciliation_items WHERE run_id=$1 ORDER BY created_at',[id]
    );
    return {
      id:row.id,provider:row.provider,actorKeyId:row.actor_key_id,status:row.status,
      scannedCount:row.scanned_count,matchedCount:row.matched_count,updatedCount:row.updated_count,
      pendingCount:row.pending_count,reviewCount:row.review_count,errorCount:row.error_count,
      summary:row.summary,startedAt:new Date(row.started_at).toISOString(),
      finishedAt:row.finished_at?new Date(row.finished_at).toISOString():null,
      items:(items?.rows||[]).map(item=>({
        id:item.id,entityType:item.entity_type,localEntityId:item.local_entity_id,
        providerReference:item.provider_reference,localStatus:item.local_status,
        providerStatus:item.provider_status,outcome:item.outcome,
        localAmountMinor:item.local_amount_minor===null?null:Number(item.local_amount_minor),
        providerAmountMinor:item.provider_amount_minor===null?null:Number(item.provider_amount_minor),
        currencyCode:item.currency_code,message:item.message,providerSnapshot:item.provider_snapshot,
        createdAt:new Date(item.created_at).toISOString()
      }))
    };
  }
  const run=runMemory.get(id);
  return run?{...run,items:itemMemory.get(id)||[]}:null;
}

export async function markPayoutReconciled(id){
  const result=await queryDatabase(
    'UPDATE provider_payouts SET last_reconciled_at=now(),updated_at=now() WHERE id=$1 RETURNING id',[id]
  );
  return result?result.rowCount>0:false;
}
