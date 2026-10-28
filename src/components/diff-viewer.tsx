import { parseUnifiedDiff, type DiffCell } from "@/lib/diff-ui";

const cell = (c: DiffCell, tone: string, mark = "") => (
  <>
    <td className="w-10 select-none border-r border-line px-2 text-right text-muted">{c?.line}</td>
    <td className={`whitespace-pre-wrap break-all px-2 ${tone}`}>{mark && c && <span className="select-none text-muted">{mark} </span>}{c?.text}</td>
  </>
);

/** A side-by-side view of a unified diff. Removed lines carry a "−" and added lines a "+", so colour is never the only signal. */
export function DiffViewer({ diffText }: { diffText: string }) {
  const files = parseUnifiedDiff(diffText);
  if (files.length === 0) return <p className="m-0 text-sm text-muted">This patch has no changes to show.</p>;
  return (
    <div className="flex flex-col gap-5">
      {files.map((file) => (
        <section key={file.path} aria-label={`Changes to ${file.path}`} className="border border-line bg-surface">
          <h3 className="m-0 border-b border-line px-3 py-2 font-mono text-xs text-muted">{file.path}</h3>
          <div className="overflow-x-auto">
            <table className="w-full table-fixed border-collapse font-mono text-xs leading-[1.7]">
              <caption className="sr-only">Old text on the left, new text on the right</caption>
              <tbody>
                {file.rows.map((row, i) =>
                  row.kind === "hunk" ? (
                    <tr key={i}><td colSpan={4} className="bg-raised px-2 text-muted">{row.text}</td></tr>
                  ) : (
                    <tr key={i}>
                      {cell(row.left, row.kind === "change" && row.left ? "bg-bad/15" : "", row.kind === "change" ? "−" : "")}
                      {cell(row.right, row.kind === "change" && row.right ? "bg-ok/15" : "", row.kind === "change" ? "+" : "")}
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
          <p className="m-0 border-t border-line px-3 py-1 text-[11px] text-muted">Left: before · Right: after. Removed lines are on the left, added lines on the right.</p>
        </section>
      ))}
    </div>
  );
}
