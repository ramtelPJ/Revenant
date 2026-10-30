"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { ApiError, apiFetch } from "@/lib/api-client";
import type { CaseDetail, CheckRun, Project } from "@/lib/case-ui";
import { useCaseData, useFiles, useHealth } from "@/lib/hooks";
import { healthProblems, type Health } from "@/lib/health-problems";
import { TONE_TAG, VERDICT_LABEL } from "@/lib/labels";
import { TopBar } from "../brand";
import { InlineText } from "../inline-text";
import { JobPanel } from "../job-progress";
import { LastStepNotice } from "../last-step-notice";
import { CheckRunPair } from "../lab/check-run-card";

const H = "font-mono text-xs uppercase tracking-[0.12em] text-muted";
const BTN = "px-[18px] py-[11px]";

type Check = Project["availableChecks"][number];

/** Loads the case, its checks and the setup health, then shows the verification chamber. */
export function VerifyPage({ caseId }: { caseId: string }) {
  const caseData = useCaseData(caseId);
  const files = useFiles(caseId);
  const { health } = useHealth(true);

  if (caseData.error) {
    const missing = caseData.error.status === 404 || caseData.error.status === 400;
    return (
      <>
        <TopBar trail="verification" />
        <main id="main" className="mx-auto max-w-xl px-4 py-16">
          <h1 className="display m-0 text-4xl leading-none">{missing ? "That case isn't here" : "Can't open the verification chamber"}</h1>
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
        <TopBar trail="verification" />
        <main id="main" className="mx-auto max-w-xl px-4 py-16 text-muted">Opening the verification chamber…</main>
      </>
    );
  }
  return <VerifyView detail={caseData.data} checks={files.data?.project.availableChecks ?? null} health={health} onChanged={() => void caseData.reload()} />;
}

/** The newest run of each kind for this patch (after) and for the original (baseline), paired by check. */
export function pairRuns(runs: CheckRun[], patchId: string): { kind: CheckRun["checkKind"]; label: string; before: CheckRun | null; after: CheckRun | null }[] {
  const latest = (pick: (r: CheckRun) => boolean, kind: CheckRun["checkKind"]) => runs.filter((r) => r.checkKind === kind && pick(r)).at(-1) ?? null; // runs arrive oldest first
  const kinds = [...new Set(runs.filter((r) => r.phase === "after" && r.patchId === patchId).map((r) => r.checkKind))];
  return kinds.map((kind) => {
    const after = latest((r) => r.phase === "after" && r.patchId === patchId, kind);
    return { kind, label: after?.commandLabel ?? kind, before: latest((r) => r.phase === "baseline", kind), after };
  });
}

/** Consent, the choice of checks, and the before/after evidence. Nothing runs until the consent box is ticked. */
export function VerifyView({ detail, checks, health, onChanged }: { detail: CaseDetail; checks: Check[] | null; health: Health | null; onChanged: () => void }) {
  const patch = detail.latestPatch;
  const approved = patch?.status === "approved" ? patch : null;
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set(["test", "build", "start"])); // narrowed to the checks the project has
  const [consent, setConsent] = useState(false); // never remembered: it starts unticked on every visit and clears after every run
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobDone, setJobDone] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const working = pending || (jobId !== null && !jobDone) || detail.activeJob !== null;
  const shownJob = jobId ?? (detail.activeJob?.kind === "verify" ? detail.activeJob.id : null);

  const available = (checks ?? []).filter((c) => chosen.has(c.kind)).map((c) => c.kind);
  const dockerProblems = health ? healthProblems(health).filter((p) => p.id === "docker" || p.id === "image") : [];
  const dockerDown = dockerProblems.length > 0;
  const limits = health?.limits;
  const pairs = approved ? pairRuns(detail.checkRuns, approved.id) : [];
  const verdict = detail.stage === "verified" && detail.verdict ? VERDICT_LABEL[detail.verdict] : null;
  const canRun = approved !== null && consent && available.length > 0 && !working && !dockerDown;

  const send = async (path: string, body?: Record<string, unknown>, then?: (data: { jobId?: string }) => void) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setPending(true);
    setError(null);
    try {
      const data = await apiFetch<{ jobId?: string }>(path, { method: "POST", body });
      then?.(data);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "That didn't work. Try again.");
      if (e instanceof ApiError && e.status === 409) onChanged(); // the case moved on: show how it stands now
    } finally {
      busyRef.current = false;
      setPending(false);
    }
  };
  const run = () =>
    void send(`/api/cases/${detail.id}/verify`, { consent, checks: available }, (d) => {
      setConsent(false);
      setJobDone(false);
      setJobId(d.jobId ?? null);
    });
  const skip = () => void send(`/api/cases/${detail.id}/verify/skip`, undefined, () => setConsent(false));
  const toggle = (kind: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (!next.delete(kind)) next.add(kind);
      return next;
    });

  return (
    <>
      <TopBar trail={<><Link href={`/cases/${detail.id}`} className="text-muted hover:text-fg">{detail.name}</Link> / verification</>} />
      <main id="main" className="mx-auto flex max-w-5xl flex-col gap-6 px-[clamp(16px,4vw,48px)] py-10">
        <header className="flex flex-col gap-2">
          <div className={H}>Verification chamber</div>
          <h1 className="display m-0 text-4xl leading-tight">Does the repair work?</h1>
          <p className="m-0 max-w-[60ch] text-muted">The project&apos;s own checks run before and after the repair, in an isolated sandbox. The verdict comes from those results, not from the AI.</p>
        </header>

        {!approved && (
          <p role="status" className="m-0 border border-line bg-surface p-4 text-sm">
            There is no approved patch to verify. {patch?.status === "proposed" ? "Approve the suggested patch first." : "Propose and approve a repair first."}
          </p>
        )}

        {approved && (
          <section aria-label="Checks" className="flex flex-col gap-4 border border-line bg-surface p-[18px]">
            <div className={H}>Checks to run</div>
            {checks === null && <p className="m-0 text-sm text-muted">Reading the project…</p>}
            {checks !== null && checks.length === 0 && <p className="m-0 text-sm text-muted">This project has no test, build or start script, so there is nothing to run. You can skip verification.</p>}
            {checks !== null && checks.length > 0 && (
              <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" disabled={working}>
                <legend className="sr-only">Checks to run</legend>
                {checks.map((check) => (
                  <label key={check.kind} className="flex items-start gap-2.5 text-sm leading-normal">
                    <input type="checkbox" checked={chosen.has(check.kind)} onChange={() => toggle(check.kind)} className="mt-1" />
                    <span>
                      <code className="font-mono">{check.command}</code>
                      <span className="text-muted"> ({check.kind === "start" ? "passes if it keeps running for about 8 seconds" : "passes if it exits with code 0"})</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}

            <div className="flex flex-col gap-1.5 border border-warn/45 px-3 py-3 text-sm leading-normal">
              <p className="m-0 font-medium text-warn">Project code will run inside a Docker container with no network access.</p>
              <p className="m-0 text-muted">
                Limits: {limits?.sandboxMemoryMb ? `${limits.sandboxMemoryMb} MB memory` : "limited memory"}, {limits?.sandboxCpus ? `${limits.sandboxCpus} CPU` : "limited CPU"}, 256 processes, {limits?.checkTimeoutSec ? `${limits.checkTimeoutSec} s` : "a time"} limit per check, read-only system files. It works on a temporary copy, so your project folders are never changed.
              </p>
            </div>

            {dockerDown && (
              <div role="alert" className="flex flex-col gap-1.5 border border-bad/45 px-3 py-3 text-sm">
                <p className="m-0 font-medium text-bad">Checks can&apos;t run until Docker is ready.</p>
                <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
                  {dockerProblems.map((p) => <li key={p.id}><InlineText text={p.fix} /></li>)}
                </ul>
                <p className="m-0 text-muted">Without them nothing can be proven, so the result would stay Unverified. You can still skip verification.</p>
              </div>
            )}

            <label className="flex items-start gap-2.5 text-sm leading-normal">
              <input type="checkbox" checked={consent} disabled={working} onChange={(e) => setConsent(e.target.checked)} className="mt-1" />
              <span>
                I allow this project&apos;s code to run in the sandbox. <span className="text-muted">The tick resets after every run.</span>
              </span>
            </label>
          </section>
        )}

        {!shownJob && <LastStepNotice job={detail.lastJob} />}
        {error && <p role="alert" className="m-0 text-sm text-bad">{error}</p>}
        {shownJob && <JobPanel jobId={shownJob} onFinished={() => { setJobDone(true); onChanged(); }} />}

        {verdict && (
          <section aria-label="Result" className="flex flex-col gap-2 border border-line bg-surface p-[18px]">
            <div className={H}>Result</div>
            <p className="m-0 flex flex-wrap items-center gap-3">
              <span className={`tag ${TONE_TAG[verdict.tone]}`}>{verdict.label}</span>
              <span className="text-sm">{detail.verdictReason}</span>
            </p>
            <p className="m-0 text-xs text-muted">Decided by plain code from the check results below. Passing these checks does not mean the whole project was audited.</p>
            <div><Link href={`/cases/${detail.id}/report`} className={`btn btn-primary ${BTN}`}>Open the Report</Link></div>
          </section>
        )}

        {pairs.map((pair) => <CheckRunPair key={pair.kind} label={pair.label} before={pair.before} after={pair.after} />)}

        <nav aria-label="Actions" className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
          <Link href={`/cases/${detail.id}/repair`} className={`btn btn-secondary ${BTN}`}>Return to Repair</Link>
          {approved && (
            <>
              <button type="button" disabled={!canRun} onClick={run} className={`btn btn-primary ${BTN}`}>{working ? "Running…" : "Run Checks"}</button>
              <button type="button" disabled={working} onClick={skip} className={`btn btn-secondary ${BTN}`}>Skip Verification</button>
            </>
          )}
        </nav>
      </main>
    </>
  );
}
