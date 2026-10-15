import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cfg } from './helpers.js';
import { mercadoPago,emailProvider } from '../server/providers.js';
test('provider adapters use fixed APIs, exact cent conversion, opaque references and email idempotency',async()=>{
 const original=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options)=>{calls.push({url:String(url),...options});return Response.json({id:'resource'});};
 try{
  const mp=mercadoPago({...cfg,mpToken:'test-token'}),id=randomUUID();
  await mp.createPreference({id,price_id:randomUUID(),snapshot:{name:'Product'},plan:'annual',currency:'BRL',amount_cents:4001,checkout_expires_at:new Date(Date.now()+86400000)});
  const body=JSON.parse(calls[0].body);assert.equal(body.items[0].unit_price,40.01);assert.equal(body.external_reference,id);assert.equal(body.payer,undefined);
  assert.equal(new URL(calls[0].url).pathname,'/checkout/preferences');assert.equal(calls[0].headers['X-Idempotency-Key'],undefined);
  await mp.getPayment('123');assert.equal(calls[1].url,'https://api.mercadopago.com/v1/payments/123');
  await assert.rejects(async()=>mp.getPayment('https://evil.invalid'));
  await emailProvider({...cfg,resendKey:'test-resend',emailFrom:'sender@example.com'}).send({key:'activation-unique',to:'owner@example.com',code:'test-code',productName:'Product'});
  assert.equal(calls[2].url,'https://api.resend.com/emails');assert.equal(calls[2].headers['Idempotency-Key'],'activation-unique');
  assert.ok(calls.every(c=>c.redirect==='error'&&c.signal));
 }finally{globalThis.fetch=original;}
});
