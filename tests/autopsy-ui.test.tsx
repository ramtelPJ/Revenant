import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { AutopsyView } from "@/components/autopsy/autopsy-page";
import { EvidenceList } from "@/components/evidence-list";
import type { CaseDetail, CheckRun, Finding } from "@/lib/case-ui";
import { droppedNote, firstFile, parseEvidence, sourceHref } from "@/lib/evidence-ui";
import { FINDING_LABEL } from "@/lib/labels";
import type { JobView } from "@/lib/polling";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

const fileEv = { kind: "file", path: "src/index.js", startLine: 3, endLine: 3, quote: 'const g = require("esm-greeter");' };
const logEv = { kind: "log", excerpt: "Error [ERR_REQUIRE_ASYNC_MODULE]", origin: "check" };
const run = (over: Partial<CheckRun> = {}): CheckRun => ({
  id: "r1", patchId: null, phase: "baseline", checkKind: "test", commandLabel: "npm test", target: "original", status: "failed", exitCode: 1, outputExcerpt: "boom",
  unrunnableReason: null, durationMs: 480, limits: { memoryMb: 512, cpus: 1, pids: 256, timeoutSec: 120, network: "none" }, startedAt: 1, finishedAt: 2, ...over,
});
const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "f1", label: "confirmed_by_check", title: "Dependency is ESM-only", explanation: "require() cannot load it.", category: "module_format",
  evidence: [fileEv, logEv, { kind: "check", checkRunId: "r1" }], droppedCitations: 0, checkRunId: "r1", model: "gemma2:2b", createdAt: 1, ...over,
});
const detail = (over: Partial<CaseDetail> = {}): CaseDetail => ({
  id: "c1", name: "demo", sourceKind: "sample", sourceLabel: "demo", stage: "diagnosed", sizeBytes: 1, fileCount: 1, verdict: null, verdictReason: null,
  createdAt: 1, updatedAt: 1, analysis: null, latestFinding: finding(), latestPatch: null, activeJob: null, checkRuns: [run()], ...over,
});
const job = (over: Partial<JobView> = {}): JobView => ({ id: "j1", caseId: "c1", kind: "diagnose", status: "running", progressNote: null, steps: [], errorCode: null, errorMessage: null, createdAt: 1, startedAt: 1, finishedAt: null, ...over });
const view = (d: CaseDetail) => html(<AutopsyView detail={d} onChanged={() => {}} />);

describe("evidence helpers", () => {
  test("parseEvidence keeps well-formed items and ignores damaged ones", () => {
    const parsed = parseEvidence([fileEv, logEv, { kind: "check", checkRunId: "r1" }, { kind: "file", path: "a" }, { kind: "log" }, { kind: "x" }, null, "text", 4, { kind: "file", path: "a", quote: "q", startLine: 0 }]);
    expect(parsed.map((e) => e.kind)).toEqual(["file", "log", "check"]);
  });
  test("a file item without an end line is a single line", () => {
    expect(parseEvidence([{ kind: "file", path: "a.js", quote: "abc", startLine: 5 }])[0]).toMatchObject({ startLine: 5, endLine: 5 });
  });
  test("the dropped note counts only citations, never the check run, and is silent when nothing was dropped", () => {
    const items = parseEvidence([fileEv, logEv, { kind: "check", checkRunId: "r1" }]);
    expect(droppedNote(0, items)).toBeNull();
    expect(droppedNote(1, items)).toBe("1 of 3 citations could not be verified and was left out.");
    expect(droppedNote(2, items)).toBe("2 of 4 citations could not be verified and were left out.");
    expect(droppedNote(1, [])).toBe("1 of 1 citation could not be verified and was left out.");
  });
  test("firstFile and sourceHref", () => {
    expect(firstFile(parseEvidence([logEv, fileEv]))).toBe("src/index.js");
    expect(firstFile(parseEvidence([logEv]))).toBeNull();
    expect(sourceHref("c1", "src/a b&c.js")).toBe("/cases/c1?file=src%2Fa%20b%26c.js");
  });
  test("every stored label has its exact wording", () => {
    expect(Object.fromEntries(Object.entries(FINDING_LABEL).map(([k, v]) => [k, v.label]))).toEqual({
      confirmed_by_check: "Confirmed by Check", supported_by_files: "Supported by Files", hypothesis: "Hypothesis", no_failure_found: "No failure found",
    });
  });
});

describe("EvidenceList", () => {
  const list = (over: Partial<Parameters<typeof EvidenceList>[0]> = {}) => html(<EvidenceList caseId="c1" evidence={[fileEv, logEv, { kind: "check", checkRunId: "r1" }]} droppedCitations={0} checkRuns={[run()]} {...over} />);

  test("a file citation shows its path as a link to the source, its line and its excerpt", () => {
    const out = list();
    expect(out).toContain('href="/cases/c1?file=src%2Findex.js"');
    expect(out).toContain("line 3");
    expect(out).toContain("esm-greeter");
  });
  test("a log excerpt says where it came from", () => {
    expect(list()).toContain("From the check&#x27;s output");
    expect(list({ evidence: [{ ...logEv, origin: "log" }] })).toContain("From the error log you added");
  });
  test("the linked check run is drawn with its recorded result", () => {
    const out = list();
    expect(out).toContain("npm test");
    expect(out).toContain("Failed");
  });
  test("a missing check run is said plainly, not drawn empty", () => {
    expect(list({ checkRuns: [] })).toContain("no longer available");
  });
  test("the dropped-citation note appears only when something was dropped", () => {
    expect(list()).not.toContain("could not be verified and");
    expect(list({ droppedCitations: 2 })).toContain("2 of 4 citations could not be verified and were left out.");
  });
  test("with no verified evidence it says so", () => {
    expect(list({ evidence: [] })).toContain("No citation could be verified");
  });
  test("excerpts are text, never markup", () => {
    const evil = [{ kind: "file", path: "<img src=x>.js", startLine: 1, endLine: 1, quote: "<script>alert(1)</script>" }, { kind: "log", excerpt: "<b onclick=x>", origin: "log" }];
    const out = list({ evidence: evil });
    expect(out).not.toMatch(/<img|<script|<b /);
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("AutopsyView", () => {
  test("a confirmed finding: title, exact label, explanation and evidence", () => {
    const out = view(detail());
    expect(out).toContain("Dependency is ESM-only");
    expect(out).toContain("Confirmed by Check");
    expect(out).toContain("require() cannot load it.");
    expect(out).toContain("module format");
    expect(out).toContain("Explanation written by gemma2:2b");
    expect(out).toContain("not from the model&#x27;s own confidence");
  });
  test.each([["supported_by_files", "Supported by Files"], ["hypothesis", "Hypothesis"]] as const)("label %s is shown as %s", (label, text) => {
    expect(view(detail({ latestFinding: finding({ label, checkRunId: null }) }))).toContain(text);
  });
  test("a finding with unverifiable citations says how many were dropped", () => {
    expect(view(detail({ latestFinding: finding({ label: "hypothesis", evidence: [], droppedCitations: 3 }) }))).toContain("3 of 3 citations could not be verified and were left out.");
  });
  test("a control project says 'No failure found' plainly, never implies the project is broken, and cannot propose a repair", () => {
    const out = view(detail({ latestFinding: finding({ label: "no_failure_found", title: "No failure found", category: null, evidence: [{ kind: "check", checkRunId: "r1" }], explanation: "The check passed." }), checkRuns: [run({ status: "passed", exitCode: 0 })] }));
    expect(out).toContain("No failure found");
    expect(out).toContain("does not say the project is free of problems");
    expect(out).not.toMatch(/Confirmed by Check|Hypothesis|Supported by Files/);
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Propose Repair/);
    expect(out).toContain("There is nothing to repair");
    expect(out).not.toContain("module format");
  });
  test("actions: Back, View Source for the first cited file", () => {
    const out = view(detail());
    expect(out).toContain('href="/cases/c1"');
    expect(out).toMatch(/<a[^>]*href="\/cases\/c1\?file=src%2Findex\.js"[^>]*>View Source/);
  });
  test("View Source is off when no file is cited", () => {
    expect(view(detail({ latestFinding: finding({ evidence: [logEv] }) }))).toMatch(/<button[^>]*disabled[^>]*>View Source/);
  });
  test("no finding yet: says so, offers the log box, and has no label or repair", () => {
    const out = view(detail({ latestFinding: null }));
    expect(out).toContain("No diagnosis yet");
    expect(out).toContain("Add Error Log");
    expect(out).not.toContain("Confirmed by Check");
  });
  test("the log box starts empty with Save and Diagnose both off", () => {
    const out = view(detail());
    expect(out).toContain("<textarea");
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Save log/);
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Diagnose with the logs/);
  });
  test("an active job turns the log actions off and shows progress", () => {
    const out = view(detail({ activeJob: job() }));
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Save log/);
    expect(out).toContain("Starting…");
  });
  test("every model and project string is text", () => {
    const evil = finding({ title: "<img src=x onerror=1>", explanation: "<script>x</script>", evidence: [{ kind: "log", excerpt: "<i>", origin: "log" }] });
    const out = view(detail({ latestFinding: evil }));
    expect(out).not.toMatch(/<img|<script|<i>/);
  });
});
