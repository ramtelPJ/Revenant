// Runs the real sandbox. Skipped (and reported as skipped) when Docker or the image is missing.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { checkDocker } from "@/lib/sandbox/docker-health";
import { buildDockerArgs, containerName, resolveDockerBin, runDocker, type DockerRunSpec } from "@/lib/sandbox/docker";
import { evaluateCheck, START_SURVIVAL_MS, type CheckKind } from "@/lib/sandbox/checks";

const IMAGE = "node:lts-slim";
const health = await checkDocker(IMAGE, undefined, 30_000);
const ready = health.available && health.imagePresent;

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function project(scripts: Record<string, string>, files: Record<string, string>) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-real-")));
  roots.push(root);
  const runId = randomUUID();
  const folder = path.join(root, runId);
  mkdirSync(folder);
  writeFileSync(path.join(folder, "package.json"), JSON.stringify({ name: "t", version: "1.0.0", scripts }));
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(folder, name), content);
  return { runId, folder };
}

async function run(kind: CheckKind, p: { runId: string; folder: string }, extra: { timeoutMs?: number; survivalMs?: number; maxOutputBytes?: number; image?: string } = {}) {
  const spec: DockerRunSpec = { runId: p.runId, folder: p.folder, kind, image: extra.image ?? IMAGE, memoryMb: 512, cpus: 1 };
  return runDocker(buildDockerArgs(spec), {
    name: containerName(p.runId),
    timeoutMs: extra.timeoutMs ?? 60_000,
    survivalMs: extra.survivalMs,
    maxOutputBytes: extra.maxOutputBytes,
  });
}

const containerExists = async (runId: string) => {
  const bin = (await resolveDockerBin())!;
  return spawnSync(bin, ["ps", "-a", "--filter", `name=${containerName(runId)}`, "-q"], { encoding: "utf8" }).stdout.trim() !== "";
};

describe.runIf(ready)("real Docker sandbox", { timeout: 90_000 }, () => {
  test("a passing test script: exit 0, output captured, project can write to /app", async () => {
    const p = project({ test: "node test.js" }, { "test.js": 'require("fs").writeFileSync("/app/out.txt","x"); console.log("hello from sandbox, uid", process.getuid())' });
    const result = await run("test", p);
    expect(result).toMatchObject({ kind: "finished", exitCode: 0, timedOut: false });
    expect((result as { output: string }).output).toContain("hello from sandbox, uid 1000");
    expect(await containerExists(p.runId)).toBe(false);
  });

  test("a failing test script: non-zero exit and its error text", async () => {
    const p = project({ test: "node test.js" }, { "test.js": 'console.error("ESM_PROBLEM"); process.exit(3)' });
    const result = (await run("test", p)) as { exitCode: number; output: string };
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("ESM_PROBLEM");
    expect(evaluateCheck("test", result as never)).toBe("failed");
  });

  test("the network is blocked", async () => {
    const p = project({ test: "node test.js" }, { "test.js": 'fetch("https://example.com").then(() => process.exit(1), () => { console.log("blocked"); process.exit(0); })' });
    const result = (await run("test", p)) as { exitCode: number; output: string };
    expect(result.exitCode, result.output).toBe(0); // 0 only if the fetch failed
    expect(result.output).toContain("blocked");
  });

  test("writes outside /app and /tmp are denied (read-only root)", async () => {
    const p = project({ test: "node test.js" }, { "test.js": 'try { require("fs").writeFileSync("/etc/x","x"); process.exit(1) } catch (e) { console.log("denied", e.code); process.exit(0) }' });
    const result = (await run("test", p)) as { exitCode: number; output: string };
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain("denied EROFS");
  });

  test("a hanging script times out, the container is killed and removed", async () => {
    const p = project({ test: "node test.js" }, { "test.js": "setInterval(() => {}, 1000)" });
    const started = Date.now();
    const result = await run("test", p, { timeoutMs: 3000 });
    expect(result).toMatchObject({ kind: "finished", timedOut: true });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(evaluateCheck("test", result as never)).toBe("timed_out");
    expect(await containerExists(p.runId)).toBe(false);
  });

  test("start check: a server that stays up counts as survived", async () => {
    const p = project({ start: "node server.js" }, { "server.js": 'setInterval(() => {}, 1000); console.log("listening")' });
    const result = (await run("start", p, { survivalMs: 3000, timeoutMs: 15_000 })) as { survived: boolean; output: string };
    expect(result.survived).toBe(true);
    expect(result.output).toContain("listening");
    expect(evaluateCheck("start", result as never)).toBe("passed");
    expect(await containerExists(p.runId)).toBe(false);
  });

  test("start check: crashing immediately is a failure", async () => {
    const p = project({ start: "node server.js" }, { "server.js": 'console.error("crash"); process.exit(2)' });
    const result = await run("start", p, { survivalMs: 3000, timeoutMs: 15_000 });
    expect(evaluateCheck("start", result as never)).toBe("failed");
  });

  test("a memory hog is killed by the limit", async () => {
    const p = project({ test: "node test.js" }, { "test.js": "const a=[];for(;;){a.push(Buffer.alloc(50*1024*1024,1))}" });
    const result = (await run("test", p)) as { exitCode: number };
    expect(result.exitCode).toBe(137);
  });

  test("a flood of output is capped at 64 KB and marked", async () => {
    const p = project({ test: "node test.js" }, { "test.js": 'process.stdout.write("x".repeat(300 * 1024))' });
    const result = (await run("test", p)) as { output: string; truncated: boolean; exitCode: number };
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThan(64 * 1024 + 100);
  });

  test("a missing image is image_missing (pull is disabled), not a project failure", async () => {
    const p = project({ test: "node test.js" }, { "test.js": "" });
    expect(await run("test", p, { image: "revenant-no-such-image:0.0.0" })).toEqual({ kind: "unavailable", reason: "image_missing" });
  });
});

// FIX-001: with the real docker command and a daemon that cannot be reached, Docker's own error must not be blamed on the project
const haveCli = (await resolveDockerBin()) !== undefined;
describe.runIf(haveCli)("real docker CLI with an unreachable daemon", { timeout: 60_000 }, () => {
  test("is docker_not_running, never a failed run of the project", async () => {
    const before = process.env.DOCKER_HOST;
    process.env.DOCKER_HOST = "unix:///nonexistent/revenant-test.sock";
    try {
      const p = project({ test: "node test.js" }, { "test.js": "" });
      expect(await run("test", p)).toEqual({ kind: "unavailable", reason: "docker_not_running" });
    } finally {
      if (before === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = before;
    }
  });
});

test.skipIf(ready)("real Docker sandbox tests were SKIPPED: Docker or the node:lts-slim image is not available", () => {});
test("survival constant matches the documented 8 seconds", () => expect(START_SURVIVAL_MS).toBe(8000));
