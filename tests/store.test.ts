import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openDatabase, type OpenDatabase } from "@/lib/db/client";
import { cases, findings, jobs, patches } from "@/lib/db/schema";
import { AppError } from "@/lib/http/respond";
import { createCase, getCaseOr404, getJobOr404, getPatchInCase, updateCase } from "@/lib/cases/store";

let root: string;
let open: OpenDatabase;
let db: OpenDatabase["db"];

const mk = (name = "demo") =>
  createCase({ name, sourceKind: "sample", sourceLabel: "broken-esm", sizeBytes: 1, fileCount: 1 }, db);

const patchFor = (caseId: string) => {
  const finding = db
    .insert(findings)
    .values({ caseId, label: "hypothesis", title: "t", explanation: "e", evidenceJson: "[]" })
    .returning()
    .get();
  return db
    .insert(patches)
    .values({ caseId, findingId: finding.id, attempt: 1, rationale: "r", editsJson: "[]", diffText: "", filesAffectedJson: "[]", model: "m" })
    .returning()
    .get();
};

const failure = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return { status: error.status, code: error.code, message: error.message };
    throw error;
  }
  return null;
};

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "revenant-store-"));
  open = openDatabase(path.join(root, "data"));
  db = open.db;
});
afterEach(() => {
  open.sqlite.close();
  rmSync(root, { recursive: true, force: true });
});

describe("getPatchInCase", () => {
  test("returns the patch for its own case", () => {
    const a = mk();
    const patch = patchFor(a.id);
    expect(getPatchInCase(a.id, patch.id, db).id).toBe(patch.id);
  });

  test("a patch id from another case is 404, indistinguishable from a missing id", () => {
    const a = mk("a");
    const b = mk("b");
    const patch = patchFor(a.id);

    const crossCase = failure(() => getPatchInCase(b.id, patch.id, db));
    const missing = failure(() => getPatchInCase(a.id, "00000000-0000-4000-8000-000000000000", db));
    expect(crossCase).toEqual({ status: 404, code: "NOT_FOUND", message: "We couldn't find that." });
    expect(crossCase).toEqual(missing);
  });
});

describe("getCaseOr404 / getJobOr404", () => {
  test("return rows that exist and 404 for ones that do not", () => {
    const c = mk();
    const job = db.insert(jobs).values({ caseId: c.id, kind: "analyze" }).returning().get();
    expect(getCaseOr404(c.id, db).name).toBe("demo");
    expect(getJobOr404(job.id, db).kind).toBe("analyze");
    expect(failure(() => getCaseOr404("nope", db))?.status).toBe(404);
    expect(failure(() => getJobOr404("nope", db))?.status).toBe(404);
  });
});

describe("createCase / updateCase", () => {
  test("a new case starts at stage imported with no verdict", () => {
    const c = mk();
    expect(c).toMatchObject({ stage: "imported", verdict: null });
  });

  test("updateCase changes the fields and always bumps updated_at", async () => {
    const c = mk();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = updateCase(c.id, { stage: "analyzed" }, db);
    expect(updated.stage).toBe("analyzed");
    expect(updated.updatedAt).toBeGreaterThan(c.updatedAt);
    expect(updated.createdAt).toBe(c.createdAt);
    expect(getCaseOr404(c.id, db).stage).toBe("analyzed");
  });

  test("updating an unknown case is 404", () => {
    expect(failure(() => updateCase("nope", { stage: "analyzed" }, db))?.status).toBe(404);
  });

  test("updateCase ignores id and timestamps smuggled in at runtime", () => {
    const c = mk();
    const smuggled = { stage: "analyzed", id: "other", createdAt: 1, updatedAt: 1 } as unknown as Parameters<typeof updateCase>[1];
    const updated = updateCase(c.id, smuggled, db);
    expect(updated.id).toBe(c.id);
    expect(updated.createdAt).toBe(c.createdAt);
    expect(updated.updatedAt).toBeGreaterThan(1);
    expect(updated.stage).toBe("analyzed");
    expect(failure(() => getCaseOr404("other", db))?.status).toBe(404);
  });

  test("Case Files ordering: the most recently updated case sorts first", async () => {
    const first = mk("first");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = mk("second");
    await new Promise((resolve) => setTimeout(resolve, 5));
    updateCase(first.id, { stage: "analyzed" }, db);
    const ordered = db.select().from(cases).all().sort((x, y) => y.updatedAt - x.updatedAt);
    expect(ordered.map((c) => c.name)).toEqual(["first", "second"]);
    expect(second.updatedAt).toBeLessThan(getCaseOr404(first.id, db).updatedAt);
  });
});
