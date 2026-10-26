import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "./server.mjs";
import { startMabangMock } from "./mabang-fixture.mjs";
const temp = mkdtempSync(join(tmpdir(), "order-center-"));
const mock = await startMabangMock();
let app, b;
try {
  app = await startServer(join(temp, "workspace"), mock.env);
  b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  p.setDefaultTimeout(30000);
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.clock.install();
  await p.goto(app.base);
  await p.locator("[data-demo=admin]").click();
  await p.locator("#main-content h1").waitFor();
  const start = await p.request.post(app.base + "/api/orders/backfill", {
    data: { fromDate: "2025-01-01", toDate: "2025-01-01" },
  });
  assert.equal(start.status(), 202, await start.text());
  for (let i = 0; i < 100; i++) {
    const v = await (
      await p.request.get(app.base + "/api/orders/status")
    ).json();
    if (v.jobs[0].status === "failed") throw Error(v.jobs[0].error);
    if (v.jobs[0].status === "completed") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await p.locator('a.nav-item[href="#orders"]').click();
  await p.getByRole("heading", { name: "Order center", exact: true }).waitFor();
  await p.locator(".order-number-link").waitFor();
  await p.getByText("Last successful order sync", { exact: false }).waitFor();
  assert.equal(await p.getByRole("button", { name: "Reload list", exact: true }).count(), 0);
  const updated = p.waitForResponse((r) => r.url().includes("/api/orders?page="));
  await p.route("**/api/orders/status", async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    assert(value.lastSuccessfulSyncAt);
    assert.equal(value.continuousSyncEnabled, false);
    await route.fulfill({ json: { ...value, indexRevision: "changed-projection" } });
  });
  await p.clock.fastForward(10000);
  await updated;
  await p.unroute("**/api/orders/status");
  await p.locator(".order-number-link").waitFor();
  await p
    .getByLabel("Platform order number", { exact: true })
    .fill("HISTORY-1");
  await p.getByRole("button", { name: "Search order", exact: true }).click();
  await p.locator(".order-number-link").waitFor();
  await p.locator(".order-number-link").click();
  await p.getByRole("dialog").locator(".original-order-summary").waitFor();
  const summary = p.getByRole("dialog").locator(".detail-grid");
  await summary.getByText("Shopify", { exact: true }).waitFor();
  await summary.getByText("Shipped", { exact: true }).waitFor();
  for (const value of [
    "Test Buyer",
    "fixture@example.com",
    "+1 202 555 0100 / +1 202 555 0101",
    "Test City",
  ])
    await summary.getByText(value, { exact: true }).waitFor();
  assert.equal(await summary.getByText("Fetched at", { exact: true }).count(), 0);
  assert.equal(
    await p
      .getByRole("dialog")
      .getByText("100 Test Road", { exact: true })
      .isVisible(),
    false,
  );
  await p.locator(".order-source-fields>summary").click();
  await p.getByText("100 Test Road", { exact: true }).waitFor();
  await p.getByText("<script>unsafe</script>", { exact: true }).waitFor();
  assert.equal(await p.locator(".order-source-fields script").count(), 0);
  await p.screenshot({
    path: "test-results/order-center-fixture-detail-en.png",
  });
  await p
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await p.locator(".language-switcher select").selectOption("zh-CN");
  await p.setViewportSize({ width: 390, height: 844 });
  await p.screenshot({
    path: "test-results/order-center-fixture-mobile-zh.png",
  });
  assert(
    await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  const r = await p.request.get(
    app.base + "/api/orders/search?number=HISTORY-1",
  );
  const v = await r.json();
  assert.equal(v.items.length, 1);
  assert(!JSON.stringify(v).includes("100 Test Road"));
  for (const value of [
    "Test Buyer",
    "fixture@example.com",
    "+1 202 555 0100",
    "Test City",
  ])
    assert(!JSON.stringify(v).includes(value));
  assert(
    mock.calls.some(
      (c) =>
        c.api === "get-history-order-list" &&
        c.data.platformOrderId === "ERP-HISTORY",
    ),
  );
  assert(
    mock.calls.every((c) =>
      ["order-get-order-list-new", "get-history-order-list"].includes(c.api),
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS durable historical backfill, exact local search, live detail, full inert source fields, bilingual/mobile and read-only upstream",
  );
} finally {
  await b?.close();
  await app?.close();
  await mock.close();
  rmSync(temp, { recursive: true, force: true });
}
