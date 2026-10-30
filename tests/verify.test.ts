import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { removeTree } from "@/lib/cases/fs";
import { importFolder, type ImportContext } from "@/lib/cases/import";
import { openDatabase, type OpenDatabase } from "@/lib/db/client";
import { cases, checkRuns, findings, jobs, patches } from "@/lib/db/schema";
import { AppError } from "@/lib/http/respond";
import { cancelJob, getJobStatus } from "@/lib/jobs/runner";
import { skipVerification, startVerify } from "@/lib/jobs/verify";
import { approvePatch } from "@/lib/patch/apply";
import type { DockerResult } from "@/lib/sandbox/docker";
import { runCheck, type RunCheckInput, type RunContext } from "@/lib/sandbox/run";

let root: string;
let open: OpenDatabase;
let docker: ReturnType<typeof vi.fn>;
let runCtx: RunContext;
let importCtx: ImportContext;

const GOOD = [{ path: "src/index.js", search: 'require("esm-greeter")', replace: 'import("esm-greeter")' }];
const WRONG = [{ path: "src/index.js", search: 'require("esm-greeter")', replace: 'require("esm-greeter") /* still broken */' }];

const finished = (over: Partial<Extract<DockerResult, { kind: "finished" }>> = {}): DockerResult => ({
  kind: "finished", exitCode: 0, timedOut: false, survived: false, aborted: false, output: "ok\n", truncated: false, durationMs: 5, ...over,
});

/**
 * A fake sandbox that behaves like the project would: it reads the copy it was asked to run, and "test" fails while
 * src/index.js still has a require() of the ESM package. "build" fails only if `src/build-broken` exists.
 */
const fakeDocker = async (args: string[]): Promise<DockerResult> => {
  const mount = args[args.indexOf("-v") + 1].split(":")[0];
  const broken = readFileSync(path.join(mount, "src/index.js"), "utf8").includes('require("esm-greeter")');
  const command = args.slice(-2).join(" ");
  if (command.includes("build")) return readFileSync(path.join(mount, "src/build-state"), "utf8").trim() === "bad" ? finished({ exitCode: 1, output: "build failed\n" }) : finished();
  return broken ? finished({ exitCode: 1, output: "Error [ERR_REQUIRE_ESM]\n" }) : finished();
};

const newCase = async (scripts: Record<string, string> = { test: "node test.js" }, index = 'const g = require("esm-greeter");\nmodule.exports = g;\n') => {
  const dir = path.join(root, "src", crypto.randomUUID());
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "p", main: "src/index.js", scripts }));
  writeFileSync(path.join(dir, "src/index.js"), index);
  writeFileSync(path.join(dir, "src/build-state"), "bad\n");
  return (await importFolder(dir, importCtx)).id;
};
const addPatch = async (caseId: string, edits: unknown = GOOD, approve = true) => {
  const finding = open.db.insert(findings).values({ caseId, label: "supported_by_files", title: "t", explanation: "e", evidenceJson: "[]" }).returning().get();
  const patch = open.db.insert(patches).values({ caseId, findingId: finding.id, attempt: 1, rationale: "r", editsJson: JSON.stringify(edits), diffText: "d", filesAffectedJson: "[]", model: "fake" }).returning().get();
  if (approve) await approvePatch(caseId, patch.id, { db: open.db, dataDir: runCtx.dataDir });
  return patch;
};
const verify = async (caseId: string, input: { consent?: unknown; checks: unknown }) => {
  const { jobId, finished: done } = startVerify(caseId, input, { db: open.db, dataDir: runCtx.dataDir, run: (i: RunCheckInput) => runCheck(i, runCtx) });
  await done;
  return getJobStatus(jobId, open.db);
};
const runsOf = (caseId: string) => open.db.select().from(checkRuns).where(eq(checkRuns.caseId, caseId)).all();
const caseRow = (id: string) => open.db.select().from(cases).where(eq(cases.id, id)).get()!;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return `${error.status} ${error.code}`;
    throw error;
  }
  return "no error";
};
const start = (caseId: string, input: { consent?: unknown; checks: unknown }) => startVerify(caseId, input, { db: open.db, dataDir: runCtx.dataDir });

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-verify-")));
  mkdirSync(path.join(root, "home"));
  open = openDatabase(path.join(root, "data"));
  docker = vi.fn(fakeDocker);
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

describe("consent (auth T14)", () => {
  test.each([[undefined], [false], ["true"], [1], [null], [{}]])("consent = %j is refused: no job, no run, nothing spawned", async (consent) => {
    const caseId = await newCase();
    await addPatch(caseId);
    expect(code(() => start(caseId, { consent, checks: ["test"] }))).toBe("400 CONSENT_REQUIRED");
    expect(open.db.select().from(jobs).all()).toHaveLength(0);
    expect(runsOf(caseId)).toHaveLength(0);
    expect(docker).not.toHaveBeenCalled();
  });

  test("consent is checked before the case is looked up", () => {
    expect(code(() => startVerify("00000000-0000-4000-8000-000000000000", { checks: ["test"] }, { db: open.db }))).toBe("400 CONSENT_REQUIRED");
  });

  test("consent from an earlier request does not carry over: each verification needs its own", async () => {
    const caseId = await newCase();
    await addPatch(caseId);
    await verify(caseId, { consent: true, checks: ["test"] });
    expect(code(() => start(caseId, { checks: ["test"] }))).toBe("400 CONSENT_REQUIRED");
  });
});

describe("what can be verified", () => {
  test("needs an approved patch", async () => {
    const caseId = await newCase();
    expect(code(() => start(caseId, { consent: true, checks: ["test"] }))).toBe("409 WRONG_STATE");
    await addPatch(caseId, GOOD, false); // proposed, not approved
    expect(code(() => start(caseId, { consent: true, checks: ["test"] }))).toBe("409 WRONG_STATE");
    expect(docker).not.toHaveBeenCalled();
  });

  test.each([[[]], [["test", "build", "start", "test"]], [["test", "test"]], [["lint"]], ["test"], [undefined], [[1]], [["test; rm -rf /"]]])("checks = %j is refused", async (checks) => {
    const caseId = await newCase({ test: "node test.js", build: "node b.js", start: "node s.js" });
    await addPatch(caseId);
    expect(code(() => start(caseId, { consent: true, checks }))).toBe("400 VALIDATION_FAILED");
    expect(docker).not.toHaveBeenCalled();
  });

  test("a check the project does not have is refused", async () => {
    const caseId = await newCase();
    await addPatch(caseId);
    expect(code(() => start(caseId, { consent: true, checks: ["build"] }))).toBe("400 VALIDATION_FAILED");
  });

  test("an unknown case is 404", () => {
    expect(code(() => start("00000000-0000-4000-8000-000000000000", { consent: true, checks: ["test"] }))).toBe("404 NOT_FOUND");
  });

  test("a second start while one runs is 409", async () => {
    const caseId = await newCase();
    await addPatch(caseId);
    const first = startVerify(caseId, { consent: true, checks: ["test"] }, { db: open.db, dataDir: runCtx.dataDir, run: (i) => runCheck(i, runCtx) });
    expect(code(() => start(caseId, { consent: true, checks: ["test"] }))).toBe("409 JOB_RUNNING");
    await first.finished;
  });
});

describe("verdicts", () => {
  test("a correct patch: baseline fails, the repaired copy passes -> resurrected", async () => {
    const caseId = await newCase();
    const patch = await addPatch(caseId);
    const job = await verify(caseId, { consent: true, checks: ["test"] });
    expect(job.status).toBe("succeeded");
    const runs = runsOf(caseId);
    expect(runs.map((r) => [r.phase, r.target, r.status, r.patchId])).toEqual([["baseline", "original", "failed", null], ["after", "working", "passed", patch.id]]);
    expect(runs.every((r) => r.consentedAt > 0)).toBe(true);
    expect(caseRow(caseId)).toMatchObject({ verdict: "resurrected", stage: "verified" });
    expect(caseRow(caseId).verdictReason).toContain("passes after it");
    expect(caseRow(caseId).verdictAt).toBeGreaterThan(0);
  });

  test("a wrong patch: the repaired copy still fails -> failed", async () => {
    const caseId = await newCase();
    await addPatch(caseId, WRONG);
    await verify(caseId, { consent: true, checks: ["test"] });
    expect(runsOf(caseId).map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(caseRow(caseId)).toMatchObject({ verdict: "failed", stage: "verified" });
  });

  test("the control project: nothing fails at baseline -> unverified, 'not reproduced'", async () => {
    const caseId = await newCase({ test: "node test.js" }, "module.exports = 1;\n");
    await addPatch(caseId, [{ path: "src/index.js", search: "module.exports = 1;", replace: "module.exports = 2;" }]);
    await verify(caseId, { consent: true, checks: ["test"] });
    expect(runsOf(caseId).map((r) => r.status)).toEqual(["passed", "passed"]);
    expect(caseRow(caseId)).toMatchObject({ verdict: "unverified", stage: "verified" });
    expect(caseRow(caseId).verdictReason).toContain("not reproduced");
  });

  test("Docker absent: every run is stored unrunnable -> unverified", async () => {
    docker.mockResolvedValue({ kind: "unavailable", reason: "docker_missing" });
    const caseId = await newCase();
    await addPatch(caseId);
    const job = await verify(caseId, { consent: true, checks: ["test"] });
    expect(job.status).toBe("succeeded"); // not a job failure
    expect(runsOf(caseId).map((r) => [r.status, r.unrunnableReason])).toEqual([["unrunnable", "docker_missing"], ["unrunnable", "docker_missing"]]);
    expect(caseRow(caseId)).toMatchObject({ verdict: "unverified", stage: "verified" });
    expect(caseRow(caseId).verdictReason).toContain("could not run"); // and it does not claim the failure was "not reproduced"
    expect(caseRow(caseId).verdictReason).not.toContain("not reproduced");
  });

  test("two checks: the failing one is fixed but the other fails -> partially repaired", async () => {
    const caseId = await newCase({ test: "node test.js", build: "node build.js" });
    await addPatch(caseId);
    await verify(caseId, { consent: true, checks: ["test", "build"] });
    expect(caseRow(caseId).verdict).toBe("partially_repaired");
    expect(runsOf(caseId)).toHaveLength(4);
  });

  test("an existing baseline of the same kind is reused, not run again", async () => {
    const caseId = await newCase();
    const existing = await runCheck({ caseId, kind: "test", phase: "baseline", target: "original", consent: true }, runCtx);
    await addPatch(caseId);
    docker.mockClear();
    await verify(caseId, { consent: true, checks: ["test"] });
    expect(docker).toHaveBeenCalledTimes(1); // only the repaired copy
    expect(runsOf(caseId).filter((r) => r.phase === "baseline").map((r) => r.id)).toEqual([existing.id]);
    expect(caseRow(caseId).verdict).toBe("resurrected");
  });

  test("a baseline that could not run is tried again", async () => {
    docker.mockResolvedValueOnce({ kind: "unavailable", reason: "docker_not_running" });
    const caseId = await newCase();
    await runCheck({ caseId, kind: "test", phase: "baseline", target: "original", consent: true }, runCtx);
    await addPatch(caseId);
    await verify(caseId, { consent: true, checks: ["test"] });
    expect(runsOf(caseId).filter((r) => r.phase === "baseline").map((r) => r.status)).toEqual(["unrunnable", "failed"]);
    expect(caseRow(caseId).verdict).toBe("resurrected");
  });

  test("the original folder is untouched by verification", async () => {
    const caseId = await newCase();
    await addPatch(caseId);
    const file = path.join(runCtx.dataDir, "cases", caseId, "original/src/index.js");
    const before = readFileSync(file, "utf8");
    await verify(caseId, { consent: true, checks: ["test"] });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("cancelling leaves the case's verdict as it was", async () => {
    const caseId = await newCase();
    await addPatch(caseId);
    let release: () => void = () => {};
    docker.mockImplementation(async (args: string[]) => {
      await new Promise<void>((resolve) => (release = resolve));
      return fakeDocker(args);
    });
    const { jobId, finished: done } = startVerify(caseId, { consent: true, checks: ["test"] }, { db: open.db, dataDir: runCtx.dataDir, run: (i) => runCheck(i, runCtx) });
    await vi.waitFor(() => expect(docker).toHaveBeenCalled());
    cancelJob(jobId, open.db);
    release();
    await done;
    expect(getJobStatus(jobId, open.db).status).toBe("cancelled");
    expect(caseRow(caseId).verdict).toBeNull();
    expect(caseRow(caseId).stage).toBe("patched");
  });
});

describe("skip", () => {
  test("sets unverified, the stage verified and the skip reason, and runs nothing", async () => {
    const caseId = await newCase();
    await addPatch(caseId);
    expect(skipVerification(caseId, { db: open.db })).toEqual({ verdict: "unverified" });
    expect(caseRow(caseId)).toMatchObject({ verdict: "unverified", verdictReason: "Verification was skipped by the user", stage: "verified" });
    expect(docker).not.toHaveBeenCalled();
    expect(runsOf(caseId)).toHaveLength(0);
  });

  test("needs an approved patch, and a step must not be running", async () => {
    const caseId = await newCase();
    expect(code(() => skipVerification(caseId, { db: open.db }))).toBe("409 WRONG_STATE");
    await addPatch(caseId);
    open.db.insert(jobs).values({ caseId, kind: "verify", status: "running" }).run();
    expect(code(() => skipVerification(caseId, { db: open.db }))).toBe("409 JOB_RUNNING");
    expect(code(() => skipVerification("00000000-0000-4000-8000-000000000000", { db: open.db }))).toBe("404 NOT_FOUND");
  });
});
