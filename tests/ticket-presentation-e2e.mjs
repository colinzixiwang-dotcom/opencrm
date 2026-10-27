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
      author: { nick_name: "Agent One", user_type: "agent" },
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
  mock.state.replyOverride.push({
    id: 16, attachments: [{url:mock.base+"/preview/original.eml",file_name:"original.eml",file_size:24561}], content_format: "html", author: {nick_name: "Mail Customer", user_type: "customer"}, created_at: "2026-10-06T13:11:52+08:00",
    content: '<div>Just cant afford it now</div><div id="composer_signature">Sent from my Galaxy</div><div><div>-------- Original message --------</div><div>From: Support</div><div>Date: Yesterday</div><div>To: Customer</div><div>Subject: Order</div></div><table border="0" cellpadding="0" cellspacing="0"><tr><td><table border="0" cellpadding="0" cellspacing="0"><tr><td>Previous support response</td></tr></table></td></tr></table><table><tr><th>Item</th><th>Amount</th></tr><tr><td>Deposit</td><td>$50</td></tr></table><div>Unsubscribe footer</div>',
  }, {
    id: 17, content_format: "html", author: {nick_name:"Customer"}, created_at:"2026-10-07T00:00:00Z",
    content: '<div>Current reply</div><div>-------- Original message --------</div><div>No email headers: this is part of my reply.</div>',
  });
  mock.state.replyOverride.push({
    id: 18, attachments: ticket.attachments.slice(0,3), content_format: "html", author: {nick_name:"Outlook Customer",user_type:"customer"},created_at:"2026-10-08T00:00:00Z",
    content: '<div style="margin-top:1em;margin-bottom:1em"><span>\u200b</span><a id="OLK_Beautified_pdf" href="https://1drv.ms/example">bank statements.pdf</a>Hi Morpho Team,</div><div style="margin-top:1em;margin-bottom:1em">Please confirm the reserved price.</div><blockquote>Reserved price is $2,799</blockquote><div style="margin-top:1em;margin-bottom:1em">My new questions follow this quote.</div><ol start="2"><li>Which reward should I select?</li><li>How are my deposits applied?</li></ol><div>Best, Customer</div><hr><div id="divRplyFwdMsg"><b>From:</b> Support<br><b>Sent:</b> Yesterday<br><b>To:</b> Customer<br><b>Subject:</b> Price</div><div>Previous support pricing response</div><table><tr><th>Reward</th><th>Price</th></tr><tr><td>Pro</td><td>$2,799</td></tr></table><div>Older unsubscribe footer</div>',
  });
  app = await startServer(join(temp, "test-workspace"), mock.env);
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
  // A new index can return partial metadata before its first sync completes.
  let firstMetadata = true;
  await page.route("**/api/tickets/metadata", (route) => {
    if (!firstMetadata) return route.continue();
    firstMetadata = false;
    return route.fulfill({ json: { fields: {}, templates: {}, filters: [] } });
  });
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
  assert.equal(await messages.count(), 8);
  await page.getByText("Times shown in Beijing (UTC+8)",{exact:true}).waitFor();
  await page.locator(".conversation-count").filter({hasText:"8 messages"}).waitFor();
  assert.equal(await page.getByRole("navigation",{name:"Conversation pagination",exact:true}).count(),0);
  assert.equal(await messages.nth(0).locator(".conversation-role").innerText(),"Customer");
  assert.equal(await messages.nth(1).locator(".conversation-role").innerText(),"Support agent");
  assert.equal(await messages.nth(5).locator(".conversation-header time").innerText().then(text=>text.includes("13:11")),true);

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
  const samsung = messages.nth(5);
  assert.equal(await samsung.getByText("Just cant afford it now",{exact:true}).isVisible(),true);
  assert.equal(await samsung.getByText("Previous support response",{exact:true}).isVisible(),false);
  assert.equal(await samsung.locator(".mail-signature").innerText(),"Sent from my Galaxy");
  await samsung.locator("summary").click();
  assert.equal(await samsung.getByText("Previous support response",{exact:true}).isVisible(),true);
  assert.equal(await samsung.getByText("Unsubscribe footer",{exact:true}).isVisible(),true);
  assert.equal(await samsung.locator(".mail-layout").count(),2);
  assert.equal(await samsung.locator("table").count(),1);
  assert.equal(await samsung.locator("table th").count(),2);
  await samsung.locator("summary").click();
  assert.equal(await samsung.getByRole("navigation",{name:"Attachment pagination",exact:true}).count(),0);
  const email = samsung.getByRole("link", {name:"Download original email",exact:true});
  assert.ok((await email.getAttribute("href")).includes("download=1"));
  assert.ok((await email.innerText()).includes("24 KB"));
  const download = await Promise.all([page.waitForEvent("download"),email.click()]).then(([download])=>download);
  assert.equal(download.suggestedFilename(),"original.eml");
  assert.equal(await download.failure(),null);
  const downloadURL = new URL(await email.getAttribute("href"),app.base);
  const response = await page.request.get(downloadURL.href);
  assert.equal(response.status(),200);
  assert.ok(response.headers()["content-disposition"].startsWith("attachment;"));
  assert.ok((await response.text()).includes("Just cant afford it now"));
  downloadURL.searchParams.delete("download");
  assert.equal((await page.request.get(downloadURL.href)).status(),415);
  downloadURL.searchParams.set("download","1");
  downloadURL.searchParams.set("ref",mock.base+"/preview/not-a-ticket-attachment.eml");
  assert.ok((await page.request.get(downloadURL.href)).status() >= 400);
  assert.equal(await page.getByRole("dialog",{name:"Attachment preview",exact:true}).count(),0);
  assert.equal(await messages.nth(6).locator("details").count(),0);
  const outlook = messages.nth(7);
  const gallery = outlook.locator(".attachment-gallery");
  assert.equal(await gallery.locator(".attachment-card").count(),3);
  assert.equal(await gallery.getByRole("navigation").count(),0);
  for (const card of await gallery.locator(".attachment-card").all()) assert.equal(await card.isVisible(),true);
  await gallery.getByRole("button",{name:"Preview manual.pdf",exact:true}).click();
  const preview = page.getByRole("dialog",{name:"Attachment preview",exact:true});
  const previewPager = preview.getByRole("navigation",{name:"Attachment preview navigation",exact:true});
  assert.match(await previewPager.innerText(), /3\s*\/\s*3/);
  assert.equal(await previewPager.getByRole("button",{name:"Next attachment",exact:true}).isDisabled(),true);
  await previewPager.getByRole("button",{name:"Previous attachment",exact:true}).click();
  assert.match(await previewPager.innerText(), /2\s*\/\s*3/);
  await page.keyboard.press("Escape");
  await preview.waitFor({state:"detached"});
  assert.equal(await outlook.getByText("Reserved price is $2,799",{exact:true}).isVisible(),true);
  assert.equal(await outlook.getByText("My new questions follow this quote.",{exact:true}).isVisible(),true);
  assert.equal(await outlook.locator("ol li").count(),2);
  assert.equal(await outlook.locator("ol").getAttribute("start"),"2");
  assert.equal(await outlook.getByText("Previous support pricing response",{exact:true}).isVisible(),false);
  assert.ok(await outlook.locator(".mail-paragraph").first().evaluate(el=>parseFloat(getComputedStyle(el).marginBottom))>0);
  const inline = outlook.locator(".mail-inline-files");
  assert.equal(await inline.getByRole("link").getAttribute("href"),"https://1drv.ms/example");
  assert.ok((await inline.innerText()).includes("OneDrive"));
  assert.equal(await outlook.getByText("Hi Morpho Team,",{exact:true}).isVisible(),true);
  await outlook.locator("summary").click();
  assert.equal(await outlook.getByText("Previous support pricing response",{exact:true}).isVisible(),true);
  assert.equal(await outlook.getByText("Older unsubscribe footer",{exact:true}).isVisible(),true);
  assert.equal(await outlook.locator("table th").count(),2);
  await outlook.locator("summary").click();
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
      .getByText("否", { exact: true })
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
  ticket.content =
    '<p>Current offer</p><table><tr><th>Site</th><th>Price</th></tr><tr><td></td><td>$50</td></tr><tr><td colspan="2">Terms</td></tr></table><pre>  line one\n    line two</pre><script>window.mailExecuted=true</script><a href="javascript:alert(1)">Unsafe link</a><blockquote><p>Previous email</p><table><tr><td>Old quote</td></tr></table><blockquote>Older mail</blockquote></blockquote>';
  await page.getByRole("button", { name: "刷新工单", exact: true }).click();
  await story.getByText("Current offer", { exact: true }).waitFor();
  assert.equal(await story.locator("table").count(), 2);
  assert.equal(
    await story
      .locator("table")
      .first()
      .locator("tr")
      .nth(1)
      .locator("td")
      .count(),
    2,
  );
  assert.equal(await story.locator("td[colspan='2']").count(), 1);
  assert.equal(
    await story.locator("pre").textContent(),
    "  line one\n    line two",
  );
  assert.equal(
    await story.locator(".conversation-quote").getAttribute("open"),
    null,
  );
  assert.equal(
    await story.getByText("Previous email", { exact: true }).isVisible(),
    false,
  );
  assert.equal(await story.locator("a[href^='javascript:'],script").count(), 0);
  assert.equal(await page.evaluate(() => window.mailExecuted), undefined);
  await story.locator(".conversation-quote summary").click();
  assert.equal(
    await story.getByText("Previous email", { exact: true }).isVisible(),
    true,
  );
  await page.screenshot({
    path: "test-results/mail-tables-mobile.png",
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
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
