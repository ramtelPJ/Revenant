import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, readlink, realpath, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { crc32, inflateRawSync } from "node:zlib";
import { getDb, type Db } from "@/lib/db/client";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/http/respond";
import { caseFolder } from "./files";
import { makeReadOnly, removeTree } from "./fs";
import { readManifest } from "./inventory";
import { createCase } from "./store";

export type ImportContext = {
  db: Db;
  dataDir: string;
  maxProjectBytes: number;
  samplesDir: string;
  homeDir: string;
  /** Upload size limit; defaults to 100 MB when not given. */
  maxArchiveBytes?: number;
};
export type ImportResult = { id: string; name: string; stage: "imported"; fileCount: number; sizeBytes: number };

/** Defaults come from the environment; tests pass their own. */
export function defaultImportContext(): ImportContext {
  const env = getEnv();
  return {
    db: getDb(),
    dataDir: path.resolve(env.DATA_DIR),
    maxProjectBytes: env.MAX_PROJECT_MB * 1024 * 1024,
    samplesDir: path.resolve(process.cwd(), "samples"),
    homeDir: os.homedir(),
    maxArchiveBytes: env.MAX_ARCHIVE_MB * 1024 * 1024,
  };
}

// Never copied, at any depth. `.git` is history, the rest are credentials that a project folder should not hold.
const SKIPPED_DIRS = new Set([".git", ".ssh", ".aws", ".gnupg"]);
const SENSITIVE_SEGMENTS = new Set([".ssh", ".aws", ".gnupg"]);
// Test fixtures for the team's samples: the answer key must not end up in the project the AI reads.
const SAMPLE_ONLY_FILES = new Set(["sample.json", "expected.json"]);

const refused = (message: string) => new AppError("VALIDATION_FAILED", 400, message, { path: message });
const missingFolder = () => new AppError("NOT_FOUND", 404, "We couldn't find that folder.");
const tooLarge = (limit: number) =>
  new AppError("TOO_LARGE", 413, `This project is larger than the ${Math.round(limit / 1024 / 1024)} MB limit.`);

const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep);

/**
 * `node_modules/.bin` holds symlinks that npm scripts need (`vitest`, `tsc`, ...). Only those are
 * kept, and only when they are relative and stay inside that same node_modules folder.
 */
async function keepableLink(abs: string): Promise<string | undefined> {
  const segments = abs.split(path.sep);
  const at = segments.lastIndexOf("node_modules");
  if (at < 0 || segments[at + 1] !== ".bin" || segments.length !== at + 3) return undefined;
  const target = await readlink(abs);
  if (path.isAbsolute(target)) return undefined;
  const nodeModules = segments.slice(0, at + 1).join(path.sep);
  return inside(nodeModules, path.resolve(path.dirname(abs), target)) ? target : undefined;
}

type Entry = { rel: string; abs: string; kind: "dir" | "file" | "link"; size: number; linkTarget?: string };

/** Lists what would be copied. Nothing is written, and the size limit is checked here, before any copy. */
async function plan(root: string, isSample: boolean, limit: number): Promise<{ entries: Entry[]; bytes: number; fileCount: number }> {
  const entries: Entry[] = [];
  let bytes = 0;
  let fileCount = 0;

  const visit = async (rel: string) => {
    for (const dirent of await readdir(path.join(root, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      const abs = path.join(root, childRel);
      if (dirent.isDirectory()) {
        if (SKIPPED_DIRS.has(dirent.name)) continue;
        entries.push({ rel: childRel, abs, kind: "dir", size: 0 });
        await visit(childRel);
      } else if (dirent.isSymbolicLink()) {
        const target = await keepableLink(abs);
        if (target !== undefined) entries.push({ rel: childRel, abs, kind: "link", size: 0, linkTarget: target });
      } else if (dirent.isFile()) {
        if (isSample && rel === "" && SAMPLE_ONLY_FILES.has(dirent.name)) continue;
        const size = (await lstat(abs)).size;
        bytes += size;
        if (bytes > limit) throw tooLarge(limit);
        if (!childRel.split("/").includes("node_modules")) fileCount++;
        entries.push({ rel: childRel, abs, kind: "file", size });
      }
    }
  };
  await visit("");
  return { entries, bytes, fileCount };
}

type Built = { bytes: number; fileCount: number };

/**
 * Creates the case folder and row for any source. `build` fills `original/`; afterwards it must hold a
 * Node.js project, is made read-only, and the row is inserted. If anything fails, nothing is left behind.
 */
async function createCaseFrom(
  source: { kind: "sample" | "folder" | "archive"; label: string; nameFallback: string },
  ctx: ImportContext,
  build: (dest: string) => Promise<Built>,
): Promise<ImportResult> {
  const id = randomUUID();
  const dest = caseFolder(id, "original", ctx.dataDir);
  try {
    await mkdir(dest, { recursive: true, mode: 0o700 });
    const built = await build(dest);
    const manifest = readManifest(dest);
    await makeReadOnly(dest);

    const name = (typeof manifest.name === "string" && manifest.name ? manifest.name : source.nameFallback).slice(0, 120);
    const row = createCase(
      { id, name, sourceKind: source.kind, sourceLabel: source.label, sizeBytes: built.bytes, fileCount: built.fileCount },
      ctx.db,
    );
    return { id: row.id, name: row.name, stage: "imported", fileCount: built.fileCount, sizeBytes: built.bytes };
  } catch (error) {
    await removeTree(path.join(ctx.dataDir, "cases", id)); // no half-imported case is left behind
    throw error;
  }
}

async function importDirectory(
  source: { dir: string; kind: "sample" | "folder"; label: string },
  ctx: ImportContext,
): Promise<ImportResult> {
  readManifest(source.dir); // not a Node.js project: refuse before copying anything
  const { entries, bytes, fileCount } = await plan(source.dir, source.kind === "sample", ctx.maxProjectBytes);

  return createCaseFrom({ kind: source.kind, label: source.label, nameFallback: path.basename(source.dir) }, ctx, async (dest) => {
    let copied = 0;
    for (const entry of entries) {
      const target = path.join(dest, entry.rel);
      if (entry.kind === "dir") await mkdir(target, { recursive: true });
      else if (entry.kind === "link") await symlink(entry.linkTarget!, target);
      else {
        copied += entry.size;
        if (copied > ctx.maxProjectBytes) throw tooLarge(ctx.maxProjectBytes); // the folder grew while copying
        await copyFile(entry.abs, target);
      }
    }
    return { bytes, fileCount };
  });
}

export async function importSample(sampleId: string, ctx: ImportContext = defaultImportContext()): Promise<ImportResult> {
  const notFound = () => new AppError("NOT_FOUND", 404, "We couldn't find that sample.");
  if (typeof sampleId !== "string" || !/^[a-z0-9-]+$/.test(sampleId)) throw notFound();

  let dir: string;
  try {
    // /*turbopackIgnore*/: the samples folder is only known at run time; this stops `next build` tracing the whole project
    dir = await realpath(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ ctx.samplesDir, sampleId));
    if (!inside(await realpath(/*turbopackIgnore: true*/ ctx.samplesDir), dir) || !(await stat(dir)).isDirectory()) throw notFound();
  } catch {
    throw notFound();
  }
  return importDirectory({ dir, kind: "sample", label: sampleId }, ctx);
}

/** The operator typed this path, so it is checked for accidents (home, root, credentials, Revenant's own data). */
export async function importFolder(folderPath: string, ctx: ImportContext = defaultImportContext()): Promise<ImportResult> {
  if (typeof folderPath !== "string" || folderPath.length === 0 || folderPath.length > 4096 || folderPath.includes("\0")) {
    throw refused("Enter the full path of a folder.");
  }
  if (!path.isAbsolute(folderPath)) throw refused("Enter the full (absolute) path of the folder.");

  let real: string;
  try {
    real = await realpath(folderPath);
    if (!(await stat(real)).isDirectory()) throw missingFolder();
  } catch {
    throw missingFolder();
  }

  const home = await realpath(ctx.homeDir).catch(() => ctx.homeDir);
  const data = await realpath(ctx.dataDir).catch(() => ctx.dataDir);
  const segments = [...folderPath.split(/[\\/]/), ...real.split(path.sep)];

  if (real === path.parse(real).root) throw refused("That folder is too broad to import.");
  if (real === home || inside(real, home)) throw refused("That folder is your home directory or contains it; choose the project folder itself.");
  if (inside(real, data)) throw refused("That folder contains Revenant's own data folder.");
  if (inside(data, real)) throw refused("That folder is inside Revenant's data folder.");
  if (segments.some((segment) => SENSITIVE_SEGMENTS.has(segment))) throw refused("That folder cannot be imported.");

  return importDirectory({ dir: real, kind: "folder", label: real }, ctx);
}

// ---- zip archives ----------------------------------------------------------------------------------------------

const MAX_ARCHIVE_ENTRIES = 50_000;
const JUNK_SEGMENTS = new Set(["__MACOSX"]);

const unsafeArchive = (why: string) =>
  new AppError("UNSAFE_ARCHIVE", 422, "This archive contains unsafe contents and was rejected.", { archive: why });
const notAZip = () => new AppError("VALIDATION_FAILED", 400, "This file is not a valid zip archive.", { archive: "Upload a .zip file." });

type ArchiveFile = { rel: string; entry: AdmZip.IZipEntry; size: number; crc: number; mode: number; method: number };

/** Validates every entry's name, type, size and method WITHOUT decompressing anything. */
function readArchive(buffer: Buffer, maxProjectBytes: number) {
  // "PK\3\4" (a normal zip) or "PK\5\6" (an empty one)
  if (buffer.length < 22 || buffer[0] !== 0x50 || buffer[1] !== 0x4b || ![0x03, 0x05].includes(buffer[2])) throw notAZip();

  let entries: AdmZip.IZipEntry[];
  try {
    entries = new AdmZip(buffer).getEntries();
  } catch (error) {
    // the library itself refuses two entries with the same name
    if (error instanceof Error && /duplicate entry/i.test(error.message)) throw unsafeArchive("duplicate entry");
    throw notAZip();
  }
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw unsafeArchive("too many entries");

  const dirs: string[] = [];
  const files: ArchiveFile[] = [];
  const seen = new Set<string>();
  let declared = 0;

  for (const entry of entries) {
    // the raw bytes of the name, not the library's cleaned-up version
    const name = entry.rawEntryName.toString("utf8");
    if (name.length === 0 || name.length > 1024 || name.includes("\0")) throw unsafeArchive("invalid entry name");
    if (name.startsWith("/") || name.startsWith("\\") || /^[a-zA-Z]:/.test(name)) throw unsafeArchive("absolute path");
    const isDir = name.endsWith("/");
    const segments = name.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
    if (segments.includes("..")) throw unsafeArchive("path leaves the project folder");

    const mode = entry.header.attr >>> 16;
    const type = mode & 0o170000;
    if (type !== 0 && type !== 0o100000 && type !== 0o040000) throw unsafeArchive("links and special files are not allowed");

    if (segments.some((segment) => SKIPPED_DIRS.has(segment) || JUNK_SEGMENTS.has(segment))) continue; // .git, credentials, macOS metadata
    if (segments.length === 0) continue;
    const rel = segments.join("/");

    if (isDir) {
      dirs.push(rel);
      continue;
    }
    if (entry.header.encrypted || (entry.header.flags & 1) !== 0) throw unsafeArchive("encrypted entries are not supported");
    if (entry.header.method !== 0 && entry.header.method !== 8) throw unsafeArchive("unsupported compression");
    if (seen.has(rel)) throw unsafeArchive("duplicate entry");
    seen.add(rel);

    declared += entry.header.size;
    if (declared > maxProjectBytes) throw tooLarge(maxProjectBytes); // declared sizes are summed before anything is inflated
    files.push({ rel, entry, size: entry.header.size, crc: entry.header.crc >>> 0, mode, method: entry.header.method });
  }

  // a single top-level folder (the usual "zip the folder" layout) is unwrapped
  const tops = new Set([...dirs, ...files.map((f) => f.rel)].map((rel) => rel.split("/")[0]));
  const strip = tops.size === 1 && !files.some((f) => !f.rel.includes("/")) ? [...tops][0] + "/" : "";
  const cut = (rel: string) => (strip && rel.startsWith(strip) ? rel.slice(strip.length) : rel);
  return {
    dirs: dirs.map(cut).filter((rel) => rel !== "" && rel !== strip.slice(0, -1)),
    files: files.map((f) => ({ ...f, rel: cut(f.rel) })).filter((f) => f.rel !== ""),
    declared,
  };
}

/** The label shown for an uploaded file: just the name, no folders, no control characters. */
const archiveLabel = (filename: string) => path.basename(filename.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) || "archive.zip";

/**
 * Imports an uploaded .zip. The library is used to LIST entries; every file is inflated and written by this code,
 * with a hard cap equal to its declared size, so a lying header cannot expand past what was checked.
 */
export async function importArchive(buffer: Buffer, filename: string, ctx: ImportContext = defaultImportContext()): Promise<ImportResult> {
  const maxArchive = ctx.maxArchiveBytes ?? 100 * 1024 * 1024;
  if (buffer.length > maxArchive) {
    throw new AppError("TOO_LARGE", 413, `This archive is larger than the ${Math.round(maxArchive / 1024 / 1024)} MB upload limit.`);
  }
  const { dirs, files } = readArchive(buffer, ctx.maxProjectBytes);

  return createCaseFrom(
    { kind: "archive", label: archiveLabel(filename), nameFallback: path.basename(filename, path.extname(filename)) || "archive" },
    ctx,
    async (dest) => {
      for (const dir of dirs) await mkdir(path.join(dest, dir), { recursive: true });

      let total = 0;
      let fileCount = 0;
      for (const file of files) {
        let data: Buffer;
        try {
          const raw = file.entry.getCompressedData();
          data = file.size === 0 ? Buffer.alloc(0) : file.method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: file.size });
        } catch {
          throw unsafeArchive("an entry does not match its declared size");
        }
        if (data.length !== file.size || crc32(data) !== file.crc) throw unsafeArchive("an entry is corrupt or does not match its header");

        total += data.length;
        if (total > ctx.maxProjectBytes) throw tooLarge(ctx.maxProjectBytes);

        const target = path.join(dest, file.rel);
        try {
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, data, { flag: "wx" }); // fails if something is already there
        } catch {
          throw unsafeArchive("conflicting entries");
        }
        if (file.mode & 0o111) await chmod(target, 0o755); // keep executable scripts executable
        if (!file.rel.split("/").includes("node_modules")) fileCount++;
      }
      return { bytes: total, fileCount };
    },
  );
}
