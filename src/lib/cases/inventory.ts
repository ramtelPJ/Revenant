import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { AppError } from "@/lib/http/respond";

export type CheckKind = "test" | "build" | "start";
export type InventoryEntry =
  | { path: string; type: "file"; sizeBytes: number }
  | { path: string; type: "dir" }
  | { path: string; type: "dir"; collapsed: true; fileCount: number };

export type Inventory = {
  name: string;
  version: string | null;
  fileCount: number; // excludes node_modules contents
  sizeBytes: number; // excludes node_modules contents
  truncated: boolean;
  entries: InventoryEntry[];
  hasNodeModules: boolean;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  engines: Record<string, string>;
  entryPoints: { path: string; source: "main" | "bin" | "scripts.start"; exists: boolean }[];
  readme: string | null;
  availableChecks: { kind: CheckKind; command: string }[];
};

const MAX_ENTRIES = 5000;
const SKIPPED = new Set([".git"]);
const COMMANDS: Record<CheckKind, string> = { test: "npm test", build: "npm run build", start: "npm start" };

const unsupported = () =>
  new AppError("UNSUPPORTED_PROJECT", 422, "No package.json found. Revenant v1 supports Node.js projects.");

export const asStringMap = (value: unknown): Record<string, string> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => typeof v === "string")
      .sort(([a], [b]) => a.localeCompare(b)) as [string, string][],
  );
};

function countFiles(dir: string): number {
  let count = 0;
  const stack = [dir];
  while (stack.length > 0) {
    for (const entry of readdirSync(stack.pop()!, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(path.join(entry.parentPath, entry.name));
      else count++;
    }
  }
  return count;
}

function walk(root: string) {
  const entries: InventoryEntry[] = [];
  let fileCount = 0;
  let sizeBytes = 0;
  let truncated = false;

  const visit = (relDir: string) => {
    const names = readdirSync(path.join(root, relDir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of names) {
      if (entry.isSymbolicLink() || SKIPPED.has(entry.name)) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (entry.name === "node_modules") {
          entries.push({ path: rel, type: "dir", collapsed: true, fileCount: countFiles(path.join(root, rel)) });
          continue;
        }
        if (entries.length < MAX_ENTRIES) entries.push({ path: rel, type: "dir" });
        visit(rel);
      } else if (entry.isFile()) {
        const size = lstatSync(path.join(root, rel)).size;
        fileCount++;
        sizeBytes += size;
        if (entries.length < MAX_ENTRIES) entries.push({ path: rel, type: "file", sizeBytes: size });
        else truncated = true;
      }
    }
  };
  visit("");
  return { entries, fileCount, sizeBytes, truncated };
}

/** Parses `<projectDir>/package.json`; anything that is not a JSON object is "not a Node.js project". */
export function readManifest(projectDir: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(projectDir, "package.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw unsupported();
    return parsed as Record<string, unknown>;
  } catch {
    throw unsupported();
  }
}

/** The checks a project's scripts allow. `npm init`'s placeholder test script is not a real check. */
export function checksFromScripts(scripts: Record<string, string>): Inventory["availableChecks"] {
  const checks: Inventory["availableChecks"] = [];
  if (scripts.test && !/no test specified/i.test(scripts.test)) checks.push({ kind: "test", command: COMMANDS.test });
  if (scripts.build) checks.push({ kind: "build", command: COMMANDS.build });
  if (scripts.start) checks.push({ kind: "start", command: COMMANDS.start });
  return checks;
}

/** Deterministic facts about a project folder. Reads files; runs nothing. */
export function buildInventory(projectDir: string): Inventory {
  const manifest = readManifest(projectDir);

  const scripts = asStringMap(manifest.scripts);
  const { entries, fileCount, sizeBytes, truncated } = walk(projectDir);

  const entryPoints: Inventory["entryPoints"] = [];
  const addEntry = (p: unknown, source: Inventory["entryPoints"][number]["source"]) => {
    if (typeof p !== "string" || p === "") return;
    const clean = p.replace(/^\.\//, "");
    if (entryPoints.some((e) => e.path === clean && e.source === source)) return;
    entryPoints.push({ path: clean, source, exists: existsSync(path.join(projectDir, clean)) });
  };
  addEntry(manifest.main, "main");
  if (typeof manifest.bin === "string") addEntry(manifest.bin, "bin");
  else for (const bin of Object.values(asStringMap(manifest.bin))) addEntry(bin, "bin");
  const startTarget = scripts.start?.match(/(?:^|\s)(?:node|nodemon|ts-node|tsx)\s+(?:--?\S+\s+)*([^\s&|;]+\.(?:c|m)?[jt]s)\b/);
  if (startTarget) addEntry(startTarget[1], "scripts.start");

  const readme = readdirSync(projectDir).find((name) => /^readme(\.[a-z]+)?$/i.test(name)) ?? null;

  const availableChecks = checksFromScripts(scripts);

  return {
    name: typeof manifest.name === "string" && manifest.name ? manifest.name : path.basename(projectDir),
    version: typeof manifest.version === "string" ? manifest.version : null,
    fileCount,
    sizeBytes,
    truncated,
    entries,
    hasNodeModules: existsSync(path.join(projectDir, "node_modules")),
    dependencies: asStringMap(manifest.dependencies),
    devDependencies: asStringMap(manifest.devDependencies),
    scripts,
    engines: asStringMap(manifest.engines),
    entryPoints,
    readme,
    availableChecks,
  };
}
