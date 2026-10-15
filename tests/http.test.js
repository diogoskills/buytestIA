import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,cfg,user,provider } from './helpers.js';
import { createApp } from '../server/app.js';
import { Problem,mac } from '../server/core.js';
let db,server,base,u,other,providers;
before(async()=>{
 db=await fixture();u=await user(db);other=await user(db);providers=provider();
 const auth={async user(req){if(req.headers['x-test-user']==='owner')return u;if(req.headers['x-test-user']==='other')return other;throw new Problem(401,'login_required');},async start(){return {message:'Confira seu e-mail.'};},async logout(){},async callback(){throw new Problem(400,'invalid_auth_link');}};
 server=createApp({db,cfg,providers,auth}).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{await new Promise(resolve=>server?.close(resolve));await db?.end();});
async function headers(owner='owner'){
 const res=await fetch(base+'/api/session',{headers:{'x-test-user':owner}});const data=await res.json();
 return {'x-test-user':owner,Origin:cfg.appOrigin,'X-CSRF-Token':data.csrf,Cookie:`premium_csrf=${data.csrf}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()};
}
test('checkout enforces session, CSRF/origin and rejects caller price/UUID overrides',async()=>{
 const h=await headers();
 for(const change of [{Origin:'https://evil.example'},{'X-CSRF-Token':'wrong'},{'x-test-user':''}]){
  const res=await fetch(base+'/api/checkout',{method:'POST',headers:{...h,...change},body:JSON.stringify({productId:cfg.productId,plan:'annual'})});
  assert.ok([401,403].includes(res.status));
 }
 for(const extra of [{amountCents:1},{userId:other.id},{email:other.email},{premium:true}]){
  const res=await fetch(base+'/api/checkout',{method:'POST',headers:h,body:JSON.stringify({productId:cfg.productId,plan:'annual',...extra})});assert.equal(res.status,400);
 }
 const res=await fetch(base+'/api/checkout',{method:'POST',headers:h,body:JSON.stringify({productId:cfg.productId,plan:'annual'})});assert.equal(res.status,200);const o=await res.json();
 const account=await(await fetch(base+'/api/account',{headers:await headers('other')})).json();assert.equal(account.orders.length,0);
 const owner=await(await fetch(base+'/api/account',{headers:h})).json();assert.equal(owner.orders[0].id,o.orderId);assert.equal(owner.orders[0].amount_cents,4000);
});
test('webhook authenticates signature without buyer session; persists before acknowledgment; rejects oversized JSON',async()=>{
 const id='900001',ts=String(Date.now()),requestId='test-request';
 const body=JSON.stringify({type:'payment',data:{id},url:'https://evil.invalid/do-not-fetch'});
 const url=base+`/api/webhooks/mercadopago?data.id=${id}`;
 const bad=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-signature':'present'},body});assert.equal(bad.status,401);
 const signature=`ts=${ts},v1=${mac(cfg.mpWebhookSecret,`id:${id};request-id:${requestId};ts:${ts};`)}`;
 const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-signature':signature,'x-request-id':requestId},body});assert.equal(res.status,200);
 assert.equal((await db.query('select count(*)::int n from billing.events where resource_id=$1',[id])).rows[0].n,1);
 assert.equal((await db.query("select count(*)::int n from billing.jobs where payload->>'paymentId'=$1",[id])).rows[0].n,1);
 const huge=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'payment',data:{id},extra:'a'.repeat(17000)})});assert.equal(huge.status,413);
});
test('private files and premium endpoint are protected; unauthenticated catalog exposes only public data',async()=>{
 for(const route of ['/.env','/server/config.js','/supabase/migrations/202610160001_premium.sql'])assert.equal((await fetch(base+route)).status,404);
 assert.equal((await fetch(base+'/api/premium/benefits',{headers:await headers()})).status,403);
 const res=await fetch(base+'/api/catalog');const {product}=await res.json();assert.equal(product.prices.find(p=>p.plan==='lifetime').amountCents,12000);
 assert.ok(!JSON.stringify(product).includes('mpToken'));
});
test('webhook never acknowledges an event when durable storage is unavailable',async()=>{
 const badDb={async connect(){throw Error('database unavailable');},async query(){throw Error('database unavailable');}};
 const broken=createApp({db:badDb,cfg,providers,auth:{}}).listen(0,'127.0.0.1');await new Promise(r=>broken.once('listening',r));
 try{
  const id='900002',ts=String(Date.now()),requestId='db-down';
  const signature=`ts=${ts},v1=${mac(cfg.mpWebhookSecret,`id:${id};request-id:${requestId};ts:${ts};`)}`;
  const res=await fetch(`http://127.0.0.1:${broken.address().port}/api/webhooks/mercadopago?data.id=${id}`,{method:'POST',headers:{'Content-Type':'application/json','x-signature':signature,'x-request-id':requestId},body:JSON.stringify({type:'payment',data:{id}})});
  assert.equal(res.status,503);assert.equal((await res.json()).received,undefined);
 }finally{await new Promise(r=>broken.close(r));}
});
