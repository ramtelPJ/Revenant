import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { computeVerdict, type RunStatus, type VerdictRun } from "@/lib/verdict";

const b = (checkKind: VerdictRun["checkKind"], status: RunStatus, id?: string) => ({ phase: "baseline" as const, checkKind, status, id });
const a = (checkKind: VerdictRun["checkKind"], status: RunStatus) => ({ phase: "after" as const, checkKind, status });

describe("computeVerdict: every branch", () => {
  const cases: [string, Parameters<typeof computeVerdict>, string][] = [
    ["target failed, then passed, only check", [[b("test", "failed"), a("test", "passed")], {}], "resurrected"],
    ["target passed and so did every other selected check", [[b("test", "failed"), b("build", "passed"), a("test", "passed"), a("build", "passed")], {}], "resurrected"],
    ["a timed-out baseline counts as failing", [[b("test", "timed_out"), a("test", "passed")], {}], "resurrected"],
    ["target passed, another check failed after", [[b("test", "failed"), b("build", "passed"), a("test", "passed"), a("build", "failed")], {}], "partially_repaired"],
    ["target passed, another check timed out after", [[b("test", "failed"), b("build", "passed"), a("test", "passed"), a("build", "timed_out")], {}], "partially_repaired"],
    ["target passed, another check unrunnable after", [[b("test", "failed"), b("build", "passed"), a("test", "passed"), a("build", "unrunnable")], {}], "partially_repaired"],
    ["target passed, another selected check has no after-run", [[b("test", "failed"), b("build", "passed"), a("test", "passed")], {}], "partially_repaired"],
    ["target still fails", [[b("test", "failed"), a("test", "failed")], {}], "failed"],
    ["target times out after", [[b("test", "failed"), a("test", "timed_out")], {}], "failed"],
    ["target after-run unrunnable", [[b("test", "failed"), a("test", "unrunnable")], {}], "unverified"],
    ["target has no after-run", [[b("test", "failed")], {}], "unverified"],
    ["no check failed at baseline (control project)", [[b("test", "passed"), a("test", "passed")], {}], "unverified"],
    ["baseline unrunnable is not a reproduced failure", [[b("test", "unrunnable"), a("test", "passed")], {}], "unverified"],
    ["skipped, even with perfect runs", [[b("test", "failed"), a("test", "passed")], { skipped: true }], "unverified"],
    ["no runs at all", [[], {}], "unverified"],
    ["only after-runs, no baseline", [[a("test", "passed")], {}], "unverified"],
  ];
  test.each(cases)("%s -> %s", (_name, args, expected) => {
    expect(computeVerdict(...args).verdict).toBe(expected);
  });

  test("the finding's cited check is the target, not just the first failure", () => {
    const runs = [b("test", "failed", "r1"), b("build", "failed", "r2"), a("test", "failed"), a("build", "passed")];
    expect(computeVerdict(runs, { citedRunId: "r2" })).toMatchObject({ verdict: "partially_repaired" }); // build is the target and passed; test did not
    expect(computeVerdict(runs, { citedRunId: "r1" })).toMatchObject({ verdict: "failed" });
    expect(computeVerdict(runs, {})).toMatchObject({ verdict: "failed" }); // nothing cited: the first baseline failure (test)
    expect(computeVerdict(runs, { citedRunId: "nope" })).toMatchObject({ verdict: "failed" }); // an unknown id falls back
  });

  test("a cited run that did not fail at baseline is not used as the target", () => {
    const runs = [b("test", "passed", "r1"), b("build", "failed", "r2"), a("test", "passed"), a("build", "passed")];
    expect(computeVerdict(runs, { citedRunId: "r1" }).verdict).toBe("resurrected"); // build was the failure, and it was fixed
  });

  test("the newest run of a kind wins", () => {
    expect(computeVerdict([b("test", "failed"), a("test", "failed"), a("test", "passed")]).verdict).toBe("resurrected");
    expect(computeVerdict([b("test", "failed"), a("test", "passed"), a("test", "failed")]).verdict).toBe("failed");
  });

  test("results carry a plain reason and the remaining issues", () => {
    expect(computeVerdict([b("test", "failed"), a("test", "failed")])).toEqual({ verdict: "failed", reason: "The test check still fails after the repair", remainingIssues: ["test: failed after the repair"] });
    expect(computeVerdict([b("test", "failed"), b("build", "passed"), a("test", "passed"), a("build", "failed")]).remainingIssues).toEqual(["build: failed after the repair"]);
    expect(computeVerdict([b("test", "failed"), a("test", "passed")]).remainingIssues).toEqual([]);
    expect(computeVerdict([], { skipped: true }).reason).toBe("Verification was skipped by the user");
  });

  test("a check that could not run is never described as 'not reproduced'", () => {
    const unrunnableBaseline = computeVerdict([b("test", "unrunnable"), a("test", "unrunnable")]);
    expect(unrunnableBaseline.verdict).toBe("unverified");
    expect(unrunnableBaseline.reason).toBe("The test check could not run on the original project, so nothing could be proven either way");
    expect(unrunnableBaseline.reason).not.toMatch(/not reproduced/);
    expect(unrunnableBaseline.remainingIssues).toEqual(["test: could not run on the original project"]);
    // one check passed and another could not run: still not a claim that nothing fails
    expect(computeVerdict([b("test", "passed"), b("build", "unrunnable")]).reason).toMatch(/could not run/);
    // only checks that really ran and passed give 'not reproduced'
    expect(computeVerdict([b("test", "passed"), a("test", "passed")]).reason).toMatch(/not reproduced/);
  });

  test("garbage input never throws and never resurrects", () => {
    // @ts-expect-error not an array
    expect(computeVerdict(undefined).verdict).toBe("unverified");
    // @ts-expect-error not an array
    expect(computeVerdict(null).verdict).toBe("unverified");
  });
});

describe("T29: resurrected only when the baseline target failed, the after target passed and all selected after-checks passed", () => {
  const statuses: RunStatus[] = ["passed", "failed", "timed_out", "unrunnable"];
  const maybe = [...statuses, undefined] as const;

  test("exhaustive over two checks, every baseline and after status, with or without skip", () => {
    let resurrected = 0;
    for (const skipped of [false, true])
      for (const bt of statuses) for (const bb of statuses)
        for (const at of maybe) for (const ab of maybe) {
          const runs = [b("test", bt), b("build", bb), ...(at ? [a("test", at)] : []), ...(ab ? [a("build", ab)] : [])];
          const result = computeVerdict(runs, { skipped });
          // an independent statement of the rule: the first failed baseline is the target
          const failed = (s?: RunStatus) => s === "failed" || s === "timed_out";
          const target = failed(bt) ? { kind: "test", after: at, other: ab } : failed(bb) ? { kind: "build", after: ab, other: at } : null;
          const expected = !skipped && target !== null && target.after === "passed" && target.other === "passed";
          if (expected) resurrected++;
          expect(result.verdict === "resurrected", JSON.stringify({ runs, skipped, result })).toBe(expected);
          if (result.verdict === "resurrected") expect(result.remainingIssues).toEqual([]);
        }
    expect(resurrected).toBeGreaterThan(0);
  });
});

describe("verdict.ts stays free of the AI code", () => {
  test("it imports nothing from lib/ai", () => {
    const source = readFileSync(new URL("../src/lib/verdict.ts", import.meta.url), "utf8");
    const imports = source.split("\n").filter((l) => /^\s*(import|export)\b.*\bfrom\b/.test(l));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((l) => /\/ai(\/|["'])/.test(l))).toEqual([]);
  });
});
