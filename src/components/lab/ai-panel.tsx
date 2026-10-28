import type { CaseDetail } from "@/lib/case-ui";
import type { Health } from "@/lib/health-problems";
import { TONE_TAG } from "@/lib/labels";

const H = "mb-2.5 font-mono text-[11px] uppercase tracking-[0.12em] text-muted";

/** The status of the local model, what it is doing, and what it has found. It shows no confidence score: none is used. */
export function AiPanel({ detail, health }: { detail: CaseDetail; health: Health | null }) {
  const ollama = health?.ollama;
  const state = !ollama ? "checking" : !ollama.reachable ? "offline" : !ollama.modelInstalled ? "missing" : "ready";
  const view = {
    checking: { text: "Checking…", dot: "bg-muted", tone: "text-muted" },
    offline: { text: "Model offline", dot: "bg-bad", tone: "text-bad" },
    missing: { text: "Model not installed", dot: "bg-warn", tone: "text-warn" },
    ready: { text: "Local AI ready", dot: "bg-ok", tone: "text-ok" },
  }[state];
  const job = detail.activeJob;
  const finding = detail.latestFinding;

  return (
    <aside aria-label="AI investigator" className="min-h-0 min-w-0 flex-1 overflow-y-auto border-l border-line bg-raised">
      <div className="flex flex-col gap-1 border-b border-line p-4">
        <div className="display text-lg">AI investigator</div>
        <div aria-live="polite" className="flex items-center gap-2 font-mono text-xs">
          <span className={`h-[7px] w-[7px] flex-none ${view.dot}`} />
          <span className={view.tone}>{ollama?.model ? `${ollama.model} · ${view.text}` : view.text}</span>
        </div>
        <div className="text-xs text-muted">Runs on this machine. Your code is not sent anywhere else.</div>
      </div>

      {(state === "offline" || state === "missing") && (
        <p className="m-0 border-b border-line px-4 py-3.5 text-[13px] leading-normal text-muted">
          Files, dependencies and check results stay available. Diagnosis and repair suggestions are paused until the model is back; Revenant won&apos;t guess a cause without it.
        </p>
      )}

      <div className="border-b border-line px-4 py-3.5">
        <div className={H}>Current activity</div>
        <p className="m-0 text-[13px] leading-normal">
          {job ? (job.progressNote ?? job.steps.find((s) => s.state === "running")?.label ?? "Working…") : "Idle. The model has not been asked anything about this project yet."}
        </p>
        {job && <div aria-hidden="true" className="relative mt-2.5 h-0.5 overflow-hidden bg-line"><div className="rv-scan absolute inset-y-0 left-0 w-1/3 bg-accent" /></div>}
      </div>

      <div className="border-b border-line px-4 py-3.5">
        <div className={H}>Findings</div>
        {!finding && <p className="m-0 text-[13px] text-muted">Nothing yet.</p>}
        {finding && (
          <div className="flex flex-col gap-1.5 text-[13px]">
            <div>{finding.title}</div>
            <span className={`tag w-fit ${finding.label === "no_failure_found" ? TONE_TAG.ok : TONE_TAG.warn}`}>{LABEL[finding.label]}</span>
          </div>
        )}
      </div>

      <p className="m-0 px-4 py-3.5 text-xs leading-normal text-muted">
        A finding&apos;s label comes from the checks that were run and the files it cites, never from the model&apos;s own confidence. Only sandbox check results decide the verdict.
      </p>
    </aside>
  );
}

const LABEL = {
  confirmed_by_check: "Confirmed by check",
  supported_by_files: "Supported by files",
  hypothesis: "Hypothesis",
  no_failure_found: "Check passed",
} as const;
