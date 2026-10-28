import { guardApi } from "@/lib/http/guard";
import { idParam } from "@/lib/http/params";
import { handle, ok } from "@/lib/http/respond";
import { cancelJob } from "@/lib/jobs/runner";

type Ctx = { params: Promise<{ jobId: string }> };

export const POST = handle<Ctx>(async (request, { params }) => {
  guardApi(request);
  const job = cancelJob(idParam((await params).jobId, "jobId"));
  return ok({ id: job.id, status: job.status });
});
