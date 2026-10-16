import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.mjs";
import { startUdeskMock } from "./udesk-fixture.mjs";
const temp = mkdtempSync(join(tmpdir(), "harbor-ticket-reading-"));
const mock = await startUdeskMock();
let app, browser;
try {
  const ticket = mock.state.tickets[0];
  ticket.user_id = 7;
  ticket.platform = "API";
  ticket.custom_fields.Problem = "Please cancel the extra order.";
  mock.state.fields.push({
    field_name: "Problem",
    field_label: "Customer Question / Problem Description",
    content_type: "text",
  });
  ticket.content =
    "Original customer submission: Order Number: ORDER-101 Customer Question / Problem Description: Please cancel the extra order.";
  mock.state.replyOverride = [
    {
      id: 11,
      content: ticket.content,
      content_format: "text",
      author: { id: 7, nick_name: "Customer", user_type: "customer" },
      created_at: ticket.created_at,
    },
    {
      id: 12,
      content:
        "<p>Your cancellation is confirmed.</p><blockquote>" +
        ticket.content +
        "</blockquote>",
      content_format: "html",
      author: { nick_name: "Agent One" },
      created_at: "2026-10-02T10:00:00Z",
    },
    {
      id: 13,
      content: ticket.content,
      content_format: "text",
      author: { id: 7, nick_name: "Customer" },
      created_at: "2026-10-03T10:00:00Z",
    },
    {
      id: 14,
      content:
        "<p>Before quote</p><blockquote>Old history</blockquote><p>New detail after quote</p>",
      content_format: "html",
      author: { nick_name: "Agent One" },
      created_at: "2026-10-04T10:00:00Z",
    },
    {
      id: 15,
      content:
        "Fresh response\nFrom: Customer\nSent: Yesterday\nTo: Support\nSubject: Order\nPrevious email",
      content_format: "text",
      author: { nick_name: "Agent One" },
      created_at: "2026-10-05T10:00:00Z",
    },
  ];
  app = await startServer(join(temp, "test.sqlite"), mock.env);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_EXECUTABLE
      ? { executablePath: process.env.CHROME_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.base);
  await page.locator("[data-demo=admin]").click();
  await page.locator("#main-content h1").waitFor();
  await page.goto(app.base + "/#service?ticket=101");
  await page
    .getByText("Initial submission shown above", { exact: true })
    .waitFor();
  await page
    .getByRole("heading", { name: "Submission fields", exact: true })
    .waitFor();
  const story = page.locator(".ticket-story");
  assert.equal(
    await story.locator(".ticket-content").first().innerText(),
    "Please cancel the extra order.",
  );
  assert.equal(await story.locator("details").getAttribute("open"), null);
  assert.equal(
    await page
      .locator(".ticket-sidebar")
      .getByText("Customer Question / Problem Description", { exact: true })
      .count(),
    0,
  );
  const messages = page.locator(".ticket-conversation article");
  assert.equal(await messages.count(), 5);
  assert.ok(!(await messages.nth(0).innerText()).includes("Order Number:"));
  await messages.nth(0).locator("summary").click();
  assert.ok((await messages.nth(0).innerText()).includes("Order Number:"));
  await messages.nth(0).locator("summary").click();
  assert.ok(!(await messages.nth(1).innerText()).includes("Order Number:"));
  await messages.nth(1).locator("summary").click();
  assert.ok((await messages.nth(1).innerText()).includes("Order Number:"));
  await messages.nth(1).locator("summary").click();
  assert.ok((await messages.nth(2).innerText()).includes("Order Number:"));
  assert.ok(
    (await messages.nth(3).innerText()).includes("New detail after quote"),
  );
  assert.equal(await messages.nth(3).locator("details").count(), 0);
  assert.equal(await messages.nth(4).locator("details").count(), 1);
  await page.screenshot({
    path: "test-results/ticket-reading-en.png",
    fullPage: true,
  });
  await page.getByLabel("Language", { exact: true }).selectOption("zh-CN");
  await page.getByRole("heading", { name: "问题详情", exact: true }).waitFor();
  await page.screenshot({
    path: "test-results/ticket-reading-zh.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector(".sidebar").getBoundingClientRect().right <= 1,
  );
  await page.screenshot({
    path: "test-results/ticket-reading-mobile.png",
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  // Unrecognized extra content must remain visible rather than disappear in a fold.
  ticket.content += " Delivery instruction: leave at reception.";
  await page.getByRole("button", { name: "刷新工单", exact: true }).click();
  await story.locator(".ticket-original summary").click();
  await story.getByText(/Delivery instruction: leave at reception/).waitFor();
  assert.equal(
    await story.locator(".ticket-problem-body .ticket-content").innerText(),
    "Please cancel the extra order.",
  );
  assert.equal(
    await story
      .locator(".ticket-submission-fields")
      .getByText("ORDER-101", { exact: true })
      .count(),
    1,
  );
  assert.equal(
    await page
      .locator(".ticket-sidebar")
      .getByText("ORDER-101", { exact: true })
      .count(),
    0,
  );
  assert.equal(
    await story
      .locator(".ticket-submission-fields")
      .getByText("0", { exact: true })
      .count(),
    1,
  );
  assert.equal(
    await story
      .locator(".ticket-submission-fields")
      .getByText("No", { exact: true })
      .count(),
    1,
  );
  ticket.platform = "邮件";
  await page.getByRole("button", { name: "刷新工单", exact: true }).click();
  await page
    .locator(".ticket-kicker")
    .getByText("邮件", { exact: true })
    .waitFor();
  await story.getByText(/Delivery instruction: leave at reception/).waitFor();
  assert.equal(await story.locator(".ticket-submission-fields").count(), 0);
  assert.equal(await story.locator(".ticket-original").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS structured submission coverage, initial message identity/time checks, expandable HTML/text quotes, trailing new text, bilingual/mobile layout and unknown content preservation",
  );
} finally {
  await browser?.close();
  await app?.close();
  await mock.close();
  rmSync(temp, { recursive: true, force: true });
}
