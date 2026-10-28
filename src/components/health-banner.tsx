"use client";
import { ApiError, SESSION_ENDED_MESSAGE } from "@/lib/api-client";
import { healthProblems, type Health } from "@/lib/health-problems";
import { useHealth, useSessionEnded } from "@/lib/hooks";
import { InlineText } from "./inline-text";

/** Shown when the session has ended (any request got a 401). The page keeps its state, so nothing typed is lost. */
export function SessionBannerView() {
  return (
    <div role="alert" className="rounded-md border border-bad/60 bg-surface px-4 py-3">
      <p className="font-medium text-bad">Session ended</p>
      <p className="mt-1 text-sm text-fg">{SESSION_ENDED_MESSAGE}</p>
    </div>
  );
}

export function SessionBanner() {
  return useSessionEnded() ? <SessionBannerView /> : null;
}

/** The pure part: what to show for a given health answer. Nothing at all when everything is ready. */
export function HealthBannerView({ health, onRecheck }: { health: Health | null; onRecheck?: () => void }) {
  if (!health) return null;
  const problems = healthProblems(health);
  if (problems.length === 0) return null;

  return (
    <section aria-label="Setup problems" role="status" className="rounded-md border border-warn/60 bg-surface px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <p className="font-medium text-warn">{problems.length === 1 ? "One thing needs attention" : `${problems.length} things need attention`}</p>
        {onRecheck && (
          <button type="button" onClick={onRecheck} className="shrink-0 rounded border border-line px-3 py-1 text-sm hover:bg-raised">
            Check again
          </button>
        )}
      </div>
      <ul className="mt-2 space-y-3">
        {problems.map((problem) => (
          <li key={problem.id}>
            <p className="text-sm font-medium text-fg">{problem.title}</p>
            <p className="text-sm text-muted">{problem.consequence}</p>
            <p className="mt-1 text-sm text-fg">
              <span className="text-muted">To fix: </span>
              <InlineText text={problem.fix} />
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function HealthBanner({ enabled = true }: { enabled?: boolean }) {
  const { health, error, recheck } = useHealth(enabled);
  // a 401 is already explained by the session banner; any other failure to ask is worth saying
  if (error && !(error instanceof ApiError && error.status === 401)) {
    return (
      <div role="status" className="rounded-md border border-warn/60 bg-surface px-4 py-3 text-sm">
        <p className="font-medium text-warn">Can&apos;t check the setup</p>
        <p className="mt-1 text-muted">{error.message}</p>
      </div>
    );
  }
  return <HealthBannerView health={health} onRecheck={recheck} />;
}
