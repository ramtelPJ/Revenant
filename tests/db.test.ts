import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, type OpenDatabase } from "@/lib/db/client";
import { analyses, cases, errorLogs, jobs } from "@/lib/db/schema";

let root: string;
let dataDir: string;
let open: OpenDatabase | undefined;

const newCase = (db: OpenDatabase["db"], name = "demo") =>
  db
    .insert(cases)
    .values({ name, sourceKind: "sample", sourceLabel: "broken-esm", sizeBytes: 10, fileCount: 2 })
    .returning()
    .get();

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "revenant-db-"));
  dataDir = path.join(root, "data");
});
afterEach(() => {
  open?.sqlite.close();
  open = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("openDatabase", () => {
  test("creates data dir 0700 and database file 0600, with migrations applied", () => {
    open = openDatabase(dataDir);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dataDir, "revenant.db")).mode & 0o777).toBe(0o600);
    const tables = open.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(["cases", "jobs", "analyses", "error_logs"]));
    expect(open.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(open.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  test("tightens permissions of an existing, too-open data dir", async () => {
    const { mkdirSync, chmodSync } = await import("node:fs");
    mkdirSync(dataDir, { mode: 0o755 });
    chmodSync(dataDir, 0o755);
    open = openDatabase(dataDir);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
  });

  test("marks jobs left active by a previous process as SERVER_RESTARTED", () => {
    open = openDatabase(dataDir);
    const c = newCase(open.db);
    open.db.insert(jobs).values({ caseId: c.id, kind: "analyze", status: "running" }).run();
    open.sqlite.close();

    open = openDatabase(dataDir);
    const job = open.db.select().from(jobs).get()!;
    expect(job.status).toBe("failed");
    expect(job.errorCode).toBe("SERVER_RESTARTED");
    expect(job.finishedAt).not.toBeNull();
  });
});

describe("constraints", () => {
  beforeEach(() => {
    open = openDatabase(dataDir);
  });

  test("deleting a case cascades to jobs, analysis and error logs", () => {
    const { db } = open!;
    const c = newCase(db);
    db.insert(jobs).values({ caseId: c.id, kind: "analyze", status: "succeeded" }).run();
    db.insert(analyses).values({ caseId: c.id, inventoryJson: "{}" }).run();
    db.insert(errorLogs).values({ caseId: c.id, content: "boom" }).run();

    db.delete(cases).where(eq(cases.id, c.id)).run();

    expect(db.select().from(jobs).all()).toHaveLength(0);
    expect(db.select().from(analyses).all()).toHaveLength(0);
    expect(db.select().from(errorLogs).all()).toHaveLength(0);
  });

  test("a second queued/running job for one case is rejected; finished jobs do not block", () => {
    const { db } = open!;
    const c = newCase(db);
    const other = newCase(db, "other");
    db.insert(jobs).values({ caseId: c.id, kind: "analyze", status: "running" }).run();

    expect(() => db.insert(jobs).values({ caseId: c.id, kind: "diagnose" }).run()).toThrow(/UNIQUE/);
    db.insert(jobs).values({ caseId: other.id, kind: "analyze", status: "running" }).run(); // other case ok

    db.update(jobs).set({ status: "succeeded" }).where(eq(jobs.caseId, c.id)).run();
    db.insert(jobs).values({ caseId: c.id, kind: "diagnose" }).run(); // allowed again
    db.insert(jobs).values({ caseId: c.id, kind: "verify", status: "failed" }).run(); // history is unlimited
  });

  test("invalid enum values are rejected by the database", () => {
    const { sqlite } = open!;
    const insert = (stage: string, verdict: string | null) =>
      sqlite
        .prepare(
          `INSERT INTO cases (id, name, source_kind, source_label, stage, size_bytes, file_count, verdict, created_at, updated_at)
           VALUES (?, 'x', 'sample', 's', ?, 1, 1, ?, 1, 1)`,
        )
        .run(crypto.randomUUID(), stage, verdict);
    expect(() => insert("x", null)).toThrow(/CHECK/);
    expect(() => insert("imported", "maybe")).toThrow(/CHECK/);
    expect(() => insert("imported", "resurrected")).not.toThrow();
    expect(() =>
      sqlite
        .prepare(`INSERT INTO jobs (id, case_id, kind, status, created_at) VALUES (?, ?, 'analyze', 'paused', 1)`)
        .run(crypto.randomUUID(), "nope"),
    ).toThrow();
  });

  test("one analysis per case; orphan rows are rejected", () => {
    const { db } = open!;
    const c = newCase(db);
    db.insert(analyses).values({ caseId: c.id, inventoryJson: "{}" }).run();
    expect(() => db.insert(analyses).values({ caseId: c.id, inventoryJson: "{}" }).run()).toThrow(/UNIQUE/);
    expect(() => db.insert(errorLogs).values({ caseId: "missing", content: "x" }).run()).toThrow(/FOREIGN KEY/);
  });

  test("defaults: stage imported, job queued, timestamps set", () => {
    const { db } = open!;
    const c = newCase(db);
    expect(c.stage).toBe("imported");
    expect(c.verdict).toBeNull();
    expect(c.createdAt).toBeGreaterThan(0);
    const j = db.insert(jobs).values({ caseId: c.id, kind: "analyze" }).returning().get();
    expect(j.status).toBe("queued");
  });
});
