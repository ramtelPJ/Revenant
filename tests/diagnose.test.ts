import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { removeTree } from "@/lib/cases/fs";
import { importFolder, type ImportContext } from "@/lib/cases/import";
import { getCaseOr404 } from "@/lib/cases/store";
import { openDatabase, type OpenDatabase } from "@/lib/db/client";
import { checkRuns, errorLogs, findings, jobs } from "@/lib/db/schema";
import { AppError } from "@/lib/http/respond";
import type { chatJson } from "@/lib/ai/ollama";
import { explainUnrunnable, pickBaselineCheck, startDiagnose } from "@/lib/jobs/diagnose";
import { cancelJob, getJobStatus } from "@/lib/jobs/runner";
import type { DockerResult } from "@/lib/sandbox/docker";
import { runCheck, type RunCheckInput, type RunContext } from "@/lib/sandbox/run";

let root: string;
let open: OpenDatabase;
let docker: ReturnType<typeof vi.fn>;
let chat: ReturnType<typeof vi.fn>;
const answer = (over: Record<string, unknown> = {}) => ({ data: { title: "Cannot load ESM", explanation: "The dependency is ESM only.", category: "module_format", actionable: true, cites: [1], ...over }, model: "fake:1b", attempts: 1 });
let runCtx: RunContext;
let importCtx: ImportContext;

const finished = (over: Partial<Extract<DockerResult, { kind: "finished" }>> = {}): DockerResult => ({
  kind: "finished", exitCode: 0, timedOut: false, survived: false, aborted: false, output: "ok\n", truncated: false, durationMs: 5, ...over,
});

const newCase = async (manifest: Record<string, unknown> = { name: "p", scripts: { test: "node test.js" } }) => {
  const dir = path.join(root, "src", crypto.randomUUID());
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
  writeFileSync(path.join(dir, "test.js"), "console.log(1)");
  return (await importFolder(dir, importCtx)).id;
};

/** Starts a diagnose job against the fake sandbox and waits for it. */
const diagnose = async (caseId: string, input: { captureBaseline: boolean; consent?: unknown }) => {
  const { jobId, finished: done } = startDiagnose(caseId, input, {
    db: open.db,
    dataDir: runCtx.dataDir,
    run: (runInput: RunCheckInput) => runCheck(runInput, runCtx),
    chat: chat as unknown as typeof chatJson,
  });
  await done;
  return getJobStatus(jobId, open.db);
};
const runs = () => open.db.select().from(checkRuns).all();
const findingsOf = (caseId: string) => open.db.select().from(findings).where(eq(findings.caseId, caseId)).all();
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
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-diag-")));
  mkdirSync(path.join(root, "home"));
  open = openDatabase(path.join(root, "data"));
  docker = vi.fn(async () => finished());
  chat = vi.fn(async () => answer());
  runCtx = {
    db: open.db,
    dataDir: path.join(root, "data"),
    limits: { image: "node:lts-slim", memoryMb: 512, cpus: 1, timeoutSec: 120 },
    docker: docker as unknown as RunContext["docker"],
  };
  importCtx = { db: open.db, dataDir: runCtx.dataDir, maxProjectBytes: 1e8, samplesDir: path.join(root, "samples"), homeDir: path.join(root, "home") };
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  open.sqlite.close();
  await removeTree(root);
});

describe("consent", () => {
  test.each([[undefined], [false], ["true"], [1], [null], [{}]])("captureBaseline with consent = %j is refused: no job, no run, nothing spawned", async (consent) => {
    const caseId = await newCase();
    expect(code(() => startDiagnose(caseId, { captureBaseline: true, consent }, { db: open.db, dataDir: runCtx.dataDir }))).toBe("400 CONSENT_REQUIRED");
    expect(open.db.select().from(jobs).all()).toHaveLength(0);
    expect(runs()).toHaveLength(0);
    expect(docker).not.toHaveBeenCalled();
  });

  test("consent is checked before the case is looked up", () => {
    expect(code(() => startDiagnose("00000000-0000-4000-8000-000000000000", { captureBaseline: true }, { db: open.db }))).toBe("400 CONSENT_REQUIRED");
  });

  test("consent: true is passed through to the sandbox and recorded on the run", async () => {
    const caseId = await newCase();
    await diagnose(caseId, { captureBaseline: true, consent: true });
    expect(runs()[0].consentedAt).toBeGreaterThan(0);
  });

  test("without captureBaseline nothing is run, whatever consent says", async () => {
    const caseId = await newCase();
    for (const consent of [undefined, false, true]) {
      const job = await diagnose(caseId, { captureBaseline: false, consent });
      expect(job).toMatchObject({ status: "succeeded" });
      expect(job.progressNote).toContain("no failure output or error log");
    }
    expect(docker).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(runs()).toHaveLength(0);
    expect(findingsOf(caseId)).toHaveLength(0);
  });
});

describe("a project whose check passes", () => {
  test("is reported as 'no failure found' without guessing at problems", async () => {
    const caseId = await newCase();
    const job = await diagnose(caseId, { captureBaseline: true, consent: true });

    expect(job).toMatchObject({ status: "succeeded", progressNote: "The check passed. No failure was found." });
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({ phase: "baseline", target: "original", checkKind: "test", status: "passed" });

    const [finding] = findingsOf(caseId);
    expect(finding).toMatchObject({ label: "no_failure_found", title: "No failure found", category: null, model: null, checkRunId: null });
    expect(finding.explanation).toContain("does not mean the project is free of problems");
    expect(JSON.parse(finding.evidenceJson)).toEqual([{ kind: "check", checkRunId: runs()[0].id }]);
    expect(getCaseOr404(caseId, open.db).stage).toBe("diagnosed");
  });

  test("with an error log supplied it does NOT claim there is no failure: the model explains the log, never 'confirmed'", async () => {
    const caseId = await newCase();
    open.db.insert(errorLogs).values({ caseId, content: "Error: it crashes in production" }).run();
    chat.mockResolvedValue(answer({ cites: [1] }));
    const job = await diagnose(caseId, { captureBaseline: true, consent: true });
    expect(job.status).toBe("succeeded");
    const [finding] = findingsOf(caseId);
    expect(finding).toMatchObject({ label: "supported_by_files", checkRunId: null, model: "fake:1b" });
    expect(getCaseOr404(caseId, open.db).stage).toBe("diagnosed");
  });

  test("a pasted log without any baseline is diagnosed too, and can never be confirmed_by_check", async () => {
    const caseId = await newCase();
    open.db.insert(errorLogs).values({ caseId, content: "Error: ERR_REQUIRE_ASYNC_MODULE at test.js:1" }).run();
    const job = await diagnose(caseId, { captureBaseline: false });
    expect(job.status).toBe("succeeded");
    expect(docker).not.toHaveBeenCalled();
    expect(findingsOf(caseId)[0].label).toBe("supported_by_files");
  });

  test("running it again adds another finding; the case ends up with the newest", async () => {
    const caseId = await newCase();
    await diagnose(caseId, { captureBaseline: true, consent: true });
    await diagnose(caseId, { captureBaseline: true, consent: true });
    expect(findingsOf(caseId)).toHaveLength(2);
    expect(runs()).toHaveLength(2);
  });
});

describe("a project whose check fails", () => {
  test("a failed check is explained by the model, cited evidence is verified, and the label is confirmed_by_check", async () => {
    const caseId = await newCase();
    docker.mockResolvedValue(finished({ exitCode: 1, output: "Error [ERR_REQUIRE_ASYNC_MODULE]: require() cannot be used\n    at /app/test.js:1:1\n" }));
    const job = await diagnose(caseId, { captureBaseline: true, consent: true });

    expect(job).toMatchObject({ status: "succeeded", progressNote: "Diagnosis saved." });
    expect(job.progressNote).not.toContain("AI-005");
    expect(runs()[0]).toMatchObject({ status: "failed", exitCode: 1 });
    const [finding] = findingsOf(caseId);
    expect(finding).toMatchObject({ label: "confirmed_by_check", checkRunId: runs()[0].id, category: "module_format", title: "Cannot load ESM", model: "fake:1b" });
    expect(JSON.parse(finding.evidenceJson)).toContainEqual({ kind: "check", checkRunId: runs()[0].id });
    expect(getCaseOr404(caseId, open.db).stage).toBe("diagnosed");
  });

  test("the model sees numbered candidates and the label is not in its schema", async () => {
    const caseId = await newCase();
    docker.mockResolvedValue(finished({ exitCode: 1, output: "Error: boom happened\n" }));
    await diagnose(caseId, { captureBaseline: true, consent: true });
    const [schema, messages] = chat.mock.calls[0];
    expect(Object.keys(schema.shape)).not.toContain("label");
    expect(JSON.stringify(messages)).toContain("[1] output: Error: boom happened");
  });

  test("citations that do not exist are left out and counted; with none left the label is hypothesis", async () => {
    const caseId = await newCase();
    docker.mockResolvedValue(finished({ exitCode: 1, output: "Error: boom happened\n" }));
    chat.mockResolvedValue(answer({ cites: [7, 99] }));
    const job = await diagnose(caseId, { captureBaseline: true, consent: true });
    const [finding] = findingsOf(caseId);
    expect(finding).toMatchObject({ label: "hypothesis", checkRunId: null });
    expect(JSON.parse(finding.evidenceJson)).toEqual([]);
    expect(job.status).toBe("succeeded");
  });

  test("AI unavailable: the check run is kept, the job fails with AI_UNAVAILABLE, no finding, stage unchanged", async () => {
    const caseId = await newCase();
    docker.mockResolvedValue(finished({ exitCode: 1, output: "Error: boom happened\n" }));
    chat.mockRejectedValue(new AppError("AI_UNAVAILABLE", 503, "The local AI isn't running."));
    const job = await diagnose(caseId, { captureBaseline: true, consent: true });
    expect(job).toMatchObject({ status: "failed", errorCode: "AI_UNAVAILABLE" });
    expect(runs()).toHaveLength(1);
    expect(findingsOf(caseId)).toHaveLength(0);
    expect(getCaseOr404(caseId, open.db).stage).toBe("imported");
  });

  test("sandbox unavailable + a pasted log: diagnosed from the log, at most supported_by_files", async () => {
    const caseId = await newCase();
    docker.mockResolvedValue({ kind: "unavailable", reason: "docker_missing" });
    open.db.insert(errorLogs).values({ caseId, content: "Error: boom happened" }).run();
    chat.mockResolvedValue(answer({ cites: [1] }));
    await diagnose(caseId, { captureBaseline: true, consent: true });
    expect(runs()[0].status).toBe("unrunnable");
    expect(findingsOf(caseId)[0].label).toBe("supported_by_files");
  });

  test("a timeout is reported as such", async () => {
    const caseId = await newCase();
    docker.mockResolvedValue(finished({ exitCode: 137, timedOut: true }));
    const job = await diagnose(caseId, { captureBaseline: true, consent: true });
    expect(runs()[0].status).toBe("timed_out");
    expect(job.progressNote).toBe("The check did not finish within the time limit.");
    expect(findingsOf(caseId)).toHaveLength(0);
  });
});

describe("when the check cannot run, the job still succeeds and says why (never a pass or a failure)", () => {
  test.each([
    ["docker_missing", "Docker was not found"],
    ["docker_not_running", "not running"],
    ["image_missing", "sandbox image"],
  ] as const)("%s", async (reason, text) => {
    const caseId = await newCase();
    docker.mockResolvedValue({ kind: "unavailable", reason });
    const job = await diagnose(caseId, { captureBaseline: true, consent: true });
    expect(job.status).toBe("succeeded");
    expect(job.progressNote).toContain(text);
    expect(runs()[0]).toMatchObject({ status: "unrunnable", unrunnableReason: reason });
    expect(findingsOf(caseId)).toHaveLength(0);
  });

  test("dependencies not installed", async () => {
    const caseId = await newCase({ name: "p", scripts: { test: "node test.js" }, dependencies: { chalk: "^5" } });
    const job = await diagnose(caseId, { captureBaseline: true, consent: true });
    expect(runs()[0]).toMatchObject({ status: "unrunnable", unrunnableReason: "no_node_modules" });
    expect(job.progressNote).toContain("dependencies are not installed");
    expect(docker).not.toHaveBeenCalled();
  });

  test("no test and no start script: nothing is run and no row is written", async () => {
    const caseId = await newCase({ name: "p", scripts: { build: "tsc" } });
    const job = await diagnose(caseId, { captureBaseline: true, consent: true });
    expect(job).toMatchObject({ status: "succeeded", progressNote: "This project has no test or start script, so there is nothing to run." });
    expect(runs()).toHaveLength(0);
    expect(docker).not.toHaveBeenCalled();
  });
});

describe("which check is the baseline", () => {
  test("test wins over start; start is used when there is no test; build is never the baseline", () => {
    expect(pickBaselineCheck([{ kind: "start" }, { kind: "test" }, { kind: "build" }])).toBe("test");
    expect(pickBaselineCheck([{ kind: "build" }, { kind: "start" }])).toBe("start");
    expect(pickBaselineCheck([{ kind: "build" }])).toBeNull();
    expect(pickBaselineCheck([])).toBeNull();
  });

  test("end to end: a project with only a start script is run with start", async () => {
    const caseId = await newCase({ name: "p", scripts: { start: "node server.js" } });
    docker.mockResolvedValue(finished({ exitCode: 137, survived: true }));
    await diagnose(caseId, { captureBaseline: true, consent: true });
    expect(runs()[0]).toMatchObject({ checkKind: "start", status: "passed" });
  });
});

describe("explanations", () => {
  test("every reason has plain wording and unknown ones fall back safely", () => {
    for (const reason of ["docker_missing", "docker_not_running", "image_missing", "script_missing", "no_node_modules", "cancelled", "copy_failed"]) {
      expect(explainUnrunnable(reason).length, reason).toBeGreaterThan(20);
    }
    expect(explainUnrunnable("something_new")).toBe("The check could not run.");
    expect(explainUnrunnable(null)).toBe("The check could not run.");
    expect(explainUnrunnable("image_missing", "node:22-slim")).toContain("node:22-slim");
  });
});

describe("jobs", () => {
  test("a second diagnose for the same case while one runs is 409 JOB_RUNNING", async () => {
    const caseId = await newCase();
    let release!: () => void;
    docker.mockImplementation(() => new Promise<DockerResult>((resolve) => (release = () => resolve(finished()))));
    const first = startDiagnose(caseId, { captureBaseline: true, consent: true }, { db: open.db, dataDir: runCtx.dataDir, run: (i) => runCheck(i, runCtx) });
    await vi.waitFor(() => expect(docker).toHaveBeenCalled());
    expect(code(() => startDiagnose(caseId, { captureBaseline: false }, { db: open.db, dataDir: runCtx.dataDir }))).toBe("409 JOB_RUNNING");
    release();
    await first.finished;
  });

  test("an unknown case is 404", () => {
    expect(code(() => startDiagnose("00000000-0000-4000-8000-000000000000", { captureBaseline: false }, { db: open.db }))).toBe("404 NOT_FOUND");
  });

  test("progress steps are reported", async () => {
    const caseId = await newCase();
    const job = await diagnose(caseId, { captureBaseline: true, consent: true });
    expect(job.steps.map((s: { label: string }) => s.label)).toEqual(["Preparing", "Running the check in the sandbox", "Recording the result"]);
    expect(job.steps.every((s: { state: string }) => s.state === "done")).toBe(true);
  });

  test("cancelling while the check runs stops it: job cancelled, run recorded as cancelled, no finding", async () => {
    const caseId = await newCase();
    docker.mockImplementation(async (_args: string[], options: { signal?: AbortSignal }) => {
      await new Promise((resolve) => options.signal!.addEventListener("abort", resolve));
      return finished({ exitCode: 137, aborted: true, output: "partial" });
    });
    const { jobId, finished: done } = startDiagnose(caseId, { captureBaseline: true, consent: true }, { db: open.db, dataDir: runCtx.dataDir, run: (i) => runCheck(i, runCtx) });
    await vi.waitFor(() => expect(docker).toHaveBeenCalled());
    cancelJob(jobId, open.db);
    await done;

    expect(getJobStatus(jobId, open.db).status).toBe("cancelled");
    expect(runs()[0]).toMatchObject({ status: "unrunnable", unrunnableReason: "cancelled" });
    expect(findingsOf(caseId)).toHaveLength(0);
  });

  test("an error from the sandbox layer fails the job with that error's code", async () => {
    const caseId = await newCase();
    const { jobId, finished: done } = startDiagnose(caseId, { captureBaseline: true, consent: true }, {
      db: open.db,
      dataDir: runCtx.dataDir,
      run: async () => {
        throw new AppError("NOT_FOUND", 404, "We couldn't find that.");
      },
    });
    await done;
    expect(getJobStatus(jobId, open.db)).toMatchObject({ status: "failed", errorCode: "NOT_FOUND" });
  });
});

describe("POST /api/cases/:caseId/diagnose", () => {
  let POST: typeof import("@/app/api/cases/[caseId]/diagnose/route").POST;
  let signSession: typeof import("@/lib/http/session").signSession;
  let routeDb: typeof import("@/lib/db/client").getDb;
  let importFolderDefault: typeof import("@/lib/cases/import").importFolder;
  let routeRoot: string;

  beforeAll(async () => {
    routeRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-diagroute-")));
    vi.stubEnv("REVENANT_LAUNCH_TOKEN", "a".repeat(64));
    vi.stubEnv("REVENANT_SESSION_SECRET", "b".repeat(64));
    vi.stubEnv("OLLAMA_MODEL", "gemma2:2b");
    vi.stubEnv("PORT", "3000");
    vi.stubEnv("DATA_DIR", path.join(routeRoot, "data"));
    ({ POST } = await import("@/app/api/cases/[caseId]/diagnose/route"));
    ({ signSession } = await import("@/lib/http/session"));
    ({ getDb: routeDb } = await import("@/lib/db/client"));
    ({ importFolder: importFolderDefault } = await import("@/lib/cases/import"));
  });
  afterAll(async () => {
    const holder = globalThis as unknown as { __revenantDb?: { sqlite: { close(): void } } };
    holder.__revenantDb?.sqlite.close();
    delete holder.__revenantDb;
    await removeTree(routeRoot);
  });

  const post = (caseId: string, body: string | undefined, options: { cookie?: boolean; host?: string; headers?: Record<string, string> } = {}) =>
    POST(
      new Request(`http://127.0.0.1:3000/api/cases/${caseId}/diagnose`, {
        method: "POST",
        headers: {
          host: options.host ?? "127.0.0.1:3000",
          ...(body !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}),
          ...(options.cookie === false ? {} : { cookie: `revenant_session=${signSession()}` }),
          ...options.headers,
        },
        body,
      }),
      { params: Promise.resolve({ caseId }) },
    );
  const projectCase = async () => {
    const dir = path.join(routeRoot, "p", crypto.randomUUID());
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "r", scripts: { test: "node t.js" } }));
    return (await importFolderDefault(dir)).id;
  };
  const UNKNOWN = "00000000-0000-4000-8000-000000000000";

  test("captureBaseline without consent: 400 CONSENT_REQUIRED, and nothing was started", async () => {
    const id = await projectCase();
    for (const body of [{ captureBaseline: true }, { captureBaseline: true, consent: false }, { captureBaseline: true, consent: "true" }]) {
      const res = await post(id, JSON.stringify(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error.code).toBe("CONSENT_REQUIRED");
    }
    expect(routeDb().select().from(jobs).where(eq(jobs.caseId, id)).all()).toHaveLength(0);
    expect(routeDb().select().from(checkRuns).where(eq(checkRuns.caseId, id)).all()).toHaveLength(0);
  });

  test("captureBaseline false starts a job: 202 with a job id, and the job finishes", async () => {
    const id = await projectCase();
    const res = await post(id, JSON.stringify({ captureBaseline: false }));
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()).data;
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    await vi.waitFor(() => expect(getJobStatus(jobId, routeDb()).status).toBe("succeeded"));
  });

  test("bad bodies are 400 VALIDATION_FAILED: not JSON, missing or non-boolean captureBaseline", async () => {
    const id = await projectCase();
    for (const body of ["{ nope", "{}", JSON.stringify({ captureBaseline: "yes" }), JSON.stringify({ captureBaseline: 1 }), "null", "[]"]) {
      const res = await post(id, body);
      expect(res.status, body).toBe(400);
      expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
    }
  });

  test("a second request while the first job is active is 409 JOB_RUNNING", async () => {
    const id = await projectCase();
    routeDb().insert(jobs).values({ caseId: id, kind: "analyze", status: "running" }).run();
    const res = await post(id, JSON.stringify({ captureBaseline: false }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("JOB_RUNNING");
  });

  test("401 without a session, 403 for a wrong Host or foreign Origin, 404 for an unknown case, 400 for a malformed id", async () => {
    const id = await projectCase();
    const body = JSON.stringify({ captureBaseline: false });
    expect((await post(id, body, { cookie: false })).status).toBe(401);
    expect((await post(id, body, { host: "evil.example:3000" })).status).toBe(403);
    expect((await post(id, body, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await post(UNKNOWN, body)).status).toBe(404);
    expect((await post("not-a-uuid", body)).status).toBe(400);
  });
});
