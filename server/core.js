import { randomBytes, createHash, createHmac, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
export class Problem extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}
export const uuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const mac = (key, value) => createHmac('sha256', key).update(value).digest('hex');
export function equal(a, b) {
  if(typeof a!=='string'||typeof b!=='string')return false;
  const left=Buffer.from(a),right=Buffer.from(b);
  return left.length===right.length&&timingSafeEqual(left,right);
}
export const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();
export function validEmail(email) { return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
export function cents(value) {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new Problem(422, 'invalid_money');
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}
export function seal(key, value) {
  const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const encrypted = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), encrypted]).toString('base64url');
}
export function unseal(key, value) {
  const b = Buffer.from(value, 'base64url'); const d = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), b.subarray(0,12));
  d.setAuthTag(b.subarray(12,28)); return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());
}
export function verifyWebhook({ signature, requestId, dataId, bodyId, secret, now = Date.now(), toleranceMs = 15 * 60_000 }) {
  if (!secret || typeof signature !== 'string' || signature.length > 512 ||
    typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(requestId) ||
    typeof dataId !== 'string' || !/^\d{1,30}$/.test(dataId) || String(bodyId) !== dataId) throw new Problem(401, 'invalid_signature');
  const parts = signature.split(',').map(p => p.trim().split('='));
  const tsParts = parts.filter(([k]) => k === 'ts'); const vParts = parts.filter(([k]) => k === 'v1');
  if (parts.some(p=>p.length!==2) || tsParts.length !== 1 || vParts.length !== 1) throw new Problem(401, 'invalid_signature');
  const ts = tsParts[0][1]; const v1 = vParts[0][1];
  if (!/^\d{10,13}$/.test(ts ?? '') || !/^[a-f0-9]{64}$/i.test(v1 ?? '')) throw new Problem(401, 'invalid_signature');
  const time = Number(ts) * (ts.length === 10 ? 1000 : 1);
  if (Math.abs(now-time) > toleranceMs) throw new Problem(401, 'stale_signature');
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  if (!equal(mac(secret, manifest), v1.toLowerCase())) throw new Problem(401, 'invalid_signature');
  return hash(`${manifest}${v1}`);
}
export function validatePayment(payment, order, cfg) {
  if (!payment || !/^\d{1,30}$/.test(String(payment.id)) || payment.external_reference !== order.id ||
    String(payment.collector_id) !== cfg.mpCollectorId || order.snapshot.providerMode!==cfg.mpMode ||
    order.snapshot.collectorId!==cfg.mpCollectorId || payment.live_mode !== (cfg.mpMode === 'live') ||
    payment.currency_id !== order.currency || cents(payment.transaction_amount) !== order.amount_cents) throw new Problem(422, 'payment_mismatch');
  const statuses = ['approved','pending','in_process','authorized','in_mediation','rejected','cancelled','refunded','charged_back'];
  if (!statuses.includes(payment.status)) throw new Problem(422, 'unknown_payment_status');
  if (payment.status === 'approved' && (!payment.date_approved || !Number.isFinite(Date.parse(payment.date_approved)) || Date.parse(payment.date_approved)>Date.now()+60_000)) throw new Problem(422,'invalid_approval_date');
}
export async function transaction(db, fn) {
  const c = await db.connect();
  try { await c.query('begin'); const result = await fn(c); await c.query('commit'); return result; }
  catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}
export async function lock(c, value) { await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [value]); }
export async function enqueue(c, kind, key, payload) {
  await c.query(`insert into billing.jobs(kind,key,payload) values($1,$2,$3) on conflict(key) do nothing`, [kind,key,JSON.stringify(payload)]);
}
export async function rateLimit(db, key, limit, seconds) {
  const { rows } = await db.query(`insert into billing.rate_limits(key,hits,resets_at)
    values($1,1,now()+$2::integer*interval '1 second') on conflict(key) do update set
    hits=case when billing.rate_limits.resets_at <= now() then 1 else billing.rate_limits.hits+1 end,
    resets_at=case when billing.rate_limits.resets_at <= now() then now()+$2::integer*interval '1 second' else billing.rate_limits.resets_at end
    returning hits`, [key,seconds]);
  if (rows[0].hits>limit) throw new Problem(429,'rate_limited','Aguarde um pouco antes de tentar novamente.');
}
