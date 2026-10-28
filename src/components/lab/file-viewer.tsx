"use client";
import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "@/lib/api-client";

type Loaded = { path: string; content: string; lineCount: number } | { path: string; error: string };

/** Shows one project file as text with line numbers. Errors (binary, too large) come from the server in plain words. */
export function FileViewer({ caseId, path, onClose }: { caseId: string; path: string; onClose: () => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let alive = true;
    apiFetch<{ path: string; content: string; lineCount: number }>(`/api/cases/${caseId}/files/content?path=${encodeURIComponent(path)}`).then(
      (file) => alive && setLoaded({ path, content: file.content, lineCount: file.lineCount }),
      (e: unknown) => alive && setLoaded({ path, error: e instanceof ApiError ? e.message : "Couldn't read that file." }),
    );
    return () => {
      alive = false;
    };
  }, [caseId, path]);

  const current = loaded && loaded.path === path ? loaded : null; // a late answer for a previous file is ignored
  return (
    <section aria-label="File viewer" className="border border-line bg-raised">
      <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted">File</span>
        <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{path}</code>
        <button type="button" onClick={onClose} className="btn btn-ghost" aria-label={`Close ${path}`}>Close</button>
      </header>
      {!current && <p className="m-0 px-4 py-3 text-sm text-muted">Loading…</p>}
      {current && "error" in current && <p role="alert" className="m-0 px-4 py-3 text-sm text-bad">{current.error}</p>}
      {current && "content" in current && (
        <div className="flex max-h-[420px] overflow-auto font-mono text-xs leading-[1.7]">
          <pre aria-hidden="true" className="m-0 select-none border-r border-line px-3 py-3 text-right text-muted">
            {Array.from({ length: Math.max(current.lineCount, 1) }, (_, i) => i + 1).join("\n")}
          </pre>
          <pre tabIndex={0} aria-label={`Contents of ${path}`} className="m-0 min-w-0 flex-1 px-3 py-3 text-fg">
            {current.content === "" ? "(empty file)" : current.content}
          </pre>
        </div>
      )}
    </section>
  );
}
