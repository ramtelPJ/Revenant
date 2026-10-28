import type { JobView } from "./polling";
import type { Stage, Tone, Verdict } from "./labels";

export type TreeEntry =
  | { path: string; type: "file"; sizeBytes: number }
  | { path: string; type: "dir"; collapsed?: undefined }
  | { path: string; type: "dir"; collapsed: true; fileCount: number };

export type Project = {
  name: string;
  version: string | null;
  sizeBytes: number;
  hasNodeModules: boolean;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  engines: Record<string, string>;
  entryPoints: { path: string; source: "main" | "bin" | "scripts.start"; exists: boolean }[];
  readme: string | null;
  availableChecks: { kind: "test" | "build" | "start"; command: string }[];
};
export type FilesResponse = { entries: TreeEntry[]; fileCount: number; truncated: boolean; project: Project };

export type CheckRun = {
  id: string;
  patchId: string | null;
  phase: "baseline" | "after";
  checkKind: "test" | "build" | "start";
  commandLabel: string;
  target: "original" | "working";
  status: "passed" | "failed" | "timed_out" | "unrunnable";
  exitCode: number | null;
  outputExcerpt: string | null;
  unrunnableReason: string | null;
  durationMs: number | null;
  limits: { memoryMb: number; cpus: number; pids: number; timeoutSec: number; network: string } | null;
  startedAt: number;
  finishedAt: number | null;
};

export type Finding = {
  id: string;
  label: "confirmed_by_check" | "supported_by_files" | "hypothesis" | "no_failure_found";
  title: string;
  explanation: string;
  category: string | null;
  evidence: unknown[];
  checkRunId: string | null;
  model: string | null;
  createdAt: number;
};

export type CaseDetail = {
  id: string;
  name: string;
  sourceKind: "sample" | "folder" | "archive";
  sourceLabel: string;
  stage: Stage;
  sizeBytes: number;
  fileCount: number;
  verdict: Verdict | null;
  verdictReason: string | null;
  createdAt: number;
  updatedAt: number;
  analysis: { inventory: unknown; summary: { purpose?: string; how_to_run?: string } | null; model: string | null; createdAt: number } | null;
  latestFinding: Finding | null;
  latestPatch: { id: string; status: string } | null;
  activeJob: JobView | null;
  checkRuns: CheckRun[];
};

export const STAGE_ORDER: Stage[] = ["imported", "analyzed", "diagnosed", "patched", "verified"];

// ---- file tree ---------------------------------------------------------------------------------------------------
export type TreeNode = { name: string; path: string; kind: "dir" | "file" | "modules"; children: TreeNode[]; fileCount?: number };
export type TreeRow = { path: string; name: string; depth: number; kind: TreeNode["kind"]; expanded: boolean; fileCount?: number };

/** Nests the flat list from the server. Folders come before files, each group alphabetical. */
export function buildTree(entries: TreeEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const byPath = new Map<string, TreeNode>();
  for (const entry of entries) {
    const slash = entry.path.lastIndexOf("/");
    const node: TreeNode = {
      name: entry.path.slice(slash + 1),
      path: entry.path,
      kind: entry.type === "file" ? "file" : entry.collapsed ? "modules" : "dir",
      children: [],
      fileCount: entry.type === "dir" && entry.collapsed ? entry.fileCount : undefined,
    };
    byPath.set(entry.path, node);
    const parent = slash > 0 ? byPath.get(entry.path.slice(0, slash)) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  const order = (a: TreeNode, b: TreeNode) => (a.kind === "file" ? 1 : 0) - (b.kind === "file" ? 1 : 0) || a.name.localeCompare(b.name);
  const sortAll = (nodes: TreeNode[]) => {
    nodes.sort(order);
    nodes.forEach((n) => sortAll(n.children));
  };
  sortAll(roots);
  return roots;
}

/** The rows to draw, skipping everything inside folders the user has collapsed. */
export function visibleRows(nodes: TreeNode[], collapsed: ReadonlySet<string>, depth = 0): TreeRow[] {
  return nodes.flatMap((node) => {
    const expanded = node.kind === "dir" && !collapsed.has(node.path);
    const row: TreeRow = { path: node.path, name: node.name, depth, kind: node.kind, expanded, fileCount: node.fileCount };
    return expanded ? [row, ...visibleRows(node.children, collapsed, depth + 1)] : [row];
  });
}

export const extOf = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toUpperCase().slice(0, 4) : "");

// ---- checks ------------------------------------------------------------------------------------------------------
export const CHECK_STATUS: Record<CheckRun["status"], { label: string; tone: Tone }> = {
  passed: { label: "Passed", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  timed_out: { label: "Timed out", tone: "warn" },
  unrunnable: { label: "Could not run", tone: "neutral" },
};

export function formatDuration(ms: number | null): string {
  if (ms === null) return "unknown time";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function describeLimits(limits: CheckRun["limits"]): string {
  if (!limits) return "limits not recorded";
  return `network ${limits.network === "none" ? "off" : limits.network} · ${limits.memoryMb} MB · ${limits.cpus} CPU · ${limits.timeoutSec} s limit`;
}

/** `test` if the project has one, otherwise `start`; never `build`. Mirrors what the server's diagnose step runs. */
export function baselineCheck(checks: Project["availableChecks"]): Project["availableChecks"][number] | null {
  return checks.find((c) => c.kind === "test") ?? checks.find((c) => c.kind === "start") ?? null;
}
