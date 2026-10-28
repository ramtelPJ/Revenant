import { createTwoFilesPatch, diffLines } from "diff";

export type FileChange = { path: string; before: string; after: string };

/** One unified diff for every changed file, `a/` and `b/` style, with three lines of context. */
export function renderDiff(changes: FileChange[]): string {
  return changes
    .map((c) => createTwoFilesPatch(`a/${c.path}`, `b/${c.path}`, c.before, c.after, "", "", { context: 3 }).replace(/^=+\n/, ""))
    .join("");
}

/** The files a patch touches, in order, without repeats. */
export const filesAffected = (changes: FileChange[]): string[] => [...new Set(changes.map((c) => c.path))];

/** Lines added plus lines removed, counted from a real line diff (so an unchanged line is never counted). */
export function changedLines(before: string, after: string): number {
  return diffLines(before, after).reduce((sum, part) => sum + (part.added || part.removed ? (part.count ?? 0) : 0), 0);
}
