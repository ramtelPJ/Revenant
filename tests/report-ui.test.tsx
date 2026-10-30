import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ReportProblem, ReportView } from "@/components/report/report-page";
import { RecentInvestigations } from "@/components/import/import-parts";
import type { CheckRun, Report } from "@/lib/case-ui";
import type { Verdict } from "@/lib/labels";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const run = (over: Partial<CheckRun> = {}): CheckRun => ({
  id: "r", patchId: null, phase: "baseline", checkKind: "test", commandLabel: "npm test", target: "original", status: "failed", exitCode: 1, outputExcerpt: "boom output",
  unrunnableReason: null, durationMs: 480, limits: { memoryMb: 512, cpus: 1, pids: 256, timeoutSec: 120, network: "none" }, startedAt: 1, finishedAt: 2, ...over,
});
const report = (over: Partial<Report> = {}): Report => ({
  caseId: "c1", name: "demo", verdict: "resurrected", verdictReason: "The test check failed before the repair and passes after it", verdictAt: 5,
  finding: { id: "f1", label: "confirmed_by_check", title: "Dependency is ESM-only", explanation: "require() cannot load it.", category: "module_format", evidence: [{ kind: "check", checkRunId: "b" }], droppedCitations: 0, checkRunId: "b", model: "gemma2:2b" },
  patch: { id: "p1", attempt: 1, diffText: "--- a/src/index.js\n+++ b/src/index.js\n@@ -1,1 +1,1 @@\n-old line\n+new line\n", rationale: "Load it with import().", filesAffected: ["src/index.js"], model: "gemma2:2b" },
  checkRuns: { baseline: [run({ id: "b" })], after: [run({ id: "a", phase: "after", target: "working", patchId: "p1", status: "passed", exitCode: 0, outputExcerpt: "ok output" })] },
  remainingIssues: [], aiContribution: { model: "gemma2:2b", aiSteps: ["overview", "diagnosis", "patch"], deterministicSteps: ["inventory", "labels", "checks", "verdict"] },
  disclaimer: "Passing these checks is not an audit.", ...over,
});
const view = (r: Report) => html(<ReportView report={r} />);

describe("ReportView", () => {
  test("shows the verdict, its reason, the failure, the evidence, the change, the AI account and the disclaimer", () => {
    const out = view(report());
    for (const text of ["Resurrected", "passes after it", "Dependency is ESM-only", "Confirmed by Check", "Before: original project", "After: repaired copy", "boom output", "ok output", "Load it with import().", "src/index.js", "old line", "new line", "gemma2:2b", "Passing these checks is not an audit."]) {
      expect(out, text).toContain(text);
    }
    expect(out).toContain("None among the checks that were run");
    expect(out).toContain('href="/cases/c1/repair"');
    expect(out).toContain('href="/cases/new"');
  });

  test.each<[Verdict, string]>([["resurrected", "Resurrected"], ["partially_repaired", "Partially repaired"], ["failed", "Failed"], ["unverified", "Unverified"]])("verdict %s is shown as %s, and 'Resurrected' appears only for resurrected", (verdict, words) => {
    const out = view(report({ verdict, verdictReason: "stored reason" }));
    expect(out).toContain(`>${words}</span>`);
    expect(/Resurrected/.test(out)).toBe(verdict === "resurrected");
  });

  test("remaining issues are listed", () => {
    const out = view(report({ verdict: "partially_repaired", remainingIssues: ["build: failed after the repair"] }));
    expect(out).toContain("build: failed after the repair");
    expect(out).not.toContain("None among the checks");
  });

  test("a skipped verification has no after evidence and says so", () => {
    const out = view(report({ verdict: "unverified", verdictReason: "Verification was skipped by the user", checkRuns: { baseline: [report().checkRuns.baseline[0]], after: [] } }));
    expect(out).toContain("Verification was skipped by the user");
    expect(out).toContain("has not run on the repaired copy yet");
  });

  test("no check runs at all says there is no before-and-after evidence", () => {
    expect(view(report({ verdict: "unverified", checkRuns: { baseline: [], after: [] } }))).toContain("no before-and-after evidence");
  });

  test("the AI account does not claim what the model did not do", () => {
    const out = view(report({ aiContribution: { model: "gemma2:2b", aiSteps: ["patch"], deterministicSteps: ["checks", "verdict"] } }));
    expect(out).toContain("wrote the suggested patch");
    expect(out).not.toContain("wrote the project overview");
    expect(view(report({ aiContribution: { model: null, aiSteps: [], deterministicSteps: ["verdict"] } }))).toContain("did not write any part of this result");
  });

  test("model, check and diff text stay text", () => {
    const out = view(report({
      finding: { ...report().finding!, title: "<script>alert(1)</script>", explanation: "<img src=x onerror=1>" },
      patch: { ...report().patch!, rationale: "<b>bold</b>", diffText: "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-<i>a</i>\n+<u>b</u>\n" },
    }));
    for (const tag of ["<script>", "<img", "<b>", "<i>", "<u>"]) expect(out).not.toContain(tag);
  });
});

describe("ReportProblem", () => {
  test("a case with no verdict (409) says 'Not verified yet' and links to verification", () => {
    const out = html(<ReportProblem caseId="c1" status={409} message="x" onRetry={() => {}} />);
    expect(out).toContain("Not verified yet");
    expect(out).toContain('href="/cases/c1/verify"');
    expect(out).not.toMatch(/Resurrected|Unverified|Failed/);
  });
  test("404 and other failures are told apart", () => {
    expect(html(<ReportProblem caseId="c1" status={404} message="x" onRetry={() => {}} />)).toContain("That case isn&#x27;t here");
    const other = html(<ReportProblem caseId="c1" status={0} message="Can&#x27;t reach Revenant." onRetry={() => {}} />);
    expect(other).toContain("Can&#x27;t open the report");
    expect(other).toContain("Try again");
  });
});

describe("Case Files uses the same verdict words", () => {
  test("each stored verdict gets the same badge text as the report", () => {
    for (const [verdict, words] of [["resurrected", "Resurrected"], ["partially_repaired", "Partially repaired"], ["failed", "Failed"], ["unverified", "Unverified"]] as const) {
      const out = html(<RecentInvestigations cases={[{ id: "c1", name: "demo", stage: "verified", verdict, updatedAt: 1 }]} now={2} />);
      expect(out).toContain(`>${words}</span>`);
    }
  });
});
