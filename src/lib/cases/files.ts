import { closeSync, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/http/respond";

export const MAX_TEXT_FILE_BYTES = 512 * 1024;
export type Version = "original" | "working";

const invalid = (message = "That path is not allowed.") =>
  new AppError("VALIDATION_FAILED", 400, message, { path: "Must be a relative path inside the project." });

/** `data/cases/<caseId>/<version>` */
export function caseFolder(caseId: string, version: Version, dataDir = path.resolve(getEnv().DATA_DIR)) {
  return path.join(dataDir, "cases", caseId, version);
}

/** Lexical checks on the string the user sent, before touching the disk. Returns clean segments. */
function checkRelativePath(relPath: string, forEdit: boolean): string[] {
  if (typeof relPath !== "string" || relPath.length === 0 || relPath.length > 1024) throw invalid();
  if (relPath.includes("\0")) throw invalid();
  // an encoded separator or dot can only be an attempt to sneak past a decoder
  if (/%(2e|2f|5c)/i.test(relPath)) throw invalid();
  if (path.isAbsolute(relPath) || path.win32.isAbsolute(relPath) || relPath.startsWith("~")) throw invalid();

  const segments = relPath.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
  if (segments.length === 0 || segments.includes("..")) throw invalid();
  if (forEdit && segments.some((s) => s === "node_modules" || s === ".git")) {
    throw invalid("Files inside node_modules or .git cannot be changed.");
  }
  return segments;
}

/**
 * Resolves `relPath` inside `baseDir` and returns the real path. The real path (after
 * following every symlink) must stay inside the real `baseDir`.
 */
export function resolveInFolder(baseDir: string, relPath: string, options: { forEdit?: boolean } = {}): string {
  const segments = checkRelativePath(relPath, options.forEdit ?? false);

  let realBase: string;
  try {
    realBase = realpathSync(baseDir);
  } catch {
    throw new AppError("NOT_FOUND", 404, "We couldn't find that.");
  }

  let real: string;
  try {
    real = realpathSync(path.join(realBase, ...segments));
  } catch {
    throw new AppError("NOT_FOUND", 404, "We couldn't find that.");
  }
  if (real !== realBase && !real.startsWith(realBase + path.sep)) throw invalid();
  return real;
}

export type TextFile = { path: string; content: string; lineCount: number };

/** Reads a UTF-8 text file ≤ 512 KB. Binary and oversized files are refused with their own codes. */
export function readTextFile(baseDir: string, relPath: string, maxBytes = MAX_TEXT_FILE_BYTES): TextFile {
  const real = resolveInFolder(baseDir, relPath);
  if (!statSync(real).isFile()) throw invalid("That path is not a file.");

  const fd = openSync(real, "r");
  let buffer: Buffer;
  try {
    // size is checked on the open descriptor, so a file cannot grow between check and read
    if (fstatSync(fd).size > maxBytes) {
      throw new AppError("TOO_LARGE", 413, `This file is larger than ${Math.round(maxBytes / 1024)} KB and cannot be shown.`);
    }
    buffer = readFileSync(fd);
  } finally {
    closeSync(fd);
  }

  let content: string;
  try {
    if (buffer.includes(0)) throw new Error("NUL byte");
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new AppError("UNSUPPORTED_FILE", 422, "This looks like a binary file and cannot be shown as text.");
  }

  const lineCount = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  return { path: checkRelativePath(relPath, false).join("/"), content, lineCount };
}
