// Test-only dependency injection. This file is never imported by production.
import { createApp } from '../server/app.js';
import { fixture,cfg,user,provider,paymentFor } from './helpers.js';
import { Problem } from '../server/core.js';
import { processPayment } from '../server/billing.js';
import { runBatch } from '../server/jobs.js';
export async function startFixture(){
 const prior=process.env.TEST_DATABASE_URL;delete process.env.TEST_DATABASE_URL;
 let db;try{db=await fixture();}finally{if(prior)process.env.TEST_DATABASE_URL=prior;}
 const owner=await user(db),providers=provider();let origin='';
 const config={...cfg};
 const auth={async user(req){if(req.headers.cookie?.includes('fixture_session=owner'))return owner;throw new Problem(401,'login_required');},
  async start(){return {message:'Se o envio estiver disponível, confira seu e-mail.'};},
  async logout(req,res){res.append('Set-Cookie','fixture_session=; Path=/; Max-Age=0');},async callback(){throw new Problem(400,'test_only');}};
 const server=createApp({db,cfg:config,providers,auth}).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 origin=`http://127.0.0.1:${server.address().port}`;
 // The provider is a deterministic fake; allow HTTP return only in this test function.
 providers.mp.createPreference=async(order)=>{providers.mp.creates++;return {collector_id:12345,external_reference:order.id,id:`test-${order.id}`,sandbox_init_point:`https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=${order.id}`};};
 return {db,origin,owner,providers,config,server,async approve(){
  const order=(await db.query('select * from billing.orders where user_id=$1 order by created_at desc limit 1',[owner.id])).rows[0];
  if(!order)throw Error('No fixture order');
  const payment=await paymentFor(db,providers,order.id);await processPayment(db,cfg,providers.mp,payment.id);await runBatch(db,cfg,providers,10);
  return providers.email.sent.at(-1)?.code;
 },async close(){await new Promise(r=>server.close(r));await db.end();}};
}
