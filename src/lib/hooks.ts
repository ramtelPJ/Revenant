"use client";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ApiError, apiFetch, sessionEnded } from "./api-client";
import type { CaseDetail, FilesResponse, Report } from "./case-ui";
import type { Health } from "./health-problems";
import { startPolling, type JobView } from "./polling";

export const useSessionEnded = () => useSyncExternalStore(sessionEnded.subscribe, sessionEnded.get, () => false);

type JobState = { jobId: string; job: JobView | null; error: ApiError | null };

/** Follows a job until it finishes. Stops when the job ends, the id changes, or the component goes away. */
export function useJob(jobId: string | null, onFinished?: (job: JobView) => void) {
  const [state, setState] = useState<JobState | null>(null);

  useEffect(() => {
    if (!jobId) return;
    return startPolling({
      fetchJob: (signal) => apiFetch<JobView>(`/api/jobs/${jobId}`, { signal }),
      onUpdate: (job) => setState({ jobId, job, error: null }),
      onFinished,
      onError: (error) => setState((prev) => ({ jobId, job: prev?.jobId === jobId ? prev.job : null, error: error instanceof ApiError ? error : new ApiError("NETWORK_ERROR", 0, "Lost contact with Revenant.") })),
    });
    // onFinished is read when the job ends, not a reason to restart polling
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const current = state && state.jobId === jobId ? state : null; // a stale answer for a previous job is ignored
  return { job: current?.job ?? null, error: current?.error ?? null };
}

/** What Ollama and Docker are doing. Re-checked when the tab regains focus (after the user starts something). */
export function useHealth(enabled: boolean) {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  // `alive` lets an effect that has been cleaned up ignore a late answer
  const load = useCallback(
    (alive: () => boolean = () => true) =>
      apiFetch<Health>("/api/health").then(
        (result) => {
          if (!alive()) return;
          setHealth(result);
          setError(null);
        },
        (e: unknown) => {
          if (!alive()) return;
          setError(e instanceof ApiError ? e : new ApiError("NETWORK_ERROR", 0, "Can't reach Revenant."));
        },
      ),
    [],
  );

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void load(() => alive);
    const onVisible = () => document.visibilityState === "visible" && void load(() => alive);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, load]);

  return { health, error, recheck: () => load() };
}

type Loaded<T> = { key: string; data: T | null; error: ApiError | null };
const asApiError = (e: unknown) => (e instanceof ApiError ? e : new ApiError("NETWORK_ERROR", 0, "Can't reach Revenant. Check that it is still running."));

/** One GET, with a `reload()` for after something changed. An answer for a different id is ignored. */
function useLoaded<T>(key: string, path: string) {
  const [state, setState] = useState<Loaded<T> | null>(null);
  const load = useCallback(
    () =>
      apiFetch<T>(path).then(
        (data) => setState({ key, data, error: null }),
        (e: unknown) => {
          if (!(e instanceof DOMException)) setState({ key, data: null, error: asApiError(e) });
        },
      ),
    [key, path],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const current = state && state.key === key ? state : null;
  return { data: current?.data ?? null, error: current?.error ?? null, loading: current === null, reload: load };
}

export const useCaseData = (caseId: string) => useLoaded<CaseDetail>(`case:${caseId}`, `/api/cases/${caseId}`);
export const useReport = (caseId: string) => useLoaded<Report>(`report:${caseId}`, `/api/cases/${caseId}/report`);
export const useFiles = (caseId: string) => useLoaded<FilesResponse>(`files:${caseId}`, `/api/cases/${caseId}/files`);
