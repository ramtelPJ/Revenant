"use client";
import { useState } from "react";
import type { JobView } from "@/lib/polling";

const WHAT: Record<JobView["kind"], string> = {
  analyze: "The project overview",
  diagnose: "The diagnosis",
  propose_patch: "The repair suggestion",
  verify: "The verification",
};

/** What to tell the person about a step that ended badly. Never a code, never a stack: the server's own plain sentence. */
export function describeLastStep(job: JobView): string {
  const what = WHAT[job.kind] ?? "The last step";
  if (job.errorCode === "SERVER_RESTARTED") return `${what} was interrupted by a restart. Run it again.`;
  if (job.status === "cancelled") return `${what} was cancelled.`;
  return job.errorMessage ? `${what} didn't finish: ${job.errorMessage}` : `${what} didn't finish. Try it again.`;
}

/**
 * A step from an earlier visit (or before a restart) that failed, was cancelled or was interrupted. A step that ends
 * while this page is open is already shown by its own progress panel, so it is not announced a second time.
 */
export function LastStepNotice({ job }: { job: JobView | null | undefined }) {
  const [openedAt] = useState(() => Date.now());
  if (!job || (job.finishedAt ?? 0) >= openedAt) return null;
  return (
    <p role="status" className="m-0 border border-warn/45 px-3 py-2.5 text-sm leading-normal">
      <span className="font-medium text-warn">Earlier step: </span>
      {describeLastStep(job)}
    </p>
  );
}
