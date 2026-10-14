import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
export async function startServer(databasePath) {
  const build = spawnSync(
    "./scripts/go.sh",
    ["build", "-o", "../.bin/harbor", "./cmd/harbor"],
    { stdio: "inherit" },
  );
  if (build.status !== 0) throw Error("Go build failed");
  const port = await new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const child = spawn(resolve(".bin/harbor"), [], {
    env: {
      ...process.env,
      DB_PATH: databasePath,
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
    close: () =>
      new Promise((r) => {
        child.once("exit", r);
        child.kill("SIGTERM");
      }),
  };
}
