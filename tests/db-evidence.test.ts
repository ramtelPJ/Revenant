import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, type OpenDatabase } from "@/lib/db/client";
import { cases, checkRuns, findings, patches } from "@/lib/db/schema";

let root: string;
let open: OpenDatabase;

const newCase = () =>
  open.db
    .insert(cases)
    .values({ name: "demo", sourceKind: "sample", sourceLabel: "broken-esm", sizeBytes: 1, fileCount: 1 })
    .returning()
    .get();

const newFinding = (caseId: string) =>
  open.db
    .insert(findings)
    .values({ caseId, label: "hypothesis", title: "t", explanation: "e", evidenceJson: "[]" })
    .returning()
    .get();

const newPatch = (caseId: string, findingId: string, status: "proposed" | "approved" | "rejected" | "superseded" = "proposed") =>
  open.db
    .insert(patches)
    .values({
      caseId,
      findingId,
      attempt: 1,
      rationale: "r",
      editsJson: "[]",
      diffText: "",
      filesAffectedJson: "[]",
      status,
      model: "gemma2:2b",
    })
    .returning()
    .get();

const run = (caseId: string, phase: "baseline" | "after", patchId?: string) =>
  open.db
    .insert(checkRuns)
    .values({
      caseId,
      patchId,
      phase,
      checkKind: "test",
      commandLabel: "npm test",
      target: phase === "baseline" ? "original" : "working",
      status: "failed",
      limitsJson: "{}",
      consentedAt: Date.now(),
    })
    .returning()
    .get();

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "revenant-ev-"));
  open = openDatabase(path.join(root, "data"));
});
afterEach(() => {
  open.sqlite.close();
  rmSync(root, { recursive: true, force: true });
});

describe("check_runs", () => {
  test("a row without consented_at cannot be inserted", () => {
    const c = newCase();
    expect(() =>
      open.sqlite
        .prepare(
          `INSERT INTO check_runs (id, case_id, phase, check_kind, command_label, target, status, limits_json, started_at)
           VALUES (?, ?, 'baseline', 'test', 'npm test', 'original', 'failed', '{}', 1)`,
        )
        .run(randomUUID(), c.id),
    ).toThrow(/NOT NULL/);
  });

  test("an after run needs a patch; a baseline run must not have one", () => {
    const c = newCase();
    const p = newPatch(c.id, newFinding(c.id).id);

    expect(() => run(c.id, "after")).toThrow(/CHECK/);
    expect(() => run(c.id, "baseline", p.id)).toThrow(/CHECK/);
    expect(run(c.id, "baseline").patchId).toBeNull();
    expect(run(c.id, "after", p.id).patchId).toBe(p.id);
  });

  test("invalid phase, kind, target and status values are rejected", () => {
    const c = newCase();
    const bad = (column: string, value: string) =>
      open.sqlite
        .prepare(
          `INSERT INTO check_runs (id, case_id, phase, check_kind, command_label, target, status, limits_json, consented_at, started_at)
           VALUES (?, ?, 'baseline', 'test', 'npm test', 'original', 'failed', '{}', 1, 1)`.replace(
            new RegExp(`'${{ phase: "baseline", check_kind: "test", target: "original", status: "failed" }[column]}'`),
            `'${value}'`,
          ),
        )
        .run(randomUUID(), c.id);
    expect(() => bad("phase", "during")).toThrow(/CHECK/);
    expect(() => bad("check_kind", "lint")).toThrow(/CHECK/);
    expect(() => bad("target", "elsewhere")).toThrow(/CHECK/);
    expect(() => bad("status", "ok")).toThrow(/CHECK/);
  });
});

describe("patches", () => {
  test("only one approved patch per case; other cases and history are unaffected", () => {
    const a = newCase();
    const b = newCase();
    const fa = newFinding(a.id);
    const fb = newFinding(b.id);

    const first = newPatch(a.id, fa.id, "approved");
    expect(() => newPatch(a.id, fa.id, "approved")).toThrow(/UNIQUE/);
    newPatch(b.id, fb.id, "approved"); // different case is fine
    newPatch(a.id, fa.id, "superseded");
    newPatch(a.id, fa.id, "rejected");

    open.db.update(patches).set({ status: "superseded" }).where(eq(patches.id, first.id)).run();
    expect(newPatch(a.id, fa.id, "approved").status).toBe("approved");
  });

  test("invalid status is rejected", () => {
    const c = newCase();
    const f = newFinding(c.id);
    expect(() =>
      open.sqlite
        .prepare(
          `INSERT INTO patches (id, case_id, finding_id, attempt, rationale, edits_json, diff_text, files_affected_json, status, model, created_at)
           VALUES (?, ?, ?, 1, 'r', '[]', '', '[]', 'maybe', 'm', 1)`,
        )
        .run(randomUUID(), c.id, f.id),
    ).toThrow(/CHECK/);
  });
});

describe("findings", () => {
  test("invalid label and category are rejected; category may be null", () => {
    const c = newCase();
    const insert = (label: string, category: string | null) =>
      open.sqlite
        .prepare(
          `INSERT INTO findings (id, case_id, label, title, explanation, category, evidence_json, created_at)
           VALUES (?, ?, ?, 't', 'e', ?, '[]', 1)`,
        )
        .run(randomUUID(), c.id, label, category);
    expect(() => insert("certain", null)).toThrow(/CHECK/);
    expect(() => insert("hypothesis", "magic")).toThrow(/CHECK/);
    expect(() => insert("no_failure_found", null)).not.toThrow();
    expect(() => insert("confirmed_by_check", "module_format")).not.toThrow();
  });

  test("deleting the confirming check run keeps the finding and nulls the link", () => {
    const c = newCase();
    const r = run(c.id, "baseline");
    const f = open.db
      .insert(findings)
      .values({ caseId: c.id, label: "confirmed_by_check", title: "t", explanation: "e", evidenceJson: "[]", checkRunId: r.id })
      .returning()
      .get();

    open.db.delete(checkRuns).where(eq(checkRuns.id, r.id)).run();
    const after = open.db.select().from(findings).where(eq(findings.id, f.id)).get();
    expect(after).toBeDefined();
    expect(after!.checkRunId).toBeNull();
  });
});

describe("cascades", () => {
  test("deleting a case removes check runs, findings and patches, even with the reference cycle", () => {
    const c = newCase();
    const baseline = run(c.id, "baseline");
    const f = open.db
      .insert(findings)
      .values({ caseId: c.id, label: "confirmed_by_check", title: "t", explanation: "e", evidenceJson: "[]", checkRunId: baseline.id })
      .returning()
      .get();
    const p = newPatch(c.id, f.id, "approved");
    run(c.id, "after", p.id);

    open.db.delete(cases).where(eq(cases.id, c.id)).run();

    expect(open.db.select().from(checkRuns).all()).toHaveLength(0);
    expect(open.db.select().from(findings).all()).toHaveLength(0);
    expect(open.db.select().from(patches).all()).toHaveLength(0);
  });

  test("deleting a patch removes its after runs but not baseline runs", () => {
    const c = newCase();
    const p = newPatch(c.id, newFinding(c.id).id);
    run(c.id, "baseline");
    run(c.id, "after", p.id);

    open.db.delete(patches).where(eq(patches.id, p.id)).run();
    const left = open.db.select().from(checkRuns).all();
    expect(left).toHaveLength(1);
    expect(left[0].phase).toBe("baseline");
  });
});
