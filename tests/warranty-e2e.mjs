import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from './server.mjs';
const temp=mkdtempSync(join(tmpdir(),'harbor-warranty-')),app=await startServer(join(temp,'test-workspace'));
const browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', {value: undefined, configurable: true}));
const data=async()=>(await page.request.get(app.base+'/api/bootstrap')).json();
const post=async(action,payload,status=200)=>{const r=await page.request.post(app.base+'/api/action',{data:{action,payload}});assert.equal(r.status(),status,await r.text());return (await r.json()).result;};
try {
 await page.goto(app.base);await page.locator('[data-demo=admin]').click();await page.locator('.topbar').waitFor();
 const device=await post('product.create',{sku:'WARRANTY-DEVICE',name:'Warranty printer',category:'Support',costCents:1000,priceCents:2000,reorderPoint:1,leadDays:1,productType:'device',partKind:'other',warrantyClass:'none'});
 const b={ticketNumber:'W-TICKET',orderNumber:'W-ORDER',platform:'Shopify',productId:device.id,rootCauseId:'device_fault',solutionId:'replacement',description:'Warranty check',warrantyEvidence:{deliveredAt:'2000-01-01'}};
 await post('rma.create',b,422);assert.equal((await data()).rmas.length,0);assert.equal((await data()).rmaTasks.length,0);
 await page.reload();await page.locator('a[href="#rma"]').click();await page.getByRole('button',{name:'Create RMA',exact:true}).click();
 const d=page.getByRole('dialog');
 await d.getByLabel('Support ticket number').fill(b.ticketNumber);await d.getByLabel('Order number',{exact:true}).fill(b.orderNumber);await d.getByLabel('Purchased platform').selectOption('Shopify');await d.getByLabel('Affected device / part SKU').selectOption(device.id);await d.getByLabel('Root cause',{exact:true}).selectOption('device_fault');await d.getByLabel('Description',{exact:true}).fill(b.description);await d.getByLabel('Proposed solution').selectOption('replacement');
 await page.route('**/api/rma-assessment', route => route.fulfill({json:{eligible:false,status:'incomplete',requiresWarranty:true,coverage:'none',reason:'Configure the affected SKU warranty class before using a warranty-required solution.',policyRevision:1}}));
 await d.getByLabel('Delivery date',{exact:true}).fill('2001-01-01');
 await d.getByText('Warranty rule not determined',{exact:false}).waitFor();
 assert.equal(await d.getByText('No warranty required',{exact:false}).count(),0);
 assert.equal(await d.getByRole('button',{name:'Create RMA',exact:true}).isDisabled(),true);
 await page.unroute('**/api/rma-assessment');
 await d.getByLabel('Delivery date',{exact:true}).fill('2000-01-01');await d.getByText('Warranty has expired. Choose a solution that does not require warranty coverage.',{exact:true}).waitFor();assert.equal(await d.getByRole('button',{name:'Create RMA',exact:true}).isDisabled(),true);
 const recent=new Date(Date.now()-30*86400000).toISOString().slice(0,10);await d.getByLabel('Delivery date',{exact:true}).fill(recent);await d.getByText('Warranty is active. This solution is eligible.',{exact:true}).waitFor();const keys=[];
 await page.route('**/api/action', async route => {
  if(route.request().postDataJSON()?.action !== 'rma.create') return route.continue();
  keys.push(route.request().headers()['idempotency-key']);
  if(keys.length === 1) { const response=await route.fetch(); assert.equal(response.status(),200); await route.abort('failed'); }
  else await route.continue();
 });
 await d.getByRole('button',{name:'Create RMA',exact:true}).click();
 await d.locator('.form-error').waitFor();
 assert.equal((await data()).rmas.length,1,'Lost response must leave exactly one committed RMA');
 await d.getByRole('button',{name:'Create RMA',exact:true}).click();await d.waitFor({state:'detached'});
 assert.equal(keys.length,2);assert(keys[0]);assert.equal(keys[0],keys[1],'Retry must reuse the same idempotency key');
 assert.equal((await data()).rmas.length,1,'Retry must not duplicate RMA');
 await page.unroute('**/api/action');
 const original=(await data()).rmas[0].eligibilityAssessment;assert.equal(original.status,'covered');assert.equal(original.ruleSnapshot.months,12);
 await page.locator('a[href="#settings"]').click();await page.getByRole('tab',{name:'Warranty rules',exact:true}).click();await page.getByLabel('Warranty months',{exact:true}).first().fill('24');await page.getByRole('button',{name:'Save warranty rules',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#toasts')?.textContent.includes('Warranty rules saved.'));
 let s=await data();assert.equal(s.supportConfig.warrantyPolicy.revision,2);assert.equal(s.rmas[0].eligibilityAssessment.ruleSnapshot.months,12);
 await post('warranty.save',{policy:s.supportConfig.warrantyPolicy,expectedRevision:1},409);
 await post('rma.create',{...b,solutionId:'goodwill',taskInputs:{gift:{amountCents:100}}});assert.equal((await data()).rmas.length,2);
 await page.reload();await page.getByRole('tab',{name:'Warranty rules',exact:true}).click();assert.equal(await page.getByLabel('Warranty months',{exact:true}).first().inputValue(),'24');
 assert.deepEqual(errors,[]);console.log('PASS warranty API gate, atomic rejection, live assessment, settings persistence, history snapshot, stale policy rejection and warranty exemption');
} finally {await browser.close();await app.close();rmSync(temp,{recursive:true,force:true});}
