import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Problem, equal, mac, verifyWebhook, rateLimit, transaction, enqueue } from './core.js';
import { cookies, setCookie, authService } from './auth.js';
import { catalog, checkout, accountState, resend, redeem, requireAccess } from './billing.js';
import { recordWebhook } from './jobs.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function createApp({db,cfg,providers,auth=authService(db,cfg)}) {
  const app=express();app.disable('x-powered-by');
  // Trust only operator-specified ingress CIDRs; client-supplied forwarding headers are otherwise ignored.
  if(cfg.trustProxy)app.set('trust proxy',cfg.trustProxy);
  app.use((req,res,next)=>{
    res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
    if(req.path.startsWith('/api/')||req.path.startsWith('/auth/'))res.set('Cache-Control','no-store');
    next();
  });
  app.post('/api/webhooks/mercadopago',express.json({limit:'16kb',strict:true}),async(req,res)=>{
    if(req.body?.type!=='payment')throw new Problem(400,'unsupported_topic');
    const delivery=verifyWebhook({signature:req.get('x-signature'),requestId:req.get('x-request-id'),
      dataId:req.query['data.id'],bodyId:req.body?.data?.id,secret:cfg.mpWebhookSecret});
    await recordWebhook(db,delivery,String(req.body.data.id));
    res.status(200).json({received:true});
  });
  app.use('/api',express.json({limit:'8kb',strict:true}));
  app.use('/api',async(req,res,next)=>{
    if(['POST','PUT','PATCH','DELETE'].includes(req.method)){
      if(req.get('origin')!==cfg.appOrigin||!equal(req.get('x-csrf-token'),cookies(req).premium_csrf))throw new Problem(403,'invalid_origin_or_csrf');
    }
    // Aggregate IP protection in DB, works across API instances. No PII is stored in the key.
    await rateLimit(db,`ip:${mac(cfg.hmacKey,req.ip??'unknown')}`,120,60);
    next();
  });
  app.get('/health',async(req,res)=>{await db.query('select 1');res.json({ok:true});});
  app.get('/api/catalog',async(req,res)=>{res.json({product:await catalog(db,cfg.productId)});});
  app.get('/api/session',async(req,res)=>{
    let csrf=cookies(req).premium_csrf;
    if(!/^[a-f0-9]{64}$/.test(csrf??'')){csrf=randomBytes(32).toString('hex');setCookie(res,cfg,'premium_csrf',csrf,86400);}
    try{const user=await auth.user(req);res.json({user:{id:user.id,email:user.email},intent:user.intent,csrf});}
    catch(e){if(e.status!==401)throw e;res.json({user:null,csrf});}
  });
  app.post('/api/auth/start',async(req,res)=>{
    await rateLimit(db,`login-ip:${mac(cfg.hmacKey,req.ip??'unknown')}`,10,3600);
    res.json(await auth.start(req,res));
  });
  app.get('/auth/callback',async(req,res)=>{
    try{await auth.callback(req,res);}catch{res.redirect(303,'/?premium=1&auth=retry');}
  });
  app.post('/api/auth/logout',async(req,res)=>{await auth.logout(req,res);res.json({ok:true});});
  app.use('/api',async(req,res,next)=>{req.user=await auth.user(req);next();});
  app.get('/api/account',async(req,res)=>{
    await rateLimit(db,`state:${req.user.id}`,20,60);
    res.json(await accountState(db,req.user.id,cfg.productId));
  });
  app.post('/api/checkout',async(req,res)=>{
    await rateLimit(db,`checkout:${req.user.id}`,10,60);
    const allowed=['productId','plan'];
    if(!req.body||Object.keys(req.body).some(k=>!allowed.includes(k)))throw new Problem(400,'unexpected_checkout_field');
    res.json(await checkout(db,cfg,providers.mp,req.user,req.body,req.get('idempotency-key')));
  });
  app.post('/api/account/refresh',async(req,res)=>{
    await rateLimit(db,`refresh:${req.user.id}`,3,60);
    await transaction(db,async c=>{
      const {rows}=await c.query(`select id from billing.orders where user_id=$1 and product_id=$2
        and created_at>now()-interval '180 days' order by created_at desc limit 3`,[req.user.id,cfg.productId]);
      for(const order of rows)await enqueue(c,'reconcile',`refresh:${order.id}:${Math.floor(Date.now()/60000)}`,{orderId:order.id,offset:0});
    });
    res.json({queued:true});
  });
  app.post('/api/activation/redeem',async(req,res)=>{res.json(await redeem(db,cfg,req.user,req.body??{}));});
  app.post('/api/activation/resend',async(req,res)=>{res.json(await resend(db,cfg,req.user,req.body?.grantId));});
  app.get('/api/premium/benefits',async(req,res)=>{
    const grant=await requireAccess(db,req.user.id,cfg.productId);
    res.json({features:grant.features,plan:grant.plan,validUntil:grant.ends_at});
  });
  app.get(['/', '/index.html'],(req,res)=>res.sendFile(path.join(root,'index.html')));
  for(const name of ['styles.css','script.js'])app.get(`/${name}`,(req,res)=>res.sendFile(path.join(root,name)));
  app.use('/assets',express.static(path.join(root,'dist'),{immutable:true,maxAge:'1h',dotfiles:'deny'}));
  app.use((req,res)=>res.status(404).json({error:'not_found'}));
  app.use((error,req,res,next)=>{
    if(res.headersSent)return next(error);
    const status=error.type==='entity.too.large'?413:error.type==='entity.parse.failed'?400:error.status??503;
    const code=error.type==='entity.too.large'?'payload_too_large':error.type==='entity.parse.failed'?'invalid_json':error instanceof Problem?error.code:'service_unavailable';
    if(status===429)res.set('Retry-After','60');
    res.status(status>=400&&status<600?status:503).json({error:code,message:error instanceof Problem?error.message:'Serviço indisponível. Tente novamente em instantes.'});
  });
  return app;
}
