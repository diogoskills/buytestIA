const premium = document.querySelector('#premium-modal');
const codeModal = document.querySelector('#code-modal');
const $ = (id) => document.getElementById(id);
let productId; // Public catalog identifier; the server independently enforces installation scope.
let session = null, csrf = '', product = null, account = null, selectedPlan = 'annual', busy = false;
const money = (cents) => new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL' }).format(cents/100);
const date = (value) => new Date(value).toLocaleDateString('pt-BR');
const planName = (plan) => plan === 'annual' ? 'Anual' : 'Vitalício';
function message(id,text){ $(id).textContent=text; }
async function api(url, body, key) {
  const response = await fetch(url, { method:body === undefined?'GET':'POST', credentials:'same-origin',
    headers:body === undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf,...(key?{'Idempotency-Key':key}:{})},
    body:body === undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20_000) });
  const data = await response.json().catch(()=>({message:'O serviço de checkout está indisponível. Tente novamente mais tarde.'}));
  if(!response.ok) {
    if(response.status===401){session=null;renderIdentity();}
    throw new Error(data.message ?? 'Não foi possível concluir. Tente novamente.');
  }
  return data;
}
function setupDialog(dialog,openers,closer) {
  openers.forEach(id=>$(id).addEventListener('click',async()=>{
    dialog.showModal();
    if(dialog===codeModal)await loadAccount().catch(e=>message('code-message',e.message));
  }));
  $(closer).addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',e=>{
    const r=dialog.getBoundingClientRect();
    if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();
  });
}
setupDialog(premium,['open-premium','banner-premium'],'close-premium');
setupDialog(codeModal,['open-code'],'close-code');
codeModal.addEventListener('close',()=>{$('access-code').value='';});
function renderIdentity(){
  $('login-form').hidden=Boolean(session);
  $('authenticated-checkout').hidden=!session;
  $('account-email').textContent=session?.email??'';
  $('code-email').value=session?.email??'';
  $('code-login').hidden=Boolean(session);
  if(!session)$('code-form').hidden=true;
}
function renderPlans(){
  const container=$('plan-options');container.replaceChildren();
  for(const plan of ['annual','lifetime']){
    const price=product.prices.find(p=>p.plan===plan);
    const label=document.createElement('label');label.className='plan-option';
    const input=document.createElement('input');input.type='radio';input.name='plan';input.value=plan;
    input.checked=selectedPlan===plan;input.disabled=!price;
    input.addEventListener('change',()=>{selectedPlan=plan;renderPurchaseButton();});
    const text=document.createElement('span');const title=document.createElement('strong');title.textContent=planName(plan);
    const note=document.createElement('small');note.textContent=plan==='annual'?'12 meses de acesso · pagamento único':'Sem expiração programada · pagamento único';
    text.append(title,note);const amount=document.createElement('b');amount.textContent=price?money(price.amountCents):'Indisponível';
    label.append(input,text,amount);container.append(label);
  }
}
function renderPurchaseButton(){
  const lifetime=account?.grants.some(g=>g.plan==='lifetime'&&!g.revoked_at);
  const annualBlocked=selectedPlan==='annual'&&account?.grants.some(g=>!g.revoked_at&&g.ends_at&&new Date(g.ends_at).getTime()>Date.now()+30*86400000);
  const price=product?.prices.find(p=>p.plan===selectedPlan);
  $('start-checkout').disabled=busy||lifetime||annualBlocked||!price;
  $('start-checkout').textContent=lifetime?'Você já adquiriu o acesso vitalício':annualBlocked?'Renovação abre nos últimos 30 dias':busy?'Preparando checkout…':'Continuar para pagamento →';
}
const financialLabels={pending:'Aguardando confirmação do pagamento',approved:'Pagamento aprovado',rejected:'Pagamento recusado. Você pode tentar outra compra.',cancelled:'Pagamento cancelado',expired:'Checkout expirado',refunded:'Pagamento reembolsado',charged_back:'Pagamento contestado · acesso suspenso',review:'Pagamento em análise · contate o suporte'};
function appendText(parent,tag,text,className){const el=document.createElement(tag);el.textContent=text;if(className)el.className=className;parent.append(el);return el;}
function renderAccount(){
  renderIdentity();renderPurchaseButton();
  const summary=$('access-summary');summary.replaceChildren();
  if(account?.access.active){
    appendText(summary,'h3','Seu Premium está ativo ✦');
    appendText(summary,'p',account.access.plan==='lifetime'?'Acesso vitalício':`Válido até ${date(account.access.ends_at)}`);
    $('open-premium').textContent='✦ Premium ativo';
  }else{$('open-premium').textContent='✦ Plano Premium';}
  const awaiting=(account?.grants??[]).filter(g=>!g.activated_at&&!g.revoked_at&&(!g.ends_at||new Date(g.ends_at)>new Date()));
  const select=$('activation-grant');select.replaceChildren();
  for(const grant of awaiting){
    const option=document.createElement('option');option.value=grant.id;
    option.textContent=`${planName(grant.plan)}${grant.ends_at?` · até ${date(grant.ends_at)}`:''}`;select.append(option);
  }
  $('code-form').hidden=!session||!awaiting.length;
  if(session&&!awaiting.length)message('code-message',account?.access.active?'Seu acesso já está ativo. Não é necessário reutilizar o código.':'Nenhuma compra aguardando ativação. Consulte o pagamento no Plano Premium.');
  else if(awaiting.length)message('code-message','Sua compra foi confirmada. Digite o código do e-mail para ativar.');
  const list=$('order-list');list.replaceChildren();
  for(const order of account?.orders??[]){
    const card=document.createElement('section');card.className='order-card';
    appendText(card,'h3',`${planName(order.plan)} · ${money(order.amount_cents)}`);
    let state=financialLabels[order.financial_status]??'Estado em atualização';
    if(order.financial_status==='pending'&&['unknown','creating'].includes(order.checkout_status))state='Resultado do checkout ainda desconhecido. Não repita o pagamento. Consulte novamente ou contate o suporte.';
    if(order.checkout_status==='failed'&&order.financial_status==='pending')state='Checkout indisponível. Você pode tentar novamente.';
    appendText(card,'p',state);
    if(order.needs_review)appendText(card,'p','Esta compra precisa de análise do suporte. Guarde o identificador abaixo.');
    appendText(card,'small',`Pedido ${order.id}`);
    if(order.checkout_url){const link=appendText(card,'a','Abrir / retomar checkout →','checkout-link');link.href=order.checkout_url;link.rel='noreferrer';}
    const grant=awaiting.find(g=>g.order_id===order.id);
    if(order.financial_status==='approved'&&grant){
      if(grant.email_state==='dead')appendText(card,'p','Não foi possível entregar o e-mail. Abra Code e solicite um reenvio.');
      else if(grant.email_state==='done'&&grant.email_provider_id)appendText(card,'p','Código aceito pelo serviço de e-mail. Confira sua caixa de entrada e spam.');
      else if(['pending','running'].includes(grant.email_state))appendText(card,'p','Código enfileirado. Aguarde a entrega do e-mail.');
      else appendText(card,'p','Abra Code para solicitar um novo código se o anterior expirou.');
      const button=appendText(card,'button','Informar código','small-button');button.type='button';
      button.addEventListener('click',()=>{premium.close();codeModal.showModal();});
    }
    list.append(card);
  }
}
async function loadAccount(){
  if(!session){renderIdentity();return;}
  account=await api('/api/account');renderAccount();
}
async function initialize(){
  try{
    const [s,c]=await Promise.all([api('/api/session'),api('/api/catalog')]);
    session=s.user;csrf=s.csrf;product=c.product;
    if(!product)throw new Error('O plano está indisponível. Tente novamente mais tarde.');
    productId=product.id;
    if(s.intent?.productId===productId&&['annual','lifetime'].includes(s.intent.plan))selectedPlan=s.intent.plan;
    renderPlans();renderIdentity();$('premium-content').hidden=false;message('premium-message','');
    await loadAccount();
    const params=new URLSearchParams(location.search);
    if(params.get('premium')==='1'){
      premium.showModal();
      if(params.get('auth')==='retry')message('premium-message','O link expirou ou foi aberto em outro navegador. Solicite um novo link neste dispositivo.');
      history.replaceState({},'',location.pathname);
    }
  }catch(e){message('premium-message','Checkout indisponível. A integração precisa estar configurada no servidor.');message('code-message','Não foi possível conectar ao serviço. Tente novamente mais tarde.');}
}
$('login-form').addEventListener('submit',async e=>{
  e.preventDefault();const button=e.submitter;button.disabled=true;
  try{
    const data=await api('/api/auth/start',{email:$('purchase-email').value,productId,plan:selectedPlan});
    message('premium-message',data.message);
  }catch(e){message('premium-message',e.message);}finally{button.disabled=false;}
});
$('start-checkout').addEventListener('click',async()=>{
  if(busy)return;busy=true;renderPurchaseButton();
  try{
    const storageKey=`checkout:${productId}:${selectedPlan}`;
    let saved;try{saved=JSON.parse(localStorage.getItem(storageKey));}catch{}
    if(!saved||account?.orders.some(o=>o.id===saved.orderId&&(o.financial_status!=='pending'||o.checkout_status==='failed')))saved={key:crypto.randomUUID()};
    localStorage.setItem(storageKey,JSON.stringify(saved));
    const result=await api('/api/checkout',{productId,plan:selectedPlan},saved.key);
    saved.orderId=result.orderId;localStorage.setItem(storageKey,JSON.stringify(saved));
    await loadAccount();
    message('premium-message',result.state==='failed'?'Não foi possível abrir o checkout. Você pode tentar novamente.':result.state==='unknown'?'O resultado ainda é desconhecido. A compra será reconciliada; não repita o pagamento.':result.checkoutUrl?'Checkout preparado. Use “Abrir / retomar checkout” abaixo para pagar.':'Consulte o estado da sua compra abaixo.');
  }catch(e){message('premium-message',e.name==='TimeoutError'?'A operação demorou. Consulte a compra; não repita o pagamento em outra janela.':e.message);}
  finally{busy=false;renderPurchaseButton();}
});
$('refresh-payment').addEventListener('click',async e=>{
  const button=e.currentTarget;button.disabled=true;
  try{await api('/api/account/refresh',{});await loadAccount();message('premium-message','Consulta solicitada. O estado será atualizado após a confirmação do provedor.');}
  catch(e){message('premium-message',e.message);}finally{setTimeout(()=>{button.disabled=false;},20_000);}
});
$('code-login').addEventListener('click',()=>{codeModal.close();premium.showModal();});
$('logout').addEventListener('click',async()=>{
  try{await api('/api/auth/logout',{});session=null;account=null;renderIdentity();$('open-premium').textContent='✦ Plano Premium';message('premium-message','Você saiu. Entre pelo e-mail para recuperar seu acesso.');}
  catch(e){message('premium-message',e.message);}
});
$('code-form').addEventListener('submit',async e=>{
  e.preventDefault();e.submitter.disabled=true;
  try{await api('/api/activation/redeem',{grantId:$('activation-grant').value,code:$('access-code').value.trim()});await loadAccount();message('code-message','Premium ativado! Seu acesso será recuperado nos próximos logins.');$('access-code').value='';}
  catch(e){message('code-message',e.message);}finally{e.submitter.disabled=false;}
});
$('resend-code').addEventListener('click',async e=>{
  const button=e.currentTarget;button.disabled=true;
  try{await api('/api/activation/resend',{grantId:$('activation-grant').value});message('code-message','Novo código enfileirado. Aguarde o e-mail; o código anterior foi invalidado.');}
  catch(e){message('code-message',e.message);}finally{setTimeout(()=>{button.disabled=false;},60_000);}
});
setInterval(()=>{if(session&&(premium.open||codeModal.open))loadAccount().catch(e=>message(premium.open?'premium-message':'code-message',e.message));},15_000);
initialize();
