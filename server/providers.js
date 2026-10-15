import { Problem } from './core.js';
export async function jsonRequest(url, options) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(12_000), redirect:'error' });
  if(!res.ok) { const e=new Problem(503, `provider_http_${res.status}`); e.providerStatus=res.status; throw e; }
  return res.json();
}
export function mercadoPago(cfg) {
  const headers={Authorization:`Bearer ${cfg.mpToken}`,'Content-Type':'application/json'};
  return {
    async createPreference(order) {
      // Preferences are not Payments. Do not claim /v1/payments idempotency for this POST.
      return jsonRequest('https://api.mercadopago.com/checkout/preferences', { method:'POST',headers,body:JSON.stringify({
        external_reference:order.id,
        items:[{id:order.price_id,title:`${order.snapshot.name} — ${order.plan==='annual'?'Anual':'Vitalício'}`,
          quantity:1,currency_id:order.currency,unit_price:order.amount_cents/100}],
        back_urls:{success:`${cfg.appOrigin}/?premium=1`,pending:`${cfg.appOrigin}/?premium=1`,failure:`${cfg.appOrigin}/?premium=1`},
        notification_url:`${cfg.appOrigin}/api/webhooks/mercadopago?source_news=webhooks`,
        auto_return:'approved',expires:true,expiration_date_to:new Date(order.checkout_expires_at).toISOString(),
        statement_descriptor:String(order.snapshot.name).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9 ]/g,'').trim().toUpperCase().slice(0,22)||'PREMIUM'
      })});
    },
    getPayment(id) {
      if(!/^\d{1,30}$/.test(String(id)))throw new Problem(422,'invalid_payment_id');
      return jsonRequest(`https://api.mercadopago.com/v1/payments/${id}`,{headers});
    },
    searchPayments(reference,offset=0) {
      const params=new URLSearchParams({external_reference:reference,sort:'date_created',criteria:'desc',limit:'50',offset:String(offset)});
      return jsonRequest(`https://api.mercadopago.com/v1/payments/search?${params}`,{headers});
    },
    searchPreferences(reference) {
      const params=new URLSearchParams({external_reference:reference,limit:'2',offset:'0'});
      return jsonRequest(`https://api.mercadopago.com/checkout/preferences/search?${params}`,{headers});
    },
    getPreference(id) {
      if(!/^[a-zA-Z0-9_-]{1,150}$/.test(id))throw new Problem(422,'invalid_preference');
      return jsonRequest(`https://api.mercadopago.com/checkout/preferences/${id}`,{headers});
    }
  };
}
export function emailProvider(cfg) {
  return {
    async send({key,to,code,productName}) {
      return jsonRequest('https://api.resend.com/emails', {method:'POST',headers:{Authorization:`Bearer ${cfg.resendKey}`,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({
        from:cfg.emailFrom,to:[to],subject:`Ative seu acesso — ${productName}`,
        text:`Seu pagamento foi confirmado.\n\nCódigo de ativação: ${code}\n\nO código é pessoal e expira em 15 minutos. Entre em ${cfg.appOrigin}/?premium=1 com a conta que fez a compra e abra Code. Se o código expirar, solicite um novo; sua compra permanece registrada.\n\nNão compartilhe este código.`
      })});
    }
  };
}
