"use client";
import Link from "next/link";
import { useState } from "react";
import { baselineCheck, type CaseDetail, type FilesResponse } from "@/lib/case-ui";
import { formatBytes } from "@/lib/import-ui";
import { useCaseData, useFiles, useHealth } from "@/lib/hooks";
import { STAGE_LABEL } from "@/lib/labels";
import { Brand, TopBar } from "../brand";
import { AiPanel } from "./ai-panel";
import { Explorer } from "./explorer";
import { FileViewer } from "./file-viewer";
import { InspectPanel } from "./inspect-panel";
import { SettingsDialog } from "./settings-dialog";

type Panel = "files" | "center" | "ai";

// The later steps are separate pages that arrive with the model, patch and verification work. They are shown, but
// switched off, so the path through the product is visible without pretending it exists yet.
const STEPS = [
  { num: "01", label: "Overview", active: true },
  { num: "02", label: "Autopsy" },
  { num: "03", label: "Repair" },
  { num: "04", label: "Verification" },
];

export function LabPage({ caseId }: { caseId: string }) {
  const caseData = useCaseData(caseId);
  const files = useFiles(caseId);
  const { health } = useHealth(true);
  const [panel, setPanel] = useState<Panel>("center");
  const [selected, setSelected] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);

  if (caseData.error) {
    const missing = caseData.error.status === 404 || caseData.error.status === 400;
    return (
      <>
        <TopBar trail="case" />
        <main id="main" className="mx-auto max-w-xl px-4 py-16">
          <h1 className="display m-0 text-4xl leading-none">{missing ? "That case isn't here" : "Can't open this case"}</h1>
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
        <TopBar trail="case" />
        <main id="main" className="mx-auto max-w-xl px-4 py-16 text-muted">Opening the case…</main>
      </>
    );
  }

  const detail: CaseDetail = caseData.data;
  const filesData: FilesResponse | null = files.data;
  const ai = !health ? { text: "Checking…", dot: "bg-muted", tone: "text-muted" } : !health.ollama.reachable ? { text: "Model offline", dot: "bg-bad", tone: "text-bad" } : !health.ollama.modelInstalled ? { text: "Model missing", dot: "bg-warn", tone: "text-warn" } : { text: "Local AI ready", dot: "bg-ok", tone: "text-ok" };
  // class names are written out in full (never assembled from pieces) so Tailwind can see and generate them
  const show = (p: Panel) => (panel === p ? "flex min-[1100px]:flex" : "hidden min-[1100px]:flex");

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex flex-none flex-wrap items-center gap-4 border-b-2 border-line px-4 py-2.5">
        <Brand compact />
        <div className="flex min-w-0 items-center gap-2.5 border-l border-line pl-4 font-mono text-[13px]">
          <span className="truncate">{detail.name}</span>
          <span className="text-muted">·</span>
          <span className="flex-none text-muted">{STAGE_LABEL[detail.stage]}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div aria-live="polite" className="flex items-center gap-2 border border-line px-2.5 py-1.5 font-mono text-xs">
            <span className={`h-[7px] w-[7px] ${ai.dot}`} />
            <span className={ai.tone}>{ai.text}</span>
          </div>
          <button type="button" className="btn btn-secondary btn-icon" aria-label="Settings" onClick={() => setSettings(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M20 7h-9" /><path d="M14 17H5" /><circle cx="17" cy="17" r="3" /><circle cx="7" cy="7" r="3" />
            </svg>
          </button>
          <button type="button" className="btn btn-secondary" disabled title="Available once a verdict has been reached">Export Report</button>
        </div>
      </header>

      <div role="tablist" aria-label="Panels" className="grid flex-none grid-cols-3 border-b border-line min-[1100px]:hidden">
        {([["files", "Files"], ["center", "Investigation"], ["ai", "AI"]] as const).map(([id, label]) => (
          <button key={id} role="tab" type="button" aria-selected={panel === id} onClick={() => setPanel(id)} className={`min-h-11 cursor-pointer border-0 border-b-2 bg-transparent text-[13px] ${panel === id ? "border-accent text-fg" : "border-transparent text-muted"}`}>
            {label}
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 min-[1100px]:grid-cols-[280px_minmax(0,1fr)_320px]">
        <div className={`${show("files")} min-h-0 min-w-0 flex-col`}>
          <Explorer detail={detail} files={filesData} selected={selected} onSelect={(p) => { setSelected(p); setPanel("center"); }} />
        </div>

        <main id="main" className={`${show("center")} min-h-0 min-w-0 flex-col`}>
          <nav aria-label="Investigation steps" className="flex flex-none overflow-x-auto border-b border-line">
            <ul role="tablist" className="m-0 flex list-none p-0">
              {STEPS.map((step) => (
                <li key={step.label} role="presentation">
                  <span
                    role="tab"
                    aria-selected={step.active === true}
                    aria-disabled={step.active ? undefined : true}
                    title={step.active ? undefined : "Not available yet"}
                    className={`-mb-px flex min-h-[46px] items-center gap-2 whitespace-nowrap border-b-2 px-5 text-sm font-medium ${step.active ? "border-accent text-fg" : "border-transparent text-muted opacity-60"}`}
                  >
                    <span className="font-mono text-[11px] text-muted">{step.num}</span>
                    {step.label}
                  </span>
                </li>
              ))}
            </ul>
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex flex-col gap-6 p-[clamp(16px,2vw,28px)]">
              <Overview detail={detail} files={filesData} filesError={files.error?.message ?? null} />
              {selected && <FileViewer caseId={caseId} path={selected} onClose={() => setSelected(null)} />}
              <InspectPanel detail={detail} project={filesData?.project ?? null} health={health} onChanged={() => void caseData.reload()} />
            </div>
          </div>
        </main>

        <div className={`${show("ai")} min-h-0 min-w-0 flex-col`}>
          <AiPanel detail={detail} health={health} />
        </div>
      </div>

      {settings && <SettingsDialog health={health} onClose={() => setSettings(false)} />}
    </div>
  );
}

function Fact({ label, children, tone }: { label: string; children: React.ReactNode; tone?: string }) {
  return (
    <div className="border-l border-line px-4 py-3.5 first:border-l-0 first:pl-0">
      <div className="text-xs text-muted">{label}</div>
      <div className={`font-mono text-sm ${tone ?? ""}`}>{children}</div>
    </div>
  );
}

/** Facts read straight from the project's files. Nothing here comes from the model. */
function Overview({ detail, files, filesError }: { detail: CaseDetail; files: FilesResponse | null; filesError: string | null }) {
  const project = files?.project;
  const check = project ? baselineCheck(project.availableChecks) : null;
  const summary = detail.analysis?.summary;
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">Repository overview</div>
        <h2 className="display m-0 break-words text-[30px]">{detail.name}</h2>
      </div>

      {filesError && <p role="alert" className="m-0 text-sm text-bad">Couldn&apos;t read the project&apos;s files: {filesError}</p>}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] border-b border-t-2 border-b-line border-t-line">
        <Fact label="Files">{detail.fileCount.toLocaleString()} · {formatBytes(detail.sizeBytes)}</Fact>
        <Fact label="Dependencies">{project ? `${Object.keys(project.dependencies).length} + ${Object.keys(project.devDependencies).length} dev` : "…"}</Fact>
        <Fact label="Declared Node">{project ? (project.engines.node ?? "not declared") : "…"}</Fact>
        <Fact label="node_modules" tone={project ? (project.hasNodeModules ? "text-ok" : "text-warn") : undefined}>{project ? (project.hasNodeModules ? "included" : "not included") : "…"}</Fact>
      </div>

      {project && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-px bg-line">
          <div className="flex flex-col gap-2 bg-surface p-4">
            <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-accent">How it was meant to run</div>
            {Object.keys(project.scripts).length === 0 ? (
              <p className="m-0 text-sm text-muted">No scripts in package.json.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0 font-mono text-[13px]">
                {Object.entries(project.scripts).map(([name, command]) => (
                  <li key={name} className="flex gap-2"><span className="flex-none text-muted">npm run {name}</span><span className="truncate">{command}</span></li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-col gap-2 bg-surface p-4">
            <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-accent">Entry points</div>
            {project.entryPoints.length === 0 ? (
              <p className="m-0 text-sm text-muted">None declared.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0 font-mono text-[13px]">
                {project.entryPoints.map((entry) => (
                  <li key={`${entry.source}:${entry.path}`} className="flex items-center gap-2">
                    <span className="truncate">{entry.path}</span>
                    <span className="flex-none text-xs text-muted">({entry.source})</span>
                    {!entry.exists && <span className="tag tag-bad ml-auto flex-none">file missing</span>}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-1 text-[13px] text-muted">
              {check ? <>The check Revenant would run first: <code className="font-mono text-fg">{check.command}</code></> : "No test or start script to run."}
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2 border border-line bg-surface p-4">
        <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-accent">Purpose · AI summary</div>
        {summary?.purpose ? (
          <p className="m-0 text-sm leading-normal">{summary.purpose}</p>
        ) : (
          <p className="m-0 text-sm leading-normal text-muted">The local model hasn&apos;t written an overview of this project yet. Everything above was read directly from its files.</p>
        )}
      </div>
    </>
  );
}
