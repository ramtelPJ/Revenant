import { z } from "zod";
import { readJson } from "@/lib/http/body";
import { guardApi } from "@/lib/http/guard";
import { idParam } from "@/lib/http/params";
import { handle, ok } from "@/lib/http/respond";
import { startDiagnose } from "@/lib/jobs/diagnose";

type Ctx = { params: Promise<{ caseId: string }> };

// `consent` is passed on untouched: running project code needs it to be exactly `true`, checked in startDiagnose
const body = z.object({ captureBaseline: z.boolean(), consent: z.unknown().optional() });

export const POST = handle<Ctx>(async (request, { params }) => {
  guardApi(request);
  const caseId = idParam((await params).caseId, "caseId");
  const { jobId } = startDiagnose(caseId, await readJson(request, body));
  return ok({ jobId }, 202);
});
