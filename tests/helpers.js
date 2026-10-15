import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { readFile,readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
export const cfg={appOrigin:'https://shop.example',supabaseUrl:'https://project.supabase.co',supabaseKey:'public-test-key',
 encryptionKey:'a'.repeat(64),hmacKey:'b'.repeat(64),mpWebhookSecret:'webhook-test-secret',mpCollectorId:'12345',mpMode:'test',productId:'forma-premium',secureCookies:false};
export async function fixture(){
 let db;
 if(process.env.TEST_DATABASE_URL){
  const url=new URL(process.env.TEST_DATABASE_URL);
  if(!['127.0.0.1','localhost'].includes(url.hostname)||!url.pathname.startsWith('/forma_test_'))throw Error('Tests require a disposable local forma_test_ database');
  db=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:6});
  await db.query('drop schema if exists billing cascade; drop schema if exists auth cascade;');
 }else{
  const engine=new PGlite();let queue=Promise.resolve();
  const acquire=async()=>{const previous=queue;let release;queue=new Promise(r=>{release=r});await previous;return release;};
  db={async connect(){const release=await acquire();return {query:(...args)=>engine.query(...args),release};},
   async query(...args){const release=await acquire();try{return await engine.query(...args);}finally{release();}},
   async exec(sql){const release=await acquire();try{return await engine.exec(sql);}finally{release();}},end:()=>engine.close()};
 }
 const exec=sql=>db.exec?db.exec(sql):db.query(sql);
 await exec(`do $$ begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;end $$;
  create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);`);
 for(const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort())await exec(await readFile(`supabase/migrations/${file}`,'utf8'));
 return db;
}
export async function user(db){const id=randomUUID();await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[id,`${id}@example.com`]);return {id,email:`${id}@example.com`};}
export function provider(){
 const mp={creates:0,payments:new Map(),preferences:new Map(),async createPreference(order){mp.creates++;const pref={external_reference:order.id,collector_id:12345,live_mode:false,expires:true,expiration_date_to:new Date(order.checkout_expires_at).toISOString(),items:[{id:order.price_id,quantity:1,currency_id:order.currency,unit_price:order.amount_cents/100}],id:`pref-${order.id}`,sandbox_init_point:`https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=${order.id}`,init_point:'https://www.mercadopago.com.br/checkout/v1/redirect'};mp.preferences.set(pref.id,pref);return pref;},
 async searchPreferences(reference){const elements=[...mp.preferences.values()].filter(p=>p.external_reference===reference);return {elements:elements.slice(0,2),total:elements.length};},
 async getPreference(id){return mp.preferences.get(id);},
 async getPayment(id){const p=mp.payments.get(String(id));if(!p)throw Error('Missing mock payment');return structuredClone(p);},
 async searchPayments(reference,offset=0){const all=[...mp.payments.values()].filter(p=>p.external_reference===reference);return {results:all.slice(offset,offset+50),paging:{total:all.length}};}};
 const email={sent:[],fail:false,async send(value){if(email.fail)throw Error('mock delivery failure');email.sent.push(value);return {id:'email-test'};}};
 return {mp,email};
}
let counter=1000;
export async function paymentFor(db,providers,orderId,overrides={}){
 const order=(await db.query('select * from billing.orders where id=$1',[orderId])).rows[0];
 const payment={id:String(++counter),external_reference:orderId,collector_id:12345,live_mode:false,currency_id:'BRL',transaction_amount:order.amount_cents/100,
 status:'approved',date_approved:new Date().toISOString(),transaction_amount_refunded:0,...overrides};
 providers.mp.payments.set(payment.id,payment);return payment;
}
