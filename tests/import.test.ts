import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { removeTree } from "@/lib/cases/fs";
import { importFolder, importSample, type ImportContext } from "@/lib/cases/import";
import { openDatabase, type OpenDatabase } from "@/lib/db/client";
import { cases } from "@/lib/db/schema";
import { AppError } from "@/lib/http/respond";

let root: string;
let open: OpenDatabase;
let ctx: ImportContext;

const write = (base: string, rel: string, content = "x") => {
  const full = path.join(base, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
};

/** A small Node project directly under `root/<name>`. */
const project = (name: string, extra: Record<string, string> = {}) => {
  const dir = path.join(root, name);
  write(dir, "package.json", JSON.stringify({ name, version: "1.0.0", scripts: { test: "node test.js" } }));
  write(dir, "test.js", "console.log('hi')\n");
  for (const [rel, content] of Object.entries(extra)) write(dir, rel, content);
  return dir;
};

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return `${error.status} ${error.code}`;
    throw error;
  }
  return "no error";
};

const caseDirs = () => (existsSync(path.join(ctx.dataDir, "cases")) ? readdirSync(path.join(ctx.dataDir, "cases")) : []);

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-import-")));
  mkdirSync(path.join(root, "home"));
  mkdirSync(path.join(root, "samples"));
  open = openDatabase(path.join(root, "data"));
  ctx = {
    db: open.db,
    dataDir: path.join(root, "data"),
    maxProjectBytes: 10 * 1024 * 1024,
    samplesDir: path.join(root, "samples"),
    homeDir: path.join(root, "home"),
  };
});
afterEach(async () => {
  try {
    open.sqlite.close();
  } catch {
    /* already closed by a test */
  }
  await removeTree(root);
});

describe("importFolder: the happy path", () => {
  test("creates a case from a Node project and copies its files", async () => {
    const dir = project("my-app", { "src/index.js": "console.log(1)", "node_modules/dep/index.js": "module.exports=1", "node_modules/dep/package.json": "{}" });
    const result = await importFolder(dir, ctx);

    expect(result).toMatchObject({ name: "my-app", stage: "imported", fileCount: 3 }); // package.json, test.js, src/index.js
    expect(result.sizeBytes).toBeGreaterThan(0);

    const row = ctx.db.select().from(cases).where(eq(cases.id, result.id)).get()!;
    expect(row).toMatchObject({ name: "my-app", sourceKind: "folder", sourceLabel: dir, stage: "imported", verdict: null });
    expect(row.sizeBytes).toBe(result.sizeBytes);

    const original = path.join(ctx.dataDir, "cases", result.id, "original");
    expect(readFileSync(path.join(original, "src/index.js"), "utf8")).toBe("console.log(1)");
    expect(existsSync(path.join(original, "node_modules/dep/index.js"))).toBe(true); // node_modules is copied (checks run offline)
  });

  test("size_bytes counts node_modules, file_count does not", async () => {
    const dir = project("sizes", { "node_modules/big/data.txt": "y".repeat(5000) });
    const result = await importFolder(dir, ctx);
    expect(result.fileCount).toBe(2);
    expect(result.sizeBytes).toBeGreaterThan(5000);
  });

  test("the name falls back to the folder name and is capped at 120 characters", async () => {
    const noName = path.join(root, "folder-name");
    write(noName, "package.json", "{}");
    expect((await importFolder(noName, ctx)).name).toBe("folder-name");

    const long = path.join(root, "long");
    write(long, "package.json", JSON.stringify({ name: "n".repeat(300) }));
    expect((await importFolder(long, ctx)).name).toHaveLength(120);
  });

  test("a path given through a symlink resolves to the real folder", async () => {
    const dir = project("real-one");
    const link = path.join(root, "link-to-project");
    symlinkSync(dir, link);
    const result = await importFolder(link, ctx);
    expect(ctx.db.select().from(cases).where(eq(cases.id, result.id)).get()!.sourceLabel).toBe(dir);
  });
});

describe("the original copy is read-only", () => {
  test("files and folders have no write bit and cannot be changed", async () => {
    const dir = project("ro", { "src/a.js": "a" });
    const { id } = await importFolder(dir, ctx);
    const original = path.join(ctx.dataDir, "cases", id, "original");

    for (const rel of ["", "src", "src/a.js", "package.json"]) {
      expect(lstatSync(path.join(original, rel)).mode & 0o222, rel || "(root)").toBe(0);
    }
    await expect(writeFile(path.join(original, "src/a.js"), "changed")).rejects.toMatchObject({ code: "EACCES" });
    await expect(writeFile(path.join(original, "new.js"), "new")).rejects.toMatchObject({ code: "EACCES" });
    expect(readFileSync(path.join(original, "src/a.js"), "utf8")).toBe("a");
  });

  test("removeTree can still delete it (needed for deleting a case)", async () => {
    const { id } = await importFolder(project("deletable", { "src/a.js": "a" }), ctx);
    await removeTree(path.join(ctx.dataDir, "cases", id));
    expect(existsSync(path.join(ctx.dataDir, "cases", id))).toBe(false);
  });
});

describe("what is not copied", () => {
  test("symlinks anywhere outside node_modules/.bin", async () => {
    const outside = path.join(root, "outside-secret.txt");
    writeFileSync(outside, "SECRET");
    const dir = project("links", { "src/real.js": "r" });
    symlinkSync(outside, path.join(dir, "link-root.txt"));
    symlinkSync(outside, path.join(dir, "src", "link-src.txt"));
    symlinkSync("real.js", path.join(dir, "src", "inside-link.js")); // even harmless ones
    symlinkSync(root, path.join(dir, "link-dir"));

    const { id } = await importFolder(dir, ctx);
    const original = path.join(ctx.dataDir, "cases", id, "original");
    expect(readdirSync(original).sort()).toEqual(["package.json", "src", "test.js"]);
    expect(readdirSync(path.join(original, "src"))).toEqual(["real.js"]);
  });

  test("node_modules/.bin links are kept when relative and inside node_modules, dropped otherwise", async () => {
    const dir = project("bin", { "node_modules/tool/cli.js": "#!/usr/bin/env node\n" });
    const bin = path.join(dir, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync("../tool/cli.js", path.join(bin, "tool")); // good
    symlinkSync("../../../outside.txt", path.join(bin, "escape")); // leaves node_modules
    symlinkSync(path.join(dir, "test.js"), path.join(bin, "absolute")); // absolute
    symlinkSync("../tool/cli.js", path.join(dir, "node_modules", "tool", "not-in-bin")); // not in .bin

    const { id } = await importFolder(dir, ctx);
    const copiedBin = path.join(ctx.dataDir, "cases", id, "original", "node_modules", ".bin");
    expect(readdirSync(copiedBin)).toEqual(["tool"]);
    expect(lstatSync(path.join(copiedBin, "tool")).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(copiedBin, "tool"), "utf8")).toBe("#!/usr/bin/env node\n"); // resolves inside the copy
    expect(existsSync(path.join(ctx.dataDir, "cases", id, "original", "node_modules", "tool", "not-in-bin"))).toBe(false);
  });

  test(".git, .ssh, .aws and .gnupg folders are skipped at any depth", async () => {
    const dir = project("secrets", {
      ".git/config": "g",
      "sub/.git/config": "g",
      "deploy/.ssh/id_rsa": "KEY",
      ".aws/credentials": "KEY",
      "a/b/.gnupg/secring": "KEY",
      "src/ok.js": "ok",
    });
    const { id } = await importFolder(dir, ctx);
    const original = path.join(ctx.dataDir, "cases", id, "original");
    const all = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [e.name, ...all(path.join(d, e.name))] : [e.name]));
    const names = all(original);
    for (const bad of [".git", ".ssh", ".aws", ".gnupg", "id_rsa", "credentials", "secring"]) expect(names, bad).not.toContain(bad);
    expect(names).toContain("ok.js");
  });
});

describe("refusals leave nothing behind", () => {
  const nothingCreated = async () => {
    expect(ctx.db.select().from(cases).all()).toHaveLength(0);
    expect(caseDirs()).toEqual([]);
  };

  test("no package.json, invalid JSON, or a non-object manifest: 422 UNSUPPORTED_PROJECT", async () => {
    const none = path.join(root, "empty");
    mkdirSync(none);
    expect(await failure(importFolder(none, ctx))).toBe("422 UNSUPPORTED_PROJECT");

    const bad = path.join(root, "bad-json");
    write(bad, "package.json", "{ nope");
    expect(await failure(importFolder(bad, ctx))).toBe("422 UNSUPPORTED_PROJECT");

    const arr = path.join(root, "array");
    write(arr, "package.json", "[]");
    expect(await failure(importFolder(arr, ctx))).toBe("422 UNSUPPORTED_PROJECT");
    await nothingCreated();
  });

  test("over the size limit: 413 TOO_LARGE before anything is copied", async () => {
    const dir = project("big", { "data.bin": "z".repeat(2000) });
    expect(await failure(importFolder(dir, { ...ctx, maxProjectBytes: 1000 }))).toBe("413 TOO_LARGE");
    await nothingCreated();
  });

  test("the size limit counts node_modules too", async () => {
    const dir = project("big-deps", { "node_modules/huge/blob": "z".repeat(5000) });
    expect(await failure(importFolder(dir, { ...ctx, maxProjectBytes: 1000 }))).toBe("413 TOO_LARGE");
  });

  test("a database failure after copying removes the copied files", async () => {
    const dir = project("db-fails");
    open.sqlite.close(); // the insert will now throw
    await expect(importFolder(dir, ctx)).rejects.toThrow();
    expect(caseDirs()).toEqual([]);
  });

  test("a path that does not exist, or is a file, is 404", async () => {
    expect(await failure(importFolder(path.join(root, "nope"), ctx))).toBe("404 NOT_FOUND");
    expect(await failure(importFolder(path.join(root, "home", "..", "samples", "missing"), ctx))).toBe("404 NOT_FOUND");
    write(root, "just-a-file.txt");
    expect(await failure(importFolder(path.join(root, "just-a-file.txt"), ctx))).toBe("404 NOT_FOUND");
  });

  test("relative, empty, NUL and non-string paths are 400", async () => {
    for (const bad of ["relative/path", "./x", "", "~", "/tmp/x\0y", undefined, 5]) {
      expect(await failure(importFolder(bad as string, ctx)), String(bad)).toBe("400 VALIDATION_FAILED");
    }
  });
});

describe("folders that are refused as accidents (400)", () => {
  test("the filesystem root", async () => {
    expect(await failure(importFolder("/", ctx))).toBe("400 VALIDATION_FAILED");
  });

  test("the home directory itself, and any folder that contains it", async () => {
    write(ctx.homeDir, "package.json", "{}");
    expect(await failure(importFolder(ctx.homeDir, ctx))).toBe("400 VALIDATION_FAILED");
    write(root, "package.json", "{}"); // root contains home
    expect(await failure(importFolder(root, ctx))).toBe("400 VALIDATION_FAILED");
  });

  test("a project inside the home directory is fine", async () => {
    const dir = path.join(ctx.homeDir, "code", "app");
    write(dir, "package.json", "{}");
    expect((await importFolder(dir, ctx)).stage).toBe("imported");
  });

  test("a folder with a .ssh, .aws or .gnupg segment in its path", async () => {
    for (const hidden of [".ssh", ".aws", ".gnupg"]) {
      const dir = path.join(root, "x", hidden, "proj");
      write(dir, "package.json", "{}");
      expect(await failure(importFolder(dir, ctx)), hidden).toBe("400 VALIDATION_FAILED");
    }
  });

  test("a folder inside Revenant's data folder, and one that contains it", async () => {
    const insideData = path.join(ctx.dataDir, "scratch");
    write(insideData, "package.json", "{}");
    expect(await failure(importFolder(insideData, ctx))).toBe("400 VALIDATION_FAILED");

    const parent = path.join(root, "parent");
    write(parent, "package.json", "{}");
    expect(await failure(importFolder(parent, { ...ctx, dataDir: path.join(parent, "data") }))).toBe("400 VALIDATION_FAILED");
  });

  test("a symlink to a refused folder is refused too (the real path is checked)", async () => {
    const link = path.join(root, "innocent-name");
    symlinkSync(ctx.homeDir, link);
    write(ctx.homeDir, "package.json", "{}");
    expect(await failure(importFolder(link, ctx))).toBe("400 VALIDATION_FAILED");
  });
});

describe("importSample", () => {
  const sample = (id: string) => {
    const dir = path.join(ctx.samplesDir, id);
    write(dir, "package.json", JSON.stringify({ name: id, scripts: { test: "node test.js" } }));
    write(dir, "test.js", "process.exit(1)");
    write(dir, "sample.json", '{"name":"x"}');
    write(dir, "expected.json", '{"failingCheck":"test","expectedFile":"test.js"}');
    write(dir, "node_modules/dep/index.js", "1");
    return dir;
  };

  test("imports a prepared sample as a case with kind sample", async () => {
    sample("broken-esm");
    const result = await importSample("broken-esm", ctx);
    expect(ctx.db.select().from(cases).where(eq(cases.id, result.id)).get()).toMatchObject({
      name: "broken-esm",
      sourceKind: "sample",
      sourceLabel: "broken-esm",
    });
    expect(result.fileCount).toBe(2);
  });

  test("the answer key (expected.json) and sample.json are not copied into the project", async () => {
    sample("broken-esm");
    const { id } = await importSample("broken-esm", ctx);
    const original = path.join(ctx.dataDir, "cases", id, "original");
    expect(readdirSync(original).sort()).toEqual(["node_modules", "package.json", "test.js"]);
  });

  test("the answer key is only withheld at the sample root", async () => {
    const dir = sample("deep");
    write(dir, "src/expected.json", '{"a":1}');
    const { id } = await importSample("deep", ctx);
    expect(existsSync(path.join(ctx.dataDir, "cases", id, "original", "src", "expected.json"))).toBe(true);
  });

  test("unknown, malformed and path-like sample ids are 404", async () => {
    sample("real");
    for (const id of ["nope", "../real", "real/../real", "REAL", "a b", "", "real\0", ".", "..", "/etc"]) {
      expect(await failure(importSample(id, ctx)), JSON.stringify(id)).toBe("404 NOT_FOUND");
    }
  });

  test("a sample that is a symlink pointing outside the samples folder is 404", async () => {
    const outside = project("outside-project");
    symlinkSync(outside, path.join(ctx.samplesDir, "sneaky"));
    expect(await failure(importSample("sneaky", ctx))).toBe("404 NOT_FOUND");
    expect(caseDirs()).toEqual([]);
  });

  test("a sample without package.json is 422", async () => {
    mkdirSync(path.join(ctx.samplesDir, "broken"));
    expect(await failure(importSample("broken", ctx))).toBe("422 UNSUPPORTED_PROJECT");
  });
});

test("the importer never runs project code", () => {
  for (const file of ["import", "fs", "store", "inventory"]) {
    const source = readFileSync(`src/lib/cases/${file}.ts`, "utf8");
    expect(source, file).not.toMatch(/child_process|\beval\s*\(|new Function|\bexec(Sync|File)?\s*\(|\bspawn(Sync)?\s*\(|require\(/);
  }
});
