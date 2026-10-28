import { readTextFile } from "@/lib/cases/files";
import { AppError } from "@/lib/http/respond";
import { extractFileRefs } from "./context";
import { isSecretLike } from "./context";
import type { Evidence } from "./schemas";
import type { EvidenceSources } from "./evidence";

const MAX_CANDIDATES = 12;
const MAX_LINE = 240;
const ERROR_LINE = /\b(error|cannot|can't|failed|failure|not found|not a function|undefined|unexpected|refused|denied|ERR_[A-Z_]+|ENOENT|EACCES)\b/i;

/**
 * Pieces of evidence the model may point at, numbered from 1 by position. Built from real output and real files, so
 * every one is true; the model only chooses which ones explain the failure. Files named in a trace come first, then error lines.
 */
export function buildCandidates(sources: EvidenceSources): Evidence[] {
  const out: Evidence[] = [];
  const seen = new Set<string>();
  const add = (item: Evidence) => {
    const key = JSON.stringify(item);
    if (out.length < MAX_CANDIDATES && !seen.has(key)) (seen.add(key), out.push(item));
  };

  for (const source of [...sources.outputs, ...sources.logs]) {
    const lines = source.text.split("\n").map((l) => l.trim());
    for (const line of lines.filter((l) => l.length >= 8 && ERROR_LINE.test(l)).slice(0, 4)) add({ kind: "log", excerpt: line.slice(0, MAX_LINE) });
    // packages the output talks about (node_modules/<name>/...): a file that names one is likely where it is used
    const packages = [...source.text.matchAll(/node_modules\/((?:@[\w.-]+\/)?[\w.-]+)/g)].map((m) => m[1]);
    for (const ref of extractFileRefs(source.text, sources.projectDir)) {
      if (!ref.rel || isSecretLike(ref.rel) || ref.rel.split("/").includes("node_modules")) continue;
      try {
        const fileLines = readTextFile(sources.projectDir, ref.rel).content.split("\n");
        // a trace gives the line; a plain "Require stack" does not, so look for the line that mentions a package from the output
        const line = ref.line ?? fileLines.findIndex((l) => packages.some((p) => l.includes(p))) + 1;
        const text = fileLines[line - 1]?.trim();
        if (line >= 1 && text && text.length >= 3) add({ kind: "file", path: ref.rel, startLine: line, endLine: line, quote: text.slice(0, MAX_LINE) });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
      }
    }
  }
  // files first: a small model leans toward the first entries, and the code a trace points at is the most useful citation
  return [...out.filter((e) => e.kind === "file"), ...out.filter((e) => e.kind === "log")];
}

/** The candidates as numbered text for the prompt. */
export const describeCandidates = (items: Evidence[]) =>
  items.map((e, i) => (e.kind === "file" ? `[${i + 1}] file ${e.path} line ${e.startLine}: ${e.quote}` : `[${i + 1}] output: ${e.excerpt}`)).join("\n");
