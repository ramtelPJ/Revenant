import { and, eq } from "drizzle-orm";
import { getDb, type Db } from "@/lib/db/client";
import { cases, jobs, patches } from "@/lib/db/schema";
import { AppError } from "@/lib/http/respond";

// One message for "missing" and "belongs to another case", so neither can be told apart.
const notFound = () => new AppError("NOT_FOUND", 404, "We couldn't find that.");

export type NewCase = typeof cases.$inferInsert;
export type CaseChanges = Partial<Omit<typeof cases.$inferInsert, "id" | "createdAt" | "updatedAt">>;

export function getCaseOr404(caseId: string, db: Db = getDb()) {
  const row = db.select().from(cases).where(eq(cases.id, caseId)).get();
  if (!row) throw notFound();
  return row;
}

export function getJobOr404(jobId: string, db: Db = getDb()) {
  const row = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!row) throw notFound();
  return row;
}

/** Filters by BOTH ids: a patch id from another case is a 404, never a 403. */
export function getPatchInCase(caseId: string, patchId: string, db: Db = getDb()) {
  const row = db
    .select()
    .from(patches)
    .where(and(eq(patches.id, patchId), eq(patches.caseId, caseId)))
    .get();
  if (!row) throw notFound();
  return row;
}

export function createCase(values: NewCase, db: Db = getDb()) {
  return db.insert(cases).values(values).returning().get();
}

/** Every case write goes through here so `updated_at` (the Case Files ordering) is always bumped. */
export function updateCase(caseId: string, changes: CaseChanges, db: Db = getDb()) {
  // The types already exclude these, but callers can hold data from JSON; never let it rewrite them.
  const safe: Record<string, unknown> = { ...changes };
  for (const key of ["id", "createdAt", "updatedAt"]) delete safe[key];

  const row = db
    .update(cases)
    .set({ ...safe, updatedAt: Date.now() })
    .where(eq(cases.id, caseId))
    .returning()
    .get();
  if (!row) throw notFound();
  return row;
}
