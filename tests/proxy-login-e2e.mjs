import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";
import { startServer } from "./server.mjs";

const temp = mkdtempSync(join(tmpdir(), "harbor-proxy-login-"));
let backend, frontend, browser;
const previousTarget = process.env.VITE_API_PROXY_TARGET;
try {
  backend = await startServer(join(temp, "test-workspace"));
  process.env.VITE_API_PROXY_TARGET = backend.base;
  frontend = await createServer({
    configFile: "frontend/vite.config.js",
    server: { host: "127.0.0.1", port: 0, open: false },
  });
  await frontend.listen();
  const base = `http://127.0.0.1:${frontend.httpServer.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_EXECUTABLE
      ? { executablePath: process.env.CHROME_EXECUTABLE }
      : {}),
  });
  for (const role of ["credentials", "admin", "operator", "analyst"]) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(base);
      const login = page.waitForResponse((r) => r.url().endsWith("/api/login"));
      if (role === "credentials") {
        await page.locator('#login-form [name="email"]').fill("admin@harbor.local");
        await page.locator('#login-form [name="password"]').fill("HarborDemo!2026");
        await page.locator("#login-form button").click();
      } else {
        await page.locator(`button[data-demo="${role}"]`).click();
      }
      assert.equal((await login).status(), 200, role + " login through Vite");
      await page.locator("#main-content .page-heading").waitFor();
      assert.equal((await page.request.get(base + "/api/bootstrap")).status(), 200);
      const logout = await page.evaluate(async () => {
        const response = await fetch("/api/logout", { method: "POST" });
        return response.status;
      });
      assert.equal(logout, 200, "authenticated write through Vite");
      console.log("PASS proxy login, bootstrap and logout:", role);
    } finally {
      await context.close();
    }
  }
  const rejected = await fetch(base + "/api/login", {
    method: "POST",
    headers: { Origin: "http://untrusted.example", "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@harbor.local", password: "HarborDemo!2026" }),
  });
  assert.equal(rejected.status, 403);
  assert.match((await rejected.json()).error, /Cross-origin/);
  console.log("PASS proxy still rejects cross-origin writes");
} finally {
  await browser?.close();
  await frontend?.close();
  await backend?.close();
  if (previousTarget === undefined) delete process.env.VITE_API_PROXY_TARGET;
  else process.env.VITE_API_PROXY_TARGET = previousTarget;
  rmSync(temp, { recursive: true, force: true });
}
