import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { removeTree } from "@/lib/cases/fs";
import { buildZip, projectEntries } from "./helpers/zip";

let root: string;
let POST: typeof import("@/app/api/cases/route").POST;
let signSession: typeof import("@/lib/http/session").signSession;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-route-")));
  vi.stubEnv("REVENANT_LAUNCH_TOKEN", "a".repeat(64));
  vi.stubEnv("REVENANT_SESSION_SECRET", "b".repeat(64));
  vi.stubEnv("OLLAMA_MODEL", "gemma2:2b");
  vi.stubEnv("PORT", "3000");
  vi.stubEnv("DATA_DIR", path.join(root, "data"));
  vi.stubEnv("MAX_PROJECT_MB", "1");
  vi.stubEnv("MAX_ARCHIVE_MB", "1");
  ({ POST } = await import("@/app/api/cases/route"));
  ({ signSession } = await import("@/lib/http/session"));
});

afterAll(async () => {
  const holder = globalThis as unknown as { __revenantDb?: { sqlite: { close(): void } } };
  holder.__revenantDb?.sqlite.close();
  delete holder.__revenantDb;
  await removeTree(root);
});

const project = (name: string, extra: Record<string, string> = {}) => {
  const dir = path.join(root, "projects", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, scripts: { test: "node t.js" } }));
  for (const [rel, content] of Object.entries(extra)) writeFileSync(path.join(dir, rel), content);
  return dir;
};

type Options = { body?: string; headers?: Record<string, string>; cookie?: boolean };
const post = (options: Options = {}) => {
  const body = options.body;
  const headers: Record<string, string> = {
    host: "127.0.0.1:3000",
    ...(body !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}),
    ...(options.cookie === false ? {} : { cookie: `revenant_session=${signSession()}` }),
    ...options.headers,
  };
  return POST(new Request("http://127.0.0.1:3000/api/cases", { method: "POST", headers, body }), undefined);
};
const json = (value: unknown) => JSON.stringify(value);

describe("access", () => {
  test("without a session it is 401 and creates nothing", async () => {
    const res = await post({ body: json({ kind: "folder", path: project("a") }), cookie: false });
    expect(res.status).toBe(401);
    expect(readdirSync(root)).not.toContain("data");
  });

  test("a wrong Host or a foreign Origin is 403", async () => {
    const body = json({ kind: "folder", path: project("b") });
    expect((await post({ body, headers: { host: "evil.example:3000" } })).status).toBe(403);
    expect((await post({ body, headers: { origin: "https://evil.example" } })).status).toBe(403);
  });

  test("a non-JSON content type is 400", async () => {
    const res = await post({ body: json({ kind: "sample", sampleId: "x" }), headers: { "content-type": "text/plain" } });
    expect(res.status).toBe(400);
  });
});

describe("validation", () => {
  const code = async (res: Response) => (await res.json()).error.code;

  test("malformed JSON is 400 VALIDATION_FAILED, not a 500", async () => {
    const res = await post({ body: "{ not json" });
    expect(res.status).toBe(400);
    expect(await code(res)).toBe("VALIDATION_FAILED");
  });

  test("an unknown kind, a missing field, and wrong types are 400 with a message per field", async () => {
    for (const body of [json({ kind: "url", url: "https://x" }), json({ kind: "folder" }), json({ kind: "sample", sampleId: 5 }), json({}), json(null), json([])]) {
      const res = await post({ body });
      expect(res.status, body).toBe(400);
      expect(await code(res)).toBe("VALIDATION_FAILED");
    }
  });

  test("an oversized body is 413", async () => {
    const res = await post({ body: json({ kind: "folder", path: "x".repeat(200_000) }) });
    expect(res.status).toBe(413);
  });
});

describe("importing a folder", () => {
  test("201 with the new case; the response exposes no internal paths", async () => {
    const dir = project("happy", { "t.js": "1", "src.js": "2" });
    const res = await post({ body: json({ kind: "folder", path: dir }) });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({ name: "happy", stage: "imported", fileCount: 3 });
    expect(data.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(data)).not.toContain(root);
    expect(readdirSync(path.join(root, "data", "cases"))).toContain(data.id);
  });

  test("not a Node project: 422, and no case folder is left", async () => {
    const before = readdirSync(path.join(root, "data", "cases")).length;
    const dir = path.join(root, "projects", "not-node");
    mkdirSync(dir, { recursive: true });
    const res = await post({ body: json({ kind: "folder", path: dir }) });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatchObject({ code: "UNSUPPORTED_PROJECT", message: "No package.json found. Revenant v1 supports Node.js projects." });
    expect(readdirSync(path.join(root, "data", "cases")).length).toBe(before);
  });

  test("over MAX_PROJECT_MB: 413 with a readable message", async () => {
    const dir = project("huge", { "blob.bin": "z".repeat(1024 * 1024 + 10) });
    const res = await post({ body: json({ kind: "folder", path: dir }) });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatchObject({ code: "TOO_LARGE", message: "This project is larger than the 1 MB limit." });
  });

  test("a missing folder is 404, a relative path 400, the filesystem root 400", async () => {
    expect((await post({ body: json({ kind: "folder", path: path.join(root, "nope") }) })).status).toBe(404);
    expect((await post({ body: json({ kind: "folder", path: "relative/dir" }) })).status).toBe(400);
    expect((await post({ body: json({ kind: "folder", path: "/" }) })).status).toBe(400);
  });
});

describe("importing a sample", () => {
  test("an unknown sample is 404 NOT_FOUND", async () => {
    const res = await post({ body: json({ kind: "sample", sampleId: "does-not-exist" }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  test("a path-like sample id is 404, never a file read", async () => {
    for (const sampleId of ["../etc", "..", "a/b", "/etc/passwd"]) {
      expect((await post({ body: json({ kind: "sample", sampleId }) })).status, sampleId).toBe(404);
    }
  });
});

describe("uploading a zip", () => {
  const upload = (form: FormData, headers: Record<string, string> = {}, cookie = true) =>
    POST(
      new Request("http://127.0.0.1:3000/api/cases", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", ...(cookie ? { cookie: `revenant_session=${signSession()}` } : {}), ...headers },
        body: form,
      }),
      undefined,
    );
  const zipForm = (zip: Buffer, name = "project.zip", field = "archive") => {
    const form = new FormData();
    form.append(field, new File([new Uint8Array(zip)], name, { type: "application/zip" }));
    return form;
  };

  test("a valid zip is imported: 201, kind archive", async () => {
    const res = await upload(zipForm(buildZip(projectEntries("proj/", [{ name: "src/a.js", data: "a" }])), "my-project.zip"));
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({ name: "zipped", stage: "imported", fileCount: 3 });
    expect(JSON.stringify(data)).not.toContain(root);
    expect(readdirSync(path.join(root, "data", "cases"))).toContain(data.id);
  });

  test("without a session it is 401 and nothing is read or stored", async () => {
    const before = readdirSync(path.join(root, "data", "cases")).length;
    expect((await upload(zipForm(buildZip(projectEntries())), {}, false)).status).toBe(401);
    expect(readdirSync(path.join(root, "data", "cases")).length).toBe(before);
  });

  test("a wrong Host or foreign Origin is 403", async () => {
    expect((await upload(zipForm(buildZip(projectEntries())), { host: "evil.example:3000" })).status).toBe(403);
    expect((await upload(zipForm(buildZip(projectEntries())), { origin: "https://evil.example" })).status).toBe(403);
  });

  test("a missing archive field, a text field instead of a file, and a non-zip file are 400", async () => {
    expect((await upload(zipForm(buildZip(projectEntries()), "p.zip", "other-field"))).status).toBe(400);
    const text = new FormData();
    text.append("archive", "just a string");
    expect((await upload(text)).status).toBe(400);
    const res = await upload(zipForm(Buffer.from("this is not a zip, only words"), "p.zip"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
  });

  test("a hostile archive is 422 UNSAFE_ARCHIVE and leaves no case folder", async () => {
    const before = readdirSync(path.join(root, "data", "cases")).length;
    const res = await upload(zipForm(buildZip(projectEntries("", [{ name: "../escape.js", data: "x" }]))));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("UNSAFE_ARCHIVE");
    expect(readdirSync(path.join(root, "data", "cases")).length).toBe(before);
  });

  test("a zip that is not a Node project is 422 UNSUPPORTED_PROJECT", async () => {
    const res = await upload(zipForm(buildZip([{ name: "readme.md", data: "hi" }])));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("UNSUPPORTED_PROJECT");
  });

  test("over MAX_ARCHIVE_MB is 413", async () => {
    const res = await upload(zipForm(Buffer.alloc(1024 * 1024 + 100, 7)));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatchObject({ code: "TOO_LARGE", message: "This archive is larger than the 1 MB upload limit." });
  });

  test("a declared upload size far beyond the limit is refused without reading the body", async () => {
    const res = await upload(zipForm(buildZip(projectEntries())), { "content-length": String(50 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });

  test("a project bigger than MAX_PROJECT_MB when unpacked is 413 even though the upload is small", async () => {
    const res = await upload(zipForm(buildZip(projectEntries("", [{ name: "bomb.bin", data: Buffer.alloc(3 * 1024 * 1024) }]))));
    expect(res.status).toBe(413);
  });

  test("JSON requests still work on the same route", async () => {
    const dir = project("still-json");
    expect((await post({ body: json({ kind: "folder", path: dir }) })).status).toBe(201);
  });
});
