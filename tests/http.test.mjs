import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const listen=app=>new Promise(resolve=>app.server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${app.server.address().port}`)));
const close=app=>new Promise(resolve=>app.server.close(resolve));
test('HTTP authentication, permissions, idempotency, persistence, and export boundaries',async t=>{
  const temp=mkdtempSync(join(tmpdir(),'harbor-http-'));const databasePath=join(temp,'test.sqlite');let app=createApp({databasePath});let base=await listen(app);let cookie='';
  const request=async(path,body,headers={})=>fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Cookie:cookie,...headers},body:body?JSON.stringify(body):undefined});
  const login=async(role)=>{const res=await request('/api/login',{email:`${role}@harbor.local`,password:'HarborDemo!2026'});assert.equal(res.status,200);cookie=res.headers.get('set-cookie').split(';')[0];return res;};
  try{
    await t.test('protected routes require a login and invalid credentials fail',async()=>{assert.equal((await request('/api/bootstrap')).status,401);assert.equal((await request('/api/login',{email:'admin@harbor.local',password:'wrong'})).status,401);const res=await login('admin');assert.match(res.headers.get('set-cookie'),/HttpOnly/);assert.match(res.headers.get('set-cookie'),/SameSite=Strict/);});
    await t.test('password hashes never reach bootstrap or exports',async()=>{const b=await(await request('/api/bootstrap')).text();assert.ok(!b.includes('passwordHash'));assert.equal((await request('/api/export/users')).status,404);const backup=await(await request('/api/backup')).json();assert.ok(!backup.state.users);});
    let productId;
    const body={action:'product.create',payload:{sku:'HTTP-TEST',name:'Persistence test',spu:'HTTP',category:'Tests',unit:'pcs',costCents:500,priceCents:1200,reorderPoint:10,leadDays:5,supplierId:'SUP-1'}};
    await t.test('idempotency replay applies one mutation and rejects conflicting payloads',async()=>{
      const a=await request('/api/action',body,{'Idempotency-Key':'http-repeat-1'});assert.equal(a.status,200);const saved=await a.json();productId=saved.result.id;
      const second=await request('/api/action',body,{'Idempotency-Key':'http-repeat-1'});const replay=await second.json();assert.equal(replay.result.id,productId);assert.equal(replay.replayed,true);
      const conflict=await request('/api/action',{...body,payload:{...body.payload,name:'Changed'}},{'Idempotency-Key':'http-repeat-1'});assert.equal(conflict.status,409);
      assert.equal(app.getState().products.filter(x=>x.sku==='HTTP-TEST').length,1);
    });
    await t.test('data and session persist across server restart',async()=>{await close(app);app=createApp({databasePath});base=await listen(app);const r=await request('/api/bootstrap');assert.equal(r.status,200);assert.equal((await r.json()).products.find(x=>x.id===productId).sku,'HTTP-TEST');});
    await t.test('cross-origin mutation is rejected',async()=>{assert.equal((await request('/api/action',body,{Origin:'https://example.com'})).status,403);});
    await t.test('invalid input produces no stock or revision changes',async()=>{const before=app.getState();const r=await request('/api/action',{action:'inventory.adjust',payload:{productId:'PRD-1',warehouseId:'WH-1',delta:-999999,reason:'test'}});assert.equal(r.status,409);assert.deepEqual(app.getState(),before);});
    await t.test('analyst cannot bypass hidden UI actions',async()=>{await login('analyst');const r=await request('/api/action',body);assert.equal(r.status,403);const b=await(await request('/api/bootstrap')).json();assert.deepEqual(b.permissions,[]);});
    await t.test('operator cannot write finance but can create operational records',async()=>{await login('operator');const r=await request('/api/action',{action:'expense.create',payload:{category:'Software',description:'test',amountCents:100}});assert.equal(r.status,403);});
    await t.test('CSV exports neutralize spreadsheet formulas',async()=>{await login('admin');const r=await request('/api/action',{action:'supplier.create',payload:{name:'=SUM(1,2)',terms:'Net 30'}});assert.equal(r.status,200);const csv=await(await request('/api/export/suppliers')).text();assert.match(csv,/'=SUM/);});
    await t.test('disabled users lose access even with an existing session',async()=>{await login('analyst');const analystCookie=cookie;await login('admin');const r=await request('/api/action',{action:'user.update',payload:{id:'USR-ANALYST',role:'analyst',active:false}});assert.equal(r.status,200);cookie=analystCookie;assert.equal((await request('/api/bootstrap')).status,401);});
    await t.test('report rejects reversed ranges and unknown channels',async()=>{await login('admin');assert.equal((await request('/api/report?from=2026-10-20&to=2026-10-10')).status,400);assert.equal((await request('/api/report?channel=bad')).status,400);});
    await t.test('logout invalidates the server-side session',async()=>{assert.equal((await request('/api/logout',{})).status,200);assert.equal((await request('/api/bootstrap')).status,401);});
  }finally{await close(app);rmSync(temp,{recursive:true,force:true});}
});
