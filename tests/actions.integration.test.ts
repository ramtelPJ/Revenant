// TEST-003: consent, scoping, one-job-per-case and original-immutability, end to end through the real route handlers
// (guard, validation, services, database and case folders), with the Docker call replaced by a spy.
// auth T12, T13, T14, T15, T16, T17, T27, T30.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";

// the sandbox's only door to the outside: every test can see whether it was ever opened
const runDocker = vi.fn();
vi.mock("@/lib/sandbox/docker", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/sandbox/docker")>()), runDocker }));

const PORT = "3000";
let root: string;
let signSession: typeof import("@/lib/http/session").signSession;
let db: ReturnType<typeof import("@/lib/db/client").getDb>;
let schema: typeof import("@/lib/db/schema");
let importFolder: typeof import("@/lib/cases/import").importFolder;
let importCtx: import("@/lib/cases/import").ImportContext;
let routes: {
  verify: typeof import("@/app/api/cases/[caseId]/verify/route");
  diagnose: typeof import("@/app/api/cases/[caseId]/diagnose/route");
  approve: typeof import("@/app/api/cases/[caseId]/patches/[patchId]/approve/route");
  reject: typeof import("@/app/api/cases/[caseId]/patches/[patchId]/reject/route");
  job: typeof import("@/app/api/jobs/[jobId]/route");
  report: typeof import("@/app/api/cases/[caseId]/report/route");
  caseRoute: typeof import("@/app/api/cases/[caseId]/route");
};

const finished = (exitCode: number) => ({ kind: "finished", exitCode, timedOut: false, survived: false, aborted: false, output: exitCode === 0 ? "ok\n" : "Error: broken\n", truncated: false, durationMs: 5 });
/** Behaves like the project: the test fails while src/index.js still has the broken call. */
const fakeProject = async (args: string[]) => {
  const mount = args[args.indexOf("-v") + 1].split(":")[0];
  return finished(readFileSync(path.join(mount, "src/index.js"), "utf8").includes("brokenCall()") ? 1 : 0);
};

beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-actions-")));
  mkdirSync(path.join(root, "home"));
  vi.stubEnv("REVENANT_LAUNCH_TOKEN", "a".repeat(64));
  vi.stubEnv("REVENANT_SESSION_SECRET", "b".repeat(64));
  vi.stubEnv("OLLAMA_MODEL", "gemma2:2b");
  vi.stubEnv("PORT", PORT);
  vi.stubEnv("DATA_DIR", path.join(root, "data"));
  ({ signSession } = await import("@/lib/http/session"));
  schema = await import("@/lib/db/schema");
  db = (await import("@/lib/db/client")).getDb();
  ({ importFolder } = await import("@/lib/cases/import"));
  importCtx = { db, dataDir: path.join(root, "data"), maxProjectBytes: 1e8, samplesDir: path.join(root, "samples"), homeDir: path.join(root, "home") };
  routes = {
    verify: await import("@/app/api/cases/[caseId]/verify/route"),
    diagnose: await import("@/app/api/cases/[caseId]/diagnose/route"),
    approve: await import("@/app/api/cases/[caseId]/patches/[patchId]/approve/route"),
    reject: await import("@/app/api/cases/[caseId]/patches/[patchId]/reject/route"),
    job: await import("@/app/api/jobs/[jobId]/route"),
    report: await import("@/app/api/cases/[caseId]/report/route"),
    caseRoute: await import("@/app/api/cases/[caseId]/route"),
  };
});
afterAll(async () => {
  const { removeTree } = await import("@/lib/cases/fs");
  await removeTree(root);
});
beforeEach(() => {
  runDocker.mockReset();
  runDocker.mockImplementation(fakeProject);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ---- helpers ----------------------------------------------------------------------------------------------------
const cookie = () => `revenant_session=${signSession()}`;
const req = (method: string, url: string, body?: unknown) =>
  new Request(`http://127.0.0.1:${PORT}${url}`, {
    method,
    headers: { host: `127.0.0.1:${PORT}`, cookie: cookie(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });
const call = async (res: Promise<Response>) => {
  const r = await res;
  return { status: r.status, body: (await r.json()) as any };
};
const waitJob = async (jobId: string) => {
  for (let i = 0; i < 200; i++) {
    const { body } = await call(routes.job.GET(req("GET", `/api/jobs/${jobId}`), ctx({ jobId })));
    if (!["queued", "running"].includes(body.data.status)) return body.data;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("job did not finish");
};

const BROKEN = "module.exports = function f() { return brokenCall(); };\n";
const FIX = [{ path: "src/index.js", search: "brokenCall()", replace: "42" }];
const newCase = async () => {
  const dir = path.join(root, "src", crypto.randomUUID());
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "p", main: "src/index.js", scripts: { test: "node test.js" } }));
  writeFileSync(path.join(dir, "src/index.js"), BROKEN);
  return (await importFolder(dir, importCtx)).id;
};
const addPatch = (caseId: string, edits: unknown = FIX) => {
  const finding = db.insert(schema.findings).values({ caseId, label: "supported_by_files", title: "t", explanation: "e", evidenceJson: "[]" }).returning().get();
  return db.insert(schema.patches).values({ caseId, findingId: finding.id, attempt: 1, rationale: "r", editsJson: JSON.stringify(edits), diffText: "d", filesAffectedJson: '["src/index.js"]', model: "fake" }).returning().get();
};
const approve = (caseId: string, patchId: string) => call(routes.approve.POST(req("POST", `/api/cases/${caseId}/patches/${patchId}/approve`), ctx({ caseId, patchId })));
const reject = (caseId: string, patchId: string) => call(routes.reject.POST(req("POST", `/api/cases/${caseId}/patches/${patchId}/reject`), ctx({ caseId, patchId })));
const verify = (caseId: string, body: unknown) => call(routes.verify.POST(req("POST", `/api/cases/${caseId}/verify`, body), ctx({ caseId })));
const del = (caseId: string) => call(routes.caseRoute.DELETE(req("DELETE", `/api/cases/${caseId}`), ctx({ caseId })));
const runsOf = (caseId: string) => db.select().from(schema.checkRuns).where(eq(schema.checkRuns.caseId, caseId)).all();
const jobsOf = (caseId: string) => db.select().from(schema.jobs).where(eq(schema.jobs.caseId, caseId)).all();
const caseRow = (id: string) => db.select().from(schema.cases).where(eq(schema.cases.id, id)).get()!;
const patchRow = (id: string) => db.select().from(schema.patches).where(eq(schema.patches.id, id)).get()!;
const folder = (caseId: string, v: "original" | "working") => path.join(root, "data", "cases", caseId, v);
const exists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
/** Every file under a folder with its content hash and mode. */
const fingerprint = (dir: string): string => {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(d, e.name);
    return e.isDirectory() ? walk(full) : [`${path.relative(dir, full)}:${createHash("sha256").update(readFileSync(full)).digest("hex")}:${(lstatSync(full).mode & 0o777).toString(8)}`];
  });
  return walk(dir).sort().join("\n");
};

// ---- the tests --------------------------------------------------------------------------------------------------
describe("T12: an id from another case", () => {
  test("approving or rejecting case A's patch through case B is 404 and changes nothing", async () => {
    const a = await newCase();
    const b = await newCase();
    const patch = addPatch(a);
    const beforeA = fingerprint(folder(a, "original"));
    for (const act of [approve, reject]) {
      const res = await act(b, patch.id);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    }
    expect(patchRow(patch.id).status).toBe("proposed");
    expect(caseRow(a).stage).not.toBe("patched");
    expect(exists(folder(a, "working")) || exists(folder(b, "working"))).toBe(false);
    expect(fingerprint(folder(a, "original"))).toBe(beforeA);
  });

  test("a patch id that exists nowhere gets the same answer, so the two cannot be told apart", async () => {
    const a = await newCase();
    const patch = addPatch(await newCase());
    const other = await approve(a, patch.id);
    const nowhere = await approve(a, crypto.randomUUID());
    expect([other.status, other.body.error.message]).toEqual([nowhere.status, nowhere.body.error.message]);
  });
});

describe("T13: Docker missing -> Unverified", () => {
  test("every run is stored unrunnable, the verdict is unverified, and the report never says resurrected", async () => {
    runDocker.mockResolvedValue({ kind: "unavailable", reason: "docker_missing" });
    const caseId = await newCase();
    const patch = addPatch(caseId);
    expect((await approve(caseId, patch.id)).status).toBe(200);
    const started = await verify(caseId, { consent: true, checks: ["test"] });
    expect(started.status).toBe(202);
    expect((await waitJob(started.body.data.jobId)).status).toBe("succeeded");
    expect(runsOf(caseId).map((r) => [r.status, r.unrunnableReason])).toEqual([["unrunnable", "docker_missing"], ["unrunnable", "docker_missing"]]);
    expect(caseRow(caseId)).toMatchObject({ verdict: "unverified", stage: "verified" });
    expect(caseRow(caseId).verdictReason).toMatch(/could not run/);
    const report = await call(routes.report.GET(req("GET", `/api/cases/${caseId}/report`), ctx({ caseId })));
    expect(report.status).toBe(200);
    expect(report.body.data.verdict).toBe("unverified");
    expect(JSON.stringify(report.body)).not.toMatch(/resurrected/i);
  });
});

describe("T14: consent missing on verify", () => {
  test.each([[{ consent: false, checks: ["test"] }], [{ checks: ["test"] }], [{ consent: "true", checks: ["test"] }], [{ consent: 1, checks: ["test"] }], [{ consent: null, checks: ["test"] }]])("%j -> 400 CONSENT_REQUIRED, nothing spawned, no run row, no job", async (body) => {
    const caseId = await newCase();
    await approve(caseId, addPatch(caseId).id);
    runDocker.mockClear();
    const res = await verify(caseId, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CONSENT_REQUIRED");
    expect(runDocker).not.toHaveBeenCalled();
    expect(runsOf(caseId)).toHaveLength(0);
    expect(jobsOf(caseId)).toHaveLength(0);
  });
});

describe("T15: baseline without consent", () => {
  test.each([[{ captureBaseline: true }], [{ captureBaseline: true, consent: false }], [{ captureBaseline: true, consent: "yes" }]])("diagnose %j -> 400 CONSENT_REQUIRED and nothing executed", async (body) => {
    const caseId = await newCase();
    const res = await call(routes.diagnose.POST(req("POST", `/api/cases/${caseId}/diagnose`, body), ctx({ caseId })));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CONSENT_REQUIRED");
    expect(runDocker).not.toHaveBeenCalled();
    expect(runsOf(caseId)).toHaveLength(0);
    expect(jobsOf(caseId)).toHaveLength(0);
  });
});

describe("T16: consent is not reused", () => {
  test("after a verification with consent, the next request without consent is refused and adds no run", async () => {
    const caseId = await newCase();
    await approve(caseId, addPatch(caseId).id);
    const first = await verify(caseId, { consent: true, checks: ["test"] });
    expect(first.status).toBe(202);
    await waitJob(first.body.data.jobId);
    const runsBefore = runsOf(caseId).length;
    expect(runsBefore).toBeGreaterThan(0);
    runDocker.mockClear();
    const second = await verify(caseId, { checks: ["test"] });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe("CONSENT_REQUIRED");
    expect(runDocker).not.toHaveBeenCalled();
    expect(runsOf(caseId)).toHaveLength(runsBefore);
  });
});

describe("T17: a second job while one runs", () => {
  test("is 409 JOB_RUNNING, starts nothing, and the first job still finishes normally", async () => {
    const caseId = await newCase();
    await approve(caseId, addPatch(caseId).id);
    let release: () => void = () => {};
    runDocker.mockImplementation(async (args: string[]) => {
      await new Promise<void>((resolve) => (release = resolve));
      return fakeProject(args);
    });
    const first = await verify(caseId, { consent: true, checks: ["test"] });
    expect(first.status).toBe(202);
    await vi.waitFor(() => expect(runDocker).toHaveBeenCalled());
    const second = await verify(caseId, { consent: true, checks: ["test"] });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("JOB_RUNNING");
    expect(jobsOf(caseId)).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(runDocker).toHaveBeenCalledTimes(2)); // baseline, then the repaired copy
    release();
    expect((await waitJob(first.body.data.jobId)).status).toBe("succeeded");
  });
});

describe("T27: deleting a case while a job runs", () => {
  test("DELETE /api/cases/:id is 409 while a job runs, and nothing is removed", async () => {
    const caseId = await newCase();
    const finding = db.insert(schema.findings).values({ caseId, label: "supported_by_files", title: "t", explanation: "e", evidenceJson: "[]" }).returning().get();
    db.insert(schema.jobs).values({ caseId, kind: "analyze", status: "running" }).run();
    const blocked = await del(caseId);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("JOB_RUNNING");
    expect(exists(folder(caseId, "original"))).toBe(true);
    expect(db.select().from(schema.findings).where(eq(schema.findings.id, finding.id)).get()).toBeDefined();
  });

  test("deleting an idle case removes its rows and folder; a second delete is 404", async () => {
    const caseId = await newCase();
    addPatch(caseId);
    expect((await del(caseId)).status).toBe(200);
    expect(exists(path.join(root, "data", "cases", caseId))).toBe(false);
    expect(db.select().from(schema.cases).where(eq(schema.cases.id, caseId)).get()).toBeUndefined();
    expect(db.select().from(schema.patches).where(eq(schema.patches.caseId, caseId)).all()).toEqual([]);
    expect((await del(caseId)).status).toBe(404);
  });
});

describe("T30: original/ is never touched", () => {
  test("its files, hashes and modes are identical after approve, reject, a second approve and verify", async () => {
    const caseId = await newCase();
    const before = fingerprint(folder(caseId, "original"));
    const first = addPatch(caseId);
    const second = addPatch(caseId, [{ path: "src/index.js", search: "brokenCall()", replace: "7" }]);

    expect((await approve(caseId, first.id)).status).toBe(200);
    expect(fingerprint(folder(caseId, "original"))).toBe(before);
    expect(readFileSync(path.join(folder(caseId, "working"), "src/index.js"), "utf8")).toBe("module.exports = function f() { return 42; };\n");

    expect((await reject(caseId, second.id)).status).toBe(200);
    expect(fingerprint(folder(caseId, "original"))).toBe(before);

    const verified = await verify(caseId, { consent: true, checks: ["test"] });
    expect(verified.status).toBe(202);
    await waitJob(verified.body.data.jobId);
    expect(fingerprint(folder(caseId, "original"))).toBe(before);
    expect(readFileSync(path.join(folder(caseId, "original"), "src/index.js"), "utf8")).toBe(BROKEN);
    expect(caseRow(caseId).verdict).toBe("resurrected");
    expect(exists(path.join(root, "data", "runs", "x"))).toBe(false);
    expect(readdirSync(path.join(root, "data", "runs"))).toEqual([]); // the temporary copies are gone
  });
});
