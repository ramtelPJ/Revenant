import { ApiError } from "./api-client";

export const POLL_INTERVAL_MS = 1500;
const MAX_CONSECUTIVE_ERRORS = 5;

export type JobStep = { label: string; state: "pending" | "running" | "done" | "failed" };
export type JobView = {
  id: string;
  caseId: string;
  kind: "analyze" | "diagnose" | "propose_patch" | "verify";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progressNote: string | null;
  steps: JobStep[];
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

export const isFinished = (job: Pick<JobView, "status">) => job.status === "succeeded" || job.status === "failed" || job.status === "cancelled";

type PollOptions = {
  fetchJob: (signal: AbortSignal) => Promise<JobView>;
  onUpdate: (job: JobView) => void;
  onFinished?: (job: JobView) => void;
  /** Called once, when polling gives up because of an error. */
  onError: (error: unknown) => void;
  intervalMs?: number;
  maxConsecutiveErrors?: number;
};

/**
 * Asks for the job again after each answer (never two requests at once) until it is finished.
 * Returns `stop()`, which cancels the timer and any request in flight; nothing is reported after that.
 * A lost session, a missing job or a forbidden request stop it at once; a few network blips are tolerated.
 */
export function startPolling(options: PollOptions): () => void {
  const interval = options.intervalMs ?? POLL_INTERVAL_MS;
  const maxErrors = options.maxConsecutiveErrors ?? MAX_CONSECUTIVE_ERRORS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let errors = 0;

  const stop = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    controller?.abort();
  };

  const tick = async () => {
    controller = new AbortController();
    try {
      const job = await options.fetchJob(controller.signal);
      if (stopped) return;
      errors = 0;
      options.onUpdate(job);
      if (isFinished(job)) {
        stopped = true;
        options.onFinished?.(job);
        return;
      }
    } catch (error) {
      if (stopped) return;
      errors++;
      const fatal = error instanceof ApiError && [401, 403, 404].includes(error.status);
      if (fatal || errors >= maxErrors) {
        stopped = true;
        options.onError(error);
        return;
      }
    }
    if (!stopped) timer = setTimeout(tick, interval);
  };

  void tick();
  return stop;
}
