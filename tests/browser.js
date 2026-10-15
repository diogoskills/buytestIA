import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { startFixture } from './browser-fixture.js';
const fixture=await startFixture();
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}),args:['--no-sandbox']});
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const origin='https://shop.example';
 // Route the reserved test origin to our local fixture, without external traffic or TLS overrides.
 await page.route(origin+'/**',async route=>{
  const request=route.request(),url=new URL(request.url());
  const response=await fetch(fixture.origin+url.pathname+url.search,{method:request.method(),headers:await request.allHeaders(),body:request.postDataBuffer()??undefined,redirect:'manual'});
  await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
 });
 await page.goto(origin);await page.locator('#open-premium').click();
 await page.getByText('R$ 40,00',{exact:true}).waitFor();await page.getByText('R$ 120,00',{exact:true}).waitFor();
 await page.locator('#purchase-email').fill(fixture.owner.email);await page.locator('#login-form button').click();
 await page.getByText('Se o envio estiver disponível, confira seu e-mail.',{exact:true}).waitFor();
 await page.keyboard.press('Escape');
 await context.addCookies([{name:'fixture_session',value:'owner',url:origin}]);
 await page.goto(origin+'/?premium=1');await page.locator('#start-checkout').waitFor();
 await page.locator('#start-checkout').click();
 await page.getByText('Abrir / retomar checkout →',{exact:true}).waitFor();
 await page.goto(origin+'/?premium=1');await page.getByText('Abrir / retomar checkout →',{exact:true}).waitFor();
 const code=await fixture.approve();assert.ok(code);
 await page.goto(origin+'/?premium=1');await page.getByText('Pagamento aprovado',{exact:true}).waitFor();
 await page.keyboard.press('Escape');await page.locator('#open-code').click();
 await page.locator('#access-code').fill(code);await page.locator('#code-form button[type=submit]').click();
 await page.getByText('Premium ativado! Seu acesso será recuperado nos próximos logins.',{exact:true}).waitFor();
 assert.equal(await page.locator('#code-email').inputValue(),fixture.owner.email);
 await page.keyboard.press('Escape');await page.reload();await page.locator('#open-premium').click();
 await page.getByText('Seu Premium está ativo ✦',{exact:true}).waitFor();
 await page.keyboard.press('Escape');
 for(const width of [320,390,1440]){
  await page.setViewportSize({width,height:850});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#open-code').click();await page.getByText('Seu acesso já está ativo. Não é necessário reutilizar o código.',{exact:true}).waitFor();
  await page.mouse.click(1,1);assert.equal(await page.locator('#code-modal').evaluate(d=>d.open),false);
 }
 assert.deepEqual(errors,[]);
 await page.screenshot({path:'/tmp/forma-premium-browser.png',fullPage:true});
 console.log('PASS browser: prices, login request, pending checkout, provider approval + e-mail, code activation, restored access, mobile 320/390px, modal close, no JS errors. Providers simulated.');
}finally{await browser.close();await fixture.close();}
