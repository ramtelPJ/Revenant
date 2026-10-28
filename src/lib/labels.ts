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
