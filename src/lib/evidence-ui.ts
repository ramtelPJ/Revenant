// The evidence of a finding as stored (verified items only), turned into what the autopsy page draws.

export type ShownEvidence =
  | { kind: "file"; path: string; startLine: number; endLine: number; quote: string }
  | { kind: "log"; excerpt: string; origin: "log" | "check" }
  | { kind: "check"; checkRunId: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isLine = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

/** Keeps only well-formed items; anything else in a damaged row is ignored rather than drawn. */
export function parseEvidence(items: unknown[]): ShownEvidence[] {
  const shown: ShownEvidence[] = [];
  for (const item of items) {
    if (!isObject(item)) continue;
    if (item.kind === "file" && typeof item.path === "string" && typeof item.quote === "string" && isLine(item.startLine)) {
      shown.push({ kind: "file", path: item.path, startLine: item.startLine, endLine: isLine(item.endLine) ? item.endLine : item.startLine, quote: item.quote });
    } else if (item.kind === "log" && typeof item.excerpt === "string") {
      shown.push({ kind: "log", excerpt: item.excerpt, origin: item.origin === "check" ? "check" : "log" });
    } else if (item.kind === "check" && typeof item.checkRunId === "string") {
      shown.push({ kind: "check", checkRunId: item.checkRunId });
    }
  }
  return shown;
}

/** "2 of 5 citations could not be verified and were left out.", or null when nothing was dropped. */
export function droppedNote(dropped: number, items: ShownEvidence[]): string | null {
  if (!(dropped > 0)) return null;
  const total = items.filter((e) => e.kind !== "check").length + dropped;
  return `${dropped} of ${total} citation${total === 1 ? "" : "s"} could not be verified and ${dropped === 1 ? "was" : "were"} left out.`;
}

/** The first cited file, for the "View Source" action. */
export const firstFile = (items: ShownEvidence[]): string | null => items.find((e): e is Extract<ShownEvidence, { kind: "file" }> => e.kind === "file")?.path ?? null;

export const lineRange = (e: { startLine: number; endLine: number }) => (e.endLine > e.startLine ? `lines ${e.startLine}–${e.endLine}` : `line ${e.startLine}`);

/** Where the case page opens a file. The path is encoded, so it can never alter the URL. */
export const sourceHref = (caseId: string, path: string) => `/cases/${caseId}?file=${encodeURIComponent(path)}`;
