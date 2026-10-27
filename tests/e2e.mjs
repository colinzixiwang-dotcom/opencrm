import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.mjs";
const temp = mkdtempSync(join(tmpdir(), "harbor-smoke-"));
const app = await startServer(join(temp, "test-workspace"));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_EXECUTABLE
    ? { executablePath: process.env.CHROME_EXECUTABLE }
    : {}),
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.base);
  await page.locator("[data-demo=admin]").click();
  await page.locator("#main-content h1").waitFor();
  const links = await page
    .locator("nav a.nav-item")
    .evaluateAll((xs) => xs.map((x) => x.getAttribute("href")));
  assert.equal(links.length, 13);
  const hidden = [
    "fba",
    "advertising",
    "finance",
    "statistics",
    "tools",
    "sales",
    "purchase",
  ];
  for (const id of hidden) assert.ok(!links.includes("#" + id));
  for (const href of links) {
    await page.locator(`nav a[href="${href}"]`).click();
    await page.locator("#main-content h1").waitFor();
    assert.equal(
      await page
        .getByText("Workspace could not be displayed", { exact: true })
        .count(),
      0,
    );
  }
  for (const id of hidden) {
    await page.evaluate((x) => {
      location.hash = x;
    }, id);
    await page
      .getByRole("heading", { name: "Temporarily disabled", exact: true })
      .waitFor();
  }
  await page.locator('nav a[href="#product"]').click();
  // Catalog identity is imported from ERP; local product creation is no longer
  // exposed on this page. Import/edit/inventory flows have their own catalog suite.
  await page.locator(".catalog-products").waitFor();
  assert.equal(await page.getByRole("button", { name: "Add product", exact: true }).count(), 0);
  await page.getByText("No imported SKUs yet. Synchronize the Mabang catalog first.", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS current workspace: 13 visible modules, seven hidden routes, ERP catalog entry and no JavaScript errors",
  );
} finally {
  await browser.close();
  await app.close();
  rmSync(temp, { recursive: true, force: true });
}
