import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.mjs";
import { startMabangMock } from "./mabang-fixture.mjs";
import { startUdeskMock } from "./udesk-fixture.mjs";
import { selectColumnFilter } from "./column-filter-helpers.mjs";
const temp = mkdtempSync(join(tmpdir(), "catalog-rma-"));
const mabang = await startMabangMock(),
  udesk = await startUdeskMock();
let app, browser;
try {
  app = await startServer(join(temp, "workspace"), {
    ...mabang.env,
    ...udesk.env,
  });
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.base);
  await page.locator("[data-demo=admin]").click();
  await page.locator("#main-content h1").waitFor();
  const post = async (path, data, status = 200) => {
    const r = await page.request.post(app.base + path, { data });
    assert.equal(r.status(), status, await r.text());
    return r.json();
  };
  const run = await post(
    "/api/catalog/sync",
    { fromDate: new Date().toISOString().slice(0, 10) },
    202,
  );
  for (let i = 0; i < 100; i++) {
    const r = await (
      await page.request.get(app.base + "/api/catalog/status")
    ).json();
    if (r.runs[0].status === "failed") throw Error(r.runs[0].error);
    if (r.runs[0].status === "completed") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  let state = await (
    await page.request.get(app.base + "/api/bootstrap")
  ).json();
  assert.equal(state.products.length, 5);
  assert.equal(state.stocks.length, 0);
  assert.equal(state.catalogInventory.length, 5);
  assert(state.products.every((p) => p.reshipRequiresApproval === true));
  // This import was triggered through the test API, outside the integration settings UI.
  await page.reload();
  await page.locator('a.nav-item[href="#product"]').click();
  await page.getByRole("button", { name: /MORPHO-TEST/ }).click();
  const detail = page.getByRole("dialog");
  await detail.getByLabel("SKU type", { exact: true }).selectOption("device");
  await detail
    .getByLabel("Warranty class", { exact: true })
    .selectOption("device");
  await detail
    .getByLabel("Configuration reason", { exact: true })
    .fill("Original unit coverage configured");
  await detail
    .getByRole("button", { name: "Save configuration", exact: true })
    .click();
  await detail.waitFor({ state: "hidden" });
  for (const sku of ["REPLACEMENT-B", "PART-B", "PART-C"]) {
    state = await (await page.request.get(app.base + "/api/bootstrap")).json();
    const p = state.products.find((p) => p.sku === sku);
    await post("/api/catalog/policy", {
      id: p.id,
      expectedRevision: p.policyRevision,
      allowOriginal: true,
      reshipRequiresApproval: sku === "PART-C",
      deviceIds: sku.startsWith("PART") ? [state.products.find(p => p.sku === "MORPHO-TEST").id] : [],
      productType: sku === "PART-C" ? "consumable" : sku === "PART-B" ? "part" : "device",
      warrantyClass: "device",
      reason: "Approved replacement catalog",
    });
  }
  await page.reload();
  await page.locator("#main-content h1").waitFor();
  await page.getByLabel("SKU type", {exact:true}).selectOption("consumable");
  assert.equal(await page.getByRole("button", {name:/PART-B/}).count(),0);
  await page.getByRole("button", {name:/PART-C/}).click();
  assert.equal(await detail.getByLabel("SKU type", {exact:true}).inputValue(),"consumable");
  assert.equal(await detail.getByLabel("Reshipment requires approval", {exact:true}).isChecked(),true);
  const binding = detail.locator(".catalog-device-options label").filter({hasText:"MORPHO-TEST"}).getByRole("checkbox");
  assert.equal(await binding.isChecked(),true);
  await page.screenshot({path:"test-results/catalog-compatibility-detail-en.png"});
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({path:"test-results/catalog-compatibility-detail-mobile.png"});
  await page.setViewportSize({width:1440,height:1000});
  await binding.uncheck(); await binding.check();
  await detail.getByLabel("Configuration reason", {exact:true}).fill("Verified consumable compatibility in product details");
  await detail.getByRole("button", {name:"Save configuration",exact:true}).click();
  await detail.waitFor({state:"hidden"});
  await page.getByLabel("SKU type", {exact:true}).selectOption("");
  await page.locator(".language-switcher select").selectOption("zh-CN");
  await page.screenshot({
    path: "test-results/catalog-products-zh.png",
    fullPage: true,
  });
  await page.locator(".language-switcher select").selectOption("en");
  await page.locator('a.nav-item[href="#warehouse"]').click();
  await page
    .getByRole("heading", { name: "ERP inventory", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Adjust inventory", exact: true })
      .count(),
    0,
  );
  await page.screenshot({
    path: "test-results/catalog-inventory-en.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".language-switcher select").selectOption("zh-CN");
  await page.screenshot({
    path: "test-results/catalog-inventory-mobile-zh.png",
    fullPage: true,
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(".language-switcher select").selectOption("en");
  await post("/api/integrations/udesk/accounts/sync", {});
  await page.locator('a.nav-item[href="#service"]').click();
  await selectColumnFilter(page, "Filter by ticket assignment", "all");
  await page
    .getByRole("row")
    .filter({ hasText: "Device support 中文" })
    .click();
  await page
    .getByRole("button", { name: "Create RMA draft", exact: true })
    .click();
  const d = page.getByRole("dialog");
  const numberInput = d.getByLabel("Platform order number", { exact: true });
  assert.equal(await numberInput.inputValue(), "");
  const originalNumber = "ORDER-101";
  const lookupButton = d.getByRole("button", { name: "Look up original order", exact: true });
  const historyDate = d.getByLabel("Payment date (for historical lookup)", { exact: true });
  await numberInput.fill("UNINDEXED-OLD-ORDER");
  await lookupButton.click();
  await historyDate.waitFor();
  await historyDate.fill("2020-01-01");
  await d.getByLabel("Shop (optional)", { exact: true }).fill("Old shop");
  await numberInput.fill(originalNumber);
  assert.equal(await historyDate.count(), 0, "Changing order number hides old history assistance");
  let nextLookup;
  const captureLookup = request => {
    if (request.url().endsWith("/api/original-orders/lookup")) nextLookup = request.postDataJSON();
  };
  page.on("request", captureLookup);
  await lookupButton.click();
  await d.getByRole("radio").waitFor();
  page.off("request", captureLookup);
  assert.equal(nextLookup.paidDate, "", "Do not carry a previous order's date");
  assert.equal(nextLookup.shop, "", "Do not carry a previous order's shop");
  assert.equal(await historyDate.count(), 0);
  await page.route("**/api/original-orders/lookup", route => route.fulfill({
    status: 422,
    json: { code: "history_identifier_required", error: "Historical lookup needs payment date" },
  }), { times: 1 });
  await lookupButton.click();
  await historyDate.waitFor();
  await lookupButton.click();
  await d.getByRole("radio").waitFor();
  assert.equal(await historyDate.count(), 0, "Successful retry hides historical assistance even without editing the number");
  await d.getByRole("radio").check();
  await d
    .getByRole("button", {
      name: "Confirm original order and item",
      exact: true,
    })
    .click();
  await d.getByLabel("Proposed solution", { exact: true }).waitFor();
  assert.equal(await d.getByRole("button", { name: "Next: solution and warranty", exact: true }).count(), 0);
  await d
    .getByLabel("Root cause", { exact: true })
    .selectOption("device_fault");
  await d
    .getByLabel("Proposed solution", { exact: true })
    .selectOption("parts");
  await d
    .getByLabel("Solution reason", { exact: true })
    .fill("Two parts failed");
  await d.getByLabel("Search reshipment SKU", {exact:true}).fill("PART-B");
  assert.equal(await d.getByLabel("Reship SKU 1", {exact:true}).locator("option").count(),2);
  await d
    .getByLabel("Reship SKU 1", { exact: true })
    .selectOption(state.products.find((p) => p.sku === "PART-B").id);
  await d
    .getByRole("button", { name: "Add reshipment item", exact: true })
    .click();
  state = await (await page.request.get(app.base + "/api/bootstrap")).json();
  await d.getByLabel("Search reshipment SKU", {exact:true}).fill(state.products.find(p=>p.sku === "PART-C").name);
  await d
    .getByLabel("Reship SKU 2", { exact: true })
    .selectOption(state.products.find((p) => p.sku === "PART-C").id);
  await d.getByLabel("Quantity 2", { exact: true }).fill("2");
  const delivered = new Date();
  delivered.setDate(delivered.getDate() - 30);
  await d
    .getByLabel("Delivery date", { exact: true })
    .fill(delivered.toISOString().slice(0, 10));
  await d
    .getByLabel("Delivery evidence reference", { exact: true })
    .fill("Receipt verified");
  await page.waitForFunction(
    () =>
      document.querySelector("dialog[open] button[type=submit]")?.disabled ===
      false,
  );
  await d
    .locator(".modal-body")
    .evaluate((e) => (e.scrollTop = e.scrollHeight));
  await page.screenshot({ path: "test-results/catalog-reship-lines-en.png" });
  await d.getByRole("button", { name: "Create RMA", exact: true }).click();
  await d.waitFor({ state: "hidden" });
  state = await (await page.request.get(app.base + "/api/bootstrap")).json();
  const rma = state.rmas.find((r) => r.solutionReason === "Two parts failed");
  assert(rma);
  assert.equal(rma.originalOrder.order.items[0].sku, "MORPHO-TEST");
  assert.deepEqual(
    rma.reshipItems.map((l) => [l.sku, l.qty]),
    [
      ["PART-B", 1],
      ["PART-C", 2],
    ],
  );
  const tasks = state.rmaTasks.filter((t) => t.rmaId === rma.id);
  assert.equal(tasks.length, 2);
  assert.equal(tasks.find(t => t.productId === state.products.find(p=>p.sku === "PART-C").id).approval,"pending");
  assert.equal(tasks.find(t => t.productId === state.products.find(p=>p.sku === "PART-B").id).approval,"not_required");
  await page.locator('a.nav-item[href="#rma"]').click();
  await page.getByRole("button", { name: rma.id, exact: true }).click();
  await page
    .getByRole("heading", { name: "Reshipment details", exact: true })
    .waitFor();
  await page.screenshot({ path: "test-results/catalog-rma-detail-en.png" });
  assert(
    mabang.calls.every((c) =>
      [
        "stock-do-search-sku-list-new",
        "stock-get-stock-quantity",
        "order-get-order-list-new",
        "get-history-order-list",
      ].includes(c.api),
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS read-only catalog import, demo cleanup, admin policy UI, inventory, bilingual/mobile, real-order confirmation and two-SKU reship RMA",
  );
} finally {
  await browser?.close();
  await app?.close();
  await mabang.close();
  await udesk.close();
  rmSync(temp, { recursive: true, force: true });
}
