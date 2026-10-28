import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { removeTree } from "@/lib/cases/fs";
import { importArchive, type ImportContext } from "@/lib/cases/import";
import { openDatabase, type OpenDatabase } from "@/lib/db/client";
import { cases } from "@/lib/db/schema";
import { AppError } from "@/lib/http/respond";
import { buildZip, projectEntries, type ZipEntry } from "./helpers/zip";

let root: string;
let open: OpenDatabase;
let ctx: ImportContext;

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
const nothingCreated = () => {
  expect(open.db.select().from(cases).all()).toHaveLength(0);
  expect(caseDirs()).toEqual([]);
};
const originalOf = (id: string) => path.join(ctx.dataDir, "cases", id, "original");
const list = (dir: string, rel = ""): string[] =>
  readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? [`${r}/`, ...list(dir, r)] : [r];
  });

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-zip-")));
  mkdirSync(path.join(root, "home"));
  open = openDatabase(path.join(root, "data"));
  ctx = { db: open.db, dataDir: path.join(root, "data"), maxProjectBytes: 10 * 1024 * 1024, samplesDir: path.join(root, "samples"), homeDir: path.join(root, "home"), maxArchiveBytes: 5 * 1024 * 1024 };
});
afterEach(async () => {
  open.sqlite.close();
  await removeTree(root);
});

describe("valid archives", () => {
  test("a project at the root of the zip becomes a case", async () => {
    const result = await importArchive(buildZip(projectEntries("", [{ name: "src/index.js", data: "1" }])), "my project.zip", ctx);
    expect(result).toMatchObject({ name: "zipped", stage: "imported", fileCount: 3 });
    expect(open.db.select().from(cases).where(eq(cases.id, result.id)).get()).toMatchObject({ sourceKind: "archive", sourceLabel: "my project.zip", verdict: null });
    expect(list(originalOf(result.id)).sort()).toEqual(["package.json", "src/", "src/index.js", "test.js"]);
    expect(readFileSync(path.join(originalOf(result.id), "src/index.js"), "utf8")).toBe("1");
  });

  test("a single top-level folder (the usual 'zip the folder') is unwrapped", async () => {
    const { id } = await importArchive(buildZip([{ name: "proj/" }, ...projectEntries("proj/", [{ name: "src/a.js", data: "a" }])]), "proj.zip", ctx);
    expect(list(originalOf(id)).sort()).toEqual(["package.json", "src/", "src/a.js", "test.js"]);
  });

  test("two top-level entries are not unwrapped; a root file stops unwrapping too", async () => {
    const two = await importArchive(buildZip([...projectEntries(""), { name: "docs/readme.md", data: "x" }]), "a.zip", ctx);
    expect(list(originalOf(two.id))).toEqual(expect.arrayContaining(["package.json", "docs/", "docs/readme.md"]));
  });

  test("macOS metadata, .git and credential folders are skipped, wherever they are", async () => {
    const { id } = await importArchive(
      buildZip(projectEntries("proj/", [
        { name: ".git/config", data: "g" }, { name: "deploy/.ssh/id_rsa", data: "KEY" }, { name: ".aws/credentials", data: "KEY" },
        { name: "a/.gnupg/secring", data: "KEY" }, { name: "src/ok.js", data: "ok" },
      ]).concat([{ name: "__MACOSX/proj/._package.json", data: "junk" }, { name: "__MACOSX/", data: "" }])),
      "p.zip", ctx,
    );
    const names = list(originalOf(id));
    for (const bad of [".git", ".ssh", ".aws", ".gnupg", "id_rsa", "credentials", "secring", "__MACOSX", "._package.json"]) {
      expect(names.join("|"), bad).not.toContain(bad);
    }
    expect(names).toContain("src/ok.js");
  });

  test("stored (uncompressed) entries work, and empty files are fine", async () => {
    const { id } = await importArchive(buildZip(projectEntries("", [{ name: "raw.txt", data: "stored", method: 0 }, { name: "empty.txt", data: "" }])), "s.zip", ctx);
    expect(readFileSync(path.join(originalOf(id), "raw.txt"), "utf8")).toBe("stored");
    expect(readFileSync(path.join(originalOf(id), "empty.txt"), "utf8")).toBe("");
  });

  test("executable files stay executable; others do not become executable", async () => {
    const { id } = await importArchive(buildZip(projectEntries("", [{ name: "run.sh", data: "#!/bin/sh\n", unixMode: 0o100755 }, { name: "plain.txt", data: "x", unixMode: 0o100644 }])), "x.zip", ctx);
    expect(lstatSync(path.join(originalOf(id), "run.sh")).mode & 0o111).not.toBe(0);
    expect(lstatSync(path.join(originalOf(id), "plain.txt")).mode & 0o111).toBe(0);
  });

  test("node_modules is copied but not counted in file_count", async () => {
    const result = await importArchive(buildZip(projectEntries("", [{ name: "node_modules/dep/index.js", data: "d" }, { name: "node_modules/dep/package.json", data: "{}" }])), "n.zip", ctx);
    expect(result.fileCount).toBe(2);
    expect(existsSync(path.join(originalOf(result.id), "node_modules/dep/index.js"))).toBe(true);
  });

  test("the result is read-only like every other original", async () => {
    const { id } = await importArchive(buildZip(projectEntries()), "r.zip", ctx);
    expect(lstatSync(path.join(originalOf(id), "package.json")).mode & 0o222).toBe(0);
    await expect(writeFile(path.join(originalOf(id), "new.js"), "x")).rejects.toMatchObject({ code: "EACCES" });
  });

  test("the displayed file name has no folders or control characters, and falls back to the zip name", async () => {
    const a = await importArchive(buildZip(projectEntries()), "../../etc/evil\u0001.zip", ctx);
    expect(open.db.select().from(cases).where(eq(cases.id, a.id)).get()!.sourceLabel).toBe("evil.zip");
    const noName = await importArchive(buildZip([{ name: "package.json", data: "{}" }]), "fallback-name.zip", ctx);
    expect(noName.name).toBe("fallback-name"); // package.json has no name
  });
});

describe("hostile paths are rejected as a whole, and nothing is written anywhere", () => {
  test.each([
    ["parent directory", "../evil.js"],
    ["parent hidden mid-path", "a/../../evil.js"],
    ["backslash traversal", "..\\evil.js"],
    ["absolute path", "/etc/evil.js"],
    ["backslash absolute", "\\evil.js"],
    ["drive letter", "C:\\evil.js"],
    ["NUL byte", "ok.js\0.png"],
  ])("%s", async (_label, name) => {
    const zip = buildZip(projectEntries("", [{ name, data: "EVIL" }]));
    expect(await failure(importArchive(zip, "z.zip", ctx))).toBe("422 UNSAFE_ARCHIVE");
    nothingCreated();
    for (const escaped of [path.join(root, "evil.js"), path.join(ctx.dataDir, "evil.js"), path.join(ctx.dataDir, "cases", "evil.js"), "/etc/evil.js"]) {
      expect(existsSync(escaped), escaped).toBe(false);
    }
  });

  test("one bad entry after many good ones still rejects everything", async () => {
    const good = Array.from({ length: 20 }, (_, i) => ({ name: `src/f${i}.js`, data: "x" }));
    const zip = buildZip([...projectEntries("", good), { name: "../../escape.js", data: "x" }]);
    expect(await failure(importArchive(zip, "z.zip", ctx))).toBe("422 UNSAFE_ARCHIVE");
    nothingCreated();
  });

  test("symlinks and special files", async () => {
    for (const unixMode of [0o120777, 0o010644, 0o020644, 0o060644, 0o140644]) {
      const zip = buildZip(projectEntries("", [{ name: "link", data: "/etc/passwd", unixMode }]));
      expect(await failure(importArchive(zip, "z.zip", ctx)), unixMode.toString(8)).toBe("422 UNSAFE_ARCHIVE");
    }
    nothingCreated();
  });
});

describe("hostile contents are rejected", () => {
  test("too many entries", async () => {
    const entries: ZipEntry[] = Array.from({ length: 50_001 }, (_, i) => ({ name: `f${i}`, data: "", method: 0 as const }));
    expect(await failure(importArchive(buildZip([...projectEntries(), ...entries]), "many.zip", { ...ctx, maxArchiveBytes: 50 * 1024 * 1024 }))).toBe("422 UNSAFE_ARCHIVE");
    nothingCreated();
  });

  test("a zip bomb: a tiny upload that declares far more than the project limit is refused before inflating", async () => {
    const zeros = Buffer.alloc(8 * 1024 * 1024);
    const zip = buildZip(projectEntries("", [{ name: "bomb.bin", data: zeros }]));
    expect(zip.length).toBeLessThan(100 * 1024);
    expect(await failure(importArchive(zip, "bomb.zip", { ...ctx, maxProjectBytes: 1024 * 1024 }))).toBe("413 TOO_LARGE");
    nothingCreated();
  });

  test("several small entries whose declared sizes add up past the limit are refused", async () => {
    const chunk = Buffer.alloc(300 * 1024);
    const zip = buildZip(projectEntries("", Array.from({ length: 5 }, (_, i) => ({ name: `c${i}.bin`, data: chunk }))));
    expect(await failure(importArchive(zip, "sum.zip", { ...ctx, maxProjectBytes: 1024 * 1024 }))).toBe("413 TOO_LARGE");
    nothingCreated();
  });

  test("a header that lies about the size cannot make the entry inflate past what was declared", async () => {
    const real = Buffer.alloc(5 * 1024 * 1024, 1);
    const zip = buildZip(projectEntries("", [{ name: "liar.bin", data: real, size: 10 }]));
    expect(await failure(importArchive(zip, "liar.zip", ctx))).toBe("422 UNSAFE_ARCHIVE");
    nothingCreated();
  });

  test("declared size larger than the real data, a wrong checksum, encryption, odd compression, duplicates", async () => {
    const cases: [string, ZipEntry[]][] = [
      ["size too big", [{ name: "x.bin", data: "hello", size: 999 }]],
      ["bad crc", [{ name: "x.bin", data: "hello", crc: 12345 }]],
      ["encrypted", [{ name: "x.bin", data: "hello", flags: 1 }]],
      ["unsupported method", [{ name: "x.bin", data: "hello", rawMethod: 14 }]],
      ["duplicate names", [{ name: "x.bin", data: "a" }, { name: "x.bin", data: "b" }]],
      ["duplicate after normalising", [{ name: "x.bin", data: "a" }, { name: "./x.bin", data: "b" }]],
      ["file and folder with one name", [{ name: "x", data: "a" }, { name: "x/y.js", data: "b" }]],
    ];
    for (const [label, entries] of cases) {
      expect(await failure(importArchive(buildZip(projectEntries("", entries)), "z.zip", ctx)), label).toBe("422 UNSAFE_ARCHIVE");
      nothingCreated();
    }
  });

  test("stored data that is really deflated data does not pass the checksum", async () => {
    const data = Buffer.from("hello hello hello hello");
    const zip = buildZip(projectEntries("", [{ name: "x.txt", data: deflateRawSync(data), method: 0, size: data.length }]));
    expect(await failure(importArchive(zip, "z.zip", ctx))).toBe("422 UNSAFE_ARCHIVE");
  });
});

describe("not a usable upload", () => {
  test("random bytes, text, empty, a truncated zip, and a zip header with garbage behind it are 400", async () => {
    const valid = buildZip(projectEntries());
    const inputs: [string, Buffer][] = [
      ["random", Buffer.from(Array.from({ length: 200 }, (_, i) => (i * 37) % 256))],
      ["text", Buffer.from("this is not a zip file at all, just some words")],
      ["empty", Buffer.alloc(0)],
      ["truncated", valid.subarray(0, valid.length - 40)],
      ["PK header only", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100, 7)])],
      ["a gzip file", Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, ...Array(30).fill(0)])],
    ];
    for (const [label, bytes] of inputs) expect(await failure(importArchive(bytes, "z.zip", ctx)), label).toBe("400 VALIDATION_FAILED");
    nothingCreated();
  });

  test("over the upload limit is 413 before the archive is even read", async () => {
    expect(await failure(importArchive(Buffer.alloc(6 * 1024 * 1024), "big.zip", ctx))).toBe("413 TOO_LARGE");
    nothingCreated();
  });

  test("an empty zip, no package.json, an invalid one, or one that is too deep are 422 UNSUPPORTED_PROJECT", async () => {
    const zips: [string, Buffer][] = [
      ["empty archive", buildZip([])],
      ["no package.json", buildZip([{ name: "readme.md", data: "hi" }])],
      ["invalid json", buildZip([{ name: "package.json", data: "{ nope" }])],
      ["array manifest", buildZip([{ name: "package.json", data: "[]" }])],
      ["project two levels down", buildZip([{ name: "outer/inner/package.json", data: "{}" }, { name: "outer/inner/a.js", data: "x" }])],
    ];
    for (const [label, zip] of zips) expect(await failure(importArchive(zip, "z.zip", ctx)), label).toBe("422 UNSUPPORTED_PROJECT");
    nothingCreated();
  });

  test("a database failure after extracting removes the extracted files", async () => {
    open.sqlite.close();
    await expect(importArchive(buildZip(projectEntries()), "z.zip", ctx)).rejects.toThrow();
    expect(caseDirs()).toEqual([]);
  });
});

test("the library's extractAllTo is never used", () => {
  expect(readFileSync("src/lib/cases/import.ts", "utf8")).not.toMatch(/extractAllTo|extractEntryTo|\.readFile\(|getData\(/);
});
