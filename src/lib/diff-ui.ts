// Turns the stored unified diff into rows for a side-by-side view. Nothing here is HTML: every `text` is shown as a text node.

export type DiffCell = { line: number; text: string } | null;
export type DiffRow = { kind: "hunk"; text: string } | { kind: "ctx" | "change"; left: DiffCell; right: DiffCell };
export type DiffFile = { path: string; rows: DiffRow[] };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parses the output of `createTwoFilesPatch` (a/ and b/ paths). Unknown lines are ignored, never thrown on. */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  let dels: DiffCell[] = [];
  let adds: DiffCell[] = [];

  const flush = () => {
    if (!file) return;
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) file.rows.push({ kind: "change", left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };

  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("--- ")) {
      flush();
      continue; // the path comes from the +++ line
    }
    if (line.startsWith("+++ ")) {
      file = { path: line.slice(4).replace(/^b\//, "").replace(/\t.*$/, ""), rows: [] };
      files.push(file);
      continue;
    }
    if (!file) continue;
    const hunk = HUNK.exec(line);
    if (hunk) {
      flush();
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      file.rows.push({ kind: "hunk", text: line });
    } else if (line.startsWith("-")) dels.push({ line: oldNo++, text: line.slice(1) });
    else if (line.startsWith("+")) adds.push({ line: newNo++, text: line.slice(1) });
    else if (line.startsWith(" ")) {
      flush();
      file.rows.push({ kind: "ctx", left: { line: oldNo++, text: line.slice(1) }, right: { line: newNo++, text: line.slice(1) } });
    }
  }
  flush();
  return files;
}
