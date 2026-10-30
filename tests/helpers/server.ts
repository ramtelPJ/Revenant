// Starts the production build (`next start`) on a spare loopback port with known secrets and a throwaway data folder,
// the way scripts/launch.ts does, so integration tests can talk to the real server over HTTP. Needs `npm run build`.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const hasBuild = existsSync(path.resolve(".next/BUILD_ID"));

export type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string; json: () => any };

/** A raw HTTP request, so a test can set the Host and Sec-Fetch headers that fetch() would not let it set. */
export function rawRequest(port: number, options: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path, headers: { host: `127.0.0.1:${port}`, ...options.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

export type TestServer = {
  port: number;
  dataDir: string;
  launchToken: string;
  sessionSecret: string;
  unlockPath: string;
  /** Everything the server wrote to stdout and stderr so far. */
  logs: () => string;
  request: (options: { method?: string; path: string; headers?: Record<string, string>; body?: string; cookie?: string }) => Promise<Reply>;
  /** Stops the server. The data folder stays, so a second server can start on the same data. */
  stop: () => Promise<void>;
  /** Stops the server and deletes its data folder (imported projects are read-only, so they are unlocked first). */
  dispose: () => Promise<void>;
};

export async function startTestServer(options: { dataDir?: string; env?: Record<string, string> } = {}): Promise<TestServer> {
  const dataDir = options.dataDir ?? realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-server-")));
  const port = await freePort();
  const launchToken = randomBytes(32).toString("hex");
  const sessionSecret = randomBytes(32).toString("hex");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    OLLAMA_MODEL: process.env.OLLAMA_MODEL ?? "gemma2:2b",
    REVENANT_LAUNCH_TOKEN: launchToken,
    REVENANT_SESSION_SECRET: sessionSecret,
    ...options.env,
  };
  const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
  const child: ChildProcess = spawn(process.execPath, [next, "start", "-H", "127.0.0.1", "-p", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout!.on("data", (c: Buffer) => (log += c.toString()));
  child.stderr!.on("data", (c: Buffer) => (log += c.toString()));

  const stop = () =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    });

  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`The test server stopped while starting.\n${log.slice(-300)}`);
    try {
      if ((await rawRequest(port, { path: "/locked" })).status === 200) break;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
    if (i === 119) {
      await stop();
      throw new Error("The test server did not start in 30 seconds.");
    }
  }

  return {
    port,
    dataDir,
    launchToken,
    sessionSecret,
    unlockPath: `/unlock?token=${launchToken}`,
    logs: () => log,
    request: (o) => rawRequest(port, { ...o, headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers } }),
    stop,
    async dispose() {
      await stop();
      spawnSync("chmod", ["-R", "u+rwx", dataDir]);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** `name=value` of the session cookie in a Set-Cookie header, or null. */
export function sessionCookie(reply: Reply): string | null {
  const raw = reply.headers["set-cookie"] ?? [];
  const found = raw.map((c) => c.split(";")[0]).find((c) => c.startsWith("revenant_session="));
  return found ?? null;
}
