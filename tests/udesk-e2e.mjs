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
  await page.locator('a.nav-item[href="#service"]').click();
  await page.locator("tbody tr").first().waitFor();
  await page
    .locator("select option[value='10']")
    .waitFor({ state: "attached" });
  assert.equal(await page.locator("select option[value='10']").count(), 1);
  assert.equal(await page.locator("nav a.nav-item").count(), 13);
  console.log("PASS source metadata, navigation and filter deduplication");
  assert.equal(
    await page
      .getByLabel("Sort all authorized tickets", { exact: true })
      .inputValue(),
    "replied_at:desc",
  );
  const sortedResponse = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/tickets" &&
      new URL(r.url()).searchParams.get("sort") === "field_num:desc",
  );
  await page
    .getByLabel("Sort all authorized tickets", { exact: true })
    .selectOption("field_num:desc");
  assert.equal((await (await sortedResponse).json()).sort, "field_num:desc");
  await page.locator("tbody tr .text-button").first().waitFor();
  assert.equal(
    await page.locator("tbody tr .text-button").first().innerText(),
    "#104",
  );
  await page
    .getByLabel("Search current page", { exact: true })
    .fill("OTHER-AGENT-PRIVATE");
  assert.equal(await page.locator("tbody tr").count(), 1);
  await page.getByLabel("Search current page", { exact: true }).fill("");
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
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByRole("status", { name: "Fetching tickets from Udesk…", exact: true })
    .waitFor();
  await page.screenshot({ path: "test-results/ticket-loading-refined.png" });
  releaseList();
  await page.locator("tbody tr").first().waitFor();
  await page.unroute("**/api/tickets?*");
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
  await page.locator("tbody tr .ticket-subject").first().click();
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
  await page.keyboard.press("Escape");
  await preview.waitFor({ state: "detached" });
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
