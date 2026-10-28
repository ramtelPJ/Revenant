import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildInventory } from "@/lib/cases/inventory";
import { AppError } from "@/lib/http/respond";

let dir: string;

const write = (rel: string, content = "x") => {
  const full = path.join(dir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
};
const manifest = (value: unknown) => write("package.json", JSON.stringify(value));

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "revenant-inv-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return `${error.status} ${error.code}`;
    throw error;
  }
  return "no error";
};

describe("a typical project", () => {
  beforeEach(() => {
    manifest({
      name: "greeter",
      version: "1.2.3",
      main: "./src/index.js",
      bin: { greet: "bin/greet.js" },
      scripts: { start: "node src/server.js", test: "node test.js", build: "tsc" },
      dependencies: { zeta: "^1.0.0", chalk: "^5.0.0" },
      devDependencies: { vitest: "^1.0.0" },
      engines: { node: ">=18" },
    });
    write("src/index.js");
    write("src/server.js");
    write("test.js");
    write("README.md", "# hi");
    write("node_modules/chalk/index.js");
    write("node_modules/chalk/package.json");
    write("node_modules/zeta/deep/er/file.js");
    write(".git/config");
  });

  test("reports facts from package.json", () => {
    const inv = buildInventory(dir);
    expect(inv).toMatchObject({
      name: "greeter",
      version: "1.2.3",
      hasNodeModules: true,
      readme: "README.md",
      engines: { node: ">=18" },
      devDependencies: { vitest: "^1.0.0" },
    });
    expect(inv.scripts).toEqual({ build: "tsc", start: "node src/server.js", test: "node test.js" });
    expect(Object.keys(inv.dependencies)).toEqual(["chalk", "zeta"]); // sorted
  });

  test("node_modules is one collapsed entry with a file count; .git is not listed", () => {
    const inv = buildInventory(dir);
    expect(inv.entries.filter((e) => e.path.startsWith("node_modules/"))).toHaveLength(0);
    expect(inv.entries).toContainEqual({ path: "node_modules", type: "dir", collapsed: true, fileCount: 3 });
    expect(inv.entries.some((e) => e.path.startsWith(".git"))).toBe(false);
    expect(inv.fileCount).toBe(5); // package.json, src/index.js, src/server.js, test.js, README.md
  });

  test("entry points come from main, bin and the start script, with an exists flag", () => {
    const inv = buildInventory(dir);
    expect(inv.entryPoints).toEqual([
      { path: "src/index.js", source: "main", exists: true },
      { path: "bin/greet.js", source: "bin", exists: false },
      { path: "src/server.js", source: "scripts.start", exists: true },
    ]);
  });

  test("available checks follow the scripts that exist", () => {
    expect(buildInventory(dir).availableChecks).toEqual([
      { kind: "test", command: "npm test" },
      { kind: "build", command: "npm run build" },
      { kind: "start", command: "npm start" },
    ]);
  });

  test("lists files with their sizes, parents before children, and is repeatable", () => {
    const first = buildInventory(dir);
    expect(first.entries).toContainEqual({ path: "README.md", type: "file", sizeBytes: 4 });
    expect(first.entries.map((e) => e.path).indexOf("src")).toBeLessThan(first.entries.map((e) => e.path).indexOf("src/index.js"));
    expect(buildInventory(dir)).toEqual(first);
  });
});

describe("available checks edge cases", () => {
  test("the npm-init placeholder test script is not a check", () => {
    manifest({ name: "p", scripts: { test: 'echo "Error: no test specified" && exit 1' } });
    expect(buildInventory(dir).availableChecks).toEqual([]);
  });

  test("a project with no scripts has no checks and no entry points", () => {
    manifest({ name: "p" });
    const inv = buildInventory(dir);
    expect(inv.availableChecks).toEqual([]);
    expect(inv.entryPoints).toEqual([]);
    expect(inv.hasNodeModules).toBe(false);
    expect(inv.readme).toBeNull();
  });

  test("a main that points at a missing file is reported, not hidden", () => {
    manifest({ name: "p", main: "lib/renamed.js", scripts: { start: "node lib/renamed.js" } });
    expect(buildInventory(dir).entryPoints).toContainEqual({ path: "lib/renamed.js", source: "main", exists: false });
  });

  test("non-string script values and dependency values are ignored", () => {
    manifest({ name: "p", scripts: { test: 5, build: "tsc" }, dependencies: { a: "1", b: { x: 1 } } });
    const inv = buildInventory(dir);
    expect(inv.scripts).toEqual({ build: "tsc" });
    expect(inv.dependencies).toEqual({ a: "1" });
  });

  test("name falls back to the folder name", () => {
    manifest({ version: "1.0.0" });
    expect(buildInventory(dir).name).toBe(path.basename(dir));
  });
});

describe("unsupported projects", () => {
  test("no package.json, invalid JSON, and a non-object manifest are 422 UNSUPPORTED_PROJECT", () => {
    expect(code(() => buildInventory(dir))).toBe("422 UNSUPPORTED_PROJECT");
    write("package.json", "{ not json");
    expect(code(() => buildInventory(dir))).toBe("422 UNSUPPORTED_PROJECT");
    write("package.json", "[1,2]");
    expect(code(() => buildInventory(dir))).toBe("422 UNSUPPORTED_PROJECT");
    write("package.json", "null");
    expect(code(() => buildInventory(dir))).toBe("422 UNSUPPORTED_PROJECT");
  });
});

describe("safety", () => {
  test("symlinks are skipped, including ones that point outside the project", () => {
    manifest({ name: "p" });
    const outside = mkdtempSync(path.join(os.tmpdir(), "revenant-inv-out-"));
    writeFileSync(path.join(outside, "secret.txt"), "s");
    symlinkSync(outside, path.join(dir, "link-dir"));
    symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "link-file"));
    const inv = buildInventory(dir);
    expect(inv.entries.map((e) => e.path)).toEqual(["package.json"]);
    rmSync(outside, { recursive: true, force: true });
  });

  test("a very large tree is listed up to a cap and flagged as truncated, counts stay exact", () => {
    manifest({ name: "p" });
    for (let i = 0; i < 5100; i++) writeFileSync(path.join(dir, `f${i}.txt`), "");
    const inv = buildInventory(dir);
    expect(inv.entries.length).toBeLessThanOrEqual(5000);
    expect(inv.truncated).toBe(true);
    expect(inv.fileCount).toBe(5101);
  });
});
