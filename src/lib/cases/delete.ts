import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, type Db } from "@/lib/db/client";
import { cases, jobs } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/http/respond";
import { removeTree } from "./fs";
import { getCaseOr404 } from "./store";

/** Removes the case row (its jobs, findings, patches and runs cascade) and then its folder on disk. */
export async function deleteCase(caseId: string, db: Db = getDb(), dataDir = path.resolve(getEnv().DATA_DIR)) {
  getCaseOr404(caseId, db);
  const active = db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.caseId, caseId), inArray(jobs.status, ["queued", "running"]))).get();
  if (active) throw new AppError("JOB_RUNNING", 409, "A step is still running for this case. Wait for it to finish, then delete.");
  db.delete(cases).where(eq(cases.id, caseId)).run();
  await removeTree(path.join(dataDir, "cases", caseId));
}
