import { guardApi } from "@/lib/http/guard";
import { idParam } from "@/lib/http/params";
import { handle, ok } from "@/lib/http/respond";
import { buildReport } from "@/lib/report";

type Ctx = { params: Promise<{ caseId: string }> };

export const GET = handle<Ctx>(async (request, { params }) => {
  guardApi(request);
  return ok(buildReport(idParam((await params).caseId, "caseId")));
});
