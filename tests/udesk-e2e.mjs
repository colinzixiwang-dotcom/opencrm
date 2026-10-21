import { selectColumnFilter } from "./column-filter-helpers.mjs";
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
  app = await startServer(join(temp, "test-workspace"), mock.env);
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
  await page.route("**/api/tickets?*", (route) =>
    route.fulfill({
      json: {
        items: [],
        initializing: true,
        fetchedAt: "",
        totalCount: 0,
        totalPages: 1,
        nextCursor: "",
        syncIntervalSeconds: 60,
      },
    }),
  );
  await page.locator('a.nav-item[href="#service"]').click();
  await page
    .getByRole("status", { name: "Ticket data is initializing", exact: true })
    .waitFor();
  assert.equal(await page.locator(".ticket-result-count").count(), 0);
  await page.screenshot({ path: "test-results/ticket-index-initializing.png" });
  await page.unroute("**/api/tickets?*");
  await page.locator('a.nav-item[href="#home"]').click();
  await page.locator('a.nav-item[href="#service"]').click();
  await page.locator("tbody tr").first().waitFor();
  assert.equal(
    await page
      .getByLabel("Filter by ticket assignment", { exact: true })
      .getAttribute("data-value"),
    "all",
  );
  assert.equal(
    await page
      .getByLabel("Sort all authorized tickets", { exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page.getByLabel("Udesk filter", { exact: true }).count(),
    0,
  );
  await selectColumnFilter(page, "Filter by ticket assignment", "mine");
  const sortedResponse = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/tickets" &&
      new URL(r.url()).searchParams.get("assignment") === "all",
  );
  await selectColumnFilter(page, "Filter by ticket assignment", "all");
  assert.equal((await (await sortedResponse).json()).sort, "repliedAt:desc");
  await page.locator("tbody .ticket-subject").first().waitFor();
  assert.equal(await page.locator("nav a.nav-item").count(), 13);
  console.log("PASS shared scope selector and fixed reply-time order");
  await page
    .getByLabel("Search ticket content", { exact: true })
    .fill("Second own ticket");
  await page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/tickets" &&
      new URL(r.url()).searchParams.get("q") === "Second own ticket",
  );
  await page.locator("tbody tr").first().waitFor();
  assert.equal(await page.locator("tbody tr").count(), 1);
  const cleared = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/tickets" &&
      !new URL(r.url()).searchParams.get("q"),
  );
  await page.getByLabel("Search ticket content", { exact: true }).fill("");
  await cleared;
  await page.locator("tbody tr").first().waitFor();
  await page.screenshot({
    path: "test-results/ticket-queue-en.png",
    fullPage: true,
  });
  assert.ok(
    (
      await page
        .getByRole("navigation", { name: "Ticket pagination", exact: true })
        .innerText()
    ).includes("1 pages total"),
  );
  let releaseList;
  const listGate = new Promise((resolve) => {
    releaseList = resolve;
  });
  await page.route("**/api/tickets?*", async (route) => {
    await listGate;
    await route.continue();
  });
  await selectColumnFilter(page, "Filter by ticket assignment", "mine");
  await page
    .getByRole("status", { name: "Loading tickets…", exact: true })
    .waitFor();
  await page.screenshot({ path: "test-results/ticket-loading-refined.png" });
  releaseList();
  await page.locator("tbody tr").first().waitFor();
  await page.unroute("**/api/tickets?*");
  const before = mock.state.requests.filter((p) => p === "tickets").length;
  assert.equal(
    await page.getByRole("button", { name: "Refresh", exact: true }).count(),
    0,
  );
  const queried = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/tickets",
  );
  await selectColumnFilter(page, "Filter by ticket assignment", "all");
  await queried;
  await page.locator("tbody tr").first().waitFor();
  assert.equal(
    mock.state.requests.filter((p) => p === "tickets").length,
    before,
  );
  const filtered = await page.request.get(
    app.base + "/api/tickets?filterId=11",
  );
  assert.equal(filtered.status(), 200);
  assert.equal((await filtered.json()).totalCount, 1);
  await page
    .locator('tbody tr .ticket-subject[href="#service?ticket=101"]')
    .click();
  assert.ok(page.url().endsWith("#service?ticket=101"));
  await page
    .getByRole("heading", { name: "Order and product", exact: true })
    .waitFor();
  const extras = page
    .locator("details.ticket-field-disclosure")
    .filter({ has: page.locator("summary", { hasText: "Other fields" }) });
  await extras.locator("summary").click();
  assert.equal(await extras.locator(".ticket-fields > div").count(), 4);
  assert.equal(
    await page
      .locator(".ticket-detail-header")
      .getByText("Agent One", { exact: true })
      .count(),
    0,
  );
  assert.equal(await page.locator(".ticket-fields dt small").count(), 0);
  assert.equal(
    await page.getByText("assignee_name", { exact: true }).count(),
    0,
  );
  assert.equal(await page.getByText("Custom 3", { exact: true }).count(), 0);
  await page.reload();
  await page.locator(".ticket-fields").first().waitFor();
  await extras.locator("summary").click();
  await page
    .locator(".ticket-fields dd")
    .getByText("No", { exact: true })
    .waitFor();
  await page
    .locator(".ticket-fields dd")
    .getByText("0", { exact: true })
    .waitFor();
  await page.getByText("Only v2 field", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("Custom fields v2", { exact: true }).count(),
    0,
  );
  await page.getByText("Hardware fault", { exact: true }).waitFor();
  await page.getByText("Internal case context", { exact: true }).waitFor();
  const body = await page
    .locator(".ticket-conversation .conversation-body")
    .first()
    .innerText();
  assert.ok(!/\n{3,}/.test(body));
  assert.ok(body.includes("Second paragraph."));
  assert.equal(
    await page
      .locator(".ticket-conversation .conversation-body")
      .first()
      .evaluate((el) => getComputedStyle(el).textAlign),
    "left",
  );
  const pagination = page.getByRole("navigation", {
    name: "Conversation pagination",
    exact: true,
  });
  assert.ok((await pagination.innerText()).includes("2 pages total"));
  await pagination.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByText("Second conversation page", { exact: true }).waitFor();
  assert.equal(
    await pagination
      .getByRole("button", { name: "Next", exact: true })
      .isDisabled(),
    true,
  );
  await pagination
    .getByRole("button", { name: "Previous", exact: true })
    .click();
  await page.getByText("Internal case context", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Preview device-photo.svg", exact: true })
    .click();
  const preview = page.getByRole("dialog", {
    name: "Attachment preview",
    exact: true,
  });
  await preview.waitFor();
  await preview.locator("img").evaluate((img) => img.decode());
  assert.ok(
    (await preview.locator("img").getAttribute("src")).startsWith(
      "/api/tickets/101/attachment?ref=",
    ),
  );
  await page.screenshot({ path: "test-results/ticket-attachment-preview.png" });
  const previewPager = preview.getByRole("navigation", {
    name: "Attachment preview navigation",
    exact: true,
  });
  assert.ok((await previewPager.innerText()).includes("1"));
  assert.equal(
    await previewPager
      .getByRole("button", { name: "Previous attachment", exact: true })
      .isDisabled(),
    true,
  );
  await page.keyboard.press("ArrowRight");
  await preview
    .getByText(
      "Preview unavailable. Open the original attachment to view it.",
      { exact: true },
    )
    .waitFor();
  await previewPager
    .getByRole("button", { name: "Previous attachment", exact: true })
    .click();
  await preview.locator("img").evaluate((img) => img.decode());
  await page.keyboard.press("Escape");
  await preview.waitFor({ state: "detached" });
  const gallery = page.locator(".ticket-sidebar .attachment-gallery").first();
  assert.equal(await gallery.locator(".attachment-card").count(), 4);
  assert.equal(
    await gallery
      .getByRole("navigation", { name: "Attachment pagination", exact: true })
      .count(),
    0,
  );
  for (const card of await gallery.locator(".attachment-card").all())
    assert.equal(await card.isVisible(), true);
  await page
    .getByRole("button", { name: "Preview missing.jpg", exact: true })
    .click();
  await page
    .getByText(
      "Preview unavailable. Open the original attachment to view it.",
      { exact: true },
    )
    .waitFor();
  await page
    .getByRole("button", { name: "Close preview", exact: true })
    .click();

  const pdfResponse = page.waitForResponse(
    (r) => r.url().includes("/attachment?") && r.url().includes("manual.pdf"),
  );
  await page
    .getByRole("button", { name: "Preview manual.pdf", exact: true })
    .click();
  assert.equal((await pdfResponse).status(), 200);
  await preview.locator('canvas[data-rendered="true"]').waitFor();
  assert.match(await previewPager.innerText(), /3\s*\/\s*4/);
  assert.ok(
    await preview.locator("canvas").evaluate((canvas) => {
      const bytes = canvas
        .getContext("2d")
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      for (let i = 0; i < bytes.length; i += 4) {
        if (bytes[i] < 100 && bytes[i + 3] > 0) dark++;
      }
      return dark > 100;
    }),
  );
  await page.screenshot({ path: "test-results/ticket-pdf-preview.png" });
  await previewPager
    .getByRole("button", { name: "Next attachment", exact: true })
    .click();
  const emailDownload = preview.getByRole("link", {
    name: "Download original email",
    exact: true,
  });
  await emailDownload.waitFor();
  assert.ok((await emailDownload.getAttribute("href")).includes("download=1"));
  assert.equal(
    await previewPager
      .getByRole("button", { name: "Next attachment", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByRole("button", { name: "Close preview", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "Preview unsafe.html", exact: true })
      .count(),
    0,
  );
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
  assert.match(await d.locator(".rma-steps").innerText(), /#101/);
  assert.equal(
    await d.getByLabel("Platform order number", { exact: true }).inputValue(),
    "ORDER-101",
  );
  assert.equal(await d.getByLabel("Description", { exact: true }).count(), 0);
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
  assert(saved.payload.description.includes("Device stops printing"));
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
  assert.equal(created.status(), 422, await created.text());
  assert.match(
    (await created.json()).error,
    /only whole-unit or parts reshipment/,
  );
  console.log(
    "PASS custom fields/options, inert HTML, conversation and saved RMA draft",
  );
  await page.screenshot({
    path: "test-results/ticket-detail-en.png",
    fullPage: true,
  });
  await page.getByLabel("Language", { exact: true }).selectOption("zh-CN");
  await page
    .getByRole("heading", { name: "订单与产品", exact: true })
    .waitFor();
  await page.screenshot({
    path: "test-results/ticket-detail-zh.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: "test-results/ticket-detail-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  // All agents share Morpho rows; non-Morpho tickets stay excluded on every path.
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
    "/api/tickets/102/attachment?ref=https%3A%2F%2Fexample.com%2Fphoto.jpg",
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
  // Source outage does not turn PG pagination into a failed source request;
  // details continue to require live authorization.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "返回工单列表", exact: true }).click();
  await page.locator("tbody tr").first().waitFor();
  mock.state.fail = true;
  const listDuringOutage = await page.request.get(app.base + "/api/tickets");
  assert.equal(listDuringOutage.status(), 200);
  assert.equal((await listDuringOutage.json()).totalCount, 3);
  const deniedDetail = await page.request.get(app.base + "/api/tickets/101");
  assert.equal(deniedDetail.status(), 503);
  assert.equal((await deniedDetail.json()).code, "source_unavailable");
  assert.deepEqual(errors, []);
  console.log(
    "PASS Udesk background index, PG queries, source filters, all custom fields, safe content, read-only conversation, persistent RMA draft, bilingual/mobile display, account mapping, row authorization and live authorization during outage",
  );
} finally {
  await browser?.close();
  await app?.close();
  await mock.close();
  rmSync(temp, { recursive: true, force: true });
}
