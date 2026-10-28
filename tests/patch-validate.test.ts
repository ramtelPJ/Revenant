import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { removeTree } from "@/lib/cases/fs";
import { changedLines, filesAffected, renderDiff } from "@/lib/patch/diff";
import { PATCH_LIMITS, describeErrors, validateEdits, type Edit } from "@/lib/patch/validate";

let root: string;
let dir: string;

const INDEX = 'const greeter = require("esm-greeter");\n\nmodule.exports = (name) => greeter.greet(name);\n';
const write = (rel: string, content: string | Buffer) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), content);
};
const edit = (over: Partial<Edit> = {}): Edit => ({ path: "src/index.js", search: 'const greeter = require("esm-greeter");', replace: 'const greeter = await import("esm-greeter");', ...over });
const errorsOf = (edits: Edit[]) => {
  const result = validateEdits(dir, edits);
  if (result.ok) throw new Error("expected the edits to be rejected");
  return result.errors;
};
const snapshot = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? snapshot(path.join(d, e.name)) : [`${path.join(d, e.name)}:${statSync(path.join(d, e.name)).mtimeMs}:${readFileSync(path.join(d, e.name)).toString("base64")}`])).sort();

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-patch-")));
  dir = path.join(root, "project");
  write("package.json", '{"name":"p"}\n');
  write("src/index.js", INDEX);
  write("src/other.js", "const a = 1;\nconst b = 2;\n");
  write("src/dup.js", "x();\nx();\n");
  write("src/win.js", "const a = 1;\r\nconst b = 2;\r\n");
  write("src/big.js", Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n") + "\n");
  write("package-lock.json", "{}\n");
  write("yarn.lock", "x\n");
  write("node_modules/dep/index.js", "module.exports = 1;\n");
  write(".git/config", "[core]\n");
  write("bin/data.bin", Buffer.from([1, 2, 0, 3]));
  symlinkSync("/etc/hosts", path.join(dir, "src/link.js"));
});
afterAll(async () => {
  chmodSync(dir, 0o755);
  await removeTree(root);
});

describe("an acceptable patch", () => {
  test("is accepted and returns the changed file text and the number of changed lines", () => {
    const result = validateEdits(dir, [edit()]);
    expect(result).toMatchObject({ ok: true, changedLines: 2 });
    if (!result.ok) return;
    expect(result.changes).toEqual([{ path: "src/index.js", before: INDEX, after: INDEX.replace('require("esm-greeter")', 'await import("esm-greeter")') }]);
  });
  test("an edit may delete text (empty replace) and several edits in one file are applied together", () => {
    const result = validateEdits(dir, [{ path: "src/other.js", search: "const a = 1;\n", replace: "" }, { path: "src/other.js", search: "const b = 2;", replace: "const b = 3;" }]);
    expect(result.ok && result.changes[0].after).toBe("const b = 3;\n");
  });
  test("the order of edits in one file does not matter", () => {
    const edits = [{ path: "src/other.js", search: "const a = 1;", replace: "const a = 10;" }, { path: "src/other.js", search: "const b = 2;", replace: "const b = 20;" }];
    const forward = validateEdits(dir, edits);
    const backward = validateEdits(dir, [...edits].reverse());
    expect(forward.ok && backward.ok && forward.changes[0].after === backward.changes[0].after).toBe(true);
  });
  test("paths written as ./x, /app/x or with backslashes are the same file", () => {
    for (const p of ["./src/index.js", "/app/src/index.js", "src\\index.js"]) expect(validateEdits(dir, [edit({ path: p })]).ok, p).toBe(true);
  });
  test("a file with Windows line endings can be edited with a model's \\n text", () => {
    const result = validateEdits(dir, [{ path: "src/win.js", search: "const a = 1;\nconst b = 2;", replace: "const a = 5;\nconst b = 6;" }]);
    expect(result.ok && result.changes[0].after).toBe("const a = 5;\r\nconst b = 6;\r\n");
  });
});

describe("limits", () => {
  test("up to 5 edits pass, 6 fail", () => {
    const five = Array.from({ length: PATCH_LIMITS.edits }, (_, i) => ({ path: "src/big.js", search: `line ${i}\n`, replace: `LINE ${i}\n` }));
    expect(validateEdits(dir, five).ok).toBe(true);
    expect(errorsOf([...five, { path: "src/big.js", search: "line 9\n", replace: "x\n" }]).join()).toContain("Too many edits: 6. At most 5");
  });
  test("up to 3 files pass, 4 fail", () => {
    const three = [edit(), { path: "src/other.js", search: "const a = 1;", replace: "const a = 2;" }, { path: "package.json", search: '"p"', replace: '"q"' }];
    expect(validateEdits(dir, three).ok).toBe(true);
    expect(errorsOf([...three, { path: "src/dup.js", search: "x();\nx();", replace: "y();" }]).join()).toContain("Too many files: 4. At most 3");
  });
  test("60 changed lines pass, 61 fail", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n";
    // 30 lines removed + 30 added = 60
    expect(validateEdits(dir, [{ path: "src/big.js", search: lines(30), replace: Array.from({ length: 30 }, (_, i) => `new ${i}`).join("\n") + "\n" }])).toMatchObject({ ok: true, changedLines: 60 });
    const over = errorsOf([{ path: "src/big.js", search: lines(31), replace: Array.from({ length: 30 }, (_, i) => `new ${i}`).join("\n") + "\n" }]);
    expect(over[0]).toContain("61 lines");
    expect(over[0]).toContain("At most 60");
  });
  test("no edits at all fails", () => {
    expect(errorsOf([])[0]).toContain("No edits");
  });
});

describe("paths (T24)", () => {
  test.each([
    ["node_modules/dep/index.js", "node_modules or .git"],
    ["src/../node_modules/dep/index.js", "node_modules or .git"],
    [".git/config", "node_modules or .git"],
    ["package-lock.json", "lockfiles"],
    ["yarn.lock", "lockfiles"],
    ["../outside.js", "relative path to a file inside the project"],
    ["src/../../outside.js", "relative path to a file inside the project"],
    ["/etc/passwd", "relative path to a file inside the project"],
    ["~/.ssh/id_rsa", "relative path to a file inside the project"],
    ["src/%2e%2e/x.js", "relative path to a file inside the project"],
    ["src", "relative path to a file inside the project"],
    ["src/link.js", "relative path to a file inside the project"],
    ["src/missing.js", "does not exist"],
    ["bin/data.bin", "binary file"],
  ])("%s is rejected: %s", (p, reason) => {
    const errors = errorsOf([edit({ path: p, search: "x", replace: "y" })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(reason);
    expect(errors[0]).toContain(p.replace(/^\.\//, "").replace(/\\/g, "/"));
  });
});

describe("the search text", () => {
  test("an empty search is rejected", () => {
    expect(errorsOf([edit({ search: "" })])[0]).toContain("search text is empty");
  });
  test("a search that is not in the file is rejected, whitespace included", () => {
    expect(errorsOf([edit({ search: 'const greeter = require("nope");' })])[0]).toContain("was not found");
    expect(errorsOf([edit({ search: 'const  greeter = require("esm-greeter");' })])[0]).toContain("match the file exactly");
  });
  test("a search that occurs twice is ambiguous and rejected", () => {
    const [error] = errorsOf([{ path: "src/dup.js", search: "x();", replace: "y();" }]);
    expect(error).toContain("appears more than once");
    expect(error).toContain("Edit 1 (src/dup.js)");
  });
  test("overlapping matches count as ambiguous", () => {
    write("src/ab.js", "aaa\n");
    expect(errorsOf([{ path: "src/ab.js", search: "aa", replace: "b" }])[0]).toContain("appears more than once");
  });
  test("a replacement equal to the search changes nothing and is rejected", () => {
    expect(errorsOf([edit({ replace: edit().search })])[0]).toContain("nothing changes");
  });
  test("two edits to the same text are rejected", () => {
    const [error] = errorsOf([{ path: "src/other.js", search: "const a = 1;", replace: "A" }, { path: "src/other.js", search: "a = 1;\nconst b", replace: "B" }]);
    expect(error).toContain("Edit 2 and edit 1");
    expect(error).toContain("same text");
  });
  test("every broken rule is reported at once, numbered by edit, ready for the retry prompt", () => {
    const errors = errorsOf([edit({ path: "node_modules/dep/index.js" }), edit({ search: "nope" }), edit({ path: "../y.js" })]);
    expect(errors).toHaveLength(3);
    expect(describeErrors(errors)).toMatch(/^1\. .*\n2\. .*\n3\. /);
  });
});

describe("validation never writes", () => {
  test("neither accepted nor rejected patches change a single byte or timestamp, and the folder can be read-only", () => {
    const before = snapshot(dir);
    chmodSync(path.join(dir, "src"), 0o555);
    try {
      validateEdits(dir, [edit()]);
      validateEdits(dir, [edit({ search: "nope" }), edit({ path: "../x" })]);
      validateEdits(dir, [{ path: "src/other.js", search: "const a = 1;", replace: "z" }]);
    } finally {
      chmodSync(path.join(dir, "src"), 0o755);
    }
    expect(snapshot(dir)).toEqual(before);
  });
});

describe("diff", () => {
  test("the diff of a known edit is exactly this unified diff", () => {
    const result = validateEdits(dir, [edit()]);
    if (!result.ok) throw new Error("rejected");
    expect(renderDiff(result.changes)).toBe(
      [
        "--- a/src/index.js",
        "+++ b/src/index.js",
        "@@ -1,3 +1,3 @@",
        '-const greeter = require("esm-greeter");',
        '+const greeter = await import("esm-greeter");',
        " ",
        " module.exports = (name) => greeter.greet(name);",
        "",
      ].join("\n"),
    );
  });
  test("several files give one diff in the order of the edits, and the affected list has no repeats", () => {
    const result = validateEdits(dir, [{ path: "src/other.js", search: "const a = 1;", replace: "const a = 2;" }, edit(), { path: "src/other.js", search: "const b = 2;", replace: "const b = 3;" }]);
    if (!result.ok) throw new Error("rejected");
    expect(filesAffected(result.changes)).toEqual(["src/other.js", "src/index.js"]);
    const diff = renderDiff(result.changes);
    expect(diff.indexOf("a/src/other.js")).toBeLessThan(diff.indexOf("a/src/index.js"));
  });
  test("changed lines are counted from a real diff: unchanged lines do not count", () => {
    expect(changedLines("a\nb\nc\n", "a\nB\nc\n")).toBe(2);
    expect(changedLines("a\nb\n", "a\nb\n")).toBe(0);
    expect(changedLines("a\n", "a\nb\nc\n")).toBe(2);
    expect(changedLines("a\nb\n", "")).toBe(2);
  });
  test("no change gives an empty diff body", () => {
    expect(renderDiff([])).toBe("");
  });
});
