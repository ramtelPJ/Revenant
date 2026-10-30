// npm run eval -- --consent [--runs N] [--samples a,b] [--model tag]
//
// Runs every sample through the real product path (import, overview, diagnosis with a baseline run, patch proposal,
// approval, verification) against a private copy of the app on a spare port with a throwaway data folder, then
// compares the outcome with each sample's expected.json. Failures are reported as failures; nothing is skipped or
// retried. It needs `npm run build` once, Ollama with the model, and Docker with the sandbox image.
//
// Project code runs in the Docker sandbox, so you must pass --consent: that flag is the script's consent, and it is sent
// with every diagnose and verify request exactly as the app's own consent box would be.
//
// Exit code: 0 = ran (even if some repairs failed), 1 = the control check or the honesty check failed,
//            2 = could not run (no consent flag, no build, Ollama/Docker not ready, bad arguments).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// ---- arguments ---------------------------------------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const die = (message: string, code = 2): never => {
  console.error(message);
  process.exit(code);
};

if (flag("help")) die("npm run eval -- --consent [--runs N] [--samples a,b] [--model tag]", 0);
if (!flag("consent")) die("Eval runs each sample's code in the Docker sandbox. Pass --consent to allow that:\n  npm run eval -- --consent");
const runs = Number(option("runs") ?? "1");
if (!Number.isInteger(runs) || runs < 1 || runs > 10) die("--runs must be a whole number from 1 to 10.");
if (!existsSync(".next/BUILD_ID")) die("No production build found. Run `npm run build` first.");

const samplesRoot = path.resolve("samples");
const allSamples = readdirSync(samplesRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(path.join(samplesRoot, e.name, "expected.json")))
  .map((e) => e.name)
  .sort();
const wanted = option("samples")?.split(",").map((s) => s.trim()).filter(Boolean) ?? allSamples;
const unknown = wanted.filter((s) => !allSamples.includes(s));
if (unknown.length > 0) die(`Unknown sample(s): ${unknown.join(", ")}. Available: ${allSamples.join(", ")}`);

type Expected = { failingCheck: null } | { failingCheck: string; expectedCategory: string; expectedFile: string };
const expectedOf = (sample: string): Expected => JSON.parse(readFileSync(path.join(samplesRoot, sample, "expected.json"), "utf8"));

// ---- a private copy of the app -----------------------------------------------------------------------------------
const dataDir = mkdtempSync(path.join(os.tmpdir(), "revenant-eval-"));
let server: ChildProcess | null = null;

function cleanup() {
  server?.kill("SIGTERM");
  spawnSync("chmod", ["-R", "u+rwx", dataDir]); // imported projects are read-only
  rmSync(dataDir, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

async function startServer(): Promise<{ base: string; cookie: string }> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), DATA_DIR: dataDir };
  const model = option("model");
  if (model) env.OLLAMA_MODEL = model;
  server = spawn(process.execPath, ["scripts/launch.ts", "--no-open"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The app did not start.\n${log.slice(-400)}`)), 30_000);
    const onData = (chunk: Buffer) => {
      log += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:\d+\/unlock\?token=[0-9a-f]+/.exec(log);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };
    server!.stdout!.on("data", onData);
    server!.stderr!.on("data", (c: Buffer) => (log += c.toString()));
    server!.once("exit", () => reject(new Error(`The app stopped.\n${log.slice(-400)}`)));
  });
  const base = new URL(url).origin;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("revenant_session="));
      if (cookie) return { base, cookie };
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
  throw new Error("Could not unlock the app.");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- talking to the app ------------------------------------------------------------------------------------------
type Api = { base: string; cookie: string };
class StepError extends Error {
  stage: string;
  constructor(stage: string, message: string) {
    super(message);
    this.stage = stage;
  }
}
async function call(api: Api, method: "GET" | "POST", route: string, body?: unknown): Promise<{ status: number; data: any; error?: { code: string; message: string } }> {
  const res = await fetch(api.base + route, {
    method,
    headers: { cookie: api.cookie, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload: any = await res.json().catch(() => ({}));
  return { status: res.status, data: payload.data, error: payload.error };
}
async function must(stage: string, api: Api, method: "GET" | "POST", route: string, body?: unknown) {
  const res = await call(api, method, route, body);
  if (res.status >= 400) throw new StepError(stage, `${res.error?.code ?? res.status}: ${res.error?.message ?? "request failed"}`);
  return res.data;
}
async function job(stage: string, api: Api, jobId: string): Promise<any> {
  for (let i = 0; i < 150; i++) {
    const j = await must(stage, api, "GET", `/api/jobs/${jobId}`);
    if (j.status === "failed") throw new StepError(stage, `${j.errorCode}: ${j.errorMessage}`);
    if (j.status === "cancelled") throw new StepError(stage, "job cancelled");
    if (j.status === "succeeded") return j;
    await sleep(2000);
  }
  throw new StepError(stage, "job did not finish in 5 minutes");
}

// ---- one run of one sample ---------------------------------------------------------------------------------------
type Check = { phase: string; kind: string; status: string };
type Result = {
  sample: string;
  run: number;
  kind: "broken" | "control";
  stage: string; // the last stage reached
  failure: string | null; // why it stopped, in the app's words
  overviewFailure: string | null; // the optional overview step failed, but the run continued
  finding: { label: string; category: string | null; title: string; citedFiles: string[] } | null;
  categoryMatch: boolean | null;
  fileMatch: boolean | null;
  identified: boolean | null;
  patchFiles: string[];
  verdict: string | null;
  verdictReason: string | null;
  checks: Check[];
  controlHonest: boolean | null;
  falseResurrected: boolean;
  seconds: number;
};

async function evaluate(api: Api, sample: string, run: number): Promise<Result> {
  const expected = expectedOf(sample);
  const broken = expected.failingCheck !== null;
  const started = Date.now();
  const r: Result = {
    sample, run, kind: broken ? "broken" : "control", stage: "import", failure: null, overviewFailure: null, finding: null, categoryMatch: null, fileMatch: null, identified: null,
    patchFiles: [], verdict: null, verdictReason: null, checks: [], controlHonest: null, falseResurrected: false, seconds: 0,
  };
  let caseId = "";
  try {
    caseId = (await must("import", api, "POST", "/api/cases", { kind: "sample", sampleId: sample })).id;

    r.stage = "overview";
    try {
      await job("overview", api, (await must("overview", api, "POST", `/api/cases/${caseId}/analyze`)).jobId);
    } catch (error) {
      // the overview is a separate, optional step: the product diagnoses without it, so the run goes on and says so
      r.overviewFailure = error instanceof Error ? error.message : String(error);
    }

    r.stage = "diagnosis";
    await job("diagnosis", api, (await must("diagnosis", api, "POST", `/api/cases/${caseId}/diagnose`, { captureBaseline: true, consent: true })).jobId);
    const afterDiagnosis = await must("diagnosis", api, "GET", `/api/cases/${caseId}`);
    const f = afterDiagnosis.latestFinding;
    if (f) {
      const cited: string[] = (f.evidence as any[]).filter((e) => e.kind === "file").map((e) => String(e.path));
      r.finding = { label: f.label, category: f.category, title: f.title, citedFiles: [...new Set(cited)] };
    }

    if (!broken) {
      // the control must be reported as healthy, and there must be nothing to repair
      const proposal = await call(api, "POST", `/api/cases/${caseId}/patches`);
      r.controlHonest = r.finding?.label === "no_failure_found" && proposal.status === 409;
      if (!r.controlHonest) r.failure = r.finding ? `the control was labelled "${r.finding.label}"${proposal.status === 409 ? "" : " and a repair could be proposed"}` : "no finding was recorded for the control";
      r.stage = "done";
      return r;
    }

    const want = expected as { failingCheck: string; expectedCategory: string; expectedFile: string };
    r.categoryMatch = r.finding?.category === want.expectedCategory;
    r.fileMatch = r.finding?.citedFiles.includes(want.expectedFile) ?? false;
    r.identified = r.categoryMatch && r.fileMatch;
    if (!r.finding || r.finding.label === "no_failure_found") throw new StepError("diagnosis", "no failure was identified");

    r.stage = "patch";
    await job("patch", api, (await must("patch", api, "POST", `/api/cases/${caseId}/patches`)).jobId);
    const patches: any[] = await must("patch", api, "GET", `/api/cases/${caseId}/patches`);
    const patch = patches[0];
    if (!patch) throw new StepError("patch", "no patch was stored");
    r.patchFiles = patch.filesAffected.map(String);

    r.stage = "approval";
    await must("approval", api, "POST", `/api/cases/${caseId}/patches/${patch.id}/approve`);

    r.stage = "verification";
    await job("verification", api, (await must("verification", api, "POST", `/api/cases/${caseId}/verify`, { consent: true, checks: [want.failingCheck] })).jobId);
    r.stage = "done";
  } catch (error) {
    r.failure = error instanceof StepError ? `${error.stage}: ${error.message}` : `${r.stage}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (caseId) {
      const detail = (await call(api, "GET", `/api/cases/${caseId}`).catch(() => null))?.data;
      if (detail) {
        r.verdict = detail.verdict ?? null;
        r.verdictReason = detail.verdictReason ?? null;
        r.checks = detail.checkRuns.map((c: any) => ({ phase: c.phase, kind: c.checkKind, status: c.status }));
        r.falseResurrected = detail.verdict === "resurrected" && !resurrectionIsEarned(r.checks);
      }
    }
    r.seconds = Math.round((Date.now() - started) / 1000);
  }
  return r;
}

/** An independent reading of the stored runs: some check failed before and every after-run passed. */
function resurrectionIsEarned(checks: Check[]): boolean {
  const failedBefore = new Set(checks.filter((c) => c.phase === "baseline" && (c.status === "failed" || c.status === "timed_out")).map((c) => c.kind));
  const after = checks.filter((c) => c.phase === "after");
  return after.length > 0 && after.every((c) => c.status === "passed") && after.some((c) => failedBefore.has(c.kind));
}

// ---- report ------------------------------------------------------------------------------------------------------
const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${n} of ${d} (${Math.round((100 * n) / d)}%)`);
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

function report(results: Result[], model: string) {
  const broken = results.filter((r) => r.kind === "broken");
  const control = results.filter((r) => r.kind === "control");
  const identified = broken.filter((r) => r.identified).length;
  const repaired = broken.filter((r) => r.verdict === "resurrected").length;
  const controlOk = control.filter((r) => r.controlHonest).length;
  const falseRes = results.filter((r) => r.falseResurrected).length;

  console.log(`\nModel: ${model}   Runs per sample: ${runs}   Samples: ${wanted.join(", ")}\n`);
  console.log(`${pad("sample", 22)}${pad("run", 4)}${pad("identified", 22)}${pad("patch touches", 20)}${pad("verdict", 20)}note`);
  for (const r of results) {
    const id = r.kind === "control" ? "(control)" : r.identified === null ? "-" : `${r.identified ? "yes" : "NO"} (cat ${r.categoryMatch ? "ok" : "x"}, file ${r.fileMatch ? "ok" : "x"})`;
    const note = r.failure ?? ((r.kind === "control" ? "reported as healthy" : "") + (r.overviewFailure ? ` (overview failed: ${r.overviewFailure})` : ""));
    console.log(`${pad(r.sample, 22)}${pad(String(r.run), 4)}${pad(id, 22)}${pad(r.patchFiles.join(",") || "-", 20)}${pad(r.verdict ?? "-", 20)}${note}`);
  }
  console.log("\nMetrics (counts from this run only):");
  console.log(`  1. Identified the expected category and file : ${pct(identified, broken.length)}   (target: 4 of 5)`);
  console.log(`  2. Verified repair (verdict Resurrected)      : ${pct(repaired, broken.length)}   (target: 3 of 5)`);
  console.log(`  3. Control reported as no failure found       : ${pct(controlOk, control.length)}   (must be 100%)`);
  console.log(`  4. Resurrected without a passed check         : ${falseRes} of ${results.length}   (must be 0)`);
  return { identified, repaired, controlOk, controlTotal: control.length, brokenTotal: broken.length, falseRes };
}

// ---- main --------------------------------------------------------------------------------------------------------
let exitCode = 0;
try {
  const api = await startServer();
  const health = (await call(api, "GET", "/api/health")).data;
  if (!health?.ollama?.reachable || !health.ollama.modelInstalled) throw new Error(`The local model is not ready (${health?.ollama?.model ?? "unknown"}). Start Ollama and pull the model, then try again.`);
  if (!health.docker?.available || !health.docker.imagePresent) throw new Error(`Docker is not ready (image ${health?.docker?.image ?? "unknown"}). Start Docker and pull the image, then try again.`);
  const model: string = health.ollama.model;
  console.log(`Model ${model}, Docker ready. Running ${wanted.length} sample(s) x ${runs} run(s)...`);

  const results: Result[] = [];
  for (let run = 1; run <= runs; run++) {
    for (const sample of wanted) {
      process.stdout.write(`  ${sample} (run ${run}) ... `);
      const result = await evaluate(api, sample, run);
      results.push(result);
      console.log(result.failure ? `stopped at ${result.failure}` : `${result.verdict ?? "done"} in ${result.seconds}s`);
    }
  }

  const summary = report(results, model);
  const dataOut = path.resolve("data");
  mkdirSync(dataOut, { recursive: true });
  const file = path.join(dataOut, `eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), model, runsPerSample: runs, samples: wanted, summary, results }, null, 2));
  console.log(`\nResults written to ${path.relative(process.cwd(), file)}`);

  if (summary.controlOk < summary.controlTotal) {
    console.error("\nFAILED: a control project was not reported as healthy.");
    exitCode = 1;
  }
  if (summary.falseRes > 0) {
    console.error("\nFAILED: a case was marked Resurrected without a failed-then-passed check.");
    exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 2;
} finally {
  cleanup();
}
process.exit(exitCode);
