import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { removeTree } from "@/lib/cases/fs";
import type { getDb as GetDb } from "@/lib/db/client";

let root: string;
let getDb: typeof GetDb;
let schema: typeof import("@/lib/db/schema");
let importFolder: typeof import("@/lib/cases/import").importFolder;
let signSession: typeof import("@/lib/http/session").signSession;
let routes: {
  list: typeof import("@/app/api/cases/route").GET;
  detail: typeof import("@/app/api/cases/[caseId]/route").GET;
  samples: typeof import("@/app/api/samples/route").GET;
  files: typeof import("@/app/api/cases/[caseId]/files/route").GET;
  content: typeof import("@/app/api/cases/[caseId]/files/content/route").GET;
};

beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-read-")));
  vi.stubEnv("REVENANT_LAUNCH_TOKEN", "a".repeat(64));
  vi.stubEnv("REVENANT_SESSION_SECRET", "b".repeat(64));
  vi.stubEnv("OLLAMA_MODEL", "gemma2:2b");
  vi.stubEnv("PORT", "3000");
  vi.stubEnv("DATA_DIR", path.join(root, "data"));
  ({ getDb } = await import("@/lib/db/client"));
  schema = await import("@/lib/db/schema");
  ({ importFolder } = await import("@/lib/cases/import"));
  ({ signSession } = await import("@/lib/http/session"));
  routes = {
    list: (await import("@/app/api/cases/route")).GET,
    detail: (await import("@/app/api/cases/[caseId]/route")).GET,
    samples: (await import("@/app/api/samples/route")).GET,
    files: (await import("@/app/api/cases/[caseId]/files/route")).GET,
    content: (await import("@/app/api/cases/[caseId]/files/content/route")).GET,
  };
});

afterAll(async () => {
  const holder = globalThis as unknown as { __revenantDb?: { sqlite: { close(): void } } };
  holder.__revenantDb?.sqlite.close();
  delete holder.__revenantDb;
  await removeTree(root);
});

const project = (name: string, files: Record<string, string | Buffer> = {}) => {
  const dir = path.join(root, "projects", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, scripts: { test: "node test.js" } }));
  writeFileSync(path.join(dir, "test.js"), "console.log('t')\n");
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
};
const newCase = async (name: string, files: Record<string, string | Buffer> = {}) => (await importFolder(project(name, files))).id;

const request = (url: string, options: { cookie?: boolean; headers?: Record<string, string> } = {}) =>
  new Request(`http://127.0.0.1:3000${url}`, {
    headers: { host: "127.0.0.1:3000", ...(options.cookie === false ? {} : { cookie: `revenant_session=${signSession()}` }), ...options.headers },
  });
const ctx = (caseId: string) => ({ params: Promise.resolve({ caseId }) });
const UNKNOWN = "00000000-0000-4000-8000-000000000000";

describe("GET /api/cases", () => {
  test("401 without a session, 403 for a wrong Host", async () => {
    expect((await routes.list(request("/api/cases", { cookie: false }), undefined)).status).toBe(401);
    expect((await routes.list(request("/api/cases", { headers: { host: "evil.example:3000" } }), undefined)).status).toBe(403);
  });

  test("empty when there are no cases", async () => {
    const res = await routes.list(request("/api/cases"), undefined);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });

  test("newest-updated first, with only the fields the list needs", async () => {
    const first = await newCase("first");
    await new Promise((r) => setTimeout(r, 5));
    const second = await newCase("second");
    await new Promise((r) => setTimeout(r, 5));
    const { updateCase } = await import("@/lib/cases/store");
    updateCase(first, { stage: "analyzed" });

    const { data } = await (await routes.list(request("/api/cases"), undefined)).json();
    expect(data.map((c: { name: string }) => c.name)).toEqual(["first", "second"]);
    expect(Object.keys(data[0]).sort()).toEqual(["id", "name", "stage", "updatedAt", "verdict"]);
    expect(data[1].id).toBe(second);
  });
});

describe("GET /api/samples", () => {
  test("lists the shipped samples with only id, name and description", async () => {
    const res = await routes.samples(request("/api/samples"), undefined);
    const { data } = await res.json();
    expect(data.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining(["broken-esm", "control-working"]));
    for (const sample of data) expect(Object.keys(sample).sort()).toEqual(["description", "id", "name"]);
    expect(JSON.stringify(data)).not.toMatch(/expectedFile|expectedCategory|failingCheck/); // the answer key stays server-side
  });

  test("401 without a session", async () => {
    expect((await routes.samples(request("/api/samples", { cookie: false }), undefined)).status).toBe(401);
  });
});

describe("GET /api/cases/:caseId", () => {
  test("401, 403, 400 for a malformed id, 404 for an unknown one", async () => {
    const id = await newCase("detail-access");
    expect((await routes.detail(request(`/api/cases/${id}`, { cookie: false }), ctx(id))).status).toBe(401);
    expect((await routes.detail(request(`/api/cases/${id}`, { headers: { host: "evil.example:3000" } }), ctx(id))).status).toBe(403);
    for (const bad of ["not-a-uuid", "../etc", "123", "' OR 1=1 --"]) {
      const res = await routes.detail(request(`/api/cases/x`), ctx(bad));
      expect(res.status, bad).toBe(400);
      expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
    }
    const missing = await routes.detail(request(`/api/cases/${UNKNOWN}`), ctx(UNKNOWN));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.message).toBe("We couldn't find that.");
  });

  test("a fresh case has nothing attached", async () => {
    const id = await newCase("fresh");
    const { data } = await (await routes.detail(request(`/api/cases/${id}`), ctx(id))).json();
    expect(data).toMatchObject({ id, name: "fresh", stage: "imported", verdict: null, analysis: null, latestFinding: null, latestPatch: null, activeJob: null, checkRuns: [] });
  });

  test("shows the newest finding and patch, the active job, the analysis and every check run, all parsed", async () => {
    const id = await newCase("full");
    const db = getDb();
    const { analyses, findings, patches, jobs, checkRuns } = schema;

    db.insert(analyses).values({ caseId: id, inventoryJson: JSON.stringify({ name: "full" }), summaryJson: JSON.stringify({ purpose: "p" }), model: "gemma2:2b" }).run();
    db.insert(findings).values({ caseId: id, label: "hypothesis", title: "old", explanation: "e", evidenceJson: "[]" }).run();
    const newestFinding = db.insert(findings).values({ caseId: id, label: "confirmed_by_check", title: "new", explanation: "why", category: "module_format", evidenceJson: JSON.stringify([{ kind: "log", excerpt: "x" }]) }).returning().get();
    db.insert(patches).values({ caseId: id, findingId: newestFinding.id, attempt: 1, rationale: "r1", editsJson: '[{"secret":"edits"}]', diffText: "d1", filesAffectedJson: '["a.js"]', model: "m", status: "superseded" }).run();
    db.insert(patches).values({ caseId: id, findingId: newestFinding.id, attempt: 2, rationale: "r2", editsJson: "[]", diffText: "d2", filesAffectedJson: '["b.js"]', model: "m" }).run();
    db.insert(jobs).values({ caseId: id, kind: "diagnose", status: "running", progressNote: "working", stepsJson: JSON.stringify([{ label: "Reading", state: "done" }]) }).run();
    db.insert(checkRuns).values({ caseId: id, phase: "baseline", checkKind: "test", commandLabel: "npm test", target: "original", status: "failed", exitCode: 1, outputExcerpt: "boom", limitsJson: JSON.stringify({ memoryMb: 512 }), consentedAt: 1, startedAt: 1 }).run();

    const { data } = await (await routes.detail(request(`/api/cases/${id}`), ctx(id))).json();
    expect(data.analysis).toEqual({ inventory: { name: "full" }, summary: { purpose: "p" }, model: "gemma2:2b", createdAt: expect.any(Number) });
    expect(data.latestFinding).toMatchObject({ title: "new", label: "confirmed_by_check", category: "module_format", evidence: [{ kind: "log", excerpt: "x" }] });
    expect(data.latestPatch).toMatchObject({ attempt: 2, rationale: "r2", diffText: "d2", filesAffected: ["b.js"], status: "proposed" });
    expect(data.latestPatch).not.toHaveProperty("editsJson");
    expect(JSON.stringify(data)).not.toContain("secret"); // raw edits are not part of the summary
    expect(data.activeJob).toMatchObject({ kind: "diagnose", status: "running", progressNote: "working", steps: [{ label: "Reading", state: "done" }] });
    expect(data.checkRuns).toHaveLength(1);
    expect(data.checkRuns[0]).toMatchObject({ phase: "baseline", checkKind: "test", status: "failed", exitCode: 1, outputExcerpt: "boom", limits: { memoryMb: 512 } });
  });

  test("a finished job is not 'active'", async () => {
    const id = await newCase("jobs-done");
    getDb().insert(schema.jobs).values({ caseId: id, kind: "analyze", status: "succeeded" }).run();
    const { data } = await (await routes.detail(request(`/api/cases/${id}`), ctx(id))).json();
    expect(data.activeJob).toBeNull();
  });

  test("rows of other cases never appear", async () => {
    const a = await newCase("iso-a");
    const b = await newCase("iso-b");
    getDb().insert(schema.findings).values({ caseId: b, label: "hypothesis", title: "only-in-b", explanation: "e", evidenceJson: "[]" }).run();
    getDb().insert(schema.errorLogs).values({ caseId: b, content: "b log" }).run();
    const { data } = await (await routes.detail(request(`/api/cases/${a}`), ctx(a))).json();
    expect(data.latestFinding).toBeNull();
    expect(JSON.stringify(data)).not.toContain("only-in-b");
  });

  test("corrupt stored JSON becomes null/empty, not a 500", async () => {
    const id = await newCase("corrupt");
    getDb().insert(schema.analyses).values({ caseId: id, inventoryJson: "{ broken", summaryJson: "also broken" }).run();
    getDb().insert(schema.findings).values({ caseId: id, label: "hypothesis", title: "t", explanation: "e", evidenceJson: "nope" }).run();
    const res = await routes.detail(request(`/api/cases/${id}`), ctx(id));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.analysis).toMatchObject({ inventory: null, summary: null });
    expect(data.latestFinding.evidence).toEqual([]);
  });
});

describe("GET /api/cases/:caseId/files", () => {
  test("lists the files, collapses node_modules, and reports counts", async () => {
    const id = await newCase("tree", { "src/index.js": "x", "node_modules/dep/a.js": "1", "node_modules/dep/b.js": "2" });
    const res = await routes.files(request(`/api/cases/${id}/files`), ctx(id));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    const paths = data.entries.map((e: { path: string }) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["package.json", "src", "src/index.js", "test.js", "node_modules"]));
    expect(paths.some((p: string) => p.startsWith("node_modules/"))).toBe(false);
    expect(data.entries).toContainEqual({ path: "node_modules", type: "dir", collapsed: true, fileCount: 2 });
    expect(data).toMatchObject({ fileCount: 3, truncated: false });
    expect(JSON.stringify(data)).not.toContain(root); // no absolute paths
  });

  test("401, 400 for a malformed id, 404 for an unknown case", async () => {
    const id = await newCase("tree-access");
    expect((await routes.files(request(`/api/cases/${id}/files`, { cookie: false }), ctx(id))).status).toBe(401);
    expect((await routes.files(request(`/api/cases/x/files`), ctx("nope"))).status).toBe(400);
    expect((await routes.files(request(`/api/cases/${UNKNOWN}/files`), ctx(UNKNOWN))).status).toBe(404);
  });
});

describe("GET /api/cases/:caseId/files/content", () => {
  const get = (id: string, query: string, options: { cookie?: boolean } = {}) =>
    routes.content(request(`/api/cases/${id}/files/content?${query}`, options), ctx(id));

  test("returns a file's text and line count", async () => {
    const id = await newCase("content", { "src/index.js": "one\ntwo\n" });
    const res = await get(id, "path=src%2Findex.js");
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ path: "src/index.js", content: "one\ntwo\n", lineCount: 2 });
    expect((await (await get(id, "path=src/index.js&version=original")).json()).data.path).toBe("src/index.js");
  });

  test("traversal, absolute and encoded paths are 400 and never read anything", async () => {
    const id = await newCase("content-attack");
    for (const p of ["../../etc/passwd", "..%2f..%2fetc%2fpasswd", "%252e%252e%252fsecret", "/etc/passwd", "~/.ssh/id_rsa", "src/../../x", "..\\..\\x", ".."]) {
      const res = await get(id, `path=${p}`);
      expect(res.status, p).toBe(400);
      expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
    }
  });

  test("a missing or empty path, an unknown version, and extra junk are 400", async () => {
    const id = await newCase("content-validate");
    for (const q of ["", "path=", "version=original", "path=test.js&version=other", "path=test.js&version="]) {
      expect((await get(id, q)).status, q).toBe(400);
    }
  });

  test("missing file 404, directory 400, binary 422, oversized 413", async () => {
    const id = await newCase("content-kinds", {
      "bin/data.bin": Buffer.from([1, 2, 0, 3, 4]),
      "big.txt": "x".repeat(512 * 1024 + 1),
    });
    expect((await get(id, "path=nope.js")).status).toBe(404);
    expect((await get(id, "path=bin")).status).toBe(400);
    const binary = await get(id, "path=bin%2Fdata.bin");
    expect(binary.status).toBe(422);
    expect((await binary.json()).error.code).toBe("UNSUPPORTED_FILE");
    const big = await get(id, "path=big.txt");
    expect(big.status).toBe(413);
    expect((await big.json()).error.code).toBe("TOO_LARGE");
  });

  test("a file from another case cannot be reached through this case's id", async () => {
    const a = await newCase("scope-a", { "only-in-a.txt": "A SECRET" });
    const b = await newCase("scope-b");
    expect((await get(b, "path=only-in-a.txt")).status).toBe(404);
    expect((await get(a, "path=only-in-a.txt")).status).toBe(200);
  });

  test("version=working is 404 until a patch is approved, then serves the working copy", async () => {
    const id = await newCase("working", { "src/a.js": "original\n" });
    expect((await get(id, "path=src/a.js&version=working")).status).toBe(404);

    // as approval would leave it: a working copy with the change, and an approved patch
    const dataDir = path.join(root, "data", "cases", id);
    cpSync(path.join(dataDir, "original"), path.join(dataDir, "working"), { recursive: true });
    chmodSync(path.join(dataDir, "working"), 0o755);
    chmodSync(path.join(dataDir, "working", "src"), 0o755);
    chmodSync(path.join(dataDir, "working", "src", "a.js"), 0o644);
    writeFileSync(path.join(dataDir, "working", "src", "a.js"), "patched\n");
    const finding = getDb().insert(schema.findings).values({ caseId: id, label: "hypothesis", title: "t", explanation: "e", evidenceJson: "[]" }).returning().get();
    getDb().insert(schema.patches).values({ caseId: id, findingId: finding.id, attempt: 1, rationale: "r", editsJson: "[]", diffText: "", filesAffectedJson: "[]", model: "m", status: "approved" }).run();

    expect((await (await get(id, "path=src/a.js&version=working")).json()).data.content).toBe("patched\n");
    expect((await (await get(id, "path=src/a.js")).json()).data.content).toBe("original\n"); // original untouched
  });

  test("401 without a session, 403 for a wrong Host, 404 for an unknown case, 400 for a malformed id", async () => {
    const id = await newCase("content-access");
    expect((await get(id, "path=test.js", { cookie: false })).status).toBe(401);
    expect((await routes.content(request(`/x?path=test.js`, { headers: { host: "evil.example:3000" } }), ctx(id))).status).toBe(403);
    expect((await get(UNKNOWN, "path=test.js")).status).toBe(404);
    expect((await routes.content(request(`/x?path=test.js`), ctx("bad"))).status).toBe(400);
  });
});
