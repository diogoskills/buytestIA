import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,cfg,user,provider,paymentFor } from './helpers.js';
import { checkout,processPayment,redeem,resend,access,accountState,requireAccess } from '../server/billing.js';
import { recordWebhook,runBatch,scheduleReconciliation } from '../server/jobs.js';
import { rateLimit,unseal } from '../server/core.js';
let db;
before(async()=>{db=await fixture();});after(async()=>{await db?.end();});
const purchase=async(u,p,plan='annual',key=randomUUID())=>checkout(db,cfg,p.mp,u,{productId:'forma-premium',plan},key);
async function grantFor(orderId){return (await db.query('select * from billing.grants where order_id=$1',[orderId])).rows[0];}
async function codeFor(grant){const job=(await db.query(`select payload from billing.jobs where kind='email' and payload->>'grantId'=$1 order by created_at desc limit 1`,[grant.id])).rows[0];return unseal(cfg.encryptionKey,job.payload.encryptedCode);}
async function approved(plan='annual'){
 const u=await user(db),p=provider(),o=await purchase(u,p,plan),payment=await paymentFor(db,p,o.orderId);
 await processPayment(db,cfg,p.mp,payment.id);return {u,p,o,payment,g:await grantFor(o.orderId)};
}
test('versioned trusted price and snapshot survive retirement; client cannot select another product',async()=>{
 const u=await user(db),p=provider(),o=await purchase(u,p);
 const order=(await db.query('select * from billing.orders where id=$1',[o.orderId])).rows[0];
 assert.equal(order.amount_cents,4000);assert.equal(order.snapshot.priceVersion,1);assert.equal(order.snapshot.amountCents,4000);
 await assert.rejects(()=>db.query('update billing.prices set amount_cents=1 where id=$1',[order.price_id]));
 await assert.rejects(()=>checkout(db,cfg,p.mp,u,{productId:'another-project',plan:'annual'},randomUUID()));
});
test('concurrent clicks and different keys reuse one checkout; exact key conflicts on another plan',async()=>{
 const u=await user(db),p=provider(),key=randomUUID();
 const results=await Promise.all([purchase(u,p,'annual',key),purchase(u,p,'annual',key),purchase(u,p)]);
 assert.equal(new Set(results.map(o=>o.orderId)).size,1);assert.equal(p.mp.creates,1);
 await assert.rejects(()=>purchase(u,p,'lifetime',key),e=>e.code==='idempotency_conflict');
 await assert.rejects(()=>purchase(u,p,'lifetime'),e=>e.code==='pending_other_plan');
});
test('timeout outcome stays unknown and is never blindly recreated',async()=>{
 const u=await user(db),p=provider();p.mp.createPreference=async()=>{p.mp.creates++;throw Error('timeout');};
 const o=await purchase(u,p);assert.equal(o.state,'unknown');
 const resumed=await purchase(u,p);assert.equal(resumed.orderId,o.orderId);assert.equal(p.mp.creates,1);
 const result=(await db.query('select state from billing.checkout_attempts where order_id=$1',[o.orderId])).rows[0];assert.equal(result.state,'unknown');
});
test('mismatched amount, currency, receiver, mode and payment ID cannot grant access',async()=>{
 const u=await user(db),p=provider(),o=await purchase(u,p);
 for(const change of [{transaction_amount:1},{currency_id:'USD'},{collector_id:999},{live_mode:true},{external_reference:randomUUID()}]){
  const payment=await paymentFor(db,p,o.orderId,change);
  await assert.rejects(()=>processPayment(db,cfg,p.mp,payment.id));
 }
 assert.equal(await grantFor(o.orderId),undefined);assert.equal((await access(db,u.id,cfg.productId)).active,false);
});
test('durable duplicate webhook plus concurrent processing grants exactly once, then ignores pending regression',async()=>{
 const u=await user(db),p=provider(),o=await purchase(u,p),payment=await paymentFor(db,p,o.orderId);
 await Promise.all([recordWebhook(db,'delivery-test',payment.id),recordWebhook(db,'delivery-test',payment.id)]);
 assert.equal((await db.query("select count(*)::int n from billing.events where delivery_key='delivery-test'")).rows[0].n,1);
 await Promise.all([processPayment(db,cfg,p.mp,payment.id),processPayment(db,cfg,p.mp,payment.id)]);
 assert.equal((await db.query('select count(*)::int n from billing.grants where order_id=$1',[o.orderId])).rows[0].n,1);
 p.mp.payments.get(payment.id).status='pending';await processPayment(db,cfg,p.mp,payment.id);
 assert.equal((await db.query('select financial_status from billing.orders where id=$1',[o.orderId])).rows[0].financial_status,'approved');
});
test('access awaits activation; another account and another product cannot use the code; redemption is atomic',async()=>{
 const {u,g}=await approved(),other=await user(db),code=await codeFor(g);
 assert.equal((await access(db,u.id,cfg.productId)).active,false);
 await assert.rejects(()=>redeem(db,cfg,other,{grantId:g.id,code}));
 const results=await Promise.allSettled([redeem(db,cfg,u,{grantId:g.id,code}),redeem(db,cfg,u,{grantId:g.id,code})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await access(db,u.id,cfg.productId)).active,true);
 assert.equal((await access(db,other.id,cfg.productId)).active,false);
 assert.equal((await access(db,u.id,'other-product')).active,false);
 await assert.rejects(()=>requireAccess(db,u.id,'other-product'));
 await assert.rejects(()=>redeem(db,cfg,u,{grantId:g.id,code}),e=>e.code==='already_activated');
});
test('wrong attempts persist and lock challenge; resend invalidates previous code without losing purchase',async()=>{
 const {u,g}=await approved(),old=await codeFor(g);
 for(let i=0;i<5;i++)await assert.rejects(()=>redeem(db,cfg,u,{grantId:g.id,code:'0'.repeat(24)}));
 assert.equal((await db.query('select attempts from billing.activation_challenges where grant_id=$1',[g.id])).rows[0].attempts,5);
 await assert.rejects(()=>redeem(db,cfg,u,{grantId:g.id,code:old}),e=>e.code==='code_expired_or_locked');
 await assert.rejects(()=>resend(db,cfg,u,g.id),e=>e.code==='resend_cooldown');
 await db.query("update billing.activation_challenges set created_at=now()-interval '2 minutes' where grant_id=$1",[g.id]);
 await resend(db,cfg,u,g.id);const fresh=await codeFor(g);assert.notEqual(fresh,old);
 await assert.rejects(()=>redeem(db,cfg,u,{grantId:g.id,code:old}));
 await redeem(db,cfg,u,{grantId:g.id,code:fresh});assert.equal((await access(db,u.id,cfg.productId)).active,true);
});
test('expired code preserves right and resending creates a fresh challenge',async()=>{
 const {u,g}=await approved(),code=await codeFor(g);
 await db.query("update billing.activation_challenges set expires_at=now()-interval '1 minute',created_at=now()-interval '2 minutes' where grant_id=$1",[g.id]);
 await assert.rejects(()=>redeem(db,cfg,u,{grantId:g.id,code}),e=>e.code==='code_expired_or_locked');
 await resend(db,cfg,u,g.id);await redeem(db,cfg,u,{grantId:g.id,code:await codeFor(g)});
});
test('unconfirmed payment cannot be redeemed even with the correct challenge',async()=>{
 const {u,o,g}=await approved(),code=await codeFor(g);
 await db.query("update billing.orders set financial_status='pending' where id=$1",[o.orderId]);
 await assert.rejects(()=>redeem(db,cfg,u,{grantId:g.id,code}),e=>e.code==='payment_not_confirmed');
 assert.equal((await access(db,u.id,cfg.productId)).active,false);
});
test('two real payments for one order remain recorded and flagged without a second grant',async()=>{
 const {p,o}=await approved(),second=await paymentFor(db,p,o.orderId);
 await processPayment(db,cfg,p.mp,second.id);
 assert.equal((await db.query('select count(*)::int n from billing.payments where order_id=$1',[o.orderId])).rows[0].n,2);
 assert.equal((await db.query('select duplicate from billing.payments where id=$1',[second.id])).rows[0].duplicate,true);
 assert.equal((await db.query('select count(*)::int n from billing.grants where order_id=$1',[o.orderId])).rows[0].n,1);
});
test('partial refund, full refund and dispute revoke access and old approval cannot restore it',async()=>{
 for(const reversal of [{transaction_amount_refunded:40,status:'refunded'},{transaction_amount_refunded:1,status:'approved'},{status:'charged_back'},{status:'in_mediation'}]){
  const {u,p,g,payment}=await approved();await redeem(db,cfg,u,{grantId:g.id,code:await codeFor(g)});
  Object.assign(p.mp.payments.get(payment.id),reversal);await processPayment(db,cfg,p.mp,payment.id);
  assert.equal((await access(db,u.id,cfg.productId)).active,false);
  Object.assign(p.mp.payments.get(payment.id),{status:'approved',transaction_amount_refunded:0});await processPayment(db,cfg,p.mp,payment.id);
  assert.equal((await access(db,u.id,cfg.productId)).active,false);
 }
});
test('annual starts at financial approval, not activation; renewal extends original validity and lifetime blocks duplicate purchase',async()=>{
 const {u,p,o,payment,g}=await approved();
 assert.equal(new Date(g.starts_at).getTime(),new Date(payment.date_approved).getTime());
 await assert.rejects(()=>purchase(u,p),e=>e.code==='renewal_too_early');
 await db.query("update billing.grants set starts_at=now()-interval '11 months',ends_at=now()+interval '10 days' where id=$1",[g.id]);
 const prior=await grantFor(o.orderId),renewal=await purchase(u,p),renewPayment=await paymentFor(db,p,renewal.orderId);
 await processPayment(db,cfg,p.mp,renewPayment.id);const renewed=await grantFor(renewal.orderId);
 assert.equal(new Date(renewed.starts_at).getTime(),new Date(prior.ends_at).getTime());
 const upgrade=await purchase(u,p,'lifetime'),upgradePayment=await paymentFor(db,p,upgrade.orderId);
 await processPayment(db,cfg,p.mp,upgradePayment.id);const lifetime=await grantFor(upgrade.orderId);assert.equal(lifetime.ends_at,null);
 await assert.rejects(()=>purchase(u,p,'lifetime'),e=>e.code==='already_lifetime');
 await assert.rejects(()=>purchase(u,p,'annual'),e=>e.code==='already_lifetime');
});
test('annual expiration denies protected endpoints and late activation cannot shift validity',async()=>{
 const {u,g}=await approved();await redeem(db,cfg,u,{grantId:g.id,code:await codeFor(g)});
 await db.query("update billing.grants set starts_at=now()-interval '13 months',ends_at=now()-interval '1 month' where id=$1",[g.id]);
 assert.equal((await access(db,u.id,cfg.productId)).active,false);await assert.rejects(()=>requireAccess(db,u.id,cfg.productId));
});
test('rate limits are enforced durably and separately by account',async()=>{
 const key=randomUUID();await rateLimit(db,key,2,60);await rateLimit(db,key,2,60);await assert.rejects(()=>rateLimit(db,key,2,60),e=>e.status===429);
 await rateLimit(db,randomUUID(),2,60);
});
test('browser roles cannot read operational tables or modify prices, orders, grants',async()=>{
 const c=await db.connect();try{
  await c.query('begin');await c.query('set local role authenticated');
  for(const table of ['prices','orders','grants','jobs','activation_challenges']){
   await c.query('savepoint probe');await assert.rejects(()=>c.query(`select * from billing.${table}`));await c.query('rollback to savepoint probe');
  }
  await c.query('savepoint probe');await assert.rejects(()=>c.query('update billing.prices set amount_cents=1'));await c.query('rollback to savepoint probe');
  await c.query('rollback');
 }finally{c.release();}
});
test('complete fake-provider flow survives worker mail failure, retries, activates and restores account state',async()=>{
 const isolated=await fixtureForWorker();try{
  const {db:d}=isolated,u=await user(d),p=provider(),o=await checkout(d,cfg,p.mp,u,{productId:cfg.productId,plan:'annual'},randomUUID());
  const payment=await paymentFor(d,p,o.orderId);p.email.fail=true;
  await recordWebhook(d,'complete-flow',payment.id);await runBatch(d,cfg,p,10);
  const g=(await d.query('select * from billing.grants where order_id=$1',[o.orderId])).rows[0];assert.ok(g);
  assert.equal((await access(d,u.id,cfg.productId)).active,false);
  const emailJob=(await d.query("select * from billing.jobs where kind='email'")).rows[0];assert.equal(emailJob.state,'pending');assert.equal(emailJob.attempts,1);
  p.email.fail=false;await d.query("update billing.jobs set available_at=now() where kind='email'");await runBatch(d,cfg,p,10);
  assert.equal(p.email.sent.length,1);assert.equal(p.email.sent[0].to,u.email);
  await redeem(d,cfg,u,{grantId:g.id,code:p.email.sent[0].code});assert.equal((await accountState(d,u.id,cfg.productId)).access.active,true);
  assert.ok(!(await d.query("select payload from billing.jobs where kind='email'")).rows[0].payload.encryptedCode);
 }finally{await isolated.db.end();}
});
async function fixtureForWorker(){
 // A second fixture must not drop the shared real database. PGlite is isolated for this subtest.
 const prior=process.env.TEST_DATABASE_URL;delete process.env.TEST_DATABASE_URL;
 try{return {db:await fixture()};}finally{if(prior)process.env.TEST_DATABASE_URL=prior;}
}
test('periodic reconciliation recovers a missed webhook and pagination uses bounded pages',async()=>{
 const {db:d}=await fixtureForWorker();try{
  const u=await user(d),p=provider(),o=await checkout(d,cfg,p.mp,u,{productId:cfg.productId,plan:'lifetime'},randomUUID());
  await paymentFor(d,p,o.orderId);await scheduleReconciliation(d);await runBatch(d,cfg,p,10);
  assert.ok((await d.query('select id from billing.grants where order_id=$1',[o.orderId])).rows[0]);
  assert.ok((await d.query('select next_reconcile_at>now() future from billing.orders where id=$1',[o.orderId])).rows[0].future);
 }finally{await d.end();}
});
test('preference creation timeout is recovered by verified external reference search, without another POST',async()=>{
 const {recoverPreference}=await import('../server/billing.js');
 const u=await user(db),p=provider(),create=p.mp.createPreference;
 p.mp.createPreference=async order=>{await create(order);throw Error('response lost');};
 const o=await purchase(u,p);assert.equal(o.state,'unknown');
 const order=(await db.query('select * from billing.orders where id=$1',[o.orderId])).rows[0];
 await recoverPreference(db,cfg,p.mp,order);
 const resumed=await purchase(u,p);assert.equal(resumed.state,'ready');assert.ok(resumed.checkoutUrl);assert.equal(p.mp.creates,1);
});
test('exhausted durable webhook job can be retried on a duplicate delivery',async()=>{
 const id='91919',key=randomUUID();await recordWebhook(db,key,id);
 await db.query("update billing.jobs set state='dead',attempts=10 where payload->>'paymentId'=$1",[id]);
 await recordWebhook(db,key,id);
 assert.equal((await db.query("select state from billing.jobs where payload->>'paymentId'=$1",[id])).rows[0].state,'pending');
});
test('late provider approval and rejected/pending states are handled without trusting checkout return',async()=>{
 const u=await user(db),p=provider(),o=await purchase(u,p),payment=await paymentFor(db,p,o.orderId,{status:'pending',date_approved:null});
 await processPayment(db,cfg,p.mp,payment.id);assert.equal(await grantFor(o.orderId),undefined);
 p.mp.payments.get(payment.id).status='rejected';await processPayment(db,cfg,p.mp,payment.id);assert.equal(await grantFor(o.orderId),undefined);
 Object.assign(p.mp.payments.get(payment.id),{status:'approved',date_approved:new Date().toISOString()});
 await processPayment(db,cfg,p.mp,payment.id);assert.ok(await grantFor(o.orderId));
});
test('definite checkout rejection can start a fresh attempt, while retained key returns the same failure',async()=>{
 const u=await user(db),p=provider(),create=p.mp.createPreference,key=randomUUID();
 p.mp.createPreference=async()=>{const e=Error('bad request');e.providerStatus=400;throw e;};
 const failed=await purchase(u,p,'annual',key);assert.equal(failed.state,'failed');
 const repeated=await purchase(u,p,'annual',key);assert.equal(repeated.orderId,failed.orderId);
 p.mp.createPreference=create;const fresh=await purchase(u,p);assert.equal(fresh.state,'ready');assert.notEqual(fresh.orderId,failed.orderId);
});
test('cross-product activation and resend are rejected even for the same user',async()=>{
 const {u,g}=await approved(),code=await codeFor(g),anotherCfg={...cfg,productId:'another-product'};
 await assert.rejects(()=>redeem(db,anotherCfg,u,{grantId:g.id,code}));
 await assert.rejects(()=>resend(db,anotherCfg,u,g.id));
});
test('reconciliation actually paginates beyond fifty transactions without unbounded search',async()=>{
 const {db:d}=await fixtureForWorker();try{
  const u=await user(d),p=provider(),o=await checkout(d,cfg,p.mp,u,{productId:cfg.productId,plan:'annual'},randomUUID());
  for(let i=0;i<51;i++)await paymentFor(d,p,o.orderId,{status:'pending',date_approved:null});
  const offsets=[],search=p.mp.searchPayments;p.mp.searchPayments=async(ref,offset)=>{offsets.push(offset);return search(ref,offset);};
  await scheduleReconciliation(d);for(let i=0;i<7;i++)await runBatch(d,cfg,p,10);
  assert.deepEqual(offsets,[0,50]);assert.equal((await d.query('select count(*)::int n from billing.payments where order_id=$1',[o.orderId])).rows[0].n,51);
 }finally{await d.end();}
});
test('a fully paid and activated second product never grants Forma or exposes its orders there',async()=>{
 const u=await user(db),p=provider(),otherCfg={...cfg,productId:'second-product'};
 await db.query("insert into billing.products(id,name,features) values('second-product','Second','[\"second-feature\"]')");
 await db.query("insert into billing.prices(product_id,plan,version,currency,amount_cents,active) values('second-product','lifetime',1,'BRL',1000,true)");
 const o=await checkout(db,otherCfg,p.mp,u,{productId:'second-product',plan:'lifetime'},randomUUID());
 const payment=await paymentFor(db,p,o.orderId);await processPayment(db,otherCfg,p.mp,payment.id);const g=await grantFor(o.orderId);
 await redeem(db,otherCfg,u,{grantId:g.id,code:await codeFor(g)});
 assert.equal((await access(db,u.id,'second-product')).active,true);assert.equal((await access(db,u.id,cfg.productId)).active,false);
 assert.equal((await accountState(db,u.id,cfg.productId)).orders.length,0);
 await assert.rejects(()=>requireAccess(db,u.id,cfg.productId));
});
test('refund racing correct redemption cannot leave usable access',async()=>{
 const {u,p,g,payment}=await approved(),code=await codeFor(g);
 Object.assign(p.mp.payments.get(payment.id),{status:'refunded',transaction_amount_refunded:40});
 const results=await Promise.allSettled([redeem(db,cfg,u,{grantId:g.id,code}),processPayment(db,cfg,p.mp,payment.id)]);
 assert.equal(results[1].status,'fulfilled');assert.equal((await access(db,u.id,cfg.productId)).active,false);
});
test('calendar year uses financial timestamp, including leap day, and cannot activate an expired year',async()=>{
 const u=await user(db),p=provider(),o=await purchase(u,p),payment=await paymentFor(db,p,o.orderId,{date_approved:'2024-02-29T12:00:00.000Z'});
 await processPayment(db,cfg,p.mp,payment.id);const g=await grantFor(o.orderId);
 assert.equal(new Date(g.ends_at).toISOString(),'2025-02-28T12:00:00.000Z');
 const code=await codeFor(g);await assert.rejects(()=>redeem(db,cfg,u,{grantId:g.id,code}),e=>e.code==='access_expired');
});
test('partial refund can escalate to chargeback without restoring or hiding the financial state',async()=>{
 const {u,p,payment}=await approved();
 Object.assign(p.mp.payments.get(payment.id),{transaction_amount_refunded:1});await processPayment(db,cfg,p.mp,payment.id);
 Object.assign(p.mp.payments.get(payment.id),{status:'charged_back'});await processPayment(db,cfg,p.mp,payment.id);
 assert.equal((await db.query('select status from billing.payments where id=$1',[payment.id])).rows[0].status,'charged_back');
 assert.equal((await access(db,u.id,cfg.productId)).active,false);
});
test('approval racing the preference response stays approved and never reopens the checkout link',async()=>{
 const u=await user(db),p=provider(),create=p.mp.createPreference;
 p.mp.createPreference=async order=>{
  const pref=await create(order),payment=await paymentFor(db,p,order.id);
  await processPayment(db,cfg,p.mp,payment.id);return pref;
 };
 const result=await purchase(u,p);assert.equal(result.state,'approved');assert.equal(result.checkoutUrl,null);
 const order=(await db.query('select checkout_status,financial_status from billing.orders where id=$1',[result.orderId])).rows[0];
 assert.equal(order.checkout_status,'closed');assert.equal(order.financial_status,'approved');
});
test('installation binds product, Supabase project, receiver and test mode; production cannot reuse test rights',async()=>{
 const {verifyInstallation}=await import('../server/db.js');
 await verifyInstallation(db,cfg);await verifyInstallation(db,cfg);
 for(const override of [{mpMode:'live'},{mpCollectorId:'9876'},{productId:'another-product'},{supabaseUrl:'https://another.supabase.co'}])
  await assert.rejects(()=>verifyInstallation(db,{...cfg,...override}),/context mismatch/);
});
