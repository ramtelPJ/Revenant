import { z } from "zod";
import { desc } from "drizzle-orm";
import { importArchive, importFolder, importSample, defaultImportContext } from "@/lib/cases/import";
import { getDb } from "@/lib/db/client";
import { cases } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import { guardApi } from "@/lib/http/guard";
import { readJson } from "@/lib/http/body";
import { AppError, handle, ok } from "@/lib/http/respond";

const body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sample"), sampleId: z.string().min(1).max(100) }),
  z.object({ kind: z.literal("folder"), path: z.string().min(1).max(4096) }),
]);

export const GET = handle(async (request) => {
  guardApi(request);
  const rows = getDb()
    .select({ id: cases.id, name: cases.name, stage: cases.stage, verdict: cases.verdict, updatedAt: cases.updatedAt })
    .from(cases)
    .orderBy(desc(cases.updatedAt), desc(cases.createdAt))
    .all();
  return ok(rows);
});

export const POST = handle(async (request) => {
  guardApi(request, { multipart: true }); // JSON for sample/folder, multipart for a zip upload

  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type === "multipart/form-data") {
    const limit = getEnv().MAX_ARCHIVE_MB * 1024 * 1024;
    // refuse an oversized upload before reading it into memory (a little slack for the multipart framing)
    if (Number(request.headers.get("content-length") ?? 0) > limit + 1024 * 1024) {
      throw new AppError("TOO_LARGE", 413, `This archive is larger than the ${getEnv().MAX_ARCHIVE_MB} MB upload limit.`);
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new AppError("VALIDATION_FAILED", 400, "The upload could not be read.", { archive: "Upload a .zip file." });
    }
    const file = form.get("archive");
    if (typeof file !== "object" || file === null || typeof (file as File).arrayBuffer !== "function") {
      throw new AppError("VALIDATION_FAILED", 400, "Choose a .zip file to upload.", { archive: "Required." });
    }
    if ((file as File).size > limit) {
      throw new AppError("TOO_LARGE", 413, `This archive is larger than the ${getEnv().MAX_ARCHIVE_MB} MB upload limit.`);
    }
    const bytes = Buffer.from(await (file as File).arrayBuffer());
    return ok(await importArchive(bytes, (file as File).name || "archive.zip", defaultImportContext()), 201);
  }

  const input = await readJson(request, body);
  return ok(input.kind === "sample" ? await importSample(input.sampleId) : await importFolder(input.path), 201);
});
