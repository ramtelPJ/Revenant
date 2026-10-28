import path from "node:path";
import { eq } from "drizzle-orm";
import { buildCandidates, describeCandidates } from "@/lib/ai/candidates";
import { buildContext } from "@/lib/ai/context";
import { verifyEvidence, type EvidenceSources } from "@/lib/ai/evidence";
import { computeLabel } from "@/lib/ai/label";
import { chatJson, type ChatJsonOptions } from "@/lib/ai/ollama";
import { diagnoseMessages } from "@/lib/ai/prompts";
import { diagnosisSchema } from "@/lib/ai/schemas";
import { caseFolder } from "@/lib/cases/files";
import { buildInventory } from "@/lib/cases/inventory";
import { getCaseOr404, updateCase } from "@/lib/cases/store";
import { getDb, type Db } from "@/lib/db/client";
import { errorLogs, findings } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/http/respond";
import type { CheckKind } from "@/lib/sandbox/checks";
import { runCheck, type CheckRunRow, type RunCheckInput } from "@/lib/sandbox/run";
import { explainUnrunnable } from "@/lib/unrunnable";
import { startJob } from "./runner";

export type DiagnoseInput = { captureBaseline: boolean; consent?: unknown };
export type DiagnoseDeps = {
  db?: Db;
  dataDir?: string;
  /** Replaceable in tests; the default runs the real sandbox. */
  run?: (input: RunCheckInput) => Promise<CheckRunRow>;
  /** Replaceable in tests; the default talks to the local Ollama. */
  chat?: typeof chatJson;
  aiOptions?: ChatJsonOptions;
};

// 14,000 characters of overview context fit gemma2's window; the diagnosis adds numbered candidates, so it gets a little less
const DIAGNOSE_CONTEXT_CHARS = 12_000;

export { explainUnrunnable } from "@/lib/unrunnable";

/** `test` if the project has one, otherwise `start`. Never `build`: that is for verification. */
export function pickBaselineCheck(available: { kind: CheckKind }[]): CheckKind | null {
  for (const kind of ["test", "start"] as const) if (available.some((check) => check.kind === kind)) return kind;
  return null;
}

/**
 * Starts the diagnose job. With the user's consent it first runs the project's own check once in the sandbox and records
 * what really happened. A passing check with no error log is reported honestly as "no failure found", without asking a
 * model to find one. Otherwise (a failed check, or a log the user pasted) the model explains the failure, and the app
 * verifies what it cites and decides the label.
 */
export function startDiagnose(caseId: string, input: DiagnoseInput, deps: DiagnoseDeps = {}) {
  // consent comes first: with captureBaseline on, project code will run, so it must be exactly `true`
  if (input.captureBaseline && input.consent !== true) {
    throw new AppError("CONSENT_REQUIRED", 400, "Permission to run project code in the sandbox is required.");
  }
  const db = deps.db ?? getDb();
  const run = deps.run ?? ((checkInput: RunCheckInput) => runCheck(checkInput));
  getCaseOr404(caseId, db);

  return startJob(
    caseId,
    "diagnose",
    async (ctx) => {
      ctx.plan(["Preparing"]); // later steps are added as they start, because which ones run depends on what the check finds
      ctx.step("Preparing");
      const dataDir = deps.dataDir ?? path.resolve(getEnv().DATA_DIR);
      const dir = caseFolder(caseId, "original", dataDir);
      const logs = db.select({ content: errorLogs.content }).from(errorLogs).where(eq(errorLogs.caseId, caseId)).all().map((l) => l.content);

      let baseline: CheckRunRow | null = null;
      let skipNote: string | null = null;
      if (input.captureBaseline) {
        const kind = pickBaselineCheck(buildInventory(dir).availableChecks);
        if (!kind) {
          skipNote = "This project has no test or start script, so there is nothing to run.";
        } else {
          ctx.step("Running the check in the sandbox");
          // consent is passed on exactly as given: runCheck refuses anything but `true`
          baseline = await run({ caseId, kind, phase: "baseline", target: "original", consent: input.consent as boolean, signal: ctx.signal });
          if (baseline.status === "timed_out") skipNote = "The check did not finish within the time limit.";
          else if (baseline.status === "unrunnable") skipNote = explainUnrunnable(baseline.unrunnableReason);
        }
      }

      if (baseline?.status === "passed" && logs.length === 0) {
        // nothing failed and nobody reported a failure: say so, without asking a model to find one
        ctx.step("Recording the result");
        db.insert(findings)
          .values({
            caseId,
            label: "no_failure_found",
            title: "No failure found",
            explanation: `The project's check (${baseline.commandLabel}) passed in the sandbox, so no failure was reproduced. That does not mean the project is free of problems.`,
            evidenceJson: JSON.stringify([{ kind: "check", checkRunId: baseline.id }]),
          })
          .run();
        updateCase(caseId, { stage: "diagnosed" }, db);
        ctx.note("The check passed. No failure was found.");
        return;
      }

      const outputs = baseline?.status === "failed" && baseline.outputExcerpt ? [{ id: baseline.id, text: baseline.outputExcerpt }] : [];
      if (outputs.length === 0 && logs.length === 0) {
        ctx.note(skipNote ?? "There is no failure output or error log to diagnose. Run a check or paste an error log.");
        return;
      }

      ctx.step("Asking the local model");
      const sources: EvidenceSources = { projectDir: dir, logs: logs.map((text) => ({ text })), outputs };
      const candidates = buildCandidates(sources);
      const built = buildContext({ projectDir: dir, checkOutputs: outputs.map((o) => o.text), logs, budget: DIAGNOSE_CONTEXT_CHARS });
      const chat = deps.chat ?? chatJson;
      const { data, model } = await chat(diagnosisSchema, diagnoseMessages(built.text, describeCandidates(candidates), built.nonce), { ...deps.aiOptions, signal: ctx.signal });

      ctx.step("Recording the result");
      // the model only picks candidates by number; each pick is verified again and the label is computed here
      const cited = [...new Set(data.cites)].flatMap((n) => (candidates[n - 1] ? [candidates[n - 1]] : []));
      const { verified, dropped } = verifyEvidence(cited, sources);
      const { label, checkRunId } = computeLabel(verified, baseline, dir);
      db.insert(findings)
        .values({
          caseId,
          label,
          title: data.title,
          explanation: data.explanation,
          category: data.category,
          evidenceJson: JSON.stringify(checkRunId ? [...verified, { kind: "check", checkRunId }] : verified),
          checkRunId,
          model,
        })
        .run();
      updateCase(caseId, { stage: "diagnosed" }, db);
      ctx.note(dropped > 0 ? `Diagnosis saved. ${dropped} citation(s) could not be verified and were left out.` : "Diagnosis saved.");
    },
    db,
  );
}
