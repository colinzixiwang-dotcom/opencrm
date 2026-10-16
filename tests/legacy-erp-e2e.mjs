import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { startServer } from "./server.mjs";

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require(process.env.PLAYWRIGHT_PATH || "playwright");
} catch {
  throw new Error(
    "Install the browser test dependency with npm install, or set PLAYWRIGHT_PATH to an existing Playwright installation.",
  );
}
const temp = mkdtempSync(join(tmpdir(), "harbor-e2e-"));
const app = await startServer(join(temp, "test.sqlite"));
const base = app.base;
const browser = await playwright.chromium.launch({
  headless: true,
  ...(process.env.CHROME_EXECUTABLE
    ? { executablePath: process.env.CHROME_EXECUTABLE }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
const page = await context.newPage();
page.setDefaultTimeout(12000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const failures = [];
page.on("requestfailed", (r) => {
  if (!r.failure()?.errorText.includes("ERR_ABORTED")) failures.push(r.url());
});
const checks = [];
mkdirSync("test-results", { recursive: true });
const checkpoint = (label) => {
  checks.push(label);
  console.log("PASS", label);
};
const data = async () => {
  const r = await page.request.get(base + "/api/bootstrap");
  assert.equal(r.status(), 200);
  return r.json();
};
const nav = async (name) => {
  await page.locator(`a.nav-item[href="#${name}"]`).click();
  await page.locator(`#main-content .page-heading`).waitFor();
};
const fill = async (name, value) =>
  page.locator(`#action-form [name="${name}"]`).fill(String(value));
const select = async (name, value) =>
  page.locator(`#action-form [name="${name}"]`).selectOption(value);
const save = async () => {
  await page.locator("#action-form button[type=submit]").click();
  await page.locator("dialog").waitFor({ state: "detached" });
};
const row = (id) => page.locator(`tr[data-row-id="${id}"]`);
const waitState = async (predicate) => {
  for (let i = 0; i < 80; i++) {
    const s = await data();
    if (predicate(s)) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("The expected persisted state was not reached.");
};
try {
  await page.goto(base);
  await page.getByRole("heading", { name: "Welcome aboard." }).waitFor();
  await page.locator("button[data-demo=admin]").click();
  await page
    .getByRole("heading", { name: "Your operation, at a glance." })
    .waitFor();
  checkpoint("administrator login and live dashboard");
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  assert.equal(await page.locator("a.nav-item").count(), 20);
  for (const p of [
    "product",
    "sales",
    "fba",
    "purchase",
    "warehouse",
    "logistics",
    "advertising",
    "service",
    "finance",
    "statistics",
    "tools",
    "settings",
  ]) {
    await nav(p);
    assert.ok(
      (await page.locator("#main-content").innerText()).length > 150,
      p + " is populated",
    );
  }
  checkpoint("all 12 operational modules render without page errors");

  await nav("product");
  await page.getByRole("button", { name: "Add product", exact: true }).click();
  for (const [k, v] of Object.entries({
    sku: "QA-NEW-001",
    name: "Browser Workflow Product",
    spu: "QA-GROUP",
    category: "QA",
    costCents: "5.00",
    priceCents: "12.00",
    reorderPoint: 5,
    leadDays: 7,
  }))
    await fill(k, v);
  await select("supplierId", "SUP-1");
  await save();
  let s = await data();
  const product = s.products.find((p) => p.sku === "QA-NEW-001");
  assert.ok(product);
  await page
    .getByRole("textbox", { name: "Search records", exact: true })
    .fill("QA-NEW-001");
  assert.equal(await page.locator("tbody tr[data-row-id]").count(), 1);
  await row(product.id)
    .getByRole("button", { name: "Edit QA-NEW-001" })
    .click();
  await fill("name", "Browser Workflow Product Updated");
  await save();
  s = await data();
  assert.equal(
    s.products.find((x) => x.id === product.id).name,
    "Browser Workflow Product Updated",
  );
  checkpoint("product creation, editing, persistence, and table search");

  await nav("purchase");
  await page.getByRole("tab", { name: /Suppliers/ }).click();
  await page.getByRole("button", { name: "Add supplier", exact: true }).click();
  await fill("name", "Browser Test Supplier");
  await fill("contact", "Test Contact");
  await fill("email", "contact@example.com");
  await save();
  s = await data();
  assert.ok(s.suppliers.some((x) => x.name === "Browser Test Supplier"));
  await page.getByRole("tab", { name: /Purchase orders/ }).click();
  await page
    .getByRole("button", { name: "New purchase order", exact: true })
    .click();
  await select("supplierId", "SUP-1");
  await select("warehouseId", "WH-1");
  await page.locator(".line-product").selectOption(product.id);
  await page.locator("[name=line-qty]").fill("20");
  await page.getByRole("button", { name: "Add another product" }).click();
  await page.locator(".line-product").nth(1).selectOption("PRD-1");
  await page.locator("[name=line-qty]").nth(1).fill("3");
  await save();
  s = await data();
  const po = s.purchases[0];
  assert.equal(po.lines.length, 2);
  assert.equal(po.lines[0].unitCents, 500);
  for (const [label, status] of [
    ["Submit", "pending"],
    ["Approve", "approved"],
    ["Place order", "ordered"],
  ]) {
    await row(po.id).getByRole("button", { name: label, exact: true }).click();
    await waitState(
      (s) => s.purchases.find((x) => x.id === po.id).status === status,
    );
  }
  await row(po.id)
    .getByRole("button", { name: "Receive", exact: true })
    .click();
  await page
    .locator(`.receipt-line input[data-product="${product.id}"]`)
    .fill("10");
  await save();
  s = await data();
  assert.equal(s.purchases.find((x) => x.id === po.id).status, "partial");
  assert.equal(
    s.stocks.find((x) => x.productId === product.id && x.warehouseId === "WH-1")
      .onHand,
    10,
  );
  await row(po.id)
    .getByRole("button", { name: "Receive", exact: true })
    .click();
  await save();
  s = await data();
  assert.equal(s.purchases.find((x) => x.id === po.id).status, "received");
  assert.equal(
    s.stocks.find((x) => x.productId === product.id && x.warehouseId === "WH-1")
      .onHand,
    20,
  );
  await row(po.id).getByRole("button", { name: "Pay", exact: true }).click();
  await save();
  s = await data();
  assert.equal(s.purchases.find((x) => x.id === po.id).paidCents, 12550);
  checkpoint(
    "multi-line purchasing: approval, partial receipt, final receipt, and payment",
  );

  await nav("sales");
  await page
    .getByRole("button", { name: "New sales order", exact: true })
    .click();
  await fill("customer", "Browser Test Buyer");
  await select("channel", "Direct");
  await select("warehouseId", "WH-1");
  await page.locator(".line-product").selectOption(product.id);
  await page.locator("[name=line-qty]").fill("4");
  await save();
  s = await data();
  const order = s.sales[0];
  for (const [label, status] of [
    ["Confirm", "confirmed"],
    ["Ship", "shipped"],
  ]) {
    await row(order.id)
      .getByRole("button", { name: label, exact: true })
      .click();
    await waitState(
      (s) => s.sales.find((x) => x.id === order.id).status === status,
    );
  }
  await row(order.id)
    .getByRole("button", { name: "Record payment", exact: true })
    .click();
  await save();
  await row(order.id)
    .getByRole("button", { name: "Return", exact: true })
    .click();
  await page.locator(".receipt-line input").fill("2");
  await save();
  s = await data();
  const updated = s.sales.find((x) => x.id === order.id);
  assert.equal(updated.refundCents, 2400);
  assert.equal(updated.paidCents, 2400);
  assert.equal(
    s.stocks.find((x) => x.productId === product.id && x.warehouseId === "WH-1")
      .onHand,
    18,
  );
  checkpoint(
    "sales confirmation, fulfillment, payment, return, refund, and inventory reversal",
  );

  await nav("logistics");
  await page
    .getByRole("button", { name: "Create transfer", exact: true })
    .click();
  await select("sourceId", "WH-1");
  await select("destinationId", "WH-3");
  await fill("carrier", "Browser Logistics");
  await fill("tracking", "QA-TRACK-1");
  await page.locator(".line-product").selectOption(product.id);
  await page.locator("[name=line-qty]").fill("3");
  await save();
  s = await data();
  const transfer = s.shipments[0];
  for (const [label, status] of [
    ["Reserve stock", "reserved"],
    ["Dispatch", "in_transit"],
    ["Receive transfer", "received"],
  ]) {
    await row(transfer.id)
      .getByRole("button", { name: label, exact: true })
      .click();
    await waitState(
      (s) => s.shipments.find((x) => x.id === transfer.id).status === status,
    );
  }
  s = await data();
  assert.equal(
    s.stocks.find((x) => x.productId === product.id && x.warehouseId === "WH-1")
      .onHand,
    15,
  );
  assert.equal(
    s.stocks.find((x) => x.productId === product.id && x.warehouseId === "WH-3")
      .onHand,
    3,
  );
  checkpoint(
    "warehouse transfer: reservation, transit, and destination receipt",
  );

  await nav("warehouse");
  await page
    .getByRole("button", { name: "Adjust inventory", exact: true })
    .click();
  await select("productId", product.id);
  await select("warehouseId", "WH-1");
  await fill("delta", 5);
  await fill("unitCents", "5.00");
  await fill("reason", "Verified QA count");
  await save();
  s = await data();
  assert.equal(
    s.stocks.find((x) => x.productId === product.id && x.warehouseId === "WH-1")
      .onHand,
    20,
  );
  await page.getByRole("tab", { name: /Movement ledger/ }).click();
  await page
    .getByRole("textbox", { name: "Search records", exact: true })
    .fill("Verified QA count");
  assert.match(await page.locator("tbody").innerText(), /Verified QA count/);
  checkpoint("inventory adjustment and searchable movement ledger");

  await nav("sales");
  await page
    .getByRole("button", { name: "New sales order", exact: true })
    .click();
  await fill("customer", "Overstock rejection test");
  await select("warehouseId", "WH-1");
  await page.locator(".line-product").selectOption(product.id);
  await page.locator("[name=line-qty]").fill("9999");
  await save();
  s = await data();
  const rejected = s.sales[0];
  await row(rejected.id)
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await page
    .getByText("Insufficient available stock for QA-NEW-001.", { exact: true })
    .waitFor();
  s = await data();
  assert.equal(s.sales.find((x) => x.id === rejected.id).status, "draft");
  checkpoint(
    "insufficient-stock rejection is displayed and draft state is preserved",
  );

  await nav("finance");
  await page.getByRole("tab", { name: /Expenses/ }).click();
  await page
    .getByRole("button", { name: "Record expense", exact: true })
    .click();
  await select("category", "Software");
  await fill("amountCents", "12.00");
  await fill("description", "Browser QA software expense");
  await save();
  s = await data();
  assert.ok(
    s.expenses.some(
      (x) =>
        x.description === "Browser QA software expense" &&
        x.amountCents === 1200,
    ),
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export", exact: true }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "harbor-expenses.csv");
  await download.saveAs("test-results/expenses.csv");
  checkpoint("finance expense entry and real CSV export");

  await nav("advertising");
  await page
    .getByRole("button", { name: "Record campaign", exact: true })
    .click();
  await fill("name", "Browser Test Campaign");
  await fill("budgetCents", "100.00");
  await fill("spendCents", "20.00");
  await fill("attributedSalesCents", "80.00");
  await save();
  s = await data();
  const campaign = s.campaigns[0];
  await row(campaign.id)
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  s = await waitState(
    (s) => s.campaigns.find((x) => x.id === campaign.id).status === "paused",
  );
  assert.equal(s.campaigns[0].spendCents, 2000);
  checkpoint("manual campaign tracking and pause state");

  await nav("service");
  await page.getByRole("button", { name: "New ticket", exact: true }).click();
  await fill("customer", "Browser Test Buyer");
  await fill("subject", "Browser QA return question");
  await fill("message", "Can you confirm the return?");
  await select("orderId", order.id);
  await save();
  s = await data();
  const ticket = s.tickets[0];
  await row(ticket.id)
    .getByRole("button", { name: "View notes", exact: true })
    .click();
  await page
    .locator("#ticket-note-form [name=note]")
    .fill("Return recorded and stock restored.");
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await page.locator("dialog").waitFor({ state: "detached" });
  s = await data();
  assert.equal(s.tickets.find((x) => x.id === ticket.id).notes.length, 2);
  await row(ticket.id)
    .getByRole("button", { name: "Start", exact: true })
    .click();
  await waitState(
    (s) => s.tickets.find((x) => x.id === ticket.id).status === "in_progress",
  );
  await row(ticket.id)
    .getByRole("button", { name: "Resolve", exact: true })
    .click();
  await waitState(
    (s) => s.tickets.find((x) => x.id === ticket.id).status === "resolved",
  );
  checkpoint("ticket creation, internal note, progress, and resolution");

  await nav("tools");
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await fill("title", "Browser QA task");
  await save();
  s = await data();
  const task = s.tasks[0];
  await row(task.id)
    .getByRole("button", { name: "Mark done", exact: true })
    .click();
  await waitState(
    (s) => s.tasks.find((x) => x.id === task.id).status === "done",
  );
  await page
    .getByRole("tab", { name: "Profit calculator", exact: true })
    .click();
  await page.locator("#calculator-form [name=price]").fill("0");
  assert.match(
    await page.locator("#calculator-result").innerText(),
    /— net margin/,
  );
  assert.doesNotMatch(
    await page.locator("#calculator-result").innerText(),
    /NaN|Infinity/,
  );
  checkpoint("operational tasks and zero-price-safe profit calculator");

  await nav("statistics");
  await page.locator("#report-channel").selectOption("Direct");
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await page.getByText("Report updated.", { exact: true }).waitFor();
  assert.match(
    await page.locator("tbody").innerText(),
    /Browser Workflow Product Updated/,
  );
  const from = "2020-01-01",
    to = "2020-01-02";
  await page.locator("#report-from").fill(from);
  await page.locator("#report-to").fill(to);
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await page.getByText("No records yet.", { exact: true }).waitFor();
  checkpoint("reports recompute by date and channel with proper empty states");

  await nav("settings");
  await page.locator("#settings-form [name=company]").fill("Harbor Browser QA");
  await page
    .getByRole("button", { name: "Save preferences", exact: true })
    .click();
  await waitState((s) => s.settings.company === "Harbor Browser QA");
  await page.reload();
  await page.getByText("Harbor Browser QA", { exact: true }).first().waitFor();
  await page.getByRole("tab", { name: /Users & roles/ }).click();
  await page.getByRole("button", { name: "Add user", exact: true }).click();
  await fill("name", "Browser User");
  await fill("email", "browser@example.com");
  await fill("password", "StrongBrowser!2026");
  await select("role", "operator");
  await save();
  s = await data();
  assert.ok(
    s.users.some(
      (x) => x.email === "browser@example.com" && x.role === "operator",
    ),
  );
  checkpoint("company settings, user creation, and reload persistence");

  await page
    .getByRole("tab", { name: "Role permissions", exact: false })
    .click();
  await page.getByRole("button", { name: "Add role", exact: true }).click();
  await fill("roleName", "Catalog Clerk");
  await fill("roleKey", "catalog_clerk");
  await page
    .getByRole("checkbox", { name: "View Product", exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: "product.create", exact: true })
    .check();
  await page.screenshot({
    path: "test-results/role-editor.png",
    fullPage: true,
  });
  await save();
  s = await data();
  const customRole = s.roles.find((r) => r.roleKey === "catalog_clerk");
  assert.ok(customRole);
  await page.getByRole("tab", { name: /Users & roles/ }).click();
  await page.getByRole("button", { name: "Add user", exact: true }).click();
  await fill("name", "Catalog Clerk");
  await fill("email", "clerk@example.com");
  await fill("password", "ClerkTest!2026");
  await select("role", "catalog_clerk");
  await save();
  s = await data();
  const clerk = s.users.find((u) => u.email === "clerk@example.com");
  assert.ok(clerk);
  const clerkContext = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    }),
    clerkPage = await clerkContext.newPage();
  clerkPage.on("pageerror", (e) => errors.push(e.message));
  await clerkPage.goto(base);
  await clerkPage.locator("[name=email]").fill("clerk@example.com");
  await clerkPage.locator("[name=password]").fill("ClerkTest!2026");
  await clerkPage.getByRole("button", { name: /Open workspace/ }).click();
  await clerkPage.getByRole("heading", { name: "Access restricted" }).waitFor();
  assert.equal(await clerkPage.locator("a.nav-item").count(), 1);
  await clerkPage.locator('a.nav-item[href="#product"]').click();
  await clerkPage
    .getByRole("button", { name: "Add product", exact: true })
    .waitFor();
  assert.equal(
    await clerkPage.getByRole("button", { name: /Edit HB-/ }).count(),
    0,
  );
  await row(clerk.id)
    .getByRole("button", { name: "Assign roles", exact: true })
    .click();
  await page.getByRole("checkbox", { name: "Analyst", exact: true }).check();
  await save();
  await clerkPage.reload();
  await clerkPage.getByRole("heading", { name: "Product catalog" }).waitFor();
  assert.equal(await clerkPage.locator("a.nav-item").count(), 18);
  await row(clerk.id)
    .getByRole("button", { name: "Assign roles", exact: true })
    .click();
  await page.getByRole("checkbox", { name: "Analyst", exact: true }).uncheck();
  await save();
  await page
    .getByRole("tab", { name: "Role permissions", exact: false })
    .click();
  await row(customRole.roleId)
    .getByRole("button", { name: "Edit permissions", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "product.create", exact: true })
    .uncheck();
  await save();
  const revoked = await clerkPage.request.post(base + "/api/action", {
    data: { action: "product.create", payload: {} },
  });
  assert.equal(revoked.status(), 403);
  await clerkPage.reload();
  await clerkPage.getByRole("heading", { name: "Product catalog" }).waitFor();
  assert.equal(
    await clerkPage
      .getByRole("button", { name: "Add product", exact: true })
      .count(),
    0,
  );
  await clerkContext.close();
  checkpoint(
    "custom role editor, user assignment, multi-role union, hidden actions, and live server revocation",
  );

  await page.locator("#global-search").fill("QA-NEW-001");
  await page.locator("#global-search").press("Enter");
  await page
    .getByRole("heading", { name: "Product catalog", exact: true })
    .waitFor();
  assert.equal(await page.locator("tbody tr[data-row-id]").count(), 1);
  checkpoint("global product search routes to a filtered catalog");
  await nav("home");
  {
    await page.locator("#period-select").selectOption("all");
    await page
      .getByRole("heading", { name: "Your operation, at a glance." })
      .waitFor();
  }
  await page.screenshot({
    path: "test-results/dashboard-after-workflows.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page
    .getByRole("heading", { name: "Your operation, at a glance." })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page
    .getByRole("button", { name: "Toggle navigation", exact: true })
    .click();
  await page.locator('a.nav-item[href="#product"]').click();
  await page
    .getByRole("heading", { name: "Product catalog", exact: true })
    .waitFor();
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  checkpoint("mobile layout has no page overflow and navigation works");

  const analystContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const analyst = await analystContext.newPage();
  await analyst.goto(base);
  await analyst.locator("[data-demo=analyst]").click();
  await analyst
    .getByRole("heading", { name: "Your operation, at a glance." })
    .waitFor();
  await analyst.locator('a.nav-item[href="#product"]').click();
  assert.equal(
    await analyst
      .getByRole("button", { name: "Add product", exact: true })
      .count(),
    0,
  );
  const denied = await analyst.request.post(base + "/api/action", {
    data: { action: "product.create", payload: {} },
  });
  assert.equal(denied.status(), 403);
  await analystContext.close();
  checkpoint("analyst has read-only UI and server-enforced write rejection");
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
  checkpoint("no browser JavaScript errors or unexpected failed requests");
  writeFileSync(
    "test-results/e2e-report.json",
    JSON.stringify(
      { passed: true, checks, errors, failedRequests: failures },
      null,
      2,
    ),
  );
  console.log(`\n${checks.length} end-to-end checkpoints passed.`);
} catch (error) {
  await page.screenshot({ path: "test-results/failure.png", fullPage: true });
  writeFileSync(
    "test-results/e2e-report.json",
    JSON.stringify(
      {
        passed: false,
        checks,
        error: error.stack,
        errors,
        failedRequests: failures,
      },
      null,
      2,
    ),
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await app.close();
  rmSync(temp, { recursive: true, force: true });
}
