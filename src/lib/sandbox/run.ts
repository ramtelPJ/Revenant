import { randomUUID } from "node:crypto";
import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { caseFolder } from "@/lib/cases/files";
import { makeWritable, removeTree } from "@/lib/cases/fs";
import { asStringMap, checksFromScripts, readManifest } from "@/lib/cases/inventory";
import { getCaseOr404, getPatchInCase } from "@/lib/cases/store";
import { getDb, type Db } from "@/lib/db/client";
import { checkRuns } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/http/respond";
import { CHECKS, START_SURVIVAL_MS, evaluateCheck, isCheckKind, timeoutSecFor, type CheckKind } from "./checks";
import { buildDockerArgs, containerName, runDocker, type DockerResult, type RunDockerOptions } from "./docker";

export type CheckRunRow = typeof checkRuns.$inferSelect;

export type RunCheckInput = {
  caseId: string;
  kind: CheckKind;
  phase: "baseline" | "after";
  target: "original" | "working";
  patchId?: string;
  /** Must be exactly `true`: the explicit permission to run this project's code. Never defaulted. */
  consent: boolean;
  signal?: AbortSignal;
};

export type RunContext = {
  db: Db;
  dataDir: string;
  limits: { image: string; memoryMb: number; cpus: number; timeoutSec: number };
  docker: (args: string[], options: RunDockerOptions) => Promise<DockerResult>;
};

export function defaultRunContext(): RunContext {
  const env = getEnv();
  return {
    db: getDb(),
    dataDir: path.resolve(env.DATA_DIR),
    limits: { image: env.SANDBOX_IMAGE, memoryMb: env.SANDBOX_MEMORY_MB, cpus: env.SANDBOX_CPUS, timeoutSec: env.CHECK_TIMEOUT_SEC },
    docker: runDocker,
  };
}

const invalid = (message: string) => new AppError("VALIDATION_FAILED", 400, message);

/**
 * Runs one allowlisted check on a case folder inside Docker and records the result.
 *
 * The row is written (with the user's consent time) BEFORE anything is spawned, and with the status
 * `unrunnable / in_progress`, which is never evidence of a pass or a failure. If the process dies
 * mid-run, that is what stays behind. Once the run ends the row is updated in place.
 * Problems with the environment (no Docker, no script, no dependencies) are recorded as
 * `unrunnable`, not thrown: only misuse of this function throws.
 */
export async function runCheck(input: RunCheckInput, ctx: RunContext = defaultRunContext()): Promise<CheckRunRow> {
  // 1. consent comes first: nothing is read, written, or spawned without it
  if (input.consent !== true) {
    throw new AppError("CONSENT_REQUIRED", 400, "Permission to run project code in the sandbox is required.");
  }
  const { caseId, kind, phase, target, patchId } = input;

  // 2. misuse
  if (!isCheckKind(kind)) throw invalid("That check is not allowed.");
  if (phase !== "baseline" && phase !== "after") throw invalid("Unknown phase.");
  if (phase === "baseline" && (target !== "original" || patchId !== undefined)) throw invalid("A baseline check runs on the original, without a patch.");
  if (phase === "after" && (target !== "working" || patchId === undefined)) throw invalid("An after check runs on the working copy of a patch.");

  getCaseOr404(caseId, ctx.db);
  if (patchId !== undefined) {
    const patch = getPatchInCase(caseId, patchId, ctx.db); // a patch from another case is a 404
    if (patch.status !== "approved") throw new AppError("WRONG_STATE", 409, "That patch has not been approved.");
  }

  const folder = caseFolder(caseId, target, ctx.dataDir);
  try {
    if (!(await stat(folder)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new AppError("NOT_FOUND", 404, "We couldn't find that.");
  }

  const runId = randomUUID();
  const now = Date.now();
  const timeoutSec = timeoutSecFor(kind, ctx.limits.timeoutSec);
  const limits = { memoryMb: ctx.limits.memoryMb, cpus: ctx.limits.cpus, pids: 256, timeoutSec, network: "none" };

  const finish = (changes: Partial<typeof checkRuns.$inferInsert>) => {
    ctx.db
      .update(checkRuns)
      .set({ finishedAt: Date.now(), ...changes })
      .where(eq(checkRuns.id, runId))
      .run();
    return ctx.db.select().from(checkRuns).where(eq(checkRuns.id, runId)).get()!;
  };

  // 3. the row exists, with consent recorded, before anything runs
  ctx.db
    .insert(checkRuns)
    .values({
      id: runId,
      caseId,
      patchId: patchId ?? null,
      phase,
      checkKind: kind,
      commandLabel: CHECKS[kind].label,
      target,
      status: "unrunnable",
      unrunnableReason: "in_progress",
      limitsJson: JSON.stringify(limits),
      consentedAt: now,
      startedAt: now,
    })
    .run();

  const runDir = path.join(ctx.dataDir, "runs", runId);
  try {
    // 4. can this project be checked here at all?
    const manifest = readManifest(folder);
    const scripts = asStringMap(manifest.scripts);
    if (!checksFromScripts(scripts).some((check) => check.kind === kind)) {
      return finish({ unrunnableReason: "script_missing" });
    }
    const hasDependencies = Object.keys(asStringMap(manifest.dependencies)).length + Object.keys(asStringMap(manifest.devDependencies)).length > 0;
    if (hasDependencies && !(await exists(path.join(folder, "node_modules")))) {
      return finish({ unrunnableReason: "no_node_modules" }); // checks run offline, so dependencies must already be installed
    }

    // 5. run on a throwaway copy, so nothing the project does can touch the case folders
    try {
      await mkdir(path.dirname(runDir), { recursive: true, mode: 0o700 });
      await cp(folder, runDir, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
      await makeWritable(runDir);
    } catch {
      return finish({ unrunnableReason: "copy_failed" });
    }

    const result = await ctx.docker(
      buildDockerArgs({ runId, folder: runDir, kind, image: ctx.limits.image, memoryMb: ctx.limits.memoryMb, cpus: ctx.limits.cpus }),
      {
        name: containerName(runId),
        timeoutMs: timeoutSec * 1000,
        survivalMs: kind === "start" ? START_SURVIVAL_MS : undefined,
        signal: input.signal,
      },
    );

    if (result.kind === "unavailable") return finish({ unrunnableReason: result.reason });
    if (result.aborted) {
      return finish({ unrunnableReason: "cancelled", exitCode: result.exitCode, outputExcerpt: result.output, durationMs: result.durationMs });
    }
    return finish({
      status: evaluateCheck(kind, result),
      unrunnableReason: null,
      exitCode: result.exitCode,
      outputExcerpt: result.output,
      durationMs: result.durationMs,
    });
  } catch (error) {
    console.error(`[sandbox] run ${runId} failed: ${error instanceof Error ? error.name : typeof error}`); // never the message
    return finish({ unrunnableReason: "internal_error" });
  } finally {
    await removeTree(runDir).catch(() => {});
  }
}

async function exists(p: string) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
