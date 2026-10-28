// Analyze both shipped samples with your real Ollama, and with nothing listening. Skipped (and reported) when the model is absent.
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { checkOllama } from "@/lib/ai/ollama-health";
import { removeTree } from "@/lib/cases/fs";
import { importSample, type ImportContext } from "@/lib/cases/import";
import { getCaseOr404 } from "@/lib/cases/store";
import { openDatabase, type OpenDatabase } from "@/lib/db/client";
import { analyses } from "@/lib/db/schema";
import { startAnalyze } from "@/lib/jobs/analyze";
import { getJobStatus } from "@/lib/jobs/runner";

const URL_ = "http://127.0.0.1:11434";
const MODEL = "gemma2:2b";
const ready = await checkOllama(URL_, MODEL, 20_000).then((h) => h.reachable && h.modelInstalled);

let root: string;
let open: OpenDatabase;
let ctx: ImportContext;
beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-analyzereal-")));
  mkdirSync(path.join(root, "home"));
  open = openDatabase(path.join(root, "data"));
  ctx = { db: open.db, dataDir: path.join(root, "data"), maxProjectBytes: 1e8, samplesDir: path.resolve("samples"), homeDir: path.join(root, "home") };
});
afterAll(async () => {
  open.sqlite.close();
  await removeTree(root);
});

const analyze = async (caseId: string, aiOptions: object) => {
  const { jobId, finished } = startAnalyze(caseId, { db: open.db, dataDir: ctx.dataDir, aiOptions });
  await finished;
  return getJobStatus(jobId, open.db);
};
const row = (caseId: string) => open.db.select().from(analyses).where(eq(analyses.caseId, caseId)).get()!;

describe.runIf(ready)("real model", { timeout: 240_000 }, () => {
  test.each(["broken-esm", "control-working"])("%s: a valid summary whose key files all exist", async (sample) => {
    const { id } = await importSample(sample, ctx);
    const job = await analyze(id, { url: URL_, model: MODEL, timeoutMs: 200_000 });
    expect(job.status).toBe("succeeded");
    const summary = JSON.parse(row(id).summaryJson!);
    console.log(`[analyze-real] ${sample}:`, JSON.stringify(summary));
    expect(row(id).model).toBe(MODEL);
    expect(getCaseOr404(id, open.db).stage).toBe("analyzed");
    const dir = path.join(ctx.dataDir, "cases", id, "original");
    for (const f of summary.key_files) expect(() => realpathSync(path.join(dir, f.path))).not.toThrow();
  });
});

test("Ollama not reachable: AI_UNAVAILABLE, inventory kept, no summary", async () => {
  const { id } = await importSample("broken-esm", ctx);
  const job = await analyze(id, { url: "http://127.0.0.1:1", model: MODEL, timeoutMs: 5000 });
  expect(job).toMatchObject({ status: "failed", errorCode: "AI_UNAVAILABLE" });
  expect(row(id).summaryJson).toBeNull();
  expect(JSON.parse(row(id).inventoryJson).name).toBeTruthy();
});
