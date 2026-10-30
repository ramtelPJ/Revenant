import { guardApi } from "@/lib/http/guard";
import { idParam } from "@/lib/http/params";
import { handle, ok } from "@/lib/http/respond";
import { skipVerification } from "@/lib/jobs/verify";

type Ctx = { params: Promise<{ caseId: string }> };

export const POST = handle<Ctx>(async (request, { params }) => {
  guardApi(request);
  return ok(skipVerification(idParam((await params).caseId, "caseId")));
});
