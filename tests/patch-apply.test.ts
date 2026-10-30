import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { removeTree } from "@/lib/cases/fs";
import { importFolder, type ImportContext } from "@/lib/cases/import";
import { openDatabase, type OpenDatabase } from "@/lib/db/client";
import { cases, findings, jobs, patches } from "@/lib/db/schema";
import { approvePatch, rejectPatch } from "@/lib/patch/apply";

let root: string;
let open: OpenDatabase;
let ctx: ImportContext;

const INDEX = 'const greeter = require("esm-greeter");\nmodule.exports = (n) => greeter.greet(n);\n';
const GOOD = [{ path: "src/index.js", search: 'const greeter = require("esm-greeter");', replace: 'const greeter = import("esm-greeter");' }];

const newCase = async () => {
  const dir = path.join(root, "src", crypto.randomUUID());
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "p", main: "src/index.js" }));
  writeFileSync(path.join(dir, "src/index.js"), INDEX);
  return (await importFolder(dir, ctx)).id;
};
const addPatch = (caseId: string, edits: unknown = GOOD, status: "proposed" | "approved" | "rejected" | "superseded" = "proposed") => {
  const finding = open.db.insert(findings).values({ caseId, label: "supported_by_files", title: "t", explanation: "e", evidenceJson: "[]" }).returning().get();
  return open.db.insert(patches).values({ caseId, findingId: finding.id, attempt: 1, rationale: "r", editsJson: JSON.stringify(edits), diffText: "d", filesAffectedJson: '["src/index.js"]', status, model: "fake" }).returning().get();
};
const deps = () => ({ db: open.db, dataDir: ctx.dataDir });
const folder = (caseId: string, v: string) => path.join(ctx.dataDir, "cases", caseId, v);
const fingerprint = (dir: string): string => {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [`${path.relative(dir, path.join(d, e.name))}:${createHash("sha256").update(readFileSync(path.join(d, e.name))).digest("hex")}`]));
  return walk(dir).sort().join("\n");
};
const caseRow = (id: string) => open.db.select().from(cases).where(eq(cases.id, id)).get()!;
const patchRow = (id: string) => open.db.select().from(patches).where(eq(patches.id, id)).get()!;

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-apply-")));
  mkdirSync(path.join(root, "home"));
  open = openDatabase(path.join(root, "data"));
  ctx = { db: open.db, dataDir: path.join(root, "data"), maxProjectBytes: 1e8, samplesDir: path.join(root, "samples"), homeDir: path.join(root, "home") };
});
afterAll(async () => {
  open.sqlite.close();
  await removeTree(root);
});

describe("approvePatch", () => {
  test("builds working/ with exactly the edits and leaves original/ untouched (T30)", async () => {
    const id = await newCase();
    const before = fingerprint(folder(id, "original"));
    const patch = addPatch(id);
    await approvePatch(id, patch.id, deps());
    expect(readFileSync(path.join(folder(id, "working"), "src/index.js"), "utf8")).toBe(INDEX.replace(GOOD[0].search, GOOD[0].replace));
    const orig = fingerprint(folder(id, "original")).split("\n");
    const work = fingerprint(folder(id, "working")).split("\n");
    expect(work.filter((l) => !orig.includes(l)).map((l) => l.split(":")[0])).toEqual(["src/index.js"]);
    expect(fingerprint(folder(id, "original"))).toBe(before);
    expect(patchRow(patch.id).status).toBe("approved");
    expect(caseRow(id).stage).toBe("patched");
  });

  test("clears the previous verdict and supersedes an earlier approval", async () => {
    const id = await newCase();
    const first = addPatch(id);
    await approvePatch(id, first.id, deps());
    open.db.update(cases).set({ stage: "verified", verdict: "failed", verdictReason: "x", verdictAt: 1 }).where(eq(cases.id, id)).run();
    const second = addPatch(id);
    await approvePatch(id, second.id, deps());
    expect(patchRow(first.id).status).toBe("superseded");
    expect(patchRow(second.id).status).toBe("approved");
    expect(caseRow(id)).toMatchObject({ stage: "patched", verdict: null, verdictReason: null, verdictAt: null });
  });

  test("a patch id from another case is 404 (T12)", async () => {
    const a = await newCase();
    const b = await newCase();
    const patch = addPatch(b);
    await expect(approvePatch(a, patch.id, deps())).rejects.toMatchObject({ status: 404 });
    expect(() => rejectPatch(a, patch.id, deps())).toThrow(expect.objectContaining({ status: 404 }));
    expect(existsSync(folder(a, "working"))).toBe(false);
  });

  test.each([["superseded", "That patch was replaced by a newer one."], ["rejected", "That patch was already rejected."], ["approved", "That patch is already approved."]] as const)("the 409 for a %s patch says so in plain words", async (status, message) => {
    const id = await newCase();
    const patch = addPatch(id, GOOD, status);
    await expect(approvePatch(id, patch.id, deps())).rejects.toMatchObject({ status: 409, code: "WRONG_STATE", message });
  });

  test.each(["superseded", "rejected", "approved"] as const)("a %s patch is 409", async (status) => {
    const id = await newCase();
    const patch = addPatch(id, GOOD, status);
    await expect(approvePatch(id, patch.id, deps())).rejects.toMatchObject({ status: 409, code: "WRONG_STATE" });
    expect(existsSync(folder(id, "working"))).toBe(false);
  });

  test("edits that no longer match leave no working/ and the patch proposed", async () => {
    const id = await newCase();
    const patch = addPatch(id, [{ path: "src/index.js", search: "not in the file", replace: "x" }]);
    await expect(approvePatch(id, patch.id, deps())).rejects.toMatchObject({ status: 409 });
    expect(existsSync(folder(id, "working"))).toBe(false);
    expect(readdirSync(path.join(folder(id, "original"), "..")).sort()).toEqual(["original"]);
    expect(patchRow(patch.id).status).toBe("proposed");
    expect(caseRow(id).stage).not.toBe("patched");
  });

  test("a failure mid-copy leaves no working/ and the patch proposed", async () => {
    const id = await newCase();
    const patch = addPatch(id, [{ path: "src/index.js", search: GOOD[0].search, replace: "x" }]);
    // a file the copy cannot read breaks the copy half-way
    const dir = path.join(folder(id, "original"), "src");
    chmodSync(dir, 0o755);
    writeFileSync(path.join(dir, "unreadable.js"), "x", { mode: 0o200 });
    chmodSync(dir, 0o555);
    await expect(approvePatch(id, patch.id, deps())).rejects.toThrow();
    expect(readdirSync(path.join(folder(id, "original"), ".."))).toEqual(["original"]);
    expect(patchRow(patch.id).status).toBe("proposed");
  });

  test("a running step blocks approval (409 JOB_RUNNING)", async () => {
    const id = await newCase();
    const patch = addPatch(id);
    open.db.insert(jobs).values({ caseId: id, kind: "verify", status: "running" }).run();
    await expect(approvePatch(id, patch.id, deps())).rejects.toMatchObject({ status: 409, code: "JOB_RUNNING" });
  });
});

describe("rejectPatch", () => {
  test("marks rejected, returns to diagnosed, original/ byte-identical", async () => {
    const id = await newCase();
    const before = fingerprint(folder(id, "original"));
    const patch = addPatch(id);
    rejectPatch(id, patch.id, deps());
    expect(patchRow(patch.id)).toMatchObject({ status: "rejected" });
    expect(caseRow(id).stage).toBe("diagnosed");
    expect(fingerprint(folder(id, "original"))).toBe(before);
    expect(existsSync(folder(id, "working"))).toBe(false);
  });

  test("a non-proposed patch is 409", async () => {
    const id = await newCase();
    const patch = addPatch(id, GOOD, "superseded");
    expect(() => rejectPatch(id, patch.id, deps())).toThrow(expect.objectContaining({ status: 409 }));
  });
});
