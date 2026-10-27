import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.mjs";
const temp = mkdtempSync(join(tmpdir(), "harbor-i18n-")),
  app = await startServer(join(temp, "test-workspace"));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_EXECUTABLE
    ? { executablePath: process.env.CHROME_EXECUTABLE }
    : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(app.base);
  await page.getByLabel("Language", { exact: true }).selectOption("zh-CN");
  await page
    .getByRole("heading", { name: "欢迎使用。", exact: true })
    .waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  await page.locator("[data-demo=admin]").click();
  await page
    .getByRole("heading", { name: "运营总览。", exact: true })
    .waitFor();
  const ids = await page
    .locator("a.nav-item")
    .evaluateAll((xs) => xs.map((x) => x.getAttribute("href")));
  assert.equal(ids.length, 13);
  for (const href of ids) {
    await page.locator('a.nav-item[href="' + href + '"]').click();
    await page.locator("#main-content h1").waitFor();
    assert.equal(
      await page
        .getByText("Workspace could not be displayed", { exact: true })
        .count(),
      0,
    );
    assert.match(
      await page.locator("#main-content h1").innerText(),
      /[\u4e00-\u9fff]/,
    );
  }
  await page.locator('a[href="#product"]').click();
  await page.getByRole("button", { name: "新增商品", exact: true }).click();
  let d = page.getByRole("dialog");
  await d.locator("[name=sku]").fill("BILINGUAL-1080");
  await d.locator("[name=name]").fill("Customer entered 中文 Product");
  await d.locator("[name=category]").fill("Test category");
  await d.locator("[name=productType]").selectOption("part");
  await d.locator("[name=partKind]").selectOption("printhead");
  await d.locator("[name=warrantyClass]").selectOption("printhead_1080");
  await d.getByLabel("语言", { exact: true }).selectOption("en");
  assert.equal(await d.locator("[name=sku]").inputValue(), "BILINGUAL-1080");
  assert.equal(
    await d.locator("[name=warrantyClass]").inputValue(),
    "printhead_1080",
  );
  await d.getByRole("button", { name: "Save record", exact: true }).click();
  await d.waitFor({ state: "detached" });
  let s = await (await page.request.get(app.base + "/api/bootstrap")).json();
  const p = s.products.find((p) => p.sku === "BILINGUAL-1080");
  assert.equal(p.name, "Customer entered 中文 Product");
  assert.equal(p.productType, "part");
  assert.equal(p.warrantyClass, "printhead_1080");
  await page.getByLabel("Language", { exact: true }).selectOption("zh-CN");
  await page.locator('a[href="#settings"]').click();
  await page.getByRole("tab", { name: "质保规则", exact: true }).click();
  await page.getByRole("heading", { name: "质保规则", exact: true }).waitFor();
  await page.reload();
  await page.getByLabel("语言", { exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  await page.getByRole("tab", { name: "质保规则", exact: true }).click();
  // Inventory is queried within product details, not a separate navigation page.
  assert.equal(await page.locator('a[href="#warehouse"]').count(), 0);

  const post = async (action, payload) => {
    const r = await page.request.post(app.base + "/api/action", {
      data: { action, payload },
    });
    assert.equal(r.status(), 200, await r.text());
    return (await r.json()).result;
  };
  const order = await post("sale.create", {
    customer: "Language test customer",
    channel: "Direct",
    warehouseId: "WH-1",
    lines: [{ productId: "PRD-1", qty: 1, unitCents: 1000 }],
  });
  await post("sale.transition", { id: order.id, status: "confirmed" });
  await post("sale.transition", { id: order.id, status: "shipped" });
  await post("sale.return", { id: order.id, lines: [{productId: "PRD-1", qty: 1}] });
  s = await (await page.request.get(app.base + "/api/bootstrap")).json();
  assert.equal(s.sales.find((o) => o.id === order.id).lines[0].returned, 1);
  await page.locator('a[href="#rma"]').click();
  await page.getByRole("button", { name: "创建 RMA", exact: true }).click();
  d = page.getByRole("dialog");
  await d.getByLabel("购买平台", { exact: true }).selectOption("Shopify");
  await d.getByLabel("故障整机 / 配件 SKU", { exact: true }).selectOption(p.id);
  await d.getByLabel("拟定方案", { exact: true }).selectOption("parts");
  await d
    .getByLabel("喷头购买方式", { exact: true })
    .selectOption("standalone_printhead");
  await d.getByLabel("签收日期", { exact: true }).fill("2000-01-01");
  await d
    .getByText("质保已过期，请选择无需质保的方案。", { exact: true })
    .waitFor();
  assert.equal(
    await d.getByRole("button", { name: "创建 RMA", exact: true }).isDisabled(),
    true,
  );
  await d.getByLabel("语言", { exact: true }).selectOption("en");
  await d
    .getByText(
      "Warranty has expired. Choose a solution that does not require warranty coverage.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await d.getByLabel("Delivery date", { exact: true }).inputValue(),
    "2000-01-01",
  );
  await d.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByLabel("Language", { exact: true }).selectOption("zh-CN");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('a[href="#settings"]').evaluate((a) => a.click());
  await page.getByRole("tab", { name: "质保规则", exact: true }).click();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  mkdirSync("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/bilingual-zh-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "test-results/bilingual-zh.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS bilingual login, all 13 active pages, modal switching without data loss, canonical payloads, canonical sales-return API execution, translated warranty errors, persisted preference and Chinese mobile layout",
  );
} finally {
  await browser.close();
  await app.close();
  rmSync(temp, { recursive: true, force: true });
}
