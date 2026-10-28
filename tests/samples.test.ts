// Checks the shipped samples themselves: structure, import, and (with real Docker) that the broken one really
// fails inside the sandbox, the control passes, and a one-file fix repairs the broken one.
import { cp, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { buildInventory } from "@/lib/cases/inventory";
import { removeTree } from "@/lib/cases/fs";
import { importFolder, importSample, type ImportContext } from "@/lib/cases/import";
import { openDatabase, type OpenDatabase } from "@/lib/db/client";
import { FINDING_CATEGORIES } from "@/lib/db/schema";
import { CHECK_KINDS } from "@/lib/sandbox/checks";
import { runDocker } from "@/lib/sandbox/docker";
import { checkDocker } from "@/lib/sandbox/docker-health";
import { runCheck, type RunContext } from "@/lib/sandbox/run";

const SAMPLES = path.resolve("samples");
const sampleIds = readdirSync(SAMPLES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

const expectedSchema = z.union([
  z.object({ failingCheck: z.null() }),
  z.object({ failingCheck: z.enum(CHECK_KINDS as [string, ...string[]]), expectedCategory: z.enum(FINDING_CATEGORIES), expectedFile: z.string().min(1) }),
]);
const sampleSchema = z.object({ name: z.string().min(1), description: z.string().min(1) });
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

const FIXED_INDEX = `module.exports = async function hello(name) {
  const { greet } = await import("esm-greeter");
  return greet(name);
};
`;

let root: string;
let open: OpenDatabase;
let importCtx: ImportContext;

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-samples-")));
  mkdirSync(path.join(root, "home"));
  open = openDatabase(path.join(root, "data"));
  importCtx = { db: open.db, dataDir: path.join(root, "data"), maxProjectBytes: 100 * 1024 * 1024, samplesDir: SAMPLES, homeDir: path.join(root, "home") };
});
afterAll(async () => {
  open.sqlite.close();
  await removeTree(root);
});

test("the expected samples exist", () => {
  expect(sampleIds).toEqual(expect.arrayContaining(["broken-esm", "control-working"]));
});

describe.each(sampleIds)("sample %s", (id) => {
  const dir = path.join(SAMPLES, id);

  test("has a valid package.json, sample.json and expected.json", () => {
    expect(readJson(path.join(dir, "package.json")).name).toBe(id);
    expect(sampleSchema.safeParse(readJson(path.join(dir, "sample.json"))).success).toBe(true);
    const expected = expectedSchema.parse(readJson(path.join(dir, "expected.json")));
    if (expected.failingCheck !== null) {
      expect(existsSync(path.join(dir, (expected as { expectedFile: string }).expectedFile)), "expectedFile must exist").toBe(true);
      expect(readJson(path.join(dir, "package.json")).scripts).toHaveProperty(expected.failingCheck);
    }
  });

  test("contains no symlinks outside node_modules (the importer would drop them)", () => {
    const visit = (current: string): string[] =>
      readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name === "node_modules") return [];
        const full = path.join(current, entry.name);
        if (entry.isSymbolicLink()) return [full];
        return entry.isDirectory() ? visit(full) : [];
      });
    expect(visit(dir)).toEqual([]);
  });

  test("is prepared: dependencies are installed as real folders (run `npm run prepare-samples` if this fails)", () => {
    const manifest = readJson(path.join(dir, "package.json"));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const installed = path.join(dir, "node_modules", name);
      expect(existsSync(installed), `${name} is not installed`).toBe(true);
      expect(lstatSync(installed).isSymbolicLink(), `${name} must be a real folder, not a link`).toBe(false);
    }
  });

  test("imports as a case; the answer key and sample.json do not reach the case folder", async () => {
    const result = await importSample(id, importCtx);
    const original = path.join(importCtx.dataDir, "cases", result.id, "original");
    const names = readdirSync(original);
    expect(names).not.toContain("expected.json");
    expect(names).not.toContain("sample.json");
    expect(names).toEqual(expect.arrayContaining(["package.json", "test.js", "src", "node_modules", "vendor"]));

    const inventory = buildInventory(original);
    expect(inventory).toMatchObject({ name: id, hasNodeModules: true });
    expect(inventory.availableChecks).toEqual([{ kind: "test", command: "npm test" }]);
    expect(inventory.entryPoints).toContainEqual({ path: "src/index.js", source: "main", exists: true });
    expect(inventory.dependencies).toHaveProperty("esm-greeter");
  });
});

describe("the broken sample is one small file away from the control", () => {
  test("src/index.js is the only file that differs, and the control is the fixed version", () => {
    const files = (dir: string, rel = ""): string[] =>
      readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
        if (e.name === "node_modules") return [];
        const r = rel ? `${rel}/${e.name}` : e.name;
        return e.isDirectory() ? files(dir, r) : [r];
      });
    const broken = path.join(SAMPLES, "broken-esm");
    const control = path.join(SAMPLES, "control-working");
    const differing = files(broken).filter((f) => !["sample.json", "expected.json", "README.md", "package.json", "package-lock.json"].includes(f) && readFileSync(path.join(broken, f)).compare(readFileSync(path.join(control, f))) !== 0);
    expect(differing).toEqual(["src/index.js"]);
    expect(readFileSync(path.join(control, "src/index.js"), "utf8")).toBe(FIXED_INDEX);
  });
});

const health = await checkDocker("node:lts-slim", undefined, 30_000);
const dockerReady = health.available && health.imagePresent;

describe.runIf(dockerReady)("in the real sandbox", { timeout: 90_000 }, () => {
  let ctx: RunContext;
  beforeAll(() => {
    ctx = { db: open.db, dataDir: importCtx.dataDir, limits: { image: "node:lts-slim", memoryMb: 512, cpus: 1, timeoutSec: 60 }, docker: runDocker };
  });
  const check = async (caseId: string) => runCheck({ caseId, kind: "test", phase: "baseline", target: "original", consent: true }, ctx);

  test("broken-esm FAILS its test with the real module error", async () => {
    const { id } = await importSample("broken-esm", importCtx);
    const row = await check(id);
    expect(row.status).toBe("failed");
    expect(row.exitCode).not.toBe(0);
    expect(row.outputExcerpt).toContain("ERR_REQUIRE_ASYNC_MODULE");
    expect(row.outputExcerpt).toContain("esm-greeter");
  });

  test("control-working PASSES its test", async () => {
    const { id } = await importSample("control-working", importCtx);
    const row = await check(id);
    expect(row.status, row.outputExcerpt ?? "").toBe("passed");
    expect(row.outputExcerpt).toContain("ok: greeting works");
  });

  test("the one-file fix makes broken-esm pass", async () => {
    const fixed = path.join(root, "broken-esm-fixed");
    await cp(path.join(SAMPLES, "broken-esm"), fixed, { recursive: true });
    await writeFile(path.join(fixed, "src/index.js"), FIXED_INDEX);
    const { id } = await importFolder(fixed, importCtx);
    const row = await check(id);
    expect(row.status, row.outputExcerpt ?? "").toBe("passed");
  });
});

test.skipIf(dockerReady)("sample sandbox tests were SKIPPED: Docker or the node:lts-slim image is not available", () => {});
