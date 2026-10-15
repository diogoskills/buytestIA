import { randomUUID, randomBytes } from 'node:crypto';
import { Problem, uuid, mac, equal, seal, transaction, lock, enqueue, validatePayment, cents, rateLimit } from './core.js';

export async function catalog(db,productId) {
  const {rows}=await db.query(`select p.id,p.name,p.features,coalesce(jsonb_agg(jsonb_build_object('id',r.id,'plan',r.plan,
    'amountCents',r.amount_cents,'currency',r.currency,'version',r.version)) filter(where r.id is not null),'[]') prices
    from billing.products p left join billing.prices r on r.product_id=p.id and r.active
    where p.id=$1 and p.enabled group by p.id`,[productId]);
  return rows[0]??null;
}
export async function access(db,userId,productId) {
  const {rows}=await db.query(`select g.id,g.plan,g.features,g.starts_at,g.ends_at from billing.grants g
    join billing.orders o on o.id=g.order_id where g.user_id=$1 and g.product_id=$2
    and g.activated_at is not null and g.revoked_at is null and o.financial_status='approved'
    and g.starts_at<=now() and (g.ends_at is null or g.ends_at>now())
    order by g.ends_at desc nulls first limit 1`,[userId,productId]);
  return rows[0]?{active:true,...rows[0]}:{active:false};
}
export async function requireAccess(db,userId,productId,feature) {
  const result=await access(db,userId,productId);
  if(!result.active||(feature&&!result.features.includes(feature)))throw new Problem(403,'premium_required','Este recurso exige Premium ativo.');
  return result;
}
export async function checkout(db,cfg,provider,user,{productId,plan},requestKey) {
  if(productId!==cfg.productId||!['annual','lifetime'].includes(plan)||!uuid(requestKey))throw new Problem(400,'invalid_checkout');
  const preparation=await transaction(db,async c=>{
    await lock(c,`owner:${user.id}:${productId}`);
    const repeated=await c.query('select * from billing.orders where user_id=$1 and request_key=$2',[user.id,requestKey]);
    if(repeated.rows[0]){
      const o=repeated.rows[0];if(o.product_id!==productId||o.plan!==plan)throw new Problem(409,'idempotency_conflict');
      return {order:o,create:false};
    }
    const product=await catalog(c,productId);
    const price=product?.prices.find(p=>p.plan===plan);
    if(!price)throw new Problem(409,'price_unavailable','O plano está indisponível.');
    const owned=await c.query(`select * from billing.grants where user_id=$1 and product_id=$2
      and revoked_at is null and (ends_at is null or ends_at>now()) order by ends_at desc nulls first`,[user.id,productId]);
    if(owned.rows.some(g=>g.plan==='lifetime'))throw new Problem(409,'already_lifetime','Você já tem o acesso vitalício. Abra Code para ativá-lo, se necessário.');
    if(plan==='annual'&&owned.rows.some(g=>new Date(g.ends_at).getTime()>Date.now()+30*86400_000))throw new Problem(409,'renewal_too_early','A renovação anual abre nos últimos 30 dias do acesso.');
    const pending=await c.query(`select * from billing.orders where user_id=$1 and product_id=$2
      and financial_status='pending' and checkout_status in ('creating','ready','unknown')
      order by created_at desc limit 1 for update`,[user.id,productId]);
    if(pending.rows[0]){
      if(pending.rows[0].plan!==plan)throw new Problem(409,'pending_other_plan','Há uma compra em andamento de outro plano. Consulte seu estado antes de trocar.');
      return {order:pending.rows[0],create:false};
    }
    const id=randomUUID(),expires=new Date(Date.now()+7*86400_000);
    const {rows}=await c.query(`insert into billing.orders(id,user_id,product_id,price_id,snapshot,plan,amount_cents,currency,request_key,checkout_expires_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,[id,user.id,productId,price.id,
      JSON.stringify({name:product.name,features:product.features,priceVersion:price.version,plan,amountCents:price.amountCents,currency:price.currency,providerMode:cfg.mpMode,collectorId:cfg.mpCollectorId}),plan,price.amountCents,price.currency,requestKey,expires]);
    await c.query('insert into billing.checkout_attempts(order_id) values($1)',[id]);
    return {order:rows[0],create:true};
  });
  const {order}=preparation;
  if(!preparation.create)return checkoutView(order);
  try {
    if(!cfg.appOrigin.startsWith('https://'))throw new Problem(503,'https_required','O checkout precisa de um domínio HTTPS configurado.');
    const pref=await provider.createPreference(order);
    const url=cfg.mpMode==='test'?pref.sandbox_init_point:pref.init_point;
    if(!/^[a-zA-Z0-9_-]{1,150}$/.test(String(pref.id))||pref.external_reference!==order.id||String(pref.collector_id)!==cfg.mpCollectorId||!validCheckoutUrl(url))throw new Problem(503,'invalid_preference_response');
    const updated=await transaction(db,async c=>{
      const result=await c.query(`update billing.orders set preference_id=$2,checkout_url=$3,
        checkout_status=case when financial_status='pending' then 'ready' else 'closed' end,updated_at=now() where id=$1 returning *`,[order.id,String(pref.id),url]);
      await c.query(`update billing.checkout_attempts set state='ready',updated_at=now() where order_id=$1`,[order.id]);
      return result.rows[0];
    });
    return checkoutView(updated);
  }catch(e){
    // An interrupted preference POST has unknown outcome. Never replay it blindly.
    const definite=e.code==='https_required'||(e.providerStatus>=400&&e.providerStatus<500&&e.providerStatus!==408&&e.providerStatus!==429);
    await transaction(db,async c=>{
      await c.query(`update billing.orders set checkout_status=$2,needs_review=$3,updated_at=now() where id=$1`,[order.id,definite?'failed':'unknown',!definite]);
      await c.query(`update billing.checkout_attempts set state=$2,error_code=$3,updated_at=now() where order_id=$1`,[order.id,definite?'failed':'unknown',e.code??'provider_unknown']);
      await enqueue(c,'reconcile',`initial:${order.id}`,{orderId:order.id,offset:0});
    });
    if(definite)return {orderId:order.id,state:'failed',checkoutUrl:null};
    return {orderId:order.id,state:'unknown',checkoutUrl:null};
  }
}
export function validCheckoutUrl(value) {
  try {const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&
    ['www.mercadopago.com.br','sandbox.mercadopago.com.br'].includes(u.hostname);}catch{return false;}
}
function checkoutView(o) {
  return {orderId:o.id,state:o.financial_status==='pending'?o.checkout_status:o.financial_status,
    checkoutUrl:o.checkout_status==='ready'&&new Date(o.checkout_expires_at)>new Date()&&o.financial_status==='pending'?o.checkout_url:null};
}
export async function recoverPreference(db,cfg,provider,order) {
  // Search exists for Preferences; absence is not proof that a timed-out POST failed.
  const result=await provider.searchPreferences(order.id);
  if(!Array.isArray(result.elements))throw new Problem(503,'invalid_preference_search');
  if(result.elements.length===0)return;
  if(result.elements.length!==1||Number(result.total)!==1){
    await db.query('update billing.orders set needs_review=true where id=$1',[order.id]);return;
  }
  const candidate=result.elements[0];
  const preference=await provider.getPreference(candidate.id);
  const item=preference.items?.[0];
  const url=cfg.mpMode==='test'?preference.sandbox_init_point:preference.init_point;
  if(String(preference.id)!==String(candidate.id)||preference.external_reference!==order.id||String(preference.collector_id)!==cfg.mpCollectorId||
    candidate.live_mode!==(cfg.mpMode==='live')||preference.items?.length!==1||
    item?.id!==order.price_id||item.quantity!==1||item.currency_id!==order.currency||
    cents(item.unit_price)!==order.amount_cents||!validCheckoutUrl(url)||
    preference.expires!==true||!Number.isFinite(Date.parse(preference.expiration_date_to))||
    Math.abs(Date.parse(preference.expiration_date_to)-new Date(order.checkout_expires_at).getTime())>1000)
    throw new Problem(422,'preference_mismatch');
  await transaction(db,async c=>{
    const current=(await c.query('select * from billing.orders where id=$1 for update',[order.id])).rows[0];
    if(current.checkout_status!=='unknown'||current.financial_status!=='pending')return;
    await c.query(`update billing.orders set preference_id=$2,checkout_url=$3,checkout_status='ready',
      needs_review=false,updated_at=now() where id=$1`,[order.id,String(preference.id),url]);
    await c.query(`update billing.checkout_attempts set state='ready',error_code=null,updated_at=now() where order_id=$1`,[order.id]);
  });
}
export async function issueChallenge(c,cfg,grant) {
  const id=randomUUID(),code=randomBytes(12).toString('hex').toUpperCase();
  const verifier=mac(cfg.hmacKey,`${id}:${grant.id}:${grant.user_id}:${grant.product_id}:${code}`);
  await c.query('update billing.activation_challenges set invalidated_at=now() where grant_id=$1 and consumed_at is null and invalidated_at is null',[grant.id]);
  await c.query(`insert into billing.activation_challenges(id,grant_id,user_id,product_id,verifier,expires_at)
    values($1,$2,$3,$4,$5,now()+interval '15 minutes')`,[id,grant.id,grant.user_id,grant.product_id,verifier]);
  await enqueue(c,'email',`activation:${id}`,{challengeId:id,grantId:grant.id,encryptedCode:seal(cfg.encryptionKey,code)});
}
export async function processPayment(db,cfg,provider,paymentId) {
  if(!/^\d{1,30}$/.test(String(paymentId)))throw new Problem(400,'invalid_payment_id');
  return transaction(db,async c=>{
    await lock(c,`payment:${paymentId}`);
    // Fetch inside the transaction lock so concurrent workers cannot apply stale reads.
    const payment=await provider.getPayment(paymentId);
    if(String(payment.id)!==String(paymentId)||!uuid(payment.external_reference))throw new Problem(422,'payment_mismatch');
    const lookup=await c.query('select user_id,product_id from billing.orders where id=$1',[payment.external_reference]);
    if(!lookup.rows[0]||lookup.rows[0].product_id!==cfg.productId)throw new Problem(422,'unknown_order');
    await lock(c,`owner:${lookup.rows[0].user_id}:${lookup.rows[0].product_id}`);
    const {rows}=await c.query('select * from billing.orders where id=$1 for update',[payment.external_reference]);
    const order=rows[0];validatePayment(payment,order,cfg);
    const refunded=cents(payment.transaction_amount_refunded??0);
    if(refunded>order.amount_cents)throw new Problem(422,'invalid_refund');
    const prior=(await c.query('select * from billing.payments where id=$1',[String(payment.id)])).rows[0];
    if(prior&&prior.order_id!==order.id)throw new Problem(422,'payment_reassigned');
    // Refunds and chargebacks never regress to approved on an older notification/read.
    const seen=[prior?.status,payment.status];
    const status=seen.includes('charged_back')?'charged_back':seen.includes('refunded')?'refunded':
      seen.includes('in_mediation')?'in_mediation':prior?.status==='approved'&&
      ['pending','in_process','authorized','rejected','cancelled'].includes(payment.status)?'approved':payment.status;
    const refundedCents=Math.max(refunded,prior?.refunded_cents??0);
    await c.query(`insert into billing.payments(id,order_id,status,refunded_cents,approved_at)
      values($1,$2,$3,$4,$5) on conflict(id) do update set status=$3,refunded_cents=$4,
      approved_at=coalesce(billing.payments.approved_at,$5),last_verified_at=now()`,[String(payment.id),order.id,status,refundedCents,payment.date_approved??null]);
    if(order.canonical_payment_id&&order.canonical_payment_id!==String(payment.id)){
      if(!['approved','refunded','charged_back','in_mediation'].includes(status)&&refundedCents===0)return {otherAttempt:true};
      await c.query('update billing.payments set duplicate=true where id=$1',[String(payment.id)]);
      await c.query('update billing.orders set needs_review=true,updated_at=now() where id=$1',[order.id]);
      return {duplicate:true};
    }
    const reversal=refundedCents>0||['refunded','charged_back','in_mediation'].includes(status);
    if(reversal){
      const financial=status==='charged_back'?'charged_back':status==='refunded'&&refundedCents>=order.amount_cents?'refunded':'review';
      await c.query(`update billing.orders set financial_status=$2,needs_review=true,updated_at=now() where id=$1`,[order.id,financial]);
      await c.query(`update billing.grants set revoked_at=coalesce(revoked_at,now()),revoke_reason=$2 where order_id=$1`,[order.id,status==='in_mediation'?'dispute':refundedCents>0?'refund':status]);
      await c.query(`update billing.activation_challenges set invalidated_at=now() where grant_id in (select id from billing.grants where order_id=$1) and consumed_at is null`,[order.id]);
      return {revoked:true};
    }
    if(status!=='approved'){
      if(!order.canonical_payment_id)await c.query(`update billing.orders set financial_status=$2,updated_at=now() where id=$1`,[order.id,['rejected','cancelled'].includes(status)?status:'pending']);
      return {pending:true};
    }
    // An order may have been put into review before approval. Never silently restore it.
    if(['refunded','charged_back','review'].includes(order.financial_status))return {review:true};
    await c.query(`update billing.orders set canonical_payment_id=$2,financial_status='approved',checkout_status='closed',updated_at=now() where id=$1`,[order.id,String(payment.id)]);
    const exists=await c.query('select id from billing.grants where order_id=$1',[order.id]);
    if(exists.rows.length)return {alreadyGranted:true};
    const approvedAt=new Date(payment.date_approved);
    let startsAt=approvedAt;
    if(order.plan==='annual'){
      const priorGrants=await c.query(`select max(ends_at) as ends_at from billing.grants
        where user_id=$1 and product_id=$2 and plan='annual' and revoked_at is null`,[order.user_id,order.product_id]);
      if(priorGrants.rows[0]?.ends_at&&new Date(priorGrants.rows[0].ends_at)>startsAt)startsAt=new Date(priorGrants.rows[0].ends_at);
    }
    const granted=await c.query(`insert into billing.grants(order_id,payment_id,user_id,product_id,plan,features,starts_at,ends_at)
      values($1,$2,$3,$4,$5,$6,$7,case when $5='annual' then $7::timestamptz+interval '12 months' else null end) returning *`,
      [order.id,String(payment.id),order.user_id,order.product_id,order.plan,JSON.stringify(order.snapshot.features),startsAt]);
    // Lifetime already owned through another paid order: preserve money history, flag for support.
    const lifetime=await c.query(`select id from billing.grants where user_id=$1 and product_id=$2 and plan='lifetime'
      and revoked_at is null and id<>$3`,[order.user_id,order.product_id,granted.rows[0].id]);
    if(lifetime.rows.length){
      await c.query(`update billing.grants set revoked_at=now(),revoke_reason='duplicate_lifetime' where id=$1`,[granted.rows[0].id]);
      await c.query('update billing.orders set needs_review=true where id=$1',[order.id]);
      return {duplicate:true};
    }
    await issueChallenge(c,cfg,granted.rows[0]);
    return {granted:true};
  });
}
export async function redeem(db,cfg,user,{grantId,code}) {
  if(!uuid(grantId)||typeof code!=='string'||!/^[a-f0-9]{24}$/i.test(code))throw new Problem(400,'invalid_code','Confira o código de 24 caracteres.');
  await rateLimit(db,`redeem:${user.id}`,15,3600);
  // Commit failed attempts; never roll back the attempt counter with the error.
  const result=await transaction(db,async c=>{
    const grant=(await c.query('select * from billing.grants where id=$1 and user_id=$2 and product_id=$3 for update',[grantId,user.id,cfg.productId])).rows[0];
    if(!grant)return {error:'invalid_code'};
    const order=(await c.query('select financial_status from billing.orders where id=$1',[grant.order_id])).rows[0];
    if(grant.revoked_at||order.financial_status!=='approved')return {error:'payment_not_confirmed'};
    if(grant.activated_at)return {error:'already_activated'};
    if(grant.ends_at&&new Date(grant.ends_at)<=new Date())return {error:'access_expired'};
    const challenge=(await c.query(`select * from billing.activation_challenges where grant_id=$1 and consumed_at is null
      and invalidated_at is null for update`,[grantId])).rows[0];
    if(!challenge||new Date(challenge.expires_at)<=new Date()||challenge.attempts>=5)return {error:'code_expired_or_locked'};
    await c.query('update billing.activation_challenges set attempts=attempts+1 where id=$1',[challenge.id]);
    const verifier=mac(cfg.hmacKey,`${challenge.id}:${grant.id}:${user.id}:${grant.product_id}:${code.toUpperCase()}`);
    if(!equal(verifier,challenge.verifier))return {error:'invalid_code'};
    await c.query('update billing.activation_challenges set consumed_at=now() where id=$1',[challenge.id]);
    await c.query('update billing.grants set activated_at=now() where id=$1',[grantId]);
    return {activated:true};
  });
  if(result.error)throw new Problem(409,result.error,'Não foi possível ativar. Confira o código e a compra ou solicite um novo código.');
  return result;
}
export async function resend(db,cfg,user,grantId) {
  if(!uuid(grantId))throw new Problem(400,'invalid_grant');
  await rateLimit(db,`resend:${user.id}`,5,3600);
  return transaction(db,async c=>{
    const grant=(await c.query(`select g.* from billing.grants g join billing.orders o on o.id=g.order_id
      where g.id=$1 and g.user_id=$2 and g.product_id=$3 and o.financial_status='approved' and g.revoked_at is null
      and g.activated_at is null and (g.ends_at is null or g.ends_at>now()) for update of g`,[grantId,user.id,cfg.productId])).rows[0];
    if(!grant)throw new Problem(404,'activation_unavailable');
    const recent=await c.query(`select id from billing.activation_challenges where grant_id=$1 and created_at>now()-interval '60 seconds'`,[grantId]);
    if(recent.rows.length)throw new Problem(429,'resend_cooldown','Aguarde 60 segundos antes de reenviar.');
    await issueChallenge(c,cfg,grant);return {queued:true};
  });
}
export async function accountState(db,userId,productId) {
  const orders=await db.query(`select id,plan,amount_cents,currency,financial_status,checkout_status,
    case when financial_status='pending' and checkout_status='ready' and checkout_expires_at>now() then checkout_url else null end checkout_url,
    needs_review,created_at from billing.orders where user_id=$1 and product_id=$2 order by created_at desc limit 20`,[userId,productId]);
  const grants=await db.query(`select g.id,g.order_id,g.plan,g.starts_at,g.ends_at,g.activated_at,g.revoked_at,g.revoke_reason,
    (select j.state from billing.jobs j where j.kind='email' and j.payload->>'grantId'=g.id::text order by j.created_at desc limit 1) email_state,
    (select j.provider_message_id from billing.jobs j where j.kind='email' and j.payload->>'grantId'=g.id::text order by j.created_at desc limit 1) email_provider_id
    from billing.grants g where g.user_id=$1 and g.product_id=$2 order by g.created_at desc limit 20`,[userId,productId]);
  return {access:await access(db,userId,productId),orders:orders.rows,grants:grants.rows};
}
