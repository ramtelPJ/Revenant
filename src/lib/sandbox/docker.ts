import { spawn, type ChildProcess } from "node:child_process";
import { CHECKS, IMAGE_NAME_PATTERN, type CheckKind } from "./checks.ts";

// The /*turbopackIgnore*/ comments below stop `next build` from tracing the whole project because the
// docker binary path is only known at run time. They change nothing at run time.

export const MAX_OUTPUT_BYTES = 64 * 1024;
const truncationMarker = (maxBytes: number) =>
  `\n…[output truncated at ${maxBytes % 1024 === 0 ? `${maxBytes / 1024} KB` : `${maxBytes} bytes`}]`;

// The CLI is not always on PATH for the shell that launched Revenant (Docker Desktop on macOS).
export const DOCKER_CANDIDATES = [
  "docker",
  "/Applications/Docker.app/Contents/Resources/bin/docker",
  "/usr/local/bin/docker",
  "/opt/homebrew/bin/docker",
];

/** Resolves true only if the process starts and exits 0 within the timeout. Never rejects. */
export type Run = (command: string, args: string[], timeoutMs: number) => Promise<boolean>;
export const runQuiet: Run = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(/*turbopackIgnore: true*/ command, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });

let resolvedBin: string | undefined;
export const resetDockerBin = () => (resolvedBin = undefined);

/** First candidate that answers `--version`. Only a success is cached, so installing Docker later works. */
export async function resolveDockerBin(exec: Run = runQuiet): Promise<string | undefined> {
  if (resolvedBin) return resolvedBin;
  for (const bin of DOCKER_CANDIDATES) {
    if (await exec(bin, ["--version"], 3000)) return (resolvedBin = bin);
  }
  return undefined;
}

// ---- argument builder (pure) -------------------------------------------------------------

export type DockerRunSpec = {
  runId: string; // generated uuid, never project text
  folder: string; // absolute path of the temporary copy (data/runs/<runId>)
  kind: CheckKind;
  image: string;
  memoryMb: number;
  cpus: number;
};

export const containerName = (runId: string) => `revenant-${runId}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const intIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/**
 * Builds the complete `docker run` argument list. Only the run id, the temp folder, the image
 * name and two numeric limits come from the caller, each validated; the flag set is fixed.
 * Extra properties on `spec` are ignored, so project data cannot reach the command line.
 */
export function buildDockerArgs(spec: DockerRunSpec): string[] {
  const { runId, folder, kind, image, memoryMb, cpus } = spec;
  if (typeof runId !== "string" || !UUID.test(runId)) throw new RangeError("runId must be a lowercase uuid");
  if (typeof folder !== "string" || !folder.startsWith("/") || /[:,\0\n\r]/.test(folder)) {
    throw new RangeError("folder must be an absolute path without ':' ',' or control characters");
  }
  if (!Object.hasOwn(CHECKS, kind)) throw new RangeError("unknown check kind");
  if (typeof image !== "string" || !IMAGE_NAME_PATTERN.test(image)) throw new RangeError("invalid image name");
  if (!intIn(memoryMb, 64, 4096)) throw new RangeError("memoryMb must be an integer from 64 to 4096");
  if (!intIn(cpus, 1, 4)) throw new RangeError("cpus must be an integer from 1 to 4");

  return [
    "run",
    "--rm",
    "--pull=never", // never download an image at run time (offline requirement)
    "--name", containerName(runId),
    "--network", "none",
    "--memory", `${memoryMb}m`,
    "--memory-swap", `${memoryMb}m`,
    "--cpus", String(cpus),
    "--pids-limit", "256",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--tmpfs", "/tmp:rw,size=64m",
    "--user", "node",
    "-v", `${folder}:/app:rw`,
    "-w", "/app",
    "-e", "CI=true",
    image,
    ...CHECKS[kind].command,
  ];
}

// ---- running ------------------------------------------------------------------------------

export type UnavailableReason = "docker_missing" | "docker_not_running" | "image_missing";
export type DockerResult =
  | { kind: "unavailable"; reason: UnavailableReason }
  | {
      kind: "finished";
      exitCode: number | null;
      timedOut: boolean;
      survived: boolean; // still running at survivalMs (start check)
      aborted: boolean; // the caller's AbortSignal fired
      output: string; // stdout and stderr in arrival order, capped
      truncated: boolean;
      durationMs: number;
    };

export type RunDockerOptions = {
  name: string; // container name, used for `docker kill`
  timeoutMs: number;
  survivalMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  deps?: { spawn?: typeof spawn; resolveBin?: () => Promise<string | undefined> };
};

function classifyFailure(output: string): UnavailableReason | undefined {
  if (/Cannot connect to the Docker daemon|Is the docker daemon running|error during connect/i.test(output)) return "docker_not_running";
  if (/Unable to find image|No such image|pull access denied/i.test(output)) return "image_missing";
  return undefined;
}

/** Spawns `docker run` (argument array, no shell), enforces the timeout with `docker kill`, caps output. */
export async function runDocker(args: string[], options: RunDockerOptions): Promise<DockerResult> {
  const spawnFn = options.deps?.spawn ?? spawn;
  const bin = await (options.deps?.resolveBin ?? resolveDockerBin)();
  if (!bin) return { kind: "unavailable", reason: "docker_missing" };

  const maxBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const started = Date.now();

  return new Promise<DockerResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(/*turbopackIgnore: true*/ bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return resolve({ kind: "unavailable", reason: "docker_missing" });
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let survived = false;
    let aborted = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];

    const collect = (data: Buffer) => {
      if (size >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - size;
      const part = data.length > room ? data.subarray(0, room) : data;
      if (data.length > room) truncated = true;
      chunks.push(part);
      size += part.length;
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const killContainer = () => {
      // stop the container itself; killing only the client would leave it running
      try {
        spawnFn(/*turbopackIgnore: true*/ bin, ["kill", options.name], { stdio: "ignore" }).on("error", () => {});
      } catch {
        /* nothing more to do */
      }
      timers.push(setTimeout(() => child.kill("SIGKILL"), 5000)); // last resort for the client
    };

    const finish = (result: DockerResult) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = () => {
      aborted = true;
      killContainer();
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    timers.push(
      setTimeout(() => {
        timedOut = true;
        killContainer();
      }, options.timeoutMs),
    );
    if (options.survivalMs !== undefined) {
      timers.push(
        setTimeout(() => {
          survived = true;
          killContainer();
        }, options.survivalMs),
      );
    }

    child.on("error", () => finish({ kind: "unavailable", reason: "docker_missing" }));
    child.on("close", (exitCode) => {
      let output = Buffer.concat(chunks).toString("utf8");
      if (truncated) output += truncationMarker(maxBytes);
      // exit 125 means docker itself failed (not the project): report why, do not blame the project
      if (exitCode === 125 && !timedOut && !survived && !aborted) {
        const reason = classifyFailure(output);
        if (reason) return finish({ kind: "unavailable", reason });
      }
      finish({ kind: "finished", exitCode, timedOut, survived, aborted, output, truncated, durationMs: Date.now() - started });
    });
  });
}
