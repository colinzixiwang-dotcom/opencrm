import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.mjs";
const temp = mkdtempSync(join(tmpdir(), "harbor-rma-e2e-")),
  app = await startServer(join(temp, "test-workspace")),
  base = app.base,
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_EXECUTABLE
      ? { executablePath: process.env.CHROME_EXECUTABLE }
      : {}),
  });
const adminContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  }),
  page = await adminContext.newPage();
page.setDefaultTimeout(15000);
const errors = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
mkdirSync("test-results", { recursive: true });
const pass = (s) => {
  checks.push(s);
  console.log("PASS", s);
};
const data = async (p) => (await p.request.get(base + "/api/bootstrap")).json();
const nav = async (p, id) => {
  await p.locator(`a.nav-item[href="#${id}"]`).click();
  await p.locator(".page-heading").waitFor();
};
const dialog = (p) => p.getByRole("dialog").last();
const save = async (p, label = "Save record") => {
  if (label === "Create RMA" && await dialog(p).getByLabel("Delivery date",{exact:true}).count()) await dialog(p).getByLabel("Delivery date",{exact:true}).fill(new Date(Date.now()-30*86400000).toISOString().slice(0,10));
  const count = await p.locator("dialog").count();
  await dialog(p).getByRole("button", { name: label, exact: true }).click();
  await p.waitForFunction(
    (n) => document.querySelectorAll("dialog").length === n,
    count - 1,
  );
};
const post = async (p, action, payload) => {
  const r = await p.request.post(base + "/api/action", {
    data: { action, payload },
  });
  assert.equal(r.status(), 200, await r.text());
  return (await r.json()).result;
};
const login = async (p, role) => {
  await p.goto(base);
  await p.locator(`[data-demo=${role}]`).click();
  await p
    .getByRole("heading", { name: "Your operation, at a glance." })
    .waitFor();
};
let operatorContext, otherContext;
try {
  await login(page, "admin");
  await nav(page, "product");
  const addProduct = async (sku, name, type, part = false) => {
    await page
      .getByRole("button", { name: "Add product", exact: true })
      .click();
    const d = dialog(page);
    for (const [k, v] of Object.entries({
      sku,
      name,
      category: "Support",
      costCents: "5.00",
      priceCents: "20.00",
      reorderPoint: "2",
      leadDays: "7",
    }))
      await d.locator(`[name=${k}]`).fill(v);
    await d.locator("[name=productType]").selectOption(type);
    if (part) {
      await d.locator("[name=partKind]").selectOption("printhead");
      await d.locator("[name=deviceIds]").selectOption(device.id);
    }
    await save(page);
    return (await data(page)).products.find((x) => x.sku === sku);
  };
  const device = await addProduct(
      "SUP-DEVICE-001",
      "Support Test Printer",
      "device",
    ),
    part = await addProduct(
      "SUP-HEAD-001",
      "Support Test Printhead",
      "part",
      true,
    );
  await page.getByLabel("Filter SKU type").selectOption("part");
  assert.equal(await page.locator("tbody tr[data-row-id]").count(), 1);
  assert.match(await page.locator("tbody").innerText(), /SUP-HEAD-001/);
  pass("device and custom printhead SKUs, compatibility, and product filters");
  await nav(page, "rmaconfig");
  await page.getByRole("tab", { name: "Custom fields", exact: true }).click();
  await page.getByRole("button", { name: "Add field", exact: true }).click();
  let d = dialog(page);
  await d.getByLabel("Name", { exact: true }).fill("Customer region");
  await d
    .getByLabel("Stable key (optional for new records)")
    .fill("customer_region");
  await d.getByLabel("Field type", { exact: true }).selectOption("select");
  await d.getByLabel("Options (one per line)").fill("US\nEU");
  await d.getByLabel("Required", { exact: true }).check();
  await save(page, "Save configuration");
  await page.getByRole("tab", { name: "Root causes", exact: true }).click();
  await page
    .getByRole("button", { name: "Add root cause", exact: true })
    .click();
  d = dialog(page);
  await d.getByLabel("Name", { exact: true }).fill("Print quality issue");
  await d
    .getByLabel("Stable key (optional for new records)")
    .fill("print_quality");
  await d.getByLabel("Primary label").selectOption("device_issue");
  await d.getByLabel("Applies to device / part SKUs").selectOption(device.id);
  await save(page, "Save configuration");
  await page.getByRole("tab", { name: "Solutions & DAG", exact: true }).click();
  await page.getByRole("button", { name: "Add solution", exact: true }).click();
  d = dialog(page);
  await d.getByLabel("Name", { exact: true }).fill("Full support resolution");
  await d
    .getByLabel("Stable key (optional for new records)")
    .fill("full_resolution");
  for (const [i, [key, type, amount]] of [
    ["return", "return_device", "0"],
    ["refund", "refund", "200.00"],
    ["parts", "send_parts", "0"],
    ["gift", "gift_card", "150.00"],
    ["promo", "promo_code", "0"],
  ].entries()) {
    await d.getByRole("button", { name: "Add task node", exact: true }).click();
    const n = d.locator(".workflow-node").nth(i);
    await n.getByLabel("Node key", { exact: true }).fill(key);
    await n.getByLabel("Task type", { exact: true }).selectOption(type);
    await n.getByLabel("Default value ($)").fill(amount);
    if (type === "send_parts")
      await n.getByLabel("Default SKU").selectOption(part.id);
    if (["refund", "parts"].includes(key))
      await n.getByRole("checkbox", { name: "return", exact: true }).check();
  }
  await page.screenshot({
    path: "test-results/rma-dag-editor.png",
    fullPage: true,
  });
  await save(page, "Save configuration");
  pass(
    "admin creates required custom fields, SKU-specific root causes, and a five-node solution DAG without code",
  );
  await nav(page, "supportorders");
  await page
    .getByRole("button", { name: "Add support order", exact: true })
    .click();
  d = dialog(page);
  await d
    .getByLabel("Order number", { exact: true })
    .fill("CUSTOMER-ORDER-1001");
  await d.getByLabel("Customer", { exact: true }).fill("Support Customer");
  await d.getByLabel("Platform", { exact: true }).selectOption("Amazon");
  await d.getByLabel("SKU", { exact: true }).selectOption(device.id);
  await save(page);
  await nav(page, "serials");
  for (const [kind, sn, pid] of [
    ["device", "PRINTER-SN-1001", device.id],
    ["printhead", "HEAD-SN-1001", part.id],
  ]) {
    await page
      .getByRole("button", { name: "Register serial", exact: true })
      .click();
    d = dialog(page);
    await d.getByLabel("Serial number", { exact: true }).fill(sn);
    await d.getByLabel("Serial type", { exact: true }).selectOption(kind);
    await d.getByLabel("SKU", { exact: true }).selectOption(pid);
    if (kind === "printhead")
      await d
        .getByLabel("Parent device SN", { exact: true })
        .selectOption("PRINTER-SN-1001");
    await save(page);
  }
  await page
    .getByRole("textbox", { name: "Search records", exact: true })
    .fill("HEAD-SN-1001");
  assert.equal(await page.locator("tbody tr[data-row-id]").count(), 1);
  pass(
    "support orders and linked device / printhead serials can be created and searched",
  );
  operatorContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const operator = await operatorContext.newPage();
  operator.setDefaultTimeout(15000);
  operator.on("pageerror", (e) => errors.push(e.message));
  await login(operator, "operator");
  await nav(operator, "supportorders");
  await operator
    .getByRole("textbox", { name: "Search records", exact: true })
    .fill("CUSTOMER-ORDER-1001");
  await operator
    .getByRole("button", { name: "Create RMA", exact: true })
    .click();
  d = dialog(operator);
  await d.getByLabel("Support ticket number").fill("TICKET-RMA-1001");
  assert.equal(
    await d.getByLabel("Order number", { exact: true }).inputValue(),
    "CUSTOMER-ORDER-1001",
  );
  await d.getByLabel("Serial number (optional)").fill("PRINTER-SN-1001");
  await d
    .getByLabel("Root cause", { exact: true })
    .selectOption("print_quality");
  await d
    .getByLabel("Description", { exact: true })
    .fill(
      "The printer has poor print quality. Please resolve all follow-up tasks.",
    );
  await d.getByLabel("Proposed solution").selectOption("full_resolution");
  await d.getByLabel("Customer region").selectOption("US");
  assert.equal(await d.locator(".workflow-node").count(), 5);
  assert.equal(
    await d.getByRole("button", { name: "Add task node" }).count(),
    0,
  );
  await save(operator, "Create RMA");
  let s = await data(operator);
  const rma = s.rmas[0];
  assert.equal(s.rmaTasks.length, 5);
  assert.equal(s.rmaTasks.filter((t) => t.approval === "pending").length, 3);
  assert.equal(rma.customFields.customer_region, "US");
  await nav(operator, "rma");
  const localDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: s.settings.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(rma.createdAt));
  await operator.getByLabel("From", { exact: true }).fill(localDay);
  await operator.getByLabel("To", { exact: true }).fill(localDay);
  assert.equal(await operator.locator("tbody tr[data-row-id]").count(), 1);
  await operator.screenshot({
    path: "test-results/rma-owner-list.png",
    fullPage: true,
  });
  pass(
    "creator selects one solution and creates all five tasks with three independent approvals",
  );
  await post(page, "user.create", {
    name: "Other Support Agent",
    email: "other-rma@example.com",
    password: "OtherRMA!2026",
    role: "operator",
  });
  otherContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const other = await otherContext.newPage();
  await other.goto(base);
  await other.locator("[name=email]").fill("other-rma@example.com");
  await other.locator("[name=password]").fill("OtherRMA!2026");
  await other.getByRole("button", { name: /Open workspace/ }).click();
  await other
    .getByRole("heading", { name: "Your operation, at a glance." })
    .waitFor();
  await nav(other, "rma");
  assert.equal((await data(other)).rmas.length, 0);
  assert.equal(
    (await other.request.get(base + "/api/rmas/" + rma.id)).status(),
    404,
  );
  const csv = await other.request.get(base + "/api/export/rmas");
  assert.equal(csv.status(), 200);
  assert.ok(!(await csv.text()).includes(rma.id));
  assert.equal(
    await operator.locator('a.nav-item[href="#rmatasks"]').count(),
    0,
  );
  pass(
    "a second agent cannot see the case in UI, detail API, task data, or CSV exports",
  );
  await page.reload();
  await nav(page, "rmatasks");
  s = await data(page);
  const task = (type) =>
    s.rmaTasks.find((t) => t.rmaId === rma.id && t.typeId === type);
  const openTask = async (id) => {
    await page
      .locator(`tr[data-row-id="${id}"]`)
      .getByRole("button", { name: "Open task", exact: true })
      .click();
  };
  const review = async (type) => {
    await openTask(task(type).id);
    d = dialog(page);
    await d.getByRole("tab", { name: "Review approval", exact: true }).click();
    await d
      .getByLabel("Review reason")
      .fill("Approved after checking case details.");
    await save(page, "Save review");
    s = await data(page);
  };
  await review("refund");
  assert.equal(task("refund").status, "blocked");
  await review("gift_card");
  await review("return_device");
  assert.equal(task("send_parts").status, "blocked");
  pass(
    "admin reviews tasks independently while dependencies continue to block execution",
  );
  const execute = async (type, op, fields = {}) => {
    await openTask(task(type).id);
    d = dialog(page);
    await d.getByRole("tab", { name: "Record execution", exact: true }).click();
    await d.getByLabel("Execution action").selectOption(op);
    for (const [label, value] of Object.entries(fields))
      await d.getByLabel(label, { exact: true }).fill(value);
    await save(page, "Record execution");
    s = await data(page);
  };
  await execute("gift_card", "complete", {
    "Gift card code / delivery reference": "GIFT-CARD-1001",
  });
  await execute("promo_code", "complete", {
    "Promo code sent": "PROMO-SUPPORT-15",
  });
  assert.equal(s.benefitHistory.length, 2);
  await nav(page, "rmalogistics");
  assert.equal(await page.locator("tbody tr[data-row-id]").count(), 1);
  await page.getByRole("tab", { name: /By task/ }).click();
  assert.equal(await page.locator("tbody tr[data-row-id]").count(), 2);
  await nav(page, "rmatasks");
  await execute("return_device", "dispatch", {
    Carrier: "Return Carrier",
    "Tracking number": "RETURN-TRACK-1001",
  });
  assert.equal(task("refund").status, "blocked");
  await execute("return_device", "complete");
  assert.equal(task("refund").status, "ready");
  assert.equal(task("send_parts").status, "ready");
  await execute("send_parts", "dispatch", {
    Carrier: "Parts Carrier",
    "Tracking number": "PARTS-TRACK-1001",
  });
  await nav(page, "rmalogistics");
  await page.getByText("No records yet.", { exact: true }).waitFor();
  await nav(page, "rmatasks");
  await execute("send_parts", "complete");
  await execute("refund", "complete", {
    "Transaction / fulfillment reference": "REFUND-TXN-1001",
  });
  assert.equal(s.rmas.find((r) => r.id === rma.id).status, "completed");
  await page.screenshot({
    path: "test-results/rma-task-center.png",
    fullPage: true,
  });
  pass(
    "return receipt unlocks refund and parts; dispatch queue clears and all tasks complete",
  );
  await nav(page, "benefits");
  assert.equal(await page.locator("tbody tr[data-row-id]").count(), 2);
  await page
    .getByLabel("Benefit type", { exact: true })
    .selectOption("Send gift card");
  assert.equal(await page.locator("tbody tr[data-row-id]").count(), 1);
  await page
    .getByRole("textbox", { name: "Search records", exact: true })
    .fill("GIFT-CARD-1001");
  assert.equal(await page.locator("tbody tr[data-row-id]").count(), 1);
  await page.screenshot({
    path: "test-results/rma-benefit-history.png",
    fullPage: true,
  });
  pass(
    "sent gift card and promo code history supports type filters and code search",
  );
  await nav(page, "rmaconfig");
  await page.getByRole("tab", { name: "Custom fields", exact: true }).click();
  for (const [key, name, scope] of [
    ["support_tier", "Support tier", "product"],
    ["delivery_confirmation", "Delivery confirmation", "execution"],
  ]) {
    await page.getByRole("button", { name: "Add field", exact: true }).click();
    d = dialog(page);
    await d.getByLabel("Name", { exact: true }).fill(name);
    await d.getByLabel("Stable key (optional for new records)").fill(key);
    await d.getByLabel("Form scope").selectOption(scope);
    await d.getByLabel("Required", { exact: true }).check();
    if (scope === "execution")
      await d.getByLabel("Applies to task type").selectOption("gift_card");
    await save(page, "Save configuration");
  }
  await nav(page, "product");
  await page
    .getByRole("button", { name: "Edit SUP-DEVICE-001", exact: true })
    .click();
  await dialog(page)
    .getByLabel("Support tier", { exact: true })
    .fill("Premium");
  await save(page, "Save changes");
  assert.equal(
    (await data(page)).products.find((p) => p.id === device.id).customFields
      .support_tier,
    "Premium",
  );
  const extra = await post(operator, "rma.create", {
    ticketNumber: "TICKET-EDIT-TEST",
    orderNumber: "CUSTOMER-ORDER-1001",
    platform: "Amazon",
    productId: device.id,
    rootCauseId: "print_quality",
    description: "Goodwill adjustment and delivery proof",
    solutionId: "goodwill",
    customFields: { customer_region: "US" },
    taskInputs: { gift: { amountCents: 5000 } },
  });
  await operator.reload();
  await nav(operator, "rma");
  await operator.getByRole("button", { name: extra.id, exact: true }).click();
  let extraState = await data(operator),
    extraGift = extraState.rmaTasks.find(
      (t) => t.rmaId === extra.id && t.typeId === "gift_card",
    );
  await dialog(operator)
    .locator(".workflow-node")
    .filter({ hasText: "Send gift card" })
    .getByRole("button", { name: "Edit task details", exact: true })
    .click();
  d = dialog(operator);
  await d.getByRole("tab", { name: "Task details", exact: true }).click();
  await d.getByLabel("Value ($)").fill("150.00");
  await save(operator, "Save task details");
  await dialog(operator)
    .getByRole("button", { name: "Close", exact: true })
    .click();
  extraState = await data(operator);
  assert.equal(
    extraState.rmaTasks.find((t) => t.id === extraGift.id).approval,
    "pending",
  );
  await page.reload();
  await nav(page, "rmatasks");
  await openTask(extraGift.id);
  d = dialog(page);
  await d.getByRole("tab", { name: "Review approval", exact: true }).click();
  await d.getByLabel("Review reason").fill("Approve revised goodwill amount");
  await save(page, "Save review");
  await openTask(extraGift.id);
  d = dialog(page);
  await d.getByRole("tab", { name: "Record execution", exact: true }).click();
  await d.getByLabel("Gift card code / delivery reference").fill("GIFT-EXTRA");
  await d.getByLabel("Delivery confirmation").fill("Customer email delivered");
  await save(page, "Record execution");
  s = await data(page);
  assert.equal(
    s.rmaTasks.find((t) => t.id === extraGift.id).executionFields
      .delivery_confirmation,
    "Customer email delivered",
  );
  pass(
    "admin-configured product and execution fields work; changing a gift value triggers a new approval",
  );

  await operator.reload();
  await nav(operator, "rma");
  await operator.getByRole("button", { name: rma.id, exact: true }).click();
  d = dialog(operator);
  await d
    .getByLabel("Add case note")
    .fill("Customer confirms the replacement part works.");
  await d.getByRole("button", { name: "Add note", exact: true }).click();
  await d
    .getByText("Customer confirms the replacement part works.", { exact: true })
    .waitFor();
  await d.getByRole("button", { name: "Close", exact: true }).click();
  await operator.setViewportSize({ width: 390, height: 844 });
  await operator.reload();
  await operator
    .getByRole("heading", { name: "Return merchandise authorizations" })
    .waitFor();
  assert.equal(
    await operator.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await operator.screenshot({
    path: "test-results/rma-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  pass(
    "owner case notes, completed-case visibility, responsive layout, and zero JavaScript errors",
  );
  writeFileSync(
    "test-results/rma-e2e-report.json",
    JSON.stringify({ passed: true, checks, errors }, null, 2),
  );
  console.log(checks.length + " RMA browser checkpoints passed.");
} catch (e) {
  await page.screenshot({
    path: "test-results/rma-failure.png",
    fullPage: true,
  });
  writeFileSync(
    "test-results/rma-e2e-report.json",
    JSON.stringify({ passed: false, checks, errors, error: e.stack }, null, 2),
  );
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  await app.close();
  rmSync(temp, { recursive: true, force: true });
}
