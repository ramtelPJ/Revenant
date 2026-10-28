// npm run revenant: starts the production server on 127.0.0.1 with fresh secrets and opens the unlock link.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { parseEnv } from "../src/lib/env.ts";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

// Fresh every launch, so a restart invalidates every old link and cookie.
const secrets = {
  REVENANT_LAUNCH_TOKEN: randomBytes(32).toString("hex"),
  REVENANT_SESSION_SECRET: randomBytes(32).toString("hex"),
};
const env = { ...process.env, ...secrets, HOST: "127.0.0.1" };

let port: number;
try {
  port = parseEnv(env).PORT; // fail now with a clear message, not on the first request
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

if (!existsSync(".next/BUILD_ID")) {
  console.error("No production build found. Run `npm run build` first.");
  process.exit(1);
}

const url = `http://127.0.0.1:${port}/unlock?token=${secrets.REVENANT_LAUNCH_TOKEN}`;
console.log(`\nRevenant is starting on http://127.0.0.1:${port}`);
console.log(`Open this link once (it works a single time, for 15 minutes):\n\n  ${url}\n`);

// secrets travel in the environment, not argv, so they do not show up in `ps`
const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
const child = spawn(process.execPath, [next, "start", "-H", "127.0.0.1", "-p", String(port)], { env, stdio: "inherit" });

const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
if (!process.argv.includes("--no-open")) {
  setTimeout(() => spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref(), 1500);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
