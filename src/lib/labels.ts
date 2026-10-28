// Words and tones for stages and verdicts. Only stored values are turned into words here; nothing is inferred.
export type Stage = "imported" | "analyzed" | "diagnosed" | "patched" | "verified";
export type Verdict = "resurrected" | "partially_repaired" | "failed" | "unverified";
export type Tone = "ok" | "warn" | "bad" | "neutral";

export const STAGE_LABEL: Record<Stage, string> = {
  imported: "Imported",
  analyzed: "Overview ready",
  diagnosed: "Diagnosed",
  patched: "Repair staged",
  verified: "Verified",
};

export const VERDICT_LABEL: Record<Verdict, { label: string; tone: Tone }> = {
  resurrected: { label: "Resurrected", tone: "ok" },
  partially_repaired: { label: "Partially repaired", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
  unverified: { label: "Unverified", tone: "neutral" },
};

export const TONE_TAG: Record<Tone, string> = { ok: "tag-ok", warn: "tag-warn", bad: "tag-bad", neutral: "tag-neutral" };

export type FindingLabel = "confirmed_by_check" | "supported_by_files" | "hypothesis" | "no_failure_found";

/** How a stored finding label is shown. The label is decided in code on the server; this only gives it words. */
export const FINDING_LABEL: Record<FindingLabel, { label: string; tone: Tone }> = {
  confirmed_by_check: { label: "Confirmed by Check", tone: "ok" },
  supported_by_files: { label: "Supported by Files", tone: "warn" },
  hypothesis: { label: "Hypothesis", tone: "warn" },
  no_failure_found: { label: "No failure found", tone: "ok" },
};
