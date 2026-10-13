import { randomUUID, scryptSync, timingSafeEqual, randomBytes } from 'node:crypto';

export class DomainError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new DomainError(message, status); };
export const id = prefix => `${prefix}-${randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();
const day = () => now().slice(0, 10);
const required = (v, name, max = 160) => {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max) fail(`${name} is required (maximum ${max} characters).`);
  return v.trim();
};
const text = (v, max = 500) => {
  if (v == null) return '';
  if (typeof v !== 'string' || v.length > max) fail(`Text must be at most ${max} characters.`);
  return v.trim();
};
const integer = (v, name, min = 1, max = 1_000_000) => {
  if (!Number.isSafeInteger(v) || v < min || v > max) fail(`${name} must be a whole number between ${min} and ${max}.`);
  return v;
};
const oneOf = (v, values, name) => values.includes(v) ? v : fail(`Invalid ${name}.`);
const find = (s, collection, key, label = collection) => s[collection].find(x => x.id === key) || fail(`${label} not found.`, 404);
const total = lines => lines.reduce((v, l) => v + l.qty * l.unitCents, 0);
const sum = (items, field) => items.reduce((v, x) => v + x[field], 0);
const unique = (s, field, v, exclude) => {
  if (s.some(x => x[field].toLowerCase() === v.toLowerCase() && x.id !== exclude)) fail(`${field.toUpperCase()} already exists.`, 409);
};

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password, stored) {
  const [salt, encoded] = stored.split(':');
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(encoded, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const actionRoles = {
  'product.create': ['admin', 'operator'], 'product.update': ['admin', 'operator'],
  'supplier.create': ['admin', 'operator'], 'warehouse.create': ['admin'],
  'purchase.create': ['admin', 'operator'], 'purchase.transition': ['admin', 'operator'],
  'purchase.receive': ['admin', 'operator'], 'purchase.pay': ['admin'],
  'inventory.adjust': ['admin', 'operator'],
  'shipment.create': ['admin', 'operator'], 'shipment.transition': ['admin', 'operator'],
  'sale.create': ['admin', 'operator'], 'sale.transition': ['admin', 'operator'],
  'sale.return': ['admin', 'operator'], 'sale.pay': ['admin'],
  'expense.create': ['admin'], 'campaign.create': ['admin', 'operator'],
  'campaign.update': ['admin', 'operator'], 'ticket.create': ['admin', 'operator'],
  'ticket.transition': ['admin', 'operator'], 'task.create': ['admin', 'operator'],
  'task.transition': ['admin', 'operator'], 'settings.update': ['admin'],
  'user.create': ['admin'], 'user.update': ['admin'],
};
export const can = (role, action) => actionRoles[action]?.includes(role) || false;

export function stock(s, productId, warehouseId) {
  find(s, 'products', productId, 'Product'); find(s, 'warehouses', warehouseId, 'Warehouse');
  let row = s.stocks.find(x => x.productId === productId && x.warehouseId === warehouseId);
  if (!row) { row = { id: id('STK'), productId, warehouseId, onHand: 0, locked: 0, averageCostCents: 0, valueCents: 0 }; s.stocks.push(row); }
  return row;
}
const ledger = (s, row, delta, kind, reference, cost, user, totalCostCents=Math.abs(delta)*cost) => s.movements.unshift({
  id: id('MOV'), productId: row.productId, warehouseId: row.warehouseId, delta,
  kind, reference, unitCostCents: cost, totalCostCents, onHandAfter: row.onHand, valueCentsAfter: row.valueCents, actor: user.name, createdAt: now(),
});
const allocate = (value, qty, totalQty) => Number((2n*BigInt(value)*BigInt(qty)+BigInt(totalQty))/(2n*BigInt(totalQty)));
function addStock(s, row, qty, cost, kind, reference, user, totalCostCents=qty*cost) {
  const nextQty = row.onHand + qty;
  if (nextQty > 100_000_000) fail('Inventory exceeds the supported quantity limit.');
  row.valueCents += totalCostCents;
  row.averageCostCents = nextQty ? Math.round(row.valueCents / nextQty) : 0;
  row.onHand = nextQty;
  ledger(s, row, qty, kind, reference, cost, user, totalCostCents);
}
function removeStock(s, row, qty, kind, reference, user, reserved = false) {
  const available = reserved ? row.locked : row.onHand - row.locked;
  if (qty > available || qty > row.onHand) fail(`Insufficient ${reserved ? 'reserved' : 'available'} stock.`, 409);
  const totalCostCents = allocate(row.valueCents,qty,row.onHand);
  const cost = Math.round(totalCostCents / qty);
  row.onHand -= qty;
  row.valueCents -= totalCostCents;
  if (reserved) row.locked -= qty;
  ledger(s, row, -qty, kind, reference, cost, user,totalCostCents);
  row.averageCostCents = row.onHand ? Math.round(row.valueCents/row.onHand) : 0;
  return {unitCostCents:cost,totalCostCents};
}
function reserve(s, lines, warehouseId) {
  for (const l of lines) {
    const row = stock(s, l.productId, warehouseId);
    if (row.onHand - row.locked < l.qty) fail(`Insufficient available stock for ${find(s, 'products', l.productId).sku}.`, 409);
    row.locked += l.qty;
  }
}
function release(s, lines, warehouseId) {
  for (const l of lines) { const row = stock(s, l.productId, warehouseId); row.locked -= l.qty; }
}
function linesInput(s, items) {
  if (!Array.isArray(items) || !items.length || items.length > 50) fail('Add between 1 and 50 line items.');
  const seen = new Set();
  return items.map(l => {
    find(s, 'products', l.productId, 'Product');
    if (seen.has(l.productId)) fail('A product may appear only once per document.');
    seen.add(l.productId);
    return { productId: l.productId, qty: integer(l.qty, 'Quantity'), unitCents: integer(l.unitCents, 'Unit price in cents', 0, 10_000_000), received: 0, returned: 0 };
  });
}
function receiptInput(input, lines, field) {
  if (!Array.isArray(input) || !input.length) fail('Select at least one line to receive.');
  const seen = new Set();
  const normalized = input.map(item => {
    const line = lines.find(l => l.productId === item.productId) || fail('Unknown line item.');
    if (seen.has(item.productId)) fail('Duplicate receipt line.');
    seen.add(item.productId);
    const qty = integer(item.qty, 'Quantity');
    if (qty > line.qty - line[field]) fail('Quantity exceeds the remaining amount.', 409);
    return { line, qty };
  });
  return normalized;
}
const dateInput = (v, fallback = day()) => {
  if (!v) return fallback;
  const parsed=typeof v==='string'?new Date(v):new Date(NaN);
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== v) fail('Enter a valid date.');
  return v;
};
const financialPayment = (s, doc, collection, b, user) => {
  if (doc.status === 'cancelled' || doc.status === 'draft' || doc.status === 'pending') fail('Approve or confirm the document before recording a payment.', 409);
  const amountCents = integer(b.amountCents, 'Payment amount in cents', 1, 500_000_000);
  const due = total(doc.lines) - (doc.refundCents || 0) - doc.paidCents;
  if (amountCents > due) fail('Payment exceeds the outstanding balance.', 409);
  doc.paidCents += amountCents;
  const payment = { id: id('PAY'), kind: collection === 'purchases' ? 'outflow' : 'inflow', reference: doc.id, amountCents, date: dateInput(b.date), note: text(b.note), actor: user.name, createdAt: now() };
  s.payments.unshift(payment); return payment;
};

export function mutate(original, action, b, user) {
  if (!can(user.role, action)) fail('Your role does not permit this action.', 403);
  // Clone first: an invalid multi-line action never partially mutates its caller.
  const s = structuredClone(original);
  let result;
  switch (action) {
    case 'product.create': case 'product.update': {
      const existing = action.endsWith('update') ? find(s, 'products', b.id, 'Product') : null;
      const sku = required(b.sku, 'SKU', 64); unique(s.products, 'sku', sku, existing?.id);
      if (b.supplierId) find(s, 'suppliers', b.supplierId, 'Supplier');
      const p = { sku, name: required(b.name, 'Product name'), spu: text(b.spu, 64), category: required(b.category, 'Category', 64), unit: text(b.unit || 'pcs', 16), costCents: integer(b.costCents, 'Cost', 0, 10_000_000), priceCents: integer(b.priceCents, 'Price', 0, 10_000_000), reorderPoint: integer(b.reorderPoint, 'Reorder point', 0), supplierId: b.supplierId || '', leadDays: integer(b.leadDays ?? 14, 'Lead time', 0, 365), updatedAt: now() };
      if (existing) Object.assign(existing, p); else s.products.unshift({ id: id('PRD'), ...p, createdAt: now() });
      result = existing || s.products[0]; break;
    }
    case 'supplier.create': {
      const email = text(b.email, 160); if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter a valid supplier email.');
      result = { id: id('SUP'), name: required(b.name, 'Supplier name'), contact: text(b.contact), email, terms: text(b.terms || 'Net 30'), createdAt: now() };
      s.suppliers.unshift(result); break;
    }
    case 'warehouse.create': {
      const name = required(b.name, 'Warehouse name'); unique(s.warehouses, 'name', name);
      result = { id: id('WH'), name, location: required(b.location, 'Location'), type: oneOf(b.type, ['local', 'fba', 'overseas'], 'warehouse type') };
      s.warehouses.push(result); break;
    }
    case 'purchase.create': {
      find(s, 'suppliers', b.supplierId, 'Supplier'); find(s, 'warehouses', b.warehouseId, 'Warehouse');
      const lines = linesInput(s, b.lines);
      if (total(lines) > 500_000_000) fail('Document total exceeds the supported limit.');
      result = { id: id('PO'), supplierId: b.supplierId, warehouseId: b.warehouseId, lines, status: 'draft', paidCents: 0, expectedDate: dateInput(b.expectedDate), note: text(b.note), createdAt: now(), updatedAt: now() };
      s.purchases.unshift(result); break;
    }
    case 'purchase.transition': {
      const p = find(s, 'purchases', b.id, 'Purchase order');
      const rules = { draft: ['pending', 'cancelled'], pending: ['approved', 'draft', 'cancelled'], approved: ['ordered', 'cancelled'], ordered: ['cancelled'] };
      if (!rules[p.status]?.includes(b.status)) fail(`Cannot move a ${p.status} purchase order to ${b.status}.`, 409);
      if (b.status === 'cancelled' && (p.paidCents || p.lines.some(l => l.received))) fail('Paid or received orders cannot be cancelled.', 409);
      p.status = b.status; p.updatedAt = now(); result = p; break;
    }
    case 'purchase.receive': {
      const p = find(s, 'purchases', b.id, 'Purchase order');
      if (!['ordered', 'partial'].includes(p.status)) fail('Only ordered or partially received purchases can be received.', 409);
      for (const { line, qty } of receiptInput(b.lines, p.lines, 'received')) {
        const row = stock(s, line.productId, p.warehouseId);
        addStock(s, row, qty, line.unitCents, 'purchase_receipt', p.id, user); line.received += qty;
      }
      p.status = p.lines.every(l => l.received === l.qty) ? 'received' : 'partial'; p.updatedAt = now(); result = p; break;
    }
    case 'purchase.pay': result = financialPayment(s, find(s, 'purchases', b.id), 'purchases', b, user); break;
    case 'inventory.adjust': {
      const row = stock(s, b.productId, b.warehouseId); const delta = integer(b.delta, 'Adjustment quantity', -1_000_000);
      if (!delta) fail('Adjustment cannot be zero.'); const reason = required(b.reason, 'Adjustment reason', 300);
      if (delta > 0) addStock(s, row, delta, integer(b.unitCents, 'Unit cost', 0, 10_000_000), 'adjustment', reason, user);
      else removeStock(s, row, -delta, 'adjustment', reason, user);
      result = row; break;
    }
    case 'shipment.create': {
      find(s, 'warehouses', b.sourceId, 'Source warehouse'); find(s, 'warehouses', b.destinationId, 'Destination warehouse');
      if (b.sourceId === b.destinationId) fail('Source and destination must be different.');
      const lines = linesInput(s, b.lines);
      result = { id: id('SHP'), sourceId: b.sourceId, destinationId: b.destinationId, lines, status: 'draft', carrier: required(b.carrier, 'Carrier'), tracking: text(b.tracking), expectedDate: dateInput(b.expectedDate), note: text(b.note), freightCents: integer(b.freightCents ?? 0, 'Freight', 0, 100_000_000), createdAt: now(), updatedAt: now() };
      s.shipments.unshift(result); break;
    }
    case 'shipment.transition': {
      const p = find(s, 'shipments', b.id, 'Shipment');
      const rules = { draft: ['reserved', 'cancelled'], reserved: ['in_transit', 'cancelled'], in_transit: ['received'] };
      if (!rules[p.status]?.includes(b.status)) fail(`Cannot move a ${p.status} shipment to ${b.status}.`, 409);
      if (b.status === 'reserved') reserve(s, p.lines, p.sourceId);
      if (p.status === 'reserved' && b.status === 'cancelled') release(s, p.lines, p.sourceId);
      if (b.status === 'in_transit') {
        for (const l of p.lines) { const cost=removeStock(s, stock(s, l.productId, p.sourceId), l.qty, 'transfer_out', p.id, user, true); l.costCents=cost.unitCostCents; l.costTotalCents=cost.totalCostCents; }
      }
      if (b.status === 'received') {
        for (const l of p.lines) addStock(s, stock(s, l.productId, p.destinationId), l.qty, l.costCents, 'transfer_in', p.id, user,l.costTotalCents);
      }
      p.status = b.status; p.updatedAt = now(); result = p; break;
    }
    case 'sale.create': {
      find(s, 'warehouses', b.warehouseId, 'Warehouse'); const lines = linesInput(s, b.lines);
      if (total(lines) > 500_000_000) fail('Document total exceeds the supported limit.');
      result = { id: id('SO'), customer: required(b.customer, 'Customer'), channel: oneOf(b.channel, ['Amazon', 'Shopify', 'Direct', 'Wholesale'], 'channel'), warehouseId: b.warehouseId, lines, status: 'draft', paidCents: 0, refundCents: 0, note: text(b.note), createdAt: now(), updatedAt: now() };
      s.sales.unshift(result); break;
    }
    case 'sale.transition': {
      const o = find(s, 'sales', b.id, 'Sales order'); const rules = { draft: ['confirmed', 'cancelled'], confirmed: ['shipped', 'cancelled'], shipped: ['completed'] };
      if (!rules[o.status]?.includes(b.status)) fail(`Cannot move a ${o.status} sales order to ${b.status}.`, 409);
      if (b.status === 'confirmed') reserve(s, o.lines, o.warehouseId);
      if (b.status === 'cancelled') { if (o.paidCents) fail('Refund the recorded payment before cancellation; payment reversal is not supported.', 409); if (o.status === 'confirmed') release(s, o.lines, o.warehouseId); }
      if (b.status === 'shipped') {
        for (const l of o.lines) { const cost=removeStock(s, stock(s, l.productId, o.warehouseId), l.qty, 'sale', o.id, user, true); l.costCents=cost.unitCostCents; l.costTotalCents=cost.totalCostCents; l.returnedCostCents=0; }
        o.shippedAt = now();
      }
      o.status = b.status; o.updatedAt = now(); result = o; break;
    }
    case 'sale.return': {
      const o = find(s, 'sales', b.id, 'Sales order'); if (!['shipped', 'completed'].includes(o.status)) fail('Only shipped orders can be returned.', 409);
      let refund = 0;
      for (const { line, qty } of receiptInput(b.lines, o.lines, 'returned')) {
        const returnedCost=allocate(line.costTotalCents,line.returned+qty,line.qty);
        const costDelta=returnedCost-line.returnedCostCents;
        addStock(s, stock(s, line.productId, o.warehouseId), qty, Math.round(costDelta/qty), 'sales_return', o.id, user,costDelta);
        line.returned += qty; line.returnedCostCents=returnedCost; refund += qty * line.unitCents;
      }
      o.refundCents += refund;
      // A paid return refunds only the collected amount above the revised total.
      const cashRefund = Math.max(0, o.paidCents - (total(o.lines) - o.refundCents));
      if (cashRefund) { o.paidCents -= cashRefund; s.payments.unshift({id:id('REF'),kind:'outflow',reference:o.id,amountCents:cashRefund,date:day(),note:'Sales return refund',actor:user.name,createdAt:now()}); }
      o.updatedAt = now(); result = o; break;
    }
    case 'sale.pay': result = financialPayment(s, find(s, 'sales', b.id), 'sales', b, user); break;
    case 'expense.create': {
      result = { id: id('EXP'), category: oneOf(b.category, ['Advertising', 'Logistics', 'Software', 'Operations', 'Other'], 'expense category'), amountCents: integer(b.amountCents, 'Expense amount', 1, 100_000_000), date: dateInput(b.date), description: required(b.description, 'Description', 300), createdAt: now() };
      s.expenses.unshift(result); break;
    }
    case 'campaign.create': case 'campaign.update': {
      if (action.endsWith('create')) {
        result = { id: id('AD'), name: required(b.name, 'Campaign name'), channel: oneOf(b.channel, ['Amazon', 'Shopify', 'Direct'], 'channel'), budgetCents: integer(b.budgetCents, 'Budget', 0, 100_000_000), spendCents: integer(b.spendCents, 'Spend', 0, 100_000_000), attributedSalesCents: integer(b.attributedSalesCents, 'Attributed sales', 0, 100_000_000), status: 'active', createdAt: now() };
        s.campaigns.unshift(result);
      } else { result = find(s, 'campaigns', b.id, 'Campaign'); result.status = oneOf(b.status, ['active', 'paused'], 'campaign status'); }
      break;
    }
    case 'ticket.create': {
      if (b.orderId) find(s, 'sales', b.orderId, 'Sales order');
      result = { id: id('TKT'), customer: required(b.customer, 'Customer'), subject: required(b.subject, 'Subject'), category: oneOf(b.category, ['Order', 'Return', 'Quality', 'Other'], 'ticket category'), priority: oneOf(b.priority, ['normal', 'high'], 'priority'), orderId: b.orderId || '', status: 'open', notes: [{text:required(b.message, 'Message', 2000),actor:user.name,at:now()}], createdAt: now() };
      s.tickets.unshift(result); break;
    }
    case 'ticket.transition': {
      const t = find(s, 'tickets', b.id, 'Ticket'); if (b.status) t.status = oneOf(b.status, ['open', 'in_progress', 'resolved'], 'ticket status');
      if (b.note) t.notes.push({text:required(b.note, 'Note', 2000),actor:user.name,at:now()}); result = t; break;
    }
    case 'task.create': {
      result = { id: id('TASK'), title: required(b.title, 'Task title'), owner: text(b.owner || user.name), dueDate: dateInput(b.dueDate), priority: oneOf(b.priority || 'normal', ['normal', 'high'], 'priority'), status: 'open', createdAt: now() };
      s.tasks.unshift(result); break;
    }
    case 'task.transition': { result = find(s, 'tasks', b.id, 'Task'); result.status = oneOf(b.status, ['open', 'done'], 'task status'); break; }
    case 'settings.update': {
      s.settings.company = required(b.company, 'Company name'); s.settings.timezone = oneOf(b.timezone, ['Asia/Shanghai', 'America/New_York', 'Europe/London', 'UTC'], 'timezone');
      s.settings.lowStockDays = integer(b.lowStockDays, 'Stock coverage threshold', 1, 90); result = s.settings; break;
    }
    case 'user.create': {
      const email = required(b.email, 'Email').toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter a valid email.'); unique(s.users, 'email', email);
      const password = required(b.password, 'Password'); if (password.length < 10) fail('Passwords must contain at least 10 characters.');
      result = { id: id('USR'), name: required(b.name, 'Name'), email, role: oneOf(b.role, ['admin', 'operator', 'analyst'], 'role'), passwordHash: hashPassword(password), active: true };
      s.users.push(result); break;
    }
    case 'user.update': {
      const u = find(s, 'users', b.id, 'User'); const role = oneOf(b.role, ['admin', 'operator', 'analyst'], 'role'); const active = b.active;
      if (typeof active !== 'boolean') fail('Active state must be a boolean.');
      if (u.id === user.id && (role !== 'admin' || !active)) fail('You cannot remove your own administrator access.', 409);
      if (u.role === 'admin' && (!active || role !== 'admin') && s.users.filter(x=>x.role==='admin'&&x.active).length === 1) fail('At least one active administrator is required.', 409);
      u.role = role; u.active = active; result = u; break;
    }
    default: fail('Unknown action.', 404);
  }
  assertState(s);
  s.version += 1;
  s.audit.unshift({id:id('AUD'),action,reference:result?.id||'',actor:user.name,at:now()});
  if (s.audit.length > 5000) s.audit.length = 5000;
  return { state: s, result: result?.passwordHash ? { ...result, passwordHash: undefined } : result };
}

export function assertState(s) {
  for (const row of s.stocks) {
    if (!Number.isSafeInteger(row.onHand) || !Number.isSafeInteger(row.locked) || row.onHand < 0 || row.locked < 0 || row.locked > row.onHand) fail('Inventory invariant violated.', 409);
    if (!Number.isSafeInteger(row.averageCostCents) || row.averageCostCents < 0) fail('Inventory cost invariant violated.', 409);
    if (!Number.isSafeInteger(row.valueCents) || row.valueCents < 0 || (row.onHand===0&&row.valueCents!==0)) fail('Inventory value invariant violated.',409);
  }
}

export function report(s, { from = '0000-01-01', to = '9999-12-31', channel = 'all' } = {}) {
  const calendarDay = value => value?.length===10?value:value?new Intl.DateTimeFormat('en-CA',{timeZone:s.settings.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value)):null;
  const included = date => date && calendarDay(date) >= from && calendarDay(date) <= to;
  const sales = s.sales.filter(o => ['shipped', 'completed'].includes(o.status) && included(o.shippedAt) && (channel === 'all' || o.channel === channel));
  let revenueCents = 0, cogsCents = 0, units = 0;
  const productMap = new Map(); const days = new Map(); const channels = new Map();
  for (const order of sales) {
    let value = 0;
    for (const line of order.lines) {
      const qty = line.qty - line.returned; const revenue = qty * line.unitCents; const cost = line.costTotalCents-line.returnedCostCents;
      revenueCents += revenue; cogsCents += cost; units += qty; value += revenue;
      const p = productMap.get(line.productId) || {productId:line.productId,units:0,revenueCents:0,cogsCents:0};
      p.units += qty; p.revenueCents += revenue; p.cogsCents += cost; productMap.set(line.productId,p);
    }
    const d=calendarDay(order.shippedAt);days.set(d,(days.get(d)||0)+value);channels.set(order.channel,(channels.get(order.channel)||0)+value);
  }
  const expenses = s.expenses.filter(x => included(x.date)); const expenseCents = sum(expenses,'amountCents');
  const stockValueCents = s.stocks.reduce((v,r)=>v+r.valueCents,0);
  const transitValueCents = s.shipments.filter(x=>x.status==='in_transit').reduce((v,x)=>v+x.lines.reduce((a,l)=>a+l.costTotalCents,0),0);
  const outstandingSalesCents=s.sales.filter(x=>!['draft','cancelled'].includes(x.status)).reduce((v,x)=>v+total(x.lines)-x.refundCents-x.paidCents,0);
  const outstandingPurchaseCents=s.purchases.filter(x=>!['draft','pending','cancelled'].includes(x.status)).reduce((v,x)=>v+total(x.lines)-x.paidCents,0);
  return {revenueCents,cogsCents,grossProfitCents:revenueCents-cogsCents,expenseCents,netProfitCents:revenueCents-cogsCents-expenseCents,units,orders:sales.length,stockValueCents,transitValueCents,outstandingSalesCents,outstandingPurchaseCents,
    products:[...productMap.values()].sort((a,b)=>b.revenueCents-a.revenueCents),daily:[...days].sort(([a],[b])=>a.localeCompare(b)).map(([date,revenueCents])=>({date,revenueCents})),channels:[...channels].map(([channel,revenueCents])=>({channel,revenueCents})),expenses};
}
export function publicState(s, user) {
  return {...s,users:s.users.map(({passwordHash,...u})=>u),currentUser:{id:user.id,name:user.name,email:user.email,role:user.role},permissions:Object.keys(actionRoles).filter(a=>can(user.role,a)),report:report(s)};
}

// Upgrade early development snapshots without changing business quantities.
export function migrateState(s) {
  let changed=false;
  for(const row of s.stocks)if(row.valueCents==null){row.valueCents=row.onHand*row.averageCostCents;changed=true;}
  for(const order of [...s.sales,...s.shipments])for(const l of order.lines){
    if(l.costCents!=null&&l.costTotalCents==null){l.costTotalCents=l.costCents*l.qty;l.returnedCostCents=l.costCents*(l.returned||0);changed=true;}
  }
  return changed;
}

export function seedState() {
  const users = [
    {id:'USR-ADMIN',name:'Alex Morgan',email:'admin@harbor.local',role:'admin',active:true,passwordHash:hashPassword('HarborDemo!2026')},
    {id:'USR-OPERATOR',name:'Jamie Chen',email:'operator@harbor.local',role:'operator',active:true,passwordHash:hashPassword('HarborDemo!2026')},
    {id:'USR-ANALYST',name:'Sam Rivera',email:'analyst@harbor.local',role:'analyst',active:true,passwordHash:hashPassword('HarborDemo!2026')},
  ];
  const s = {version:1,settings:{company:'Harbor Supply Co.',currency:'USD',timezone:'Asia/Shanghai',lowStockDays:14},users,
    suppliers:[{id:'SUP-1',name:'Evergreen Manufacturing',contact:'Mia Lin',email:'mia@example.com',terms:'Net 30'},{id:'SUP-2',name:'Northstar Goods',contact:'David Park',email:'david@example.com',terms:'Net 15'}],
    warehouses:[{id:'WH-1',name:'Shenzhen Hub',location:'Shenzhen, CN',type:'local'},{id:'WH-2',name:'Amazon West',location:'California, US',type:'fba'},{id:'WH-3',name:'London Fulfillment',location:'London, UK',type:'overseas'}],
    products:[
      {id:'PRD-1',sku:'HB-TMB-001',spu:'HB-TMB',name:'Insulated Travel Tumbler',category:'Drinkware',unit:'pcs',costCents:850,priceCents:2890,reorderPoint:80,supplierId:'SUP-1',leadDays:18,createdAt:now()},
      {id:'PRD-2',sku:'HB-DSK-002',spu:'HB-DSK',name:'Oak Desk Organizer',category:'Workspace',unit:'pcs',costCents:1240,priceCents:3990,reorderPoint:35,supplierId:'SUP-2',leadDays:14,createdAt:now()},
      {id:'PRD-3',sku:'HB-LMP-003',spu:'HB-LMP',name:'Rechargeable Reading Lamp',category:'Lighting',unit:'pcs',costCents:1680,priceCents:5490,reorderPoint:45,supplierId:'SUP-1',leadDays:21,createdAt:now()},
      {id:'PRD-4',sku:'HB-BAG-004',spu:'HB-BAG',name:'Everyday Canvas Tote',category:'Accessories',unit:'pcs',costCents:620,priceCents:2290,reorderPoint:60,supplierId:'SUP-2',leadDays:12,createdAt:now()},
      {id:'PRD-5',sku:'HB-JAR-005',spu:'HB-JAR',name:'Glass Storage Set',category:'Kitchen',unit:'set',costCents:1120,priceCents:3490,reorderPoint:40,supplierId:'SUP-1',leadDays:16,createdAt:now()},
      {id:'PRD-6',sku:'HB-MAT-006',spu:'HB-MAT',name:'Cork Desk Mat',category:'Workspace',unit:'pcs',costCents:740,priceCents:2690,reorderPoint:30,supplierId:'SUP-2',leadDays:10,createdAt:now()},
    ],stocks:[],movements:[],purchases:[],sales:[],shipments:[],payments:[],expenses:[],campaigns:[],tickets:[],tasks:[],audit:[]};
  const admin=users[0];
  for(const [i,p] of s.products.entries())for(const [j,w]of s.warehouses.entries()){
    const qty=[260,145,23,190,78,95][i]-j*7;
    const row=stock(s,p.id,w.id);addStock(s,row,Math.max(qty,0),p.costCents,'opening_balance','Example opening stock',admin);
  }
  // Seed history through the same business actions used by the app.
  let state=s;
  const apply=(a,b)=>{const r=mutate(state,a,b,admin);state=r.state;return r.result;};
  for(let i=0;i<18;i++){
    const product=s.products[i%6];
    const order=apply('sale.create',{customer:['Juniper Market','River & Stone','Atlas Retail','Direct customer'][i%4],channel:['Amazon','Shopify','Direct','Wholesale'][i%4],warehouseId:'WH-2',lines:[{productId:product.id,qty:(i%4)+1,unitCents:product.priceCents}]});
    apply('sale.transition',{id:order.id,status:'confirmed'});apply('sale.transition',{id:order.id,status:'shipped'});apply('sale.transition',{id:order.id,status:'completed'});
    const date=new Date();date.setUTCDate(date.getUTCDate()-(17-i));find(state,'sales',order.id).shippedAt=date.toISOString();find(state,'sales',order.id).createdAt=date.toISOString();
    apply('sale.pay',{id:order.id,amountCents:total(order.lines),date:date.toISOString().slice(0,10)});
  }
  const po=apply('purchase.create',{supplierId:'SUP-1',warehouseId:'WH-1',expectedDate:day(),lines:[{productId:'PRD-3',qty:120,unitCents:1680}],note:'Priority replenishment for reading lamps.'});
  apply('purchase.transition',{id:po.id,status:'pending'});
  const po2=apply('purchase.create',{supplierId:'SUP-2',warehouseId:'WH-1',expectedDate:day(),lines:[{productId:'PRD-4',qty:80,unitCents:620}],note:'Next restock cycle.'});
  apply('purchase.transition',{id:po2.id,status:'pending'});apply('purchase.transition',{id:po2.id,status:'approved'});apply('purchase.transition',{id:po2.id,status:'ordered'});
  apply('expense.create',{category:'Advertising',description:'Example campaign spend',amountCents:18600,date:day()});
  apply('expense.create',{category:'Logistics',description:'Example transport charges',amountCents:7400,date:day()});
  apply('campaign.create',{name:'Tumbler · everyday essentials',channel:'Amazon',budgetCents:35000,spendCents:18600,attributedSalesCents:98640});
  apply('campaign.create',{name:'Workspace collection',channel:'Shopify',budgetCents:25000,spendCents:8200,attributedSalesCents:43600});
  apply('ticket.create',{customer:'Juniper Market',subject:'Confirm tumbler packaging specification',category:'Order',priority:'normal',message:'Please confirm the packaging dimensions for the next order.'});
  apply('task.create',{title:'Review reading lamp replenishment',owner:'Jamie Chen',priority:'high',dueDate:day()});
  apply('task.create',{title:'Check supplier quotes for next month',owner:'Alex Morgan',priority:'normal',dueDate:day()});
  state.audit=state.audit.slice(0,8);return state;
}
