import { desc, eq, sql } from "drizzle-orm";
import { getCaseOr404 } from "@/lib/cases/store";
import { getDb } from "@/lib/db/client";
import { patches } from "@/lib/db/schema";
import { guardApi } from "@/lib/http/guard";
import { idParam } from "@/lib/http/params";
import { handle, ok } from "@/lib/http/respond";
import { startProposePatch } from "@/lib/jobs/propose-patch";

type Ctx = { params: Promise<{ caseId: string }> };

const list = (value: string) => {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const POST = handle<Ctx>(async (request, { params }) => {
  guardApi(request);
  const { jobId } = startProposePatch(idParam((await params).caseId, "caseId"));
  return ok({ jobId }, 202);
});

/** Every proposal for the case, newest first. The raw edits stay on the server; the diff is what people review. */
export const GET = handle<Ctx>(async (request, { params }) => {
  guardApi(request);
  const caseId = getCaseOr404(idParam((await params).caseId, "caseId")).id;
  const rows = getDb().select().from(patches).where(eq(patches.caseId, caseId)).orderBy(desc(patches.createdAt), desc(sql`rowid`)).all();
  return ok(
    rows.map((p) => ({
      id: p.id,
      findingId: p.findingId,
      attempt: p.attempt,
      rationale: p.rationale,
      diffText: p.diffText,
      filesAffected: list(p.filesAffectedJson),
      status: p.status,
      model: p.model,
      createdAt: p.createdAt,
      decidedAt: p.decidedAt,
    })),
  );
});
