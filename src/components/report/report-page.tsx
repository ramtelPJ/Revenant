"use client";
import Link from "next/link";
import type { CheckRun, Report } from "@/lib/case-ui";
import { useReport } from "@/lib/hooks";
import { FINDING_LABEL, TONE_TAG, VERDICT_LABEL } from "@/lib/labels";
import { TopBar } from "../brand";
import { DiffViewer } from "../diff-viewer";
import { EvidenceList } from "../evidence-list";
import { CheckRunPair } from "../lab/check-run-card";

const H = "font-mono text-xs uppercase tracking-[0.12em] text-muted";
const BTN = "px-[18px] py-[11px]";

// plain words for the step names the server records
const STEP_WORDS: Record<string, string> = {
  overview: "wrote the project overview",
  diagnosis: "explained the failure",
  patch: "wrote the suggested patch",
  inventory: "File inventory, scripts and entry points",
  labels: "The label on the finding (confirmed, supported, hypothesis)",
  checks: "Running the checks in the sandbox",
  verdict: "The verdict",
};

/** Loads the report. A case that has not been verified has no report, and says so. */
export function ReportPage({ caseId }: { caseId: string }) {
  const report = useReport(caseId);

  if (report.error) return <ReportProblem caseId={caseId} status={report.error.status} message={report.error.message} onRetry={() => void report.reload()} />;
  if (!report.data) {
    return (
      <>
        <TopBar trail="report" />
        <main id="main" className="mx-auto max-w-xl px-4 py-16 text-muted">Opening the report…</main>
      </>
    );
  }
  return <ReportView report={report.data} />;
}

/** Why there is no report: not verified yet (409), no such case, or a failure to load. */
export function ReportProblem({ caseId, status, message, onRetry }: { caseId: string; status: number; message: string; onRetry: () => void }) {
  const notVerified = status === 409;
  const missing = status === 404 || status === 400;
  return (
    <>
      <TopBar trail="report" />
      <main id="main" className="mx-auto max-w-xl px-4 py-16">
        <h1 className="display m-0 text-4xl leading-none">{notVerified ? "Not verified yet" : missing ? "That case isn't here" : "Can't open the report"}</h1>
        <p role={notVerified ? "status" : "alert"} className="mt-4 text-muted">
          {notVerified ? "This case has no verdict, so there is nothing to report. Run the checks, or skip verification, to get a result." : missing ? "It may have been deleted, or the link may be wrong." : message}
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          {notVerified ? (
            <>
              <Link href={`/cases/${caseId}/verify`} className={`btn btn-primary ${BTN}`}>Go to Verification</Link>
              <Link href={`/cases/${caseId}`} className={`btn btn-secondary ${BTN}`}>Back to the case</Link>
            </>
          ) : (
            <>
              <Link href="/cases/new" className={`btn btn-primary ${BTN}`}>Open a case</Link>
              {!missing && <button type="button" onClick={onRetry} className={`btn btn-secondary ${BTN}`}>Try again</button>}
            </>
          )}
        </div>
      </main>
    </>
  );
}

/** The stored verdict, the evidence behind it, and an honest account of what the AI did. */
export function ReportView({ report }: { report: Report }) {
  const verdict = VERDICT_LABEL[report.verdict]; // the only source of the verdict's words
  const finding = report.finding;
  const label = finding ? FINDING_LABEL[finding.label] : null;
  const allRuns: CheckRun[] = [...report.checkRuns.baseline, ...report.checkRuns.after];
  const kinds = [...new Set(allRuns.map((r) => r.checkKind))];
  const latest = (runs: CheckRun[], kind: string) => runs.filter((r) => r.checkKind === kind).at(-1) ?? null;
  const aiDid = report.aiContribution.aiSteps.map((s) => STEP_WORDS[s] ?? s);

  return (
    <>
      <TopBar trail={<><Link href={`/cases/${report.caseId}`} className="text-muted hover:text-fg">{report.name}</Link> / report</>} />
      <main id="main" className="mx-auto flex max-w-5xl flex-col gap-8 px-[clamp(16px,4vw,48px)] py-10">
        <header className="flex flex-col gap-3">
          <div className={H}>Resurrection report</div>
          <h1 className="m-0 flex flex-wrap items-center gap-3">
            <span className={`tag ${TONE_TAG[verdict.tone]} px-4 py-2 text-base`}>{verdict.label}</span>
          </h1>
          {report.verdictReason && <p className="m-0 text-lg leading-snug">{report.verdictReason}</p>}
          <p className="m-0 text-xs text-muted">Decided by plain code from the check results below, not by the AI.</p>
        </header>

        {finding && label && (
          <section aria-label="The original failure" className="flex flex-col gap-3">
            <div className={H}>The original failure</div>
            <h2 className="m-0 break-words text-xl font-semibold leading-snug">{finding.title}</h2>
            <p className="m-0 flex flex-wrap items-center gap-2">
              <span className={`tag ${TONE_TAG[label.tone]}`}>{label.label}</span>
              {finding.category && <span className="tag tag-neutral">{finding.category.replace(/_/g, " ")}</span>}
            </p>
            <p className="m-0 text-[15px] leading-relaxed">{finding.explanation}</p>
            <EvidenceList caseId={report.caseId} evidence={finding.evidence} droppedCitations={finding.droppedCitations} checkRuns={allRuns} />
          </section>
        )}

        <section aria-label="Before and after" className="flex flex-col gap-4">
          <div className={H}>Before and after</div>
          {kinds.length === 0 ? (
            <p className="m-0 text-sm text-muted">No check was run on the repaired copy, so there is no before-and-after evidence.</p>
          ) : (
            kinds.map((kind) => {
              const before = latest(report.checkRuns.baseline, kind);
              const after = latest(report.checkRuns.after, kind);
              return <CheckRunPair key={kind} label={(after ?? before)?.commandLabel ?? kind} before={before} after={after} />;
            })
          )}
        </section>

        <section aria-label="Remaining issues" className="flex flex-col gap-2">
          <div className={H}>Remaining issues</div>
          {report.remainingIssues.length === 0 ? (
            <p className="m-0 text-sm text-muted">None among the checks that were run. Anything not listed above was not tested.</p>
          ) : (
            <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm">
              {report.remainingIssues.map((issue) => <li key={issue}>{issue}</li>)}
            </ul>
          )}
        </section>

        {report.patch && (
          <section aria-label="The approved change" className="flex flex-col gap-3">
            <div className={H}>The approved change</div>
            <p className="m-0 text-[15px] leading-relaxed">{report.patch.rationale}</p>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0 font-mono text-xs">
              {report.patch.filesAffected.map((f) => <li key={String(f)}>{String(f)}</li>)}
            </ul>
            <DiffViewer diffText={report.patch.diffText} />
          </section>
        )}

        <section aria-label="How local AI contributed" className="flex flex-col gap-2 border border-line bg-surface p-[18px]">
          <div className={H}>How local AI contributed</div>
          <p className="m-0 text-sm leading-normal">
            {aiDid.length > 0 && report.aiContribution.model
              ? `The local model ${report.aiContribution.model}, running on this machine, ${aiDid.join(", ").replace(/, ([^,]*)$/, " and $1")}.`
              : "The local model did not write any part of this result."}
          </p>
          <p className="m-0 text-sm leading-normal text-muted">
            Not done by AI: {report.aiContribution.deterministicSteps.map((s) => (STEP_WORDS[s] ?? s).toLowerCase()).join("; ")}.
          </p>
        </section>

        <p role="note" className="m-0 border border-line px-4 py-3 text-sm leading-normal text-muted">{report.disclaimer}</p>

        <nav aria-label="Actions" className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
          <Link href={`/cases/${report.caseId}/repair`} className={`btn btn-secondary ${BTN}`}>Review Patch</Link>
          <Link href="/cases/new" className={`btn btn-primary ${BTN}`}>Start Another Case</Link>
        </nav>
      </main>
    </>
  );
}
