import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { removeTree } from "@/lib/cases/fs";
import { importFolder, type ImportContext } from "@/lib/cases/import";
import { openDatabase, type OpenDatabase } from "@/lib/db/client";
import { analyses, cases, checkRuns, findings, jobs, patches } from "@/lib/db/schema";
import { AppError } from "@/lib/http/respond";
import { REPORT_DISCLAIMER, buildReport } from "@/lib/report";
import { computeVerdict } from "@/lib/verdict";

let root: string;
let open: OpenDatabase;
let importCtx: ImportContext;

const newCase = async () => {
  const dir = path.join(root, "src", crypto.randomUUID());
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "p", scripts: { test: "node test.js" } }));
  return (await importFolder(dir, importCtx)).id;
};
let clock = 1000;
const run = (caseId: string, over: Partial<typeof checkRuns.$inferInsert>) =>
  open.db.insert(checkRuns).values({ caseId, phase: "baseline", checkKind: "test", commandLabel: "npm test", target: "original", status: "failed", exitCode: 1, limitsJson: "{}", consentedAt: 1, startedAt: clock++, ...over }).returning().get();

/** A case that went through the whole flow, with the verdict stored the way the verify job stores it. */
async function verified(baselineStatus: "passed" | "failed", afterStatus: "passed" | "failed" | "unrunnable", extra: { build?: "passed" | "failed" } = {}) {
  const caseId = await newCase();
  open.db.insert(analyses).values({ caseId, inventoryJson: "{}", summaryJson: JSON.stringify({ purpose: "p" }), model: "fake:1b" }).run();
  const baseline = run(caseId, { status: baselineStatus });
  const finding = open.db.insert(findings).values({ caseId, label: "confirmed_by_check", title: "ESM only", explanation: "e", category: "module_format", evidenceJson: JSON.stringify([{ kind: "check", checkRunId: baseline.id }]), checkRunId: baseline.id, model: "fake:1b" }).returning().get();
  const patch = open.db.insert(patches).values({ caseId, findingId: finding.id, attempt: 1, rationale: "Use import()", editsJson: "[]", diffText: "--- a/x\n+++ b/x\n", filesAffectedJson: '["src/index.js"]', status: "approved", model: "fake:1b" }).returning().get();
  const started = clock++;
  open.db.insert(jobs).values({ caseId, kind: "verify", status: "succeeded", startedAt: started }).run();
  const runs = [baseline];
  runs.push(run(caseId, { phase: "after", target: "working", patchId: patch.id, status: afterStatus, startedAt: started + 1 }));
  if (extra.build) {
    runs.push(run(caseId, { checkKind: "build", commandLabel: "npm run build", status: "passed", startedAt: started + 2 }));
    runs.push(run(caseId, { phase: "after", checkKind: "build", commandLabel: "npm run build", target: "working", patchId: patch.id, status: extra.build, startedAt: started + 3 }));
  }
  const result = computeVerdict(runs.map((r) => ({ id: r.id, phase: r.phase, checkKind: r.checkKind, status: r.status })), { citedRunId: baseline.id });
  open.db.update(cases).set({ stage: "verified", verdict: result.verdict, verdictReason: result.reason, verdictAt: 5 }).where(eq(cases.id, caseId)).run();
  return { caseId, patch, finding, result };
}
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return `${error.status} ${error.code}`;
    throw error;
  }
  return "no error";
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-report-")));
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

describe("buildReport: one report per verdict outcome", () => {
  test("resurrected", async () => {
    const { caseId, patch, finding } = await verified("failed", "passed");
    const report = buildReport(caseId, open.db);
    expect(report).toMatchObject({ caseId, verdict: "resurrected", verdictAt: 5, remainingIssues: [] });
    expect(report.verdictReason).toContain("passes after it");
    expect(report.finding).toMatchObject({ id: finding.id, title: "ESM only", label: "confirmed_by_check" });
    expect(report.patch).toMatchObject({ id: patch.id, rationale: "Use import()", diffText: "--- a/x\n+++ b/x\n", filesAffected: ["src/index.js"] });
    expect(report.checkRuns.baseline.map((r) => r.status)).toEqual(["failed"]);
    expect(report.checkRuns.after.map((r) => [r.status, r.patchId])).toEqual([["passed", patch.id]]);
  });

  test("failed", async () => {
    const { caseId } = await verified("failed", "failed");
    const report = buildReport(caseId, open.db);
    expect(report.verdict).toBe("failed");
    expect(report.remainingIssues).toEqual(["test: failed after the repair"]);
  });

  test("partially repaired lists the other check as a remaining issue", async () => {
    const { caseId } = await verified("failed", "passed", { build: "failed" });
    const report = buildReport(caseId, open.db);
    expect(report.verdict).toBe("partially_repaired");
    expect(report.remainingIssues).toEqual(["build: failed after the repair"]);
    expect(report.checkRuns.after.map((r) => r.checkKind)).toEqual(["test", "build"]);
  });

  test("unverified because a check could not run", async () => {
    const { caseId } = await verified("failed", "unrunnable");
    const report = buildReport(caseId, open.db);
    expect(report.verdict).toBe("unverified");
    expect(report.remainingIssues).toEqual(["test: could not run after the repair"]);
  });

  test("unverified because the failure was not reproduced (control project)", async () => {
    const { caseId } = await verified("passed", "passed");
    const report = buildReport(caseId, open.db);
    expect(report.verdict).toBe("unverified");
    expect(report.verdictReason).toContain("not reproduced");
  });

  test("skipped: unverified, the skip reason, and no after-runs shown", async () => {
    const { caseId } = await verified("failed", "passed");
    open.db.update(cases).set({ verdict: "unverified", verdictReason: "Verification was skipped by the user" }).where(eq(cases.id, caseId)).run();
    const report = buildReport(caseId, open.db);
    expect(report).toMatchObject({ verdict: "unverified", verdictReason: "Verification was skipped by the user", remainingIssues: [] });
    expect(report.checkRuns.after).toEqual([]);
    expect(report.checkRuns.baseline).toHaveLength(1);
  });
});

describe("buildReport: honesty", () => {
  test("the verdict and reason are the stored ones, even if the runs would now say something else", async () => {
    const { caseId } = await verified("failed", "failed");
    open.db.update(cases).set({ verdict: "resurrected", verdictReason: "stored words" }).where(eq(cases.id, caseId)).run();
    const report = buildReport(caseId, open.db);
    expect(report.verdict).toBe("resurrected");
    expect(report.verdictReason).toBe("stored words");
    expect(report.remainingIssues).toEqual(["test: failed after the repair"]); // still lists what did not pass
  });

  test("AI contribution lists what the model did, and the deterministic steps", async () => {
    const { caseId } = await verified("failed", "passed");
    const report = buildReport(caseId, open.db);
    expect(report.aiContribution).toEqual({ model: "fake:1b", aiSteps: ["overview", "diagnosis", "patch"], deterministicSteps: ["inventory", "labels", "checks", "verdict"] });
  });

  test("a step the model did not do is not claimed", async () => {
    const { caseId } = await verified("failed", "passed");
    open.db.delete(analyses).where(eq(analyses.caseId, caseId)).run();
    expect(buildReport(caseId, open.db).aiContribution.aiSteps).toEqual(["diagnosis", "patch"]);
  });

  test("every report carries the not-an-audit disclaimer", async () => {
    for (const [b, a] of [["failed", "passed"], ["failed", "failed"], ["passed", "passed"]] as const) {
      const { caseId } = await verified(b, a);
      expect(buildReport(caseId, open.db).disclaimer).toBe(REPORT_DISCLAIMER);
    }
    expect(REPORT_DISCLAIMER).toMatch(/not an audit/);
    expect(REPORT_DISCLAIMER).toMatch(/modernization/);
  });

  test("the approved patch is reported even when a newer proposal exists", async () => {
    const { caseId, finding, patch } = await verified("failed", "passed");
    open.db.insert(patches).values({ caseId, findingId: finding.id, attempt: 2, rationale: "newer", editsJson: "[]", diffText: "newer diff", filesAffectedJson: "[]", status: "proposed", model: "fake:1b" }).run();
    expect(buildReport(caseId, open.db).patch?.id).toBe(patch.id);
  });

  test("runs from an earlier verification are not mixed into the latest one", async () => {
    const { caseId, patch } = await verified("failed", "passed");
    // an earlier verification had also run a failing build; the latest chose only the test check
    run(caseId, { phase: "after", checkKind: "build", commandLabel: "npm run build", target: "working", patchId: patch.id, status: "failed", startedAt: 1 });
    const report = buildReport(caseId, open.db);
    expect(report.checkRuns.after.map((r) => r.checkKind)).toEqual(["test"]);
    expect(report.remainingIssues).toEqual([]);
  });
});

describe("buildReport: when there is no report", () => {
  test("a case without a verdict is 409", async () => {
    const caseId = await newCase();
    expect(code(() => buildReport(caseId, open.db))).toBe("409 WRONG_STATE");
  });

  test("a verdict without the verified stage is 409 too", async () => {
    const { caseId } = await verified("failed", "passed");
    open.db.update(cases).set({ stage: "patched" }).where(eq(cases.id, caseId)).run();
    expect(code(() => buildReport(caseId, open.db))).toBe("409 WRONG_STATE");
  });

  test("an unknown case is 404", () => {
    expect(code(() => buildReport("00000000-0000-4000-8000-000000000000", open.db))).toBe("404 NOT_FOUND");
  });
});
