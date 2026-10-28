import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { removeTree } from "@/lib/cases/fs";
import { importFolder, type ImportContext } from "@/lib/cases/import";
import { openDatabase, type OpenDatabase } from "@/lib/db/client";
import { checkRuns, findings, jobs, patches } from "@/lib/db/schema";
import { AppError } from "@/lib/http/respond";
import { getJobStatus } from "@/lib/jobs/runner";
import { startProposePatch } from "@/lib/jobs/propose-patch";
import type { chatJson } from "@/lib/ai/ollama";

let root: string;
let open: OpenDatabase;
let importCtx: ImportContext;

const INDEX = 'const greeter = require("esm-greeter");\nmodule.exports = (n) => greeter.greet(n);\n';
const GOOD = { rationale: "Load the ESM-only package with import().", edits: [{ path: "src/index.js", search: 'const greeter = require("esm-greeter");', replace: 'const greeter = await import("esm-greeter");' }] };
const BAD = { rationale: "x", edits: [{ path: "src/index.js", search: 'require("not-there")', replace: "y" }] };

const newCase = async () => {
  const dir = path.join(root, "src", crypto.randomUUID());
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "p", main: "src/index.js", scripts: { test: "node test.js" } }));
  writeFileSync(path.join(dir, "src/index.js"), INDEX);
  writeFileSync(path.join(dir, "src/secret-notes.js"), "// not cited\n");
  writeFileSync(path.join(dir, ".env"), "SECRET=abcdefghijklmnop1234\n");
  return (await importFolder(dir, importCtx)).id;
};
const addFinding = (caseId: string, over: Partial<typeof findings.$inferInsert> = {}) =>
  open.db
    .insert(findings)
    .values({
      caseId, label: "supported_by_files", title: "ESM only", explanation: "require() cannot load an ESM-only package.", category: "module_format",
      evidenceJson: JSON.stringify([{ kind: "file", path: "src/index.js", startLine: 1, endLine: 1, quote: 'const greeter = require("esm-greeter");' }]), ...over,
    })
    .returning()
    .get();
const reply = (data: unknown) => ({ data, model: "fake:1b", attempts: 1 as const });
type Chat = typeof chatJson & ReturnType<typeof vi.fn>;
const stub = (...answers: unknown[]) => {
  const fn = vi.fn();
  answers.forEach((a) => fn.mockResolvedValueOnce(reply(a)));
  fn.mockResolvedValue(reply(answers[answers.length - 1]));
  return fn as unknown as Chat;
};
const run = async (caseId: string, chat: typeof chatJson) => {
  const { jobId, finished } = startProposePatch(caseId, { db: open.db, dataDir: importCtx.dataDir, chat });
  await finished;
  return getJobStatus(jobId, open.db);
};
const rows = (caseId: string) => open.db.select().from(patches).where(eq(patches.caseId, caseId)).all();
/** Every file under original/ with its content hash and mode: a patch proposal must not change any of it. */
const fingerprint = (caseId: string): string => {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [`${path.relative(root, path.join(d, e.name))}:${createHash("sha256").update(readFileSync(path.join(d, e.name))).digest("hex")}`]));
  return walk(path.join(importCtx.dataDir, "cases", caseId, "original")).sort().join("\n");
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-propose-")));
  mkdirSync(path.join(root, "home"));
  open = openDatabase(path.join(root, "data"));
  importCtx = { db: open.db, dataDir: path.join(root, "data"), maxProjectBytes: 1e8, samplesDir: path.join(root, "samples"), homeDir: path.join(root, "home") };
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  open.sqlite.close();
  await removeTree(root);
});

describe("a valid proposal", () => {
  test("is stored with its diff, files and rationale, touches one file, and changes nothing in original/", async () => {
    const id = await newCase();
    const finding = addFinding(id);
    const before = fingerprint(id);
    const job = await run(id, stub(GOOD));

    expect(job).toMatchObject({ status: "succeeded", kind: "propose_patch" });
    expect(job.progressNote).toContain("Patch proposed");
    const [patch] = rows(id);
    expect(patch).toMatchObject({ findingId: finding.id, attempt: 1, status: "proposed", model: "fake:1b", rationale: GOOD.rationale });
    expect(JSON.parse(patch.filesAffectedJson)).toEqual(["src/index.js"]);
    expect(patch.diffText).toContain("--- a/src/index.js");
    expect(patch.diffText).toContain('-const greeter = require("esm-greeter");');
    expect(patch.diffText).toContain('+const greeter = await import("esm-greeter");');
    expect(JSON.parse(patch.editsJson)).toEqual(GOOD.edits);
    expect(fingerprint(id)).toBe(before);
  });

  test("the model is shown the cited file whole and exactly, the finding, and the untrusted-data notice, never .env or uncited files", async () => {
    const id = await newCase();
    addFinding(id);
    const chat = stub(GOOD);
    await run(id, chat);
    const sent = JSON.stringify((chat as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]);
    expect(sent).toContain("require(\\\"esm-greeter\\\")");
    expect(sent).toContain("ESM only");
    expect(sent).toContain("untrusted");
    expect(sent).not.toContain("abcdefghijklmnop1234");
    expect(sent).not.toContain("not cited");
  });

  test("the check output that confirmed the finding is shown too", async () => {
    const id = await newCase();
    const run1 = open.db.insert(checkRuns).values({ caseId: id, phase: "baseline", checkKind: "test", commandLabel: "npm test", target: "original", status: "failed", exitCode: 1, outputExcerpt: "ERR_REQUIRE_ASYNC_MODULE here", limitsJson: "{}", consentedAt: 1 }).returning().get();
    addFinding(id, { label: "confirmed_by_check", checkRunId: run1.id });
    const chat = stub(GOOD);
    await run(id, chat);
    expect(JSON.stringify((chat as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1])).toContain("ERR_REQUIRE_ASYNC_MODULE here");
  });

  test("with no cited file it falls back to the project's entry point", async () => {
    const id = await newCase();
    addFinding(id, { label: "hypothesis", evidenceJson: "[]" });
    const chat = stub(GOOD);
    expect((await run(id, chat)).status).toBe("succeeded");
    expect(JSON.stringify((chat as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1])).toContain("src/index.js");
  });
});

describe("refused edits", () => {
  test("are retried once with the exact reasons, and a good second answer is saved", async () => {
    const id = await newCase();
    addFinding(id);
    const chat = stub(BAD, GOOD);
    const job = await run(id, chat);
    expect(job.status).toBe("succeeded");
    const calls = (chat as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    const retry = JSON.stringify(calls[1][1]);
    expect(retry).toContain("Your edits were refused");
    expect(retry).toContain("was not found in the file");
    expect(rows(id)).toHaveLength(1);
  });

  test("twice in a row end the job as PATCH_INVALID with no patch row", async () => {
    const id = await newCase();
    addFinding(id);
    const chat = stub(BAD, BAD);
    const job = await run(id, chat);
    expect(job).toMatchObject({ status: "failed", errorCode: "PATCH_INVALID" });
    expect((chat as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(rows(id)).toHaveLength(0);
  });

  test.each([
    ["node_modules/x/index.js", "node_modules or .git"],
    ["../y.js", "inside the project"],
    ["package-lock.json", "lockfiles"],
  ])("edits to %s are refused and never saved (T24)", async (p) => {
    const id = await newCase();
    addFinding(id);
    const job = await run(id, stub({ rationale: "r", edits: [{ path: p, search: "a", replace: "b" }] }));
    expect(job).toMatchObject({ status: "failed", errorCode: "PATCH_INVALID" });
    expect(rows(id)).toHaveLength(0);
  });
});

describe("regenerate", () => {
  test("a second proposal is attempt 2, the first becomes superseded, and it is asked for with a higher temperature", async () => {
    const id = await newCase();
    addFinding(id);
    const first = stub(GOOD);
    await run(id, first);
    const second = stub({ ...GOOD, rationale: "A different way." });
    await run(id, second);

    const [one, two] = rows(id).sort((a, b) => a.attempt - b.attempt);
    expect(one).toMatchObject({ attempt: 1, status: "superseded" });
    expect(one.decidedAt).not.toBeNull();
    expect(two).toMatchObject({ attempt: 2, status: "proposed", rationale: "A different way." });
    const temp = (c: Chat) => (c as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2].temperature;
    expect(temp(first)).toBe(0.1);
    expect(temp(second)).toBe(0.4);
  });

  test("an approved patch is not touched by a new proposal", async () => {
    const id = await newCase();
    const finding = addFinding(id);
    open.db.insert(patches).values({ caseId: id, findingId: finding.id, attempt: 1, rationale: "r", editsJson: "[]", diffText: "", filesAffectedJson: "[]", model: "m", status: "approved" }).run();
    await run(id, stub(GOOD));
    expect(rows(id).map((p) => `${p.attempt}:${p.status}`).sort()).toEqual(["1:approved", "2:proposed"]);
  });

  test("a failed regenerate leaves the earlier proposal as it was", async () => {
    const id = await newCase();
    addFinding(id);
    await run(id, stub(GOOD));
    await run(id, stub(BAD, BAD));
    expect(rows(id).map((p) => `${p.attempt}:${p.status}`)).toEqual(["1:proposed"]);
  });
});

describe("preconditions and failures", () => {
  test("no finding is 409 WRONG_STATE and starts no job", async () => {
    const id = await newCase();
    expect(() => startProposePatch(id, { db: open.db })).toThrowError(expect.objectContaining({ status: 409, code: "WRONG_STATE", message: "No failure to repair." }));
    expect(open.db.select().from(jobs).where(eq(jobs.caseId, id)).all()).toHaveLength(0);
  });
  test("a 'no failure found' finding is 409 too", async () => {
    const id = await newCase();
    addFinding(id, { label: "no_failure_found", evidenceJson: "[]" });
    expect(() => startProposePatch(id, { db: open.db })).toThrowError(expect.objectContaining({ status: 409, code: "WRONG_STATE" }));
  });
  test("only the newest finding counts", async () => {
    const id = await newCase();
    addFinding(id);
    addFinding(id, { label: "no_failure_found", title: "newer", evidenceJson: "[]" });
    expect(() => startProposePatch(id, { db: open.db })).toThrowError(expect.objectContaining({ status: 409 }));
  });
  test("an unknown case is 404", () => {
    expect(() => startProposePatch("00000000-0000-4000-8000-000000000000", { db: open.db })).toThrowError(expect.objectContaining({ status: 404 }));
  });
  test("a second start while one is running is 409 JOB_RUNNING", async () => {
    const id = await newCase();
    addFinding(id);
    const { finished } = startProposePatch(id, { db: open.db, dataDir: importCtx.dataDir, chat: stub(GOOD) });
    expect(() => startProposePatch(id, { db: open.db, dataDir: importCtx.dataDir, chat: stub(GOOD) })).toThrowError(expect.objectContaining({ status: 409, code: "JOB_RUNNING" }));
    await finished;
  });
  test("AI unavailable fails the job with AI_UNAVAILABLE and saves nothing", async () => {
    const id = await newCase();
    addFinding(id);
    const chat = vi.fn(async () => {
      throw new AppError("AI_UNAVAILABLE", 503, "The local AI isn't running.");
    }) as unknown as typeof chatJson;
    expect(await run(id, chat)).toMatchObject({ status: "failed", errorCode: "AI_UNAVAILABLE" });
    expect(rows(id)).toHaveLength(0);
  });
  test("a finding whose only cited file is too big to show fails honestly instead of guessing", async () => {
    const id = await newCase();
    const dir = path.join(importCtx.dataDir, "cases", id, "original");
    // the project has one entry point and it is far larger than the model can be shown whole
    const big = path.join(root, "bigproj");
    mkdirSync(big, { recursive: true });
    writeFileSync(path.join(big, "package.json"), JSON.stringify({ name: "b", main: "index.js", scripts: { test: "x" } }));
    writeFileSync(path.join(big, "index.js"), "x".repeat(20_000));
    const bigId = (await importFolder(big, importCtx)).id;
    addFinding(bigId, { evidenceJson: JSON.stringify([{ kind: "file", path: "index.js", startLine: 1, endLine: 1, quote: "xxx" }]) });
    const chat = stub(GOOD);
    expect(await run(bigId, chat)).toMatchObject({ status: "failed", errorCode: "PATCH_INVALID" });
    expect((chat as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(dir).toBeTruthy();
  });
});

describe("routes", () => {
  let POST: typeof import("@/app/api/cases/[caseId]/patches/route").POST;
  let GET: typeof import("@/app/api/cases/[caseId]/patches/route").GET;
  let signSession: typeof import("@/lib/http/session").signSession;
  let routeDb: typeof import("@/lib/db/client").getDb;
  let importDefault: typeof import("@/lib/cases/import").importFolder;
  let routeRoot: string;

  beforeAll(async () => {
    routeRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-patchroute-")));
    vi.stubEnv("REVENANT_LAUNCH_TOKEN", "a".repeat(64));
    vi.stubEnv("REVENANT_SESSION_SECRET", "b".repeat(64));
    vi.stubEnv("OLLAMA_MODEL", "gemma2:2b");
    vi.stubEnv("PORT", "3000");
    vi.stubEnv("DATA_DIR", path.join(routeRoot, "data"));
    // the route starts the real job, so the model is replaced here; nothing talks to Ollama.
    // resetModules: the job module was already loaded above with the real client, and a cached module ignores a later mock
    vi.resetModules();
    vi.doMock("@/lib/ai/ollama", async (original) => ({ ...(await original<typeof import("@/lib/ai/ollama")>()), chatJson: async () => reply(GOOD) }));
    ({ POST, GET } = await import("@/app/api/cases/[caseId]/patches/route"));
    ({ signSession } = await import("@/lib/http/session"));
    ({ getDb: routeDb } = await import("@/lib/db/client"));
    ({ importFolder: importDefault } = await import("@/lib/cases/import"));
  });
  afterAll(async () => {
    const holder = globalThis as unknown as { __revenantDb?: { sqlite: { close(): void } } };
    holder.__revenantDb?.sqlite.close();
    delete holder.__revenantDb;
    vi.doUnmock("@/lib/ai/ollama");
    await removeTree(routeRoot);
  });

  const call = (method: "GET" | "POST", caseId: string, options: { cookie?: boolean; host?: string } = {}) =>
    (method === "POST" ? POST : GET)(
      new Request(`http://127.0.0.1:3000/api/cases/${caseId}/patches`, { method, headers: { host: options.host ?? "127.0.0.1:3000", ...(options.cookie === false ? {} : { cookie: `revenant_session=${signSession()}` }) } }),
      { params: Promise.resolve({ caseId }) },
    );
  const routeCase = async () => {
    const dir = path.join(routeRoot, "p", crypto.randomUUID());
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "r", main: "src/index.js", scripts: { test: "node t.js" } }));
    writeFileSync(path.join(dir, "src/index.js"), INDEX);
    return (await importDefault(dir)).id;
  };
  const UNKNOWN = "00000000-0000-4000-8000-000000000000";

  test("POST without a finding is 409 WRONG_STATE; with one it is 202 and the patch appears in GET, newest first", async () => {
    const id = await routeCase();
    const refused = await call("POST", id);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe("WRONG_STATE");

    routeDb().insert(findings).values({ caseId: id, label: "supported_by_files", title: "t", explanation: "e", evidenceJson: JSON.stringify([{ kind: "file", path: "src/index.js", startLine: 1, endLine: 1, quote: 'const greeter = require("esm-greeter");' }]) }).run();
    const accepted = await call("POST", id);
    expect(accepted.status).toBe(202);
    const { jobId } = (await accepted.json()).data;
    await vi.waitFor(() => expect(getJobStatus(jobId, routeDb()).status).toBe("succeeded"));

    const listed = await (await call("GET", id)).json();
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({ attempt: 1, status: "proposed", filesAffected: ["src/index.js"], rationale: GOOD.rationale });
    expect(Object.keys(listed.data[0])).not.toContain("editsJson");
    expect(JSON.stringify(listed)).not.toContain('"search"');
  });

  test("GET is empty for a case without patches", async () => {
    const id = await routeCase();
    expect((await (await call("GET", id)).json()).data).toEqual([]);
  });

  test("401 without a session, 403 for a wrong Host, 404 for an unknown case, 400 for a malformed id", async () => {
    const id = await routeCase();
    for (const method of ["GET", "POST"] as const) {
      expect((await call(method, id, { cookie: false })).status, method).toBe(401);
      expect((await call(method, id, { host: "evil.example:3000" })).status, method).toBe(403);
      expect((await call(method, UNKNOWN)).status, method).toBe(404);
      expect((await call(method, "not-a-uuid")).status, method).toBe(400);
    }
  });
});
