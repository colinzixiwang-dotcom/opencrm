// The only SQLite access is the explicit, read-only legacy export tool.
// Both the imported application and all verification run on remote PostgreSQL.
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startServer } from "./server.mjs";
const temp = mkdtempSync(join(tmpdir(), "morpho-pg-migration-"));
let app;
try {
  const file = join(temp, "legacy-export.json");
  const exportResult = spawnSync(
    "python3",
    [
      "scripts/export-legacy-sqlite.py",
      process.env.MIGRATION_DB || "data/harbor.sqlite",
      file,
    ],
    { encoding: "utf8" },
  );
  assert.equal(exportResult.status, 0, exportResult.stderr);
  const source = JSON.parse(readFileSync(file, "utf8"));
  app = await startServer(
    join(temp, "migration-workspace"),
    {},
    { importFile: file },
  );
  const after = app.readState();
  for (const [key, value] of Object.entries(source.state)) {
    if (key !== "users")
      assert.deepEqual(
        after[key],
        value,
        key + " changed during PostgreSQL migration",
      );
  }
  for (const row of source.tables.sys_user) {
    const user = after.users.find((u) => u.id === row.user_id);
    assert.ok(user);
    assert.equal(user.email, row.email);
    assert.equal(user.passwordHash, row.password);
    assert.equal(user.active, row.status === "0");
  }
  const r = await fetch(app.base + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "admin@harbor.local",
      password: "HarborDemo!2026",
    }),
  });
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const bootstrap = await fetch(app.base + "/api/bootstrap", {
    headers: { cookie },
  });
  assert.equal(bootstrap.status, 200);
  assert.deepEqual((await bootstrap.json()).tickets, []);
  const health = await (await fetch(app.base + "/api/health")).json();
  assert.equal(health.storage, "postgresql");
  const before = after;
  await app.close({ preserve: true });
  app = await startServer(join(temp, "migration-workspace"));
  assert.deepEqual(app.readState(), before);
  mkdirSync("test-results", { recursive: true });
  const report = {
    passed: true,
    storage: "PostgreSQL",
    source: "consistent read-only legacy SQLite export",
    allBusinessCollectionsPreserved: true,
    settingsAndPolicyVersionsPreserved: true,
    accountHashesPreserved: true,
    restartPersistence: true,
  };
  writeFileSync(
    "test-results/migration-report.json",
    JSON.stringify(report, null, 2),
  );
  console.log(report);
} finally {
  await app?.close();
  rmSync(temp, { recursive: true, force: true });
}
