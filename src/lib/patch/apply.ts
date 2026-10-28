import { cp, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { caseFolder } from "@/lib/cases/files";
import { makeWritable, removeTree } from "@/lib/cases/fs";
import { getCaseOr404, getPatchInCase, updateCase } from "@/lib/cases/store";
import { getDb, type Db } from "@/lib/db/client";
import { cases, jobs, patches } from "@/lib/db/schema";
import { AppError } from "@/lib/http/respond";
import { validateEdits, type Edit } from "./validate";

export type PatchDeps = { db?: Db; dataDir?: string };

const wrongState = (message: string) => new AppError("WRONG_STATE", 409, message);

/** A step running on this case may be reading `working/`, so it must not be rebuilt under it. */
function assertNoActiveJob(caseId: string, db: Db) {
  const active = db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.caseId, caseId), inArray(jobs.status, ["queued", "running"]))).get();
  if (active) throw new AppError("JOB_RUNNING", 409, "Another step is still running for this case.");
}

function storedEdits(editsJson: string): Edit[] {
  try {
    const parsed: unknown = JSON.parse(editsJson);
    if (Array.isArray(parsed)) return parsed as Edit[];
  } catch {
    /* falls through */
  }
  throw wrongState("That patch can no longer be applied.");
}

/**
 * Approve: rebuild `working/` from `original/` with the patch's edits, all or nothing. The edits are checked again
 * against the original (the same rules as when they were proposed), the copy is built next to `working/` and moved
 * into place only when complete, and the database changes in one transaction. `original/` is only ever read.
 */
export async function approvePatch(caseId: string, patchId: string, deps: PatchDeps = {}) {
  const db = deps.db ?? getDb();
  getCaseOr404(caseId, db);
  const patch = getPatchInCase(caseId, patchId, db);
  if (patch.status !== "proposed") throw wrongState(`That patch is ${patch.status}, so it can't be approved.`);
  assertNoActiveJob(caseId, db);

  const original = caseFolder(caseId, "original", deps.dataDir);
  const working = caseFolder(caseId, "working", deps.dataDir);
  const staging = path.join(path.dirname(working), `working.tmp-${process.pid}`);

  const checked = validateEdits(original, storedEdits(patch.editsJson));
  if (!checked.ok) throw wrongState(`That patch no longer fits the project: ${checked.errors.join(" ")}`);

  try {
    await removeTree(staging);
    await cp(original, staging, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    await makeWritable(staging); // original/ is read-only and the copy keeps its modes
    for (const change of checked.changes) await writeFile(path.join(staging, change.path), change.after);
    await removeTree(working);
    await rename(staging, working);
  } catch (error) {
    await removeTree(staging);
    throw error;
  }

  try {
    const now = Date.now();
    db.transaction((tx) => {
      // the old approval goes first: the database allows one approved patch per case
      tx.update(patches).set({ status: "superseded", decidedAt: now }).where(and(eq(patches.caseId, caseId), eq(patches.status, "approved"))).run();
      tx.update(patches).set({ status: "approved", decidedAt: now }).where(eq(patches.id, patchId)).run();
      tx.update(cases).set({ stage: "patched", verdict: null, verdictReason: null, verdictAt: null, updatedAt: now }).where(eq(cases.id, caseId)).run();
    });
  } catch (error) {
    await removeTree(working); // no working/ without an approved patch
    throw error;
  }
  return getPatchInCase(caseId, patchId, db);
}

/** Reject: the proposal is closed and the case goes back to the diagnosis. Nothing on disk changes. */
export function rejectPatch(caseId: string, patchId: string, deps: PatchDeps = {}) {
  const db = deps.db ?? getDb();
  getCaseOr404(caseId, db);
  const patch = getPatchInCase(caseId, patchId, db);
  if (patch.status !== "proposed") throw wrongState(`That patch is ${patch.status}, so it can't be rejected.`);
  db.update(patches).set({ status: "rejected", decidedAt: Date.now() }).where(eq(patches.id, patchId)).run();
  updateCase(caseId, { stage: "diagnosed" }, db);
  return getPatchInCase(caseId, patchId, db);
}
