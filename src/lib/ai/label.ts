import { extractFileRefs } from "./context";
import type { VerifiedEvidence } from "./evidence";

// How much to trust a finding is decided here, in code, from verified evidence and what a check really did.
// The model has no say: its answer has no label field, and nothing it writes is read as one.

export type FindingLabel = "confirmed_by_check" | "supported_by_files" | "hypothesis";
export type BaselineRun = { id: string; phase: string; target: string; status: string; outputExcerpt: string | null };
export type LabelResult = { label: FindingLabel; checkRunId: string | null };

/**
 * confirmed_by_check: the project's own check failed in the sandbox (before any patch) AND the finding cites that run's
 * output or a file the output names. supported_by_files: at least one verified citation. Otherwise hypothesis.
 * A passed, timed-out or unrunnable check never confirms anything.
 */
export function computeLabel(verified: VerifiedEvidence[], baseline: BaselineRun | null, projectDir: string): LabelResult {
  if (baseline && baseline.phase === "baseline" && baseline.target === "original" && baseline.status === "failed") {
    const named = new Set(extractFileRefs(baseline.outputExcerpt ?? "", projectDir).flatMap((ref) => (ref.rel ? [ref.rel] : [])));
    const cites = verified.some((e) => (e.kind === "log" ? e.origin === "check" && e.checkRunId === baseline.id : named.has(e.path)));
    if (cites) return { label: "confirmed_by_check", checkRunId: baseline.id };
  }
  return { label: verified.length > 0 ? "supported_by_files" : "hypothesis", checkRunId: null };
}
