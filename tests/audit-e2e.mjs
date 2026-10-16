import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './server.mjs';
const temp=mkdtempSync(join(tmpdir(),'harbor-audit-')), path=join(temp,'audit.sqlite');
let app=await startServer(path);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
const context=await browser.newContext({viewport:{width:1440,height:1000}}), page=await context.newPage();
page.setDefaultTimeout(15000);
const errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));
const pass=s=>{checks.push(s);console.log('PASS',s);};
const data=async()=> (await page.request.get(app.base+'/api/bootstrap')).json();
const disk=()=>{const db=new DatabaseSync(path,{readOnly:true});try{return JSON.parse(db.prepare('SELECT data FROM app_state WHERE id=1').get().data);}finally{db.close();}};
const post=async(action,payload)=>{const r=await page.request.post(app.base+'/api/action',{data:{action,payload}});assert.equal(r.status(),200,await r.text());return (await r.json()).result;};
const nav=async id=>{await page.locator(`a.nav-item[href="#${id}"]`).click();await page.locator('.page-heading').waitFor();};
const dialog=()=>page.getByRole('dialog').last();
const save=async(label='Save configuration')=>{const count=await page.locator('dialog').count();const button=dialog().getByRole('button',{name:label,exact:true});if(label==='Create RMA')await button.waitFor({state:'visible'});if(label==='Create RMA')await page.waitForFunction(()=>!document.querySelector('dialog button[type=submit]').disabled);if(label==='Create RMA')await button.evaluate(b=>{b.click();b.click();});else await button.click();await page.waitForFunction(n=>document.querySelectorAll('dialog').length===n,count-1);};
const close=()=>dialog().getByRole('button',{name:'Close dialog',exact:true}).click();
mkdirSync('test-results',{recursive:true});
try {
 await page.goto(app.base);await page.locator('[data-demo=admin]').click();await page.getByRole('heading',{name:'Your operation, at a glance.'}).waitFor();
 let s=await data();
 for(const sol of s.supportConfig.solutions)for(const n of sol.nodes)assert.ok(Array.isArray(n.dependsOn));
 for(const sol of disk().supportConfig.solutions)for(const n of sol.nodes)assert.ok(Array.isArray(n.dependsOn));
 const device=await post('product.create',{sku:'AUDIT-DEVICE',name:'Audit printer',category:'Support',costCents:5000,priceCents:10000,reorderPoint:2,leadDays:7,unit:'pcs',productType:'device'});
 const part=await post('product.create',{sku:'AUDIT-PART',name:'Audit head',category:'Support',costCents:500,priceCents:1000,reorderPoint:2,leadDays:7,unit:'pcs',productType:'part',partKind:'printhead',deviceIds:[device.id]});
 await page.reload();
 // Explicitly emulate an old bootstrap response to exercise client-side compatibility.
 await page.route('**/api/bootstrap',async route=>{const r=await route.fetch(),b=await r.json();for(const sol of b.supportConfig.solutions)for(const n of sol.nodes)if(!n.dependsOn.length)n.dependsOn=null;await route.fulfill({response:r,json:b});});
 await page.reload();await nav('rma');await page.getByRole('button',{name:'Create RMA',exact:true}).click();
 for(const sol of s.supportConfig.solutions){await dialog().getByLabel('Proposed solution').selectOption(sol.id);assert.equal(await dialog().locator('.workflow-node').count(),sol.nodes.length);}
 await close();await page.unroute('**/api/bootstrap');await page.reload();
 pass('all shipped solutions render even with legacy null dependencies; SQLite stores arrays');
 const createForm=async(sol,index)=>{await nav('rma');await page.getByRole('button',{name:'Create RMA',exact:true}).click();const d=dialog();await d.getByLabel('Support ticket number').fill('AUDIT-TICKET-'+index);await d.getByLabel('Order number',{exact:true}).fill('AUDIT-ORDER-'+index);await d.getByLabel('Purchased platform').selectOption('Amazon');await d.getByLabel('Affected device / part SKU').selectOption(device.id);await d.getByLabel('Root cause',{exact:true}).selectOption(s.supportConfig.rootCauses[0].id);await d.getByLabel('Description',{exact:true}).fill('Regression test for shipped solution '+sol.id);await d.getByLabel('Proposed solution').selectOption(sol.id);if(await d.getByLabel('Delivery date',{exact:true}).count())await d.getByLabel('Delivery date',{exact:true}).fill(new Date(Date.now()-30*86400000).toISOString().slice(0,10));for(const input of await d.getByLabel('Value ($)',{exact:true}).all())await input.fill('100.01');for(const select of await d.getByLabel('Task SKU',{exact:true}).all()){if(!(await select.inputValue()))await select.selectOption(part.id);} };
 for(const [i,sol] of s.supportConfig.solutions.entries()){
  await createForm(sol,i);
  if(i===0){
   // Commit succeeds but the following reload fails. Retrying must reuse the receipt.
   let fail=true;await page.route('**/api/bootstrap',async route=>{if(fail){fail=false;await route.fulfill({status:500,json:{error:'Simulated reload failure'}});}else await route.continue();});
   await dialog().getByRole('button',{name:'Create RMA',exact:true}).click();await dialog().getByText('Simulated reload failure',{exact:true}).waitFor();
   assert.equal(disk().rmas.length,1);await save('Create RMA');await page.unroute('**/api/bootstrap');assert.equal(disk().rmas.length,1);
  }else await save('Create RMA');
 }
 s=await data();assert.equal(s.rmas.length,4);assert.equal(s.rmaTasks.length,7);assert.deepEqual(disk().rmas,s.rmas);
 pass('all four starter RMAs submit; rapid double-clicks and retry after a committed request create exactly one RMA');
 await nav('rmatasks');
 const openTask=async id=>page.locator(`tr[data-row-id="${id}"]`).getByRole('button',{name:'Open task',exact:true}).click();
 for(const t of s.rmaTasks.filter(t=>t.approval==='pending')){await openTask(t.id);await dialog().getByRole('tab',{name:'Review approval',exact:true}).click();await dialog().getByLabel('Review reason').fill('Audit approval');await save('Save review');}
 let guard=0;
 while((s=await data()).rmaTasks.some(t=>t.status!=='completed')){
  assert.ok(++guard<20,'DAG must make progress');const t=s.rmaTasks.find(t=>t.status==='ready'||t.status==='in_progress');assert.ok(t,'A task must be executable');
  const execution=async(op)=>{await openTask(t.id);await dialog().getByRole('tab',{name:'Record execution',exact:true}).click();await dialog().getByLabel('Execution action').selectOption(op);for(const [label,value] of [['Carrier','Audit carrier'],['Tracking number','TRACK-'+t.id],['Gift card code / delivery reference','GIFT-'+t.id],['Promo code sent','PROMO-'+t.id],['Transaction / fulfillment reference','TX-'+t.id]]){const field=dialog().getByLabel(label,{exact:true});if(await field.count())await field.fill(value);}await save('Record execution');};
  if(t.direction!=='none'&&t.status==='ready')await execution('dispatch');
  await execution('complete');
 }
 assert.ok(s.rmas.every(r=>r.status==='completed'));assert.equal(disk().benefitHistory.length,2);
 await nav('rmalogistics');await page.getByText('No records yet.',{exact:true}).waitFor();
 pass('starter returns, replacements, refunds, parts, gift cards and promo tasks complete independently; queue and database agree');
 // Field types and every supported form scope are configurable through the UI.
 await nav('rmaconfig');await page.getByRole('tab',{name:'Custom fields',exact:true}).click();
 for(const [scope,type] of [['rma','textarea'],['task','number'],['execution','date'],['order','select'],['serial','text'],['product','text']]){
  await page.getByRole('button',{name:'Add field',exact:true}).click();await dialog().getByLabel('Name',{exact:true}).fill('Audit '+scope+' field');await dialog().getByLabel('Stable key (optional for new records)').fill('audit_'+scope+'_field');await dialog().getByLabel('Form scope').selectOption(scope);await dialog().getByLabel('Field type',{exact:true}).selectOption(type);if(type==='select')await dialog().getByLabel('Options (one per line)').fill('Standard\nPriority');await save();
 }
 await nav('supportorders');await page.getByRole('button',{name:'Add support order',exact:true}).click();await dialog().getByLabel('Order number',{exact:true}).fill('AUDIT-MANUAL');await dialog().getByLabel('Customer',{exact:true}).fill('Audit customer');await dialog().getByLabel('Platform',{exact:true}).selectOption('Amazon');await dialog().getByLabel('SKU',{exact:true}).selectOption(device.id);await dialog().getByLabel('Audit order field',{exact:true}).selectOption('Priority');await save('Save record');
 let order=disk().supportOrders.find(o=>o.orderNumber==='AUDIT-MANUAL');assert.equal(order.customFields.audit_order_field,'Priority');await page.locator(`tr[data-row-id="${order.id}"]`).getByRole('button',{name:/Edit/}).click();await dialog().getByLabel('Status',{exact:true}).selectOption('delivered');await save('Save record');assert.equal(disk().supportOrders.find(o=>o.id===order.id).status,'delivered');
 await nav('serials');await page.getByRole('button',{name:'Register serial',exact:true}).click();await dialog().getByLabel('Serial number',{exact:true}).fill('AUDIT-SN');await dialog().getByLabel('SKU',{exact:true}).selectOption(device.id);await dialog().getByLabel('Audit serial field',{exact:true}).fill('Quality checked');await save('Save record');let serial=disk().serials.find(x=>x.sn==='AUDIT-SN');assert.equal(serial.customFields.audit_serial_field,'Quality checked');await page.locator(`tr[data-row-id="${serial.id}"]`).getByRole('button',{name:/Edit/}).click();await dialog().getByLabel('Status',{exact:true}).selectOption('sold');await save('Save record');assert.equal(disk().serials.find(x=>x.id===serial.id).status,'sold');
 pass('all five custom field types and six scopes save; order and serial custom values and status edits persist');
 await nav('rmaconfig');
 for(const [tab,add,entity] of [['Platforms','platform','platforms'],['Root causes','root cause','rootCauses'],['Approval rules','rule','rules'],['Task types','task type','taskTypes'],['Custom fields','field','fields']]){
  await page.getByRole('tab',{name:tab,exact:true}).click();await page.getByRole('button',{name:'Add '+add,exact:true}).click();await dialog().getByLabel('Name',{exact:true}).fill('Audit '+entity);await dialog().getByLabel('Stable key (optional for new records)').fill('audit_'+entity);await save();
  const row=()=>page.locator('tbody tr').filter({hasText:'Audit '+entity});await row().getByRole('button',{name:'Edit configuration'}).click();await dialog().getByLabel('Name',{exact:true}).fill('Audit '+entity+' revised');await dialog().getByLabel('Enabled',{exact:true}).uncheck();await save();assert.equal(disk().supportConfig[entity].find(x=>x.id==='audit_'+entity).enabled,false);
 }
 pass('configuration create, edit, disable and persistence across platform, root cause, approval, task type and field settings');
 // Configuration concurrency must not silently overwrite a newer administrator save.
 await page.getByRole('tab',{name:'Platforms',exact:true}).click();await page.locator('tbody tr').filter({hasText:'audit_platforms'}).getByRole('button',{name:'Edit configuration'}).click();
 let current=(await data()).supportConfig.platforms.find(x=>x.id==='audit_platforms');await post('rmaconfig.save',{entity:'platforms',record:{...current,name:'Newer administrator value'}});await dialog().getByLabel('Name',{exact:true}).fill('Stale edit');await dialog().getByRole('button',{name:'Save configuration',exact:true}).click();await dialog().getByText(/Support configuration changed/).waitFor();assert.equal(disk().supportConfig.platforms.find(x=>x.id==='audit_platforms').name,'Newer administrator value');await close();
 pass('stale configuration edits are rejected without overwriting current database values');
 await page.reload();const links=await page.locator('a.nav-item').evaluateAll(xs=>xs.map(x=>x.getAttribute('href').slice(1)));
 assert.equal(links.length,13);
 for(const id of links){await nav(id);assert.equal(await page.getByText('Workspace could not be displayed',{exact:true}).count(),0);}
 for(const bad of ['constructor','__proto__']){await page.goto(app.base+'/#'+bad);await page.getByText('Access restricted',{exact:true}).waitFor();}
 for(const collection of ['rmas','rmaTasks','supportOrders','serials','benefitHistory']){const r=await page.request.get(app.base+'/api/export/'+collection);assert.equal(r.status(),200);assert.ok((await r.body()).length>0);}
 const before=disk();await app.close();app=await startServer(path);await page.goto(app.base);await page.locator('.page-heading').waitFor();const after=await data();assert.deepEqual(after.rmas,before.rmas);assert.deepEqual(after.rmaTasks,before.rmaTasks);assert.deepEqual(after.benefitHistory,before.benefitHistory);assert.deepEqual(errors,[]);
 pass('all 13 active pages, unsupported routes, support CSV exports and authenticated server restart pass without JavaScript errors');
 await page.screenshot({path:'test-results/audit-final.png',fullPage:true});
 writeFileSync('test-results/audit-report.json',JSON.stringify({passed:true,checks,errors},null,2));console.log(checks.length+' audit checkpoints passed.');
}catch(e){await page.screenshot({path:'test-results/audit-failure.png',fullPage:true});writeFileSync('test-results/audit-report.json',JSON.stringify({passed:false,checks,errors,error:e.stack},null,2));console.error(e);process.exitCode=1;}finally{await browser.close();await app.close();rmSync(temp,{recursive:true,force:true});}
