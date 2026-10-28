"use client";
import { useState } from "react";
import { ApiError, apiFetch } from "@/lib/api-client";
import { useJob } from "@/lib/hooks";
import { isFinished, type JobStep, type JobView } from "@/lib/polling";

const STATUS: Record<JobView["status"], { label: string; tone: string }> = {
  queued: { label: "Waiting", tone: "text-muted" },
  running: { label: "Working", tone: "text-accent" },
  succeeded: { label: "Done", tone: "text-ok" },
  failed: { label: "Failed", tone: "text-bad" },
  cancelled: { label: "Cancelled", tone: "text-warn" },
};

// every state has a symbol AND a word, so colour is never the only signal
const STEP: Record<JobStep["state"], { symbol: string; word: string; tone: string }> = {
  pending: { symbol: "○", word: "waiting", tone: "text-muted" },
  running: { symbol: "●", word: "in progress", tone: "text-accent" },
  done: { symbol: "✓", word: "done", tone: "text-ok" },
  failed: { symbol: "✗", word: "failed", tone: "text-bad" },
};

type ViewProps = {
  job: JobView | null;
  error?: ApiError | null;
  onCancel?: () => void;
  cancelling?: boolean;
};

/** What a job looks like right now. All text comes from the server as plain strings and is shown as text. */
export function JobProgressView({ job, error, onCancel, cancelling }: ViewProps) {
  if (error && !job) {
    return (
      <div role="alert" className="rounded-md border border-bad/60 bg-surface px-4 py-3 text-sm">
        <p className="font-medium text-bad">Can&apos;t follow this step</p>
        <p className="mt-1 text-fg">{error.message}</p>
      </div>
    );
  }
  if (!job) return <p className="text-sm text-muted">Starting…</p>;

  const status = STATUS[job.status];
  return (
    <section aria-label="Progress" aria-live="polite" className="rounded-md border border-line bg-surface px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <p className={`font-medium ${status.tone}`}>{status.label}</p>
        {!isFinished(job) && onCancel && (
          <button type="button" onClick={onCancel} disabled={cancelling} className="rounded border border-line px-3 py-1 text-sm hover:bg-raised disabled:opacity-60">
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        )}
      </div>

      {job.steps.length > 0 && (
        <ol className="mt-3 space-y-1">
          {job.steps.map((step) => {
            const s = STEP[step.state];
            return (
              <li key={step.label} className="flex items-baseline gap-2 text-sm">
                <span aria-hidden="true" className={`w-4 text-center ${s.tone}`}>{s.symbol}</span>
                <span className={step.state === "pending" ? "text-muted" : "text-fg"}>{step.label}</span>
                <span className="sr-only">: {s.word}</span>
              </li>
            );
          })}
        </ol>
      )}

      {job.progressNote && <p className="mt-3 text-sm text-fg">{job.progressNote}</p>}
      {job.status === "failed" && job.errorMessage && <p role="alert" className="mt-3 text-sm text-bad">{job.errorMessage}</p>}
      {error && <p className="mt-3 text-sm text-warn">{error.message}</p>}
    </section>
  );
}

/** Follows a job, shows its progress, and lets the user cancel it. Calls `onFinished` once when it ends. */
export function JobPanel({ jobId, onFinished }: { jobId: string | null; onFinished?: (job: JobView) => void }) {
  const { job, error } = useJob(jobId, onFinished);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<ApiError | null>(null);
  if (!jobId) return null;

  const cancel = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      await apiFetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });
    } catch (e) {
      // "already finished" (409) just means the next poll shows the final state
      if (!(e instanceof ApiError && e.status === 409)) setCancelError(e instanceof ApiError ? e : null);
    } finally {
      setCancelling(false);
    }
  };

  return <JobProgressView job={job} error={error ?? cancelError} onCancel={cancel} cancelling={cancelling} />;
}
