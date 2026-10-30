import type { CheckKind } from "@/lib/sandbox/checks";

// The verdict is decided here, from check results only. Nothing from the model is an input and nothing in `lib/ai`
// is imported, so no AI output can raise or lower it. Anything missing resolves to `unverified`, never `resurrected`.

export type Verdict = "resurrected" | "partially_repaired" | "failed" | "unverified";
export type RunStatus = "passed" | "failed" | "timed_out" | "unrunnable";

/** The part of a stored check run the verdict reads. Runs are given oldest first: the newest run of a kind wins. */
export type VerdictRun = { phase: "baseline" | "after"; checkKind: CheckKind; status: RunStatus };

export type VerdictOptions = {
  /** The user chose Skip Verification. */
  skipped?: boolean;
  /** The check run the finding cites. If it failed at baseline, its kind is the target check. */
  citedRunId?: string | null;
};

export type VerdictResult = { verdict: Verdict; reason: string; remainingIssues: string[] };

const failedLike = (status: RunStatus | undefined) => status === "failed" || status === "timed_out";
const unverified = (reason: string, remainingIssues: string[] = []): VerdictResult => ({ verdict: "unverified", reason, remainingIssues });

const WORDS: Record<RunStatus, string> = { passed: "passed", failed: "failed", timed_out: "timed out", unrunnable: "could not run" };
const describe = (kind: CheckKind, status: RunStatus | undefined) => `${kind}: ${status ? WORDS[status] : "was not run"} after the repair`;

/**
 * target check = the baseline-failed check the finding cites, else the first baseline-failed selected check
 * - no check failed at baseline, or nothing was run, or the user skipped -> unverified
 * - the target's after-run is missing or unrunnable -> unverified
 * - the target's after-run failed or timed out -> failed
 * - the target passed and every other selected check passed after -> resurrected
 * - the target passed but another selected check did not -> partially_repaired
 * "Selected" means every check kind that appears in `runs`.
 */
export function computeVerdict(runs: readonly (VerdictRun & { id?: string })[], options: VerdictOptions = {}): VerdictResult {
  if (options.skipped === true) return unverified("Verification was skipped by the user");
  if (!Array.isArray(runs) || runs.length === 0) return unverified("No check results exist, so a repair cannot be proven");

  const baseline = new Map<CheckKind, VerdictRun & { id?: string }>();
  const after = new Map<CheckKind, VerdictRun>();
  for (const run of runs) (run.phase === "baseline" ? baseline : after).set(run.checkKind, run); // later runs replace earlier ones
  const selected = [...new Set([...baseline.keys(), ...after.keys()])];

  const failedAtBaseline = [...baseline.values()].filter((r) => failedLike(r.status));
  if (failedAtBaseline.length === 0) {
    // "not reproduced" is a claim about the project; if a check could not even run, that is not what happened
    const couldNotRun = [...baseline.values()].filter((r) => r.status === "unrunnable");
    if (couldNotRun.length > 0) {
      const kinds = couldNotRun.map((r) => r.checkKind).join(", ");
      return unverified(`The ${kinds} check could not run on the original project, so nothing could be proven either way`, couldNotRun.map((r) => `${r.checkKind}: could not run on the original project`));
    }
    return unverified("The failure was not reproduced, so a fix cannot be proven");
  }

  const cited = failedAtBaseline.find((r) => options.citedRunId != null && r.id === options.citedRunId);
  const target = (cited ?? failedAtBaseline[0]).checkKind;
  const targetAfter = after.get(target)?.status;

  if (targetAfter === undefined) return unverified(`The ${target} check was not run on the repaired copy`, [describe(target, targetAfter)]);
  if (targetAfter === "unrunnable") return unverified(`The ${target} check could not run on the repaired copy`, [describe(target, targetAfter)]);

  const others = selected.filter((kind) => kind !== target);
  const notPassing = others.filter((kind) => after.get(kind)?.status !== "passed").map((kind) => describe(kind, after.get(kind)?.status));

  if (failedLike(targetAfter)) {
    return { verdict: "failed", reason: `The ${target} check still ${targetAfter === "timed_out" ? "timed out" : "fails"} after the repair`, remainingIssues: [describe(target, targetAfter), ...notPassing] };
  }
  if (notPassing.length > 0) {
    return { verdict: "partially_repaired", reason: `The ${target} check now passes, but ${notPassing.length === 1 ? "another check does" : "other checks do"} not`, remainingIssues: notPassing };
  }
  return { verdict: "resurrected", reason: `The ${target} check failed before the repair and passes after it${others.length > 0 ? `, and so does every other selected check (${others.join(", ")})` : ""}`, remainingIssues: [] };
}
