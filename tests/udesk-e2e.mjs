import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.mjs";
import { startUdeskMock } from "./udesk-fixture.mjs";
const temp = mkdtempSync(join(tmpdir(), "harbor-udesk-"));
const mock = await startUdeskMock();
let app, browser;
try {
  app = await startServer(join(temp, "test.sqlite"), mock.env);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_EXECUTABLE
      ? { executablePath: process.env.CHROME_EXECUTABLE }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.base);
  await page.locator("[data-demo=admin]").click();
  await page.locator("#main-content h1").waitFor();
  let r = await page.request.post(
    app.base + "/api/integrations/udesk/accounts/sync",
    { data: { resetPasswords: false } },
  );
  assert.equal(r.status(), 200, await r.text());
  assert.equal((await r.json()).accounts, 3);
  await page.locator('a.nav-item[href="#service"]').click();
  await page.locator("tbody tr").first().waitFor();
  await page
    .locator("select option[value='10']")
    .waitFor({ state: "attached" });
  assert.equal(await page.locator("select option[value='10']").count(), 1);
  assert.equal(await page.locator("nav a.nav-item").count(), 13);
  console.log("PASS source metadata, navigation and filter deduplication");
  const before = mock.state.requests.filter((p) => p === "tickets").length;
  const refreshed = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/tickets",
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await refreshed;
  await page.locator("tbody tr").first().waitFor();
  assert.ok(mock.state.requests.filter((p) => p === "tickets").length > before);
  const filtered = page.waitForResponse((r) => r.url().includes("filterId=11"));
  await page.getByLabel("Udesk filter", { exact: true }).selectOption("11");
  await filtered;
  await page.locator("tbody tr").first().waitFor();
  assert.equal(await page.locator("tbody tr").count(), 1);
  assert.ok(mock.state.filterIds.includes("11"));
  await page.locator("tbody tr .text-button").first().click();
  await page
    .getByRole("heading", { name: "Custom fields", exact: true })
    .waitFor();
  assert.equal(
    await page.locator(".ticket-fields").nth(1).locator(":scope > div").count(),
    31,
  );
  await page.getByText("Hardware fault", { exact: true }).waitFor();
  await page.getByText("Internal case context", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => window.sourceScriptExecuted),
    undefined,
  );
  assert.equal(
    await page.getByRole("button", { name: "Resolve", exact: true }).count(),
    0,
  );
  assert.ok(
    (
      await page
        .getByRole("link", { name: "Open in Udesk", exact: true })
        .getAttribute("href")
    ).endsWith("/entry/ticket/show/101"),
  );
  await page
    .getByRole("button", { name: "Create RMA draft", exact: true })
    .click();
  const d = page.getByRole("dialog");
  await d.waitFor();
  assert.equal(
    await d.getByLabel("Support ticket number", { exact: true }).inputValue(),
    "#101",
  );
  assert.equal(
    await d.getByLabel("Order number", { exact: true }).inputValue(),
    "ORDER-101",
  );
  await d
    .getByLabel("Description", { exact: true })
    .fill("Saved draft explanation");
  await d.getByRole("button", { name: "Save draft", exact: true }).click();
  await d.getByText("Draft saved", { exact: true }).waitFor();
  await d.getByRole("button", { name: "Cancel", exact: true }).click();
  const drafts = await (
    await page.request.get(app.base + "/api/intake-drafts")
  ).json();
  assert.equal(drafts.items.length, 1);
  const saved = await (
    await page.request.get(
      app.base + "/api/intake-drafts/" + drafts.items[0].draft.id,
    )
  ).json();
  assert.equal(saved.payload.description, "Saved draft explanation");
  const submitPayload = {
    ...saved.payload,
    platform: "Amazon",
    productId: "PRD-1",
    rootCauseId: "device_fault",
    solutionId: "goodwill",
    taskInputs: { gift: { amountCents: 1000 } },
  };
  const submission = {
    data: { action: "rma.create", payload: submitPayload },
    headers: { "Idempotency-Key": "source-draft-submit" },
  };
  const created = await page.request.post(app.base + "/api/action", submission);
  assert.equal(created.status(), 200, await created.text());
  const rma = (await created.json()).result;
  assert.equal(rma.ticketReference.snapshotId, saved.payload.ticketSnapshotId);
  const replay = await page.request.post(app.base + "/api/action", submission);
  assert.equal(replay.status(), 200, await replay.text());
  assert.equal((await replay.json()).replayed, true);
  console.log(
    "PASS custom fields/options, inert HTML, conversation and saved RMA draft",
  );
  await page.getByLabel("Language", { exact: true }).selectOption("zh-CN");
  await page
    .getByRole("heading", { name: "自定义字段", exact: true })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  // Verify the imported agent has only their own rows on every HTTP entry point.
  const agent = await browser.newContext();
  const ap = await agent.newPage();
  await ap.goto(app.base);
  await ap.locator("[name=email]").fill("one@mock.local");
  await ap.locator("[name=password]").fill("HarborDemo!2026");
  await ap.locator("#login-form button").click();
  await ap.locator("#main-content h1").waitFor();
  for (const path of [
    "/api/tickets",
    "/api/export/tickets",
    "/api/bootstrap",
  ]) {
    const response = await ap.request.get(app.base + path);
    assert.equal(response.status(), 200);
    assert.ok(!(await response.text()).includes("OTHER-AGENT-PRIVATE"));
  }
  for (const path of [
    "/api/tickets/102",
    "/api/tickets/102/replies",
    "/api/tickets/lookup?number=%23102",
  ])
    assert.equal((await ap.request.get(app.base + path)).status(), 404);
  assert.equal(
    (
      await ap.request.post(app.base + "/api/tickets/102/drafts", { data: {} })
    ).status(),
    404,
  );
  assert.equal(
    (
      await ap.request.post(
        app.base + "/api/integrations/udesk/accounts/configure",
        { data: {} },
      )
    ).status(),
    403,
  );
  await agent.close();
  console.log(
    "PASS imported account login and authorization on list/detail/replies/export/lookup/drafts",
  );
  // An upstream outage must be visible, not a cache presented as current.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "返回工单列表", exact: true }).click();
  await page.locator("tbody tr").first().waitFor();
  mock.state.fail = true;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByText("Udesk 刷新失败", { exact: true }).waitFor();
  assert.equal(await page.locator("tbody tr").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS Udesk live refresh, source filters, all custom fields, safe content, read-only conversation, persistent RMA draft, bilingual/mobile display, account mapping, row authorization and visible outage",
  );
} finally {
  await browser?.close();
  await app?.close();
  await mock.close();
  rmSync(temp, { recursive: true, force: true });
}
