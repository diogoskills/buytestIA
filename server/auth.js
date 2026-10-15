import { createClient } from '@supabase/supabase-js';
import { randomBytes, randomUUID } from 'node:crypto';
import { Problem, hash, mac, equal, normalizeEmail, validEmail, seal, unseal, transaction, rateLimit, uuid } from './core.js';
export function cookies(req) {
  return Object.fromEntries((req.headers.cookie??'').split(';').flatMap(p=>{
    const i=p.indexOf('='); if(i<0)return []; return [[p.slice(0,i).trim(),p.slice(i+1).trim()]];
  }));
}
export function setCookie(res,cfg,name,value,maxAge) {
  res.append('Set-Cookie',`${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cfg.secureCookies?'; Secure':''}`);
}
function authClient(cfg, storage = new Map()) {
  return createClient(cfg.supabaseUrl,cfg.supabaseKey,{auth:{flowType:'pkce',storageKey:'forma-auth',
    autoRefreshToken:false,detectSessionInUrl:false,persistSession:true,
    storage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}},
    global:{fetch:(url,opts)=>fetch(url,{...opts,signal:AbortSignal.timeout(12_000)})}});
}
export function authService(db,cfg) {
  return {
    async start(req,res) {
      const {email,productId,plan}=req.body??{};
      if(!validEmail(email)||productId!==cfg.productId||!['annual','lifetime'].includes(plan))throw new Problem(400,'invalid_input','Informe um e-mail válido e escolha o plano.');
      const normalized=normalizeEmail(email);
      await rateLimit(db,`login-email:${mac(cfg.hmacKey,normalized)}`,3,3600);
      const products=await db.query('select id from billing.products where id=$1 and enabled',[productId]);
      if(!products.rows.length)throw new Problem(404,'product_unavailable');
      const id=randomUUID(), browser=randomBytes(32).toString('hex'), storage=new Map();
      setCookie(res,cfg,'premium_flow',`${id}.${browser}`,3600);
      const client=authClient(cfg,storage);
      const {error}=await client.auth.signInWithOtp({email:normalized,options:{shouldCreateUser:true,
        emailRedirectTo:`${cfg.appOrigin}/auth/callback`,...(req.body.captchaToken?{captchaToken:req.body.captchaToken}:{})}});
      const verifier=storage.get('forma-auth-code-verifier');
      if(!error&&verifier)await db.query(`insert into billing.auth_flows(id,browser_hash,email_hash,verifier_cipher,product_id,plan,expires_at)
        values($1,$2,$3,$4,$5,$6,now()+interval '1 hour')`,[id,hash(browser),mac(cfg.hmacKey,normalized),seal(cfg.encryptionKey,verifier),productId,plan]);
      // Same response for unknown/existing accounts, throttled Auth and mail errors.
      return {message:'Se o envio estiver disponível, você receberá um link. Confira o e-mail e abra o link neste navegador. Se não chegar, aguarde e tente novamente.'};
    },
    async callback(req,res) {
      const {code}=req.query;
      const [flow,browser='']=String(cookies(req).premium_flow??'').split('.');
      if(!uuid(flow)||typeof code!=='string'||code.length>4096)throw new Problem(400,'invalid_auth_link');
      const session=await transaction(db,async c=>{
        const {rows}=await c.query('select * from billing.auth_flows where id=$1 for update',[flow]);
        const f=rows[0];
        if(!f||f.consumed_at||new Date(f.expires_at)<=new Date()||!equal(f.browser_hash,hash(browser)))throw new Problem(400,'invalid_auth_link','Abra o link no navegador em que pediu o acesso ou solicite outro link.');
        const storage=new Map([['forma-auth-code-verifier',unseal(cfg.encryptionKey,f.verifier_cipher)]]);
        const {data,error}=await authClient(cfg,storage).auth.exchangeCodeForSession(code);
        if(error||!data.session||!data.user?.email_confirmed_at||!equal(mac(cfg.hmacKey,normalizeEmail(data.user.email)),f.email_hash))throw new Problem(400,'invalid_auth_link');
        const sid=randomBytes(32).toString('hex');
        await c.query(`insert into billing.sessions(id_hash,user_id,tokens_cipher,token_expires_at,expires_at,intent)
          values($1,$2,$3,to_timestamp($4),now()+interval '30 days',$5)`,[hash(sid),data.user.id,
          seal(cfg.encryptionKey,{access_token:data.session.access_token,refresh_token:data.session.refresh_token}),data.session.expires_at,
          JSON.stringify({productId:f.product_id,plan:f.plan})]);
        await c.query('update billing.auth_flows set consumed_at=now(),verifier_cipher=$2 where id=$1',[flow,'consumed']);
        return sid;
      });
      setCookie(res,cfg,'premium_session',session,30*86400);
      setCookie(res,cfg,'premium_flow','',0);
      res.redirect(303,'/?premium=1');
    },
    async user(req) {
      const sid=cookies(req).premium_session;
      if(!sid||!/^[a-f0-9]{64}$/.test(sid))throw new Problem(401,'login_required','Entre pelo e-mail para continuar.');
      return transaction(db,async c=>{
        const {rows}=await c.query('select * from billing.sessions where id_hash=$1 and expires_at>now() for update',[hash(sid)]);
        const session=rows[0];if(!session)throw new Problem(401,'login_required');
        let tokens=unseal(cfg.encryptionKey,session.tokens_cipher);
        const client=authClient(cfg);
        if(new Date(session.token_expires_at).getTime()<Date.now()+60_000){
          const {data,error}=await client.auth.refreshSession({refresh_token:tokens.refresh_token});
          if(error||!data.session)throw new Problem(401,'session_expired','Sua sessão expirou. Entre novamente pelo e-mail.');
          tokens={access_token:data.session.access_token,refresh_token:data.session.refresh_token};
          await c.query('update billing.sessions set tokens_cipher=$2,token_expires_at=to_timestamp($3) where id_hash=$1',[session.id_hash,seal(cfg.encryptionKey,tokens),data.session.expires_at]);
        }
        const {data,error}=await client.auth.getUser(tokens.access_token);
        if(error||!data.user?.email_confirmed_at||data.user.id!==session.user_id)throw new Problem(401,'login_required');
        return {id:data.user.id,email:data.user.email,intent:session.intent};
      });
    },
    async logout(req,res) {
      const sid=cookies(req).premium_session;
      if(sid)await db.query('delete from billing.sessions where id_hash=$1',[hash(sid)]);
      setCookie(res,cfg,'premium_session','',0);
    }
  };
}
