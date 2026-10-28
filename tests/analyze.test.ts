import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { removeTree } from "@/lib/cases/fs";
import { importFolder, type ImportContext } from "@/lib/cases/import";
import { getCaseOr404 } from "@/lib/cases/store";
import { openDatabase, type OpenDatabase } from "@/lib/db/client";
import { analyses } from "@/lib/db/schema";
import { AppError } from "@/lib/http/respond";
import { startAnalyze, verifiedKeyFiles } from "@/lib/jobs/analyze";
import { getJobStatus } from "@/lib/jobs/runner";
import type { chatJson } from "@/lib/ai/ollama";

let root: string;
let open: OpenDatabase;
let importCtx: ImportContext;

const newCase = async () => {
  const dir = path.join(root, "src", crypto.randomUUID());
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "p", main: "index.js", scripts: { test: "node test.js" } }));
  writeFileSync(path.join(dir, "index.js"), "module.exports = 1;\n");
  writeFileSync(path.join(dir, ".env"), "SECRET=abcdefghijklmnop1234\n");
  return (await importFolder(dir, importCtx)).id;
};
const answer = (over: Record<string, unknown> = {}) =>
  vi.fn(async () => ({ data: { purpose: "Exports a number.", how_to_run: "npm test", key_files: [{ path: "index.js", reason: "entry" }], ...over }, model: "fake:1b", attempts: 1 as const })) as unknown as typeof chatJson & ReturnType<typeof vi.fn>;
const run = async (caseId: string, chat: typeof chatJson) => {
  const { jobId, finished } = startAnalyze(caseId, { db: open.db, dataDir: importCtx.dataDir, chat });
  await finished;
  return getJobStatus(jobId, open.db);
};
const rows = (caseId: string) => open.db.select().from(analyses).where(eq(analyses.caseId, caseId)).all();

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-analyze-")));
  mkdirSync(path.join(root, "home"));
  open = openDatabase(path.join(root, "data"));
  importCtx = { db: open.db, dataDir: path.join(root, "data"), maxProjectBytes: 1e8, samplesDir: path.join(root, "samples"), homeDir: path.join(root, "home") };
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  open.sqlite.close();
  await removeTree(root);
});

describe("analyze job", () => {
  test("saves inventory, summary and model, sets stage analyzed, never sends .env to the model", async () => {
    const id = await newCase();
    const chat = answer();
    const job = await run(id, chat);
    expect(job.status).toBe("succeeded");
    const [row] = rows(id);
    expect(JSON.parse(row.inventoryJson).name).toBe("p");
    expect(JSON.parse(row.summaryJson!).purpose).toBe("Exports a number.");
    expect(row.model).toBe("fake:1b");
    expect(getCaseOr404(id, open.db).stage).toBe("analyzed");
    const sent = JSON.stringify((chat as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]);
    expect(sent).not.toContain("abcdefghijklmnop1234");
    expect(sent).toContain("untrusted");
  });

  test("drops key files that do not exist, are secret-like, or are duplicates", async () => {
    const id = await newCase();
    const chat = answer({ key_files: [{ path: "index.js", reason: "a" }, { path: "./index.js", reason: "dup" }, { path: "ghost.js", reason: "b" }, { path: ".env", reason: "c" }, { path: "../x.js", reason: "d" }, { path: "/app/package.json", reason: "e" }] });
    await run(id, chat);
    expect(JSON.parse(rows(id)[0].summaryJson!).key_files.map((f: { path: string }) => f.path)).toEqual(["index.js", "package.json"]);
  });

  test("AI unavailable: job fails with AI_UNAVAILABLE, inventory stays, no summary, stage unchanged", async () => {
    const id = await newCase();
    const chat = vi.fn(async () => { throw new AppError("AI_UNAVAILABLE", 503, "The local AI isn't running."); }) as unknown as typeof chatJson;
    const job = await run(id, chat);
    expect(job).toMatchObject({ status: "failed", errorCode: "AI_UNAVAILABLE" });
    const [row] = rows(id);
    expect(row.inventoryJson).toContain('"name":"p"');
    expect(row.summaryJson).toBeNull();
    expect(row.model).toBeNull();
    expect(getCaseOr404(id, open.db).stage).toBe("imported");
  });

  test("re-running replaces the analysis (one row), and a failed re-run clears the old summary", async () => {
    const id = await newCase();
    await run(id, answer({ purpose: "First." }));
    await run(id, answer({ purpose: "Second." }));
    expect(rows(id)).toHaveLength(1);
    expect(JSON.parse(rows(id)[0].summaryJson!).purpose).toBe("Second.");
    await run(id, vi.fn(async () => { throw new AppError("AI_UNAVAILABLE", 503, "x"); }) as unknown as typeof chatJson);
    expect(rows(id)).toHaveLength(1);
    expect(rows(id)[0].summaryJson).toBeNull();
  });

  test("a second start while one is running is 409", async () => {
    const id = await newCase();
    const { finished } = startAnalyze(id, { db: open.db, dataDir: importCtx.dataDir, chat: answer() });
    expect(() => startAnalyze(id, { db: open.db, dataDir: importCtx.dataDir, chat: answer() })).toThrowError(expect.objectContaining({ status: 409, code: "JOB_RUNNING" }));
    await finished;
  });

  test("unknown case is 404 and starts no job", () => {
    expect(() => startAnalyze("00000000-0000-4000-8000-000000000000", { db: open.db })).toThrowError(expect.objectContaining({ status: 404 }));
  });
});

test("verifiedKeyFiles keeps a real file", async () => {
  const id = await newCase();
  const dir = path.join(importCtx.dataDir, "cases", id, "original");
  expect(verifiedKeyFiles(dir, [{ path: "index.js", reason: "r" }])).toHaveLength(1);
});
