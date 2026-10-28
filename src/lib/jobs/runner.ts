import { and, eq, inArray } from "drizzle-orm";
import { formatJob, type JobStep } from "@/lib/cases/detail";
import { getCaseOr404, getJobOr404 } from "@/lib/cases/store";
import { getDb, type Db } from "@/lib/db/client";
import { jobs, JOB_KINDS } from "@/lib/db/schema";
import { AppError } from "@/lib/http/respond";

export type Step = JobStep;
export type JobKind = (typeof JOB_KINDS)[number];

/** What a running job can do. Every write is ignored once the job has finished or been cancelled. */
export type JobContext = {
  jobId: string;
  signal: AbortSignal; // fires when the user cancels; long work should stop and throw
  plan(labels: string[]): void; // declare the steps, all pending
  step(label: string): void; // this step is now running; the previous running one is done
  note(text: string): void;
};
export type JobFn = (ctx: JobContext) => Promise<void>;

// On globalThis so `next dev` hot reloads keep the controllers of jobs that are still running.
const holder = globalThis as unknown as { __revenantJobs?: Map<string, AbortController> };
const controllers = () => (holder.__revenantJobs ??= new Map());

const ACTIVE = ["queued", "running"] as const;

function isUniqueViolation(error: unknown): boolean {
  for (let current = error as { code?: string; cause?: unknown } | undefined, depth = 0; current && depth < 4; depth++) {
    if (current.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
    current = current.cause as typeof current;
  }
  return false;
}

/**
 * Records a job for a case and runs `fn` in the background of this process. Returns as soon as the row exists.
 * At most one job per case is active (the database enforces it); `finished` resolves when `fn` is done and is
 * only for tests and callers that want to wait.
 */
export function startJob(caseId: string, kind: JobKind, fn: JobFn, db: Db = getDb()): { jobId: string; finished: Promise<void> } {
  getCaseOr404(caseId, db);

  let jobId: string;
  try {
    jobId = db.insert(jobs).values({ caseId, kind }).returning({ id: jobs.id }).get().id;
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError("JOB_RUNNING", 409, "Another step is still running for this case.");
    throw error;
  }

  const controller = new AbortController();
  controllers().set(jobId, controller);

  // writes only apply while the job is active, so a cancelled or finished job is never overwritten
  const write = (changes: Partial<typeof jobs.$inferInsert>) =>
    db
      .update(jobs)
      .set(changes)
      .where(and(eq(jobs.id, jobId), inArray(jobs.status, ACTIVE)))
      .run();

  let steps: Step[] = [];
  const saveSteps = () => write({ stepsJson: JSON.stringify(steps) });
  const context: JobContext = {
    jobId,
    signal: controller.signal,
    plan(labels) {
      steps = labels.map((label) => ({ label, state: "pending" }));
      saveSteps();
    },
    step(label) {
      steps = steps.map((s) => (s.state === "running" ? { ...s, state: "done" } : s));
      const existing = steps.findIndex((s) => s.label === label);
      if (existing >= 0) steps[existing] = { label, state: "running" };
      else steps.push({ label, state: "running" });
      saveSteps();
    },
    note: (text) => void write({ progressNote: text }),
  };

  const finished = (async () => {
    await Promise.resolve(); // let the caller receive the job id before any work starts
    try {
      if (controller.signal.aborted) return;
      write({ status: "running", startedAt: Date.now() });
      await fn(context);
      steps = steps.map((s) => (s.state === "running" ? { ...s, state: "done" } : s));
      write({ status: "succeeded", finishedAt: Date.now(), stepsJson: JSON.stringify(steps) });
    } catch (error) {
      steps = steps.map((s) => (s.state === "running" ? { ...s, state: "failed" } : s));
      if (controller.signal.aborted) {
        write({ status: "cancelled", finishedAt: Date.now(), stepsJson: JSON.stringify(steps) });
      } else if (error instanceof AppError) {
        write({ status: "failed", finishedAt: Date.now(), errorCode: error.code, errorMessage: error.message, stepsJson: JSON.stringify(steps) });
      } else {
        // the message may hold SQL, paths or file contents: log only the kind of error
        console.error(`[job ${jobId}] failed: ${error instanceof Error ? error.name : typeof error}`);
        write({ status: "failed", finishedAt: Date.now(), errorCode: "INTERNAL", errorMessage: "Something went wrong. Please try again.", stepsJson: JSON.stringify(steps) });
      }
    } finally {
      controllers().delete(jobId);
    }
  })();

  return { jobId, finished };
}

/** Stops a running job. The user's cancel is final: whatever the job does afterwards cannot change its status. */
export function cancelJob(jobId: string, db: Db = getDb()) {
  const job = getJobOr404(jobId, db);
  if (job.status !== "queued" && job.status !== "running") {
    throw new AppError("WRONG_STATE", 409, "That step has already finished.");
  }
  controllers().get(jobId)?.abort();
  db.update(jobs)
    .set({ status: "cancelled", finishedAt: Date.now() })
    .where(and(eq(jobs.id, jobId), inArray(jobs.status, ACTIVE)))
    .run();
  return formatJob(getJobOr404(jobId, db));
}

export const getJobStatus = (jobId: string, db: Db = getDb()) => formatJob(getJobOr404(jobId, db));
