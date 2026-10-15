import { randomUUID } from 'node:crypto';
import { Problem, transaction, lock, enqueue, unseal } from './core.js';
import { processPayment,recoverPreference } from './billing.js';

export async function recordWebhook(db,deliveryKey,paymentId) {
  return transaction(db,async c=>{
    const {rows}=await c.query(`insert into billing.events(delivery_key,resource_id) values($1,$2)
      on conflict(delivery_key) do update set delivery_key=excluded.delivery_key returning id`,[deliveryKey,paymentId]);
    await enqueue(c,'payment',`event:${rows[0].id}`,{paymentId,eventId:rows[0].id});
    // A duplicate must revive a previously exhausted job, not discard a failed delivery forever.
    await c.query(`update billing.jobs set state='pending',attempts=0,available_at=now(),error_code=null
      where key=$1 and state='dead'`,[`event:${rows[0].id}`]);
  });
}
export async function scheduleReconciliation(db) {
  return transaction(db,async c=>{
    await c.query(`update billing.orders set checkout_status='unknown',needs_review=true,updated_at=now()
      where checkout_status='creating' and created_at<now()-interval '90 seconds'`);
    await c.query(`update billing.orders set financial_status='expired',checkout_status='closed',updated_at=now()
      where financial_status='pending' and checkout_status='ready' and checkout_expires_at<now()`);
    const {rows}=await c.query(`select id,created_at from billing.orders where next_reconcile_at<=now() order by next_reconcile_at,id limit 20 for update skip locked`);
    for(const order of rows){
      if(new Date(order.created_at).getTime()<Date.now()-180*86400000){
        await c.query('update billing.orders set next_reconcile_at=null where id=$1',[order.id]);continue;
      }
      await enqueue(c,'reconcile',`scheduled:${order.id}:${Math.floor(Date.now()/900000)}`,{orderId:order.id,offset:0});
      await c.query(`update billing.orders set next_reconcile_at=now()+case when financial_status='approved' then interval '1 day' else interval '15 minutes' end where id=$1`,[order.id]);
    }
    // Operational data only. Never remove financial history or acquired rights.
    await c.query(`delete from billing.rate_limits where resets_at<now()-interval '1 day'`);
    await c.query(`delete from billing.auth_flows where expires_at<now()-interval '1 day'`);
    await c.query(`delete from billing.sessions where expires_at<now()`);
    await c.query(`delete from billing.jobs where state='done' and finished_at<now()-interval '30 days'`);
    await c.query(`delete from billing.events where processed_at<now()-interval '30 days'`);
    return rows.length;
  });
}
export async function processJob(db,cfg,providers,job) {
  if(job.kind==='payment'){
    await processPayment(db,cfg,providers.mp,job.payload.paymentId);
    if(job.payload.eventId)await db.query('update billing.events set processed_at=now() where id=$1',[job.payload.eventId]);
  }else if(job.kind==='reconcile'){
    const order=(await db.query('select * from billing.orders where id=$1',[job.payload.orderId])).rows[0];
    if(!order)return;
    if(order.checkout_status==='unknown')await recoverPreference(db,cfg,providers.mp,order);
    const offset=Number(job.payload.offset??0);
    if(!Number.isInteger(offset)||offset<0||offset>1000)throw new Problem(422,'reconcile_page_limit');
    const page=await providers.mp.searchPayments(order.id,offset);
    if(!Array.isArray(page.results)||page.results.length>50)throw new Problem(422,'invalid_search_response');
    await transaction(db,async c=>{
      for(const p of page.results){
        if(!/^\d{1,30}$/.test(String(p.id)))throw new Problem(422,'invalid_payment_id');
        await enqueue(c,'payment',`reconcile-payment:${job.id}:${p.id}`,{paymentId:String(p.id)});
      }
      if(page.results.length===50&&offset+50<Number(page.paging?.total??0)){
        if(offset>=950){await c.query('update billing.orders set needs_review=true where id=$1',[order.id]);return;}
        await enqueue(c,'reconcile',`page:${job.id}:${offset+50}`,{orderId:order.id,offset:offset+50});
      }
    });
  }else if(job.kind==='email'){
    // Transaction lock prevents resend/refund from invalidating the challenge mid-send.
    await transaction(db,async c=>{
      const grant=(await c.query(`select g.*,o.financial_status,p.name from billing.grants g
        join billing.orders o on o.id=g.order_id join billing.products p on p.id=g.product_id
        where g.id=$1 for update of g`,[job.payload.grantId])).rows[0];
      const challenge=(await c.query('select * from billing.activation_challenges where id=$1 for update',[job.payload.challengeId])).rows[0];
      if(!grant||!challenge||grant.revoked_at||grant.activated_at||grant.financial_status!=='approved'||
        challenge.invalidated_at||challenge.consumed_at||new Date(challenge.expires_at)<=new Date())return;
      // Delivery follows current confirmed Auth identity, never payer e-mail or frontend input.
      const owner=(await c.query('select email,email_confirmed_at from auth.users where id=$1',[grant.user_id])).rows[0];
      if(!owner?.email_confirmed_at)throw new Problem(503,'owner_email_unconfirmed');
      if(Date.now()-new Date(job.created_at).getTime()>23*3600000)throw new Problem(422,'email_idempotency_window_expired');
      const response=await providers.email.send({key:`activation-${challenge.id}`,to:owner.email,
        code:unseal(cfg.encryptionKey,job.payload.encryptedCode),productName:grant.name});
      if(!response?.id)throw new Problem(503,'invalid_email_response');
      await c.query('update billing.jobs set provider_message_id=$2 where id=$1',[job.id,String(response.id)]);
    });
  }else throw new Problem(422,'unknown_job_kind');
}
export async function runBatch(db,cfg,providers,limit=10) {
  let completed=0;
  for(let i=0;i<Math.min(limit,50);i++){
    const token=randomUUID();
    const job=await transaction(db,async c=>{
      const {rows}=await c.query(`select * from billing.jobs where
        (state='pending' and available_at<=now()) or (state='running' and lease_until<now())
        order by available_at,id limit 1 for update skip locked`);
      if(!rows[0])return null;
      const result=await c.query(`update billing.jobs set state='running',attempts=attempts+1,
        lease_until=now()+interval '90 seconds',lease_token=$2 where id=$1 returning *`,[rows[0].id,token]);
      return result.rows[0];
    });
    if(!job)break;
    try{
      await processJob(db,cfg,providers,job);
      await db.query(`update billing.jobs set state='done',finished_at=now(),lease_until=null,
        payload=case when kind='email' then payload-'encryptedCode' else payload end,error_code=null
        where id=$1 and lease_token=$2`,[job.id,token]);
      completed++;
    }catch(e){
      const dead=job.attempts>=10||e.status===422;
      await db.query(`update billing.jobs set state=$3,error_code=$4,lease_until=null,
        available_at=now()+$5*interval '1 second' where id=$1 and lease_token=$2`,
        [job.id,token,dead?'dead':'pending',e.code??'processing_error',Math.min(3600,15*2**Math.min(job.attempts,8))]);
      // Never log payload, provider bodies, codes, addresses, credentials or tokens.
    }
  }
  return completed;
}
