// End to end with the real sandbox: import -> read-only original -> copy -> Docker -> recorded result.
// Skipped (and the skip is reported) when Docker or the node:lts-slim image is not available.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { caseFolder } from "@/lib/cases/files";
import { removeTree } from "@/lib/cases/fs";
import { importFolder } from "@/lib/cases/import";
import { openDatabase, type OpenDatabase } from "@/lib/db/client";
import { containerName, resolveDockerBin, runDocker } from "@/lib/sandbox/docker";
import { checkDocker } from "@/lib/sandbox/docker-health";
import { runCheck, type RunContext } from "@/lib/sandbox/run";

const IMAGE = "node:lts-slim";
const health = await checkDocker(IMAGE, undefined, 30_000);
const ready = health.available && health.imagePresent;

let root: string;
let open: OpenDatabase;
let ctx: RunContext;

const write = (base: string, rel: string, content = "x") => {
  const full = path.join(base, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
};

async function newCase(manifest: Record<string, unknown>, files: Record<string, string>, bin?: Record<string, string>, executable: string[] = []) {
  const dir = path.join(root, "src-projects", crypto.randomUUID());
  write(dir, "package.json", JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  for (const rel of executable) chmodSync(path.join(dir, rel), 0o755); // npm sets this on a package's bin files
  for (const [name, target] of Object.entries(bin ?? {})) {
    mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
    symlinkSync(target, path.join(dir, "node_modules", ".bin", name));
  }
  const home = path.join(root, "home");
  return (await importFolder(dir, { db: open.db, dataDir: ctx.dataDir, maxProjectBytes: 1e8, samplesDir: path.join(root, "samples"), homeDir: home })).id;
}

function treeHash(dir: string): string {
  const hash = createHash("sha256");
  const visit = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      const stat = lstatSync(full);
      hash.update(path.relative(dir, full));
      if (stat.isSymbolicLink()) hash.update(`->${readlinkSync(full)}`);
      else if (stat.isDirectory()) visit(full);
      else hash.update(readFileSync(full));
    }
  };
  visit(dir);
  return hash.digest("hex");
}

const containerExists = async (id: string) => {
  const bin = (await resolveDockerBin())!;
  return spawnSync(bin, ["ps", "-a", "--filter", `name=${containerName(id)}`, "-q"], { encoding: "utf8" }).stdout.trim() !== "";
};

beforeAll(() => {
  if (!ready) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-sbxreal-")));
  mkdirSync(path.join(root, "home"));
  open = openDatabase(path.join(root, "data"));
  ctx = {
    db: open.db,
    dataDir: path.join(root, "data"),
    limits: { image: IMAGE, memoryMb: 512, cpus: 1, timeoutSec: 60 },
    docker: runDocker,
  };
});
afterAll(async () => {
  if (!ready) return;
  open.sqlite.close();
  await removeTree(root);
});
afterEach(() => {
  if (ready) expect(existsSync(path.join(ctx.dataDir, "runs")) ? readdirSync(path.join(ctx.dataDir, "runs")) : []).toEqual([]);
});

describe.runIf(ready)("runCheck with the real sandbox", { timeout: 90_000 }, () => {
  test("a passing project is recorded as passed, and the original is untouched even though the project wrote files", async () => {
    const caseId = await newCase(
      { name: "ok", scripts: { test: "node test.js" } },
      { "test.js": 'require("fs").writeFileSync("/app/written-by-project.txt","x"); require("fs").writeFileSync("/app/test.js","// tampered"); console.log("project ran as", process.getuid())' },
    );
    const original = caseFolder(caseId, "original", ctx.dataDir);
    const before = treeHash(original);

    const row = await runCheck({ caseId, kind: "test", phase: "baseline", target: "original", consent: true }, ctx);

    expect(row).toMatchObject({ status: "passed", exitCode: 0, unrunnableReason: null });
    expect(row.outputExcerpt).toContain("project ran as 1000");
    expect(row.durationMs).toBeGreaterThan(0);
    expect(treeHash(original)).toBe(before);
    expect(existsSync(path.join(original, "written-by-project.txt"))).toBe(false);
    expect(await containerExists(row.id)).toBe(false);
  });

  test("a failing project is recorded as failed with its error text", async () => {
    const caseId = await newCase({ name: "bad", scripts: { test: "node test.js" } }, { "test.js": 'throw new Error("REAL_FAILURE_TEXT")' });
    const row = await runCheck({ caseId, kind: "test", phase: "baseline", target: "original", consent: true }, ctx);
    expect(row.status).toBe("failed");
    expect(row.exitCode).not.toBe(0);
    expect(row.outputExcerpt).toContain("REAL_FAILURE_TEXT");
  });

  test("tools linked in node_modules/.bin work through import, copy and container", async () => {
    const caseId = await newCase(
      { name: "bin", scripts: { test: "tool" }, devDependencies: { tool: "1.0.0" } },
      { "node_modules/tool/cli.js": '#!/usr/bin/env node\nconsole.log("tool ran")\n' },
      { tool: "../tool/cli.js" },
      ["node_modules/tool/cli.js"],
    );
    const row = await runCheck({ caseId, kind: "test", phase: "baseline", target: "original", consent: true }, ctx);
    expect(row.status, row.outputExcerpt ?? "").toBe("passed");
    expect(row.outputExcerpt).toContain("tool ran");
  });

  test("a hanging project times out: recorded as timed_out and the container is gone", async () => {
    const caseId = await newCase({ name: "hang", scripts: { test: "node test.js" } }, { "test.js": "setInterval(() => {}, 1000)" });
    const row = await runCheck({ caseId, kind: "test", phase: "baseline", target: "original", consent: true }, { ...ctx, limits: { ...ctx.limits, timeoutSec: 3 } });
    expect(row.status).toBe("timed_out");
    expect(await containerExists(row.id)).toBe(false);
  });

  test("the project has no network", async () => {
    const caseId = await newCase(
      { name: "net", scripts: { test: "node test.js" } },
      { "test.js": 'fetch("https://example.com").then(() => { console.log("REACHED"); process.exit(1) }, () => { console.log("no network"); process.exit(0) })' },
    );
    const row = await runCheck({ caseId, kind: "test", phase: "baseline", target: "original", consent: true }, ctx);
    expect(row.status, row.outputExcerpt ?? "").toBe("passed");
    expect(row.outputExcerpt).toContain("no network");
  });

  test("cancelling mid-run stops the container and is recorded as cancelled", async () => {
    const caseId = await newCase({ name: "cancel", scripts: { test: "node test.js" } }, { "test.js": "setInterval(() => {}, 1000)" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 2000);
    const row = await runCheck({ caseId, kind: "test", phase: "baseline", target: "original", consent: true, signal: controller.signal }, ctx);
    expect(row).toMatchObject({ status: "unrunnable", unrunnableReason: "cancelled" });
    expect(await containerExists(row.id)).toBe(false);
  });

  test("a missing image is recorded as unrunnable / image_missing", async () => {
    const caseId = await newCase({ name: "img", scripts: { test: "node test.js" } }, { "test.js": "" });
    const row = await runCheck({ caseId, kind: "test", phase: "baseline", target: "original", consent: true }, { ...ctx, limits: { ...ctx.limits, image: "revenant-no-such-image:0.0.0" } });
    expect(row).toMatchObject({ status: "unrunnable", unrunnableReason: "image_missing" });
  });
});

test.skipIf(ready)("real sandbox runner tests were SKIPPED: Docker or the node:lts-slim image is not available", () => {});
