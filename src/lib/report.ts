import { and, desc, eq, sql } from "drizzle-orm";
import { getCaseDetail } from "@/lib/cases/detail";
import { getCaseOr404 } from "@/lib/cases/store";
import { getDb, type Db } from "@/lib/db/client";
import { findings, jobs, patches } from "@/lib/db/schema";
import { AppError } from "@/lib/http/respond";
import { computeVerdict, type VerdictRun } from "@/lib/verdict";

// The report is read from stored rows only: the model's text is quoted as it was saved, and the verdict, reason and
// check results are the ones the verify step stored. Nothing here asks a model anything.

export const REPORT_DISCLAIMER =
  "Passing these checks means only that the listed checks passed in an isolated sandbox. It is not an audit, a security review or a modernization of the project, and anything not listed here was not tested.";

type Detail = ReturnType<typeof getCaseDetail>;
type Run = Detail["checkRuns"][number];

const SKIP_REASON = computeVerdict([], { skipped: true }).reason;
const word = (status: Run["status"]) => (status === "timed_out" ? "timed out" : status === "unrunnable" ? "could not run" : status);

function parseArray(text: string): unknown[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** The newest run of each check kind, in the order the kinds first appear. Runs arrive oldest first. */
function newestPerKind(runs: Run[]): Run[] {
  const byKind = new Map<string, Run>();
  for (const run of runs) byKind.set(run.checkKind, run);
  return [...byKind.values()];
}

/** Everything the report screen shows for a verified case. 404 for an unknown case, 409 until a verdict exists. */
export function buildReport(caseId: string, db: Db = getDb()) {
  const detail = getCaseDetail(caseId, db);
  if (detail.verdict === null || detail.stage !== "verified") {
    throw new AppError("WRONG_STATE", 409, "This case has not been verified yet.");
  }

  // the patch that was verified is the approved one, which is not always the newest proposal
  const patch = db.select().from(patches).where(and(eq(patches.caseId, caseId), eq(patches.status, "approved"))).get() ?? null;
  const finding =
    (patch ? db.select().from(findings).where(and(eq(findings.id, patch.findingId), eq(findings.caseId, caseId))).get() : undefined) ??
    db.select().from(findings).where(eq(findings.caseId, caseId)).orderBy(desc(findings.createdAt), desc(sql`rowid`)).limit(1).get() ??
    null;

  const skipped = detail.verdictReason === SKIP_REASON;
  const latestVerify = db
    .select({ startedAt: jobs.startedAt })
    .from(jobs)
    .where(and(eq(jobs.caseId, caseId), eq(jobs.kind, "verify"), eq(jobs.status, "succeeded")))
    .orderBy(desc(jobs.createdAt), desc(sql`rowid`))
    .limit(1)
    .get();

  // only the runs of the latest verification: the same set the verdict was decided from
  const after = skipped || !patch ? [] : newestPerKind(detail.checkRuns.filter((r) => r.phase === "after" && r.patchId === patch.id && r.startedAt >= (latestVerify?.startedAt ?? 0)));
  const baselineRuns = detail.checkRuns.filter((r) => r.phase === "baseline");
  const wanted = skipped ? [...new Set(baselineRuns.map((r) => r.checkKind))] : after.map((r) => r.checkKind);
  const baseline = wanted.flatMap((kind) => {
    const ofKind = baselineRuns.filter((r) => r.checkKind === kind);
    const usable = ofKind.filter((r) => r.status !== "unrunnable"); // the verify step prefers a baseline that could run
    const pick = (usable.length > 0 ? usable : ofKind).at(-1);
    return pick ? [pick] : [];
  });

  // remaining issues come from the same pure function, but only if it agrees with the stored verdict
  const recomputed = computeVerdict([...baseline, ...after] as (VerdictRun & { id: string })[], { skipped, citedRunId: finding?.checkRunId ?? null });
  const remainingIssues =
    recomputed.verdict === detail.verdict ? recomputed.remainingIssues : after.filter((r) => r.status !== "passed").map((r) => `${r.checkKind}: ${word(r.status)} after the repair`);

  const aiSteps = [
    ...(detail.analysis?.summary ? ["overview"] : []),
    ...(finding?.model ? ["diagnosis"] : []),
    ...(patch ? ["patch"] : []),
  ];

  return {
    caseId: detail.id,
    name: detail.name,
    verdict: detail.verdict,
    verdictReason: detail.verdictReason,
    verdictAt: getCaseOr404(caseId, db).verdictAt,
    finding: finding
      ? {
          id: finding.id,
          label: finding.label,
          title: finding.title,
          explanation: finding.explanation,
          category: finding.category,
          evidence: parseArray(finding.evidenceJson),
          droppedCitations: finding.droppedCitations,
          checkRunId: finding.checkRunId,
          model: finding.model,
        }
      : null,
    patch: patch ? { id: patch.id, attempt: patch.attempt, diffText: patch.diffText, rationale: patch.rationale, filesAffected: parseArray(patch.filesAffectedJson), model: patch.model } : null,
    checkRuns: { baseline, after },
    remainingIssues,
    aiContribution: {
      model: patch?.model ?? finding?.model ?? null,
      aiSteps,
      deterministicSteps: ["inventory", "labels", "checks", "verdict"],
    },
    disclaimer: REPORT_DISCLAIMER,
  };
}
