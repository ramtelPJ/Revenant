import { z } from "zod";
import { readJson } from "@/lib/http/body";
import { guardApi } from "@/lib/http/guard";
import { idParam } from "@/lib/http/params";
import { handle, ok } from "@/lib/http/respond";
import { startVerify } from "@/lib/jobs/verify";

type Ctx = { params: Promise<{ caseId: string }> };

// `consent` and the check names are passed on untouched: startVerify requires consent to be exactly `true` and checks the names
const body = z.object({ consent: z.unknown().optional(), checks: z.unknown() });

export const POST = handle<Ctx>(async (request, { params }) => {
  guardApi(request);
  const caseId = idParam((await params).caseId, "caseId");
  const { jobId } = startVerify(caseId, await readJson(request, body));
  return ok({ jobId }, 202);
});
