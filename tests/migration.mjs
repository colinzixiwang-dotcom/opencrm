// Verify the actual existing legacy workspace using a consistent SQLite copy.
// The original database is opened read-only and is never modified by this test.
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startServer } from "./server.mjs";
const source = process.env.MIGRATION_DB || "data/harbor.sqlite",
  temp = mkdtempSync(join(tmpdir(), "harbor-migration-")),
  copy = join(temp, "legacy.sqlite");
let server;
try {
  const db = new DatabaseSync(source, { readOnly: true });
  const before = JSON.parse(
    db.prepare("SELECT data FROM app_state WHERE id=1").get().data,
  );
  db.prepare("VACUUM INTO ?").run(copy);
  db.close();
  server = await startServer(copy);
  const login = await fetch(server.base + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "admin@harbor.local",
      password: "HarborDemo!2026",
    }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const response = await fetch(server.base + "/api/bootstrap", {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  const after = await response.json();
  const counts = {};
  for (const k of [
    "products",
    "suppliers",
    "warehouses",
    "stocks",
    "purchases",
    "sales",
    "shipments",
    "movements",
    "payments",
    "expenses",
    "campaigns",
    "tickets",
    "tasks",
    "audit",
  ]) {
    assert.deepEqual(after[k], before[k], k + " changed during migration");
    counts[k] = after[k].length;
  }
  assert.deepEqual(after.settings, before.settings);
  assert.equal(after.version, before.version);
  assert.equal(after.users.length, before.users.length);
  assert.equal(after.roles.length, 3);
  assert.equal(after.menus.length, 20);
  await server.close();
  server = null;
  const result = {
    passed: true,
    source: "existing local legacy database (tested on a copy)",
    unchangedCollections: counts,
    settingsPreserved: true,
    versionPreserved: true,
    legacyLoginPreserved: true,
    ruoyiRolesInitialized: 3,
  };
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/migration-report.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (server) await server.close();
  rmSync(temp, { recursive: true, force: true });
}
