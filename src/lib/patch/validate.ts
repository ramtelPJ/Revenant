import { readTextFile, resolveInFolder } from "@/lib/cases/files";
import { AppError } from "@/lib/http/respond";
import { changedLines, type FileChange } from "./diff";

// Edits come from a small local model, so they are accepted only if they are small, exact and safe. Every message
// names the rule that was broken, because the same text is fed back to the model for its one retry.

export type Edit = { path: string; search: string; replace: string };
export const PATCH_LIMITS = { files: 3, edits: 5, changedLines: 60 } as const;

export type PatchValidation = { ok: true; changes: FileChange[]; changedLines: number } | { ok: false; errors: string[] };

const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"]);

/** The path as the model may have written it (`./a.js`, `/app/a.js`, backslashes) in the form used inside the project. */
export const normalizeEditPath = (value: string) => value.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/app\//, "");

function exactlyOnce(text: string, search: string): number | "none" | "many" {
  const first = text.indexOf(search);
  if (first === -1) return "none";
  return text.indexOf(search, first + 1) === -1 ? first : "many"; // overlapping matches count as ambiguous too
}

/** A file with Windows line endings: the model writes `\n`, so match and replace with the file's own endings. */
const withFileEndings = (content: string, text: string) => (content.includes("\r\n") && !text.includes("\r") ? text.replace(/\n/g, "\r\n") : text);

/** Why a path cannot be edited, or the file's text. Reads the original only; nothing is ever written. */
function load(projectDir: string, rel: string): { content: string } | string {
  const segments = rel.split("/");
  if (segments.some((s) => s === "node_modules" || s === ".git")) return `${rel}: files inside node_modules or .git must not be edited.`;
  if (LOCKFILES.has(segments[segments.length - 1])) return `${rel}: lockfiles must not be edited.`;
  try {
    resolveInFolder(projectDir, rel, { forEdit: true });
    return { content: readTextFile(projectDir, rel).content };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.code === "NOT_FOUND") return `${rel}: the file does not exist in the project. Only existing files can be edited.`;
    if (error.code === "UNSUPPORTED_FILE") return `${rel}: this is a binary file, only text files can be edited.`;
    if (error.code === "TOO_LARGE") return `${rel}: the file is too large to edit.`;
    return `${rel}: the path must be a relative path to a file inside the project (no "..", no absolute path).`;
  }
}

/**
 * Checks a list of edits against the original project and, if they are all fine, returns the changed files.
 * At most 3 files and 5 edits; existing text files inside the project only; never node_modules, .git or a lockfile;
 * each `search` must occur exactly once in the original file; at most 60 added plus removed lines.
 */
export function validateEdits(projectDir: string, edits: Edit[]): PatchValidation {
  const errors: string[] = [];
  if (edits.length === 0) return { ok: false, errors: ["No edits were given. Give at least one edit."] };
  if (edits.length > PATCH_LIMITS.edits) errors.push(`Too many edits: ${edits.length}. At most ${PATCH_LIMITS.edits} edits are allowed.`);

  const normalized = edits.map((e) => ({ ...e, path: normalizeEditPath(e.path) }));
  const paths = [...new Set(normalized.map((e) => e.path))];
  if (paths.length > PATCH_LIMITS.files) errors.push(`Too many files: ${paths.length}. At most ${PATCH_LIMITS.files} files may be changed.`);

  const contents = new Map<string, string>();
  for (const rel of paths) {
    const loaded = load(projectDir, rel);
    if (typeof loaded === "string") errors.push(loaded);
    else contents.set(rel, loaded.content);
  }

  // each edit is located in the ORIGINAL text; edits in one file must not overlap, so the order cannot matter
  const located = new Map<string, { start: number; end: number; replace: string; n: number }[]>();
  normalized.forEach((edit, i) => {
    const content = contents.get(edit.path);
    if (content === undefined) return; // its file was already reported
    const n = i + 1;
    if (edit.search === "") return void errors.push(`Edit ${n} (${edit.path}): the search text is empty. Quote the exact text to replace.`);
    const search = withFileEndings(content, edit.search);
    if (search === withFileEndings(content, edit.replace)) return void errors.push(`Edit ${n} (${edit.path}): the replacement is the same as the search text, so nothing changes.`);
    const at = exactlyOnce(content, search);
    if (at === "none") return void errors.push(`Edit ${n} (${edit.path}): the search text was not found in the file. It must match the file exactly, including spaces and line breaks.`);
    if (at === "many") return void errors.push(`Edit ${n} (${edit.path}): the search text appears more than once. Include more surrounding text so it matches exactly one place.`);
    const list = located.get(edit.path) ?? [];
    const end = at + search.length;
    const clash = list.find((o) => at < o.end && o.start < end);
    if (clash) return void errors.push(`Edit ${n} and edit ${clash.n} (${edit.path}) change the same text. Combine them into one edit.`);
    list.push({ start: at, end, replace: withFileEndings(content, edit.replace), n });
    located.set(edit.path, list);
  });
  if (errors.length > 0) return { ok: false, errors };

  const changes: FileChange[] = [];
  let lines = 0;
  for (const [rel, list] of located) {
    const before = contents.get(rel)!;
    let after = before;
    for (const o of [...list].sort((a, b) => b.start - a.start)) after = after.slice(0, o.start) + o.replace + after.slice(o.end);
    changes.push({ path: rel, before, after });
    lines += changedLines(before, after);
  }
  if (lines > PATCH_LIMITS.changedLines) return { ok: false, errors: [`The edits change ${lines} lines. At most ${PATCH_LIMITS.changedLines} added plus removed lines are allowed. Make a smaller, more targeted change.`] };
  // keep the order the model gave the files in
  changes.sort((a, b) => paths.indexOf(a.path) - paths.indexOf(b.path));
  return { ok: true, changes, changedLines: lines };
}

/** Joined for the retry prompt. */
export const describeErrors = (errors: string[]) => errors.map((e, i) => `${i + 1}. ${e}`).join("\n");
