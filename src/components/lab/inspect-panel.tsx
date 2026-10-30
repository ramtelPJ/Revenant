"use client";
import Link from "next/link";
import { useState } from "react";
import { ApiError, apiFetch } from "@/lib/api-client";
import { baselineCheck, type CaseDetail, type Project } from "@/lib/case-ui";
import type { Health } from "@/lib/health-problems";
import { FINDING_LABEL, TONE_TAG } from "@/lib/labels";
import { JobPanel } from "../job-progress";
import { CheckRunCard } from "./check-run-card";

const H = "mb-2.5 font-mono text-[0.8rem] uppercase tracking-[0.12em] text-muted";

/**
 * Where the person decides whether project code may run. The check runs only after the box is ticked, the tick is
 * sent with the request, and it is cleared after every run, so each run needs a fresh yes.
 */
export function InspectPanel({ detail, project, health, onChanged }: { detail: CaseDetail; project: Project | null; health: Health | null; onChanged: () => void }) {
  const [consent, setConsent] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startedJob, setStartedJob] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = project ? baselineCheck(project.availableChecks) : null;
  const jobId = startedJob ?? detail.activeJob?.id ?? null;
  const running = starting || detail.activeJob !== null || startedJob !== null;
  const dockerDown = health !== null && (!health.docker.available || !health.docker.imagePresent);
  const finding = detail.latestFinding;
  const runs = detail.checkRuns.filter((r) => r.phase === "baseline").sort((a, b) => b.startedAt - a.startedAt);

  const run = async () => {
    setStarting(true);
    setError(null);
    try {
      const { jobId: id } = await apiFetch<{ jobId: string }>(`/api/cases/${detail.id}/diagnose`, { method: "POST", body: { captureBaseline: true, consent } });
      setStartedJob(id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't start the check. Try again.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <section aria-label="Inspect" className="flex flex-col gap-4 border border-line bg-surface p-[18px]">
      <div>
        <div className={H}>Run the project&apos;s own check</div>
        <p className="m-0 text-[0.8667rem] leading-normal text-muted">
          Revenant can run the project once in an isolated sandbox (no network, limited memory and time) to see what really fails. Nothing runs until you allow it.
        </p>
      </div>

      {project === null && <p className="m-0 text-sm text-muted">Reading the project…</p>}
      {project !== null && check === null && (
        <p className="m-0 text-sm text-muted">This project has no test or start script, so there is nothing to run. You can still read its files.</p>
      )}

      {check && (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-sm">
            The check is <code className="font-mono">{check.command}</code>.
          </p>
          {dockerDown && (
            <p role="status" className="m-0 border border-warn/45 px-3 py-2 text-[0.8667rem] text-warn">
              Docker isn&apos;t available right now, so the check can&apos;t run. Start Docker (and pull the sandbox image) first.
            </p>
          )}
          <label className="flex items-start gap-2.5 text-sm leading-normal">
            <input type="checkbox" checked={consent} disabled={running} onChange={(e) => setConsent(e.target.checked)} className="mt-1" />
            <span>
              I allow this project&apos;s code to run in the sandbox. <span className="text-muted">The tick resets after every run.</span>
            </span>
          </label>
          <div>
            <button
              type="button"
              disabled={!consent || running}
              onClick={() => void run()}
              className="btn btn-primary px-[18px] py-[11px]"
            >
              {running ? "Running…" : "Run the check"}
            </button>
          </div>
          {error && <p role="alert" className="m-0 text-sm text-bad">{error}</p>}
        </div>
      )}

      {jobId && (
        <JobPanel
          jobId={jobId}
          onFinished={() => {
            setStartedJob(null);
            setConsent(false);
            onChanged();
          }}
        />
      )}

      {finding && (
        <div className="flex flex-col gap-1.5 border-t border-line pt-4">
          <div className={H}>Finding</div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{finding.title}</span>
            <span className={`tag ${TONE_TAG[FINDING_LABEL[finding.label].tone]}`}>{FINDING_LABEL[finding.label].label}</span>
          </div>
          <p className="m-0 text-[0.8667rem] leading-normal">{finding.explanation}</p>
          <Link href={`/cases/${detail.id}/autopsy`} className="w-fit text-[0.8667rem] text-accent">Open the autopsy →</Link>
        </div>
      )}

      {runs.length > 0 && (
        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <div className={H}>Recorded runs</div>
          {runs.map((r) => (
            <CheckRunCard key={r.id} run={r} />
          ))}
        </div>
      )}
    </section>
  );
}
