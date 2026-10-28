import path from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { caseFolder, readTextFile } from "@/lib/cases/files";
import { getCaseOr404 } from "@/lib/cases/store";
import { getDb } from "@/lib/db/client";
import { patches } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import { guardApi } from "@/lib/http/guard";
import { idParam } from "@/lib/http/params";
import { AppError, handle, ok } from "@/lib/http/respond";

type Ctx = { params: Promise<{ caseId: string }> };

const query = z.object({
  path: z.string().min(1).max(1024),
  version: z.enum(["original", "working"]).default("original"),
});

export const GET = handle<Ctx>(async (request, { params }) => {
  guardApi(request);
  const caseId = getCaseOr404(idParam((await params).caseId, "caseId")).id;
  const { path: filePath, version } = query.parse(Object.fromEntries(new URL(request.url).searchParams));

  // the working copy only exists once a patch has been approved
  if (version === "working") {
    const approved = getDb().select({ id: patches.id }).from(patches).where(and(eq(patches.caseId, caseId), eq(patches.status, "approved"))).get();
    if (!approved) throw new AppError("NOT_FOUND", 404, "We couldn't find that.");
  }

  return ok(readTextFile(caseFolder(caseId, version, path.resolve(getEnv().DATA_DIR)), filePath));
});
