import { deleteCase } from "@/lib/cases/delete";
import { getCaseDetail } from "@/lib/cases/detail";
import { guardApi } from "@/lib/http/guard";
import { idParam } from "@/lib/http/params";
import { handle, ok } from "@/lib/http/respond";

type Ctx = { params: Promise<{ caseId: string }> };

export const GET = handle<Ctx>(async (request, { params }) => {
  guardApi(request);
  return ok(getCaseDetail(idParam((await params).caseId, "caseId")));
});

export const DELETE = handle<Ctx>(async (request, { params }) => {
  guardApi(request);
  const caseId = idParam((await params).caseId, "caseId");
  await deleteCase(caseId);
  return ok({ id: caseId });
});
