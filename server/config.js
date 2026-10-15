export function loadConfig(env = process.env) {
  const required = ['APP_ORIGIN','SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','DATABASE_URL','DATA_ENCRYPTION_KEY','ACTIVATION_HMAC_KEY','MP_ACCESS_TOKEN','MP_WEBHOOK_SECRET','MP_COLLECTOR_ID','MP_MODE','RESEND_API_KEY','EMAIL_FROM'];
  const missing = required.filter(key=>!env[key]);
  if (missing.length) throw new Error(`Missing environment variables (names only): ${missing.join(', ')}`);
  for(const key of ['DATA_ENCRYPTION_KEY','ACTIVATION_HMAC_KEY']) if(!/^[a-f0-9]{64}$/i.test(env[key])) throw new Error(`${key} must be 32 random bytes encoded in hex`);
  if(env.DATA_ENCRYPTION_KEY===env.ACTIVATION_HMAC_KEY)throw new Error('Use independent encryption and HMAC keys');
  const origin=new URL(env.APP_ORIGIN);
  if(origin.origin!==env.APP_ORIGIN || (origin.protocol!=='https:' && !['localhost','127.0.0.1'].includes(origin.hostname)))throw new Error('APP_ORIGIN must be an HTTPS origin (HTTP allowed only on localhost)');
  if(!['test','live'].includes(env.MP_MODE))throw new Error('MP_MODE must be test or live');
  if(!/^\d+$/.test(env.MP_COLLECTOR_ID))throw new Error('MP_COLLECTOR_ID must be the receiving account ID');
  if(new URL(env.SUPABASE_URL).protocol!=='https:' && !env.SUPABASE_URL.startsWith('http://127.0.0.1:'))throw new Error('Invalid Supabase URL');
  const trustProxy=env.TRUST_PROXY_CIDRS?.split(',').map(s=>s.trim()).filter(Boolean)??false;
  if(trustProxy&&trustProxy.some(s=>['true','1','0.0.0.0/0','::/0'].includes(s)))throw new Error('TRUST_PROXY_CIDRS requires explicit trusted proxy addresses/CIDRs');
  return { trustProxy, appOrigin:env.APP_ORIGIN, supabaseUrl:env.SUPABASE_URL, supabaseKey:env.SUPABASE_PUBLISHABLE_KEY,
    databaseUrl:env.DATABASE_URL, encryptionKey:env.DATA_ENCRYPTION_KEY, hmacKey:env.ACTIVATION_HMAC_KEY,
    mpToken:env.MP_ACCESS_TOKEN, mpWebhookSecret:env.MP_WEBHOOK_SECRET, mpCollectorId:env.MP_COLLECTOR_ID,
    mpMode:env.MP_MODE, resendKey:env.RESEND_API_KEY, emailFrom:env.EMAIL_FROM,
    port:Number(env.PORT??3000), secureCookies:origin.protocol==='https:', productId:env.PRODUCT_ID??'forma-premium' };
}
