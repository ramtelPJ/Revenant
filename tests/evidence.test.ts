import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyEvidence, type EvidenceSources } from "@/lib/ai/evidence";
import { computeLabel, type BaselineRun } from "@/lib/ai/label";
import type { Evidence } from "@/lib/ai/schemas";

let dir: string;
let sources: EvidenceSources;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "rv-evidence-"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src/index.js"), 'const { greet } = require("esm-greeter");\n\nmodule.exports = function hello(name) {\n    return greet(name);\n};\n');
  writeFileSync(path.join(dir, ".env"), "TOKEN=abcdef");
  sources = { projectDir: dir, logs: [{ text: "user log: TypeError: x is not a function\n  at foo" }], outputs: [{ id: "run-1", text: "Error [ERR_REQUIRE_ASYNC_MODULE]: require() cannot be used\n    at /app/src/index.js:1:20" }] };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = (over: Partial<Evidence> = {}): Evidence => ({ kind: "file", path: "src/index.js", startLine: 1, endLine: 1, quote: 'require("esm-greeter")', ...over });
const ver = (items: Evidence[]) => verifyEvidence(items, sources);
const baseline = (over: Partial<BaselineRun> = {}): BaselineRun => ({ id: "run-1", phase: "baseline", target: "original", status: "failed", outputExcerpt: sources.outputs[0].text, ...over });

describe("verifyEvidence (T23)", () => {
  it("keeps a true file citation", () => {
    expect(ver([file()])).toEqual({ verified: [{ kind: "file", path: "src/index.js", startLine: 1, endLine: 1, quote: 'require("esm-greeter")' }], dropped: 0 });
  });

  it("drops fabricated files, files outside the project, secret files and node_modules", () => {
    const r = ver([file({ path: "src/ghost.js" }), file({ path: "../x.js" }), file({ path: "/etc/passwd" }), file({ path: ".env", quote: "TOKEN" }), file({ path: "node_modules/a/index.js" })]);
    expect(r).toEqual({ verified: [], dropped: 5 });
  });

  it("drops out-of-range lines, reversed ranges and ranges that are too wide", () => {
    expect(ver([file({ startLine: 99, endLine: 99 }), file({ startLine: 3, endLine: 2 }), file({ startLine: 1, endLine: 400 })]).dropped).toBe(3);
  });

  it("drops a quote that is not in the cited lines (even if it is elsewhere in the file)", () => {
    expect(ver([file({ quote: "invented()" }), file({ startLine: 4, endLine: 4 })]).dropped).toBe(2);
  });

  it("drops a missing or tiny quote", () => {
    expect(ver([file({ quote: undefined }), file({ quote: "  " }), file({ quote: "ab" })]).dropped).toBe(3);
  });

  it("ignores whitespace differences in quotes", () => {
    const r = ver([file({ startLine: 3, endLine: 4, quote: "hello(name)   {\n return   greet(name);" })]);
    expect(r.dropped).toBe(0);
    expect(r.verified).toHaveLength(1);
  });

  it("finds the lines itself when the model gives none", () => {
    const r = ver([file({ startLine: undefined, endLine: undefined, quote: "return greet(name);" })]);
    expect(r.verified[0]).toMatchObject({ startLine: 4, endLine: 4 });
  });

  it("verifies a log excerpt against a check output (with its run id) or a user log, else drops it", () => {
    const r = ver([
      { kind: "log", excerpt: "ERR_REQUIRE_ASYNC_MODULE" },
      { kind: "log", excerpt: "x is not  a function" },
      { kind: "log", excerpt: "never printed anywhere" },
    ]);
    expect(r.verified).toEqual([
      { kind: "log", excerpt: "ERR_REQUIRE_ASYNC_MODULE", origin: "check", checkRunId: "run-1" },
      { kind: "log", excerpt: "x is not a function", origin: "log" },
    ]);
    expect(r.dropped).toBe(1);
  });

  it("removes duplicates without counting them as dropped", () => {
    expect(ver([file(), file()])).toMatchObject({ dropped: 0, verified: [expect.anything()] });
  });
});

describe("computeLabel", () => {
  const v = (e: Evidence[]) => verifyEvidence(e, sources).verified;

  it("zero verified items is a hypothesis, even with a failed check", () => {
    expect(computeLabel([], baseline(), dir)).toEqual({ label: "hypothesis", checkRunId: null });
  });

  it("a failed baseline plus a citation of its output is confirmed_by_check, with the run id", () => {
    expect(computeLabel(v([{ kind: "log", excerpt: "ERR_REQUIRE_ASYNC_MODULE" }]), baseline(), dir)).toEqual({ label: "confirmed_by_check", checkRunId: "run-1" });
  });

  it("a failed baseline plus the file its output names is confirmed_by_check", () => {
    expect(computeLabel(v([file()]), baseline(), dir).label).toBe("confirmed_by_check");
  });

  it("a file the output does not name is only supported_by_files", () => {
    writeFileSync(path.join(dir, "other.js"), "const unrelated = 1;\n");
    expect(computeLabel(v([{ kind: "file", path: "other.js", quote: "unrelated" }]), baseline(), dir)).toEqual({ label: "supported_by_files", checkRunId: null });
  });

  it.each(["passed", "unrunnable", "timed_out"])("a %s baseline can never confirm", (status) => {
    expect(computeLabel(v([file(), { kind: "log", excerpt: "ERR_REQUIRE_ASYNC_MODULE" }]), baseline({ status }), dir).label).toBe("supported_by_files");
  });

  it("only a baseline run on the original counts (not an 'after' run or a patched copy)", () => {
    expect(computeLabel(v([file()]), baseline({ phase: "after" }), dir).label).toBe("supported_by_files");
    expect(computeLabel(v([file()]), baseline({ target: "working" }), dir).label).toBe("supported_by_files");
  });

  it("a user log alone, with no baseline, is supported_by_files and never confirmed", () => {
    expect(computeLabel(v([{ kind: "log", excerpt: "x is not a function" }]), null, dir)).toEqual({ label: "supported_by_files", checkRunId: null });
  });

  it("a log excerpt copied from the user's log does not confirm against the check", () => {
    expect(computeLabel(v([{ kind: "log", excerpt: "x is not a function" }]), baseline(), dir).label).toBe("supported_by_files");
  });
});
