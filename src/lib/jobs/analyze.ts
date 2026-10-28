import path from "node:path";
import { eq } from "drizzle-orm";
import { buildContext, isSecretLike } from "@/lib/ai/context";
import { chatJson, type ChatJsonOptions } from "@/lib/ai/ollama";
import { overviewMessages } from "@/lib/ai/prompts";
import type { Overview } from "@/lib/ai/schemas";
import { overviewSchema } from "@/lib/ai/schemas";
import { caseFolder, readTextFile } from "@/lib/cases/files";
import { buildInventory } from "@/lib/cases/inventory";
import { getCaseOr404, updateCase } from "@/lib/cases/store";
import { getDb, type Db } from "@/lib/db/client";
import { analyses } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/http/respond";
import { startJob } from "./runner";

export type AnalyzeDeps = {
  db?: Db;
  dataDir?: string;
  /** Replaceable in tests; the default talks to the local Ollama. */
  chat?: typeof chatJson;
  aiOptions?: ChatJsonOptions;
};

// 14,000 characters of context fit gemma2's 8k-token window together with the instructions and the answer
const ANALYZE_CONTEXT_CHARS = 14_000;

/** The model's key files, kept only if they are real, readable, non-secret files of the project. No duplicates. */
export function verifiedKeyFiles(projectDir: string, keyFiles: Overview["key_files"]): Overview["key_files"] {
  const kept: Overview["key_files"] = [];
  const seen = new Set<string>();
  for (const file of keyFiles) {
    const rel = file.path.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/app\//, "");
    if (!rel || seen.has(rel) || isSecretLike(rel) || rel.split("/").includes("node_modules")) continue;
    try {
      readTextFile(projectDir, rel);
    } catch (error) {
      if (error instanceof AppError) continue; // missing, outside the project, binary or too big
      throw error;
    }
    seen.add(rel);
    kept.push({ path: rel, reason: file.reason });
  }
  return kept;
}

/**
 * Starts the analyze job: record what the files say about the project, then ask the local model for an overview.
 * The facts are saved first, so they stay on screen if the model is unavailable. Running it again replaces the
 * previous analysis; a failed re-run leaves the facts and clears the old summary.
 */
export function startAnalyze(caseId: string, deps: AnalyzeDeps = {}) {
  const db = deps.db ?? getDb();
  getCaseOr404(caseId, db);

  return startJob(
    caseId,
    "analyze",
    async (ctx) => {
      ctx.plan(["Reading the project", "Asking the local model", "Saving the overview"]);
      ctx.step("Reading the project");
      const dir = caseFolder(caseId, "original", deps.dataDir ?? path.resolve(getEnv().DATA_DIR));
      const { entries, fileCount, truncated, ...project } = buildInventory(dir);
      void entries, fileCount, truncated;
      const inventoryJson = JSON.stringify(project);
      db.insert(analyses)
        .values({ caseId, inventoryJson, summaryJson: null, model: null })
        .onConflictDoUpdate({ target: analyses.caseId, set: { inventoryJson, summaryJson: null, model: null, createdAt: Date.now() } })
        .run();
      const built = buildContext({ projectDir: dir, budget: ANALYZE_CONTEXT_CHARS });

      ctx.step("Asking the local model");
      const chat = deps.chat ?? chatJson;
      const { data, model } = await chat(overviewSchema, overviewMessages(built.text, built.nonce), { ...deps.aiOptions, signal: ctx.signal });

      ctx.step("Saving the overview");
      const summary = { ...data, key_files: verifiedKeyFiles(dir, data.key_files) };
      db.update(analyses).set({ summaryJson: JSON.stringify(summary), model }).where(eq(analyses.caseId, caseId)).run();
      if (getCaseOr404(caseId, db).stage === "imported") updateCase(caseId, { stage: "analyzed" }, db);
    },
    db,
  );
}
