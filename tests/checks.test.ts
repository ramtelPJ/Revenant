import { describe, expect, test } from "vitest";
import { CHECKS, CHECK_KINDS, evaluateCheck, isCheckKind, timeoutSecFor } from "@/lib/sandbox/checks";

test("the allowlist is exactly test, build and start with fixed npm commands", () => {
  expect(CHECK_KINDS).toEqual(["test", "build", "start"]);
  expect(Object.fromEntries(Object.entries(CHECKS).map(([k, v]) => [k, v.command]))).toEqual({
    test: ["npm", "test"],
    build: ["npm", "run", "build"],
    start: ["npm", "start"],
  });
});

test("isCheckKind accepts only allowlisted names", () => {
  for (const ok of CHECK_KINDS) expect(isCheckKind(ok)).toBe(true);
  for (const bad of ["lint", "TEST", "test ", "rm -rf /", "", undefined, null, 1, {}, "__proto__", "constructor"]) {
    expect(isCheckKind(bad), String(bad)).toBe(false);
  }
});

test("start gets a 15 s cap (or less); test and build use the configured timeout", () => {
  expect(timeoutSecFor("test", 120)).toBe(120);
  expect(timeoutSecFor("build", 300)).toBe(300);
  expect(timeoutSecFor("start", 120)).toBe(15);
  expect(timeoutSecFor("start", 10)).toBe(10);
});

describe("evaluateCheck", () => {
  const run = (exitCode: number | null, extra: Partial<{ timedOut: boolean; survived: boolean }> = {}) => ({
    exitCode,
    timedOut: false,
    survived: false,
    ...extra,
  });

  test.each(["test", "build"] as const)("%s passes only on exit 0", (kind) => {
    expect(evaluateCheck(kind, run(0))).toBe("passed");
    expect(evaluateCheck(kind, run(1))).toBe("failed");
    expect(evaluateCheck(kind, run(137))).toBe("failed");
    expect(evaluateCheck(kind, run(null))).toBe("failed");
  });

  test.each(["test", "build"] as const)("%s never passes just by surviving", (kind) => {
    expect(evaluateCheck(kind, run(137, { survived: true }))).toBe("failed");
  });

  test("a timeout is timed_out, even if the exit code looks like success", () => {
    for (const kind of CHECK_KINDS) expect(evaluateCheck(kind, run(0, { timedOut: true }))).toBe("timed_out");
  });

  test("start passes on exit 0 or when still running at the survival time, fails on an early non-zero exit", () => {
    expect(evaluateCheck("start", run(0))).toBe("passed");
    expect(evaluateCheck("start", run(137, { survived: true }))).toBe("passed");
    expect(evaluateCheck("start", run(1))).toBe("failed");
    expect(evaluateCheck("start", run(null))).toBe("failed");
  });
});
