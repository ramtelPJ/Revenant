import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { CheckRunPair } from "@/components/lab/check-run-card";
import { VerifyView, pairRuns } from "@/components/verify/verify-page";
import type { CaseDetail, CheckRun, Patch } from "@/lib/case-ui";
import type { Health } from "@/lib/health-problems";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

const run = (over: Partial<CheckRun> = {}): CheckRun => ({
  id: "r", patchId: null, phase: "baseline", checkKind: "test", commandLabel: "npm test", target: "original", status: "failed", exitCode: 1, outputExcerpt: "boom",
  unrunnableReason: null, durationMs: 480, limits: { memoryMb: 512, cpus: 1, pids: 256, timeoutSec: 120, network: "none" }, startedAt: 1, finishedAt: 2, ...over,
});
const patch = (over: Partial<Patch> = {}): Patch => ({ id: "p1", findingId: "f1", attempt: 1, rationale: "r", diffText: "", filesAffected: [], status: "approved", model: "m", createdAt: 1, decidedAt: 2, ...over });
const detail = (over: Partial<CaseDetail> = {}): CaseDetail => ({
  id: "c1", name: "demo", sourceKind: "sample", sourceLabel: "demo", stage: "patched", sizeBytes: 1, fileCount: 1, verdict: null, verdictReason: null, createdAt: 1, updatedAt: 1,
  analysis: null, latestFinding: null, latestPatch: patch(), activeJob: null, checkRuns: [], ...over,
});
const CHECKS = [{ kind: "test" as const, command: "npm test" }, { kind: "build" as const, command: "npm run build" }];
const ready: Health = { ollama: { reachable: true, modelInstalled: true, model: "m" }, docker: { available: true, imagePresent: true, image: "node:lts-slim" }, limits: { maxArchiveMb: 100, maxProjectMb: 500, sandboxMemoryMb: 512, sandboxCpus: 1, checkTimeoutSec: 120 } };
const view = (d: CaseDetail, health: Health | null = ready, checks = CHECKS) => html(<VerifyView detail={d} checks={checks} health={health} onChanged={() => {}} />);
const button = (out: string, name: string) => new RegExp(`<button[^>]*>${name}</button>`).exec(out)?.[0] ?? "";

describe("VerifyView", () => {
  test("lists each check with its exact command, the isolation warning and the limits", () => {
    const out = view(detail());
    expect(out).toContain("npm test");
    expect(out).toContain("npm run build");
    expect(out).toContain("Project code will run inside a Docker container with no network access.");
    expect(out).toContain("512 MB memory");
    expect(out).toContain("120 s limit per check");
  });

  test("the consent box starts unticked and Run Checks is disabled until it is ticked", () => {
    const out = view(detail());
    expect(out).toMatch(/<input type="checkbox"[^>]*(?!checked)[^>]*\/><span>I allow/);
    expect(out).not.toMatch(/checked=""[^>]*\/><span>\s*I allow/);
    expect(button(out, "Run Checks")).toContain("disabled");
  });

  test("Skip Verification and Return to Repair are available", () => {
    const out = view(detail());
    expect(button(out, "Skip Verification")).not.toContain("disabled");
    expect(out).toContain('href="/cases/c1/repair"');
  });

  test("without an approved patch there is nothing to run or skip", () => {
    const out = view(detail({ latestPatch: patch({ status: "proposed" }) }));
    expect(out).toContain("Approve the suggested patch first.");
    expect(out).not.toContain("Run Checks");
    expect(out).not.toContain("Skip Verification");
  });

  test("while a step runs, every action is disabled", () => {
    const out = view(detail({ activeJob: { id: "j", caseId: "c1", kind: "verify", status: "running", progressNote: null, steps: [], errorCode: null, errorMessage: null, createdAt: 1, startedAt: 1, finishedAt: null } }));
    expect(button(out, "Running…")).toContain("disabled");
    expect(button(out, "Skip Verification")).toContain("disabled");
  });

  test("Docker not ready: the setup steps are shown, Run Checks stays off, and no verdict is claimed", () => {
    const out = view(detail(), { ...ready, docker: { available: false, imagePresent: false, image: "node:lts-slim" } });
    expect(out).toContain("Checks can&#x27;t run until Docker is ready.");
    expect(out).toContain("Start Docker");
    expect(button(out, "Run Checks")).toContain("disabled");
    expect(out).not.toContain("Resurrected");
  });

  test("a project with no scripts says there is nothing to run", () => {
    expect(view(detail(), ready, [])).toContain("nothing to run");
  });

  test("a stored verdict and its reason are shown with the before and after runs", () => {
    const out = view(detail({
      stage: "verified", verdict: "resurrected", verdictReason: "The test check failed before the repair and passes after it",
      checkRuns: [run({ id: "b" }), run({ id: "a", phase: "after", target: "working", patchId: "p1", status: "passed", exitCode: 0, outputExcerpt: "ok" })],
    }));
    expect(out).toContain("Resurrected");
    expect(out).toContain("passes after it");
    expect(out).toContain("Before: original project");
    expect(out).toContain("After: repaired copy");
  });

  test("an unverified result because a check could not run explains why", () => {
    const out = view(detail({
      stage: "verified", verdict: "unverified", verdictReason: "The test check could not run on the repaired copy",
      checkRuns: [run({ id: "b", status: "unrunnable", unrunnableReason: "docker_not_running" }), run({ id: "a", phase: "after", target: "working", patchId: "p1", status: "unrunnable", unrunnableReason: "docker_not_running" })],
    }));
    expect(out).toContain("Unverified");
    expect(out).toContain("Docker is installed but not running");
  });

  test("output is shown as text", () => {
    const out = view(detail({ checkRuns: [run({ outputExcerpt: "<script>alert(1)</script>" }), run({ id: "a", phase: "after", target: "working", patchId: "p1", outputExcerpt: "<img src=x onerror=1>" })] }));
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
  });
});

describe("pairRuns", () => {
  test("pairs the newest baseline with the newest after-run of this patch, per check, and ignores other patches", () => {
    const runs = [
      run({ id: "b1" }), run({ id: "b2" }),
      run({ id: "old", phase: "after", target: "working", patchId: "other" }),
      run({ id: "a1", phase: "after", target: "working", patchId: "p1" }), run({ id: "a2", phase: "after", target: "working", patchId: "p1" }),
      run({ id: "bb", checkKind: "build", commandLabel: "npm run build" }),
    ];
    const pairs = pairRuns(runs, "p1");
    expect(pairs.map((p) => [p.kind, p.before?.id, p.after?.id])).toEqual([["test", "b2", "a2"]]);
  });
  test("no after-runs for the patch means nothing to show", () => {
    expect(pairRuns([run()], "p1")).toEqual([]);
  });
});

describe("CheckRunPair", () => {
  test("a missing side says so", () => {
    expect(html(<CheckRunPair label="npm test" before={null} after={null} />)).toContain("has no run on the original project");
  });
});
