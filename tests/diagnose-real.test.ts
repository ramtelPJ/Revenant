// The first slice for real: import a shipped sample, consent, run its check in Docker, and see what is recorded.
// Skipped (and the skip is reported) when Docker or the node:lts-slim image is not available.
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { removeTree } from "@/lib/cases/fs";
import { importSample, type ImportContext } from "@/lib/cases/import";
import { getCaseOr404 } from "@/lib/cases/store";
import { openDatabase, type OpenDatabase } from "@/lib/db/client";
import { checkRuns, findings } from "@/lib/db/schema";
import { startDiagnose } from "@/lib/jobs/diagnose";
import { getJobStatus } from "@/lib/jobs/runner";
import { runDocker } from "@/lib/sandbox/docker";
import { checkDocker } from "@/lib/sandbox/docker-health";
import { runCheck, type RunContext } from "@/lib/sandbox/run";

const health = await checkDocker("node:lts-slim", undefined, 30_000);
const ready = health.available && health.imagePresent;

let root: string;
let open: OpenDatabase;
let importCtx: ImportContext;
let runCtx: RunContext;

beforeAll(() => {
  if (!ready) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-diagreal-")));
  mkdirSync(path.join(root, "home"));
  open = openDatabase(path.join(root, "data"));
  importCtx = { db: open.db, dataDir: path.join(root, "data"), maxProjectBytes: 1e8, samplesDir: path.resolve("samples"), homeDir: path.join(root, "home") };
  runCtx = { db: open.db, dataDir: importCtx.dataDir, limits: { image: "node:lts-slim", memoryMb: 512, cpus: 1, timeoutSec: 60 }, docker: runDocker };
});
afterAll(async () => {
  if (!ready) return;
  open.sqlite.close();
  await removeTree(root);
});

const diagnose = async (caseId: string) => {
  const { jobId, finished } = startDiagnose(caseId, { captureBaseline: true, consent: true }, { db: open.db, dataDir: runCtx.dataDir, run: (input) => runCheck(input, runCtx), aiOptions: { url: "http://127.0.0.1:11434", model: "gemma2:2b", timeoutMs: 200_000 } });
  await finished;
  return getJobStatus(jobId, open.db);
};

describe.runIf(ready)("diagnose with the real sandbox and the shipped samples", { timeout: 300_000 }, () => {
  test("broken-esm: the real failure is captured, and no finding is invented", async () => {
    const { id } = await importSample("broken-esm", importCtx);
    const job = await diagnose(id);

    expect(job).toMatchObject({ status: "succeeded" });
    const [run] = open.db.select().from(checkRuns).where(eq(checkRuns.caseId, id)).all();
    expect(run).toMatchObject({ phase: "baseline", target: "original", checkKind: "test", status: "failed" });
    expect(run.exitCode).not.toBe(0);
    expect(run.outputExcerpt).toContain("ERR_REQUIRE_ASYNC_MODULE");
    expect(run.outputExcerpt).toContain("esm-greeter");
    const [finding] = open.db.select().from(findings).where(eq(findings.caseId, id)).all();
    console.log("[diagnose-real] broken-esm:", JSON.stringify(finding));
    expect(finding.category).toBe("module_format");
    expect(finding.label).toBe("confirmed_by_check");
    expect(finding.evidenceJson).toContain("src/index.js");
  });

  test("control-working: reported as 'no failure found'", async () => {
    const { id } = await importSample("control-working", importCtx);
    const job = await diagnose(id);

    expect(job).toMatchObject({ status: "succeeded", progressNote: "The check passed. No failure was found." });
    const [run] = open.db.select().from(checkRuns).where(eq(checkRuns.caseId, id)).all();
    expect(run).toMatchObject({ status: "passed", exitCode: 0 });
    expect(run.outputExcerpt).toContain("ok: greeting works");
    const [finding] = open.db.select().from(findings).where(eq(findings.caseId, id)).all();
    expect(finding).toMatchObject({ label: "no_failure_found", model: null, category: null });
    expect(getCaseOr404(id, open.db).stage).toBe("diagnosed");
  });
});

test.skipIf(ready)("real diagnose tests were SKIPPED: Docker or the node:lts-slim image is not available", () => {});
