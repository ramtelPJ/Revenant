// The only commands Revenant will ever run on a project. Anything else is not runnable.
export type CheckKind = "test" | "build" | "start";

/** A plain image reference. It can never start with "-", so it cannot be read as a docker flag. */
export const IMAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9._/:@-]{0,254}$/i;

export const CHECK_KINDS: readonly CheckKind[] = ["test", "build", "start"];

export const CHECKS: Record<CheckKind, { label: string; command: readonly string[] }> = {
  test: { label: "npm test", command: ["npm", "test"] },
  build: { label: "npm run build", command: ["npm", "run", "build"] },
  start: { label: "npm start", command: ["npm", "start"] },
};

/** `start` is a smoke check: it passes if the process is still running after this long. */
export const START_SURVIVAL_MS = 8_000;
const START_TIMEOUT_SEC = 15;

export const isCheckKind = (value: unknown): value is CheckKind =>
  typeof value === "string" && (CHECK_KINDS as readonly string[]).includes(value);

/** `start` gets a short hard cap; test and build use the configured timeout. */
export const timeoutSecFor = (kind: CheckKind, configuredSec: number) =>
  kind === "start" ? Math.min(START_TIMEOUT_SEC, configuredSec) : configuredSec;

export type CheckOutcome = { exitCode: number | null; timedOut: boolean; survived: boolean };
export type CheckStatus = "passed" | "failed" | "timed_out";

/** Pass rules: test/build pass on exit 0; start passes if it exits 0 or is still up after START_SURVIVAL_MS. */
export function evaluateCheck(kind: CheckKind, outcome: CheckOutcome): CheckStatus {
  if (outcome.timedOut) return "timed_out";
  if (kind === "start" && outcome.survived) return "passed";
  return outcome.exitCode === 0 ? "passed" : "failed";
}
