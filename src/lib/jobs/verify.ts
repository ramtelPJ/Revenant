import path from "node:path";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { caseFolder } from "@/lib/cases/files";
import { buildInventory } from "@/lib/cases/inventory";
import { getCaseOr404, updateCase } from "@/lib/cases/store";
import { getDb, type Db } from "@/lib/db/client";
import { checkRuns, findings, jobs, patches } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/http/respond";
import { CHECKS, isCheckKind, type CheckKind } from "@/lib/sandbox/checks";
import { runCheck, type CheckRunRow, type RunCheckInput } from "@/lib/sandbox/run";
import { computeVerdict, type VerdictRun } from "@/lib/verdict";
import { startJob } from "./runner";

export type VerifyInput = { consent?: unknown; checks: unknown };
export type VerifyDeps = {
  db?: Db;
  dataDir?: string;
  /** Replaceable in tests; the default runs the real sandbox. */
  run?: (input: RunCheckInput) => Promise<CheckRunRow>;
};

const MAX_CHECKS = 3;

function approvedPatch(caseId: string, db: Db) {
  const patch = db.select().from(patches).where(and(eq(patches.caseId, caseId), eq(patches.status, "approved"))).get();
  if (!patch) throw new AppError("WRONG_STATE", 409, "Approve a patch before verifying it.");
  return patch;
}

/** 1 to 3 distinct allowlisted check kinds, in the order given. */
function parseChecks(value: unknown): CheckKind[] {
  const bad = (message: string) => new AppError("VALIDATION_FAILED", 400, message, { checks: message });
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHECKS) throw bad(`Choose between 1 and ${MAX_CHECKS} checks.`);
  const kinds = value.filter(isCheckKind);
  if (kinds.length !== value.length) throw bad("That check is not allowed.");
  if (new Set(kinds).size !== kinds.length) throw bad("Each check can be chosen once.");
  return kinds;
}

/**
 * Starts the verify job for the approved patch. For each chosen check: use the case's existing baseline run for that
 * kind (or run one on `original`), then run the same check on the repaired copy. The verdict comes only from those runs
 * (lib/verdict.ts) and is stored on the case. Consent must be exactly `true` on THIS request; it is never read from
 * anything stored, and a run is never started without it.
 */
export function startVerify(caseId: string, input: VerifyInput, deps: VerifyDeps = {}) {
  if (input.consent !== true) {
    throw new AppError("CONSENT_REQUIRED", 400, "Permission to run project code in the sandbox is required.");
  }
  const db = deps.db ?? getDb();
  const run = deps.run ?? ((checkInput: RunCheckInput) => runCheck(checkInput));
  getCaseOr404(caseId, db);
  const kinds = parseChecks(input.checks);
  const patch = approvedPatch(caseId, db);
  const dataDir = deps.dataDir ?? path.resolve(getEnv().DATA_DIR);
  const available = buildInventory(caseFolder(caseId, "original", dataDir)).availableChecks.map((c) => c.kind);
  const missing = kinds.filter((k) => !available.includes(k));
  if (missing.length > 0) throw new AppError("VALIDATION_FAILED", 400, `This project has no ${missing.map((k) => CHECKS[k].label).join(" or ")} to run.`, { checks: "Choose a check the project has." });

  return startJob(
    caseId,
    "verify",
    async (ctx) => {
      const baselineLabel = (k: CheckKind) => `Original: ${CHECKS[k].label}`;
      const afterLabel = (k: CheckKind) => `Repaired copy: ${CHECKS[k].label}`;
      ctx.plan(kinds.flatMap((k) => [baselineLabel(k), afterLabel(k)]));

      const baselines: CheckRunRow[] = [];
      const afters: CheckRunRow[] = [];
      for (const kind of kinds) {
        ctx.step(baselineLabel(kind));
        // an earlier baseline of the same case is reused unless it could not run (that is worth another try)
        const earlier = db
          .select()
          .from(checkRuns)
          .where(and(eq(checkRuns.caseId, caseId), eq(checkRuns.phase, "baseline"), eq(checkRuns.checkKind, kind), ne(checkRuns.status, "unrunnable")))
          .orderBy(desc(checkRuns.startedAt), desc(sql`rowid`))
          .limit(1)
          .get();
        baselines.push(earlier ?? (await run({ caseId, kind, phase: "baseline", target: "original", consent: true, signal: ctx.signal })));
        if (ctx.signal.aborted) return;

        ctx.step(afterLabel(kind));
        afters.push(await run({ caseId, kind, phase: "after", target: "working", patchId: patch.id, consent: true, signal: ctx.signal }));
        if (ctx.signal.aborted) return; // a cancelled verification leaves the case's verdict as it was
      }

      ctx.step("Deciding the verdict");
      const latestFinding = db.select({ checkRunId: findings.checkRunId }).from(findings).where(eq(findings.caseId, caseId)).orderBy(desc(findings.createdAt), desc(sql`rowid`)).limit(1).get();
      const result = computeVerdict([...baselines, ...afters] as (VerdictRun & { id: string })[], { citedRunId: latestFinding?.checkRunId ?? null });
      updateCase(caseId, { stage: "verified", verdict: result.verdict, verdictReason: result.reason, verdictAt: Date.now() }, db);
      ctx.note(result.reason);
    },
    db,
  );
}

/** Skip Verification: the case ends `unverified`, with nothing run. Needs an approved patch, like verifying does. */
export function skipVerification(caseId: string, deps: { db?: Db } = {}) {
  const db = deps.db ?? getDb();
  getCaseOr404(caseId, db);
  approvedPatch(caseId, db);
  if (db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.caseId, caseId), sql`status IN ('queued','running')`)).get()) {
    throw new AppError("JOB_RUNNING", 409, "Another step is still running for this case.");
  }
  const result = computeVerdict([], { skipped: true });
  updateCase(caseId, { stage: "verified", verdict: result.verdict, verdictReason: result.reason, verdictAt: Date.now() }, db);
  return { verdict: result.verdict };
}
