"use client";
import Link from "next/link";
import { useState } from "react";
import { ApiError, apiFetch } from "@/lib/api-client";
import type { CaseDetail } from "@/lib/case-ui";
import { firstFile, parseEvidence, sourceHref } from "@/lib/evidence-ui";
import { useCaseData } from "@/lib/hooks";
import { FINDING_LABEL, TONE_TAG } from "@/lib/labels";
import { TopBar } from "../brand";
import { EvidenceList } from "../evidence-list";
import { JobPanel } from "../job-progress";

const H = "font-mono text-[11px] uppercase tracking-[0.12em] text-muted";
const MAX_LOG_CHARS = 100_000;

/** Loads the case, then shows its autopsy. */
export function AutopsyPage({ caseId }: { caseId: string }) {
  const caseData = useCaseData(caseId);

  if (caseData.error) {
    const missing = caseData.error.status === 404 || caseData.error.status === 400;
    return (
      <>
        <TopBar trail="autopsy" />
        <main id="main" className="mx-auto max-w-xl px-4 py-16">
          <h1 className="display m-0 text-4xl leading-none">{missing ? "That case isn't here" : "Can't open this autopsy"}</h1>
          <p role="alert" className="mt-4 text-muted">{missing ? "It may have been deleted, or the link may be wrong." : caseData.error.message}</p>
          <div className="mt-6 flex gap-3">
            <Link href="/cases/new" className="btn btn-primary px-[18px] py-[11px]">Open a case</Link>
            {!missing && <button type="button" onClick={() => void caseData.reload()} className="btn btn-secondary px-[18px] py-[11px]">Try again</button>}
          </div>
        </main>
      </>
    );
  }
  if (!caseData.data) {
    return (
      <>
        <TopBar trail="autopsy" />
        <main id="main" className="mx-auto max-w-xl px-4 py-16 text-muted">Opening the autopsy…</main>
      </>
    );
  }
  return <AutopsyView detail={caseData.data} onChanged={() => void caseData.reload()} />;
}

/** One prioritized failure, its verified evidence, and an honest label. */
export function AutopsyView({ detail, onChanged }: { detail: CaseDetail; onChanged: () => void }) {
  const finding = detail.latestFinding;
  const items = finding ? parseEvidence(finding.evidence) : [];
  const source = firstFile(items);
  const label = finding ? FINDING_LABEL[finding.label] : null;
  const nothingWrong = finding?.label === "no_failure_found";
  const busy = detail.activeJob !== null;

  return (
    <>
      <TopBar trail={<><Link href={`/cases/${detail.id}`} className="text-muted hover:text-fg">{detail.name}</Link> / autopsy</>} />
      <main id="main" className="mx-auto flex max-w-3xl flex-col gap-6 px-[clamp(16px,4vw,48px)] py-10">
        {!finding && (
          <header className="flex flex-col gap-2">
            <div className={H}>Digital autopsy</div>
            <h1 className="display m-0 text-4xl leading-none">No diagnosis yet</h1>
            <p className="m-0 text-muted">Nothing has been investigated for this case. Run the project&apos;s check from the case page, or add an error log below and diagnose from it.</p>
          </header>
        )}

        {finding && label && (
          <header className="flex flex-col gap-3">
            <div className={H}>Digital autopsy</div>
            <h1 className="display m-0 break-words text-4xl leading-tight">{finding.title}</h1>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`tag ${TONE_TAG[label.tone]}`}>{label.label}</span>
              {finding.category && !nothingWrong && <span className="tag tag-neutral">{finding.category.replace(/_/g, " ")}</span>}
            </div>
            <p className="m-0 text-[15px] leading-relaxed">{finding.explanation}</p>
            <p className="m-0 text-xs leading-normal text-muted">
              {nothingWrong
                ? "This comes from a check that ran in the sandbox, not from the AI. It does not say the project is free of problems."
                : `The label comes from the checks that ran and the citations that could be verified, not from the model's own confidence.${finding.model ? ` Explanation written by ${finding.model} on this machine.` : ""}`}
            </p>
          </header>
        )}

        {finding && <EvidenceList caseId={detail.id} evidence={finding.evidence} droppedCitations={finding.droppedCitations} checkRuns={detail.checkRuns} />}

        <nav aria-label="Actions" className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
          <Link href={`/cases/${detail.id}`} className="btn btn-secondary px-[18px] py-[11px]">Back</Link>
          {source ? (
            <Link href={sourceHref(detail.id, source)} className="btn btn-secondary px-[18px] py-[11px]">View Source</Link>
          ) : (
            <button type="button" disabled title="No cited file to open" className="btn btn-secondary px-[18px] py-[11px]">View Source</button>
          )}
          {finding && !nothingWrong ? (
            <Link href={`/cases/${detail.id}/repair`} className="btn btn-primary px-[18px] py-[11px]">Propose Repair</Link>
          ) : (
            <button type="button" disabled title={finding ? "There is nothing to repair" : "Diagnose first"} className="btn btn-primary px-[18px] py-[11px]">Propose Repair</button>
          )}
        </nav>

        <AddLog caseId={detail.id} busy={busy} activeJobId={detail.activeJob?.id ?? null} onChanged={onChanged} />
      </main>
    </>
  );
}

/** Paste a failure log, save it, and diagnose again from it. The text stays in the box unless it was saved. */
function AddLog({ caseId, busy, activeJobId, onChanged }: { caseId: string; busy: boolean; activeJobId: string | null; onChanged: () => void }) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const working = busy || running || saving;
  const shownJob = jobId ?? activeJobId;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/cases/${caseId}/logs`, { method: "POST", body: { content: text } });
      setText("");
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save the log. Try again."); // the text is kept
    } finally {
      setSaving(false);
    }
  };

  const diagnose = async () => {
    setError(null);
    setRunning(true);
    try {
      const { jobId: id } = await apiFetch<{ jobId: string }>(`/api/cases/${caseId}/diagnose`, { method: "POST", body: { captureBaseline: false } });
      setJobId(id);
    } catch (e) {
      setRunning(false);
      setError(e instanceof ApiError ? e.message : "Couldn't start the diagnosis. Try again.");
    }
  };

  return (
    <section aria-label="Add an error log" className="flex flex-col gap-3 border border-line bg-surface p-[18px]">
      <div className={H}>Add Error Log</div>
      <p className="m-0 text-[13px] leading-normal text-muted">Paste the output of a failing build or start, if you have one. It is stored on this machine and shown only as text. The model reads it to explain the failure.</p>
      <label className="sr-only" htmlFor="error-log">Error log</label>
      <textarea
        id="error-log"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
        rows={7}
        maxLength={MAX_LOG_CHARS}
        spellCheck={false}
        placeholder="Error: Cannot find module './config'…"
        className="w-full resize-y border border-line bg-raised p-3 font-mono text-xs leading-[1.7] text-fg"
      />
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={working || text.trim() === ""} onClick={() => void save()} className="btn btn-secondary px-[18px] py-[11px]">{saving ? "Saving…" : "Save log"}</button>
        <button type="button" disabled={working || !saved} onClick={() => void diagnose()} className="btn btn-primary px-[18px] py-[11px]">{running ? "Diagnosing…" : "Diagnose with the logs"}</button>
        {saved && !running && <span role="status" className="text-[13px] text-ok">Log saved.</span>}
      </div>
      {error && <p role="alert" className="m-0 text-sm text-bad">{error}</p>}
      {shownJob && (
        <JobPanel
          jobId={shownJob}
          onFinished={() => {
            setRunning(false);
            setSaved(false);
            onChanged();
          }}
        />
      )}
    </section>
  );
}
