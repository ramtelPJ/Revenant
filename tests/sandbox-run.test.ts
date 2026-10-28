import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { caseFolder } from "@/lib/cases/files";
import { removeTree } from "@/lib/cases/fs";
import { importFolder, type ImportContext } from "@/lib/cases/import";
import { openDatabase, type OpenDatabase } from "@/lib/db/client";
import { checkRuns, findings, patches } from "@/lib/db/schema";
import { AppError } from "@/lib/http/respond";
import { containerName, type DockerResult } from "@/lib/sandbox/docker";
import { runCheck, type RunCheckInput, type RunContext } from "@/lib/sandbox/run";

let root: string;
let open: OpenDatabase;
let docker: ReturnType<typeof vi.fn>;
let ctx: RunContext;

const write = (base: string, rel: string, content = "x") => {
  const full = path.join(base, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
};

const finished = (over: Partial<Extract<DockerResult, { kind: "finished" }>> = {}): DockerResult => ({
  kind: "finished", exitCode: 0, timedOut: false, survived: false, aborted: false, output: "ok\n", truncated: false, durationMs: 42, ...over,
});

/** Imports a project (so `original/` is the real read-only copy) and returns its case id. */
async function newCase(files: Record<string, string> = {}, manifest: Record<string, unknown> = { name: "p", scripts: { test: "node test.js", build: "node build.js", start: "node server.js" } }) {
  const dir = path.join(root, "src-projects", randomUUID());
  write(dir, "package.json", JSON.stringify(manifest));
  write(dir, "test.js", "console.log('t')");
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  const importCtx: ImportContext = { db: open.db, dataDir: ctx.dataDir, maxProjectBytes: 50 * 1024 * 1024, samplesDir: path.join(root, "samples"), homeDir: path.join(root, "home") };
  return (await importFolder(dir, importCtx)).id;
}
const randomUUID = () => crypto.randomUUID();

/** A working copy plus an approved patch, as the approve step would leave them. */
async function approvedPatch(caseId: string, status: "approved" | "proposed" = "approved") {
  const working = caseFolder(caseId, "working", ctx.dataDir);
  await cp(caseFolder(caseId, "original", ctx.dataDir), working, { recursive: true, verbatimSymlinks: true });
  const { chmod } = await import("node:fs/promises");
  await chmod(working, 0o755);
  const finding = open.db.insert(findings).values({ caseId, label: "hypothesis", title: "t", explanation: "e", evidenceJson: "[]" }).returning().get();
  return open.db.insert(patches).values({ caseId, findingId: finding.id, attempt: 1, rationale: "r", editsJson: "[]", diffText: "", filesAffectedJson: "[]", model: "m", status }).returning().get();
}

const baseline = (caseId: string, over: Partial<RunCheckInput> = {}): RunCheckInput => ({ caseId, kind: "test", phase: "baseline", target: "original", consent: true, ...over });
const rows = () => open.db.select().from(checkRuns).all();
const runDirs = () => (existsSync(path.join(ctx.dataDir, "runs")) ? readdirSync(path.join(ctx.dataDir, "runs")) : []);

/** Hash of a folder's names, contents and symlink targets, for "this folder did not change". */
function treeHash(dir: string): string {
  const hash = createHash("sha256");
  const visit = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      const stat = lstatSync(full);
      hash.update(path.relative(dir, full));
      if (stat.isSymbolicLink()) hash.update(`->${readlinkSync(full)}`);
      else if (stat.isDirectory()) visit(full);
      else hash.update(readFileSync(full));
    }
  };
  visit(dir);
  return hash.digest("hex");
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return `${error.status} ${error.code}`;
    throw error;
  }
  return "no error";
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-run-")));
  mkdirSync(path.join(root, "home"));
  open = openDatabase(path.join(root, "data"));
  docker = vi.fn(async () => finished());
  ctx = {
    db: open.db,
    dataDir: path.join(root, "data"),
    limits: { image: "node:lts-slim", memoryMb: 512, cpus: 1, timeoutSec: 120 },
    docker: docker as unknown as RunContext["docker"],
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  try {
    open.sqlite.close();
  } catch {
    /* closed by the test */
  }
  await removeTree(root);
});

describe("consent", () => {
  test.each([[false], [undefined], ["true"], [1], [null], [{}], [[true]]])("consent = %j is refused: no row, no spawn", async (consent) => {
    const caseId = await newCase();
    expect(await code(runCheck(baseline(caseId, { consent: consent as unknown as boolean }), ctx))).toBe("400 CONSENT_REQUIRED");
    expect(rows()).toHaveLength(0);
    expect(docker).not.toHaveBeenCalled();
    expect(runDirs()).toEqual([]);
  });

  test("consent is checked before anything else, even before the case is looked up", async () => {
    expect(await code(runCheck(baseline("no-such-case", { consent: false }), ctx))).toBe("400 CONSENT_REQUIRED");
  });

  test("every stored run carries the time consent was given", async () => {
    const caseId = await newCase();
    const before = Date.now();
    const row = await runCheck(baseline(caseId), ctx);
    expect(row.consentedAt).toBeGreaterThanOrEqual(before);
    expect(row.consentedAt).toBeLessThanOrEqual(Date.now());
  });
});

describe("misuse", () => {
  test("an unknown check kind is refused, with no row and no spawn", async () => {
    const caseId = await newCase();
    for (const kind of ["lint", "TEST", "", "test; id", "__proto__"]) {
      expect(await code(runCheck(baseline(caseId, { kind: kind as never }), ctx)), kind).toBe("400 VALIDATION_FAILED");
    }
    expect(rows()).toHaveLength(0);
    expect(docker).not.toHaveBeenCalled();
  });

  test("an unknown case is 404", async () => {
    expect(await code(runCheck(baseline("nope"), ctx))).toBe("404 NOT_FOUND");
    expect(rows()).toHaveLength(0);
  });

  test("phase, target and patch must agree", async () => {
    const caseId = await newCase();
    const patch = await approvedPatch(caseId);
    for (const bad of [
      { phase: "baseline", target: "working" },
      { phase: "baseline", target: "original", patchId: patch.id },
      { phase: "after", target: "original", patchId: patch.id },
      { phase: "after", target: "working" },
      { phase: "during", target: "original" },
    ]) {
      expect(await code(runCheck(baseline(caseId, bad as never), ctx)), JSON.stringify(bad)).toBe("400 VALIDATION_FAILED");
    }
    expect(docker).not.toHaveBeenCalled();
  });

  test("an after run needs an approved patch of THIS case", async () => {
    const a = await newCase();
    const b = await newCase();
    const patchOfA = await approvedPatch(a);
    const proposedOfB = await approvedPatch(b, "proposed");

    const after = (caseId: string, patchId: string): RunCheckInput => ({ caseId, kind: "test", phase: "after", target: "working", patchId, consent: true });
    expect(await code(runCheck(after(b, patchOfA.id), ctx))).toBe("404 NOT_FOUND"); // another case's patch
    expect(await code(runCheck(after(b, proposedOfB.id), ctx))).toBe("409 WRONG_STATE"); // not approved
    expect(await code(runCheck(after(a, "missing"), ctx))).toBe("404 NOT_FOUND");
    expect(rows()).toHaveLength(0);
  });

  test("a missing working folder is 404 and leaves no row", async () => {
    const caseId = await newCase();
    const patch = open.db.insert(findings).values({ caseId, label: "hypothesis", title: "t", explanation: "e", evidenceJson: "[]" }).returning().get();
    const approved = open.db.insert(patches).values({ caseId, findingId: patch.id, attempt: 1, rationale: "r", editsJson: "[]", diffText: "", filesAffectedJson: "[]", model: "m", status: "approved" }).returning().get();
    const input: RunCheckInput = { caseId, kind: "test", phase: "after", target: "working", patchId: approved.id, consent: true };
    expect(await code(runCheck(input, ctx))).toBe("404 NOT_FOUND");
    expect(rows()).toHaveLength(0);
  });
});

describe("recording results", () => {
  test("a passing run: status, exit code, output, duration, applied limits", async () => {
    const caseId = await newCase();
    docker.mockResolvedValue(finished({ output: "all good\n", durationMs: 1234 }));
    const row = await runCheck(baseline(caseId), ctx);
    expect(row).toMatchObject({ caseId, phase: "baseline", checkKind: "test", commandLabel: "npm test", target: "original", status: "passed", exitCode: 0, outputExcerpt: "all good\n", unrunnableReason: null, durationMs: 1234, patchId: null });
    expect(JSON.parse(row.limitsJson)).toEqual({ memoryMb: 512, cpus: 1, pids: 256, timeoutSec: 120, network: "none" });
    expect(row.finishedAt).toBeGreaterThanOrEqual(row.startedAt);
    expect(rows()).toHaveLength(1);
  });

  test("a failing run keeps the project's error text", async () => {
    const caseId = await newCase();
    docker.mockResolvedValue(finished({ exitCode: 1, output: "Error [ERR_REQUIRE_ESM]: require() of ES Module\n" }));
    const row = await runCheck(baseline(caseId), ctx);
    expect(row).toMatchObject({ status: "failed", exitCode: 1 });
    expect(row.outputExcerpt).toContain("ERR_REQUIRE_ESM");
  });

  test("a timeout is timed_out", async () => {
    const caseId = await newCase();
    docker.mockResolvedValue(finished({ exitCode: 137, timedOut: true }));
    expect((await runCheck(baseline(caseId), ctx)).status).toBe("timed_out");
  });

  test("start: surviving is a pass and uses the short timeout and survival time", async () => {
    const caseId = await newCase();
    docker.mockResolvedValue(finished({ exitCode: 137, survived: true }));
    const row = await runCheck(baseline(caseId, { kind: "start" }), ctx);
    expect(row.status).toBe("passed");
    expect(JSON.parse(row.limitsJson).timeoutSec).toBe(15);
    expect(docker.mock.calls[0][1]).toMatchObject({ timeoutMs: 15_000, survivalMs: 8000 });
  });

  test("test and build use the configured timeout and no survival rule", async () => {
    const caseId = await newCase();
    await runCheck(baseline(caseId, { kind: "build" }), { ...ctx, limits: { ...ctx.limits, timeoutSec: 77 } });
    expect(docker.mock.calls[0][1]).toMatchObject({ timeoutMs: 77_000, survivalMs: undefined });
  });

  test("cancelling is recorded as unrunnable / cancelled, never as a pass or failure", async () => {
    const caseId = await newCase();
    docker.mockResolvedValue(finished({ exitCode: 137, aborted: true, output: "partial" }));
    const row = await runCheck(baseline(caseId), ctx);
    expect(row).toMatchObject({ status: "unrunnable", unrunnableReason: "cancelled", outputExcerpt: "partial" });
  });

  test("an after run is linked to its patch and runs on the working copy", async () => {
    const caseId = await newCase();
    const patch = await approvedPatch(caseId);
    const row = await runCheck({ caseId, kind: "test", phase: "after", target: "working", patchId: patch.id, consent: true }, ctx);
    expect(row).toMatchObject({ phase: "after", target: "working", patchId: patch.id, status: "passed" });
  });
});

describe("the environment cannot run it: recorded as unrunnable, nothing spawned", () => {
  test("docker not installed / not running / image missing", async () => {
    const caseId = await newCase();
    for (const reason of ["docker_missing", "docker_not_running", "image_missing"] as const) {
      docker.mockResolvedValueOnce({ kind: "unavailable", reason });
      const row = await runCheck(baseline(caseId), ctx);
      expect(row).toMatchObject({ status: "unrunnable", unrunnableReason: reason, exitCode: null, outputExcerpt: null });
    }
    expect(runDirs()).toEqual([]);
  });

  test("the script for this check does not exist", async () => {
    const caseId = await newCase({}, { name: "p", scripts: { test: "node test.js" } });
    const row = await runCheck(baseline(caseId, { kind: "build" }), ctx);
    expect(row).toMatchObject({ status: "unrunnable", unrunnableReason: "script_missing" });
    expect(docker).not.toHaveBeenCalled();
  });

  test("npm init's placeholder test script counts as missing", async () => {
    const caseId = await newCase({}, { name: "p", scripts: { test: 'echo "Error: no test specified" && exit 1' } });
    expect((await runCheck(baseline(caseId), ctx)).unrunnableReason).toBe("script_missing");
    expect(docker).not.toHaveBeenCalled();
  });

  test("declared dependencies but no node_modules: no_node_modules", async () => {
    const caseId = await newCase({}, { name: "p", scripts: { test: "node test.js" }, dependencies: { chalk: "^5" } });
    expect(await runCheck(baseline(caseId), ctx)).toMatchObject({ status: "unrunnable", unrunnableReason: "no_node_modules" });
    expect(docker).not.toHaveBeenCalled();
  });

  test("devDependencies count too", async () => {
    const caseId = await newCase({}, { name: "p", scripts: { test: "node test.js" }, devDependencies: { vitest: "^1" } });
    expect((await runCheck(baseline(caseId), ctx)).unrunnableReason).toBe("no_node_modules");
  });

  test("a project with no dependencies runs without node_modules", async () => {
    const caseId = await newCase({}, { name: "p", scripts: { test: "node test.js" } });
    expect((await runCheck(baseline(caseId), ctx)).status).toBe("passed");
    expect(docker).toHaveBeenCalledTimes(1);
  });

  test("dependencies installed: it runs", async () => {
    const caseId = await newCase({ "node_modules/chalk/index.js": "1" }, { name: "p", scripts: { test: "node test.js" }, dependencies: { chalk: "^5" } });
    expect((await runCheck(baseline(caseId), ctx)).status).toBe("passed");
  });
});

describe("the row comes first, the sandbox runs on a copy, everything is cleaned up", () => {
  test("while docker runs: the row already exists with consent, as unrunnable/in_progress; the folder is a writable copy", async () => {
    const caseId = await newCase({ "node_modules/.bin/placeholder": "x" }.constructor === Object ? { "src/a.js": "a" } : {});
    let seen: { row?: typeof checkRuns.$inferSelect; argsFolder?: string; writable?: boolean; hasSrc?: boolean; isOriginal?: boolean } = {};
    docker.mockImplementation(async (args: string[]) => {
      const folder = args[args.indexOf("-v") + 1].split(":")[0];
      seen = {
        row: open.db.select().from(checkRuns).get(),
        argsFolder: folder,
        hasSrc: existsSync(path.join(folder, "src/a.js")),
        writable: (lstatSync(path.join(folder, "src/a.js")).mode & 0o200) !== 0 && (lstatSync(folder).mode & 0o200) !== 0,
        isOriginal: folder === caseFolder(caseId, "original", ctx.dataDir),
      };
      return finished();
    });
    const row = await runCheck(baseline(caseId), ctx);

    expect(seen.row).toMatchObject({ status: "unrunnable", unrunnableReason: "in_progress", finishedAt: null, caseId });
    expect(seen.row!.consentedAt).toBeGreaterThan(0);
    expect(seen.row!.id).toBe(row.id);
    expect(seen.argsFolder).toBe(path.join(ctx.dataDir, "runs", row.id));
    expect(seen).toMatchObject({ hasSrc: true, writable: true, isOriginal: false });
    expect(docker.mock.calls[0][1].name).toBe(containerName(row.id));
    expect(existsSync(seen.argsFolder!)).toBe(false); // gone afterwards
  });

  test("the temporary copy is removed after pass, fail, unavailable, and a thrown error", async () => {
    const caseId = await newCase();
    docker.mockResolvedValueOnce(finished());
    docker.mockResolvedValueOnce(finished({ exitCode: 1 }));
    docker.mockResolvedValueOnce({ kind: "unavailable", reason: "docker_missing" });
    docker.mockRejectedValueOnce(new Error("boom"));
    for (let i = 0; i < 4; i++) {
      await runCheck(baseline(caseId), ctx);
      expect(runDirs()).toEqual([]);
    }
  });

  test("an unexpected error is recorded as unrunnable / internal_error and does not escape or leak its message", async () => {
    const caseId = await newCase();
    docker.mockRejectedValue(new Error("SECRET /Users/me/path"));
    const row = await runCheck(baseline(caseId), ctx);
    expect(row).toMatchObject({ status: "unrunnable", unrunnableReason: "internal_error" });
    expect(JSON.stringify(row)).not.toContain("SECRET");
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).not.toContain("SECRET");
  });

  test("a project cannot change the case folders: original/ is identical afterwards, and so is working/", async () => {
    const caseId = await newCase({ "src/a.js": "a", "node_modules/dep/i.js": "d" });
    const patch = await approvedPatch(caseId);
    const original = caseFolder(caseId, "original", ctx.dataDir);
    const working = caseFolder(caseId, "working", ctx.dataDir);
    const [o, w] = [treeHash(original), treeHash(working)];

    docker.mockImplementation(async (args: string[]) => {
      const folder = args[args.indexOf("-v") + 1].split(":")[0];
      writeFileSync(path.join(folder, "src/a.js"), "TAMPERED BY THE PROJECT"); // what a hostile test script could do
      writeFileSync(path.join(folder, "new-file"), "x");
      return finished();
    });
    await runCheck(baseline(caseId), ctx);
    await runCheck({ caseId, kind: "test", phase: "after", target: "working", patchId: patch.id, consent: true }, ctx);

    expect(treeHash(original)).toBe(o);
    expect(treeHash(working)).toBe(w);
    expect(lstatSync(path.join(original, "package.json")).mode & 0o222).toBe(0); // still read-only
  });

  test("node_modules/.bin symlinks reach the copy intact", async () => {
    const caseId = await newCase({ "node_modules/tool/cli.js": "#!/usr/bin/env node\n" });
    const bin = path.join(caseFolder(caseId, "original", ctx.dataDir), "node_modules", ".bin");
    expect(existsSync(bin)).toBe(false); // the importer only keeps .bin links that exist in the source
    // build a case whose source has a .bin link
    const dir = path.join(root, "src-projects", randomUUID());
    write(dir, "package.json", JSON.stringify({ name: "p", scripts: { test: "tool" } }));
    write(dir, "node_modules/tool/cli.js", "#!/usr/bin/env node\n");
    mkdirSync(path.join(dir, "node_modules", ".bin"));
    symlinkSync("../tool/cli.js", path.join(dir, "node_modules", ".bin", "tool"));
    const imported = await importFolder(dir, { db: open.db, dataDir: ctx.dataDir, maxProjectBytes: 1e8, samplesDir: path.join(root, "samples"), homeDir: path.join(root, "home") });

    let link: string | undefined;
    docker.mockImplementation(async (args: string[]) => {
      const folder = args[args.indexOf("-v") + 1].split(":")[0];
      link = readlinkSync(path.join(folder, "node_modules", ".bin", "tool"));
      return finished();
    });
    await runCheck(baseline(imported.id), ctx);
    expect(link).toBe("../tool/cli.js");
  });
});

describe("interrupted runs and the startup sweep", () => {
  test("reopening the database drops leftover temp copies and marks in-progress runs interrupted", async () => {
    const caseId = await newCase();
    const row = await runCheck(baseline(caseId), ctx);
    // as if the process died mid-run: the provisional state the runner writes before spawning
    open.db.update(checkRuns).set({ status: "unrunnable", unrunnableReason: "in_progress", finishedAt: null, exitCode: null }).where(eq(checkRuns.id, row.id)).run();
    write(path.join(ctx.dataDir, "runs", "left-over-run"), "package.json", "{}");
    mkdirSync(path.join(ctx.dataDir, "runs", "left-over-run", "locked"));
    const { chmod } = await import("node:fs/promises");
    await chmod(path.join(ctx.dataDir, "runs", "left-over-run", "locked"), 0o555); // even a read-only leftover goes
    open.sqlite.close();

    open = openDatabase(ctx.dataDir);
    expect(runDirs()).toEqual([]);
    const after = open.db.select().from(checkRuns).get()!;
    expect(after).toMatchObject({ status: "unrunnable", unrunnableReason: "interrupted" });
    expect(after.finishedAt).not.toBeNull();
  });

  test("a completed run is never relabeled, even if it somehow carries the in-progress marker", async () => {
    const caseId = await newCase();
    const row = await runCheck(baseline(caseId), ctx); // passed
    open.db.update(checkRuns).set({ unrunnableReason: "in_progress" }).where(eq(checkRuns.id, row.id)).run();
    open.sqlite.close();
    open = openDatabase(ctx.dataDir);
    expect(open.db.select().from(checkRuns).get()).toMatchObject({ status: "passed", unrunnableReason: "in_progress" });
  });

  test("completed runs are not touched by the sweep", async () => {
    const caseId = await newCase();
    docker.mockResolvedValue(finished({ exitCode: 1 }));
    const row = await runCheck(baseline(caseId), ctx);
    open.sqlite.close();
    open = openDatabase(ctx.dataDir);
    expect(open.db.select().from(checkRuns).where(eq(checkRuns.id, row.id)).get()).toMatchObject({ status: "failed", exitCode: 1 });
  });
});

test("the runner has no shell or process spawning of its own", () => {
  const source = readFileSync("src/lib/sandbox/run.ts", "utf8");
  expect(source).not.toMatch(/child_process|\beval\s*\(|new Function|\bexec(Sync|File)?\s*\(|\bspawn(Sync)?\s*\(/);
});
