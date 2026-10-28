import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { removeTree } from "@/lib/cases/fs";
import { createCase } from "@/lib/cases/store";
import { openDatabase, type OpenDatabase } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import { AppError } from "@/lib/http/respond";
import { cancelJob, getJobStatus, startJob, type JobFn } from "@/lib/jobs/runner";

let root: string;
let open: OpenDatabase;
let db: OpenDatabase["db"];

const mkCase = (name = "c") => createCase({ name, sourceKind: "sample", sourceLabel: "s", sizeBytes: 1, fileCount: 1 }, db).id;
const row = (jobId: string) => db.select().from(jobs).where(eq(jobs.id, jobId)).get()!;
const registry = () => (globalThis as unknown as { __revenantJobs?: Map<string, unknown> }).__revenantJobs;

/** A promise the test resolves later, to hold a job open at a known point. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return `${error.status} ${error.code}`;
    throw error;
  }
  return "no error";
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-jobs-")));
  open = openDatabase(path.join(root, "data"));
  db = open.db;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  open.sqlite.close();
  await removeTree(root);
});

describe("lifecycle", () => {
  test("queued at once, then running, then succeeded; steps and notes are visible while it runs", async () => {
    const caseId = mkCase();
    const hold = gate();
    const reached = gate();
    const { jobId, finished } = startJob(caseId, "analyze", async (ctx) => {
      ctx.plan(["Reading files", "Calling the model", "Saving"]);
      ctx.step("Reading files");
      ctx.note("Reading 12 files");
      reached.open();
      await hold.opened;
      ctx.step("Calling the model");
    }, db);

    expect(row(jobId)).toMatchObject({ status: "queued", caseId, kind: "analyze", startedAt: null, finishedAt: null }); // before any work starts

    await reached.opened;
    expect(getJobStatus(jobId, db)).toMatchObject({
      status: "running",
      progressNote: "Reading 12 files",
      steps: [{ label: "Reading files", state: "running" }, { label: "Calling the model", state: "pending" }, { label: "Saving", state: "pending" }],
    });
    expect(row(jobId).startedAt).not.toBeNull();

    hold.open();
    await finished;
    const done = getJobStatus(jobId, db);
    expect(done).toMatchObject({ status: "succeeded", errorCode: null, errorMessage: null });
    expect(done.steps).toEqual([{ label: "Reading files", state: "done" }, { label: "Calling the model", state: "done" }, { label: "Saving", state: "pending" }]);
    expect(done.finishedAt).toBeGreaterThanOrEqual(done.startedAt!);
    expect(registry()?.size ?? 0).toBe(0);
  });

  test("a job with no steps just succeeds", async () => {
    const { jobId, finished } = startJob(mkCase(), "verify", async () => {}, db);
    await finished;
    expect(getJobStatus(jobId, db)).toMatchObject({ status: "succeeded", steps: [] });
  });

  test("a step that is started again moves forward; an unplanned step is appended", async () => {
    const { jobId, finished } = startJob(mkCase(), "diagnose", async (ctx) => {
      ctx.plan(["A"]);
      ctx.step("A");
      ctx.step("Surprise");
    }, db);
    await finished;
    expect(getJobStatus(jobId, db).steps).toEqual([{ label: "A", state: "done" }, { label: "Surprise", state: "done" }]);
  });

  test("writes after the job ended are ignored", async () => {
    let late!: () => void;
    const { jobId, finished } = startJob(mkCase(), "analyze", async (ctx) => {
      late = () => ctx.note("too late");
      ctx.note("during");
    }, db);
    await finished;
    late();
    expect(row(jobId).progressNote).toBe("during");
  });

  test("an unknown case is 404 and creates no job", () => {
    expect(code(() => startJob("00000000-0000-4000-8000-000000000000", "analyze", async () => {}, db))).toBe("404 NOT_FOUND");
    expect(db.select().from(jobs).all()).toHaveLength(0);
  });
});

describe("failure", () => {
  test("an AppError becomes failed with its code and message, and the running step is marked failed", async () => {
    const { jobId, finished } = startJob(mkCase(), "analyze", async (ctx) => {
      ctx.plan(["Reading", "Asking the model"]);
      ctx.step("Reading");
      ctx.step("Asking the model");
      throw new AppError("AI_UNAVAILABLE", 503, "The local AI isn't available.");
    }, db);
    await finished;
    expect(getJobStatus(jobId, db)).toMatchObject({
      status: "failed",
      errorCode: "AI_UNAVAILABLE",
      errorMessage: "The local AI isn't available.",
      steps: [{ label: "Reading", state: "done" }, { label: "Asking the model", state: "failed" }],
    });
    expect(row(jobId).finishedAt).not.toBeNull();
  });

  test("an unexpected error is a generic INTERNAL failure: no message in the row, none in the log", async () => {
    const { jobId, finished } = startJob(mkCase(), "analyze", async () => {
      throw new Error("SELECT * FROM cases /Users/me/project/.env KEY=hunter2");
    }, db);
    await finished;
    const status = getJobStatus(jobId, db);
    expect(status).toMatchObject({ status: "failed", errorCode: "INTERNAL", errorMessage: "Something went wrong. Please try again." });
    expect(JSON.stringify(status)).not.toMatch(/SELECT|hunter2|\/Users/);
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).not.toMatch(/SELECT|hunter2|\/Users/);
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toContain(jobId);
  });

  test("a non-Error throw is also contained (no unhandled rejection)", async () => {
    const { jobId, finished } = startJob(mkCase(), "analyze", (async () => {
      throw "just a string";
    }) as JobFn, db);
    await expect(finished).resolves.toBeUndefined();
    expect(getJobStatus(jobId, db)).toMatchObject({ status: "failed", errorCode: "INTERNAL" });
  });

  test("a synchronous throw inside the job function is contained too", async () => {
    const { jobId, finished } = startJob(mkCase(), "analyze", (() => {
      throw new Error("sync boom");
    }) as JobFn, db);
    await finished;
    expect(getJobStatus(jobId, db).status).toBe("failed");
  });
});

describe("one active job per case", () => {
  test("a second job for the same case is 409 JOB_RUNNING while the first is active, whatever its kind", async () => {
    const caseId = mkCase();
    const hold = gate();
    const first = startJob(caseId, "analyze", async () => hold.opened, db);

    for (const kind of ["analyze", "diagnose", "propose_patch", "verify"] as const) {
      expect(code(() => startJob(caseId, kind, async () => {}, db)), kind).toBe("409 JOB_RUNNING");
    }
    expect(db.select().from(jobs).all()).toHaveLength(1); // no rejected job left a row

    hold.open();
    await first.finished;
    const second = startJob(caseId, "diagnose", async () => {}, db); // allowed again
    await second.finished;
    expect(db.select().from(jobs).all()).toHaveLength(2);
  });

  test("the guard also holds before the first job has started running (it is still queued)", () => {
    const caseId = mkCase();
    startJob(caseId, "analyze", async () => {}, db);
    expect(code(() => startJob(caseId, "diagnose", async () => {}, db))).toBe("409 JOB_RUNNING");
  });

  test("other cases are not blocked", async () => {
    const hold = gate();
    const a = startJob(mkCase("a"), "analyze", async () => hold.opened, db);
    const b = startJob(mkCase("b"), "analyze", async () => {}, db);
    await b.finished;
    expect(row(b.jobId).status).toBe("succeeded");
    hold.open();
    await a.finished;
  });

  test("a failed job does not block the next one", async () => {
    const caseId = mkCase();
    const failing = startJob(caseId, "analyze", async () => {
      throw new AppError("AI_UNAVAILABLE", 503, "down");
    }, db);
    await failing.finished;
    const next = startJob(caseId, "analyze", async () => {}, db);
    await next.finished;
    expect(row(next.jobId).status).toBe("succeeded");
  });
});

describe("cancel", () => {
  test("aborts the signal, marks the job cancelled at once, and the case can start a new job right away", async () => {
    const caseId = mkCase();
    let aborted = false;
    const started = gate();
    const { jobId, finished } = startJob(caseId, "analyze", async (ctx) => {
      ctx.signal.addEventListener("abort", () => (aborted = true));
      started.open();
      await new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("stopped"))));
    }, db);
    await started.opened;

    const result = cancelJob(jobId, db);
    expect(result).toMatchObject({ id: jobId, status: "cancelled" });
    expect(row(jobId).finishedAt).not.toBeNull();
    expect(aborted).toBe(true);

    const next = startJob(caseId, "diagnose", async () => {}, db); // not blocked by the cancelled job
    await Promise.all([finished, next.finished]);
    expect(row(jobId)).toMatchObject({ status: "cancelled", errorCode: null }); // the job's own error did not turn it into "failed"
    expect(row(next.jobId).status).toBe("succeeded");
  });

  test("a job that ignores the cancel and later succeeds stays cancelled", async () => {
    const hold = gate();
    const started = gate();
    const { jobId, finished } = startJob(mkCase(), "analyze", async (ctx) => {
      started.open();
      await hold.opened; // does not look at the signal
      ctx.note("still going");
    }, db);
    await started.opened;
    cancelJob(jobId, db);
    hold.open();
    await finished;
    expect(row(jobId)).toMatchObject({ status: "cancelled", progressNote: null });
  });

  test("a job cancelled before it starts never runs its function", async () => {
    let ran = false;
    const { jobId, finished } = startJob(mkCase(), "analyze", async () => {
      ran = true;
    }, db);
    cancelJob(jobId, db); // still queued: the function has not started
    await finished;
    expect(ran).toBe(false);
    expect(row(jobId).status).toBe("cancelled");
  });

  test("cancelling a finished job is 409, an unknown job 404", async () => {
    const { jobId, finished } = startJob(mkCase(), "analyze", async () => {}, db);
    await finished;
    expect(code(() => cancelJob(jobId, db))).toBe("409 WRONG_STATE");
    expect(code(() => cancelJob("00000000-0000-4000-8000-000000000000", db))).toBe("404 NOT_FOUND");
    const failed = startJob(mkCase("x"), "analyze", async () => {
      throw new AppError("X", 500, "x");
    }, db);
    await failed.finished;
    expect(code(() => cancelJob(failed.jobId, db))).toBe("409 WRONG_STATE");
  });

  test("cancelling twice: the second is 409", async () => {
    const started = gate();
    const { jobId, finished } = startJob(mkCase(), "analyze", async (ctx) => {
      started.open();
      await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));
    }, db);
    await started.opened;
    cancelJob(jobId, db);
    expect(code(() => cancelJob(jobId, db))).toBe("409 WRONG_STATE");
    await finished;
  });
});

describe("registry", () => {
  test("controllers are removed when jobs end, however they end", async () => {
    const caseId = mkCase();
    for (const fn of [async () => {}, async () => { throw new AppError("X", 500, "x"); }, async () => { throw new Error("y"); }] as JobFn[]) {
      const { finished } = startJob(caseId, "analyze", fn, db);
      await finished;
    }
    expect(registry()?.size ?? 0).toBe(0);
  });
});

describe("routes", () => {
  let routes: { status: typeof import("@/app/api/jobs/[jobId]/route").GET; cancel: typeof import("@/app/api/jobs/[jobId]/cancel/route").POST };
  let signSession: typeof import("@/lib/http/session").signSession;
  let routeDb: typeof import("@/lib/db/client").getDb;
  let routeRoot: string;

  beforeAll(async () => {
    routeRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-jobroutes-")));
    vi.stubEnv("REVENANT_LAUNCH_TOKEN", "a".repeat(64));
    vi.stubEnv("REVENANT_SESSION_SECRET", "b".repeat(64));
    vi.stubEnv("OLLAMA_MODEL", "gemma2:2b");
    vi.stubEnv("PORT", "3000");
    vi.stubEnv("DATA_DIR", path.join(routeRoot, "data"));
    routes = { status: (await import("@/app/api/jobs/[jobId]/route")).GET, cancel: (await import("@/app/api/jobs/[jobId]/cancel/route")).POST };
    ({ signSession } = await import("@/lib/http/session"));
    ({ getDb: routeDb } = await import("@/lib/db/client"));
  });
  afterAll(async () => {
    const holder = globalThis as unknown as { __revenantDb?: { sqlite: { close(): void } } };
    holder.__revenantDb?.sqlite.close();
    delete holder.__revenantDb;
    await removeTree(routeRoot);
  });

  const req = (method: string, cookie = true, host = "127.0.0.1:3000") =>
    new Request("http://127.0.0.1:3000/api/jobs/x", { method, headers: { host, ...(cookie ? { cookie: `revenant_session=${signSession()}` } : {}) } });
  const ctx = (jobId: string) => ({ params: Promise.resolve({ jobId }) });
  const UNKNOWN = "00000000-0000-4000-8000-000000000000";

  test("GET returns the job; malformed id 400; unknown 404; 401; 403", async () => {
    const rdb = routeDb();
    const caseId = createCase({ name: "r", sourceKind: "sample", sourceLabel: "s", sizeBytes: 1, fileCount: 1 }, rdb).id;
    const { jobId, finished } = startJob(caseId, "analyze", async (c) => { c.plan(["One"]); c.step("One"); c.note("hello"); }, rdb);
    await finished;

    const ok = await routes.status(req("GET"), ctx(jobId));
    expect(ok.status).toBe(200);
    expect((await ok.json()).data).toMatchObject({ id: jobId, caseId, kind: "analyze", status: "succeeded", progressNote: "hello", steps: [{ label: "One", state: "done" }] });

    expect((await routes.status(req("GET"), ctx("not-a-uuid"))).status).toBe(400);
    expect((await routes.status(req("GET"), ctx(UNKNOWN))).status).toBe(404);
    expect((await routes.status(req("GET", false), ctx(jobId))).status).toBe(401);
    expect((await routes.status(req("GET", true, "evil.example:3000"), ctx(jobId))).status).toBe(403);
  });

  test("POST cancel: 200 with the new status; a second time 409; unknown 404; malformed 400; 401; 403", async () => {
    const rdb = routeDb();
    const caseId = createCase({ name: "r2", sourceKind: "sample", sourceLabel: "s", sizeBytes: 1, fileCount: 1 }, rdb).id;
    const started = gate();
    const { jobId, finished } = startJob(caseId, "analyze", async (c) => { started.open(); await new Promise((r) => c.signal.addEventListener("abort", r)); }, rdb);
    await started.opened;

    expect((await routes.cancel(req("POST", false), ctx(jobId))).status).toBe(401);
    expect((await routes.cancel(req("POST", true, "evil.example:3000"), ctx(jobId))).status).toBe(403);
    const res = await routes.cancel(req("POST"), ctx(jobId));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ id: jobId, status: "cancelled" });
    await finished;
    expect((await routes.cancel(req("POST"), ctx(jobId))).status).toBe(409);
    expect((await routes.cancel(req("POST"), ctx(UNKNOWN))).status).toBe(404);
    expect((await routes.cancel(req("POST"), ctx("nope"))).status).toBe(400);
  });
});
