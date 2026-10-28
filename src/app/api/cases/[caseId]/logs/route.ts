import { z } from "zod";
import { getCaseOr404 } from "@/lib/cases/store";
import { getDb } from "@/lib/db/client";
import { errorLogs } from "@/lib/db/schema";
import { readJson } from "@/lib/http/body";
import { guardApi } from "@/lib/http/guard";
import { idParam } from "@/lib/http/params";
import { handle, ok } from "@/lib/http/respond";

type Ctx = { params: Promise<{ caseId: string }> };

const MAX_LOG_CHARS = 100_000;
const body = z.object({ content: z.string().trim().min(1, "Paste the error log.").max(MAX_LOG_CHARS, `The log can be at most ${MAX_LOG_CHARS.toLocaleString("en-US")} characters.`) });

// The log is project text: stored and shown as text, never written to the server log. A little headroom over the
// field limit lets an over-long log reach the validation above (400) instead of the size guard (413).
export const POST = handle<Ctx>(async (request, { params }) => {
  guardApi(request);
  const caseId = getCaseOr404(idParam((await params).caseId, "caseId")).id;
  const { content } = await readJson(request, body, MAX_LOG_CHARS + 1_000);
  const { id } = getDb().insert(errorLogs).values({ caseId, content }).returning({ id: errorLogs.id }).get();
  return ok({ id }, 201);
});
