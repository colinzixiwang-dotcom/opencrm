import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.mjs";
import { startUdeskMock } from "./udesk-fixture.mjs";
import { startMabangMock } from "./mabang-fixture.mjs";
const temp = mkdtempSync(join(tmpdir(), "harbor-mabang-"));
const udesk = await startUdeskMock(),
  mabang = await startMabangMock();
let app, browser;
try {
  app = await startServer(join(temp, "workspace"), {
    ...udesk.env,
    ...mabang.env,
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(30000);
  await page.goto(app.base);
  await page.locator("[data-demo=admin]").click();
  await page.locator("#main-content h1").waitFor();
  const action = async (action, payload) => {
    const r = await page.request.post(app.base + "/api/action", {
      data: { action, payload },
    });
    assert.equal(r.status(), 200, await r.text());
    return (await r.json()).result;
  };
  const device = await action("product.create", {
    sku: "MORPHO-TEST",
    name: "Morpho device",
    category: "Support",
    productType: "device",
    costCents: 1000,
    priceCents: 15900,
    reorderPoint: 2,
    leadDays: 7,
  });
  const part = await action("product.create", {
    sku: "MORPHO-PART",
    name: "Morpho spare part",
    category: "Support",
    productType: "part",
    partKind: "accessory",
    deviceIds: [device.id],
    costCents: 100,
    priceCents: 1000,
    reorderPoint: 2,
    leadDays: 7,
  });
  await page.reload();
  await page.locator("#main-content h1").waitFor();
  const synced = await page.request.post(
    app.base + "/api/integrations/udesk/accounts/sync",
    { data: {} },
  );
  assert.equal(synced.status(), 200, await synced.text());
  await page.locator('a.nav-item[href="#service"]').click();
  await page
    .getByRole("row")
    .filter({ hasText: "Device support 中文" })
    .click();
  await page
    .getByRole("button", { name: "Create RMA draft", exact: true })
    .click();
  const d = page.getByRole("dialog");
  assert.equal(
    await d.getByLabel("Platform order number", { exact: true }).inputValue(),
    "ORDER-101",
  );
  await d
    .getByRole("button", { name: "Look up original order", exact: true })
    .click();
  await d.getByRole("radio").check();
  await d
    .getByRole("button", {
      name: "Confirm original order and item",
      exact: true,
    })
    .click();
  await d.getByText("Original order confirmed", { exact: true }).waitFor();
  await d.locator(".modal-body").evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({
    path: "test-results/mabang-original-order-en.png",
    fullPage: true,
  });
  await d.locator(".language-switcher select").selectOption("zh-CN");
  await page.screenshot({
    path: "test-results/mabang-original-order-zh.png",
    fullPage: true,
  });
  await d.locator(".language-switcher select").selectOption("en");
  assert.equal(
    await d.getByLabel("Purchased platform", { exact: true }).inputValue(),
    "Amazon",
  );
  const options = await d
    .getByLabel("Proposed solution", { exact: true })
    .locator("option")
    .allTextContents();
  assert.equal(options.length, 3);
  assert(!options.includes("Return and replace"));
  await d
    .getByLabel("Root cause", { exact: true })
    .selectOption("device_fault");
  await d
    .getByLabel("Proposed solution", { exact: true })
    .selectOption("reship_device");
  await d
    .getByLabel("Solution reason", { exact: true })
    .fill("Confirmed original device motor failure");
  const delivered = new Date();
  delivered.setUTCDate(delivered.getUTCDate() - 30);
  const date = delivered.toISOString().slice(0, 10);
  await d.getByLabel("Delivery date", { exact: true }).fill(date);
  await d
    .getByLabel("Delivery evidence reference", { exact: true })
    .fill("Customer delivery receipt reviewed by Administrator");
  await d.getByRole("button", { name: "Create RMA", exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('dialog[open] button[type="submit"]')?.disabled ===
      false,
  );
  await page.screenshot({
    path: "test-results/mabang-rma-confirmed-en.png",
    fullPage: true,
  });
  await d.getByRole("button", { name: "Save draft", exact: true }).click();
  await d.getByText("Draft saved", { exact: true }).waitFor();
  const drafts = await (
    await page.request.get(app.base + "/api/intake-drafts")
  ).json();
  const draftId = drafts.items[0].draft.id;
  const saved = await (
    await page.request.get(app.base + "/api/intake-drafts/" + draftId)
  ).json();
  const base = {
    ...saved.payload,
    taskInputs: { device: { qty: 1, productId: device.id } },
    expectedConfigRevision: undefined,
  };
  for (const patch of [
    { orderNumber: "OTHER" },
    { orderConfirmationId: "forged" },
    { solutionId: "replacement" },
    { solutionReason: "" },
    {
      warrantyEvidence: {
        deliveredAt: "2020-01-01",
        evidenceReference: "Receipt",
      },
    },
    {
      solutionId: "parts",
      taskInputs: { parts: { productId: part.id, qty: 0 } },
    },
  ]) {
    const r = await page.request.post(app.base + "/api/action", {
      data: { action: "rma.create", payload: { ...base, ...patch } },
    });
    assert(r.status() >= 400 && r.status() < 500, await r.text());
  }
  await d.getByRole("button", { name: "Create RMA", exact: true }).click();
  await d.waitFor({ state: "hidden" });
  const state = await (
    await page.request.get(app.base + "/api/bootstrap")
  ).json();
  const created = state.rmas.find((r) => r.intakeDraftId === draftId);
  assert(created);
  assert.equal(created.originalOrder.order.sourceNumber, "ERP-ORIGINAL");
  assert.equal(created.eligibilityAssessment.status, "covered");
  assert.equal(
    created.solutionReason,
    "Confirmed original device motor failure",
  );
  assert.equal(state.rmaTasks.filter((t) => t.rmaId === created.id).length, 1);
  assert.equal(
    state.rmaTasks.find((t) => t.rmaId === created.id).typeId,
    "send_device",
  );
  await page.locator('a.nav-item[href="#rma"]').click();
  await page.getByRole("button", { name: created.id, exact: true }).click();
  await page.getByText("Original order snapshot", { exact: true }).waitFor();
  await page.screenshot({
    path: "test-results/mabang-rma-detail-en.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const newDraft = await (
    await page.request.post(app.base + "/api/tickets/101/drafts", {
      data: { description: "Parts needed" },
    })
  ).json();
  const nextId = newDraft.draft.id;
  const query = async (orderNumber, extra = {}) =>
    page.request.post(app.base + "/api/original-orders/lookup", {
      data: { draftId: nextId, orderNumber, ...extra },
    });
  let r = await query("COLORBOX");
  assert.equal(r.status(), 200, await r.text());
  let candidate = (await r.json()).items[0];
  assert.equal(candidate.items[0].matched, false);
  r = await page.request.post(app.base + "/api/original-orders/confirm", {
    data: { draftId: nextId, candidateId: candidate.id, itemId: "item-1" },
  });
  assert.equal(r.status(), 422);
  r = await query("HISTORY-1");
  assert.equal(r.status(), 422);
  assert.equal((await r.json()).code, "history_identifier_required");
  r = await query("HISTORY-1", { paidDate: "2025-01-01" });
  assert.equal(r.status(), 200, await r.text());
  candidate = (await r.json()).items[0];
  assert.equal(candidate.order.querySource, "history");
  r = await page.request.post(app.base + "/api/original-orders/confirm", {
    data: { draftId: nextId, candidateId: candidate.id, itemId: "item-1" },
  });
  assert.equal(r.status(), 200, await r.text());
  const confirmation = await r.json();
  await action("rma.create", {
    ...newDraft.payload,
    orderNumber: "HISTORY-1",
    platform: "Amazon",
    productId: device.id,
    rootCauseId: "device_fault",
    solutionId: "parts",
    solutionReason: "Replace failed accessory",
    orderConfirmationId: confirmation.confirmationId,
    warrantyEvidence: {
      deliveredAt: date,
      evidenceReference: "Verified receipt",
    },
    taskInputs: { parts: { productId: part.id, qty: 2 } },
  });
  assert(
    mabang.calls.every((c) =>
      ["order-get-order-list-new", "get-history-order-list"].includes(c.api),
    ),
  );
  console.log(
    "PASS Mabang signed lookup, history fallback, ColorBox block, confirmation, warranty/reason/parts gates, ticket-linked whole-device and parts RMAs, immutable detail UI",
  );
} finally {
  await browser?.close();
  await app?.close();
  await udesk.close();
  await mabang.close();
  rmSync(temp, { recursive: true, force: true });
}
