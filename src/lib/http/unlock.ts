import { createHash, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";

/** The launch link is valid for this long after the server started. */
export const UNLOCK_WINDOW_MS = 15 * 60 * 1000;

// On globalThis so dev hot reloads do not reset it. Reset by restarting the server.
const holder = globalThis as unknown as { __revenantUnlock?: { consumed: boolean } };
const state = () => (holder.__revenantUnlock ??= { consumed: false });

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Exchanges the single-use launch token for permission to create a session.
 * A wrong token does not consume the real one; a right one is accepted exactly once,
 * and only within UNLOCK_WINDOW_MS of the server starting.
 */
export function tryUnlock(
  token: string | null,
  options: { now?: number; launchedAt?: number; expected?: string } = {},
): boolean {
  const now = options.now ?? Date.now();
  const launchedAt = options.launchedAt ?? now - process.uptime() * 1000;
  const expected = options.expected ?? getEnv().REVENANT_LAUNCH_TOKEN;

  if (state().consumed) return false;
  if (now - launchedAt >= UNLOCK_WINDOW_MS) return false;
  if (!token) return false;
  // compare fixed-length digests so neither content nor length of the token leaks through timing
  if (!timingSafeEqual(digest(token), digest(expected))) return false;

  state().consumed = true;
  return true;
}
