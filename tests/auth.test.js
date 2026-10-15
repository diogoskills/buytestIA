import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,cfg,user } from './helpers.js';
import { authService } from '../server/auth.js';
import { unseal } from '../server/core.js';
let db;
before(async()=>{db=await fixture();});after(async()=>{await db?.end();});
function response(){return {headers:[],append(name,value){this.headers.push([name,value]);},redirect(status,url){this.destination=url;},cookie(name){return this.headers.find(([,v])=>v.startsWith(name+'='))?.[1].split(';')[0];}};}
test('real Supabase SDK PKCE flow requires browser verifier, verifies identity, stores encrypted session, rejects replay',async()=>{
 const u=await user(db),auth=authService(db,cfg),res=response(),original=globalThis.fetch;
 let redirectTo,otpBody,verified=0;
 const token=[{alg:'HS256',typ:'JWT'},{sub:u.id,exp:Math.floor(Date.now()/1000)+3600,aud:'authenticated'},'test'].map(v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url')).join('.');
 const authUser={id:u.id,email:u.email,email_confirmed_at:new Date().toISOString(),aud:'authenticated',role:'authenticated',created_at:new Date().toISOString()};
 globalThis.fetch=async(url,options)=>{
  const target=String(url);
  if(target.includes('/otp')){redirectTo=new URL(target).searchParams.get('redirect_to');otpBody=JSON.parse(options.body);return Response.json({});}
  if(target.includes('/token')){
   const body=JSON.parse(options.body);assert.ok(body.code_verifier?.length>20);
   return Response.json({access_token:token,refresh_token:'test-refresh-token',expires_in:3600,token_type:'bearer',user:authUser});
  }
  if(target.endsWith('/user')){verified++;return Response.json(authUser);}
  throw Error('Unexpected Auth endpoint');
 };
 try{
  await auth.start({body:{email:u.email,productId:cfg.productId,plan:'lifetime'}},res);
  assert.equal(otpBody.email,u.email);assert.equal(otpBody.code_challenge_method,'s256');assert.ok(otpBody.code_challenge);
  const flow=res.cookie('premium_flow').split('=')[1].split('.')[0];assert.equal(new URL(redirectTo).pathname,'/auth/callback');
  const callback={query:{flow,code:'test-auth-code'},headers:{cookie:res.cookie('premium_flow')}};
  await assert.rejects(()=>auth.callback({...callback,headers:{cookie:'premium_flow=wrong'}},response()));
  const logged=response();await auth.callback(callback,logged);assert.equal(logged.destination,'/?premium=1');
  const sessionCookie=logged.cookie('premium_session');assert.ok(sessionCookie);
  const row=(await db.query('select * from billing.sessions where user_id=$1',[u.id])).rows[0];
  assert.ok(!row.tokens_cipher.includes(token));assert.equal(unseal(cfg.encryptionKey,row.tokens_cipher).access_token,token);
  const restored=await auth.user({headers:{cookie:sessionCookie}});assert.equal(restored.id,u.id);assert.equal(restored.intent.plan,'lifetime');assert.equal(verified,1);
  await assert.rejects(()=>auth.callback(callback,response()));
  await auth.logout({headers:{cookie:sessionCookie}},response());await assert.rejects(()=>auth.user({headers:{cookie:sessionCookie}}));
 }finally{globalThis.fetch=original;}
});
test('public Auth response does not reveal account existence and rejects malformed email',async()=>{
 const auth=authService(db,cfg),original=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({msg:'Account restricted'},{status:422});
 try{
  const result=await auth.start({body:{email:'a.b+alias@example.com',productId:cfg.productId,plan:'annual'}},response());
  assert.ok(result.message.includes('Se o envio estiver disponível'));
  await assert.rejects(()=>auth.start({body:{email:'invalid',productId:cfg.productId,plan:'annual'}},response()));
 }finally{globalThis.fetch=original;}
});
