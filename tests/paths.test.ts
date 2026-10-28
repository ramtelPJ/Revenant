import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { caseFolder, readTextFile, resolveInFolder } from "@/lib/cases/files";
import { AppError } from "@/lib/http/respond";

let root: string;
let project: string;

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return `${error.status} ${error.code}`;
    throw error;
  }
  return "no error";
};

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "revenant-paths-"));
  project = path.join(root, "project");
  const outside = path.join(root, "outside");
  mkdirSync(path.join(project, "src", "deep"), { recursive: true });
  mkdirSync(path.join(project, "node_modules", "dep"), { recursive: true });
  mkdirSync(outside);

  writeFileSync(path.join(project, "package.json"), '{"name":"x"}\n');
  writeFileSync(path.join(project, "src", "index.js"), "line one\nline two\n");
  writeFileSync(path.join(project, "src", "deep", "a.js"), "a");
  writeFileSync(path.join(project, "node_modules", "dep", "index.js"), "dep");
  writeFileSync(path.join(project, "empty.txt"), "");
  writeFileSync(path.join(project, "no-newline.txt"), "one\ntwo");
  writeFileSync(path.join(project, "binary.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  writeFileSync(path.join(project, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9])); // invalid UTF-8
  writeFileSync(path.join(project, "exact.txt"), "x".repeat(512 * 1024));
  writeFileSync(path.join(project, "big.txt"), "x".repeat(512 * 1024 + 1));

  writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET");
  symlinkSync(path.join(outside, "secret.txt"), path.join(project, "link-to-secret.txt"));
  symlinkSync(outside, path.join(project, "link-to-dir"));
  symlinkSync(path.join(project, "src", "index.js"), path.join(project, "link-inside.js"));
  symlinkSync("../../outside/secret.txt", path.join(project, "src", "relative-link.txt"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("readTextFile", () => {
  test("reads a file and reports its line count", () => {
    expect(readTextFile(project, "src/index.js")).toEqual({ path: "src/index.js", content: "line one\nline two\n", lineCount: 2 });
    expect(readTextFile(project, "no-newline.txt").lineCount).toBe(2);
    expect(readTextFile(project, "empty.txt")).toMatchObject({ content: "", lineCount: 0 });
  });

  test("normalizes harmless spellings of the same path", () => {
    expect(readTextFile(project, "./src//index.js").path).toBe("src/index.js");
    expect(readTextFile(project, "src\\index.js").path).toBe("src/index.js");
  });

  test("files inside node_modules can be read (only edits are blocked)", () => {
    expect(readTextFile(project, "node_modules/dep/index.js").content).toBe("dep");
  });
});

describe("path traversal and unsafe input", () => {
  test.each([
    ["parent directory", "../x"],
    ["parent hidden mid-path", "src/../../x"],
    ["parent with backslashes", "..\\x"],
    ["only ..", ".."],
    ["absolute path", "/etc/passwd"],
    ["windows absolute", "C:\\Windows\\system.ini"],
    ["home shortcut", "~/.ssh/id_rsa"],
    ["encoded ..%2f", "..%2fetc%2fpasswd"],
    ["encoded %2e%2e/", "%2e%2e/x"],
    ["encoded backslash", "src%5c..%5c..%5cx"],
    ["NUL byte", "src/index.js\0.png"],
    ["empty", ""],
    ["just a dot", "."],
  ])("%s is rejected with 400 VALIDATION_FAILED", (_name, input) => {
    expect(code(() => readTextFile(project, input))).toBe("400 VALIDATION_FAILED");
    expect(code(() => resolveInFolder(project, input))).toBe("400 VALIDATION_FAILED");
  });

  test("non-string input is rejected, not thrown as a TypeError", () => {
    expect(code(() => resolveInFolder(project, undefined as unknown as string))).toBe("400 VALIDATION_FAILED");
    expect(code(() => resolveInFolder(project, 42 as unknown as string))).toBe("400 VALIDATION_FAILED");
  });

  test("an extremely long path is rejected", () => {
    expect(code(() => resolveInFolder(project, "a/".repeat(600)))).toBe("400 VALIDATION_FAILED");
  });
});

describe("symlinks", () => {
  test("a symlink to a file outside the project is rejected and its content never returned", () => {
    expect(code(() => readTextFile(project, "link-to-secret.txt"))).toBe("400 VALIDATION_FAILED");
    expect(code(() => readTextFile(project, "src/relative-link.txt"))).toBe("400 VALIDATION_FAILED");
  });

  test("a symlinked directory pointing outside is rejected", () => {
    expect(code(() => readTextFile(project, "link-to-dir/secret.txt"))).toBe("400 VALIDATION_FAILED");
  });

  test("a symlink that stays inside the project is allowed", () => {
    expect(readTextFile(project, "link-inside.js").content).toBe("line one\nline two\n");
  });
});

describe("other refusals", () => {
  test("missing files are 404 NOT_FOUND; a missing project folder too", () => {
    expect(code(() => readTextFile(project, "src/nope.js"))).toBe("404 NOT_FOUND");
    expect(code(() => readTextFile(path.join(root, "gone"), "a.js"))).toBe("404 NOT_FOUND");
  });

  test("a directory is not a file", () => {
    expect(code(() => readTextFile(project, "src"))).toBe("400 VALIDATION_FAILED");
  });

  test("binary content and invalid UTF-8 are 422 UNSUPPORTED_FILE", () => {
    expect(code(() => readTextFile(project, "binary.bin"))).toBe("422 UNSUPPORTED_FILE");
    expect(code(() => readTextFile(project, "latin1.txt"))).toBe("422 UNSUPPORTED_FILE");
  });

  test("512 KB is allowed, one byte more is 413 TOO_LARGE", () => {
    expect(readTextFile(project, "exact.txt").content.length).toBe(512 * 1024);
    expect(code(() => readTextFile(project, "big.txt"))).toBe("413 TOO_LARGE");
  });
});

describe("forEdit", () => {
  test("blocks node_modules and .git at any depth, allows ordinary files", () => {
    expect(code(() => resolveInFolder(project, "node_modules/dep/index.js", { forEdit: true }))).toBe("400 VALIDATION_FAILED");
    expect(code(() => resolveInFolder(project, "src/node_modules/x.js", { forEdit: true }))).toBe("400 VALIDATION_FAILED");
    expect(code(() => resolveInFolder(project, ".git/config", { forEdit: true }))).toBe("400 VALIDATION_FAILED");
    expect(code(() => resolveInFolder(project, "src/index.js", { forEdit: true }))).toBe("no error");
  });
});

describe("caseFolder", () => {
  test("builds data/cases/<id>/<version> under the given data dir", () => {
    expect(caseFolder("abc", "original", "/data")).toBe("/data/cases/abc/original");
    expect(caseFolder("abc", "working", "/data")).toBe("/data/cases/abc/working");
  });
});

test("none of the case modules can run commands or evaluate code", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["files", "inventory", "store"]) {
    const source = readFileSync(`src/lib/cases/${file}.ts`, "utf8");
    expect(source, file).not.toMatch(/\beval\s*\(|child_process|\bexec(Sync|File)?\s*\(|\bspawn(Sync)?\s*\(|new Function/);
  }
});
