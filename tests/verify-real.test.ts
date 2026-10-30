// End to end with the real sandbox on the broken-esm sample: baseline fails, a correct patch passes, a wrong one does not.
// Skipped (and the skip is reported) when Docker, the node:lts-slim image or the sample's dependencies are missing.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { removeTree } from "@/lib/cases/fs";
import { importFolder, type ImportContext } from "@/lib/cases/import";
import { openDatabase, type OpenDatabase } from "@/lib/db/client";
import { cases, checkRuns, findings, patches } from "@/lib/db/schema";
import { startVerify } from "@/lib/jobs/verify";
import { approvePatch } from "@/lib/patch/apply";
import { runDocker } from "@/lib/sandbox/docker";
import { checkDocker } from "@/lib/sandbox/docker-health";
import { runCheck, type RunContext } from "@/lib/sandbox/run";

const SAMPLE = path.resolve("samples/broken-esm");
const health = await checkDocker("node:lts-slim", undefined, 30_000);
const ready = health.available && health.imagePresent && existsSync(path.join(SAMPLE, "node_modules/esm-greeter"));

const ORIGINAL = 'const { greet } = require("esm-greeter");\n\nmodule.exports = function hello(name) {\n  return greet(name);\n};\n';
const CORRECT = [{ path: "src/index.js", search: ORIGINAL, replace: 'module.exports = async function hello(name) {\n  const { greet } = await import("esm-greeter");\n  return greet(name);\n};\n' }];
const WRONG = [{ path: "src/index.js", search: 'require("esm-greeter")', replace: 'import("esm-greeter")' }]; // a Promise has no greet()

let root: string;
let open: OpenDatabase;
let ctx: RunContext;
let importCtx: ImportContext;

const hashTree = (dir: string): string => {
  const hash = createHash("sha256");
  const visit = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = path.join(d, name);
      hash.update(path.relative(dir, full));
      if (lstatSync(full).isDirectory()) visit(full);
      else if (!lstatSync(full).isSymbolicLink()) hash.update(readFileSync(full));
    }
  };
  visit(dir);
  return hash.digest("hex");
};

beforeAll(() => {
  if (!ready) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-verify-real-")));
  mkdirSync(path.join(root, "home"));
  open = openDatabase(path.join(root, "data"));
  const env = { image: "node:lts-slim", memoryMb: 512, cpus: 1, timeoutSec: 120 };
  ctx = { db: open.db, dataDir: path.join(root, "data"), limits: env, docker: runDocker };
  importCtx = { db: open.db, dataDir: ctx.dataDir, maxProjectBytes: 1e9, samplesDir: path.join(root, "samples"), homeDir: path.join(root, "home") };
});
afterAll(async () => {
  if (!ready) return;
  open.sqlite.close();
  await removeTree(root);
});

async function approved(edits: unknown) {
  const caseId = (await importFolder(SAMPLE, importCtx)).id;
  const finding = open.db.insert(findings).values({ caseId, label: "supported_by_files", title: "ESM only", explanation: "e", evidenceJson: "[]" }).returning().get();
  const patch = open.db.insert(patches).values({ caseId, findingId: finding.id, attempt: 1, rationale: "r", editsJson: JSON.stringify(edits), diffText: "d", filesAffectedJson: "[]", model: "fake" }).returning().get();
  await approvePatch(caseId, patch.id, { db: open.db, dataDir: ctx.dataDir });
  return caseId;
}
const verify = async (caseId: string) => {
  const { finished } = startVerify(caseId, { consent: true, checks: ["test"] }, { db: open.db, dataDir: ctx.dataDir, run: (i) => runCheck(i, ctx) });
  await finished;
  return { runs: open.db.select().from(checkRuns).where(eq(checkRuns.caseId, caseId)).all(), row: open.db.select().from(cases).where(eq(cases.id, caseId)).get()! };
};

describe.skipIf(!ready)("real sandbox: broken-esm", () => {
  test("a correct patch: baseline failed, repaired copy passed -> resurrected, original untouched", async () => {
    const caseId = await approved(CORRECT);
    const before = hashTree(path.join(ctx.dataDir, "cases", caseId, "original"));
    const { runs, row } = await verify(caseId);
    expect(runs.map((r) => [r.phase, r.target, r.status])).toEqual([["baseline", "original", "failed"], ["after", "working", "passed"]]);
    expect(runs[0].outputExcerpt).toContain("ERR_REQUIRE_ASYNC_MODULE");
    expect(runs[1].outputExcerpt).toContain("ok: greeting works");
    expect(row).toMatchObject({ verdict: "resurrected", stage: "verified" });
    expect(hashTree(path.join(ctx.dataDir, "cases", caseId, "original"))).toBe(before);
  }, 180_000);

  test("a wrong patch: the repaired copy still fails -> failed", async () => {
    const caseId = await approved(WRONG);
    const { runs, row } = await verify(caseId);
    expect(runs.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(row.verdict).toBe("failed");
  }, 180_000);
});

test.skipIf(ready)("real sandbox verification skipped: Docker, the node:lts-slim image or samples/broken-esm dependencies are not available", () => {
  expect(ready).toBe(false);
});
