import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
export async function startServer(
  databasePath,
  integrationEnv = {},
  options = {},
) {
  const executable = resolve(dirname(databasePath), "harbor-test");
  const build = spawnSync(
    "./scripts/go.sh",
    ["build", "-o", executable, "./cmd/harbor"],
    { stdio: "inherit" },
  );
  if (build.status !== 0) throw Error("Go build failed");
  const dbExecutable = resolve(dirname(databasePath), "harbor-db-test");
  const dbBuild = spawnSync(
    "./scripts/go.sh",
    ["build", "-o", dbExecutable, "./cmd/db"],
    { stdio: "inherit" },
  );
  if (dbBuild.status !== 0) throw Error("Database tool build failed");
  const dbCommand = (action, args = []) => {
    const result = spawnSync(
      dbExecutable,
      ["-action", action, "-namespace", databasePath, ...args],
      { encoding: "utf8" },
    );
    if (result.status !== 0)
      throw Error("PostgreSQL test administration failed: " + result.stderr);
    return result.stdout;
  };
  if (options.importFile) dbCommand("import", ["-file", options.importFile]);
  const port = await new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const child = spawn(executable, [], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      UDESK_BASE_URL: "",
      UDESK_ADMIN_EMAIL: "",
      UDESK_OPEN_API_TOKEN: "",
      ...integrationEnv,
      PG_TEST_NAMESPACE: databasePath,
      PORT: String(port),
      DIST_DIR: resolve("frontend/dist"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (x) => (logs += x));
  child.stderr.on("data", (x) => (logs += x));
  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(base + "/api/health");
      if (r.ok) {
        healthy = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!healthy) {
    child.kill();
    throw Error("Server did not start: " + logs);
  }
  return {
    base,
    readState: () => JSON.parse(dbCommand("dump")),
    close: ({ preserve = false } = {}) =>
      new Promise((r) => {
        child.once("exit", () => {
          if (!preserve) dbCommand("destroy-test");
          r();
        });
        child.kill("SIGTERM");
      }),
  };
}
