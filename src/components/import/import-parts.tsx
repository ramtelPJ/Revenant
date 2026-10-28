import Link from "next/link";
import { formatBytes, formatWhen, type ImportProblem } from "@/lib/import-ui";
import { STAGE_LABEL, TONE_TAG, VERDICT_LABEL, type Stage, type Verdict } from "@/lib/labels";

export type RecentCase = { id: string; name: string; stage: Stage; verdict: Verdict | null; updatedAt: number };
export type SampleInfo = { id: string; name: string; description: string };

export function ImportErrorBox({ problem }: { problem: ImportProblem }) {
  return (
    <div role="alert" className="flex items-start gap-3.5 border border-bad/45 bg-bad/[0.07] px-[18px] py-4">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="mt-0.5 flex-none text-bad">
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </svg>
      <div className="flex flex-col gap-1">
        <div className="font-semibold text-bad">{problem.title}</div>
        <div className="text-sm leading-normal text-fg">{problem.body}</div>
      </div>
    </div>
  );
}

/** The archive the person picked, before anything is uploaded. */
export function SelectionCard({ name, size }: { name: string; size: number }) {
  return (
    <div className="border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-[18px] py-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Selected for inspection</div>
          <div className="display break-all text-[22px]">{name}</div>
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] border-b border-line">
        <div className="border-r border-line px-[18px] py-3">
          <div className="text-xs text-muted">Type</div>
          <div className="font-mono text-[13px]">ZIP archive</div>
        </div>
        <div className="px-[18px] py-3">
          <div className="text-xs text-muted">Size</div>
          <div className="font-mono text-[13px]">{formatBytes(size)}</div>
        </div>
      </div>
      <div className="px-[18px] py-3 text-[13px] text-muted">Nothing has been executed. Importing only reads files.</div>
    </div>
  );
}

export function SampleCards({ samples, busy, onPick }: { samples: SampleInfo[] | null; busy: boolean; onPick: (id: string) => void }) {
  if (samples === null) return <p className="text-sm text-muted">Looking for samples…</p>;
  if (samples.length === 0) return <div className="border border-dashed border-line px-[18px] py-[22px] text-sm text-muted">No sample projects are installed.</div>;
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {samples.map((sample) => (
        <li key={sample.id}>
          <button
            type="button"
            disabled={busy}
            onClick={() => onPick(sample.id)}
            className="flex w-full cursor-pointer flex-col items-start gap-2 border border-line bg-bg p-[18px] text-left text-fg transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="font-mono text-[15px]">{sample.name}</span>
            <span className="text-sm leading-normal text-muted">{sample.description}</span>
            <span className="text-[13px] text-accent">Load sample →</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function RecentInvestigations({ cases, now }: { cases: RecentCase[] | null; now?: number }) {
  if (cases === null) return <p className="text-sm text-muted">Loading…</p>;
  if (cases.length === 0) {
    return <div className="border border-dashed border-line px-[18px] py-[22px] text-sm text-muted">No cases on this machine yet. Completed investigations appear here.</div>;
  }
  return (
    <ul className="m-0 list-none border-t-2 border-line p-0">
      {cases.map((c) => {
        const verdict = c.verdict ? VERDICT_LABEL[c.verdict] : null;
        return (
          <li key={c.id} className="border-b border-line">
            <Link href={`/cases/${c.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-fg hover:bg-surface hover:text-fg">
              <span className="min-w-0 flex-1 truncate font-mono text-sm">{c.name}</span>
              <span className="tag tag-neutral">{STAGE_LABEL[c.stage]}</span>
              {verdict && <span className={`tag ${TONE_TAG[verdict.tone]}`}>{verdict.label}</span>}
              <span className="w-full text-xs text-muted sm:w-auto">{formatWhen(c.updatedAt, now)}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
