import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { DiffViewer } from "@/components/diff-viewer";
import { investigationSteps } from "@/components/lab/lab-page";
import { RepairView } from "@/components/repair/repair-page";
import type { CaseDetail, Patch } from "@/lib/case-ui";
import { parseUnifiedDiff } from "@/lib/diff-ui";
import { renderDiff } from "@/lib/patch/diff";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const before = 'a\nconst g = require("x");\nc\n';
const after = 'a\nconst g = import("x");\nc\n';
const diffText = renderDiff([{ path: "src/index.js", before, after }]);

const patch = (over: Partial<Patch> = {}): Patch => ({ id: "p1", findingId: "f1", attempt: 2, rationale: "Use import().", diffText, filesAffected: ["src/index.js"], status: "proposed", model: "gemma2:2b", createdAt: 1, decidedAt: null, ...over });
const detail = (over: Partial<CaseDetail> = {}): CaseDetail => ({
  id: "c1", name: "demo", sourceKind: "sample", sourceLabel: "demo", stage: "diagnosed", sizeBytes: 1, fileCount: 1, verdict: null, verdictReason: null, createdAt: 1, updatedAt: 1, analysis: null,
  latestFinding: { id: "f1", label: "confirmed_by_check", title: "ESM only", explanation: "e", category: "module_format", evidence: [], droppedCitations: 0, checkRunId: null, model: null, createdAt: 1 },
  latestPatch: patch(), activeJob: null, checkRuns: [], ...over,
});
const view = (d: CaseDetail) => html(<RepairView detail={d} onChanged={() => {}} />);

describe("parseUnifiedDiff", () => {
  test("a known edit gives one removed and one added line, with line numbers and context", () => {
    const [file] = parseUnifiedDiff(diffText);
    expect(file.path).toBe("src/index.js");
    const change = file.rows.find((r) => r.kind === "change");
    expect(change).toEqual({ kind: "change", left: { line: 2, text: 'const g = require("x");' }, right: { line: 2, text: 'const g = import("x");' } });
    expect(file.rows.filter((r) => r.kind === "ctx")).toHaveLength(2);
  });
  test("unequal blocks pair up and leave the missing side empty; junk is ignored", () => {
    const rows = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1,1 +1,2 @@\n-one\n+uno\n+dos\nnonsense\n")[0].rows;
    expect(rows.filter((r) => r.kind === "change").map((r) => r.kind === "change" && [r.left?.text ?? null, r.right?.text])).toEqual([["one", "uno"], [null, "dos"]]);
    expect(parseUnifiedDiff("not a diff")).toEqual([]);
  });
});

describe("DiffViewer", () => {
  test("shows removed and added text with signs, and markup in the diff stays text", () => {
    const out = html(<DiffViewer diffText={renderDiff([{ path: "a.js", before: "<script>alert(1)</script>\n", after: "<img src=x onerror=1>\n" }])} />);
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("−");
    expect(out).toContain("+");
  });
  test("an empty diff says so", () => expect(html(<DiffViewer diffText="" />)).toContain("no changes to show"));
});

describe("RepairView", () => {
  test("a proposed patch shows rationale, files, diff, label and all four actions", () => {
    const out = view(detail());
    for (const text of ["Use import().", "src/index.js", "Confirmed by Check", "Approve Patch", "Reject", "Regenerate Suggestion", "Back to Autopsy", "Suggestion 2"]) expect(out).toContain(text);
    expect(out).toContain('href="/cases/c1/autopsy"');
  });
  test("actions are disabled while a step runs", () => {
    const out = view(detail({ activeJob: { id: "j", caseId: "c1", kind: "propose_patch", status: "running", progressNote: null, steps: [], errorCode: null, errorMessage: null, createdAt: 1, startedAt: 1, finishedAt: null } }));
    expect(out.match(/<button[^>]*disabled/g)?.length).toBe(3);
  });
  test("an approved patch confirms the original is untouched and offers no approve", () => {
    const out = view(detail({ latestPatch: patch({ status: "approved" }) }));
    expect(out).toContain("original files were not touched");
    expect(out).not.toContain("Approve Patch");
  });
  test("no failure found: nothing to repair, no propose button", () => {
    const d = detail({ latestPatch: null });
    d.latestFinding!.label = "no_failure_found";
    const out = view(d);
    expect(out).toContain("nothing to repair");
    expect(out).not.toContain("Propose Repair");
  });
  test("no patch yet offers Propose Repair", () => expect(view(detail({ latestPatch: null }))).toContain("Propose Repair"));
});

describe("investigation steps", () => {
  const href = (d: CaseDetail, label: string) => investigationSteps(d).find((s) => s.label === label)?.href;
  test("Autopsy and Repair become links once there is a failure to look at", () => {
    expect(href(detail(), "Autopsy")).toBe("/cases/c1/autopsy");
    expect(href(detail(), "Repair")).toBe("/cases/c1/repair");
  });
  test("nothing links before a diagnosis, and Repair stays off when there is no failure", () => {
    const none = detail({ latestFinding: null });
    expect([href(none, "Autopsy"), href(none, "Repair")]).toEqual([undefined, undefined]);
    const fine = detail();
    fine.latestFinding!.label = "no_failure_found";
    expect(href(fine, "Autopsy")).toBe("/cases/c1/autopsy");
    expect(href(fine, "Repair")).toBeUndefined();
  });
  test("Verification is not offered yet and Overview is the current step", () => {
    const steps = investigationSteps(detail());
    const verification = steps.find((s) => s.label === "Verification");
    expect(verification?.href).toBeUndefined();
    expect(verification?.why).toBe("Appears after a patch is approved");
    expect(investigationSteps(detail({ latestPatch: patch({ status: "approved" }) })).find((s) => s.label === "Verification")?.href).toBe("/cases/c1/verify");
    expect(steps.filter((s) => s.current).map((s) => s.label)).toEqual(["Overview"]);
  });
});

describe("DiffViewer on a phone", () => {
  test("a stacked copy shows the removed line and the added line, each with its mark", () => {
    const out = html(<DiffViewer diffText={diffText} />);
    expect(out).toContain("sm:hidden");
    expect(out).toContain("bg-bad/15");
    expect(out).toContain("bg-ok/15");
  });
});
