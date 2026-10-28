import { guardApi } from "@/lib/http/guard";
import { idParam } from "@/lib/http/params";
import { handle, ok } from "@/lib/http/respond";
import { startAnalyze } from "@/lib/jobs/analyze";

type Ctx = { params: Promise<{ caseId: string }> };

export const POST = handle<Ctx>(async (request, { params }) => {
  guardApi(request);
  const { jobId } = startAnalyze(idParam((await params).caseId, "caseId"));
  return ok({ jobId }, 202);
});
