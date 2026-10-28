"use client";
import { useState } from "react";
import { ApiError, apiFetch } from "@/lib/api-client";
import type { CaseDetail } from "@/lib/case-ui";
import { START_OLLAMA_FIX, pullModelFix } from "@/lib/fixes";
import { healthProblems, type Health } from "@/lib/health-problems";
import { InlineText } from "../inline-text";
import { JobPanel } from "../job-progress";

const H = "font-mono text-[11px] uppercase tracking-[0.12em] text-accent";

/** The restore steps for the local AI, from what /api/health says is actually missing. */
function RestoreSteps({ health }: { health: Health | null }) {
  const fixes = health ? healthProblems(health).filter((p) => p.id === "ollama" || p.id === "model").map((p) => p.fix) : [];
  const steps = fixes.length > 0 ? fixes : [START_OLLAMA_FIX, ...(health ? [pullModelFix(health.ollama.model)] : [])];
  return (
    <div role="alert" className="flex flex-col gap-2 border border-warn/45 px-3 py-3 text-sm">
      <p className="m-0 font-medium text-warn">The local AI isn&apos;t available. Start Ollama and pull the model.</p>
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5 leading-normal">
        {steps.map((step) => (
          <li key={step}><InlineText text={step} /></li>
        ))}
      </ul>
      <p className="m-0 text-muted">Everything read from the project&apos;s files stays available meanwhile.</p>
    </div>
  );
}

/**
 * The model's overview of the project, and the button that asks for it. All model text is shown as text.
 * Each key file opens in the file viewer. Without the local AI it shows how to bring it back, and nothing else.
 */
export function OverviewPanel({ detail, health, onOpenFile, onChanged }: { detail: CaseDetail; health: Health | null; onOpenFile: (path: string) => void; onChanged: () => void }) {
  const [starting, setStarting] = useState(false);
  const [running, setRunning] = useState(false);
  const [startedJob, setStartedJob] = useState<string | null>(null);
  const [failedCode, setFailedCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const summary = detail.analysis?.summary;
  const analyzeJob = detail.activeJob?.kind === "analyze" ? detail.activeJob.id : null;
  const jobId = startedJob ?? analyzeJob;
  const busy = starting || running || detail.activeJob !== null;
  const aiDown = health !== null && (!health.ollama.reachable || !health.ollama.modelInstalled);
  const showRestore = !summary && (aiDown || failedCode === "AI_UNAVAILABLE");

  const start = async () => {
    setStarting(true);
    setError(null);
    setFailedCode(null);
    try {
      const { jobId: id } = await apiFetch<{ jobId: string }>(`/api/cases/${detail.id}/analyze`, { method: "POST" });
      setStartedJob(id);
      setRunning(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't start the investigation. Try again.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className={H}>Purpose · AI summary</div>
        <button type="button" disabled={busy} onClick={() => void start()} className="btn btn-secondary ml-auto px-3 py-1.5 text-[13px]">
          {busy ? "Investigating…" : summary ? "Re-run investigation" : "Start Investigation"}
        </button>
      </div>

      {summary?.purpose ? (
        <>
          <p className="m-0 text-sm leading-normal">{summary.purpose}</p>
          {summary.how_to_run && (
            <p className="m-0 text-sm leading-normal">
              <span className="text-muted">How to run it: </span>
              <code className="font-mono text-[13px]">{summary.how_to_run}</code>
            </p>
          )}
          {summary.key_files && summary.key_files.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted">Key files</div>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {summary.key_files.map((file) => (
                  <li key={file.path} className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                    <button type="button" aria-label={`Open ${file.path}`} onClick={() => onOpenFile(file.path)} className="cursor-pointer border-0 bg-transparent p-0 font-mono text-accent underline">
                      {file.path}
                    </button>
                    <span className="text-muted">{file.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {detail.analysis?.model && <p className="m-0 text-xs text-muted">Written by {detail.analysis.model} on this machine. It is a summary, not a verdict.</p>}
        </>
      ) : (
        !showRestore && <p className="m-0 text-sm leading-normal text-muted">The local model hasn&apos;t written an overview of this project yet. Everything above was read directly from its files.</p>
      )}

      {showRestore && <RestoreSteps health={health} />}
      {error && <p role="alert" className="m-0 text-sm text-bad">{error}</p>}

      {jobId && (
        <JobPanel
          jobId={jobId}
          onFinished={(job) => {
            setRunning(false);
            if (job.status === "succeeded") setStartedJob(null);
            else setFailedCode(job.errorCode ?? job.status);
            onChanged();
          }}
        />
      )}
    </div>
  );
}
