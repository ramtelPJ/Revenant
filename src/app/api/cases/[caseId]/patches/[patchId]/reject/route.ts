import { guardApi } from "@/lib/http/guard";
import { idParam } from "@/lib/http/params";
import { handle, ok } from "@/lib/http/respond";
import { rejectPatch } from "@/lib/patch/apply";

type Ctx = { params: Promise<{ caseId: string; patchId: string }> };

export const POST = handle<Ctx>(async (request, { params }) => {
  guardApi(request);
  const p = await params;
  const patch = rejectPatch(idParam(p.caseId, "caseId"), idParam(p.patchId, "patchId"));
  return ok({ id: patch.id, status: patch.status });
});
