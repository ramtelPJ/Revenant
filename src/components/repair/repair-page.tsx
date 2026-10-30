"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { ApiError, apiFetch } from "@/lib/api-client";
import type { CaseDetail, Patch } from "@/lib/case-ui";
import { useCaseData } from "@/lib/hooks";
import { FINDING_LABEL, TONE_TAG } from "@/lib/labels";
import { TopBar } from "../brand";
import { DiffViewer } from "../diff-viewer";
import { LastStepNotice } from "../last-step-notice";
import { JobPanel } from "../job-progress";

const H = "font-mono text-[0.8rem] uppercase tracking-[0.12em] text-muted";
const BTN = "px-[18px] py-[11px]";

/** Loads the case, then shows its repair lab. */
export function RepairPage({ caseId }: { caseId: string }) {
  const caseData = useCaseData(caseId);

  if (caseData.error) {
    const missing = caseData.error.status === 404 || caseData.error.status === 400;
    return (
      <>
        <TopBar trail="repair" />
        <main id="main" className="mx-auto max-w-xl px-4 py-16">
          <h1 className="display m-0 text-4xl leading-none">{missing ? "That case isn't here" : "Can't open the repair lab"}</h1>
          <p role="alert" className="mt-4 text-muted">{missing ? "It may have been deleted, or the link may be wrong." : caseData.error.message}</p>
          <div className="mt-6 flex gap-3">
            <Link href="/cases/new" className={`btn btn-primary ${BTN}`}>Open a case</Link>
            {!missing && <button type="button" onClick={() => void caseData.reload()} className={`btn btn-secondary ${BTN}`}>Try again</button>}
          </div>
        </main>
      </>
    );
  }
  if (!caseData.data) {
    return (
      <>
        <TopBar trail="repair" />
        <main id="main" className="mx-auto max-w-xl px-4 py-16 text-muted">Opening the repair lab…</main>
      </>
    );
  }
  return <RepairView detail={caseData.data} onChanged={() => void caseData.reload()} />;
}

const STATUS_NOTE: Record<Patch["status"], string> = {
  proposed: "Proposed. Nothing has been changed yet.",
  approved: "Approved. A working copy was created; the original files were not touched.",
  rejected: "Rejected. The original files were not touched.",
  superseded: "Replaced by a newer suggestion.",
};

/** Review exactly what would change, then approve, reject or ask for another suggestion. */
export function RepairView({ detail, onChanged }: { detail: CaseDetail; onChanged: () => void }) {
  const finding = detail.latestFinding;
  const patch = detail.latestPatch;
  const label = finding ? FINDING_LABEL[finding.label] : null;
  const canRepair = finding !== null && finding.label !== "no_failure_found";

  const [jobId, setJobId] = useState<string | null>(null);
  const [jobDone, setJobDone] = useState(false); // the panel stays, so a PATCH_INVALID message can be read
  const [pending, setPending] = useState(false); // a request is in flight
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false); // a second click in the same tick must not send a second request
  const working = pending || (jobId !== null && !jobDone) || detail.activeJob !== null;
  const shownJob = jobId ?? detail.activeJob?.id ?? null;

  const act = async (path: string, then?: (data: { jobId?: string }) => void) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setPending(true);
    setError(null);
    try {
      const data = await apiFetch<{ jobId?: string }>(path, { method: "POST" });
      then?.(data);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "That didn't work. Try again.");
      if (e instanceof ApiError && e.status === 409) onChanged(); // the case moved on (a newer patch, a step running): show how it stands now
    } finally {
      busyRef.current = false;
      setPending(false);
    }
  };
  const base = `/api/cases/${detail.id}/patches`;
  const propose = () => void act(base, (d) => {
    setJobDone(false);
    setJobId(d.jobId ?? null);
  });
  const decide = (kind: "approve" | "reject") => patch && void act(`${base}/${patch.id}/${kind}`);

  return (
    <>
      <TopBar trail={<><Link href={`/cases/${detail.id}`} className="text-muted hover:text-fg">{detail.name}</Link> / repair</>} />
      <main id="main" className="mx-auto flex max-w-4xl flex-col gap-6 px-[clamp(16px,4vw,48px)] py-10">
        <header className="flex flex-col gap-3">
          <div className={H}>Repair lab</div>
          <h1 className="display m-0 text-4xl leading-tight">{patch ? `Suggestion ${patch.attempt}` : "No suggestion yet"}</h1>
          {finding && label && (
            <p className="m-0 flex flex-wrap items-center gap-2 text-sm">
              <span className={`tag ${TONE_TAG[label.tone]}`}>{label.label}</span>
              <span className="break-words">{finding.title}</span>
            </p>
          )}
        </header>

        {!canRepair && (
          <p className="m-0 text-muted">{finding ? "The autopsy found no failure, so there is nothing to repair." : "Run the autopsy first. A repair is suggested for a diagnosed failure."}</p>
        )}

        {patch && (
          <section aria-label="Suggested change" className="flex flex-col gap-4">
            <p role="status" className="m-0 text-sm">{STATUS_NOTE[patch.status]}</p>
            <div>
              <div className={H}>Why</div>
              <p className="m-0 mt-1 text-[1rem] leading-relaxed">{patch.rationale}</p>
            </div>
            <div>
              <div className={H}>Files affected</div>
              <ul className="m-0 mt-1 list-none p-0 font-mono text-xs">
                {patch.filesAffected.map((f) => <li key={String(f)}>{String(f)}</li>)}
              </ul>
            </div>
            <DiffViewer diffText={patch.diffText} />
            <p className="m-0 text-xs text-muted">Written by {patch.model} on this machine. Whether it works is decided by running the checks, not by the model.</p>
          </section>
        )}

        {!shownJob && <LastStepNotice job={detail.lastJob} />}
        {error && <p role="alert" className="m-0 text-sm text-bad">{error}</p>}
        {shownJob && (
          <JobPanel
            jobId={shownJob}
            onFinished={() => {
              setJobDone(true);
              onChanged();
            }}
          />
        )}

        <nav aria-label="Actions" className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
          <Link href={`/cases/${detail.id}/autopsy`} className={`btn btn-secondary ${BTN}`}>Back to Autopsy</Link>
          {patch?.status === "approved" && <Link href={`/cases/${detail.id}/verify`} className={`btn btn-primary ${BTN}`}>Continue to Verification</Link>}
          {patch?.status === "proposed" && (
            <>
              <button type="button" disabled={working} onClick={() => decide("approve")} className={`btn btn-primary ${BTN}`}>Approve Patch</button>
              <button type="button" disabled={working} onClick={() => decide("reject")} className={`btn btn-secondary ${BTN}`}>Reject</button>
            </>
          )}
          {canRepair && (
            <button type="button" disabled={working} onClick={propose} className={`btn btn-secondary ${BTN}`}>
              {patch ? "Regenerate Suggestion" : "Propose Repair"}
            </button>
          )}
        </nav>
      </main>
    </>
  );
}
