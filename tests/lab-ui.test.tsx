import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { AiPanel } from "@/components/lab/ai-panel";
import { CheckRunCard } from "@/components/lab/check-run-card";
import { Explorer } from "@/components/lab/explorer";
import { InspectPanel } from "@/components/lab/inspect-panel";
import { ImportErrorBox, RecentInvestigations, SampleCards, SelectionCard } from "@/components/import/import-parts";
import { ApiError } from "@/lib/api-client";
import {
  CHECK_STATUS, baselineCheck, buildTree, describeLimits, extOf, formatDuration, visibleRows,
  type CaseDetail, type CheckRun, type Finding, type FilesResponse, type Project, type TreeEntry,
} from "@/lib/case-ui";
import type { Health } from "@/lib/health-problems";
import { checkChosenFile, describeImportError, formatBytes, formatWhen } from "@/lib/import-ui";
import type { JobView } from "@/lib/polling";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

const project = (over: Partial<Project> = {}): Project => ({
  name: "demo", version: "1.2.3", sizeBytes: 100, hasNodeModules: true, dependencies: { chalk: "^5.0.0" }, devDependencies: {},
  scripts: { test: "node test.js" }, engines: {}, entryPoints: [{ path: "src/index.js", source: "main", exists: true }], readme: null,
  availableChecks: [{ kind: "test", command: "npm test" }], ...over,
});
const run = (over: Partial<CheckRun> = {}): CheckRun => ({
  id: "r1", patchId: null, phase: "baseline", checkKind: "test", commandLabel: "npm test", target: "original", status: "failed", exitCode: 1,
  outputExcerpt: "boom", unrunnableReason: null, durationMs: 480, limits: { memoryMb: 512, cpus: 1, pids: 256, timeoutSec: 120, network: "none" },
  startedAt: 1, finishedAt: 2, ...over,
});
const detail = (over: Partial<CaseDetail> = {}): CaseDetail => ({
  id: "c1", name: "demo", sourceKind: "sample", sourceLabel: "demo", stage: "imported", sizeBytes: 2048, fileCount: 3, verdict: null, verdictReason: null,
  createdAt: Date.now(), updatedAt: Date.now(), analysis: null, latestFinding: null, latestPatch: null, activeJob: null, checkRuns: [], ...over,
});
const makeFinding = (over: Partial<Finding> = {}): Finding => ({ id: "f", label: "no_failure_found", title: "No failure found", explanation: "e", category: null, evidence: [], checkRunId: null, model: null, createdAt: 1, ...over });
const makeJob = (over: Partial<JobView> = {}): JobView => ({ id: "j1", caseId: "c1", kind: "diagnose", status: "running", progressNote: null, steps: [], errorCode: null, errorMessage: null, createdAt: 1, startedAt: 1, finishedAt: null, ...over });
const healthy: Health = { ollama: { reachable: true, modelInstalled: true, model: "gemma2:2b" }, docker: { available: true, imagePresent: true, image: "node:lts-slim" } };

describe("file tree", () => {
  const entries: TreeEntry[] = [
    { path: "README.md", type: "file", sizeBytes: 1 },
    { path: "node_modules", type: "dir", collapsed: true, fileCount: 412 },
    { path: "src", type: "dir" },
    { path: "src/lib", type: "dir" },
    { path: "src/lib/util.js", type: "file", sizeBytes: 1 },
    { path: "src/a.js", type: "file", sizeBytes: 1 },
    { path: "package.json", type: "file", sizeBytes: 1 },
  ];

  test("nests children under their folder; folders first, then files, each alphabetical", () => {
    const tree = buildTree(entries);
    expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual(["modules:node_modules", "dir:src", "file:package.json", "file:README.md"]);
    const src = tree.find((n) => n.name === "src")!;
    expect(src.children.map((n) => n.name)).toEqual(["lib", "a.js"]);
    expect(src.children[0].children.map((n) => n.path)).toEqual(["src/lib/util.js"]);
  });

  test("node_modules is one entry that carries its file count and never expands", () => {
    const [modules] = buildTree(entries);
    expect(modules).toMatchObject({ kind: "modules", fileCount: 412, children: [] });
    expect(visibleRows([modules], new Set())[0].expanded).toBe(false);
  });

  test("visibleRows lists every row with its depth, and collapsing a folder hides everything inside it", () => {
    const tree = buildTree(entries);
    expect(visibleRows(tree, new Set()).map((r) => `${r.depth}:${r.path}`)).toEqual(["0:node_modules", "0:src", "1:src/lib", "2:src/lib/util.js", "1:src/a.js", "0:package.json", "0:README.md"]);
    const collapsed = visibleRows(tree, new Set(["src"]));
    expect(collapsed.map((r) => r.path)).toEqual(["node_modules", "src", "package.json", "README.md"]);
    expect(collapsed.find((r) => r.path === "src")!.expanded).toBe(false);
    expect(visibleRows(tree, new Set(["src/lib"])).map((r) => r.path)).not.toContain("src/lib/util.js");
  });

  test("empty input, extensions, and an orphan entry do not break it", () => {
    expect(buildTree([])).toEqual([]);
    expect(visibleRows([], new Set())).toEqual([]);
    expect(extOf("index.js")).toBe("JS");
    expect(extOf("archive.tar.gz")).toBe("GZ");
    expect(extOf("Makefile")).toBe("");
    expect(extOf("package-lock.json")).toBe("JSON");
    expect(buildTree([{ path: "ghost/child.js", type: "file", sizeBytes: 1 }]).map((n) => n.path)).toEqual(["ghost/child.js"]);
  });
});

describe("check helpers", () => {
  test("test beats start, build is never the baseline, none gives null", () => {
    expect(baselineCheck([{ kind: "start", command: "npm start" }, { kind: "test", command: "npm test" }, { kind: "build", command: "npm run build" }])?.kind).toBe("test");
    expect(baselineCheck([{ kind: "build", command: "b" }, { kind: "start", command: "s" }])?.kind).toBe("start");
    expect(baselineCheck([{ kind: "build", command: "b" }])).toBeNull();
    expect(baselineCheck([])).toBeNull();
  });

  test("durations and limits read naturally", () => {
    expect(formatDuration(480)).toBe("480 ms");
    expect(formatDuration(1500)).toBe("1.5 s");
    expect(formatDuration(null)).toBe("unknown time");
    expect(describeLimits({ memoryMb: 512, cpus: 1, pids: 256, timeoutSec: 120, network: "none" })).toBe("network off · 512 MB · 1 CPU · 120 s limit");
    expect(describeLimits(null)).toBe("limits not recorded");
    expect(Object.keys(CHECK_STATUS).sort()).toEqual(["failed", "passed", "timed_out", "unrunnable"]);
  });
});

describe("import helpers", () => {
  test("formatBytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(50 * 1024)).toBe("50 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(-1)).toBe("unknown size");
    expect(formatBytes(NaN)).toBe("unknown size");
  });

  test("formatWhen", () => {
    const now = 1_800_000_000_000;
    expect(formatWhen(now - 10_000, now)).toBe("just now");
    expect(formatWhen(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatWhen(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(formatWhen(now - 2 * 86_400_000, now)).toBe("2 d ago");
    expect(formatWhen(now - 30 * 86_400_000, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("checkChosenFile: only a non-empty .zip within the limit passes", () => {
    expect(checkChosenFile({ name: "app.zip", size: 1000 }, 100)).toBeNull();
    expect(checkChosenFile({ name: "APP.ZIP", size: 1000 }, 100)).toBeNull();
    expect(checkChosenFile({ name: "app.zip", size: 100 * 1024 * 1024 }, 100)).toBeNull(); // exactly the limit
    for (const name of ["app.tar.gz", "app.zip.txt", "zip", "notes.txt", "app"]) expect(checkChosenFile({ name, size: 10 }, 100)?.title, name).toBe("That isn't a zip archive");
    expect(checkChosenFile({ name: "e.zip", size: 0 }, 100)?.title).toBe("That file is empty");
    const big = checkChosenFile({ name: "big.zip", size: 100 * 1024 * 1024 + 1 }, 100);
    expect(big?.title).toBe("Too large for this build");
    expect(big?.body).toContain("100 MB");
  });

  test("describeImportError turns each failure into a title and a sentence", () => {
    const e = (code: string, message = "server words", fields?: Record<string, string>) => describeImportError(new ApiError(code, 400, message, "req_1", fields));
    expect(e("TOO_LARGE", "This project is larger than the 300 MB limit.")).toEqual({ title: "Too large for this build", body: "This project is larger than the 300 MB limit." });
    expect(e("UNSUPPORTED_PROJECT", "No package.json found.")).toEqual({ title: "Not a Node.js project", body: "No package.json found." });
    expect(e("UNSAFE_ARCHIVE").title).toBe("Unsafe archive");
    expect(e("UNSAFE_ARCHIVE").body).toContain("Nothing was imported");
    expect(e("VALIDATION_FAILED", "Some fields are invalid.", { path: "Must be a relative path." })).toEqual({ title: "Can't use that", body: "Must be a relative path." });
    expect(e("VALIDATION_FAILED", "Request failed.").body).toBe("Request failed.");
    expect(e("NOT_FOUND", "We couldn't find that folder.").title).toBe("Not found");
    expect(e("NETWORK_ERROR").title).toBe("Can't reach Revenant");
    expect(e("UNAUTHORIZED").title).toBe("Session ended");
    expect(e("SOMETHING_NEW", "odd").title).toBe("Import failed");
    expect(describeImportError(new Error("secret internals /Users/me"))).toEqual({ title: "Import failed", body: "Something unexpected went wrong. Try again." });
    expect(describeImportError("a string")).toEqual({ title: "Import failed", body: "Something unexpected went wrong. Try again." });
  });
});

describe("import page parts", () => {
  test("the error box is an alert with the title and the body", () => {
    const out = html(<ImportErrorBox problem={{ title: "Unsafe archive", body: "Nothing was imported." }} />);
    expect(out).toContain('role="alert"');
    expect(out).toContain("Unsafe archive");
    expect(out).toContain("Nothing was imported.");
  });

  test("the selection card shows the file and promises nothing was executed; names are text", () => {
    const out = html(<SelectionCard name={"<img src=x onerror=alert(1)>.zip"} size={2048} />);
    expect(out).toContain("Nothing has been executed. Importing only reads files.");
    expect(out).toContain("2.0 KB");
    expect(out).not.toContain("<img");
  });

  test("sample cards: loading, empty, a list that can be disabled while an import runs", () => {
    expect(html(<SampleCards samples={null} busy={false} onPick={() => {}} />)).toContain("Looking for samples");
    expect(html(<SampleCards samples={[]} busy={false} onPick={() => {}} />)).toContain("No sample projects are installed");
    const samples = [{ id: "a", name: "Alpha", description: "First <b>one</b>" }];
    const out = html(<SampleCards samples={samples} busy={false} onPick={() => {}} />);
    expect(out).toContain("Alpha");
    expect(out).toContain("Load sample");
    expect(out).not.toContain("<b>one</b>");
    expect(html(<SampleCards samples={samples} busy onPick={() => {}} />)).toMatch(/<button[^>]*disabled/);
  });

  test("recent investigations: loading, the empty message, and rows that link to the case with stage and verdict", () => {
    expect(html(<RecentInvestigations cases={null} />)).toContain("Loading");
    expect(html(<RecentInvestigations cases={[]} />)).toContain("No cases on this machine yet.");
    const now = 1_800_000_000_000;
    const out = html(
      <RecentInvestigations
        now={now}
        cases={[
          { id: "abc", name: "first", stage: "verified", verdict: "resurrected", updatedAt: now - 60_000 },
          { id: "def", name: "<script>x</script>", stage: "imported", verdict: null, updatedAt: now - 3 * 3_600_000 },
        ]}
      />,
    );
    expect(out).toContain('href="/cases/abc"');
    expect(out).toContain('href="/cases/def"');
    expect(out).toContain("Verified");
    expect(out).toContain("Resurrected");
    expect(out).toContain("Imported");
    expect(out).toContain("3 h ago");
    expect(out).not.toContain("<script>");
  });
});

describe("CheckRunCard", () => {
  test("a failed run shows the command, status, exit code, time, limits and the exact output as text", () => {
    const out = html(<CheckRunCard run={run({ outputExcerpt: "Error [ERR_REQUIRE_ASYNC_MODULE]: <b>bad</b>" })} />);
    expect(out).toContain("npm test");
    expect(out).toContain("Failed");
    expect(out).toContain("Original project");
    expect(out).toContain(">1<");
    expect(out).toContain("480 ms");
    expect(out).toContain("network off · 512 MB · 1 CPU · 120 s limit");
    expect(out).toContain("ERR_REQUIRE_ASYNC_MODULE");
    expect(out).toContain("&lt;b&gt;bad&lt;/b&gt;");
    expect(out).not.toContain("<b>bad</b>");
  });

  test("a passed run, and the repaired copy wording", () => {
    const out = html(<CheckRunCard run={run({ status: "passed", exitCode: 0, target: "working", phase: "after" })} />);
    expect(out).toContain("Passed");
    expect(out).toContain("Repaired copy");
  });

  test("a run that could not run explains why in plain words and never looks like a pass or a failure", () => {
    const out = html(<CheckRunCard run={run({ status: "unrunnable", unrunnableReason: "docker_not_running", exitCode: null, outputExcerpt: null, durationMs: null })} />);
    expect(out).toContain("Could not run");
    expect(out).toContain("Docker is installed but not running");
    expect(out).toContain("none");
    expect(out).not.toContain("Check output");
    expect(out).not.toContain(">Passed<");
  });

  test("a run cut by the output cap says so", () => {
    expect(html(<CheckRunCard run={run({ outputExcerpt: "x\n…[output truncated at 64 KB]" })} />)).toContain("cut at 64 KB");
  });
});

describe("AiPanel", () => {
  test("ready: shows the model and that nothing leaves the machine", () => {
    const out = html(<AiPanel detail={detail()} health={healthy} />);
    expect(out).toContain("gemma2:2b · Local AI ready");
    expect(out).toContain("Your code is not sent anywhere else.");
    expect(out).toContain("Idle.");
  });

  test("offline or missing model: says diagnosis is paused and that it will not guess", () => {
    for (const ollama of [{ reachable: false, modelInstalled: false, model: "m" }, { reachable: true, modelInstalled: false, model: "m" }]) {
      const out = html(<AiPanel detail={detail()} health={{ ...healthy, ollama }} />);
      expect(out).toContain("paused");
      expect(out).toContain("won&#x27;t guess a cause");
    }
    expect(html(<AiPanel detail={detail()} health={null} />)).toContain("Checking…");
  });

  test("the current activity follows the running job", () => {
    const activeJob = makeJob({ steps: [{ label: "Running the check in the sandbox", state: "running" }] });
    expect(html(<AiPanel detail={detail({ activeJob })} health={healthy} />)).toContain("Running the check in the sandbox");
  });

  test("a finding gets a label from the checks, and no confidence number is ever shown", () => {
    const out = html(<AiPanel detail={detail({ latestFinding: makeFinding() })} health={healthy} />);
    expect(out).toContain("Check passed");
    expect(out).toContain("never from the model&#x27;s own confidence");
    expect(out).not.toMatch(/\d+\s?%|confidence score/i);
  });
});

describe("Explorer", () => {
  const files: FilesResponse = {
    entries: [{ path: "src", type: "dir" }, { path: "src/index.js", type: "file", sizeBytes: 5 }, { path: "node_modules", type: "dir", collapsed: true, fileCount: 7 }, { path: "package.json", type: "file", sizeBytes: 1 }],
    fileCount: 2, truncated: false, project: project({ dependencies: { chalk: "^5.0.0" }, devDependencies: { vitest: "^1.0.0" } }),
  };

  test("shows the project, stage, the files, node_modules as one line, and the dependencies with versions", () => {
    const out = html(<Explorer detail={detail({ stage: "diagnosed" })} files={files} selected="src/index.js" onSelect={() => {}} />);
    expect(out).toContain("demo");
    expect(out).toContain("v1.2.3");
    expect(out).toContain("Diagnosed");
    expect(out).toContain("index.js");
    expect(out).toContain("package.json");
    expect(out).toContain("7 files");
    expect(out).toContain("chalk");
    expect(out).toContain("vitest");
    expect(out).toContain('aria-current="true"'); // the open file
    expect(out).toContain("None yet.");
  });

  test("while files are loading it says so, and the stage bar fills up to the current stage", () => {
    const out = html(<Explorer detail={detail({ stage: "patched" })} files={null} selected={null} onSelect={() => {}} />);
    expect(out).toContain("Loading…");
    expect((out.match(/bg-accent/g) ?? []).length).toBe(4); // imported, analyzed, diagnosed, patched
  });

  test("file and dependency names are text", () => {
    const evil: FilesResponse = { ...files, entries: [{ path: "<img src=x>.js", type: "file", sizeBytes: 1 }], project: project({ dependencies: { "<script>": "1" } }) };
    const out = html(<Explorer detail={detail()} files={evil} selected={null} onSelect={() => {}} />);
    expect(out).not.toMatch(/<img|<script/);
  });
});

describe("InspectPanel (the consent gate)", () => {
  const panel = (over: { detail?: Partial<CaseDetail>; project?: Project | null; health?: Health | null } = {}) =>
    html(<InspectPanel detail={detail(over.detail)} project={over.project === undefined ? project() : over.project} health={over.health === undefined ? healthy : over.health} onChanged={() => {}} />);

  test("the consent box starts unticked and Run is disabled until it is", () => {
    const out = panel();
    expect(out).toContain('type="checkbox"');
    expect(out).not.toMatch(/<input[^>]*checked/);
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Run the check/);
    expect(out).toContain("npm test");
    expect(out).toContain("Nothing runs until you allow it");
    expect(out).toContain("The tick resets after every run.");
  });

  test("a project with nothing to run says so and offers no button", () => {
    const out = panel({ project: project({ availableChecks: [{ kind: "build", command: "npm run build" }] }) });
    expect(out).toContain("no test or start script");
    expect(out).not.toContain("Run the check");
  });

  test("while the project is still being read there is no run button yet", () => {
    const out = panel({ project: null });
    expect(out).toContain("Reading the project");
    expect(out).not.toContain("Run the check");
  });

  test("Docker being down is explained before the run, not after", () => {
    const out = panel({ health: { ...healthy, docker: { available: false, imagePresent: false, image: "node:lts-slim" } } });
    expect(out).toContain("Docker isn&#x27;t available right now");
  });

  test("an active job disables Run and shows progress", () => {
    const out = panel({ detail: { activeJob: makeJob() } });
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Running…/);
    expect(out).toContain("Starting…");
  });

  test("a passing baseline with no finding of a fault is shown as 'No failure found', with its recorded run", () => {
    const finding = makeFinding({ explanation: "The check passed. That does not mean the project is free of problems." });
    const out = panel({ detail: { latestFinding: finding, checkRuns: [run({ status: "passed", exitCode: 0 })] } });
    expect(out).toContain("No failure found");
    expect(out).toContain("does not mean the project is free of problems");
    expect(out).toContain("Recorded runs");
    expect(out).toContain("Passed");
  });

  test("recorded runs are listed newest first, and only baseline runs belong to this panel", () => {
    const out = panel({ detail: { checkRuns: [run({ id: "old", commandLabel: "npm test", startedAt: 1 }), run({ id: "new", commandLabel: "npm start", checkKind: "start", startedAt: 2 }), run({ id: "after", commandLabel: "npm run build", phase: "after", patchId: "p" })] } });
    expect(out.indexOf("npm start")).toBeLessThan(out.lastIndexOf("npm test"));
    expect(out).not.toContain("npm run build</code>");
  });
});

describe("class names are never assembled from pieces (Tailwind could not see them)", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? files(full) : [full];
    });
  const sources = [...files("src/app"), ...files("src/components")].filter((f) => f.endsWith(".tsx"));

  test("no template literal glues a value onto a class token", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      for (const [, body] of readFileSync(file, "utf8").matchAll(/className=\{`([^`]*)`\}/g)) {
        // `${x}flex` or `min-${x}` style assembly: an interpolation touching a letter, digit, dash, colon or bracket
        if (/\$\{[^}]+\}[A-Za-z0-9\[\-:]/.test(body) || /[A-Za-z0-9\]\-:]\$\{/.test(body)) offenders.push(`${file}: ${body.slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
