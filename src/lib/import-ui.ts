import { ApiError, SESSION_ENDED_MESSAGE } from "./api-client";

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. */
export function formatWhen(then: number, now = Date.now()): string {
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)} d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

export type ImportProblem = { title: string; body: string };

/** Checks a chosen file before uploading it. These are conveniences; the server checks everything again. */
export function checkChosenFile(file: { name: string; size: number }, maxArchiveMb: number): ImportProblem | null {
  if (!/\.zip$/i.test(file.name)) {
    return { title: "That isn't a zip archive", body: "Revenant imports .zip archives of Node.js projects. Choose a .zip file, or open a folder or sample instead." };
  }
  if (file.size === 0) return { title: "That file is empty", body: "The archive has no content. Choose another file." };
  if (file.size > maxArchiveMb * 1024 * 1024) {
    return { title: "Too large for this build", body: `${file.name} is ${formatBytes(file.size)}. The upload limit is ${maxArchiveMb} MB. Leave out node_modules and build output, or open the folder instead.` };
  }
  return null;
}

/** Turns whatever went wrong into a title and a sentence for the red box on the import screen. */
export function describeImportError(error: unknown): ImportProblem {
  if (!(error instanceof ApiError)) return { title: "Import failed", body: "Something unexpected went wrong. Try again." };
  switch (error.code) {
    case "TOO_LARGE":
      return { title: "Too large for this build", body: error.message };
    case "UNSUPPORTED_PROJECT":
      return { title: "Not a Node.js project", body: error.message };
    case "UNSAFE_ARCHIVE":
      return { title: "Unsafe archive", body: "This archive contains paths or links that could reach outside the project folder, so it was rejected. Nothing was imported." };
    case "VALIDATION_FAILED":
      return { title: "Can't use that", body: Object.values(error.fields ?? {})[0] ?? error.message };
    case "NOT_FOUND":
      return { title: "Not found", body: error.message };
    case "NETWORK_ERROR":
      return { title: "Can't reach Revenant", body: error.message };
    case "UNAUTHORIZED":
      return { title: "Session ended", body: SESSION_ENDED_MESSAGE };
    default:
      return { title: "Import failed", body: error.message };
  }
}
