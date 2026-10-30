"use client";
import { useMemo, useState } from "react";
import { STAGE_ORDER, buildTree, extOf, visibleRows, type CaseDetail, type FilesResponse } from "@/lib/case-ui";
import { formatBytes, formatWhen } from "@/lib/import-ui";
import { STAGE_LABEL } from "@/lib/labels";

const H = "mb-2.5 font-mono text-[0.8rem] uppercase tracking-[0.12em] text-muted";

export function Explorer({ detail, files, selected, onSelect }: { detail: CaseDetail; files: FilesResponse | null; selected: string | null; onSelect: (path: string) => void }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => (files ? visibleRows(buildTree(files.entries), collapsed) : []), [files, collapsed]);
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const project = files?.project;
  const deps = project ? Object.entries({ ...project.dependencies, ...project.devDependencies }) : [];
  const finding = detail.latestFinding;
  const stageIndex = STAGE_ORDER.indexOf(detail.stage);

  return (
    <aside aria-label="Repository explorer" className="min-h-0 min-w-0 flex-1 overflow-y-auto border-r border-line bg-raised">
      <div className="flex flex-col gap-1 border-b border-line p-4">
        <div className="break-words text-lg font-semibold leading-snug">{detail.name}</div>
        <div className="font-mono text-xs text-muted">
          {project?.version ? `v${project.version} · ` : ""}Node.js · {formatBytes(detail.sizeBytes)}
        </div>
      </div>

      <div className="border-b border-line px-4 py-3.5">
        <div className={H}>Stage</div>
        <div className="grid grid-cols-5 gap-[3px]">
          {STAGE_ORDER.map((stage, i) => (
            <div key={stage} title={STAGE_LABEL[stage]} className={`h-1 ${i <= stageIndex ? "bg-accent" : "bg-line"}`} />
          ))}
        </div>
        <div className="mt-2 text-[0.8667rem]">{STAGE_LABEL[detail.stage]}</div>
      </div>

      <div className="border-b border-line pb-2 pt-3.5">
        <div className={`${H} px-4`}>Files</div>
        {!files && <p className="m-0 px-4 text-[0.8667rem] text-muted">Loading…</p>}
        <ul className="m-0 list-none p-0">
          {rows.map((row) => (
            <li key={row.path}>
              {row.kind === "modules" ? (
                <div className="flex min-h-[30px] items-center gap-1.5 pr-3 font-mono text-[0.8333rem] text-muted" style={{ paddingLeft: 12 + row.depth * 14 }}>
                  <span className="w-3 flex-none" />
                  <span className="w-[22px] flex-none" />
                  <span className="flex-none">{row.name}</span>
                  <span className="ml-auto flex-none text-[0.8rem]" title="Its contents are not listed">{row.fileCount?.toLocaleString()} files</span>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => (row.kind === "dir" ? toggle(row.path) : onSelect(row.path))}
                  aria-expanded={row.kind === "dir" ? row.expanded : undefined}
                  aria-current={row.path === selected ? "true" : undefined}
                  className={`flex min-h-[30px] w-full cursor-pointer [@media(pointer:coarse)]:min-h-11 items-center gap-1.5 border-0 pr-3 text-left font-mono text-[0.8333rem] text-fg hover:bg-surface ${row.path === selected ? "bg-surface" : "bg-transparent"}`}
                  style={{ paddingLeft: 12 + row.depth * 14 }}
                >
                  {row.kind === "dir" ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true" className={`flex-none text-muted transition-transform ${row.expanded ? "rotate-90" : ""}`}>
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  ) : (
                    <span className="w-3 flex-none" />
                  )}
                  {row.kind === "file" && <span className="w-[22px] flex-none text-[0.8rem] text-muted">{extOf(row.name)}</span>}
                  <span className="truncate">{row.name}{row.kind === "dir" ? "/" : ""}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
        {files?.truncated && <p className="m-0 px-4 pt-2 text-xs text-muted">Only the first files are listed.</p>}
      </div>

      <div className="border-b border-line px-4 py-3.5">
        <div className={H}>Dependencies</div>
        {deps.length === 0 ? (
          <p className="m-0 text-[0.8667rem] text-muted">{files ? "None declared." : "Loading…"}</p>
        ) : (
          deps.map(([name, version]) => (
            <div key={name} className="flex justify-between gap-3 py-1 font-mono text-xs">
              <span className="flex-none">{name}</span>
              <span className="min-w-0 truncate text-muted" title={version}>{version}</span>
            </div>
          ))
        )}
      </div>

      <div className="border-b border-line px-4 py-3.5">
        <div className={H}>Detected issues</div>
        {!finding && <p className="m-0 text-[0.8667rem] text-muted">None yet. Run the check to find out whether this project really fails.</p>}
        {finding && (
          <div className="flex items-start gap-2 text-[0.8667rem]">
            <span className={`mt-1.5 h-1.5 w-1.5 flex-none ${finding.label === "no_failure_found" ? "bg-ok" : "bg-bad"}`} />
            {finding.title}
          </div>
        )}
      </div>

      <div className="px-4 py-3.5">
        <div className={H}>History</div>
        <p className="m-0 text-[0.8667rem] text-muted">Opened {formatWhen(detail.createdAt)} from {detail.sourceKind === "sample" ? "a sample" : detail.sourceKind === "archive" ? "an archive" : "a folder"}.</p>
      </div>
    </aside>
  );
}
