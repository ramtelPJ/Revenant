import { chmodSync, readdirSync, rmSync } from "node:fs";
import { chmod, lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";

/** Calls `visit` for every entry below `dir`, children before their parent. Symlinks are never followed. */
async function walk(dir: string, visit: (full: string, isDir: boolean) => Promise<void>): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walk(full, visit);
    await visit(full, entry.isDirectory());
  }
}

/** Removes write permission everywhere, so nothing can change a case's `original/` by accident. */
export async function makeReadOnly(dir: string): Promise<void> {
  await walk(dir, async (full) => {
    await chmod(full, (await lstat(full)).mode & ~0o222);
  });
  await chmod(dir, (await lstat(dir)).mode & ~0o222);
}

/**
 * For a throwaway copy that a container with a different uid must write to. Safe because it
 * lives under `data/` (mode 0700) and is deleted after the run.
 */
export async function makeWritable(dir: string): Promise<void> {
  await chmod(dir, 0o777);
  await walk(dir, async (full, isDir) => {
    const executable = (await lstat(full)).mode & 0o111;
    await chmod(full, isDir ? 0o777 : executable ? 0o777 : 0o666);
  });
}

/** Deletes a folder even if it was made read-only. Missing folders are fine. */
export async function removeTree(dir: string): Promise<void> {
  try {
    await lstat(dir);
  } catch {
    return;
  }
  const unlock = async (current: string) => {
    await chmod(current, 0o700);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) await unlock(path.join(current, entry.name));
    }
  };
  await unlock(dir).catch(() => {}); // best effort; rm below reports the real failure
  await rm(dir, { recursive: true, force: true });
}

function removeTreeSync(dir: string): void {
  const unlock = (current: string) => {
    chmodSync(current, 0o700);
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) unlock(path.join(current, entry.name));
    }
  };
  try {
    unlock(dir);
  } catch {
    /* best effort; rmSync below reports the real failure */
  }
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Deletes everything in `data/runs`: temporary sandbox copies left by a run that was interrupted.
 * Synchronous so it can run while the database opens, before anything else uses the folder.
 */
export function sweepRunFolders(dataDir: string): number {
  const runs = path.join(dataDir, "runs");
  let names: string[];
  try {
    names = readdirSync(runs);
  } catch {
    return 0;
  }
  for (const name of names) removeTreeSync(path.join(runs, name));
  return names.length;
}
