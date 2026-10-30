// INT-002: what a person sees when something goes wrong (auth §13), without a browser: components are rendered to
// markup, and the server side that feeds them is checked against a real database.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ErrorPage from "@/app/error";
import NotFound from "@/app/not-found";
import { LastStepNotice, describeLastStep } from "@/components/last-step-notice";
import { CheckRunCard } from "@/components/lab/check-run-card";
import { getCaseDetail } from "@/lib/cases/detail";
import { removeTree } from "@/lib/cases/fs";
import { importFolder, type ImportContext } from "@/lib/cases/import";
import type { CheckRun } from "@/lib/case-ui";
import { openDatabase, type OpenDatabase } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import type { JobView } from "@/lib/polling";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const job = (over: Partial<JobView> = {}): JobView => ({ id: "j", caseId: "c", kind: "propose_patch", status: "failed", progressNote: null, steps: [], errorCode: "PATCH_INVALID", errorMessage: "The suggested change couldn't be applied safely, so nothing was saved. Try Regenerate.", createdAt: 1, startedAt: 1, finishedAt: 2, ...over });

describe("describeLastStep", () => {
  test("a restart is explained and the person is told to run the step again", () => {
    expect(describeLastStep(job({ kind: "verify", errorCode: "SERVER_RESTARTED", errorMessage: "This step was interrupted by a restart." }))).toBe("The verification was interrupted by a restart. Run it again.");
  });
  test("a failure shows the server's own sentence, never the code", () => {
    const text = describeLastStep(job());
    expect(text).toBe("The repair suggestion didn't finish: The suggested change couldn't be applied safely, so nothing was saved. Try Regenerate.");
    expect(text).not.toMatch(/PATCH_INVALID|[A-Z]+_[A-Z_]+/);
  });
  test("a cancel, and a failure with no message, are still plain", () => {
    expect(describeLastStep(job({ kind: "analyze", status: "cancelled", errorCode: null, errorMessage: null }))).toBe("The project overview was cancelled.");
    expect(describeLastStep(job({ kind: "diagnose", errorCode: "INTERNAL", errorMessage: null }))).toBe("The diagnosis didn't finish. Try it again.");
  });
});

describe("LastStepNotice", () => {
  test("shows a step that ended before this page was opened", () => {
    const out = html(<LastStepNotice job={job({ finishedAt: Date.now() - 60_000 })} />);
    expect(out).toContain("Earlier step: ");
    expect(out).toContain("Try Regenerate.");
  });
  test("stays quiet for a step that ends while the page is open (its own progress panel shows it), and for no step", () => {
    expect(html(<LastStepNotice job={job({ finishedAt: Date.now() + 60_000 })} />)).toBe("");
    expect(html(<LastStepNotice job={null} />)).toBe("");
    expect(html(<LastStepNotice job={undefined} />)).toBe("");
  });
  test("model or project text in the message stays text", () => {
    const out = html(<LastStepNotice job={job({ finishedAt: 1, errorMessage: "<script>alert(1)</script>" })} />);
    expect(out).not.toContain("<script>");
  });
});

describe("error and not-found pages", () => {
  test("the error page says what to do and shows no cause", () => {
    const out = html(<ErrorPage error={Object.assign(new Error("SELECT * FROM cases at /Users/x/data/revenant.db"), { digest: "abc" })} reset={() => {}} />);
    expect(out).toContain("Something went wrong");
    expect(out).toContain("Try again");
    expect(out).toContain('href="/cases/new"');
    expect(/SELECT|revenant\.db|\/Users\/|abc/.test(out)).toBe(false);
  });
  test("the not-found page is not blank and leads somewhere", () => {
    const out = html(<NotFound />);
    expect(out).toContain("That page isn&#x27;t here");
    expect(out).toContain('href="/cases/new"');
  });
});

describe("a check that timed out", () => {
  const timedOut: CheckRun = {
    id: "r", patchId: null, phase: "baseline", checkKind: "test", commandLabel: "npm test", target: "original", status: "timed_out", exitCode: null, outputExcerpt: null,
    unrunnableReason: null, durationMs: 120_000, limits: { memoryMb: 512, cpus: 1, pids: 256, timeoutSec: 120, network: "none" }, startedAt: 1, finishedAt: 2,
  };
  test("says why, with the limit", () => {
    expect(html(<CheckRunCard run={timedOut} />)).toContain("did not finish within its 120 second limit and was stopped");
  });
  test("still says it without recorded limits", () => {
    expect(html(<CheckRunCard run={{ ...timedOut, limits: null }} />)).toContain("within its time limit");
  });
});

describe("the case detail keeps the last bad step visible", () => {
  let root: string;
  let open: OpenDatabase;
  let ctx: ImportContext;
  const newCase = async () => {
    const dir = path.join(root, "src", crypto.randomUUID());
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "p", scripts: { test: "x" } }));
    return (await importFolder(dir, ctx)).id;
  };
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "revenant-fail-")));
    mkdirSync(path.join(root, "home"));
    open = openDatabase(path.join(root, "data"));
    ctx = { db: open.db, dataDir: path.join(root, "data"), maxProjectBytes: 1e8, samplesDir: path.join(root, "samples"), homeDir: path.join(root, "home") };
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    open.sqlite.close();
    await removeTree(root);
  });

  test("no jobs, or a newest job that succeeded, means no notice", async () => {
    const id = await newCase();
    expect(getCaseDetail(id, open.db).lastJob).toBeNull();
    open.db.insert(jobs).values({ caseId: id, kind: "analyze", status: "failed", errorCode: "AI_UNAVAILABLE", errorMessage: "x", createdAt: 1, finishedAt: 2 }).run();
    expect(getCaseDetail(id, open.db).lastJob).toMatchObject({ kind: "analyze", status: "failed" });
    open.db.insert(jobs).values({ caseId: id, kind: "analyze", status: "succeeded", createdAt: 3, finishedAt: 4 }).run();
    expect(getCaseDetail(id, open.db).lastJob).toBeNull(); // a later success clears it
  });

  test("a job interrupted by a restart is still there after the server comes back", async () => {
    const id = await newCase();
    open.db.insert(jobs).values({ caseId: id, kind: "verify", status: "running", startedAt: Date.now(), createdAt: Date.now() }).run();
    open.sqlite.close();
    open = openDatabase(path.join(root, "data")); // the restart marks it failed
    const detail = getCaseDetail(id, open.db);
    expect(detail.activeJob).toBeNull();
    expect(detail.lastJob).toMatchObject({ kind: "verify", status: "failed", errorCode: "SERVER_RESTARTED", errorMessage: "This step was interrupted by a restart." });
  });

  test("a running job is the active one, not the last one", async () => {
    const id = await newCase();
    open.db.insert(jobs).values({ caseId: id, kind: "diagnose", status: "running", createdAt: Date.now() }).run();
    const detail = getCaseDetail(id, open.db);
    expect(detail.activeJob?.kind).toBe("diagnose");
    expect(detail.lastJob).toBeNull();
  });
});
