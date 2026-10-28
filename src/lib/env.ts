import { z } from "zod";
import { IMAGE_NAME_PATTERN } from "./sandbox/checks.ts";

const hex32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "must be 32 random bytes as 64 hex characters");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** http on this machine only. Shared with the AI client, which checks the address again before every call. */
export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

const loopbackUrl = z
  .string()
  .refine(isLoopbackUrl, "must be an http URL on a loopback host (127.0.0.1, localhost, ::1) so project code never leaves this machine");

const int = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const schema = z.object({
  REVENANT_LAUNCH_TOKEN: hex32,
  REVENANT_SESSION_SECRET: hex32,
  HOST: z.literal("127.0.0.1", "must be 127.0.0.1; Revenant never listens on other interfaces").default("127.0.0.1"),
  PORT: int(1, 65535, 3000),
  DATA_DIR: z.string().min(1).default("./data"),
  OLLAMA_URL: loopbackUrl.default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().min(1, "set to a model tag from `ollama list`"),
  AI_TIMEOUT_SEC: int(1, 600, 120),
  SANDBOX_IMAGE: z.string().regex(IMAGE_NAME_PATTERN, "must be a plain image name such as node:lts-slim").default("node:lts-slim"),
  SANDBOX_MEMORY_MB: int(64, 4096, 512),
  SANDBOX_CPUS: int(1, 4, 1),
  CHECK_TIMEOUT_SEC: int(1, 600, 120),
  MAX_ARCHIVE_MB: int(1, 500, 100),
  MAX_PROJECT_MB: int(1, 1000, 300),
});

export type Env = z.infer<typeof schema>;

/** Pure and testable; throws a readable error listing every invalid variable. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  const lines = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
  throw new Error(`Invalid environment:\n${lines.join("\n")}`);
}

let cached: Env | undefined;

/** The only reader of process.env. Validated once, on first use. */
export function getEnv(): Env {
  return (cached ??= parseEnv(process.env));
}
