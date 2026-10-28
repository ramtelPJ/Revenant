import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { OverviewPanel } from "@/components/lab/overview-panel";
import type { CaseDetail } from "@/lib/case-ui";
import { START_OLLAMA_FIX, pullModelFix } from "@/lib/fixes";
import type { Health } from "@/lib/health-problems";
import type { JobView } from "@/lib/polling";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

const summary = { purpose: "A tiny greeter.", how_to_run: "npm test", key_files: [{ path: "src/index.js", reason: "entry point" }, { path: "package.json", reason: "scripts" }] };
const detail = (over: Partial<CaseDetail> = {}): CaseDetail => ({
  id: "c1", name: "demo", sourceKind: "sample", sourceLabel: "demo", stage: "imported", sizeBytes: 1, fileCount: 1, verdict: null, verdictReason: null,
  createdAt: 1, updatedAt: 1, analysis: null, latestFinding: null, latestPatch: null, activeJob: null, checkRuns: [], ...over,
});
const analysis = (over: Partial<NonNullable<CaseDetail["analysis"]>> = {}) => ({ inventory: {}, summary, model: "gemma2:2b", createdAt: 1, ...over });
const job = (over: Partial<JobView> = {}): JobView => ({ id: "j1", caseId: "c1", kind: "analyze", status: "running", progressNote: null, steps: [], errorCode: null, errorMessage: null, createdAt: 1, startedAt: 1, finishedAt: null, ...over });
const healthy: Health = { ollama: { reachable: true, modelInstalled: true, model: "gemma2:2b" }, docker: { available: true, imagePresent: true, image: "node:lts-slim" } };
const panel = (d: CaseDetail, health: Health | null = healthy) => html(<OverviewPanel detail={d} health={health} onOpenFile={() => {}} onChanged={() => {}} />);

describe("OverviewPanel", () => {
  test("before any analysis: Start Investigation, and no summary text", () => {
    const out = panel(detail());
    expect(out).toMatch(/<button[^>]*>Start Investigation/);
    expect(out).not.toMatch(/<button[^>]*disabled/);
    expect(out).toContain("hasn&#x27;t written an overview");
  });

  test("the summary shows purpose, how to run, and key files that are buttons for the right path", () => {
    const out = panel(detail({ analysis: analysis() }));
    expect(out).toContain("A tiny greeter.");
    expect(out).toContain("npm test");
    expect(out).toContain('aria-label="Open src/index.js"');
    expect(out).toContain('aria-label="Open package.json"');
    expect(out).toContain("entry point");
    expect(out).toContain("gemma2:2b");
    expect(out).toMatch(/<button[^>]*>Re-run investigation/);
  });

  test("model text is rendered as text, never as markup", () => {
    const evil = { purpose: "<img src=x onerror=alert(1)>", how_to_run: "<script>x</script>", key_files: [{ path: "<b>a</b>.js", reason: "<i>why</i>" }] };
    const out = panel(detail({ analysis: analysis({ summary: evil }) }));
    expect(out).not.toMatch(/<img|<script|<b>|<i>/);
    expect(out).toContain("&lt;img");
  });

  test("an active job disables the button and shows progress", () => {
    const out = panel(detail({ activeJob: job() }));
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Investigating…/);
    expect(out).toContain("Starting…");
  });

  test("any active job (not only an analyze) blocks starting another step", () => {
    expect(panel(detail({ activeJob: job({ kind: "diagnose" }) }))).toMatch(/<button[^>]*disabled[^>]*>Investigating…/);
  });

  test("with the local AI down: restore steps from the health report, and no summary text", () => {
    const down: Health = { ...healthy, ollama: { reachable: false, modelInstalled: false, model: "gemma2:2b" } };
    const out = panel(detail(), down);
    expect(out).toContain("The local AI isn&#x27;t available. Start Ollama and pull the model.");
    expect(out).toContain("Start Ollama");
    expect(out).not.toContain("hasn&#x27;t written an overview");
    expect(out).toContain("Everything read from the project");
  });

  test("model missing names the exact pull command", () => {
    const missing: Health = { ...healthy, ollama: { reachable: true, modelInstalled: false, model: "qwen2.5-coder:3b" } };
    const out = panel(detail(), missing);
    expect(out).toContain("ollama pull qwen2.5-coder:3b");
    expect(out).not.toContain("Start Ollama (open");
    expect(pullModelFix("qwen2.5-coder:3b")).toContain("ollama pull qwen2.5-coder:3b");
    expect(START_OLLAMA_FIX).toContain("Start Ollama");
  });

  test("an existing summary stays visible even if the AI goes down later", () => {
    const down: Health = { ...healthy, ollama: { reachable: false, modelInstalled: false, model: "gemma2:2b" } };
    const out = panel(detail({ analysis: analysis() }), down);
    expect(out).toContain("A tiny greeter.");
    expect(out).not.toContain("isn&#x27;t available");
  });

  test("no health report yet: no restore message, the button still works", () => {
    const out = panel(detail(), null);
    expect(out).not.toContain("isn&#x27;t available");
    expect(out).toMatch(/<button[^>]*>Start Investigation/);
  });
});
