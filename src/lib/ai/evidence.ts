import { readTextFile } from "@/lib/cases/files";
import { AppError } from "@/lib/http/respond";
import { isSecretLike } from "./context";
import type { Evidence } from "./schemas";

// The model says where it saw something; this module checks that it really is there. Anything it cannot prove is
// dropped, so what reaches the screen and the label (label.ts) rests on real files and real output only.

export type TextSource = { id?: string; text: string };
export type EvidenceSources = {
  projectDir: string;
  /** Logs the user pasted. */
  logs: TextSource[];
  /** Output of checks run in the sandbox; `id` is the check_runs row. */
  outputs: TextSource[];
};
export type VerifiedEvidence =
  | { kind: "file"; path: string; startLine: number; endLine: number; quote: string }
  | { kind: "log"; excerpt: string; origin: "log" | "check"; checkRunId?: string };
export type VerifyResult = { verified: VerifiedEvidence[]; dropped: number };

const MIN_QUOTE = 3;
const MAX_RANGE_LINES = 60; // a citation must point at something, not at a whole file

/** Collapses every run of whitespace, so indentation and line breaks do not make a true quote fail. */
export const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

function verifyFile(item: Evidence, projectDir: string): VerifiedEvidence | null {
  const quote = normalize(item.quote ?? "");
  if (!item.path || quote.length < MIN_QUOTE) return null;
  const rel = item.path.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/app\//, "");
  if (isSecretLike(rel) || rel.split("/").includes("node_modules")) return null;
  let file;
  try {
    file = readTextFile(projectDir, rel);
  } catch (error) {
    if (error instanceof AppError) return null; // missing, outside the project, binary, too big
    throw error;
  }
  const lines = file.content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  if (item.startLine === undefined) {
    // no lines given: find the first line (or pair of lines) holding the quote
    for (const width of [1, 2, 3]) {
      for (let i = 0; i < lines.length; i++) {
        const end = Math.min(lines.length, i + width);
        if (normalize(lines.slice(i, end).join("\n")).includes(quote)) return { kind: "file", path: rel, startLine: i + 1, endLine: end, quote };
      }
    }
    return null;
  }
  const start = item.startLine;
  const end = item.endLine ?? start;
  if (end < start || end > lines.length || end - start + 1 > MAX_RANGE_LINES) return null;
  return normalize(lines.slice(start - 1, end).join("\n")).includes(quote) ? { kind: "file", path: rel, startLine: start, endLine: end, quote } : null;
}

function verifyLog(item: Evidence, sources: EvidenceSources): VerifiedEvidence | null {
  const excerpt = normalize(item.excerpt ?? item.quote ?? "");
  if (excerpt.length < MIN_QUOTE) return null;
  const fromCheck = sources.outputs.find((s) => normalize(s.text).includes(excerpt));
  if (fromCheck) return { kind: "log", excerpt, origin: "check", checkRunId: fromCheck.id };
  return sources.logs.some((s) => normalize(s.text).includes(excerpt)) ? { kind: "log", excerpt, origin: "log" } : null;
}

/** Keeps only citations that can be found, drops the rest and counts them. Duplicates are dropped silently. */
export function verifyEvidence(items: Evidence[], sources: EvidenceSources): VerifyResult {
  const verified: VerifiedEvidence[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const item of items) {
    const result = item.kind === "file" ? verifyFile(item, sources.projectDir) : verifyLog(item, sources);
    if (!result) {
      dropped++;
      continue;
    }
    const key = JSON.stringify(result);
    if (!seen.has(key)) {
      seen.add(key);
      verified.push(result);
    }
  }
  return { verified, dropped };
}
