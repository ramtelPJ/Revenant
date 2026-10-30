"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { useHealth } from "@/lib/hooks";
import { checkChosenFile, describeImportError, type ImportProblem } from "@/lib/import-ui";
import { TopBar } from "../brand";
import { ImportErrorBox, RecentInvestigations, SampleCards, SelectionCard, type RecentCase, type SampleInfo } from "./import-parts";

const H = "mb-3 font-mono text-[0.8rem] uppercase tracking-[0.12em] text-muted";
const FIELD = "w-full border border-line bg-raised px-3 py-2.5 font-mono text-sm text-fg";

/** Three ways in: a shipped sample, a folder on this machine, or a zip. Importing only reads files; nothing runs. */
export function ImportPage() {
  const router = useRouter();
  const { health } = useHealth(true);
  const maxArchiveMb = health?.limits?.maxArchiveMb ?? 100;

  const [samples, setSamples] = useState<SampleInfo[] | null>(null);
  const [recent, setRecent] = useState<RecentCase[] | null>(null);
  const [folder, setFolder] = useState("");
  const [archive, setArchive] = useState<File | null>(null);
  const [problem, setProblem] = useState<ImportProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    apiFetch<SampleInfo[]>("/api/samples").then((s) => alive && setSamples(s), () => alive && setSamples([]));
    apiFetch<RecentCase[]>("/api/cases").then((c) => alive && setRecent(c), () => alive && setRecent([]));
    return () => {
      alive = false;
    };
  }, []);

  const deleteCase = async (c: RecentCase) => {
    if (!window.confirm(`Delete "${c.name}" and all its results from this machine? This can't be undone.`)) return;
    try {
      await apiFetch(`/api/cases/${c.id}`, { method: "DELETE" });
      setRecent((list) => list?.filter((x) => x.id !== c.id) ?? null);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Couldn't delete that case.");
    }
  };

  const importCase = async (body: Record<string, unknown> | FormData) => {
    setBusy(true);
    setProblem(null);
    try {
      const { id } = await apiFetch<{ id: string }>("/api/cases", { method: "POST", body });
      router.push(`/cases/${id}`);
    } catch (e) {
      setProblem(describeImportError(e));
      setBusy(false);
    }
  };

  const choose = (file: File | undefined) => {
    setProblem(null);
    setArchive(null);
    if (!file) return;
    const found = checkChosenFile(file, maxArchiveMb);
    if (found) setProblem(found);
    else setArchive(file);
  };

  const uploadArchive = () => {
    if (!archive) return;
    const form = new FormData();
    form.append("archive", archive);
    void importCase(form);
  };

  return (
    <>
      <TopBar trail="new case" />
      <main id="main" className="mx-auto flex max-w-3xl flex-col gap-10 px-[clamp(16px,4vw,48px)] py-10">
        <header className="flex flex-col gap-2">
          <h1 className="display m-0 text-4xl leading-none">The graveyard</h1>
          <p className="m-0 text-muted">Choose a dead Node.js project to investigate. Importing only reads its files; nothing runs until you allow it.</p>
        </header>

        {problem && <ImportErrorBox problem={problem} />}

        <section aria-label="Samples">
          <div className={H}>Try a sample</div>
          <SampleCards samples={samples} busy={busy} onPick={(sampleId) => void importCase({ kind: "sample", sampleId })} />
        </section>

        <section aria-label="Open a folder">
          <div className={H}>Open a folder on this machine</div>
          <form
            className="flex flex-wrap gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void importCase({ kind: "folder", path: folder.trim() });
            }}
          >
            <label className="sr-only" htmlFor="folder-path">Absolute folder path</label>
            <input id="folder-path" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="/Users/you/projects/old-app" autoComplete="off" spellCheck={false} className={`${FIELD} min-w-0 flex-1`} />
            <button type="submit" disabled={busy || folder.trim() === ""} className="btn btn-secondary px-[18px] py-[11px]">Open folder</button>
          </form>
        </section>

        <section aria-label="Upload a zip">
          <div className={H}>Upload a zip (up to {maxArchiveMb} MB)</div>
          <div className="flex flex-col gap-3">
            <input ref={fileInput} type="file" accept=".zip,application/zip" aria-label="Zip archive" onChange={(e) => choose(e.target.files?.[0])} className="text-sm" />
            {archive && (
              <>
                <SelectionCard name={archive.name} size={archive.size} />
                <div>
                  <button type="button" disabled={busy} onClick={uploadArchive} className="btn btn-primary px-[18px] py-[11px]">{busy ? "Importing…" : "Import archive"}</button>
                </div>
              </>
            )}
          </div>
        </section>

        <section aria-label="Recent investigations">
          <div className={H}>Recent investigations</div>
          <RecentInvestigations cases={recent} onDelete={deleteCase} />
        </section>
      </main>
    </>
  );
}
