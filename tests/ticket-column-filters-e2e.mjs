import { selectColumnFilter } from "./column-filter-helpers.mjs";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.mjs";
import { startUdeskMock } from "./udesk-fixture.mjs";
const temp = mkdtempSync(join(tmpdir(), "harbor-column-filters-"));
const mock = await startUdeskMock();
const original = mock.state.tickets[0];
mock.state.tickets.splice(
  0,
  mock.state.tickets.length,
  ...Array.from({ length: 47 }, (_, i) => ({
    ...original,
    id: 101 + i,
    field_num: `#${101 + i}`,
    subject: `Morpho case ${101 + i}`,
    assignee_id: i % 2 ? 22 : 11,
    assignee_name: i % 2 ? "Agent Two" : "Agent One",
    status: i % 3 ? "开启" : "等待客户",
    replied_at: `2026-10-${String((i % 20) + 1).padStart(2, "0")}T10:00:00Z`,
    attachments: [],
  })),
  {
    ...original,
    id: 900,
    field_num: "#900",
    subject: "Colorbox excluded",
    assignee_id: 11,
    user_group_id: 5060,
  },
);
let app, browser;
try {
  app = await startServer(join(temp, "workspace"), mock.env);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.base);
  await page.locator("[data-demo=admin]").click();
  await page.locator("#main-content h1").waitFor();
  const sync = await page.request.post(
    app.base + "/api/integrations/udesk/accounts/sync",
    { data: {} },
  );
  assert.equal(sync.status(), 200, await sync.text());
  await page.locator('a.nav-item[href="#service"]').click();
  const assignment = page.getByLabel("Filter by ticket assignment", {
      exact: true,
    }),
    status = page.getByLabel("Filter by ticket status", { exact: true });
  await assignment.waitFor();
  assert.equal(await assignment.getAttribute("data-value"), "mine");
  assert.equal(await status.getAttribute("data-value"), "");
  assert.equal(
    await page.getByLabel("Udesk filter", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page
      .getByLabel("Sort all authorized tickets", { exact: true })
      .count(),
    0,
  );
  await assignment.click();
  assert.equal(
    await page
      .getByRole("listbox")
      .getByRole("option", { selected: true })
      .getAttribute("data-value"),
    "mine",
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("listbox").count(), 0);
  assert(await assignment.evaluate((el) => el === document.activeElement));
  await assignment.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  assert.equal(await assignment.getAttribute("data-value"), "all");
  await page.locator("tbody .ticket-subject").first().waitFor();
  assert.equal(await page.locator("tbody .ticket-subject").count(), 20);
  await selectColumnFilter(page, "Filter by ticket status", "等待客户");
  await page.waitForFunction(
    () => document.querySelectorAll("tbody .ticket-subject").length === 16,
  );
  assert.equal(await page.locator("tbody .ticket-subject").count(), 16);
  const exportURL = await page
    .getByRole("link", { name: "Export page", exact: true })
    .getAttribute("href");
  assert.equal(
    new URL(exportURL, app.base).searchParams.get("status"),
    "等待客户",
  );
  assert.equal(
    new URL(exportURL, app.base).searchParams.get("assignment"),
    "all",
  );
  assert.equal(
    new URL(exportURL, app.base).searchParams.get("sort"),
    "repliedAt:desc",
  );
  const csv = await page.request.get(app.base + exportURL);
  assert.equal(csv.status(), 200);
  assert((await csv.text()).includes("等待客户"));
  await page.getByLabel("Language", { exact: true }).selectOption("zh-CN");
  await page.screenshot({
    path: "test-results/ticket-column-filters-all-zh.png",
    fullPage: true,
  });
  // A mapped agent starts with a personal list; all results remain accessible.
  const ctx = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    agent = await ctx.newPage();
  agent.setDefaultTimeout(30000);
  await agent.goto(app.base);
  await agent.locator("[name=email]").fill("one@mock.local");
  await agent.locator("[name=password]").fill("HarborDemo!2026");
  await agent.locator("#login-form button").click();
  await agent.locator("#main-content h1").waitFor();
  await agent.locator('a.nav-item[href="#service"]').click();
  const mine = agent.getByLabel("Filter by ticket assignment", { exact: true });
  await mine.waitFor();
  assert.equal(await mine.getAttribute("data-value"), "mine");
  await agent.locator("tbody .ticket-subject").first().waitFor();
  await selectColumnFilter(agent, "Filter by ticket assignment", "mine");
  await agent.locator("tbody .ticket-subject").first().waitFor();
  let data = await (
    await agent.request.get(
      app.base + "/api/tickets?contract=2&assignment=mine&sort=repliedAt:desc",
    )
  ).json();
  assert.equal(data.totalCount, 24);
  assert.equal(data.totalPages, 2);
  assert(data.items.every((i) => i.ticket.assigneeId === "11"));
  for (let i = 1; i < data.items.length; i++)
    assert(
      new Date(data.items[i - 1].ticket.repliedAt) >=
        new Date(data.items[i].ticket.repliedAt),
    );
  const next = agent.getByRole("button", { name: "Next", exact: true });
  await next.click();
  await agent.waitForFunction(
    () => document.querySelectorAll("tbody .ticket-subject").length === 4,
  );
  assert.equal(await agent.locator("tbody .ticket-subject").count(), 4);
  await selectColumnFilter(agent, "Filter by ticket status", "等待客户");
  await agent.waitForFunction(
    () => document.querySelectorAll("tbody .ticket-subject").length === 8,
  );
  assert.equal(
    (
      await (
        await agent.request.get(
          app.base +
            "/api/tickets?contract=2&assignment=mine&status=" +
            encodeURIComponent("等待客户"),
        )
      ).json()
    ).totalCount,
    8,
  );
  await agent.screenshot({
    path: "test-results/ticket-column-filters-mine-en.png",
    fullPage: true,
  });
  // An empty result keeps both column controls available so users can recover.
  await agent
    .getByLabel("Search ticket content", { exact: true })
    .fill("no-such-ticket-content");
  await agent.getByText("No matching tickets", { exact: true }).waitFor();
  assert(await mine.isVisible());
  assert(
    await agent
      .getByLabel("Filter by ticket status", { exact: true })
      .isVisible(),
  );
  await agent
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await agent.locator("tbody .ticket-subject").first().waitFor();
  assert.equal(await mine.getAttribute("data-value"), "all");
  await agent.getByLabel("Language", { exact: true }).selectOption("zh-CN");
  await agent.setViewportSize({ width: 390, height: 844 });
  await agent.waitForFunction(
    () => document.querySelector(".sidebar").getBoundingClientRect().right <= 1,
  );
  assert(await agent.getByLabel("筛选工单范围", { exact: true }).isVisible());
  assert(await agent.getByLabel("筛选工单状态", { exact: true }).isVisible());
  assert(
    (await agent.getByLabel("筛选工单范围", { exact: true }).boundingBox())
      .width > 120,
  );
  await agent.screenshot({
    path: "test-results/ticket-column-filters-mobile-zh.png",
    fullPage: true,
  });
  assert(
    await agent.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  await ctx.close();
  console.log(
    "PASS default personal scope, all statuses, fixed global reply sorting, SQL paging, status intersection, export, unmapped account and empty-state recovery, bilingual desktop/mobile",
  );
} finally {
  await browser?.close();
  await app?.close();
  await mock.close();
  rmSync(temp, { recursive: true, force: true });
}
