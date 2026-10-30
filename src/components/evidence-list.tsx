import Link from "next/link";
import type { CheckRun } from "@/lib/case-ui";
import { droppedNote, lineRange, parseEvidence, sourceHref } from "@/lib/evidence-ui";
import { CheckRunCard } from "./lab/check-run-card";

const H = "font-mono text-[0.8rem] uppercase tracking-[0.12em] text-muted";

/**
 * The evidence behind a finding. Only items the server verified are stored, so only those are drawn.
 * Every excerpt is project or model text and is shown as text.
 */
export function EvidenceList({ caseId, evidence, droppedCitations, checkRuns }: { caseId: string; evidence: unknown[]; droppedCitations: number; checkRuns: CheckRun[] }) {
  const items = parseEvidence(evidence);
  const note = droppedNote(droppedCitations, items);

  return (
    <section aria-label="Evidence" className="flex flex-col gap-3">
      <div className={H}>Evidence</div>
      {items.length === 0 && <p className="m-0 text-sm text-muted">No citation could be verified against the project&apos;s files or output.</p>}

      {items.map((item, i) => {
        if (item.kind === "file") {
          return (
            <figure key={i} className="m-0 border border-line bg-raised">
              <figcaption className="flex flex-wrap items-center gap-x-3 border-b border-line px-3 py-2 font-mono text-xs">
                <Link href={sourceHref(caseId, item.path)} className="min-w-0 truncate text-accent">{item.path}</Link>
                <span className="text-muted">{lineRange(item)}</span>
              </figcaption>
              <div className="flex overflow-x-auto font-mono text-xs leading-[1.7]">
                <pre aria-hidden="true" className="m-0 select-none border-r border-line px-3 py-2 text-right text-muted">{item.startLine}</pre>
                <pre tabIndex={0} aria-label={`Excerpt from ${item.path}`} className="m-0 min-w-0 flex-1 whitespace-pre-wrap break-words px-3 py-2 text-fg">{item.quote}</pre>
              </div>
            </figure>
          );
        }
        if (item.kind === "log") {
          return (
            <figure key={i} className="m-0 border border-line bg-raised">
              <figcaption className="border-b border-line px-3 py-2 font-mono text-xs text-muted">{item.origin === "check" ? "From the check's output" : "From the error log you added"}</figcaption>
              <pre tabIndex={0} aria-label="Log excerpt" className="m-0 whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-[1.7] text-fg">{item.excerpt}</pre>
            </figure>
          );
        }
        const run = checkRuns.find((r) => r.id === item.checkRunId);
        return run ? <CheckRunCard key={i} run={run} /> : <p key={i} className="m-0 text-sm text-muted">The check run that confirmed this is no longer available.</p>;
      })}

      {note && <p role="status" className="m-0 text-[0.8667rem] text-warn">{note}</p>}
    </section>
  );
}
