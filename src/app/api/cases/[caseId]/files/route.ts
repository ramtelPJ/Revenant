import { existsSync } from "node:fs";
import { caseFolder } from "@/lib/cases/files";
import { buildInventory } from "@/lib/cases/inventory";
import { getCaseOr404 } from "@/lib/cases/store";
import { getEnv } from "@/lib/env";
import { guardApi } from "@/lib/http/guard";
import { idParam } from "@/lib/http/params";
import { AppError, handle, ok } from "@/lib/http/respond";
import path from "node:path";

type Ctx = { params: Promise<{ caseId: string }> };

export const GET = handle<Ctx>(async (request, { params }) => {
  guardApi(request);
  const caseId = getCaseOr404(idParam((await params).caseId, "caseId")).id;

  const folder = caseFolder(caseId, "original", path.resolve(getEnv().DATA_DIR));
  if (!existsSync(folder)) throw new AppError("NOT_FOUND", 404, "We couldn't find that.");

  const inventory = buildInventory(folder);
  const { entries, fileCount, truncated, ...project } = inventory;
  // the tree plus the plain facts about the project (dependencies, scripts, entry points, available checks), all
  // read from files, so the explorer panel works before any AI step has run
  return ok({ entries, fileCount, truncated, project });
});
