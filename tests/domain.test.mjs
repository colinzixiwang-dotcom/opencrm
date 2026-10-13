import test from 'node:test';
import assert from 'node:assert/strict';
import { seedState, mutate, report, stock, DomainError, publicState, verifyPassword } from '../lib/domain.mjs';

const seeded=seedState();
function fixture(){const s=structuredClone(seeded);for(const name of ['purchases','sales','shipments','movements','payments','expenses','campaigns','tickets','tasks','audit'])s[name]=[];s.stocks=s.stocks.map(x=>({...x,onHand:100,locked:0,averageCostCents:1000,valueCents:100000}));return s;}
function flow(s=fixture(),user=s.users[0]){return {get state(){return s;},run(a,b){const r=mutate(s,a,b,user);s=r.state;return r.result;}};}
const poInput={supplierId:'SUP-1',warehouseId:'WH-1',lines:[{productId:'PRD-1',qty:10,unitCents:2000},{productId:'PRD-2',qty:5,unitCents:500}]};
const saleInput={customer:'Test buyer',channel:'Direct',warehouseId:'WH-1',lines:[{productId:'PRD-1',qty:4,unitCents:3000}]};
function ordered(f){const p=f.run('purchase.create',poInput);for(const status of ['pending','approved','ordered'])f.run('purchase.transition',{id:p.id,status});return p;}
function shipped(f){const o=f.run('sale.create',saleInput);for(const status of ['confirmed','shipped'])f.run('sale.transition',{id:o.id,status});return o;}

test('seed creates a consistent working example through the actual domain rules',()=>{
  assert.equal(seeded.products.length,6);assert.equal(seeded.sales.length,18);assert.equal(seeded.stocks.length,18);
  assert.ok(report(seeded).revenueCents>0);assert.ok(verifyPassword('HarborDemo!2026',seeded.users[0].passwordHash));
  assert.equal(JSON.stringify(publicState(seeded,seeded.users[0])).includes('passwordHash'),false);
});
test('purchase approval, partial receipt, completion, and moving-average costs',()=>{
  const f=flow();const p=ordered(f);f.run('purchase.receive',{id:p.id,lines:[{productId:'PRD-1',qty:5}]});
  assert.equal(f.state.purchases[0].status,'partial');assert.equal(stock(f.state,'PRD-1','WH-1').onHand,105);assert.equal(stock(f.state,'PRD-1','WH-1').averageCostCents,1048);
  f.run('purchase.receive',{id:p.id,lines:[{productId:'PRD-1',qty:5},{productId:'PRD-2',qty:5}]});assert.equal(f.state.purchases[0].status,'received');
  assert.equal(f.state.movements.length,3);assert.throws(()=>f.run('purchase.receive',{id:p.id,lines:[{productId:'PRD-1',qty:1}]}),/Only ordered/);
});
test('a failed multi-line receipt is atomic',()=>{
  const f=flow();const p=ordered(f);const before=structuredClone(f.state);
  assert.throws(()=>f.run('purchase.receive',{id:p.id,lines:[{productId:'PRD-1',qty:3},{productId:'PRD-2',qty:6}]}),/remaining/);assert.deepEqual(f.state,before);
});
test('purchase receipt requires ordering and rejects duplicate or fractional quantities',()=>{
  const f=flow();const p=f.run('purchase.create',poInput);
  assert.throws(()=>f.run('purchase.receive',{id:p.id,lines:[{productId:'PRD-1',qty:2}]}),/Only ordered/);
  for(const status of ['pending','approved','ordered'])f.run('purchase.transition',{id:p.id,status});
  assert.throws(()=>f.run('purchase.receive',{id:p.id,lines:[{productId:'PRD-1',qty:2},{productId:'PRD-1',qty:2}]}),/Duplicate/);
  assert.throws(()=>f.run('purchase.receive',{id:p.id,lines:[{productId:'PRD-1',qty:1.5}]}),/whole number/);
});
test('paid and partially received purchases cannot be cancelled',()=>{
  const f=flow();const p=ordered(f);f.run('purchase.pay',{id:p.id,amountCents:100});assert.throws(()=>f.run('purchase.transition',{id:p.id,status:'cancelled'}),/Paid or received/);
  assert.throws(()=>f.run('purchase.pay',{id:p.id,amountCents:docTotal(p)+1}),/outstanding/);
});
const docTotal=p=>p.lines.reduce((a,l)=>a+l.qty*l.unitCents,0);
test('confirming a sale reserves stock; shipping recognizes exact revenue and cost',()=>{
  const f=flow();const o=f.run('sale.create',saleInput);assert.equal(report(f.state).revenueCents,0);
  f.run('sale.transition',{id:o.id,status:'confirmed'});let st=stock(f.state,'PRD-1','WH-1');assert.equal(st.onHand,100);assert.equal(st.locked,4);
  f.run('sale.transition',{id:o.id,status:'shipped'});st=stock(f.state,'PRD-1','WH-1');assert.equal(st.onHand,96);assert.equal(st.locked,0);
  const r=report(f.state);assert.equal(r.revenueCents,12000);assert.equal(r.cogsCents,4000);assert.equal(r.grossProfitCents,8000);
});
test('insufficient-stock confirmation rolls back all line reservations',()=>{
  const f=flow();const o=f.run('sale.create',{...saleInput,lines:[{productId:'PRD-1',qty:4,unitCents:10},{productId:'PRD-2',qty:101,unitCents:10}]});const before=structuredClone(f.state);
  assert.throws(()=>f.run('sale.transition',{id:o.id,status:'confirmed'}),/Insufficient/);assert.deepEqual(f.state,before);
});
test('cancelling a confirmed order releases reserves but never changes on-hand stock',()=>{
  const f=flow();const o=f.run('sale.create',saleInput);f.run('sale.transition',{id:o.id,status:'confirmed'});f.run('sale.transition',{id:o.id,status:'cancelled'});
  assert.equal(stock(f.state,'PRD-1','WH-1').onHand,100);assert.equal(stock(f.state,'PRD-1','WH-1').locked,0);
});
test('returns restock at original cost, reverse revenue/COGS, and refund collected overpayment',()=>{
  const f=flow();const o=shipped(f);f.run('sale.pay',{id:o.id,amountCents:12000});f.run('sale.return',{id:o.id,lines:[{productId:'PRD-1',qty:2}]});
  const r=report(f.state);assert.equal(r.revenueCents,6000);assert.equal(r.cogsCents,2000);assert.equal(stock(f.state,'PRD-1','WH-1').onHand,98);
  const order=f.state.sales[0];assert.equal(order.refundCents,6000);assert.equal(order.paidCents,6000);assert.equal(f.state.payments[0].kind,'outflow');assert.equal(f.state.payments[0].amountCents,6000);
  assert.throws(()=>f.run('sale.return',{id:o.id,lines:[{productId:'PRD-1',qty:3}]}),/remaining/);
});
test('transfers preserve inventory value across reserve, transit, and receipt',()=>{
  const f=flow();const before=report(f.state).stockValueCents;
  const t=f.run('shipment.create',{sourceId:'WH-1',destinationId:'WH-2',carrier:'Test',lines:[{productId:'PRD-1',qty:12,unitCents:0}]});
  f.run('shipment.transition',{id:t.id,status:'reserved'});assert.equal(stock(f.state,'PRD-1','WH-1').locked,12);
  f.run('shipment.transition',{id:t.id,status:'in_transit'});const transit=report(f.state);assert.equal(transit.stockValueCents+transit.transitValueCents,before);assert.equal(transit.transitValueCents,12000);
  f.run('shipment.transition',{id:t.id,status:'received'});assert.equal(report(f.state).stockValueCents,before);assert.equal(stock(f.state,'PRD-1','WH-2').onHand,112);assert.equal(report(f.state).transitValueCents,0);
  assert.throws(()=>f.run('shipment.transition',{id:t.id,status:'received'}),/Cannot move/);
});
test('fractional moving-average costs never create or lose inventory cents',()=>{
  const f=flow();const initial=report(f.state).stockValueCents;
  f.run('inventory.adjust',{productId:'PRD-1',warehouseId:'WH-1',delta:1,reason:'Mixed cost batch',unitCents:2000});
  assert.equal(report(f.state).stockValueCents,initial+2000);
  const t=f.run('shipment.create',{sourceId:'WH-1',destinationId:'WH-2',carrier:'Test',lines:[{productId:'PRD-1',qty:3,unitCents:0}]});
  for(const status of ['reserved','in_transit','received'])f.run('shipment.transition',{id:t.id,status});
  assert.equal(report(f.state).stockValueCents,initial+2000);
  const o=shipped(f);const afterSale=report(f.state).stockValueCents;const cost=report(f.state).cogsCents;
  assert.equal(afterSale+cost,initial+2000);
  for(let i=0;i<4;i++)f.run('sale.return',{id:o.id,lines:[{productId:'PRD-1',qty:1}]});
  assert.equal(report(f.state).stockValueCents,initial+2000);assert.equal(report(f.state).cogsCents,0);
});
test('reserved shipment cancellation releases locks and same-warehouse transfer is rejected',()=>{
  const f=flow();assert.throws(()=>f.run('shipment.create',{sourceId:'WH-1',destinationId:'WH-1',carrier:'Test',lines:saleInput.lines}),/different/);
  const t=f.run('shipment.create',{sourceId:'WH-1',destinationId:'WH-2',carrier:'Test',lines:saleInput.lines});for(const status of ['reserved','cancelled'])f.run('shipment.transition',{id:t.id,status});assert.equal(stock(f.state,'PRD-1','WH-1').locked,0);
});
test('inventory adjustment cannot consume stock reserved by another document',()=>{
  const f=flow();const o=f.run('sale.create',saleInput);f.run('sale.transition',{id:o.id,status:'confirmed'});
  assert.throws(()=>f.run('inventory.adjust',{productId:'PRD-1',warehouseId:'WH-1',delta:-97,reason:'count'}),/Insufficient/);
  assert.throws(()=>f.run('inventory.adjust',{productId:'PRD-1',warehouseId:'WH-1',delta:0,reason:'count',unitCents:100}),/zero/);
  f.run('inventory.adjust',{productId:'PRD-1',warehouseId:'WH-1',delta:2,reason:'count',unitCents:2000});assert.equal(stock(f.state,'PRD-1','WH-1').onHand,102);assert.equal(f.state.movements[0].reference,'count');
});
test('cost captured at shipment does not change when later receipts alter current average cost',()=>{
  const f=flow();shipped(f);f.run('inventory.adjust',{productId:'PRD-1',warehouseId:'WH-1',delta:100,reason:'New batch',unitCents:3000});assert.equal(report(f.state).cogsCents,4000);
});
test('expenses affect operating profit, not sales or gross profit',()=>{
  const f=flow();shipped(f);f.run('expense.create',{category:'Software',description:'Test',amountCents:200});const r=report(f.state);assert.equal(r.grossProfitCents,8000);assert.equal(r.netProfitCents,7800);
});
test('report date grouping honors the selected company timezone and channel filter',()=>{
  const f=flow();const o=shipped(f);f.state.sales.find(x=>x.id===o.id).shippedAt='2026-10-13T20:00:00Z';
  assert.equal(report(f.state,{from:'2026-10-14',to:'2026-10-14'}).revenueCents,12000);assert.equal(report(f.state,{from:'2026-10-13',to:'2026-10-13'}).revenueCents,0);
  assert.equal(report(f.state,{channel:'Amazon'}).revenueCents,0);f.state.settings.timezone='UTC';assert.equal(report(f.state,{from:'2026-10-13',to:'2026-10-13'}).revenueCents,12000);
});
test('analyst writes and operator finance changes are rejected by the domain',()=>{
  const s=fixture();assert.throws(()=>mutate(s,'product.create',{},s.users[2]),e=>e.status===403);assert.throws(()=>mutate(s,'expense.create',{},s.users[1]),e=>e.status===403);
});
test('SKU uniqueness is case insensitive; unknown references and duplicate lines are rejected',()=>{
  const f=flow();const p=f.state.products[0];assert.throws(()=>f.run('product.create',{...p,sku:p.sku.toLowerCase()}),/already exists/);
  assert.throws(()=>f.run('sale.create',{...saleInput,warehouseId:'bad'}),/not found/);assert.throws(()=>f.run('sale.create',{...saleInput,lines:[saleInput.lines[0],saleInput.lines[0]]}),/only once/);
});
test('malformed dates return validation errors rather than unexpected exceptions',()=>{
  const f=flow();for(const expectedDate of ['not-a-date','2026-02-30','2026-99-99'])assert.throws(()=>f.run('purchase.create',{...poInput,expectedDate}),e=>e instanceof DomainError&&e.status===400);
});
test('users cannot remove their own admin access, and unknown actions never mutate state',()=>{
  const f=flow();assert.throws(()=>f.run('user.update',{id:f.state.users[0].id,role:'analyst',active:true}),/own administrator/);
  assert.throws(()=>f.run('unknown',{}),e=>e.status===403);assert.equal(f.state.audit.length,0);
});
