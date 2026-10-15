import test from 'node:test';
import assert from 'node:assert/strict';
import { cents,mac,verifyWebhook,seal,unseal,normalizeEmail,equal } from '../server/core.js';
import { validCheckoutUrl } from '../server/billing.js';
const secret='test-key',requestId='request-123',id='123456';
function signature(ts){return `ts=${ts},v1=${mac(secret,`id:${id};request-id:${requestId};ts:${ts};`)}`;}
test('official payment signature manifest and timestamp validation',()=>{
 const ts=String(Date.now());const fields={signature:signature(ts),requestId,dataId:id,bodyId:id,secret};
 assert.ok(verifyWebhook(fields));
 assert.throws(()=>verifyWebhook({...fields,signature:`ts=${ts},v1=${'0'.repeat(64)}`}));
 assert.throws(()=>verifyWebhook({...fields,bodyId:'999'}));
 assert.throws(()=>verifyWebhook({...fields,requestId:undefined}));
 const old=String(Date.now()-3600000);assert.throws(()=>verifyWebhook({...fields,signature:signature(old)}));
 assert.throws(()=>verifyWebhook({...fields,signature:`${fields.signature},ts=${ts}`}));
});
test('integer cents, email normalization preserves dots and plus aliases, redirect allowlist',()=>{
 assert.equal(cents('40.01'),4001);assert.equal(cents(120),12000);
 for(const invalid of ['40.001','NaN',-1,Infinity,'1e3'])assert.throws(()=>cents(invalid));
 assert.equal(normalizeEmail(' A.B+work@Example.com '),'a.b+work@example.com');
 assert.ok(validCheckoutUrl('https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=123'));
 assert.ok(!validCheckoutUrl('https://www.mercadopago.com.br.evil.test'));
 assert.ok(!validCheckoutUrl('javascript:alert(1)'));
});
test('encryption authenticates tokens and code payloads',()=>{
 const key='a'.repeat(64),cipher=seal(key,'never-store-plaintext');
 assert.ok(!cipher.includes('never-store-plaintext'));assert.equal(unseal(key,cipher),'never-store-plaintext');
 assert.throws(()=>unseal('b'.repeat(64),cipher));
 assert.equal(equal('é','a'),false);assert.equal(equal(undefined,''),false);assert.equal(equal('abc','abc'),true);
});
