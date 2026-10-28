import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getCaseOr404 } from "@/lib/cases/store";
import { getDb, type Db } from "@/lib/db/client";
import { analyses, checkRuns, findings, jobs, patches } from "@/lib/db/schema";

export type JobStep = { label: string; state: "pending" | "running" | "done" | "failed" };

// Stored JSON is ours, but a damaged row must show as "nothing" and not break the page.
function parse<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A job row as the browser sees it. */
export function formatJob(row: typeof jobs.$inferSelect) {
  return {
    id: row.id,
    caseId: row.caseId,
    kind: row.kind,
    status: row.status,
    progressNote: row.progressNote,
    steps: asArray(parse(row.stepsJson, [])) as JobStep[],
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

// rowid breaks ties between rows written in the same millisecond: the later insert is the newer one
const newest = <T extends { createdAt: unknown }>(table: T) => [desc(table.createdAt as never), desc(sql`rowid`)];

/** Everything the case page needs in one read, every row scoped to this case. Raw patch edits are not included. */
export function getCaseDetail(caseId: string, db: Db = getDb()) {
  const c = getCaseOr404(caseId, db);

  const analysis = db.select().from(analyses).where(eq(analyses.caseId, caseId)).get();
  const finding = db.select().from(findings).where(eq(findings.caseId, caseId)).orderBy(...newest(findings)).limit(1).get();
  const patch = db.select().from(patches).where(eq(patches.caseId, caseId)).orderBy(...newest(patches)).limit(1).get();
  const active = db
    .select()
    .from(jobs)
    .where(and(eq(jobs.caseId, caseId), inArray(jobs.status, ["queued", "running"])))
    .limit(1)
    .get();
  const runs = db.select().from(checkRuns).where(eq(checkRuns.caseId, caseId)).orderBy(asc(checkRuns.startedAt), asc(sql`rowid`)).all();

  return {
    id: c.id,
    name: c.name,
    sourceKind: c.sourceKind,
    sourceLabel: c.sourceLabel,
    stage: c.stage,
    sizeBytes: c.sizeBytes,
    fileCount: c.fileCount,
    verdict: c.verdict,
    verdictReason: c.verdictReason,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    analysis: analysis ? {
      inventory: parse<unknown>(analysis.inventoryJson, null),
      summary: parse<unknown>(analysis.summaryJson, null),
      model: analysis.model,
      createdAt: analysis.createdAt,
    } : null,
    latestFinding: finding ? {
      id: finding.id,
      label: finding.label,
      title: finding.title,
      explanation: finding.explanation,
      category: finding.category,
      evidence: asArray(parse(finding.evidenceJson, [])),
      droppedCitations: finding.droppedCitations,
      checkRunId: finding.checkRunId,
      model: finding.model,
      createdAt: finding.createdAt,
    } : null,
    latestPatch: patch ? {
      id: patch.id,
      findingId: patch.findingId,
      attempt: patch.attempt,
      rationale: patch.rationale,
      diffText: patch.diffText,
      filesAffected: asArray(parse(patch.filesAffectedJson, [])),
      status: patch.status,
      model: patch.model,
      createdAt: patch.createdAt,
      decidedAt: patch.decidedAt,
    } : null,
    activeJob: active ? formatJob(active) : null,
    checkRuns: runs.map((r) => ({
      id: r.id,
      patchId: r.patchId,
      phase: r.phase,
      checkKind: r.checkKind,
      commandLabel: r.commandLabel,
      target: r.target,
      status: r.status,
      exitCode: r.exitCode,
      outputExcerpt: r.outputExcerpt,
      unrunnableReason: r.unrunnableReason,
      durationMs: r.durationMs,
      limits: parse<unknown>(r.limitsJson, null),
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    })),
  };
}
