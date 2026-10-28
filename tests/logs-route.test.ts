import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { removeTree } from "@/lib/cases/fs";

let root: string;
let POST: typeof import("@/app/api/cases/[caseId]/logs/route").POST;
let signSession: typeof import("@/lib/http/session").signSession;
let getDb: typeof import("@/lib/db/client").getDb;
let errorLogs: typeof import("@/lib/db/schema").errorLogs;
let importFolder: typeof import("@/lib/cases/import").importFolder;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-logs-")));
  vi.stubEnv("REVENANT_LAUNCH_TOKEN", "a".repeat(64));
  vi.stubEnv("REVENANT_SESSION_SECRET", "b".repeat(64));
  vi.stubEnv("OLLAMA_MODEL", "gemma2:2b");
  vi.stubEnv("PORT", "3000");
  vi.stubEnv("DATA_DIR", path.join(root, "data"));
  ({ POST } = await import("@/app/api/cases/[caseId]/logs/route"));
  ({ signSession } = await import("@/lib/http/session"));
  ({ getDb } = await import("@/lib/db/client"));
  ({ errorLogs } = await import("@/lib/db/schema"));
  ({ importFolder } = await import("@/lib/cases/import"));
});
afterAll(async () => {
  const holder = globalThis as unknown as { __revenantDb?: { sqlite: { close(): void } } };
  holder.__revenantDb?.sqlite.close();
  delete holder.__revenantDb;
  await removeTree(root);
});

const newCase = async () => {
  const dir = path.join(root, "p", crypto.randomUUID());
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "l", scripts: { test: "node t.js" } }));
  return (await importFolder(dir)).id;
};
const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const post = (caseId: string, body: string | undefined, options: { cookie?: boolean; host?: string } = {}) =>
  POST(
    new Request(`http://127.0.0.1:3000/api/cases/${caseId}/logs`, {
      method: "POST",
      headers: {
        host: options.host ?? "127.0.0.1:3000",
        ...(body !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}),
        ...(options.cookie === false ? {} : { cookie: `revenant_session=${signSession()}` }),
      },
      body,
    }),
    { params: Promise.resolve({ caseId }) },
  );
const stored = (caseId: string) => getDb().select().from(errorLogs).where(eq(errorLogs.caseId, caseId)).all();

describe("POST /api/cases/:caseId/logs", () => {
  test("a log is stored as given and answered with 201 and its id", async () => {
    const id = await newCase();
    const res = await post(id, JSON.stringify({ content: "Error: boom\n    at /app/index.js:1:1" }));
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(stored(id)).toMatchObject([{ id: data.id, content: "Error: boom\n    at /app/index.js:1:1" }]);
  });

  test("empty, blank, missing or non-string content is 400 with a message on the content field", async () => {
    const id = await newCase();
    for (const body of [{ content: "" }, { content: "   \n " }, {}, { content: 5 }]) {
      const res = await post(id, JSON.stringify(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      const { error } = await res.json();
      expect(error.code).toBe("VALIDATION_FAILED");
      expect(error.fields).toHaveProperty("content");
    }
    for (const raw of ["{ nope", "null", "[]"]) expect((await post(id, raw)).status, raw).toBe(400);
    expect(stored(id)).toHaveLength(0);
  });

  test("exactly 100,000 characters is accepted; one more is a 400 on the field, not a 413", async () => {
    const id = await newCase();
    expect((await post(id, JSON.stringify({ content: "x".repeat(100_000) }))).status).toBe(201);
    const over = await post(id, JSON.stringify({ content: "x".repeat(100_001) }));
    expect(over.status).toBe(400);
    expect((await over.json()).error.fields.content).toContain("100,000");
  });

  test("a body far beyond the limit is 413 and stores nothing", async () => {
    const id = await newCase();
    expect((await post(id, JSON.stringify({ content: "kept" }))).status).toBe(201);
    expect((await post(id, JSON.stringify({ content: "x".repeat(300_000) }))).status).toBe(413);
    expect(stored(id).map((l) => l.content)).toEqual(["kept"]);
  });

  test("401 without a session, 403 for a wrong Host, 404 for an unknown case, 400 for a malformed id", async () => {
    const id = await newCase();
    const body = JSON.stringify({ content: "log" });
    expect((await post(id, body, { cookie: false })).status).toBe(401);
    expect((await post(id, body, { host: "evil.example:3000" })).status).toBe(403);
    expect((await post(UNKNOWN, body)).status).toBe(404);
    expect((await post("not-a-uuid", body)).status).toBe(400);
    expect(stored(id)).toHaveLength(0);
  });

  test("the log text never reaches the server's own logs, even when the request fails", async () => {
    const id = await newCase();
    const spies = (["log", "warn", "error", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await post(id, JSON.stringify({ content: "SECRET-LOG-TEXT-12345" }));
    await post(UNKNOWN, JSON.stringify({ content: "SECRET-LOG-TEXT-12345" }));
    await post(id, JSON.stringify({ content: "SECRET-LOG-TEXT-12345".repeat(10_000) }));
    const printed = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    spies.forEach((s) => s.mockRestore());
    expect(printed).not.toContain("SECRET-LOG-TEXT");
  });
});
