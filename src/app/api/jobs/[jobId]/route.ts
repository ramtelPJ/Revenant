import { guardApi } from "@/lib/http/guard";
import { idParam } from "@/lib/http/params";
import { handle, ok } from "@/lib/http/respond";
import { getJobStatus } from "@/lib/jobs/runner";

type Ctx = { params: Promise<{ jobId: string }> };

export const GET = handle<Ctx>(async (request, { params }) => {
  guardApi(request);
  return ok(getJobStatus(idParam((await params).jobId, "jobId")));
});
