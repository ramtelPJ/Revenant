import { CHECK_STATUS, describeLimits, formatDuration, type CheckRun } from "@/lib/case-ui";
import { TONE_TAG } from "@/lib/labels";
import { explainUnrunnable } from "@/lib/unrunnable";

/** One real run of a check, with its exact output. The output is shown as text only. */
export function CheckRunCard({ run }: { run: CheckRun }) {
  const status = CHECK_STATUS[run.status];
  const where = run.target === "original" ? "Original project" : "Repaired copy";
  const truncated = run.outputExcerpt?.includes("[output truncated");
  return (
    <article aria-label={`${run.commandLabel}: ${status.label}`} className="border border-line bg-surface">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-[18px] py-3">
        <code className="font-mono text-sm">{run.commandLabel}</code>
        <span className={`tag ${TONE_TAG[status.tone]}`}>{status.label}</span>
        <span className="ml-auto font-mono text-xs text-muted">{where}</span>
      </header>
      <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] border-b border-line text-sm">
        <div className="border-r border-line px-[18px] py-2.5">
          <dt className="text-xs text-muted">Exit code</dt>
          <dd className="m-0 font-mono text-[13px]">{run.exitCode ?? "none"}</dd>
        </div>
        <div className="border-r border-line px-[18px] py-2.5">
          <dt className="text-xs text-muted">Time</dt>
          <dd className="m-0 font-mono text-[13px]">{formatDuration(run.durationMs)}</dd>
        </div>
        <div className="px-[18px] py-2.5">
          <dt className="text-xs text-muted">Sandbox</dt>
          <dd className="m-0 font-mono text-[13px]">{describeLimits(run.limits)}</dd>
        </div>
      </dl>
      {run.status === "unrunnable" && <p className="m-0 px-[18px] py-3 text-sm text-fg">{explainUnrunnable(run.unrunnableReason)}</p>}
      {run.outputExcerpt && (
        <div className="px-[18px] py-3">
          <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Output{truncated ? " (cut at 64 KB)" : ""}</div>
          <pre tabIndex={0} aria-label="Check output" className="m-0 max-h-72 overflow-auto whitespace-pre-wrap break-words bg-raised p-3 font-mono text-xs leading-[1.7] text-fg">
            {run.outputExcerpt}
          </pre>
        </div>
      )}
    </article>
  );
}
